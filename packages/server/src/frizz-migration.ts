// THE FRIZZ -> NTWINE MIGRATION, run once per machine. This product was Frizz until 2026-10-13, and an
// install made under that name keeps every name it was given: its data, state and cache roots
// (`~/.local/share/frizz`, `Application Support/Frizz`, `%LOCALAPPDATA%\Frizz`, or `~/.frizz`), each
// project's `.frizz/` board, `git config frizz.id`, a linked worktree's `frizz.config`, the
// `frizz-server` lease, and `frizz-` thread names and a `frizz_session_id` column in the database.
//
// This module moves all of it to the Ntwine names, and it is the ONLY place in the server that knows
// the old ones. Nothing else reads a Frizz name: path resolution, project identity and the database
// see only what this left behind. It runs at the top of every server and launcher entry
// (frizz-migration-boot.ts), before anything resolves a path, and a second run finds nothing to do.
//
// WHAT RUNNING PROCESSES NEED, and why every move leaves a symlink. A detached broker, ACP or Codex
// daemon outlives the server that started it, and it was handed absolute paths at spawn: its state
// dir, the server lock, its record and its socket. A worker's prompt, git's worktree records
// (`.git/worktrees/<name>/gitdir`) and its shell's cwd hold absolute `.frizz/…` paths. A directory
// rename keeps every open descriptor and the inode of every socket in it, and the link at the old path
// makes every path still in flight resolve to the same files. So nothing here is copied: everything is
// renamed, within one filesystem, and the old name is left pointing at the new one. The links are
// permanent: deleting one is the human's choice, once nothing started before the move is alive.
//
// NEVER DELETES DATA. A target that already exists (a worker hook that wrote under the new name before
// this ran) is merged entry by entry. Where both sides hold the same file, the newer is kept and the
// older moved under `frizz-migration-conflicts/<time>/` in the same root, never removed. Only empty
// directories are ever removed, with rmdir, which refuses anything else.
//
// REFUSES, and says why, when both a Frizz install and an Ntwine install exist: two registries are two
// machines' worth of projects, and which one to keep is the human's decision.
//
// DEFERRED under a supervisor started before the rename. That process (the durable `nub run dev`
// launcher) still runs the old code and keeps its own paths, and it re-forks the server on every
// landed commit: migrating its roots from inside its child would move them while it is mid-flight.
// So a server forked by one serves the Frizz roots as they are (pinNtwineRoots) and only moves the
// project boards; the roots move once the supervisor itself restarts on current code.
import { execFileSync } from "node:child_process"
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { adoptedLegacyEnv } from "@ntwine/shared/legacy-env"
import {
  legacyNtwineRoot,
  pinNtwineRoots,
  pinnedNtwineRoots,
  platformNtwineRoots,
  type NtwineRootDirs,
} from "./ntwine-paths.ts"

/** A project's board link the migration leaves beside `.ntwine` — the dev watcher must not follow it. */
export const LEGACY_BOARD_LINK = ".frizz"
const BOARD = ".ntwine"
const LEGACY_DOT_ROOT = ".frizz"
/** The product's directory name on each platform, in both spellings (ntwine-paths.ts spells the new). */
const ROOT_SEGMENTS: Record<string, string> = { ntwine: "frizz", Ntwine: "Frizz" }
const LEASES = { from: "frizz-server", to: "ntwine-server" }
const GIT_ID_KEYS = { from: "frizz.id", to: "ntwine.id" }
const WORKTREE_CONFIGS = { from: "frizz.config", to: "ntwine.config" }
const THREAD_NAME_PREFIXES = { from: "frizz-", to: "ntwine-" }
const CODEX_SESSION_COLUMNS = { from: "frizz_session_id", to: "ntwine_session_id" }
const CONFLICTS_DIR = "frizz-migration-conflicts"
/** Written in the Ntwine data root once a full run finishes; after it, a boot only looks for boards. */
const DONE_MARKER = ".frizz-migrated"
/** What the pre-rename dev supervisor hands the server it forks (moved to NTWINE_* by legacy-env). */
const PRE_RENAME_SUPERVISOR_ENV = ["FRIZZ_DEV_CHILD", "FRIZZ_DEV_REEXEC", "FRIZZ_ROOTS_PIN", "FRIZZ_LAUNCH_STATE_DIR"]

