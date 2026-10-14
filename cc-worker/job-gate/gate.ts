// The host-wide job gate: one queue of heavy commands (test suites, typechecks, builds) shared by every
// agent on the machine, admitted only while there is memory to run them.
//
// WHY. RAM is the bottleneck on a box running a dozen agent sessions. An arktype mocha suite peaks at
// 2.2–3.2GB RSS, a native tsc at 1.3–2.4GB, and one session launching four suites at once sent a 31GiB
// WSL box into swap thrash that stalled every other agent. Each agent sees only its own commands, so
// the only place a "not now" can be said is the host. Nothing here talks to the ntwine server: the
// state is a directory every wrapper on the machine reads and writes under one lock.
//
// STATE DIRECTORY: `$NTWINE_GATE_DIR`, else `$XDG_STATE_HOME/ntwine/job-gate`, else
// `~/.local/state/ntwine/job-gate`. Durable, so the per-command history survives a reboot (/tmp does
// not on this WSL machine). It holds:
//
//   lock          O_EXCL lock file, `<pid> <epoch ms>`. Held for one read-modify-write (~ms). A holder
//                 that died leaves it behind; a lock older than 5s or whose pid is gone is stale.
//   state.json    The live queue — the file a `ntwine top` view reads. Format (version 1):
//                 {
//                   "version": 1,
//                   "updatedAt": <epoch ms>,
//                   "jobs": [{
//                     "id": "<8 hex>",
//                     "pid": <wrapper pid>, "pidStart": <wrapper starttime, clock ticks since boot>,
//                     "childPid": <job pid once running>,
//                     "session": "<NTWINE_THREAD, else CLAUDE_CODE_SESSION_ID, else ppid:<n>>",
//                     "signature": "<repo>:<path>|<command words>",   see signatureOf()
//                     "cmd": "<argv joined, ≤300 chars>", "cwd": "<cwd>",
//                     "heavy": <bool>,              light jobs skip the slot caps and the FIFO
//                     "estimateMB": <n>,            what admission reserves for it
//                     "status": "queued" | "running",
//                     "enqueuedAt": <epoch ms>, "admittedAt": <epoch ms>,
//                     "rssMB": <current tree RSS>, "peakMB": <peak tree RSS so far>,   running jobs, ~5s stale
//                     "waitReason": "<why it is still queued>"                         queued jobs
//                   }],
//                   "vm": { "pswpin": <pages>, "at": <epoch ms>, "rateMBps": <last swap-in rate> }
//                 }
//                 A job whose wrapper is gone (kill(pid,0) fails, or the pid was reused: its
//                 starttime no longer matches) is pruned by the next reader.
//   history.json  { "<signature>": [{ "peakMB", "at", "exit", "capMB"?, "oom"? }, …last 5] }
//   jobs.jsonl    One telemetry line per finished job: see Telemetry below.
//   config.json   Optional. The same keys as the environment (`{"NTWINE_GATE": "0"}`), read on every
//                 decision, so a running fleet can be retuned or switched off without restarting it.
//                 The environment wins over it, except that EITHER saying `NTWINE_GATE=0` turns the
//                 gate off.
//
// SETTINGS (environment, or config.json):
//   NTWINE_GATE=0                 off: the hook stops wrapping, and a wrapper already queued runs at once
//   NTWINE_GATE_RESERVE_GB=6      memory kept free for everything that is not a gated job
//   NTWINE_GATE_MAX_PER_SESSION=2 heavy jobs one thread may run at once
//   NTWINE_GATE_MAX_HEAVY         heavy jobs the host runs at once; default min(cpus, MemTotal/4GB), ≥ 2
//   NTWINE_GATE_PSI=10            hold while /proc/pressure/memory `some avg10` ≥ this (when PSI exists)
//   NTWINE_GATE_SWAPIN_MBPS=10    without PSI: hold while swap-in runs faster than this
//   NTWINE_GATE_HEAP_FLOOR_MB     the lowest --max-old-space-size the gate ever sets (A3 measurement)
//   NTWINE_GATE_CAPS=0            do not inject NODE_OPTIONS / GOMEMLIMIT
//   NTWINE_GATE_SCOPE=0           do not run jobs in a systemd memory scope
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs"
import { cpus, homedir, totalmem } from "node:os"
import { basename, dirname, join, relative } from "node:path"
import { DEFAULT_ESTIMATE_MB, type Classified } from "./classify.ts"

