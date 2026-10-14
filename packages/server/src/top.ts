// `ntwine top` — one terminal readout of the machine's memory and ntwine's share of it.
//
// Four readings, each from the module that already owns it, so this file adds grouping and rendering
// and no new parser of anyone's format:
//   - HOST: /proc/meminfo, and memory pressure. PSI `some avg10` where the kernel has it; this WSL 5.15
//     kernel has none, so the fallback is the swap-in rate from /proc/vmstat `pswpin` over ~1s, which is
//     the same signal the job gate holds on (gate.ts readPressure). The sample's second is spent while
//     the process table is read, so it costs no extra wall time.
//   - THE JOB GATE: its state.json through gate.ts `readState` (which prunes dead wrappers on read and
//     writes nothing), with each running job's tree RSS re-read, as `ntwine-run status` does.
//   - RSS PER THREAD TREE: processes grouped by the NTWINE_THREAD=<slug> env marker, read by the orphan
//     reaper's `enumerateProcs`. A Claude thread's broker daemon does NOT carry the marker (it is forked
//     by the server, which is nobody's thread), so it is attributed through the session root it parents.
//     An untagged process below a tagged one (a child that cleared its env) joins its ancestor's tree.
//     RSS is /proc/<pid>/stat's, through gate.ts `scanProcs` — the number `ps -o rss` prints.
//   - IDLE, HIBERNATED, UNOWNED AND ORPHANED: a slug whose session root is gone but whose processes are
//     not is an orphan (`decideOrphans` says which the reaper will take). A hibernated thread has no
//     process at all, so only the server knows it: each project's `board` query over loopback, the way
//     `--sessions` reaches the running board. The same rows feed `classifyUnownedBrokers`. With no server
//     answering, both are omitted and the readout says so rather than reading every daemon as unowned.
//
// Nothing here writes: no lock is taken, no state file is touched, nothing is signalled.
import { readFileSync } from "node:fs"
import { formatElapsed, type BoardSnapshot } from "@ntwine/shared"
import {
  psiSomeAvg10, readPswpin, readSettings, readState, scanProcs, treeRssMB,
  type Job, type ProcEntry,
} from "../../../cc-worker/job-gate/gate.ts"
import { serverAddressPath } from "./ntwine-paths.ts"
import { decideOrphans, enumerateProcs, isSessionRoot, ORPHAN_MIN_AGE_MS, selfAndAncestors, type ProcRow } from "./orphan-reaper.ts"
import { listProjects } from "./project-registry.ts"
import type { SessionRow } from "./storage.ts"
import { classifyUnownedBrokers, probeClaudeTranscript, type TranscriptReading, type UnownedBroker } from "./unowned-brokers.ts"

// ───────────────────────────── host

export interface HostMemory {
  totalMB: number
  availableMB: number
  swapTotalMB: number
  swapUsedMB: number
}

export function parseMeminfo(text: string): HostMemory {
  const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? 0)
  const mb = (n: number) => Math.round(n / 1024)
  return {
    totalMB: mb(kb("MemTotal")),
    availableMB: mb(kb("MemAvailable")),
    swapTotalMB: mb(kb("SwapTotal")),
    swapUsedMB: mb(kb("SwapTotal") - kb("SwapFree")),
  }
}

export type PressureReading =
  | { kind: "psi"; someAvg10: number }
  | { kind: "swapin"; mbPerSec: number; windowMs: number }
  | { kind: "unknown" }

const PAGE_KB = 4

/** Swap-in MB/s between two `pswpin` page counts. */
export function swapInRate(before: number, after: number, windowMs: number): number {
  if (windowMs <= 0 || after < before) return 0
  return Math.round((((after - before) * PAGE_KB) / 1024 / (windowMs / 1000)) * 10) / 10
}

// ───────────────────────────── thread trees

export interface TopProc extends ProcRow {
  rssKB: number
}

/** The detached Claude session daemon: `claude-agent-broker.ts` from source, `.js` from the package. */
export function isBrokerDaemon(command: string): boolean {
  return /claude-agent-broker\.(?:ts|js|mjs)(?:\s|$)/.test(command)
}

export function isNtwineMcp(command: string): boolean {
  return /ntwine-mcp\.(?:mjs|ts|js)(?:\s|$)/.test(command)
}