export interface FrizzMigrationOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  home?: string
  /** Describe every step, change nothing. */
  dryRun?: boolean
  /** Move project boards and git ids only, leaving the roots where they are (the deferred boot). */
  boardsOnly?: boolean
  /** Each step as it is taken (or, in a dry run, planned). */
  log?: (line: string) => void
  now?: () => Date
}

export interface FrizzMigrationResult {
  /** `none`: no Frizz install here, or nothing left to move. */
  status: "none" | "migrated" | "refused"
  /** Every step taken (or planned, in a dry run), in order. */
  steps: string[]
  /** Why it refused. */
  reason?: string
  /** Each root that was (or would be) renamed, old path to new. */
  moved: { from: string; to: string }[]
}

interface RootPair {
  from: string
  to: string
}

interface Install {
  /** Every root directory to rename, data first. */
  pairs: RootPair[]
  /** The Frizz roots the install serves from until it moves. */
  frizzRoots: NtwineRootDirs
  /** The Ntwine roots it serves from once it has. */
  ntwineRoots: NtwineRootDirs
}

function lstatOf(path: string): Stats | undefined {
  try {
    return lstatSync(path)
  } catch {
    return undefined
  }
}

const isRealDir = (path: string) => lstatOf(path)?.isDirectory() === true
const isLink = (path: string) => lstatOf(path)?.isSymbolicLink() === true
const hasRegistry = (root: string) => existsSync(join(root, "registry.json"))

/** The same path with the product's directory spelled the Frizz way: its LAST segment that names it. */
function frizzSpelling(path: string): string {
  const parts = path.split(sep)
  for (let index = parts.length - 1; index >= 0; index--) {
    const old = ROOT_SEGMENTS[parts[index]!]
    if (old !== undefined) {
      parts[index] = old
      return parts.join(sep)
    }
  }
  throw new Error(`no product directory in ${path}`)
}

/** The directory that carries the product's name, at or above `path` (`…/Ntwine` above `…/Ntwine/Data`). */
function productDir(path: string): string {
  const parts = path.split(sep)
  for (let index = parts.length - 1; index >= 0; index--) {
    if (ROOT_SEGMENTS[parts[index]!] !== undefined) return parts.slice(0, index + 1).join(sep)
  }
  throw new Error(`no product directory in ${path}`)
}

function rootsUnder(roots: NtwineRootDirs, map: (path: string) => string): NtwineRootDirs {
  return { data: map(roots.data), state: map(roots.state), cache: map(roots.cache) }
}

/**
 * The Frizz install on this machine, if there is one — by the rule Frizz itself resolved with: a
 * `~/.frizz` holding a registry is the install, otherwise the platform root holding one is. A root
 * already replaced by a link is a migration that ran, possibly in part, so its pairs are returned
 * again for the rest to finish.
 */