// ───────────────────────────── settings

export type Env = Record<string, string | undefined>

export function stateDir(env: Env = process.env): string {
  if (env.NTWINE_GATE_DIR) return env.NTWINE_GATE_DIR
  const xdg = env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state")
  return join(xdg, "ntwine", "job-gate")
}

function readConfigFile(dir: string): Env {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"))
    if (!parsed || typeof parsed !== "object") return {}
    const out: Env = {}
    for (const [k, v] of Object.entries(parsed)) if (k.startsWith("NTWINE_GATE")) out[k] = String(v)
    return out
  } catch {
    return {}
  }
}

export interface Settings {
  enabled: boolean
  dir: string
  reserveMB: number
  maxPerSession: number
  maxHeavy: number
  psiThreshold: number
  swapinMBps: number
  heapFloorMB: number
  caps: boolean
  scope: boolean
  /** A job whose estimate is at least this counts against the slot caps and the FIFO. */
  heavyMB: number
}

// The floor under any heap cap: the lowest --max-old-space-size measured to neither OOM nor slow an
// arktype suite (2026-10-08, ark/type's package suite, 890 tests, one run per arm unless noted; peak is
// the whole process tree from /proc, wall from /usr/bin/time):
//
//   NODE_OPTIONS / GOMEMLIMIT     tree peak    wall            result
//   uncapped (2 runs)             2545, 2472   2m 11s, 2m 55s  pass
//   --max-old-space-size=2048     2462, 2530   5m 03s, 1m 43s  2 failing (not OOM), then pass
//   --max-old-space-size=1536     2519         1m 36s          pass
//   GOMEMLIMIT=1536MiB            2474         2m 04s          pass
//   GOMEMLIMIT=1024MiB            2299         2m 19s          pass
//
// The heap cap changes nothing measurable: mocha's own node process peaks at ~0.35GB, and the bulk of
// the 2.5GB is attest's native tsc (tsgo, Go) and its workers. Wall time swung 1m 36s–5m 03s with the
// box's load, so no arm's cost is resolvable under that noise; the one failing run passed when re-run
// and a lower cap passed too, so it is not the cap. GOMEMLIMIT=1024MiB read ~8% lower — one run,
// suggestive at most. Since a heap cap is never set below what history says a job needed (heapCapMB),
// the floor only governs small jobs.
export const HEAP_FLOOR_MB = 1536

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v)
  return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : fallback
}

export function readSettings(env: Env = process.env, opts: { honorEnvOffSwitch?: boolean } = {}): Settings {
  const dir = stateDir(env)
  const file = readConfigFile(dir)
  const merged: Env = { ...file, ...Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith("NTWINE_GATE"))) }
  const off = file.NTWINE_GATE === "0" || ((opts.honorEnvOffSwitch ?? true) && env.NTWINE_GATE === "0")
  const memTotalGB = totalmem() / 2 ** 30
  return {
    enabled: !off,
    dir,
    reserveMB: num(merged.NTWINE_GATE_RESERVE_GB, 6) * 1024,
    maxPerSession: Math.max(1, num(merged.NTWINE_GATE_MAX_PER_SESSION, 2)),
    maxHeavy: Math.max(1, num(merged.NTWINE_GATE_MAX_HEAVY, Math.max(2, Math.min(cpus().length, Math.floor(memTotalGB / 4))))),
    psiThreshold: num(merged.NTWINE_GATE_PSI, 10),
    swapinMBps: num(merged.NTWINE_GATE_SWAPIN_MBPS, 10),
    heapFloorMB: num(merged.NTWINE_GATE_HEAP_FLOOR_MB, HEAP_FLOOR_MB),
    caps: merged.NTWINE_GATE_CAPS !== "0",
    scope: merged.NTWINE_GATE_SCOPE !== "0",
    heavyMB: 1024,
  }
}