/** The session id a Claude session root runs under, from its argv. */
export function sessionIdOf(command: string): string | undefined {
  return /--(?:session-id|resume)[= ]([0-9a-f-]{8,})/.exec(command)?.[1]
}

export interface ThreadTree {
  slug: string
  sessionId?: string
  rootPid: number
  brokerPid?: number
  pids: number[]
  rssKB: number
  /** The fixed cost of a thread at rest: its broker, its `claude`, its ntwine MCP server. */
  agentKB: number
  /** Everything else in the tree: shells, jobs, project MCP servers, browsers. */
  workKB: number
  /** How long the thread's process has been up: its broker's age, else its session root's. Not the
   *  oldest process in the tree, which can be a tool a previous incarnation of the thread left running. */
  ageMs: number
}

export interface OrphanGroup {
  slug: string
  pids: number[]
  rssKB: number
  /** How many of its processes the orphan reaper will end on its next sweep (the rest are too young). */
  reapable: number
}

export interface Grouping {
  threads: ThreadTree[]
  orphans: OrphanGroup[]
  /** pid → the slug it was attributed to. */
  owner: Map<number, string>
}

/**
 * Group the process table into thread trees. Pure: the rows carry everything.
 *
 * Ownership, in order: the env marker; then a broker daemon takes the slug of the session root it
 * parents; then an unmarked process takes the slug of its nearest attributed ancestor. A slug with a
 * live session root is a thread; a slug without one is an orphan.
 */
export function groupThreadTrees(procs: readonly TopProc[], opts: { selfPid?: number; protectedPids?: ReadonlySet<number> } = {}): Grouping {
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const owner = new Map<number, string>()
  for (const p of procs) if (p.slug) owner.set(p.pid, p.slug)
  for (const p of procs) {
    if (!p.slug || !isSessionRoot(p.command)) continue
    const parent = byPid.get(p.ppid)
    if (parent && !owner.has(parent.pid) && isBrokerDaemon(parent.command)) owner.set(parent.pid, p.slug)
  }
  const inherited = (pid: number): string | undefined => {
    const seen = new Set<number>()
    let cur = byPid.get(pid)
    while (cur && !seen.has(cur.pid)) {
      seen.add(cur.pid)
      const slug = owner.get(cur.pid)
      if (slug) return slug
      cur = byPid.get(cur.ppid)
    }
    return undefined
  }
  for (const p of procs) {
    if (owner.has(p.pid)) continue
    const slug = inherited(p.ppid)
    if (slug) owner.set(p.pid, slug)
  }

  const members = new Map<string, TopProc[]>()
  for (const p of procs) {
    const slug = owner.get(p.pid)
    if (!slug) continue
    const list = members.get(slug)
    if (list) list.push(p)
    else members.set(slug, [p])
  }

  const tagged: ProcRow[] = procs.map((p) => ({ ...p, slug: owner.get(p.pid) ?? null }))
  const reap = new Set(decideOrphans(tagged, {
    minAgeMs: ORPHAN_MIN_AGE_MS,
    protectedPids: opts.protectedPids ?? (opts.selfPid ? selfAndAncestors(tagged, opts.selfPid) : new Set()),
  }).reap)

  const threads: ThreadTree[] = []
  const orphans: OrphanGroup[] = []
  for (const [slug, list] of members) {
    const sum = (rows: TopProc[]) => rows.reduce((kb, p) => kb + p.rssKB, 0)
    const roots = list.filter((p) => isSessionRoot(p.command) && p.slug === slug)
    if (roots.length === 0) {
      orphans.push({ slug, pids: list.map((p) => p.pid), rssKB: sum(list), reapable: list.filter((p) => reap.has(p.pid)).length })
      continue
    }
    // A codex or a second claude root under one slug is possible; the oldest names the thread.
    const root = roots.reduce((a, b) => (b.ageMs > a.ageMs ? b : a))
    // Its OWN broker is the root's parent; another broker in the list belongs to an ntwine this thread
    // launched (an adhoc stack inherits the launching worker's marker) and counts as its work.
    const broker = list.find((p) => p.pid === root.ppid && isBrokerDaemon(p.command))
    const agent = list.filter((p) => p === root || p === broker || (isNtwineMcp(p.command) && p.ppid === root.pid))
    const sessionId = sessionIdOf(root.command)
    threads.push({
      slug,
      ...(sessionId ? { sessionId } : {}),
      rootPid: root.pid,
      ...(broker ? { brokerPid: broker.pid } : {}),
      pids: list.map((p) => p.pid).sort((a, b) => a - b),
      rssKB: sum(list),
      agentKB: sum(agent),
      workKB: sum(list) - sum(agent),
      ageMs: (broker ?? root).ageMs,
    })
  }
  threads.sort((a, b) => b.rssKB - a.rssKB || a.slug.localeCompare(b.slug))
  orphans.sort((a, b) => b.rssKB - a.rssKB || a.slug.localeCompare(b.slug))
  return { threads, orphans, owner }
}