function findInstall(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): Install | undefined {
  const dotFrom = join(home, LEGACY_DOT_ROOT)
  const dotTo = legacyNtwineRoot(home)
  const dot: Install = {
    pairs: [{ from: dotFrom, to: dotTo }],
    frizzRoots: { data: dotFrom, state: dotFrom, cache: dotFrom },
    ntwineRoots: { data: dotTo, state: dotTo, cache: dotTo },
  }
  const ntwineRoots = platformNtwineRoots(env, platform, home)
  const pairs: RootPair[] = []
  for (const root of [ntwineRoots.data, ntwineRoots.state, ntwineRoots.cache]) {
    const to = productDir(root)
    if (!pairs.some((pair) => pair.to === to)) pairs.push({ from: frizzSpelling(to), to })
  }
  const platformInstall: Install = { pairs, frizzRoots: rootsUnder(ntwineRoots, frizzSpelling), ntwineRoots }
  const platformData = platformInstall.frizzRoots.data
  if (isRealDir(dotFrom) && hasRegistry(dotFrom)) return dot
  if (isRealDir(platformData) && hasRegistry(platformData)) return platformInstall
  if (isLink(pairs[0]!.from)) return platformInstall
  if (isLink(dotFrom)) return dot
  return undefined
}

function refusal(install: Install, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string | undefined {
  const frizzData = install.frizzRoots.data
  if (!isRealDir(frizzData) || !hasRegistry(frizzData)) return undefined
  // Every place an Ntwine install could already be, whichever layout the Frizz one used.
  for (const ntwineData of [legacyNtwineRoot(home), platformNtwineRoots(env, platform, home).data]) {
    if (isRealDir(ntwineData) && hasRegistry(ntwineData)) {
      return `Both a Frizz install (${frizzData}) and an Ntwine install (${ntwineData}) are on this machine, ` +
        "and Ntwine will not merge two installs. Move the one you no longer want out of the way, then start Ntwine again."
    }
  }
  for (const { to } of install.pairs) {
    const existing = lstatOf(to)
    if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) {
      return `${to} is in the way of the Frizz data moving there. Move it aside, then start Ntwine again.`
    }
  }
  return undefined
}

interface FoldReport {
  moved: number
  conflicts: string[]
}

/**
 * Move every entry of `from` into `into` that `into` lacks, recursing into directories both have. Where
 * both hold an entry that is not two directories, the newer stays at the name and the older goes under
 * `aside`, keeping its relative path. In a dry run, only counts.
 */
function fold(from: string, into: string, aside: string, dryRun: boolean, report: FoldReport = { moved: 0, conflicts: [] }, rel = ""): FoldReport {
  for (const name of readdirSync(from)) {
    const source = join(from, name)
    const target = join(into, name)
    const path = rel ? join(rel, name) : name
    const sourceStat = lstatOf(source)
    const targetStat = lstatOf(target)
    if (!sourceStat) continue
    if (!targetStat) {
      report.moved++
      if (!dryRun) renameSync(source, target)
      continue
    }
    if (sourceStat.isDirectory() && targetStat.isDirectory()) {
      fold(source, target, aside, dryRun, report, path)
      continue
    }
    report.conflicts.push(path)
    if (dryRun) continue
    const kept = freePath(join(aside, path))
    mkdirSync(dirname(kept), { recursive: true })
    if (sourceStat.mtimeMs > targetStat.mtimeMs) {
      renameSync(target, kept)
      renameSync(source, target)
    } else {
      renameSync(source, kept)
    }
  }
  return report
}

function freePath(path: string): string {
  let candidate = path
  for (let n = 1; lstatOf(candidate); n++) candidate = `${path}.${n}`
  return candidate
}

/** rmdir every directory under and including `dir` that is empty once its empty children are gone. */
function removeEmptyTree(dir: string): boolean {
  for (const name of readdirSync(dir)) {
    const child = join(dir, name)
    if (lstatOf(child)?.isDirectory()) removeEmptyTree(child)
  }
  try {
    rmdirSync(dir)
    return true
  } catch {
    return false
  }
}

function link(from: string, to: string, platform: NodeJS.Platform): void {
  if (platform === "win32") symlinkSync(to, from, "junction")
  else symlinkSync(dirname(from) === dirname(to) ? basename(to) : to, from)
}

function linksTo(from: string, to: string): boolean {
  try {
    return resolve(dirname(from), readlinkSync(from)) === resolve(to)
  } catch {
    return false
  }
}

