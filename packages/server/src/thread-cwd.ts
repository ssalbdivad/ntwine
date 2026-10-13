import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { ThreadWorkingDir, TranscriptMessage, WorkCheckout } from "@ntwine/shared"
import { isDirectory } from "./path-probe.ts"

// WHERE A THREAD IS WORKING NOW — the folder a terminal opened on it starts in (thread-terminals.ts).
//
// Ntwine records only where a thread was LAUNCHED (project.ts workDirOf), and that stops being the answer
// the moment an agent moves: Ntwine deliberately stays out of the worktree decision, so an agent that
// wants isolation makes its own worktree (`git worktree add .ntwine/worktrees/x`, Claude Code's
// EnterWorktree) and works there. A terminal that opened in the project root then ran `npm test` against
// the wrong checkout — upstream's objection to the standalone Terminal tab. So the terminal asks
// the agent's OWN latest reading of where it is:
//
//   CLAUDE — every transcript record carries the session's `cwd`, and it moves. Checked against real
//     transcripts on 2026-09-29 (~/.claude/projects): a Bash `cd` into a folder inside the project
//     moves it and keeps it moved (e.g. `cd .ntwine/worktrees/pre-queue-check` → every later record's
//     `cwd` is that worktree); a `cd` OUTSIDE the project does not stick, because Claude Code resets the
//     shell to the project and says so; and EnterWorktree moves it for the rest of the session (a live
//     `claude -p` run: `cwd` went from the repo to `<repo>/.claude/worktrees/probe` on the first record
//     after the tool call, and the transcript was re-bucketed under the worktree's log dir). Not every
//     record has one — a trailing `cost-state` record does not — so the newest record that DOES wins.
//   CODEX — a rollout's tool calls carry the `workdir` each command ran in (transcript.ts reads it for
//     the tool card), so the newest one is where the agent last worked; before any tool call, the
//     session's own recorded folder (`codex_app_server_session.cwd`).
//   ANYTHING ELSE, or no reading at all — the project root.
//
// A reading is then lifted to the CHECKOUT it lies in: the agent's cwd is often a subfolder it `cd`ed
// into for one grep (`packages/web/src`), and the terminal belongs in the checkout — the project root, or
// the worktree — not in whatever folder the last command happened to need. The walk stops at the project
// root, so a project that is itself a folder inside a larger repository is never climbed out of. The
// human sees the result in the terminal dialog and can edit it before anything starts.