/** Who a job belongs to for the per-session cap: the ntwine thread (sub-agents share it), else the Claude session. */
export function sessionOf(env: Env = process.env, ppid = process.ppid): string {
  return env.NTWINE_THREAD?.trim() || env.CLAUDE_CODE_SESSION_ID?.trim() || `ppid:${ppid}`
}

// ───────────────────────────── /proc

const PAGE_KB = 4

export interface ProcEntry { pid: number; ppid: number; rssKB: number; start: number }

/** One pass over /proc/<pid>/stat for every process: ppid, RSS and start time. ~3ms for 350 processes. */
export function scanProcs(): Map<number, ProcEntry> {
  const out = new Map<number, ProcEntry>()
  let names: string[]
  try { names = readdirSync("/proc") } catch { return out }
  for (const name of names) {
    const c = name.charCodeAt(0)
    if (c < 48 || c > 57) continue
    const entry = readStat(Number(name))
    if (entry) out.set(entry.pid, entry)
  }
  return out
}

/** Parse /proc/<pid>/stat. The comm field may hold spaces and parens, so fields count from the LAST ')'. */
export function readStat(pid: number): ProcEntry | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8")
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ")
    // fields[0] is field 3 (state): ppid is field 4, starttime field 22, rss field 24.
    return { pid, ppid: Number(fields[1]), start: Number(fields[19]), rssKB: Number(fields[21]) * PAGE_KB }
  } catch {
    return null
  }
}

/** Every pid in the tree rooted at `root`, root included. */
export function treeOf(root: number, procs: Map<number, ProcEntry>): number[] {
  const children = new Map<number, number[]>()
  for (const p of procs.values()) {
    const list = children.get(p.ppid)
    if (list) list.push(p.pid)
    else children.set(p.ppid, [p.pid])
  }
  const out: number[] = []
  const stack = [root]
  while (stack.length) {
    const pid = stack.pop()!
    if (!procs.has(pid)) continue
    out.push(pid)
    for (const child of children.get(pid) ?? []) stack.push(child)
  }
  return out
}

export function treeRssMB(root: number, procs: Map<number, ProcEntry>): number {
  let kb = 0
  for (const pid of treeOf(root, procs)) kb += procs.get(pid)!.rssKB
  return Math.round(kb / 1024)
}

/** VmHWM: a process's own peak RSS, which catches a spike between two polls. */
export function hwmMB(pid: number): number {
  try {
    const m = /VmHWM:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))
    return m ? Math.round(Number(m[1]) / 1024) : 0
  } catch {
    return 0
  }
}

export function memAvailableMB(): number {
  try {
    const m = /MemAvailable:\s+(\d+)/.exec(readFileSync("/proc/meminfo", "utf8"))
    return m ? Math.round(Number(m[1]) / 1024) : 0
  } catch {
    return 0
  }
}

/** PSI `some avg10` for memory, or null where the kernel has no PSI (WSL's 5.15 is built without it). */
export function psiSomeAvg10(path = "/proc/pressure/memory"): number | null {
  try {
    const m = /some avg10=([\d.]+)/.exec(readFileSync(path, "utf8"))
    return m ? Number(m[1]) : null
  } catch {
    return null
  }
}

export function readPswpin(): number | null {
  try {
    const m = /^pswpin (\d+)$/m.exec(readFileSync("/proc/vmstat", "utf8"))
    return m ? Number(m[1]) : null
  } catch {
    return null
  }
}

/** Alive and still the same process: a pid recycled since it was recorded has a different starttime. */
export function isAlive(pid: number, start?: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false
  }
  if (start === undefined) return true
  const now = readStat(pid)
  return now === null ? true : now.start === start
}

// ───────────────────────────── signatures

/**
 * Where a command runs, as `<repo>:<path inside it>`, so every worktree of one repo shares a history:
 * `~/arktype/.ntwine/worktrees/jsi-rev2-val/ark/schema` and `~/arktype/ark/schema` are both
 * `arktype:ark/schema`. A linked worktree's `.git` is a FILE naming `<main>/.git/worktrees/<name>`.
 */
