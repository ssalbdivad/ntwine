// The parent side of the Claude session broker: derive its socket/record paths, fork it as a detached
// daemon, and — after a ntwine restart — ADOPT an already-running one instead of cold-starting. Mirrors
// codex-app-server-host.ts (fork/record/adopt), keyed per Claude session id (one broker per thread).
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { accessSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, delimiter, dirname, isAbsolute, join } from "node:path"
import { resolveDetachedDaemonEntry } from "../detached-daemons.ts"
import type { BrokerRecord, ClaudeBrokerConfig } from "./claude-agent-broker.ts"
import { claudeBrokerDiagnosticLogPath, describeClaudeBrokerExit, readClaudeBrokerExit, recordClaudeBrokerTermination, type ClaudeBrokerTerminationCause } from "./claude-broker-diagnostics.ts"
import { endDaemonTree, type EndDaemonTreeDeps } from "./daemon-tree.ts"
import { ntwineIpcPath } from "./ipc-path.ts"
import { recordedDaemonIsLive } from "./daemon-identity.ts"
import type { WorkerMcpServers } from "./project-mcp-servers.ts"
import { launchEnvironment } from "./worker-env.ts"

// The Claude Agent SDK REQUIRES an absolute `pathToClaudeCodeExecutable` (validateExecutablePath rejects
// a bare name), unlike an execvp of the CLI, which resolves "claude" on PATH itself. When the dispatch layer
// hands us a bare "claude" (the default when no --claude-bin is configured — the promoted-artifact case),
// resolve it to an absolute path on PATH here, or the forked daemon dies on startup ("executablePath must
// be absolute") before it can publish its record and every dispatch times out with "did not become ready".
//
// WINDOWS is a different problem, and the naive scan below got it wrong. `npm i -g` writes THREE files
// into the bin dir — `claude` (a `#!/bin/sh` script), `claude.cmd`, and `claude.ps1` — because Windows
// cannot symlink the way POSIX npm does. The bare-name scan therefore found the SH SCRIPT and returned
// it: nothing on Windows can run that (spawning it is ENOENT, and `node` reads it as JavaScript and
// dies on line 2). Measured on Windows Server 2022 with claude 2.1.220:
//
//   spawn(<bin>\claude)      -> ENOENT          node <bin>\claude   -> SyntaxError at line 2
//   spawn(<bin>\claude.cmd)  -> EINVAL          (Node refuses .cmd/.bat without shell since CVE-2024-27980)
//   spawn(<real claude.exe>) -> exit 0 "2.1.220 (Claude Code)"
//
// So `.cmd` is not the answer either. The real executable is a NATIVE claude.exe that ships inside the
// package and is NOT itself on PATH — the `.cmd` shim is just a stub that calls it. Hence: prefer a
// real `.exe` on PATH, else find the `.cmd` shim and follow it to the target it invokes.
const WINDOWS_SHIM_TARGET = /^\s*"%dp0%\\(.+?)"/mu

/** Read a `.cmd` shim and return the absolute path of the executable it actually invokes. */
function windowsShimTarget(shimPath: string): string | undefined {
  let body: string
  try { body = readFileSync(shimPath, "utf8") } catch { return undefined }
  const target = WINDOWS_SHIM_TARGET.exec(body)?.[1]
  if (!target) return undefined
  const full = join(dirname(shimPath), target)
  try { accessSync(full, fsConstants.F_OK); return full } catch { return undefined }
}

/** The search path, under whatever name this environment spells it.
 *
 *  `env.PATH` is not enough and the difference is Windows-fatal. Windows environment names are
 *  case-insensitive and it spells this one `Path`; only `process.env` emulates that, so a plain object
 *  copied out of it — which is exactly what the bridge hands this resolver — has no `PATH` key at all.
 *  Measured on Windows Server 2022 / node 26.7.0: `Object.keys(process.env)` contains `Path`,
 *  `{...process.env}.PATH` is `undefined`, and this function resolved claude 2.1.241 from `process.env`
 *  while THROWING on a plain copy of the same environment. That throw is raised during context
 *  creation, so it did not merely break dispatch — the whole server refused to boot on Windows. */