interface Run {
  dryRun: boolean
  platform: NodeJS.Platform
  stamp: string
  steps: string[]
  log: (line: string) => void
}

function step(run: Run, description: string, action: () => void): void {
  run.steps.push(description)
  run.log(description)
  if (!run.dryRun) action()
}

function foldSummary(report: FoldReport, aside: string): string {
  const entries = `${report.moved} ${report.moved === 1 ? "entry" : "entries"}`
  if (!report.conflicts.length) return entries
  return `${entries}; ${report.conflicts.length} in both, newer kept, older saved under ${aside}: ${report.conflicts.slice(0, 5).join(", ")}${report.conflicts.length > 5 ? ", …" : ""}`
}

/**
 * Rename `from` to `to` and leave a link at `from`. A `to` that already exists is merged in first:
 * the side with a registry is the install and the other is folded into it, and otherwise the smaller
 * `to` (written there before this ran) is folded into `from`, which then takes its place. Retried a few
 * times, because a live process can recreate either name in the instant between two renames.
 */
function moveDirectory(run: Run, from: string, to: string, what: string): boolean {
  const source = lstatOf(from)
  if (!source || source.isSymbolicLink()) return false
  if (!source.isDirectory()) throw new Error(`${from} is not a directory`)
  const target = lstatOf(to)
  if (target && hasRegistry(to) && !hasRegistry(from)) {
    const aside = join(to, CONFLICTS_DIR, run.stamp)
    step(run, `Merge ${from} into ${to} (${foldSummary(fold(from, to, aside, true), aside)})`, () => {
      fold(from, to, aside, false)
      removeEmptyTree(from)
    })
  } else {
    if (target) {
      const aside = join(to, CONFLICTS_DIR, run.stamp)
      step(run, `Merge ${to} into ${from} first (${foldSummary(fold(to, from, aside, true), aside)})`, () => {})
    }
    step(run, `Move ${what} ${from} to ${to}`, () => {
      for (let attempt = 0; ; attempt++) {
        try {
          if (lstatOf(to)) {
            fold(to, from, join(from, CONFLICTS_DIR, run.stamp), false)
            if (!removeEmptyTree(to)) throw Object.assign(new Error(`${to} is still in use`), { code: "ENOTEMPTY" })
          }
          renameSync(from, to)
          return
        } catch (error) {
          if (attempt >= 4 || !["ENOTEMPTY", "EEXIST", "EPERM", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
        }
      }
    })
  }
  step(run, `Link ${from} to ${to}`, () => {
    for (let attempt = 0; ; attempt++) {
      try {
        link(from, to, run.platform)
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 4) throw error
        if (linksTo(from, to)) return
        // Something wrote under the old name in the instant it was free: that is the install's too.
        if (!isRealDir(from)) throw error
        fold(from, to, join(to, CONFLICTS_DIR, run.stamp), false)
        removeEmptyTree(from)
      }
    }
  })
  return true
}

/** The registered project folders, read from wherever the data root currently is. */
function registeredProjects(data: string): string[] {
  try {
    const registry = JSON.parse(readFileSync(join(data, "registry.json"), "utf8")) as { projects?: { path?: unknown }[] }
    return (registry.projects ?? []).flatMap((project) => typeof project.path === "string" && isAbsolute(project.path) ? [project.path] : [])
  } catch {
    return []
  }
}

/** Every folder that can hold a board: each registered project, and each state dir (Home's board lives in its own). */
function boardHomes(data: string, home: string): string[] {
  const dirs = new Set(registeredProjects(data))
  try {
    for (const id of readdirSync(join(data, "projects"))) dirs.add(join(data, "projects", id))
  } catch { /* no projects yet */ }
  dirs.add(join(data, "host"))
  // The home folder's own `~/.frizz` is the Frizz dot-root, never a board.
  dirs.delete(home)
  return [...dirs]
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    return undefined
  }
}

