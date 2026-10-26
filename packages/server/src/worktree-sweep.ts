import { execFile } from "node:child_process"
import { type Dirent, existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import path from "node:path"
import { promisify } from "node:util"
import { log as ntwineLog } from "./logging.ts"

// REMOVING IDLE WORKTREES (Settings → Remove idle worktrees after, `removeIdleWorktreesDays`, 7 by
// default, 0 = never). ntwine creates no worktree, mandates no folder for one and removes none on done
// (ARCHITECTURE.md § No worktree opinions). But agents that follow the common convention leave
// `<main checkout>/.ntwine/worktrees/<slug>` behind once their branch is merged, and nothing ever comes
// back for them. So once shortly after boot and daily after, every registered project's repository is
// looked at, and a worktree in that ONE folder goes when nothing in it could be lost and nobody is in
// it. It replaced (2026-10-07) a fork feature that removed the worktrees a thread's transcript named
// when the thread was marked done; this one keys on the folder and on idleness instead, so it needs no
// hook, no worker-contract text and no coupling to Done.
//
// A worktree is removed only when EVERY check below holds. The first that fails, or that cannot be
// answered (git errors, a file that will not stat), keeps it, and the reason is logged:
//
//   1. It is a LINKED worktree git knows (`git worktree list --porcelain`), inside `.ntwine/worktrees`
//      of its repository's main checkout. Not locked (`git worktree remove` would refuse one anyway),
//      not already prunable.
//   2. NO REGISTERED PROJECT IS IN IT. A worktree opened as an ntwine project has its own board and
//      threads, which another tenant's view of "in use" does not cover.
//   3. NO OPEN THREAD IS WORKING IN IT. Any thread on this server that is Running, in the Queue, Pinned
//      or Snoozed — every thread but an unpinned, resting Done one — whose working folder (the tailer's
//      checkout reading, its background shells' folders, its recent sub-agents' folders) is the
//      worktree or inside it. Read from EVERY open project, since a thread may work in another
//      project's worktree; and a repository with a registered project this server has not opened (one
//      served by another ntwine) is skipped whole, because that server's threads are invisible here.
//   4. GIT SAYS IT IS CLEAN: no modified, staged or untracked file (`git status --porcelain`).
//   5. NO IGNORED FILE HOLDS A SECRET OR LOCAL DATA. `git worktree remove` without --force refuses
//      modified and untracked files but deletes IGNORED ones silently, and a `.env`, a key or a local
//      database is ignored precisely because it is not in git. So every ignored file is walked (minus
//      the dependency and build folders of REGENERABLE_DIRS, which are skipped whole) and one whose name
//      KEEP_FILES matches keeps the worktree, unless the main checkout holds an identical copy at the
//      same path (a `.env` copied in to run the tests loses nothing). A `.ntwine/` folder keeps it
//      unless it holds only ntwine's own `.id` / `.gitignore` markers, since a thread's notes live there.
//      Everything else ignored is build or test output and goes.
//      Until 2026-10-26 this was the other way round, an ALLOW list of build-folder names, and on a real
//      repository it removed nothing: arktype's ten idle worktrees were each kept for an `out/`, an
//      `.attest/`, a `__tests__/temp/` or generated docs, while 9.6G of them sat on a full disk. Every
//      repository names its outputs differently; what must never be lost has a short list of names.
//   6. ITS HEAD IS ON A REF. Removing a DETACHED worktree whose commit no branch or tag contains would
//      leave that commit dangling until the next gc. A worktree on a branch passes trivially: branches
//      are never deleted here.
//   7. IDLE FOR AT LEAST N DAYS: now minus the newer of its HEAD's commit time and the newest mtime of
//      any tracked or untracked, non-ignored file. Not the folder's own mtime, which any `ls` of a
//      parent or a build writing an ignored folder moves.
//
// Then `git worktree remove` (never --force: git re-checks clean on its own) and, if anything went,
// `git worktree prune`. Branches are never touched.

const exec = promisify(execFile)

export const DEFAULT_IDLE_WORKTREE_DAYS = 7
const DAY_MS = 86_400_000
export const WORKTREE_SWEEP_INTERVAL_MS = DAY_MS
/** The boot pass waits ten minutes: long enough for every registered project to be opened and its
 *  threads folded (tenant-prime.ts), so the in-use check reads a complete board. */
export const WORKTREE_FIRST_SWEEP_MS = 10 * 60_000
/** The folder, relative to a repository's main checkout. The one convention ntwine recognizes (board.ts
 *  ignores it too; router.ts settleWorktreePath repairs links into it). */
export const WORKTREE_FOLDER = path.join(".ntwine", "worktrees")

/** Dependency and build folders: whatever is under one is rebuilt by an install or a build, so the walk
 *  of check 5 skips them whole rather than reading node_modules file by file. */
export const REGENERABLE_DIRS: ReadonlySet<string> = new Set([
  "node_modules", "dist", "build", "web-dist", "coverage",
  ".turbo", ".cache", ".vite", ".next", ".nuxt", ".svelte-kit", ".parcel-cache", ".eslintcache",
  "target", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".gradle",
])
/** Ignored names that hold what no command rebuilds: environment files, keys and certificates, local
 *  databases, and the `*.local.*` convention for per-machine settings. A template (`.env.example`) is not
 *  one. */
const KEEP_FILES = [
  /^\.env(rc)?$/, /^\.env\.(?!example$|sample$|template$|defaults$).+$/, /\.env$/,
  /\.(pem|key|p12|pfx|jks|keystore)$/, /^id_(rsa|ed25519|ecdsa)$/,
  /\.(db|sqlite|sqlite3|db3)$/, /\.(db|sqlite|sqlite3)-(wal|shm|journal)$/,
  /\.local(\.[^.]+)?$/,
]
/** Past this many files in one ignored folder, the walk stops and the worktree is kept. */
const WALK_LIMIT = 200_000
/** What ntwine itself writes into a folder it resolves as a project (project-root.ts). */
const NTWINE_MARKERS: ReadonlySet<string> = new Set([".id", ".gitignore"])

function identicalInMain(rel: string, worktree: string, main: string | undefined): boolean {
  if (!main) return false
  try {
    const a = path.join(worktree, rel)
    const b = path.join(main, rel)
    if (lstatSync(a).size !== lstatSync(b).size) return false
    return readFileSync(a).equals(readFileSync(b))
  } catch {
    return false
  }
}

/**
 * What in an ignored entry (a `git status --ignored` path relative to the worktree; a trailing `/` is a
 * wholly ignored folder) must not be deleted with its worktree, as paths relative to it; empty when it
 * may all go. See check 5. `main` is the repository's main checkout, for the identical-copy exemption.
 */
export function unrestorable(entry: string, worktree: string, main?: string): string[] {
  const rel = entry.replace(/\/$/, "")
  const segments = rel.split("/")
  if (segments.some((s) => REGENERABLE_DIRS.has(s))) return []
  const last = segments.at(-1)!
  const keep = (file: string): boolean => KEEP_FILES.some((re) => re.test(path.basename(file))) && !identicalInMain(file, worktree, main)
  if (!entry.endsWith("/")) {
    if (segments.at(-2) === ".ntwine" && NTWINE_MARKERS.has(last)) return []
    return keep(rel) ? [rel] : []
  }
  if (last === ".ntwine") {
    try {
      return readdirSync(path.join(worktree, rel)).every((name) => NTWINE_MARKERS.has(name)) ? [] : [entry]
    } catch {
      return [entry]
    }
  }
  const found: string[] = []
  const stack = [rel]
  let seen = 0
  while (stack.length > 0) {
    const dir = stack.pop()!
    let names: Dirent[]
    try {
      names = readdirSync(path.join(worktree, dir), { withFileTypes: true })
    } catch {
      return [`${dir}/ (could not read it)`]
    }
    for (const dirent of names) {
      if (++seen > WALK_LIMIT) return [`${entry} (over ${WALK_LIMIT} files)`]
      const child = `${dir}/${dirent.name}`
      if (dirent.isDirectory()) {
        if (!REGENERABLE_DIRS.has(dirent.name)) stack.push(child)
      } else if (keep(child)) found.push(child)
    }
  }
  return found
}

/** A folder an open thread is working in, for check 3. `by` names the thread in the log. */
export type FolderInUse = { dir: string; by: string }

/**
 * What the checks need to know about one worktree. `undefined` for a fact means it could not be read,
 * and that alone keeps the worktree.
 */
export interface WorktreeFacts {
  path: string
  /** The repository's main checkout, whose identical copy of an ignored file lets it go (check 5). */
  main?: string
  locked?: boolean
  prunable?: boolean
  /** A registered ntwine project at or under the worktree (check 2). */
  project?: string
  /** An open thread working in it (check 3). */
  inUseBy?: FolderInUse
  /** `git status` entries that are not ignored: modified, staged, untracked (check 4). */
  changes: readonly string[] | undefined
  /** `git status --ignored` entries (check 5). */
  ignored: readonly string[] | undefined
  /** Whether some ref contains HEAD (check 6). */
  headOnRef: boolean | undefined
  /** HEAD's committer time, ms (check 7). */
  lastCommitMs: number | undefined
  /** Newest mtime of a tracked or untracked non-ignored file, ms; 0 when there are none (check 7). */
  newestFileMs: number | undefined
}

const list = (items: readonly string[]): string =>
  items.slice(0, 5).join(", ") + (items.length > 5 ? `, and ${items.length - 5} more` : "")

/** Why `facts` must be kept, or undefined when it may be removed. The checks of the header, in order. */
export function idleWorktreeKeepReason(facts: WorktreeFacts, days: number, now = Date.now()): string | undefined {
  if (!(days > 0)) return "removing idle worktrees is off"
  if (facts.locked) return "it is locked"
  if (facts.prunable) return "its folder is already gone"
  if (facts.project) return `it is the registered project ${facts.project}`
  if (facts.inUseBy) return `thread ${facts.inUseBy.by} is working in it (${facts.inUseBy.dir})`
  if (facts.changes === undefined) return "could not read its status"
  if (facts.changes.length > 0) return `it has uncommitted changes: ${list(facts.changes)}`
  if (facts.ignored === undefined) return "could not read its ignored files"
  const handMade = facts.ignored.flatMap((entry) => unrestorable(entry, facts.path, facts.main))
  if (handMade.length > 0) return `it holds ignored files git cannot restore: ${list(handMade)}`
  if (facts.headOnRef === undefined) return "could not tell whether a ref holds its HEAD"
  if (!facts.headOnRef) return "its detached HEAD is on no branch or tag; removing it would orphan the commit"
  if (facts.lastCommitMs === undefined || facts.newestFileMs === undefined) return "could not tell when it was last used"
  const last = Math.max(facts.lastCommitMs, facts.newestFileMs)
  const idleMs = now - last
  if (idleMs < days * DAY_MS) return `used ${formatAge(idleMs)} ago, under ${days}d`
  return undefined
}

function formatAge(ms: number): string {
  if (ms < 0) return "0m"
  const hours = Math.floor(ms / 3_600_000)
  if (hours < 1) return `${Math.floor(ms / 60_000)}m`
  if (hours < 24) return `${hours}h`
  const d = Math.floor(hours / 24)
  const h = hours % 24
  return h ? `${d}d ${h}h` : `${d}d`
}

// ── GIT ────────────────────────────────────────────────────────────────────────────────────────────

async function git(dir: string, args: readonly string[]): Promise<string> {
  // GIT_OPTIONAL_LOCKS=0: `git status` otherwise refreshes the index under a lock, and an agent
  // committing in that worktree at the same moment would see "index.lock exists".
  const { stdout } = await exec("git", ["-C", dir, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  })
  return stdout
}

const errorText = (error: unknown): string => (error as { stderr?: string }).stderr?.trim() || (error instanceof Error ? error.message : String(error))

function canonical(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return path.resolve(dir)
  }
}