export function repoKey(cwd: string, read = (p: string) => readFileSync(p, "utf8"), isDir = (p: string) => statSync(p).isDirectory()): string {
  let dir = cwd
  for (let depth = 0; depth < 40; depth++) {
    const git = join(dir, ".git")
    try {
      let repo: string
      if (isDir(git)) repo = basename(dir)
      else {
        const gitdir = /^gitdir:\s*(.+)$/m.exec(read(git))?.[1]?.trim() ?? ""
        const main = /^(.*)\/\.git\/worktrees\/[^/]+\/?$/.exec(gitdir)?.[1]
        repo = basename(main ?? dir)
      }
      const rel = relative(dir, cwd)
      return `${repo}:${rel || "."}`
    } catch {
      // no .git here: keep climbing
    }
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return `${basename(cwd)}:.`
}

/** Normalize one word: an absolute path to its basename, a long hex/uuid run to `*`. */
function normalizeWord(word: string): string {
  const w = word.startsWith("/") ? basename(word) : word
  return w.replace(/[0-9a-f]{8,}(-[0-9a-f]{4,})*/gi, "*")
}

/** `<repo>:<path>|<first four normalized command words>`. */
export function signatureOf(cwdKey: string, classified: Classified): string {
  return `${cwdKey}|${classified.words.slice(0, 4).map(normalizeWord).join(" ")}`
}

// ───────────────────────────── history

export interface HistoryEntry { peakMB: number; at: number; exit: number | null; capMB?: number; oom?: boolean }
export type History = Record<string, HistoryEntry[]>
export const HISTORY_DEPTH = 5

/** The memory admission reserves: the worst of the last five peaks plus 10%, else the class default. */
export function estimateMB(entries: HistoryEntry[] | undefined, fallback: Classified["class"]): number {
  const usable = (entries ?? []).filter((e) => e.peakMB > 0)
  if (!usable.length) return DEFAULT_ESTIMATE_MB[fallback]
  return Math.max(64, Math.round(Math.max(...usable.map((e) => e.peakMB)) * 1.1))
}

/**
 * The V8 heap cap for a job, or null when there is nothing measured to size it from — an unmeasured
 * job is never capped, because a cap below its real need is an OOM crash. Never below the floor, and
 * never below what history says the job needs: a past peak (which bounds every process's heap in the
 * tree), a past cap it ran under (so a cap that held never ratchets down from its own lower peaks), and
 * half again over a cap it died under.
 */
export function heapCapMB(entries: HistoryEntry[] | undefined, floorMB: number): number | null {
  const usable = (entries ?? []).filter((e) => e.peakMB > 0)
  if (!usable.length) return null
  let need = 0
  for (const e of usable) {
    need = Math.max(need, e.peakMB)
    if (e.capMB) need = Math.max(need, e.oom ? Math.ceil(e.capMB * 1.5) : e.capMB)
  }
  return Math.max(floorMB, Math.ceil(need / 64) * 64)
}

export function pushHistory(history: History, signature: string, entry: HistoryEntry): History {
  const list = [...(history[signature] ?? []), entry].slice(-HISTORY_DEPTH)
  return { ...history, [signature]: list }
}

// ───────────────────────────── admission

export interface Job {
  id: string
  pid: number
  pidStart?: number
  childPid?: number
  session: string
  signature: string
  cmd: string
  cwd: string
  heavy: boolean
  estimateMB: number
  status: "queued" | "running"
  enqueuedAt: number
  admittedAt?: number
  rssMB?: number
  peakMB?: number
  waitReason?: string
}

export interface Pressure { kind: "psi" | "swapin" | "unknown"; value: number | null; high: boolean }

export interface Host {
  memAvailableMB: number
  pressure: Pressure
  /** Current tree RSS of each running job, by id (jobs absent here count as 0 so far). */
  rssMB: Record<string, number>
}

export type Decision =
  | { admit: true; reason: "idle" | "fits" | "light" | "off" }
  | { admit: false; reason: string }

const gb = (mb: number) => `${(mb / 1024).toFixed(1)}GB`

/**
 * May `job` start now? Pure: the caller supplies the queue and a reading of the host.
 *
 * - Heavy jobs go strictly first-in-first-out among the ELIGIBLE: a job whose own session already runs
 *   its cap is skipped over, so a session that queued five suites cannot block another session's one.
 *   The head of that line is the only heavy job that may start; nothing smaller jumps it, or a stream
 *   of mid-size jobs could starve a big one forever.
 * - With no heavy job running, the head always starts — the box being full of idle agents must never
 *   deadlock the queue, and with nothing gated running there is nothing to wait for.
 * - Memory: MemAvailable, minus the reserve, minus what already-admitted jobs have yet to grow into
 *   (estimate − current RSS), must cover the job's estimate. Without that last term four suites
 *   admitted in the same second would all see the same free memory.
 * - Light jobs (estimate under heavyMB) skip the slot caps and the line; memory alone decides.
 */
export function decide(job: Job, queue: Job[], host: Host, s: Settings): Decision {
  if (!s.enabled) return { admit: true, reason: "off" }
  const running = queue.filter((j) => j.status === "running" && j.id !== job.id)
  const outstanding = running.reduce((sum, j) => sum + Math.max(0, j.estimateMB - (host.rssMB[j.id] ?? 0)), 0)
  const headroom = host.memAvailableMB - s.reserveMB - outstanding
  const memoryReason = () =>
    `needs ${gb(job.estimateMB)}, ${gb(Math.max(0, headroom))} free above the ${gb(s.reserveMB)} reserve`

  if (!job.heavy) {
    if (headroom >= job.estimateMB || running.length === 0) return { admit: true, reason: "light" }
    return { admit: false, reason: memoryReason() }
  }

  const heavyRunning = running.filter((j) => j.heavy)
  const perSession = (session: string) => heavyRunning.filter((j) => j.session === session).length
  if (perSession(job.session) >= s.maxPerSession)
    return { admit: false, reason: `this thread already runs ${perSession(job.session)} heavy jobs (limit ${s.maxPerSession})` }

  const line = queue
    .filter((j) => j.status === "queued" && j.heavy && perSession(j.session) < s.maxPerSession)
    .sort((a, b) => a.enqueuedAt - b.enqueuedAt || a.id.localeCompare(b.id))
  const ahead = line.findIndex((j) => j.id === job.id)
  if (ahead > 0) return { admit: false, reason: `${ahead} job${ahead === 1 ? "" : "s"} ahead in the queue` }

  if (heavyRunning.length === 0) return { admit: true, reason: "idle" }
  if (heavyRunning.length >= s.maxHeavy) return { admit: false, reason: `${heavyRunning.length} heavy jobs running (limit ${s.maxHeavy})` }
  if (host.pressure.high) {
    return {
      admit: false,
      reason: host.pressure.kind === "psi"
        ? `memory pressure at ${host.pressure.value}% (limit ${s.psiThreshold}%)`
        : host.pressure.kind === "swapin"
          ? `swap-in at ${host.pressure.value}MB/s (limit ${s.swapinMBps}MB/s)`
          : "measuring swap activity",
    }
  }
  if (headroom < job.estimateMB) return { admit: false, reason: `${memoryReason()} (${heavyRunning.length} heavy running)` }
  return { admit: true, reason: "fits" }
}

// ───────────────────────────── shared state under a lock

export interface State {
  version: 1
  updatedAt: number
  jobs: Job[]
  vm?: { pswpin: number; at: number; rateMBps?: number }
}

const emptyState = (): State => ({ version: 1, updatedAt: Date.now(), jobs: [] })

function readJson<T>(path: string, fallback: () => T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return fallback()
  }
}