/** Whether a board moved (or, in a dry run, would). */
function migrateBoard(run: Run, root: string): boolean {
  const from = join(root, LEGACY_BOARD_LINK)
  const to = join(root, BOARD)
  if (!isRealDir(from)) return false
  // Two different ids would be two projects; picking one by age could hand this folder's threads to
  // another board. The human's call.
  const ids = [from, to].map((board) => {
    try {
      return readFileSync(join(board, ".id"), "utf8").trim()
    } catch {
      return undefined
    }
  })
  if (ids[0] && ids[1] && ids[0] !== ids[1]) {
    run.log(`Left ${from} where it is: ${to} names a different project id`)
    return false
  }
  moveDirectory(run, from, to, "the board")
  excludeBoardLink(run, root)
  return true
}

function excludeBoardLink(run: Run, root: string): void {
  // `.ntwine/.gitignore` cannot ignore a link that sits beside it, so the repository's own exclude does.
  const exclude = join(root, ".git", "info", "exclude")
  if (!isRealDir(join(root, ".git"))) return
  let existing = ""
  try {
    existing = readFileSync(exclude, "utf8")
  } catch { /* none yet */ }
  if (existing.split(/\r?\n/u).includes(`/${LEGACY_BOARD_LINK}`)) return
  step(run, `Exclude /${LEGACY_BOARD_LINK} in ${exclude}`, () => {
    mkdirSync(dirname(exclude), { recursive: true })
    appendFileSync(exclude, `${existing && !existing.endsWith("\n") ? "\n" : ""}/${LEGACY_BOARD_LINK}\n`)
  })
}

/** Copy, never move: a repository keeps the id it committed to under the old key too. */
function migrateGitIds(run: Run, root: string): void {
  if (!existsSync(join(root, ".git"))) return
  const id = git(root, ["config", "--local", "--get", GIT_ID_KEYS.from])
  if (id && git(root, ["config", "--local", "--get", GIT_ID_KEYS.to]) === undefined) {
    step(run, `Copy git config ${GIT_ID_KEYS.from} to ${GIT_ID_KEYS.to} in ${root}`, () => {
      execFileSync("git", ["config", "--local", GIT_ID_KEYS.to, id], { cwd: root, windowsHide: true, stdio: "ignore" })
    })
  }
  const common = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  if (!common) return
  let worktrees: string[] = []
  try {
    worktrees = readdirSync(join(common, "worktrees"))
  } catch { /* none */ }
  for (const name of worktrees) {
    const dir = join(common, "worktrees", name)
    const legacy = join(dir, WORKTREE_CONFIGS.from)
    const current = join(dir, WORKTREE_CONFIGS.to)
    if (!existsSync(legacy) || existsSync(current)) continue
    const worktreeId = git(dir, ["config", "--file", legacy, "--get", GIT_ID_KEYS.from])
    if (!worktreeId) continue
    step(run, `Copy ${GIT_ID_KEYS.from} from ${legacy} to ${current}`, () => {
      execFileSync("git", ["config", "--file", current, GIT_ID_KEYS.to, worktreeId], { cwd: dir, windowsHide: true, stdio: "ignore" })
    })
  }
}

/** Rewrite every string in the registry that names a moved root (a project's icon, today). */
function migrateRegistry(run: Run, data: string, moved: RootPair[]): void {
  const path = join(data, "registry.json")
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return
  }
  let changed = 0
  const respell = (value: unknown): unknown => {
    if (typeof value === "string") {
      for (const { from, to } of moved) {
        if (value === from || value.startsWith(`${from}${sep}`)) {
          changed++
          return `${to}${value.slice(from.length)}`
        }
      }
      return value
    }
    if (Array.isArray(value)) return value.map(respell)
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, respell(inner)]))
    return value
  }
  const next = respell(JSON.parse(raw))
  if (!changed) return
  step(run, `Rewrite ${changed} ${changed === 1 ? "path" : "paths"} in ${path}`, () => {
    const temp = `${path}.${process.pid}.frizz-migration.tmp`
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: statSync(path).mode & 0o777 })
    renameSync(temp, path)
  })
}