/** Whether `child` is `parent` or inside it. Both canonical. */
export function isAtOrInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

export interface WorktreeEntry {
  path: string
  head?: string
  branch?: string
  bare?: boolean
  locked?: boolean
  prunable?: boolean
}

/** `git worktree list --porcelain`, parsed. The first entry is the main worktree. */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = []
  for (const block of porcelain.split(/\n\s*\n/)) {
    let entry: WorktreeEntry | undefined
    for (const line of block.split("\n")) {
      const space = line.indexOf(" ")
      const key = space < 0 ? line : line.slice(0, space)
      const value = space < 0 ? "" : line.slice(space + 1)
      if (key === "worktree") entry = { path: value }
      else if (!entry) continue
      else if (key === "HEAD") entry.head = value
      else if (key === "branch") entry.branch = value
      else if (key === "bare") entry.bare = true
      else if (key === "locked") entry.locked = true
      else if (key === "prunable") entry.prunable = true
    }
    if (entry) out.push(entry)
  }
  return out
}

/** The main checkout of the repository `dir` is in, canonical; undefined when it is not in one (or the
 *  repository is bare). */
export async function mainCheckoutOf(dir: string): Promise<string | undefined> {
  try {
    const main = parseWorktreeList(await git(dir, ["worktree", "list", "--porcelain"]))[0]
    return main && !main.bare ? canonical(main.path) : undefined
  } catch {
    return undefined
  }
}

