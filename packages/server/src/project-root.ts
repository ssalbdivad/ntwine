import { createHash, randomUUID } from "node:crypto"
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, parse, resolve } from "node:path"
import { acquireNamedLaunchLockSync, readGitProjectId, validateProjectId } from "./project-identity.ts"

// WHAT A PROJECT IS, WITHOUT ASKING GIT.
//
// Ntwine used to define a project as a Git repository: the root came from `rev-parse --show-toplevel`
// and the id from `git config --local ntwine.id`. That made Git a hard requirement to LAUNCH, which
// contradicts the product's own position — Ntwine has no opinion about version control — and locked
// out anyone on jj (a non-colocated repo has no `.git` at all), hg, or nothing.
//
// So the id lives in the project instead, at `.ntwine/.id`, beside the scratchpads Ntwine already
// writes there. Two of the four properties `git config` was buying (project-identity.ts) come free
// that way: a directory that MOVES keeps its id because the id moved with it, and an alias resolves
// to the same id because it resolves to the same directory. The other two — atomic creation under a
// race, and sub-directory equivalence — are re-earned here, by the same named lock the Git path uses
// and by the walk-up below.
//
// THE ONE HAZARD, AND WHY IT IS NOT ONE. Unlike `git config --local`, a file in the working tree can
// be committed, and two clones of that repo on one machine would then share an id. `.ntwine/.gitignore`
// containing `*` removes that outright: the directory ignores ITSELF and everything under it, so
// `git add -A` cannot stage any of it (verified in a repo with no top-level .gitignore at all —
// `git status --porcelain` is empty and `check-ignore` reports the id and the .gitignore as ignored).
// Writing it is not an opinion about the user's version control, it is the ordinary convention for a
// tool's own scratch directory: `.venv/.gitignore` and `.swc/.gitignore` are exactly this file.

const NTWINE_DIR = ".ntwine"
const ID_FILE = ".id"
const SELF_IGNORE = ".gitignore"

/** Any of these makes a directory the project root. An Ntwine project wins over the VCS it sits in. */
const REPO_MARKERS = [".git", ".jj", ".hg", ".svn"]
const PROJECT_MARKERS = [
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "deno.json",
  "deno.jsonc",
  "composer.json",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "Makefile",
]

export function projectIdPath(root: string): string {
  return join(root, NTWINE_DIR, ID_FILE)
}

/** The id recorded in this exact directory, or undefined. A malformed file is refused, never guessed at. */
/**
 * The id in `.ntwine/.id`, and ONLY there.
 *
 * This is a FILE reader, not the answer to "what id does this project have" — use existingProjectId
 * for that. The distinction is not pedantic: a repository that predates the gitless change carries
 * its id in `git config ntwine.id` and has no file at all, so asking this one and treating `undefined`
 * as "no project" makes an established board look like a brand-new directory. That mistake shipped
 * three times in one change (registry backfill, launch intent, and the grid's add path) and made two
 * of the maintainer's four live projects invisible.
 */
export function readProjectIdFile(root: string): string | undefined {
  let raw: string
  try {
    raw = readFileSync(projectIdPath(root), "utf8")
  } catch {
    return undefined
  }
  try {
    return validateProjectId(raw.trim())
  } catch {
    throw new Error(`${projectIdPath(root)} is invalid; expected exactly one UUID`)
  }
}

/**
 * Record `id` for `root`, atomically, and make the directory ignore itself on the way.
 *
 * open(wx) → fsync → rename is the same shape project-launch.ts uses: a reader either sees the old
 * file or the complete new one, never a half-written id.
 */