/** The two schema renames the database still needs, in the unified file and any project file not yet imported. */
function migrateDatabases(run: Run, data: string): void {
  const files = [join(data, "ui.db")]
  try {
    for (const id of readdirSync(join(data, "projects"))) files.push(join(data, "projects", id, "ui.db"))
  } catch { /* no projects yet */ }
  for (const file of files) {
    if (!lstatOf(file)?.isFile()) continue
    let db: DatabaseSync
    try {
      db = new DatabaseSync(file, { readOnly: run.dryRun })
    } catch {
      continue
    }
    try {
      db.exec("PRAGMA busy_timeout = 10000")
      const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name))
      if (tables.has("session")) {
        const { n } = db.prepare(`SELECT count(*) AS n FROM session WHERE thread_name LIKE '${THREAD_NAME_PREFIXES.from}%'`).get() as { n: number }
        if (n) {
          step(run, `Rename ${n} thread ${n === 1 ? "name" : "names"} ${THREAD_NAME_PREFIXES.from}* to ${THREAD_NAME_PREFIXES.to}* in ${file}`, () => {
            db.exec(`UPDATE session SET thread_name = '${THREAD_NAME_PREFIXES.to}' || substr(thread_name, ${THREAD_NAME_PREFIXES.from.length + 1}) WHERE thread_name LIKE '${THREAD_NAME_PREFIXES.from}%'`)
          })
        }
      }
      if (tables.has("codex_app_server_session")) {
        const columns = (db.prepare("PRAGMA table_info(codex_app_server_session)").all() as { name: string }[]).map((row) => row.name)
        if (columns.includes(CODEX_SESSION_COLUMNS.from)) {
          step(run, `Rename column codex_app_server_session.${CODEX_SESSION_COLUMNS.from} to ${CODEX_SESSION_COLUMNS.to} in ${file}`, () => {
            db.exec(`ALTER TABLE codex_app_server_session RENAME COLUMN ${CODEX_SESSION_COLUMNS.from} TO ${CODEX_SESSION_COLUMNS.to}`)
          })
        }
      }
    } finally {
      db.close()
    }
  }
}

/**
 * Move this machine's Frizz install to the Ntwine names — or, with `dryRun`, say every step it would
 * take and change nothing. Idempotent: run again, it finds nothing left to move and returns `none`.
 */
export function migrateFrizzInstall(options: FrizzMigrationOptions = {}): FrizzMigrationResult {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const run: Run = {
    dryRun: options.dryRun === true,
    platform,
    stamp: (options.now?.() ?? new Date()).toISOString().replace(/[:.]/gu, "-"),
    steps: [],
    log: options.log ?? (() => {}),
  }
  const install = findInstall(env, platform, home)
  if (!install) return { status: "none", steps: [], moved: [] }
  const refused = options.boardsOnly ? undefined : refusal(install, env, platform, home)
  if (refused) return { status: "refused", reason: refused, steps: [], moved: [] }

  const moved: RootPair[] = []
  if (!options.boardsOnly) {
    for (const pair of install.pairs) {
      if (moveDirectory(run, pair.from, pair.to, "the Frizz root")) moved.push(pair)
    }
  }
  // Where each root is now — or, in a dry run or a deferred boot, still is.
  const unmoved = run.dryRun || options.boardsOnly === true
  const roots = (key: keyof NtwineRootDirs) => (unmoved && isRealDir(install.frizzRoots[key])) ? install.frizzRoots[key] : install.ntwineRoots[key]
  const data = roots("data")
  // After a full run, only a board that turned up since is left to find, and finding one is an lstat.
  // The rest (spawning git per project, opening the database) runs until a full run has finished.
  const finished = existsSync(join(data, DONE_MARKER))
  if (!options.boardsOnly && !finished) {
    moveDirectory(run, join(roots("state"), LEASES.from), join(roots("state"), LEASES.to), "the server lease")
    migrateRegistry(run, data, install.pairs.filter((pair) => unmoved ? isRealDir(pair.from) : isLink(pair.from)))
    migrateDatabases(run, data)
  }
  for (const root of boardHomes(data, home)) {
    if (migrateBoard(run, root) || !finished) migrateGitIds(run, root)
  }
  if (!unmoved && !finished) writeFileSync(join(data, DONE_MARKER), `${JSON.stringify({ at: new Date().toISOString() })}\n`)
  return {
    status: run.steps.length ? "migrated" : "none",
    steps: run.steps,
    moved: run.dryRun ? install.pairs.filter((pair) => isRealDir(pair.from)) : moved,
  }
}