function searchPath(env: NodeJS.ProcessEnv): string {
  const direct = env.PATH ?? env.Path ?? env.path
  if (direct !== undefined) return direct
  for (const [key, value] of Object.entries(env)) if (key.toLowerCase() === "path") return value ?? ""
  return ""
}

export function resolveClaudeExecutableAbsolute(bin: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const candidate = bin && bin.length > 0 ? bin : "claude"
  if (isAbsolute(candidate)) return candidate
  const windows = process.platform === "win32"
  for (const dir of searchPath(env).split(delimiter)) {
    if (!dir) continue
    if (windows) {
      // A real executable wins outright (a standalone install, or a future npm layout that ships one).
      const exe = join(dir, `${candidate}.exe`)
      try { accessSync(exe, fsConstants.F_OK); return exe } catch { /* no .exe here */ }
      // Otherwise follow the npm `.cmd` stub to the binary it calls. Deliberately NEVER return the
      // extensionless sibling: on Windows that is a POSIX shell script and it is unusable.
      const viaShim = windowsShimTarget(join(dir, `${candidate}.cmd`))
      if (viaShim) return viaShim
      continue
    }
    const full = join(dir, candidate)
    try { accessSync(full, fsConstants.X_OK); return full } catch { /* try next PATH entry */ }
  }
  throw new Error(`Claude session broker: could not resolve '${candidate}' to an absolute executable path on PATH (the SDK requires one)`)
}

/** Short, collision-resistant endpoint name — a unix socket on POSIX, a named pipe on Windows.
 *  See ipc-path.ts for why the two spellings exist and what each one costs. */
export function claudeBrokerSocketPath(stateDir: string, sessionId: string): string {
  const key = createHash("sha256").update(stateDir).update("\0").update(sessionId).digest("hex").slice(0, 16)
  return ntwineIpcPath(`ntwine-claude-${key}`)
}

/** The discovery record lives under the project state dir (long paths are fine here). */
export function claudeBrokerRecordPath(stateDir: string, sessionId: string): string {
  // Memoised: the board asks for every broker row's record on every assemble (claudeBrokerDaemonAlive),
  // and the sha256 + join alone were ~300ms of a 40s profile on a 440-session mirror (2026-10-01).
  const memoKey = `${stateDir}\0${sessionId}`
  const known = recordPathMemo.get(memoKey)
  if (known !== undefined) return known
  const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 16)
  const path = join(stateDir, "claude-broker", `${key}.json`)
  if (recordPathMemo.size >= 20_000) recordPathMemo.clear()
  recordPathMemo.set(memoKey, path)
  return path
}
const recordPathMemo = new Map<string, string>()

// One directory listing per record directory per SYNCHRONOUS TURN, so a caller asking about hundreds of
// sessions in one go — the board, once per assemble — pays one readdir rather than one failed open (and
// the ENOENT exception node builds for it) per row. Almost every row asks about a record that does not
// exist: a board is mostly history, and a daemon's record lives only as long as the daemon. Measured on a
// mirror of the maintainer's machine (9 projects, 440 sessions, 6 streaming) on 2026-10-01: the board's
// liveness probe was 1.3s of readFileSync in a 40s profile — the single largest item in board assembly.
// A record that appears mid-turn (another process's write) is seen next turn; one deleted mid-turn is
// still read through liveBrokerRecord, which answers null for it as before.
let turnListings: Map<string, ReadonlySet<string> | null> | undefined
function recordListed(recordPath: string): boolean {
  if (!turnListings) {
    turnListings = new Map()
    queueMicrotask(() => { turnListings = undefined })
  }
  const dir = dirname(recordPath)
  let names = turnListings.get(dir)
  if (names === undefined) {
    try { names = new Set(readdirSync(dir)) } catch { names = null }
    turnListings.set(dir, names)
  }
  return names !== null && names.has(basename(recordPath))
}

/** liveBrokerRecord, for a caller probing many sessions at once: an unlisted record is answered from the
 *  turn's directory listing without opening it. Same answer, same pruning of a stale record. */