export function writeProjectIdFile(root: string, id: string): string {
  const dir = join(root, NTWINE_DIR)
  mkdirSync(dir, { recursive: true })
  // Written before the id, so the id is never briefly visible to `git add -A`.
  const ignore = join(dir, SELF_IGNORE)
  if (!existsSync(ignore)) {
    try { writeFileSync(ignore, "*\n", { flag: "wx" }) } catch { /* raced; a `*` is a `*` */ }
  }

  const path = projectIdPath(root)
  const temp = join(dir, `.${ID_FILE}.${process.pid}.${randomUUID()}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(temp, "wx", 0o600)
    writeFileSync(fd, `${id}\n`, "utf8")
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, path)
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd) } catch {} }
    try { rmSync(temp, { force: true }) } catch {}
    throw error
  }
  return id
}

/** Keyed on the canonical root rather than a common git dir, which a plain directory does not have. */
export function projectRootLockName(root: string): string {
  return `identity-path-${createHash("sha256").update(root).digest("hex")}.lock`
}

/**
 * The project's durable id, minting one only if the project has never had it.
 *
 * `seed` is the id an existing store already committed to — today that is `git config ntwine.id`, so a
 * repository that predates this file ADOPTS its own id rather than being handed a new one and losing
 * its board. Nothing is ever removed from the old store: it stays readable, and stays the answer if
 * this file is deleted.
 *
 * The lock is what makes two `ntwine` processes starting at once commit exactly ONE id — the property
 * `git config`'s own lock used to provide, and the one a bare "write if missing" would lose.
 */
export function ensureProjectIdFile(root: string, home = homedir(), seed?: string): string {
  const existing = readProjectIdFile(root)
  if (existing) return existing
  const release = acquireNamedLaunchLockSync(home, projectRootLockName(root))
  try {
    const raced = readProjectIdFile(root)
    if (raced) return raced
    return writeProjectIdFile(root, seed ? validateProjectId(seed) : randomUUID())
  } finally {
    release()
  }
}

/**
 * Does this error mean "there is simply no Git worktree here", as opposed to "a real repository is
 * broken"?
 *
 * The distinction is the whole safety property. A malformed config or unsafe ownership means a
 * repository we could not READ, and inventing a fresh namespace for it would strand every thread on
 * its board — so those still fail closed. Not-a-repository, a bare repository, and `git` not being
 * installed at all genuinely mean there is nothing to read, and now fall through to marker walk-up.
 */
export function isNotAGitWorktree(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  if (code === "ENOENT" || code === "EACCES") return true // no `git` on this machine
  if (!error || typeof error !== "object" || !("stderr" in error)) return false
  const stderr = String((error as { stderr?: unknown }).stderr)
  return /not a git repository/iu.test(stderr) || /must be run in a work ?tree/iu.test(stderr)
}

function hasAny(dir: string, names: readonly string[]): boolean {
  return names.some((name) => existsSync(join(dir, name)))
}

/**
 * The project root for `cwd`, without running `git`.
 *
 * Walks UP, because sub-directory equivalence is the property a naive "just use cwd" loses and the
 * one users notice: `ntwine` in `~/proj` and in `~/proj/src` must open the same board, not two boards
 * with two thread histories and nothing explaining why.
 *
 * Stops at `$HOME` and never returns it. A stray `~/package.json` would otherwise make a user's whole
 * home directory one project, with agents dispatched at it.
 */
/**
 * THE HOME DIRECTORY IS NOT A PROJECT, and adopting it is not merely untidy.
 *
 * Ntwine's own global state lives in `~/.ntwine` — the registry, every project's state dir, the launch
 * locks. Making $HOME a project writes `~/.ntwine/.id` and `~/.ntwine/.gitignore` INTO that state
 * root, and from then on the walk-up below finds that `.ntwine/.id` from any unmarked directory under
 * $HOME, so every one of them resolves to the home "project". That happened (2026-08-06).
 *
 * discoverProjectRoot still ANSWERS with the directory it was given — "where would the root be" has
 * an answer even in $HOME. Refusing to adopt it is the caller's job, and this is the predicate.
 */
export function isHomeDirectory(dir: string, home = homedir()): boolean {
  // REALPATH BOTH SIDES. `resolve` alone compares the paths as written, and on macOS the launch
  // directory arrives already resolved (`/private/var/...`) while `homedir()` does not (`/var/...`),
  // so a symlinked home slips straight past the guard and gets adopted — which is the bug this
  // predicate exists to stop. A home that cannot be realpath'd falls back to the literal compare.
  const canonical = (value: string): string => {
    try {
      return realpathSync(resolve(value))
    } catch {
      return resolve(value)
    }
  }
  try {
    return canonical(dir) === canonical(home)
  } catch {
    return false
  }
}

/**
 * The id this directory ALREADY claims, from either store — or undefined if it claims none.
 *
 * Both stores count, and checking only the file is a bug that has now bitten twice. `.ntwine/.id` is
 * where an id lives once a current Ntwine has opened the project; `git config ntwine.id` is where it
 * lived before, and a repository that has not been reopened since the gitless change still carries
 * only that. On this machine boron and pullfrog/app were both in that state — established boards with
 * 15 and 85 threads — so a file-only check made them invisible to the registry backfill AND made the
 * launcher offer to "add" them as if they were new (2026-08-06).
 *
 * Pure: it never mints. resolveGitProjectIdentity would, which is exactly wrong for a question.
 */
export function existingProjectId(dir: string): string | undefined {
  const fromFile = readProjectIdFile(dir)
  if (fromFile) return fromFile
  try {
    return readGitProjectId(dir)
  } catch {
    return undefined // no git, or not a repository — the file was the only place it could have been
  }
}

/** Whether this directory has already been adopted, under either identity store. */
export function isExistingProjectRoot(dir: string): boolean {
  return existingProjectId(dir) !== undefined
}

/**
 * Whether this directory is a project in its own right — a VCS checkout, or a language manifest.
 *
 * The markers discoverProjectRoot walks UP for, asked about ONE directory. That is what separates the
 * two cases the launcher has to tell apart: `ntwine` in a repository is someone opening that
 * repository, and Ntwine adopts it on the spot; `ntwine` in `~/Downloads` is a command typed in the
 * wrong terminal, and gets offered rather than adopted. Never a substitute for isHomeDirectory —
 * $HOME frequently carries a marker and is still never a project.
 */
export function hasProjectMarker(dir: string): boolean {
  return hasAny(dir, REPO_MARKERS) || hasAny(dir, PROJECT_MARKERS)
}

export function discoverProjectRoot(cwd = process.cwd(), home = homedir()): string {
  let dir: string
  try {
    dir = resolve(cwd)
  } catch {
    return resolve(cwd)
  }
  const stop = resolve(home)
  const filesystemRoot = parse(dir).root

  for (let at = dir; ; at = dirname(at)) {
    // Never climb INTO or past the home directory. Note this does not stop `dir` itself from BEING
    // $HOME — the loop simply breaks and the launch directory is returned unchanged. Whether that is
    // adoptable is isHomeDirectory's question, asked by the launcher, not answered here.
    if (at === stop || at === filesystemRoot) break
    // An existing Ntwine project wins over the VCS or manifest it happens to sit in.
    if (existsSync(projectIdPath(at))) return at
    if (hasAny(at, REPO_MARKERS)) return at
    if (hasAny(at, PROJECT_MARKERS)) return at
    if (dirname(at) === at) break
  }
  return dir
}

/**
 * The root an EXPLICIT choice adopts — the native picker and the grid's typed path, never a cwd.
 *
 * The walk-up above exists so a folder inside a checkout resolves to the checkout instead of
 * fragmenting it, and that reasoning is about directories that are projects IN THEIR OWN RIGHT — a
 * VCS root, a manifest root. An ancestor whose only claim is `.ntwine/.id` — an adopted plain
 * directory, e.g. ~/Documents opened as a project once — is no checkout, and letting it capture a
 * pick turned "add ~/Documents/projects/kirby", a brand-new empty folder, into "reopen documents":
 * the picker navigated to another project's board, and no flow could create the new project at all
 * (2026-09-02). Someone who has pointed at a folder means THAT folder.
 *
 * A launch cwd still resolves through discoverProjectRoot unchanged — sub-directory equivalence for
 * adopted plain directories is deliberate there, where the directory is incidental to the command.
 */
export function chosenProjectRoot(chosen: string, home = homedir()): string {
  const dir = resolve(chosen)
  const discovered = discoverProjectRoot(dir, home)
  return discovered === dir || hasProjectMarker(discovered) ? discovered : dir
}