/**
 * This readout and the launcher processes that exist only to run it — each ancestor carrying a bare
 * `top` argument — so `ntwine top` run from a worker's shell does not count its own ~150MB against that
 * worker's thread. Measured 2026-10-09: without it, the thread that ran it read +37% against `ps`.
 */
export function readoutChain(procs: readonly TopProc[], selfPid: number): Set<number> {
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const out = new Set([selfPid])
  let cur = byPid.get(selfPid)
  while (cur) {
    const parent = byPid.get(cur.ppid)
    if (!parent || parent.pid <= 1 || out.has(parent.pid) || !/(?:^|\s)top(?:\s|$)/.test(parent.command)) break
    out.add(parent.pid)
    cur = parent
  }
  return out
}

/** The server's own processes: the pid in server.lock, its launcher ancestors, and their untagged descendants. */
export function serverTree(procs: readonly TopProc[], serverPid: number, owner: ReadonlyMap<number, string>): { pids: number[]; rssKB: number } {
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  if (!byPid.has(serverPid)) return { pids: [], rssKB: 0 }
  let top = serverPid
  for (let guard = 0; guard < 64; guard++) {
    const parent = byPid.get(byPid.get(top)!.ppid)
    if (!parent || parent.pid <= 1 || !/ntwine/.test(parent.command) || owner.has(parent.pid)) break
    top = parent.pid
  }
  const children = new Map<number, number[]>()
  for (const p of procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p.pid])
  const pids: number[] = []
  const stack = [top]
  while (stack.length) {
    const pid = stack.pop()!
    if (owner.has(pid)) continue
    pids.push(pid)
    stack.push(...(children.get(pid) ?? []))
  }
  return { pids, rssKB: pids.reduce((kb, pid) => kb + (byPid.get(pid)?.rssKB ?? 0), 0) }
}

// ───────────────────────────── the server's view

export type BoardThread = BoardSnapshot["threads"][number]

export interface ProjectBoard {
  slug: string
  threads: BoardThread[]
}

/** The board rows `classifyUnownedBrokers` reads, rebuilt from the board's thread views. The board
 *  carries one session id per thread, so a row known only by its transcript or agent id reads as
 *  unreferenced here — a stricter reading than the server's own, and labelled as the board's. */
export function rowsFromBoards(boards: readonly ProjectBoard[]): SessionRow[] {
  return boards.flatMap((board) =>
    board.threads.filter((t) => t.sessionId).map((t) => ({
      slug: t.id,
      session_id: t.sessionId!,
      transcript_id: null,
      agent_session_id: null,
      backend: t.backend ?? "claude",
      claude_runtime: t.claudeRuntime ?? null,
      state: t.archived || t.state === "archived" ? "archived" : "open",
      archived: t.archived ? 1 : 0,
    }) as unknown as SessionRow),
  )
}

export interface Hibernated {
  slug: string
  project: string
  idleMs: number | null
}

/** Open threads that have a session but no live process: hibernated, or waiting on a cold resume. */
export function hibernatedThreads(boards: readonly ProjectBoard[], liveSlugs: ReadonlySet<string>, nowMs: number): Hibernated[] {
  const out: Hibernated[] = []
  for (const board of boards) {
    for (const t of board.threads) {
      if (t.archived || t.state === "archived" || t.foreign || !t.sessionId || liveSlugs.has(t.id)) continue
      const last = t.lastActivityAt ? Date.parse(t.lastActivityAt) : Number.NaN
      out.push({ slug: t.id, project: board.slug, idleMs: Number.isFinite(last) ? nowMs - last : null })
    }
  }
  return out.sort((a, b) => (a.idleMs ?? Infinity) - (b.idleMs ?? Infinity))
}