export function liveBrokerRecordListed(recordPath: string): BrokerRecord | null {
  return recordListed(recordPath) ? liveBrokerRecord(recordPath) : null
}

/** Why ntwine retired a daemon ON PURPOSE, while keeping the conversation. Every one of these ends a
 *  PROCESS, never a session: the transcript is on disk and the next input cold-resumes it.
 *   - `retire`        — a launch flag changed (permission mode / restart worker), so the next turn
 *                       has to start under a new process. See the bridge's retireDaemon.
 *   - `fresh-process` — a usage-limit resume; the latched `claude` would refuse the message.
 *   - `hibernate`     — the thread has rested past the idle threshold and its memory was reclaimed.
 *                       See thread-hibernation.ts. */
export type BrokerRetirementReason = "retire" | "fresh-process" | "hibernate"
const RETIREMENT_REASONS: readonly string[] = ["retire", "fresh-process", "hibernate"] satisfies BrokerRetirementReason[]
function isRetirement(cause: ClaudeBrokerTerminationCause | undefined): cause is BrokerRetirementReason {
  return cause !== undefined && RETIREMENT_REASONS.includes(cause)
}

/** The breadcrumb one intentional teardown leaves for the cold resume that follows it. */
export interface BrokerRetirementMark {
  at: string
  /** The generation of the daemon that was retired. A LATER daemon's genuine death must never be
   *  masked by a mark left for its predecessor, so the consumer compares this against the exit
   *  record's own generation before it suppresses anything. */
  generation: string
  reason: BrokerRetirementReason
}

/** Sits beside the record and the diagnostics log so a session's whole broker footprint stays in one
 *  directory. Deliberately NOT a `.json` name: liveBrokerRecords() reads every `*.json` here as a
 *  BrokerRecord and unlinks whatever fails its pid probe, which would delete this the moment it was
 *  written. */
export function claudeBrokerRetirementPath(stateDir: string, sessionId: string): string {
  const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 16)
  return join(stateDir, "claude-broker", `${key}.retired`)
}

/** Record that the daemon about to die is dying because ntwine asked. Best-effort: a mark that cannot
 *  be written costs one spurious "the thread crashed" log line, never the teardown itself. */
export function markBrokerRetired(stateDir: string, sessionId: string, reason: BrokerRetirementReason, generation: string): void {
  const mark: BrokerRetirementMark = { at: new Date().toISOString(), generation, reason }
  try {
    const path = claudeBrokerRetirementPath(stateDir, sessionId)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(mark))
  } catch { /* forensics degrade, never throw */ }
}

/** Read and CONSUME the mark — one intentional teardown explains exactly one cold resume. Consuming
 *  it here (rather than leaving it for a later reader) is what stops a stale mark from ever swallowing
 *  a second, genuine death. */
export function takeBrokerRetirement(stateDir: string, sessionId: string): BrokerRetirementMark | null {
  const path = claudeBrokerRetirementPath(stateDir, sessionId)
  let mark: BrokerRetirementMark | null = null
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BrokerRetirementMark>
    if (typeof parsed?.at === "string" && typeof parsed.generation === "string" && typeof parsed.reason === "string") {
      mark = { at: parsed.at, generation: parsed.generation, reason: parsed.reason as BrokerRetirementReason }
    }
  } catch { /* no mark, or a torn write — either way there is nothing to explain a death with */ }
  try { unlinkSync(path) } catch {}
  return mark
}

/** Where the bridge records that one agent in a session has had its first approval held back (see
 *  `claudeFirstApprovalHint`). Per AGENT, because a sub-agent never sees the note its parent was given.
 *  On disk because the daemon — and so the conversation that read the note — outlives a ntwine restart,
 *  and a second "first time" after every restart would be the noise the note exists to spare. Not a
 *  `.json` name, for the reason claudeBrokerRetirementPath gives. */
export function claudePermissionHintPath(stateDir: string, sessionId: string, agentId: string | undefined): string {
  const key = createHash("sha256").update(sessionId).update("\0").update(agentId ?? "").digest("hex").slice(0, 16)
  return join(stateDir, "claude-broker", `${key}.perm-hint`)
}