function writeJsonAtomic(path: string, value: unknown) {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value))
  renameSync(tmp, path)
}

const sleeper = new Int32Array(new SharedArrayBuffer(4))
const sleepSync = (ms: number) => Atomics.wait(sleeper, 0, 0, ms)

/** Take the lock, run `fn`, release. Throws after `timeoutMs` so a caller can fail open. */
export function withLock<T>(dir: string, fn: () => T, timeoutMs = 10_000): T {
  mkdirSync(dir, { recursive: true })
  const lock = join(dir, "lock")
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const fd = openSync(lock, "wx")
      writeFileSync(fd, `${process.pid} ${Date.now()}`)
      closeSync(fd)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      let seen = ""
      try { seen = readFileSync(lock, "utf8") } catch { continue }
      const [pid, at] = seen.split(" ").map(Number)
      if (!isAlive(pid) || Date.now() - at > 5_000) {
        // Re-read right before removing so a lock taken since our read is left alone.
        try { if (readFileSync(lock, "utf8") === seen) unlinkSync(lock) } catch {}
        continue
      }
      if (Date.now() > deadline) throw new Error("job gate lock timeout")
      sleepSync(5 + Math.random() * 15)
    }
  }
  try {
    return fn()
  } finally {
    try { unlinkSync(lock) } catch {}
  }
}