// WHERE A SHELL STARTS when its command opens with a `cd`. The launch record's `cwd` is where the SESSION
// was; `cd /home/ssalb/frizz/packages/web && nubx vite` runs the server somewhere else, and a worktree
// shell is very often exactly `cd .ntwine/worktrees/x && …`. Deliberately NARROW: one leading `cd` to a
// literal path, then `&&` or `;`. A bare token with no `$`, backtick, glob or subshell character, or the
// same wrapped in plain quotes; `~` is the home folder and a relative path resolves against `base`.
// Anything cleverer (`cd "$D"`, `pushd`, a `cd` mid-command, a subshell) answers undefined and the shell
// keeps the session's folder until the OS names the one its process is really in (shell-cwd-probe.ts).
const LEADING_CD_RE = /^\s*cd\s+(?:"([^"$`*?(\\]+)"|'([^'$`*?(]+)'|([^\s"'$`*?(;&|<>\\]+))\s*(?:&&|;)/

export function leadingCd(command: unknown, base: string | undefined): string | undefined {
  if (typeof command !== "string" || !base) return undefined
  const m = LEADING_CD_RE.exec(command)
  const raw = (m?.[1] ?? m?.[2] ?? m?.[3])?.trim()
  if (!raw || raw.startsWith("-")) return undefined // `cd -` / an option is not a folder
  if (raw === "~") return homedir()
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2))
  if (raw.startsWith("~")) return undefined // `~user` — not ours to resolve
  return isAbsolute(raw) ? resolve(raw) : resolve(base, raw)
}

/** How far back the Claude reader looks for a record with a `cwd`. Every record but a handful of
 *  bookkeeping ones carries it, so the newest is almost always in the last few KiB; the bound is only
 *  there so a pathological file cannot turn one click into a whole-transcript scan. */
const CWD_SCAN_BYTES = 8 * 1024 * 1024
const CHUNK_BYTES = 64 * 1024

/** The newest `cwd` a Claude transcript records, reading backwards from the end. A sub-agent's records
 *  (`isSidechain`) are skipped: the terminal follows the thread's own agent. */
export function newestTranscriptCwd(path: string, maxBytes = CWD_SCAN_BYTES): string | undefined {
  let fd: number
  try {
    fd = openSync(path, "r")
  } catch {
    return undefined
  }
  try {
    const size = statSync(path).size
    const floor = Math.max(0, size - maxBytes)
    let end = size
    // The part of a line that straddles two chunks: the head of the line is in the NEXT chunk read.
    let carry = Buffer.alloc(0)
    while (end > floor) {
      const start = Math.max(floor, end - CHUNK_BYTES)
      const chunk = Buffer.alloc(end - start)
      readSync(fd, chunk, 0, chunk.length, start)
      const text = Buffer.concat([chunk, carry])
      // The first piece may be the tail end of a line that began before this chunk: keep its BYTES for the
      // next read (a chunk boundary can split a multi-byte character, so it is never decoded alone) —
      // unless this chunk starts the scan window, where it is whole or cut by the bound; try it anyway.
      const firstBreak = start > floor ? text.indexOf(0x0a) : -1
      carry = start > floor ? (firstBreak === -1 ? text : text.subarray(0, firstBreak)) : Buffer.alloc(0)
      const body = start > floor ? (firstBreak === -1 ? Buffer.alloc(0) : text.subarray(firstBreak + 1)) : text
      const lines = body.toString("utf8").split("\n")
      for (let i = lines.length - 1; i >= 0; i--) {
        const cwd = recordCwd(lines[i]!)
        if (cwd) return cwd
      }
      end = start
    }
    return undefined
  } finally {
    closeSync(fd)
  }
}

function recordCwd(line: string): string | undefined {
  // Cheap reject first: most of a transcript's bytes are tool output with no `cwd` key at all.
  if (!line.includes('"cwd"')) return undefined
  try {
    const record = JSON.parse(line) as { cwd?: unknown; isSidechain?: unknown }
    if (record.isSidechain === true) return undefined
    return typeof record.cwd === "string" && isAbsolute(record.cwd) ? record.cwd : undefined
  } catch {
    return undefined
  }
}

/** The folder the newest tool call in a parsed transcript ran in — Codex's `workdir`. Relative readings
 *  resolve against `base`, the folder the session itself runs in. */
export function newestToolWorkdir(messages: readonly TranscriptMessage[], base: string): string | undefined {
  for (let m = messages.length - 1; m >= 0; m--) {
    const tools = messages[m]!.tools ?? []
    for (let t = tools.length - 1; t >= 0; t--) {
      const cwd = tools[t]!.cwd?.trim()
      if (cwd) return isAbsolute(cwd) ? cwd : resolve(base, cwd)
    }
  }
  return undefined
}

function within(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/** Lift a folder to the checkout it lies in: the nearest ancestor holding a `.git` (a directory for the
 *  main checkout, a file for a linked worktree). The walk stops AT the project root when the folder is
 *  inside the project, so a project that is a subfolder of a bigger repository stays the project. No
 *  checkout found ⇒ the folder itself. */
export function checkoutOf(dir: string, projectDir: string): string {
  const inside = within(dir, projectDir)
  let at = dir
  for (;;) {
    if (inside && at === projectDir) return projectDir
    if (existsSync(join(at, ".git"))) return at
    const up = dirname(at)
    if (up === at) return dir
    at = up
  }
}

// ── ONE CHECKOUT READING, shared by every surface ─────────────────────────────────────────────────────
//
// The agent's own folder (the tailer's fold), each background shell's folder, a human terminal's
// folder and the terminal dialog's prefill all go through `liftCheckout`, so the drawer header, the card,
// a shell row and the dialog can never classify one folder two ways. Nothing else classifies a checkout.
//
// It is MEMOIZED because the tailer asks it on every tick for every thread (the board signature carries
// the agent's checkout, so a move into a worktree pushes exactly one delta): one `.git` walk and one stat
// per new folder, then a map hit. The TTL is what lets a worktree that was removed since stop reading as
// present; 60s is well inside how long anyone looks at a stale token before it matters.
const LIFT_TTL_MS = 60_000
const LIFT_MAX = 256
interface LiftReading {
  /** The folder's checkout — the project root included. */
  dir: string
  /** Present only when that checkout is NOT the project root. */
  checkout?: WorkCheckout
}
const liftMemo = new Map<string, { at: number; value: LiftReading | undefined }>()

function realpathOr(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** `dir` lifted to its checkout (checkoutOf), and whether that checkout is the project root. Undefined
 *  when the folder does not exist — no reading, never a stale name.
 *
 *  ONE SPELLING PER FOLDER: the lift walks the folder's REAL path, so a checkout reads the same whichever
 *  way it was reached. The readings it compares come from different places — the thread's folder off the
 *  transcript's `cwd`, a running shell's off the OS (`/proc/<pid>/cwd`, always resolved) — and the web
 *  decides a row's folder hint by comparing checkouts as strings (ThreadTerminals processFolderHint), so a
 *  worktree reached through a symlink named itself twice: every live row in it said `probe` under a header
 *  that already did. It was once only the ROOT comparison that resolved (macOS spells `/tmp/x` as
 *  `/private/tmp/x` once a process resolves it, and a transcript records the resolved one). The root keeps
 *  the project's own spelling. */
export function liftWorkingDir(dir: string | undefined, projectDir: string | undefined, nowMs = Date.now()): LiftReading | undefined {
  if (!dir || !projectDir || !isAbsolute(dir)) return undefined
  const key = `${projectDir}\u0000${dir}`
  const hit = liftMemo.get(key)
  if (hit && nowMs - hit.at < LIFT_TTL_MS) return hit.value
  let value: LiftReading | undefined
  if (isDirectory(dir)) {
    const project = realpathOr(projectDir)
    const checkout = checkoutOf(realpathOr(dir), project)
    if (checkout === project) value = { dir: projectDir }
    else value = { dir: checkout, checkout: { dir: checkout, kind: isFile(join(checkout, ".git")) ? "worktree" : "folder" } }
  }
  liftMemo.delete(key)
  liftMemo.set(key, { at: nowMs, value })
  while (liftMemo.size > LIFT_MAX) {
    const oldest = liftMemo.keys().next().value
    if (oldest === undefined) break
    liftMemo.delete(oldest)
  }
  return value
}

/** `dir` lifted to its checkout and classified; undefined when that checkout IS the project root (or the
 *  folder is gone). kind "worktree" iff the checkout's `.git` is a FILE. */
export function liftCheckout(dir: string | undefined, projectDir: string | undefined, nowMs = Date.now()): WorkCheckout | undefined {
  return liftWorkingDir(dir, projectDir, nowMs)?.checkout
}

// A SIBLING WORKTREE — `~/repo-perf` made with `git worktree add ../repo-perf` beside the project at
// `~/repo`. The session's `cwd` never reaches it (Claude Code resets a `cd` out of the project), so its
// only trace is where the agent's tools work (FoldState.toolCwd), and that reading is trusted only when
// the checkout it lifts to shares the project's git directory: an edit to `~/.claude/…` memory or to an
// unrelated repository is not the thread moving.

/** The git directory shared by every worktree of `checkout`'s repository (`git rev-parse
 *  --git-common-dir`), real-pathed; undefined when `checkout` holds no `.git`. */
function gitCommonDir(checkout: string): string | undefined {
  const dotGit = join(checkout, ".git")
  try {
    if (statSync(dotGit).isDirectory()) return realpathSync(dotGit)
    const gitdir = /^gitdir:\s*(.+?)\s*$/mu.exec(readFileSync(dotGit, "utf8"))?.[1]
    if (!gitdir) return undefined
    const own = resolve(checkout, gitdir)
    let common = own
    try {
      common = resolve(own, readFileSync(join(own, "commondir"), "utf8").trim())
    } catch {
      // No `commondir`: a main checkout's gitdir is its own common dir.
    }
    return realpathSync(common)
  } catch {
    return undefined
  }
}

/** The nearest ancestor of `dir` (itself included) holding a `.git`. */
function enclosingCheckout(dir: string): string | undefined {
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) return at
    if (dirname(at) === at) return undefined
  }
}

const repoMemo = new Map<string, { at: number; value: string | undefined }>()
function repoOf(dir: string, nowMs: number): string | undefined {
  const hit = repoMemo.get(dir)
  if (hit && nowMs - hit.at < LIFT_TTL_MS) return hit.value
  const checkout = enclosingCheckout(realpathOr(dir))
  const value = checkout ? gitCommonDir(checkout) : undefined
  repoMemo.delete(dir)
  repoMemo.set(dir, { at: nowMs, value })
  while (repoMemo.size > LIFT_MAX) {
    const oldest = repoMemo.keys().next().value
    if (oldest === undefined) break
    repoMemo.delete(oldest)
  }
  return value
}

/** `dir` lifted to its checkout, only when that checkout is a WORKTREE of the project's own repository
 *  other than the project root; undefined otherwise. */
export function liftRepoWorktree(dir: string, projectDir: string, nowMs = Date.now()): LiftReading | undefined {
  // A Write can name a folder it is about to create; its nearest existing ancestor is where it lands.
  let at = dir
  while (!isDirectory(at) && dirname(at) !== at) at = dirname(at)
  const reading = liftWorkingDir(at, projectDir, nowMs)
  if (reading?.checkout?.kind !== "worktree") return undefined
  const repo = repoOf(projectDir, nowMs)
  return repo !== undefined && repoOf(reading.checkout.dir, nowMs) === repo ? reading : undefined
}

/** Test seam: the memo is process-lifetime state keyed by path. */
export function resetCheckoutMemo(): void {
  liftMemo.clear()
  repoMemo.clear()
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export interface ThreadDirReading {
  projectDir: string
  backend: "claude" | "codex" | "acp"
  /** The thread's transcript on disk, when it has one. */
  transcriptPath?: string
  /** Codex only: the parsed rollout, read on demand (it is the only reader that knows both tool protocols). */
  codexMessages?: () => readonly TranscriptMessage[]
  /** Codex only: the app-server session's recorded folder. */
  sessionCwd?: string
}

export function resolveThreadWorkingDir(reading: ThreadDirReading): ThreadWorkingDir {
  const { projectDir } = reading
  const settle = (dir: string | undefined): string | undefined => (dir && isDirectory(dir) ? checkoutOf(dir, projectDir) : undefined)
  if (reading.backend === "claude" && reading.transcriptPath) {
    const dir = settle(newestTranscriptCwd(reading.transcriptPath))
    if (dir) return { dir, source: "transcript" }
  }
  if (reading.backend === "codex") {
    const base = reading.sessionCwd ?? projectDir
    let messages: readonly TranscriptMessage[] = []
    try {
      messages = reading.codexMessages?.() ?? []
    } catch {
      // An unreadable rollout is no reading; fall through to the session's folder.
    }
    const dir = settle(newestToolWorkdir(messages, base))
    if (dir) return { dir, source: "transcript" }
    const session = settle(reading.sessionCwd)
    if (session) return { dir: session, source: "session" }
  }
  return { dir: projectDir, source: "project" }
}

/** The folder a terminal start names, checked: `~` expanded, absolute, and an existing directory.
 *  Throws the message the drawer shows. */
export function terminalFolder(input: string): string {
  const raw = input.trim()
  const expanded = raw === "~" ? homedir() : raw.startsWith(`~/`) || raw.startsWith(`~${sep}`) ? join(homedir(), raw.slice(2)) : raw
  if (!isAbsolute(expanded)) throw new Error(`The folder must be an absolute path: ${raw}`)
  if (!isDirectory(expanded)) throw new Error(`No such folder: ${raw}`)
  return resolve(expanded)
}

// WHERE THE THREAD'S SUB-AGENTS ARE WORKING — the other answer `e` can give. An orchestrating thread
// often never moves at all: its session stays in the project root while the agents it dispatches build in
// a sibling worktree of the same repository (@massive-refactor-branch-status, 2026-10-01: the thread in
// `~/arktype`, every Workflow agent editing `~/rest/orca/workspaces/arktype/featherduster`). A sub-agent's
// `cwd` does not show it either — it records the project root too, because Claude Code resets a `cd` out
// of the project — so, as for the thread itself (tailer.ts trackToolCwd), the reading is where its tools
// WORK: a Bash call's leading `cd`, or the folder of a file it edits. Outside the project it counts only
// when it lifts to a worktree of the project's own repository (liftRepoWorktree); a scratch copy in `/tmp`
// or an edit to `~/.claude` memory is not somewhere to open an editor.

/** Only sub-agents active this recently are read: an orchestrator dispatches hundreds over a long effort,
 *  and where one worked last week is not a choice anyone wants today. */
const SUB_AGENT_RECENT_MS = 24 * 60 * 60 * 1000
/** And at most this many of them, newest first. */
const SUB_AGENT_MAX = 48
/** How much of each sub-agent transcript's tail is read for its newest tool call. */
const SUB_AGENT_TAIL_BYTES = 1024 * 1024
const SUB_AGENT_FILE_EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"])

export interface SubAgentFolder {
  /** The checkout, lifted (liftWorkingDir) — the project root included. */
  dir: string
  /** How many recent sub-agents last worked there. */
  agents: number
  /** The newest of them's own description (its `.meta.json`), when it has one. */
  newest?: string
  newestAtMs: number
}

/** Every `agent-*.jsonl` under a session's `subagents/` folder, Workflow agents' subfolders included. */
function subAgentTranscripts(sessionDir: string): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number) => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const path = join(dir, name)
      if (name.startsWith("agent-") && name.endsWith(".jsonl")) out.push(path)
      else if (depth < 2 && !name.includes(".")) walk(path, depth + 1)
    }
  }
  walk(join(sessionDir, "subagents"), 0)
  return out
}

/** The folder a sub-agent's newest folder-naming tool call worked in, read off its transcript's tail. */
export function newestToolFolder(path: string, maxBytes = SUB_AGENT_TAIL_BYTES): string | undefined {
  let text: string
  try {
    const size = statSync(path).size
    const fd = openSync(path, "r")
    try {
      const start = Math.max(0, size - maxBytes)
      const buf = Buffer.alloc(size - start)
      readSync(fd, buf, 0, buf.length, start)
      text = buf.toString("utf8")
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
  const lines = text.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!line.includes('"tool_use"')) continue
    let record: { cwd?: unknown; message?: { content?: unknown } }
    try {
      record = JSON.parse(line)
    } catch {
      continue // the window's first line, cut mid-record
    }
    const base = typeof record.cwd === "string" && isAbsolute(record.cwd) ? record.cwd : undefined
    const content = Array.isArray(record.message?.content) ? record.message.content : []
    for (let b = content.length - 1; b >= 0; b--) {
      const block = content[b] as { type?: unknown; name?: unknown; input?: { command?: unknown; file_path?: unknown; notebook_path?: unknown } } | null
      if (block?.type !== "tool_use" || typeof block.name !== "string") continue
      const file = block.input?.file_path ?? block.input?.notebook_path
      const dir = block.name === "Bash" ? leadingCd(block.input?.command, base)
        : SUB_AGENT_FILE_EDIT_TOOLS.has(block.name) && typeof file === "string" && isAbsolute(file) ? dirname(file)
        : undefined
      if (dir) return dir
    }
  }
  return undefined
}

function subAgentDescription(transcript: string): string | undefined {
  try {
    const meta = JSON.parse(readFileSync(transcript.replace(/\.jsonl$/u, ".meta.json"), "utf8")) as { description?: unknown }
    return typeof meta.description === "string" && meta.description.trim() ? meta.description.trim() : undefined
  } catch {
    return undefined
  }
}

/** The checkouts a Claude thread's recent sub-agents work in, newest first. `transcriptPath` is the
 *  thread's own transcript; its sub-agents live beside it in `<session>/subagents/`. */
export function subAgentFolders(transcriptPath: string, projectDir: string, nowMs = Date.now()): SubAgentFolder[] {
  const sessionDir = transcriptPath.replace(/\.jsonl$/u, "")
  const recent = subAgentTranscripts(sessionDir)
    .map((path) => {
      try {
        return { path, at: statSync(path).mtimeMs }
      } catch {
        return undefined
      }
    })
    .filter((t): t is { path: string; at: number } => t !== undefined && nowMs - t.at < SUB_AGENT_RECENT_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, SUB_AGENT_MAX)
  const byDir = new Map<string, SubAgentFolder>()
  for (const { path, at } of recent) {
    const raw = newestToolFolder(path)
    if (!raw) continue
    const inside = within(raw, projectDir)
    const reading = inside ? liftWorkingDir(nearestDirectory(raw), projectDir, nowMs) : liftRepoWorktree(raw, projectDir, nowMs)
    if (!reading) continue
    const seen = byDir.get(reading.dir)
    if (seen) seen.agents++
    else {
      const newest = subAgentDescription(path)
      byDir.set(reading.dir, { dir: reading.dir, agents: 1, newestAtMs: at, ...(newest ? { newest } : {}) })
    }
  }
  return [...byDir.values()]
}

function nearestDirectory(path: string): string {
  let at = path
  while (!isDirectory(at) && dirname(at) !== at) at = dirname(at)
  return at
}