export function permissionHintGiven(stateDir: string, sessionId: string, agentId: string | undefined): boolean {
  return existsSync(claudePermissionHintPath(stateDir, sessionId, agentId))
}

/** Best-effort, like the retirement mark: a mark that cannot be written costs one repeat of the note
 *  after a restart. The bridge keeps its own in-memory copy, so it never costs a loop. */
export function markPermissionHintGiven(stateDir: string, sessionId: string, agentId: string | undefined): void {
  try {
    const path = claudePermissionHintPath(stateDir, sessionId, agentId)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, new Date().toISOString())
  } catch { /* see above */ }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM" }
}

export function readBrokerRecord(recordPath: string): BrokerRecord | null {
  try { return JSON.parse(readFileSync(recordPath, "utf8")) as BrokerRecord } catch { return null }
}

/** Where a session's LAST daemon identity survives after its record is gone.
 *
 *  A record is deleted the moment anyone notices the daemon is dead, and by then nobody can say WHICH
 *  daemon that was — which is the one thing the death report needs, because a session's diagnostic log
 *  accumulates every generation and "the newest entry" is only the right answer when the daemon that
 *  just died managed to write one. Preserving the identity on the way out is what lets the report tell a
 *  cause this daemon recorded from a predecessor's, instead of quoting the predecessor's in the
 *  confident voice of the current one (measured 2026-08-19: a 21:57:54 SIGKILL reported as
 *  "exited (signal-SIGTERM) at 21:55:46"). Both deletion sites below write it, so no path loses it. */
export function brokerLastKnownPath(recordPath: string): string { return `${recordPath}.last` }

/** The identity of the last daemon ntwine knew for this session, alive or dead. Outlives the record. */
export function lastKnownBrokerDaemon(stateDir: string, sessionId: string): BrokerRecord | null {
  return readBrokerRecord(brokerLastKnownPath(claudeBrokerRecordPath(stateDir, sessionId)))
}

/** Remember who this record named, then let it be deleted. Best-effort: forensics never block a teardown. */
function rememberBrokerIdentity(recordPath: string, record: BrokerRecord): void {
  try { writeFileSync(brokerLastKnownPath(recordPath), JSON.stringify(record)) } catch {}
}

/** A record whose daemon is still alive; prunes a stale record as a side effect. */
export function liveBrokerRecord(recordPath: string): BrokerRecord | null {
  const record = readBrokerRecord(recordPath)
  // The pid AND its birth (daemon-identity.ts): after a reboot a stale record's pid can belong to a
  // stranger, which `killBroker` would SIGTERM on Stop and the hibernation sweep would retire.
  if (record && recordedDaemonIsLive(record.daemonPid, record.processStart, pidAlive)) return record
  if (record) { rememberBrokerIdentity(recordPath, record); try { unlinkSync(recordPath) } catch {} }
  return null
}

/** Every broker daemon under this state dir that is still running — the set a booting ntwine can adopt.
 *
 *  Enumerates the record DIRECTORY rather than probing one path per registry row: the record filename
 *  is a hash of the session id and cannot be inverted, and at boot the live set (a handful of daemons)
 *  is tiny next to a project's session history (hundreds of rows). Stale records are pruned on the way
 *  through, exactly as a single liveBrokerRecord read does. Never throws — a project that has never run
 *  a broker has no such directory, and that is simply "none". */
export function liveBrokerRecords(stateDir: string): BrokerRecord[] {
  const dir = join(stateDir, "claude-broker")
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }
  const out: BrokerRecord[] = []
  for (const name of names) {
    if (!name.endsWith(".json")) continue // the .diagnostics.log files live here too
    const record = liveBrokerRecord(join(dir, name))
    if (record) out.push(record)
  }
  return out
}