/** Read the state, drop jobs whose wrapper is gone, let `fn` change it, write it back. */
export function updateState<T>(dir: string, fn: (state: State) => T): T {
  return withLock(dir, () => {
    const path = join(dir, "state.json")
    const state = readJson<State>(path, emptyState)
    if (!Array.isArray(state.jobs)) state.jobs = []
    state.jobs = state.jobs.filter((j) => isAlive(j.pid, j.pidStart))
    const result = fn(state)
    state.updatedAt = Date.now()
    writeJsonAtomic(path, state)
    return result
  })
}

export function readState(dir: string): State {
  const state = readJson<State>(join(dir, "state.json"), emptyState)
  if (!Array.isArray(state.jobs)) state.jobs = []
  state.jobs = state.jobs.filter((j) => isAlive(j.pid, j.pidStart))
  return state
}

export function readHistory(dir: string): History {
  const h = readJson<History>(join(dir, "history.json"), () => ({}))
  return h && typeof h === "object" ? h : {}
}

export function recordHistory(dir: string, signature: string, entry: HistoryEntry) {
  withLock(dir, () => writeJsonAtomic(join(dir, "history.json"), pushHistory(readHistory(dir), signature, entry)))
}

// Telemetry: one JSON object per line, appended when a job ends.
//   { v: 1, at, id, signature, session, cmd, cwd, heavy, estimateMB, peakMB, queueWaitMs, wallMs,
//     exit, signal, admit: { reason, memAvailableMB, pressure: { kind, value }, heavyRunning },
//     capMB?, scope? }
export function appendTelemetry(dir: string, record: Record<string, unknown>) {
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, "jobs.jsonl"), `${JSON.stringify({ v: 1, at: new Date().toISOString(), ...record })}\n`)
}

/**
 * Read memory pressure. PSI where the kernel has it; else the swap-in rate since the last reading any
 * wrapper took (kept in state.vm, so a fresh waiter needs no sampling delay of its own).
 *
 * The swap-in fallback threshold, 10MB/s: on this box at 2026-10-08, with 7.4GB already swapped out and
 * the CPUs ~90% busy, six 2s samples read 0.15–2MB/s (39–502 pages/s). Swap thrash is a sustained
 * multiple of that. 10MB/s is five times the busiest normal sample and well under a thrash.
 */
export function readPressure(state: State, s: Settings, now = Date.now()): Pressure {
  const psi = psiSomeAvg10()
  if (psi !== null) return { kind: "psi", value: psi, high: psi >= s.psiThreshold }
  const pswpin = readPswpin()
  if (pswpin === null) return { kind: "unknown", value: null, high: false }
  const prev = state.vm
  if (!prev || now - prev.at > 30_000 || pswpin < prev.pswpin) {
    state.vm = { pswpin, at: now }
    return { kind: "unknown", value: null, high: true }
  }
  if (now - prev.at < 1_000) {
    if (prev.rateMBps === undefined) return { kind: "unknown", value: null, high: true }
    return { kind: "swapin", value: prev.rateMBps, high: prev.rateMBps >= s.swapinMBps }
  }
  const rate = Math.round((((pswpin - prev.pswpin) * PAGE_KB) / 1024 / ((now - prev.at) / 1000)) * 10) / 10
  state.vm = { pswpin, at: now, rateMBps: rate }
  return { kind: "swapin", value: rate, high: rate >= s.swapinMBps }
}