/** Newest mtime among the tracked and untracked, non-ignored files of `worktree` (0 when none). Throws
 *  when a file will not stat. */
async function newestFileMs(worktree: string): Promise<number> {
  const files = (await git(worktree, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).split("\0")
  let newest = 0
  for (const file of new Set(files)) {
    if (!file) continue
    const ms = lstatSync(path.join(worktree, file)).mtimeMs
    if (ms > newest) newest = ms
  }
  return newest
}

/** Gather the git and filesystem facts for one worktree. Each that fails is left undefined. */
async function gitFacts(main: string, worktree: string): Promise<Pick<WorktreeFacts, "changes" | "ignored" | "headOnRef" | "lastCommitMs" | "newestFileMs">> {
  const facts: Pick<WorktreeFacts, "changes" | "ignored" | "headOnRef" | "lastCommitMs" | "newestFileMs"> = {
    changes: undefined, ignored: undefined, headOnRef: undefined, lastCommitMs: undefined, newestFileMs: undefined,
  }
  try {
    // NUL-separated so a path with a newline or quote reads verbatim. `matching`, not `traditional`:
    // both report a folder an ignore pattern names as one entry (node_modules is one line, not
    // thousands), but `traditional` also collapses a folder that merely CONTAINS only ignored things,
    // hiding which ignored thing was inside.
    const records = (await git(worktree, ["status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=normal"])).split("\0").filter(Boolean)
    facts.changes = records.filter((record) => !record.startsWith("!! "))
    facts.ignored = records.filter((record) => record.startsWith("!! ")).map((record) => record.slice(3))
  } catch {}
  try {
    const head = (await git(worktree, ["rev-parse", "--verify", "HEAD"])).trim()
    facts.headOnRef = (await git(main, ["for-each-ref", "--contains", head, "--format=%(refname)"])).trim().length > 0
    const seconds = Number((await git(worktree, ["log", "-1", "--format=%ct", head])).trim())
    if (Number.isFinite(seconds) && seconds > 0) facts.lastCommitMs = seconds * 1000
  } catch {}
  try {
    facts.newestFileMs = await newestFileMs(worktree)
  } catch {}
  return facts
}

export interface RepoSweepInput {
  /** The repository's main checkout. */
  main: string
  days: number
  /** Folders open threads are working in (check 3). */
  inUse: readonly FolderInUse[]
  /** Registered ntwine projects, by display name and folder (check 2). */
  projects: readonly { name: string; dir: string }[]
  now?: number
  /** Asked between worktrees: a stopping server ends the pass early. */
  stopped?: () => boolean
}

export type RepoSweepResult = { removed: string[]; kept: { path: string; reason: string }[] }

/** Sweep one repository's `.ntwine/worktrees`. Never throws: every failure is a kept worktree. */
export async function sweepRepoWorktrees(input: RepoSweepInput): Promise<RepoSweepResult> {
  const result: RepoSweepResult = { removed: [], kept: [] }
  const main = canonical(input.main)
  const folder = path.join(main, WORKTREE_FOLDER)
  if (!existsSync(folder)) return result
  let entries: WorktreeEntry[]
  try {
    entries = parseWorktreeList(await git(main, ["worktree", "list", "--porcelain"]))
  } catch (error) {
    result.kept.push({ path: folder, reason: `could not list worktrees: ${errorText(error)}` })
    return result
  }
  const registered = new Set<string>()
  const inUse = input.inUse.map((use) => ({ ...use, canonical: canonical(use.dir) }))
  const projects = input.projects.map((project) => ({ ...project, canonical: canonical(project.dir) }))
  // Check 1: linked worktrees (never the main one) inside the folder.
  for (const entry of entries.slice(1)) {
    const dir = canonical(entry.path)
    if (!isAtOrInside(folder, dir) || dir === folder) continue
    registered.add(dir)
    if (input.stopped?.()) break
    const project = projects.find((p) => isAtOrInside(dir, p.canonical))
    const busy = inUse.find((use) => isAtOrInside(dir, use.canonical))
    const cheap: WorktreeFacts = {
      path: dir,
      main,
      locked: entry.locked,
      prunable: entry.prunable,
      ...(project ? { project: project.name } : {}),
      ...(busy ? { inUseBy: { dir: busy.dir, by: busy.by } } : {}),
      changes: [], ignored: [], headOnRef: true, lastCommitMs: 0, newestFileMs: 0,
    }
    // The free checks first: no git for a worktree that is locked, a project, or in use.
    let reason = cheap.locked || cheap.prunable || cheap.project || cheap.inUseBy ? idleWorktreeKeepReason(cheap, input.days, input.now) : undefined
    if (!reason) {
      try {
        reason = idleWorktreeKeepReason({ ...cheap, ...(await gitFacts(main, dir)) }, input.days, input.now)
      } catch (error) {
        reason = `could not check it: ${errorText(error)}`
      }
    }
    if (reason) {
      result.kept.push({ path: dir, reason })
      continue
    }
    if (input.stopped?.()) break
    try {
      await git(main, ["worktree", "remove", dir])
      result.removed.push(dir)
    } catch (error) {
      result.kept.push({ path: dir, reason: `git refused to remove it: ${errorText(error)}` })
    }
  }
  // A folder in there git does not know as a worktree is somebody's, not ours: say so, never touch it.
  try {
    for (const name of readdirSync(folder)) {
      const dir = canonical(path.join(folder, name))
      if (!registered.has(dir) && lstatSync(dir).isDirectory()) result.kept.push({ path: dir, reason: "it is not a worktree git knows" })
    }
  } catch {}
  if (result.removed.length > 0) {
    await git(main, ["worktree", "prune"]).catch((error) => {
      ntwineLog.warn("worktrees", `${main}: git worktree prune failed: ${errorText(error)}`)
    })
  }
  return result
}

// ── THE MACHINE-WIDE PASS ──────────────────────────────────────────────────────────────────────────

export interface WorktreeSweepDeps {
  /** The setting, read fresh each pass. */
  days: () => number
  /** Every registered project (Home included), with whether this server has it open. */
  projects: () => readonly { id: string; name: string; dir: string; stale: boolean; open: boolean; notARepo?: boolean }[]
  /** Every folder an open thread on this server works in, across every open project. */
  inUse: () => Promise<readonly FolderInUse[]>
  now?: () => number
}

/** One pass over every registered project's repository. Returns what it did, for tests; logs it all. */
export async function sweepIdleWorktrees(deps: WorktreeSweepDeps, stopped: () => boolean = () => false): Promise<RepoSweepResult> {
  const total: RepoSweepResult = { removed: [], kept: [] }
  const days = deps.days()
  if (!(days > 0)) return total
  // Group registered projects by repository, so a repository two projects share is swept once and only
  // when every one of them is open here.
  const repos = new Map<string, { name: string; dir: string; open: boolean }[]>()
  const projects: { name: string; dir: string }[] = []
  for (const project of deps.projects()) {
    if (project.stale) continue
    projects.push({ name: project.name, dir: project.dir })
    if (project.notARepo) continue
    const main = await mainCheckoutOf(project.dir)
    if (!main) continue
    repos.set(main, [...(repos.get(main) ?? []), project])
  }
  if (repos.size === 0) return total
  const inUse = await deps.inUse()
  for (const [main, members] of repos) {
    if (stopped()) break
    if (!existsSync(path.join(main, WORKTREE_FOLDER))) continue
    const closed = members.find((member) => !member.open)
    if (closed) {
      ntwineLog.info("worktrees", `${main}: skipped, ${closed.name} is not open on this server, so its threads cannot be checked`)
      continue
    }
    const result = await sweepRepoWorktrees({ main, days, inUse, projects, now: deps.now?.(), stopped })
    for (const dir of result.removed) ntwineLog.info("worktrees", `removed ${dir}: idle ${days}d or more, clean, nothing in use`)
    for (const { path: dir, reason } of result.kept) ntwineLog.info("worktrees", `kept ${dir}: ${reason}`)
    total.removed.push(...result.removed)
    total.kept.push(...result.kept)
  }
  return total
}

export interface WorktreeSweepLoop {
  stop(): Promise<void>
}

/** Run the pass shortly after boot and daily after. Stop awaits a pass in flight. */
export function startIdleWorktreeSweep(deps: WorktreeSweepDeps, timing = { firstMs: WORKTREE_FIRST_SWEEP_MS, everyMs: WORKTREE_SWEEP_INTERVAL_MS }): WorktreeSweepLoop {
  let stopped = false
  let running: Promise<unknown> | undefined
  const run = () => {
    if (stopped || running) return
    running = sweepIdleWorktrees(deps, () => stopped)
      .catch((error) => ntwineLog.warn("worktrees", `idle worktree sweep failed: ${errorText(error)}`))
      .finally(() => {
        running = undefined
      })
  }
  const first = setTimeout(run, timing.firstMs)
  const timer = setInterval(run, timing.everyMs)
  first.unref?.()
  timer.unref?.()
  return {
    async stop() {
      stopped = true
      clearTimeout(first)
      clearInterval(timer)
      await running
    },
  }
}