export interface ForkBrokerOptions {
  stateDir: string
  cwd: string
  sessionId: string
  executablePath: string
  permissionMode?: ClaudeBrokerConfig["permissionMode"]
  env: Record<string, string>
  appendSystemPrompt?: string
  model?: string
  effort?: string
  /** Resume the on-disk session instead of starting fresh (dead-daemon follow-up cold start). */
  resume?: boolean
  /** Fork this session into `sessionId` on first start — see ClaudeBrokerConfig.forkFrom. */
  forkFrom?: string
  /** The ntwine worker environment (plugin + MCP + per-thread ntwine vars) — see ClaudeBrokerConfig. */
  pluginDir?: string
  mcpServers?: WorkerMcpServers
  allowedTools?: string[]
  workerEnv?: Record<string, string>
  /** Override the daemon entry (tests). Defaults to the bundled/sibling claude-agent-broker. */
  daemonEntry?: string
  timeoutMs?: number
}

/** Spawn the broker as a detached daemon; resolve once it has published its record (socket listening). */
export function forkBroker(options: ForkBrokerOptions): Promise<BrokerRecord> {
  const socketPath = claudeBrokerSocketPath(options.stateDir, options.sessionId)
  const recordPath = claudeBrokerRecordPath(options.stateDir, options.sessionId)
  mkdirSync(dirname(recordPath), { recursive: true })
  const generation = randomUUID()
  const config: ClaudeBrokerConfig = {
    socketPath, cwd: options.cwd, sessionId: options.sessionId, executablePath: options.executablePath,
    permissionMode: options.permissionMode, env: options.env, recordPath, generation,
    // The daemon writes its own death forensics here. Same dir as the record, so a session's socket,
    // record and diagnostics stay together and a project teardown removes all three.
    diagnosticLogPath: claudeBrokerDiagnosticLogPath(options.stateDir, options.sessionId),
    appendSystemPrompt: options.appendSystemPrompt, model: options.model, effort: options.effort,
    resume: options.resume,
    ...(options.forkFrom ? { forkFrom: options.forkFrom } : {}),
    pluginDir: options.pluginDir, mcpServers: options.mcpServers, allowedTools: options.allowedTools,
    workerEnv: options.workerEnv,
  }
  const entry = options.daemonEntry ?? resolveDetachedDaemonEntry(import.meta.url, "claude-agent-broker")
  const child = spawn(process.execPath, [entry], {
    cwd: options.cwd,
    // launchEnvironment, not process.env: the daemon snapshots its own launch env, and the Claude SDK
    // builds the worker's env from it — a live spread would hand every worker the NODE_ENV Vite wrote
    // into the dev server (worker-env.ts).
    env: { ...launchEnvironment(), NTWINE_CLAUDE_BROKER: JSON.stringify(config) },
    detached: true,
    stdio: "ignore",
    // A detached process owns no console on Windows; keep the daemon from ever being handed a
    // visible one (Windows audit 2026-09-11, finding 4 — the Codex daemon's spawn tells the story).
    windowsHide: true,
  })
  child.unref()

  const deadline = Date.now() + (options.timeoutMs ?? 30_000)
  // The cause a dead daemon recorded for itself (claude-broker-diagnostics.ts), keyed to THIS fork's
  // generation so a predecessor's death is never quoted as this one's.
  const recordedCause = () => readClaudeBrokerExit(options.stateDir, options.sessionId, generation)
  return new Promise<BrokerRecord>((resolve, reject) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const settle = (outcome: () => void) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      outcome()
    }
    const poll = () => {
      const record = readBrokerRecord(recordPath)
      // THIS fork's record, by generation. Any other record at this path is a predecessor's — dead, or
      // a stranger on a reused pid — and resolving on it would hand the bridge a daemon that is not the
      // one just spawned (adoptOrForkBroker prunes first, but this function is exported on its own).
      if (record && record.generation === generation && pidAlive(record.daemonPid)) return settle(() => resolve(record))
      if (Date.now() > deadline) {
        // A daemon that died AND wrote its exit record is named here too: the deadline path is what
        // an operator sees when the exit event was missed (a ntwine restart between fork and death).
        const exit = recordedCause()
        return settle(() => reject(new Error(
          `Claude broker for session ${options.sessionId} did not become ready${exit ? `: ${describeClaudeBrokerExit(exit)}` : ""}`,
        )))
      }
      timer = setTimeout(poll, 50)
    }
    child.once("error", (error) => settle(() => reject(error)))
    // A daemon that dies before publishing its record used to be indistinguishable from a slow one:
    // the poll ran the full 30s and rejected with nothing but "did not become ready", while the cause
    // sat in the diagnostics log the daemon had written on its way out (2026-09-10: the pinned
    // binary directory had been swept, the daemon died in under a second with "Claude executable is
    // not executable", and the operator got the opaque timeout for every new thread). `exit` still
    // fires for a detached, unref'd child while this process lives, so reject on the spot and quote
    // the record. The daemon's synchronous exit write can trail the OS exit notification by a few
    // ms, so the read is retried briefly before "left no exit record" is accepted as the answer.
    child.once("exit", (code, signal) => {
      if (settled) return
      const how = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`
      const until = Date.now() + 500
      const read = () => {
        if (settled) return
        const exit = recordedCause()
        if (!exit && Date.now() < until) { setTimeout(read, 25); return }
        settle(() => reject(new Error(
          `Claude broker for session ${options.sessionId} exited before it became ready (${how}): ${describeClaudeBrokerExit(exit)}`,
        )))
      }
      read()
    })
    poll()
  })
}

/** Reattach to a live broker if one exists (ntwine restart), else fork a fresh one. */
export async function adoptOrForkBroker(options: ForkBrokerOptions): Promise<{ record: BrokerRecord; reattached: boolean }> {
  const existing = liveBrokerRecord(claudeBrokerRecordPath(options.stateDir, options.sessionId))
  if (existing) return { record: existing, reattached: true }
  return { record: await forkBroker(options), reattached: false }
}

/** Best-effort terminate: SIGTERM the daemon and drop its record. Detach (client.close) is NOT this.
 *  Returns whether a live daemon record was present (i.e. there was something to stop).
 *
 *  `cause` is why, and it is written into the daemon's diagnostics log BEFORE the signal (see
 *  ClaudeBrokerTerminationRecord): the daemon's own breadcrumb can only ever say `signal-SIGTERM`.
 *
 *  A RETIREMENT cause (`retire` / `fresh-process` / `hibernate`) says this teardown is one ntwine CHOSE
 *  while keeping the conversation, and also leaves the mark that stops the cold resume behind it being
 *  reported to the operator as a crash. Any other cause ends the session itself (a stop, a completion,
 *  a replaced session): there is no later resume to explain, and no death to suppress — and any mark an
 *  EARLIER retirement left is void, so this clears it rather than leaving a promise of a resume that is
 *  never coming. The mark is written BEFORE the signal so a ntwine that dies mid-teardown still leaves
 *  the truth on disk.
 *
 *  The signal goes through endDaemonTree (daemon-tree.ts): SIGTERM on POSIX, where the daemon's own
 *  handler and the SDK's exit cleanup end `claude` under it, and `taskkill /T /F` on Windows, where a
 *  signal is TerminateProcess of the daemon ALONE and `claude.exe` kept running its turn — tools
 *  executing, files changing — behind a card that read stopped (Windows audit 2026-09-11, finding 5).
 *  `deps` is the seam a test routes through. */
export function killBroker(stateDir: string, sessionId: string, cause?: ClaudeBrokerTerminationCause, deps: EndDaemonTreeDeps = {}): boolean {
  const recordPath = claudeBrokerRecordPath(stateDir, sessionId)
  const record = liveBrokerRecord(recordPath)
  if (isRetirement(cause)) { if (record) markBrokerRetired(stateDir, sessionId, cause, record.generation) }
  else takeBrokerRetirement(stateDir, sessionId)
  if (record) {
    recordClaudeBrokerTermination(claudeBrokerDiagnosticLogPath(stateDir, sessionId), { daemonPid: record.daemonPid, generation: record.generation }, cause ?? "unspecified")
    rememberBrokerIdentity(recordPath, record)
    endDaemonTree(record.daemonPid, "SIGTERM", deps)
  }
  try { unlinkSync(recordPath) } catch {}
  return record !== null
}