/**
 * A process environment that still names a moved root: an env var holding an absolute path under it,
 * handed down by whatever started this process before the move. Each is respelled under the new root,
 * so this process and everything it starts agree with the paths it resolves itself.
 */
function respellEnvironment(env: NodeJS.ProcessEnv, install: Install): void {
  const moved = install.pairs.filter((pair) => isLink(pair.from))
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("NTWINE_") || !value) continue
    for (const { from, to } of moved) {
      if (value === from || value.startsWith(`${from}${sep}`)) {
        env[key] = `${to}${value.slice(from.length)}`
        break
      }
    }
  }
}

/** Was this process forked by a supervisor still running the code from before the rename? */
function forkedByPreRenameSupervisor(env: NodeJS.ProcessEnv): boolean {
  return PRE_RENAME_SUPERVISOR_ENV.some((key) => adoptedLegacyEnv.has(key)) || pinnedNtwineRoots(env) !== undefined
}

/**
 * The boot step every server and launcher entry runs first (frizz-migration-boot.ts). Migrates, or —
 * under a pre-rename supervisor — serves the Frizz roots unmoved and migrates only the boards. Exits the
 * process with the reason when the migration refuses.
 */
export function bootFrizzMigration(env: NodeJS.ProcessEnv = process.env): void {
  const say = (line: string) => console.error(`[ntwine] ${line}`)
  if (forkedByPreRenameSupervisor(env)) {
    const install = findInstall(env, process.platform, homedir())
    if (!install) return
    const pinned = pinnedNtwineRoots(env)
    if (!pinned && isRealDir(install.frizzRoots.data)) {
      pinNtwineRoots(install.frizzRoots, env)
      say(`Serving from ${install.frizzRoots.data} for now: Ntwine moves it to ${install.ntwineRoots.data} when \`nub run dev\` is restarted.`)
    }
    migrateFrizzInstall({ env, boardsOnly: true, log: say })
    return
  }
  const result = migrateFrizzInstall({ env, log: say })
  if (result.status === "refused") {
    say(result.reason!)
    process.exit(1)
  }
  const install = findInstall(env, process.platform, homedir())
  if (install) respellEnvironment(env, install)
}

/** `ntwine migrate-frizz [--dry-run]`: the same migration, run by hand, reporting each step. */
export function runMigrateFrizzCommand(args: string[]): number {
  const dryRun = args.includes("--dry-run")
  const unknown = args.filter((arg) => arg !== "--dry-run")
  if (unknown.length) {
    console.error(`usage: ntwine migrate-frizz [--dry-run]  (unexpected: ${unknown.join(" ")})`)
    return 2
  }
  const result = migrateFrizzInstall({ dryRun, log: (line) => console.log(`${dryRun ? "would: " : ""}${line}`) })
  if (result.status === "refused") {
    console.error(result.reason)
    return 1
  }
  if (result.status === "none") console.log("Nothing to migrate: no Frizz install is left on this machine.")
  return 0
}