interface ServerAddress { pid: number; port: number }

function readServerAddress(home?: string): ServerAddress | null {
  try {
    const lock = JSON.parse(readFileSync(serverAddressPath(home), "utf8")) as Partial<ServerAddress>
    if (!Number.isInteger(lock.pid) || !Number.isInteger(lock.port)) return null
    try { process.kill(lock.pid!, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM") return null }
    return { pid: lock.pid!, port: lock.port! }
  } catch {
    return null
  }
}

async function fetchBoards(port: number, home?: string): Promise<{ boards: ProjectBoard[]; failed: string[] }> {
  const boards: ProjectBoard[] = []
  const failed: string[] = []
  for (const project of listProjects(home)) {
    if (project.stale) continue
    try {
      const response = await fetch(`http://127.0.0.1:${port}/_ntwine/${encodeURIComponent(project.id)}/rpc/board`, {
        headers: { origin: `http://127.0.0.1:${port}` },
        signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok) throw new Error(String(response.status))
      const body = (await response.json()) as { result?: BoardSnapshot }
      boards.push({ slug: project.slug, threads: body.result?.threads ?? [] })
    } catch {
      failed.push(project.slug)
    }
  }
  return { boards, failed }
}

/** The session id a broker daemon serves, from its NTWINE_CLAUDE_BROKER config. Only that one variable
 *  is parsed; the rest of the environment is never retained. */
function brokerSessionFromEnv(pid: number): string | undefined {
  try {
    const entry = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").find((e) => e.startsWith("NTWINE_CLAUDE_BROKER="))
    if (!entry) return undefined
    const sessionId = (JSON.parse(entry.slice("NTWINE_CLAUDE_BROKER=".length)) as { sessionId?: unknown }).sessionId
    return typeof sessionId === "string" ? sessionId : undefined
  } catch {
    return undefined
  }
}

// ───────────────────────────── the reading

export interface GateJobView extends Job {
  /** queued: how long it has waited; running: how long it has run. */
  forMs: number
  /** running only: how long it waited before it was admitted. */
  waitedMs?: number
}

export interface TopThread extends ThreadTree {
  project?: string
  /** Board state: `running`, `idle`, `done`; absent without a server. */
  state?: "running" | "idle" | "done"
  idleMs: number | null
}

export interface UnownedView {
  sessionId: string
  daemonPid: number
  reason: UnownedBroker["reason"]
  slug?: string
  ageMs: number
  rssKB: number
  /** The server ends this daemon on its next audit (it never received a prompt). */
  serverEnds: boolean
}

export interface TopReading {
  at: string
  host: HostMemory & { pressure: PressureReading }
  gate: { enabled: boolean; dir: string; jobs: GateJobView[] }
  ntwine: { totalKB: number; serverKB: number; threadsKB: number; orphansKB: number }
  server: { pid: number; port: number; pids: number[]; rssKB: number; boardsRead: number; boardsFailed: string[] } | null
  threads: TopThread[]
  orphans: OrphanGroup[]
  /** Null when no server answered: without its rows every daemon would read as unowned. */
  unowned: UnownedView[] | null
  hibernated: Hibernated[] | null
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function readTop(opts: { home?: string; sampleMs?: number } = {}): Promise<TopReading> {
  const started = Date.now()
  const psi = psiSomeAvg10()
  const pswpinBefore = psi === null ? readPswpin() : null

  const [rows, address] = [await enumerateProcs(), readServerAddress(opts.home)]
  const stats: Map<number, ProcEntry> = scanProcs()
  const everything: TopProc[] = rows.map((r) => ({ ...r, rssKB: stats.get(r.pid)?.rssKB ?? 0 }))
  const readout = readoutChain(everything, process.pid)
  const procs = everything.filter((p) => !readout.has(p.pid))
  const grouping = groupThreadTrees(procs, { protectedPids: selfAndAncestors(everything, process.pid) })
  const nowMs = Date.now()

  // ── the server's view
  let boards: ProjectBoard[] | null = null
  let boardsFailed: string[] = []
  if (address) {
    const read = await fetchBoards(address.port, opts.home)
    boardsFailed = read.failed
    if (read.boards.length) boards = read.boards
  }
  const boardThread = new Map<string, { project: string; thread: BoardThread }>()
  for (const board of boards ?? []) for (const thread of board.threads) boardThread.set(thread.id, { project: board.slug, thread })

  const transcriptAge = (sessionId?: string): number | null => {
    if (!sessionId) return null
    let reading: TranscriptReading
    try { reading = probeClaudeTranscript(sessionId) } catch { return null }
    return reading.kind === "present" ? nowMs - reading.mtimeMs : null
  }
  const threads: TopThread[] = grouping.threads.map((tree) => {
    const known = boardThread.get(tree.slug)
    const last = known?.thread.lastActivityAt ? Date.parse(known.thread.lastActivityAt) : Number.NaN
    const state = !known ? undefined
      : known.thread.archived || known.thread.state === "archived" ? "done" as const
      : known.thread.runtime === "running" || known.thread.runtime === "spawning" || known.thread.runtime === "perm-prompt" ? "running" as const
      : "idle" as const
    return {
      ...tree,
      ...(known ? { project: known.project } : {}),
      ...(state ? { state } : {}),
      idleMs: state === "running" ? 0 : Number.isFinite(last) ? Math.max(0, nowMs - last) : transcriptAge(tree.sessionId),
    }
  })

  // ── unowned brokers and hibernated threads, only with the server's rows
  let unowned: UnownedView[] | null = null
  let hibernated: Hibernated[] | null = null
  if (boards) {
    const byPid = new Map(procs.map((p) => [p.pid, p]))
    const daemons = procs.filter((p) => isBrokerDaemon(p.command)).flatMap((p) => {
      const child = procs.find((c) => c.ppid === p.pid && isSessionRoot(c.command))
      const sessionId = brokerSessionFromEnv(p.pid) ?? (child ? sessionIdOf(child.command) : undefined)
      return sessionId ? [{ sessionId, daemonPid: p.pid, createdAt: new Date(nowMs - p.ageMs).toISOString() }] : []
    })
    const treeKB = (pid: number) => {
      let kb = 0
      const stack = [pid]
      while (stack.length) {
        const cur = stack.pop()!
        kb += byPid.get(cur)?.rssKB ?? 0
        for (const p of procs) if (p.ppid === cur) stack.push(p.pid)
      }
      return kb
    }
    unowned = classifyUnownedBrokers({ daemons, rows: rowsFromBoards(boards), transcript: (id) => probeClaudeTranscript(id), nowMs })
      .map((u) => ({
        sessionId: u.sessionId,
        daemonPid: u.daemonPid,
        reason: u.reason,
        ...(u.slug ? { slug: u.slug } : {}),
        ageMs: u.ageMs,
        rssKB: treeKB(u.daemonPid),
        serverEnds: u.verdict.end,
      }))
    hibernated = hibernatedThreads(boards, new Set(grouping.threads.map((t) => t.slug)), nowMs)
  }

  // ── the job gate
  const settings = readSettings()
  const state = readState(settings.dir)
  const gateNow = Date.now()
  const jobs: GateJobView[] = state.jobs
    .map((job): GateJobView => job.status === "running"
      ? {
          ...job,
          ...(job.childPid ? { rssMB: treeRssMB(job.childPid, stats) } : {}),
          forMs: gateNow - (job.admittedAt ?? gateNow),
          ...(job.admittedAt ? { waitedMs: job.admittedAt - job.enqueuedAt } : {}),
        }
      : { ...job, forMs: gateNow - job.enqueuedAt })
    .sort((a, b) => (a.status === b.status ? a.enqueuedAt - b.enqueuedAt : a.status === "running" ? -1 : 1))

  // ── the host, last, so the swap-in window spans everything above
  const sampleMs = opts.sampleMs ?? 1_000
  if (pswpinBefore !== null) await sleep(Math.max(0, sampleMs - (Date.now() - started)))
  const pswpinAfter = pswpinBefore !== null ? readPswpin() : null
  const windowMs = Date.now() - started
  const pressure: PressureReading = psi !== null ? { kind: "psi", someAvg10: psi }
    : pswpinBefore !== null && pswpinAfter !== null ? { kind: "swapin", mbPerSec: swapInRate(pswpinBefore, pswpinAfter, windowMs), windowMs }
    : { kind: "unknown" }
  let memory: HostMemory
  try { memory = parseMeminfo(readFileSync("/proc/meminfo", "utf8")) } catch { memory = { totalMB: 0, availableMB: 0, swapTotalMB: 0, swapUsedMB: 0 } }

  const server = address ? { ...address, ...serverTree(procs, address.pid, grouping.owner), boardsRead: boards?.length ?? 0, boardsFailed } : null
  const threadsKB = threads.reduce((kb, t) => kb + t.rssKB, 0)
  const orphansKB = grouping.orphans.reduce((kb, o) => kb + o.rssKB, 0)
  const serverKB = server?.rssKB ?? 0
  return {
    at: new Date(nowMs).toISOString(),
    host: { ...memory, pressure },
    gate: { enabled: settings.enabled, dir: settings.dir, jobs },
    ntwine: { totalKB: serverKB + threadsKB + orphansKB, serverKB, threadsKB, orphansKB },
    server,
    threads,
    orphans: grouping.orphans,
    unowned,
    hibernated,
  }
}

// ───────────────────────────── rendering

/** `512MB`, `3.4GB`. */
export function sizeLabel(kb: number): string {
  const mb = kb / 1024
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${Math.round(mb)}MB`
}

const ago = (ms: number | null | undefined) => (ms === null || ms === undefined || !Number.isFinite(ms) ? "—" : formatElapsed(Math.max(0, ms)))

function table(rows: string[][], rightAligned: ReadonlySet<number> = new Set()): string[] {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)))
  return rows.map((r) => r.map((cell, i) => (rightAligned.has(i) ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!))).join("  ").trimEnd())
}

export function renderTop(reading: TopReading, opts: { width?: number } = {}): string {
  const width = opts.width ?? 120
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
  const out: string[] = []
  const h = reading.host
  const pressure = h.pressure.kind === "psi" ? `memory pressure ${h.pressure.someAvg10}%`
    : h.pressure.kind === "swapin" ? `swap-in ${h.pressure.mbPerSec}MB/s over ${(h.pressure.windowMs / 1000).toFixed(1)}s (no PSI on this kernel)`
    : "memory pressure unknown"
  const usedPct = h.totalMB ? Math.round(((h.totalMB - h.availableMB) / h.totalMB) * 100) : 0
  out.push(`Memory  ${sizeLabel(h.availableMB * 1024)} available of ${sizeLabel(h.totalMB * 1024)} (${usedPct}% used) · swap ${sizeLabel(h.swapUsedMB * 1024)} of ${sizeLabel(h.swapTotalMB * 1024)} · ${pressure}`)
  const f = reading.ntwine
  const share = h.totalMB ? ` (${Math.round((f.totalKB / 1024 / h.totalMB) * 100)}% of memory)` : ""
  out.push(`ntwine   ${sizeLabel(f.totalKB)}${share} · server ${sizeLabel(f.serverKB)} · ${reading.threads.length} threads ${sizeLabel(f.threadsKB)}${reading.orphans.length ? ` · orphans ${sizeLabel(f.orphansKB)}` : ""}`)

  // ── gate
  out.push("")
  const running = reading.gate.jobs.filter((j) => j.status === "running")
  const queued = reading.gate.jobs.filter((j) => j.status === "queued")
  out.push(`Job gate${reading.gate.enabled ? "" : " (off)"}: ${running.length} running, ${queued.length} queued`)
  if (reading.gate.jobs.length) {
    const rows = [["", "THREAD", "RSS", "EST", "FOR", "WAITED", "COMMAND"]]
    for (const j of reading.gate.jobs) {
      rows.push([
        j.status,
        clip(j.session, 36),
        j.status === "running" ? sizeLabel((j.rssMB ?? 0) * 1024) : "",
        sizeLabel(j.estimateMB * 1024),
        ago(j.forMs),
        j.status === "running" ? ago(j.waitedMs) : "",
        clip(j.status === "queued" && j.waitReason ? `${j.signature} — ${j.waitReason}` : j.signature, 70),
      ])
    }
    for (const line of table(rows, new Set([2, 3, 4, 5]))) out.push(`  ${clip(line, width - 2)}`)
  }

  // ── threads
  out.push("")
  out.push(`Threads with a live process: ${reading.threads.length}`)
  if (reading.threads.length) {
    const rows = [["THREAD", "PROJECT", "STATE", "RSS", "AGENT", "WORK", "PROCS", "UP", "IDLE"]]
    for (const t of reading.threads) {
      rows.push([
        clip(t.slug, 40), t.project ?? "", t.state ?? "", sizeLabel(t.rssKB), sizeLabel(t.agentKB), sizeLabel(t.workKB),
        String(t.pids.length), ago(t.ageMs), t.state === "running" ? "" : ago(t.idleMs),
      ])
    }
    for (const line of table(rows, new Set([3, 4, 5, 6, 7, 8]))) out.push(`  ${line}`)
    out.push("  AGENT is the broker, claude and ntwine MCP server; WORK is everything the thread started.")
  }

  // ── idle accounting
  if (reading.hibernated === null) {
    out.push("")
    out.push(reading.server
      ? "Hibernated threads and unowned brokers not shown: the server did not return any project's board."
      : "Hibernated threads and unowned brokers not shown: no ntwine server is running.")
  } else {
    out.push("")
    out.push(`Hibernated (no process; a reply resumes it): ${reading.hibernated.length}`)
    if (reading.hibernated.length) {
      const rows = [["THREAD", "PROJECT", "IDLE"], ...reading.hibernated.map((t) => [clip(t.slug, 40), t.project, ago(t.idleMs)])]
      for (const line of table(rows, new Set([2]))) out.push(`  ${line}`)
    }
    const unowned = reading.unowned ?? []
    if (unowned.length) {
      out.push("")
      out.push(`Brokers no open thread owns: ${unowned.length}`)
      const why = (u: UnownedView) => (u.reason === "no-row" ? "no thread" : u.reason === "archived" ? "thread is done" : "not this thread's broker")
      const rows = [["SESSION", "THREAD", "WHY", "RSS", "UP", ""]]
      for (const u of unowned) rows.push([u.sessionId.slice(0, 8), clip(u.slug ?? "", 40), why(u), sizeLabel(u.rssKB), ago(u.ageMs), u.serverEnds ? "ends on the next check" : ""])
      for (const line of table(rows, new Set([3, 4]))) out.push(`  ${line}`)
    }
    if (reading.server?.boardsFailed.length) out.push(`  (no board from ${reading.server.boardsFailed.join(", ")})`)
  }

  if (reading.orphans.length) {
    out.push("")
    out.push(`Orphans (processes whose thread has no session left): ${reading.orphans.length}`)
    const rows = [["THREAD", "RSS", "PROCS", ""]]
    for (const o of reading.orphans) rows.push([clip(o.slug, 40), sizeLabel(o.rssKB), String(o.pids.length), o.reapable ? "reaped on the next sweep" : "too young to reap"])
    for (const line of table(rows, new Set([1, 2]))) out.push(`  ${line}`)
  }
  return `${out.join("\n")}\n`
}

// ───────────────────────────── the command

export const TOP_USAGE = `Usage: ntwine top [--json] [--watch]

Memory on this machine and ntwine's share of it: the host, the job gate's queue,
RSS per thread, hibernated threads, and processes no thread owns.

  --json    print the reading as JSON
  --watch   refresh every 2s until Ctrl-C`

export async function runTop(argv: readonly string[]): Promise<number> {
  const known = new Set(["--json", "--watch", "--help", "-h"])
  const unknown = argv.find((a) => !known.has(a))
  if (unknown) {
    process.stderr.write(`ntwine top: unknown option ${unknown}\n${TOP_USAGE}\n`)
    return 1
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${TOP_USAGE}\n`)
    return 0
  }
  if (process.platform !== "linux") {
    process.stderr.write("ntwine top: reads /proc, so it runs on Linux only\n")
    return 1
  }
  const json = argv.includes("--json")
  const print = async () => {
    const reading = await readTop()
    return json ? `${JSON.stringify(reading, null, 2)}\n` : renderTop(reading, { width: process.stdout.columns || 120 })
  }
  if (!argv.includes("--watch")) {
    process.stdout.write(await print())
    return 0
  }
  for (;;) {
    const text = await print()
    process.stdout.write(json ? text : `\x1b[H\x1b[2J${text}`)
    await sleep(2_000)
  }
}
