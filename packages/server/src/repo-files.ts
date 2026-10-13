import { execFileSync } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import path from "node:path"
import { liftRepoWorktree } from "./thread-cwd.ts"

// WHICH OF A THREAD'S WRITTEN FILES BELONG ON THE RAIL: the ones git would carry, and nothing else.
//
// The rail lists what a worker wrote (edited-files.ts). Restricting it to files git is not ignoring is
// the maintainer's product call (2026-09-04): "it's fine to only track changes that are tracked in git
// here". The rail becomes an account of work on the REPOSITORY, and a thread's scratch — `.ntwine/`
// notes, plans, research docs — drops out of it along with build output and `node_modules`.
//
// It is deliberately a FILTER and never a SOURCE. Attribution stays with the transcript, which is the
// only place a file can be tied to the session that wrote it: git records what changed and when, never
// WHICH session, and every attempt to infer it put other agents' work on the rail (measured over this
// machine's own history — a thread that wrote 10 files drew 282 from a commit-window sweep, and even
// commits within ±2min of that thread's own `git commit` calls were other agents' CI and wiki work).
// So git answers exactly one question here: is this path one the repository would carry?
//
// NOT-IGNORED, rather than IN-THE-INDEX. `git ls-files` would hide a file until someone ran `git add`,
// so a source file a worker had just created would be missing from the rail for the whole effort and
// appear only after the commit — the moment it is most worth seeing is the moment it would be absent.
// The test is therefore `git check-ignore`, which keeps new work visible and still drops everything
// ignored: build output, `node_modules`, and the thread scratch this rule is aimed at.
//
// ASKED OF THE CHECKOUT THE FILE IS IN. A worker that isolates itself works in a linked worktree, and a
// common place for one is `.ntwine/worktrees/<slug>` INSIDE the project — which the project's
// `.gitignore` ignores, as it ignores all of `.ntwine/`. Asked in the project root, `check-ignore` read
// every file of every worktree thread as ignored, so the rail of a thread that worked in one was empty
// (review-final #11, 2026-10-02: 22 of 144 sessions in a week ran in `.ntwine/worktrees`). The worktree is
// a checkout of the same repository with its own ignore rules applied from its own root, so each path is
// probed there: grouped by the worktree that holds it (thread-cwd.ts liftRepoWorktree — only a worktree
// of the PROJECT'S repository, so an unrelated clone a worker made in its scratch is still judged by the
// project, which ignores it), the project root for everything else inside the project. A sibling
// worktree OUTSIDE the project (`git worktree add ../repo-perf`) is the same repository too, so its files
// are judged by their own checkout rather than passed through.
//
// JUDGED WHERE THE FILE REALLY IS. Git refuses a path spelled through a symlinked directory (`fatal:
// pathspec … is beyond a symbolic link`, exit 128), and one such path fails the whole `--stdin` batch —
// so a single write to `.claude/skills/<name>/SKILL.md`, a link into `.agents/skills/`, switched the
// filter off for every row on that thread's rail (upstream 2ce68a03). Each path's DIRECTORY is resolved
// before it is grouped; the file's own name is kept, because a symlink that is itself the thing written
// is an entry git can judge. A link that leads out of every checkout is passed through.

// Enough for a whole effort's writes; a thread naming more than this is pathological and the tail is not
// worth a second git process.
const MAX_PROBE = 512
// The rail is recomputed on every transcript read, and reads are polled. One `check-ignore` is ~20-50ms,
// which is not free at poll rates, and a `.gitignore` changes far more slowly than a board polls.
const CACHE_TTL_MS = 15_000

type CacheEntry = { at: number; ignored: Set<string> }
const cache = new Map<string, CacheEntry>()

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 8 << 20,
  })
}

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

/** `p` through its nearest existing ancestor's real path — the spelling a lifted worktree root is in. */
function realSpelling(p: string): string {
  let at = p
  const rest: string[] = []
  while (!existsSync(at)) {
    const up = path.dirname(at)
    if (up === at) return p
    rest.unshift(path.basename(at))
    at = up
  }
  try {
    return path.join(realpathSync(at), ...rest)
  } catch {
    return p
  }
}

/**
 * The checkout git should be asked about `p` in, and `p` relative to it; undefined for a path no
 * checkout of this project holds (passed through).
 */
function checkoutOf(p: string, projectDir: string): { root: string; rel: string } | undefined {
  // The directory through every symlink, the file's own name kept (see JUDGED WHERE THE FILE REALLY IS).
  const real = path.join(realSpelling(path.dirname(p)), path.basename(p))
  const worktree = liftRepoWorktree(path.dirname(p), projectDir)
  if (worktree) {
    const rel = path.relative(worktree.dir, real)
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return { root: worktree.dir, rel }
  }
  const project = realSpelling(projectDir)
  if (inside(real, project)) return { root: projectDir, rel: path.relative(project, real) }
  return undefined
}

/**
 * The subset of `paths` the repository would carry — absolute paths in, absolute paths out.
 *
 * A path in no checkout of the project — outside it and in none of its repository's worktrees — is
 * passed through untouched: git has no opinion on another repository's file, and dropping it would
 * silently hide an edit the worker really made. A project that is not a git repository filters nothing,
 * for the same reason — there is no ignore list to consult, so every write is repo work by default
 * rather than invisible by default.
 */
export function repoCarriedFiles(projectDir: string, paths: readonly string[]): string[] {
  if (paths.length === 0) return []
  const groups = new Map<string, { abs: string; rel: string }[]>()
  for (const p of paths) {
    const checkout = checkoutOf(p, projectDir)
    if (!checkout) continue
    const group = groups.get(checkout.root)
    if (group) group.push({ abs: p, rel: checkout.rel })
    else groups.set(checkout.root, [{ abs: p, rel: checkout.rel }])
  }
  if (groups.size === 0) return [...paths]

  const dropped = new Set<string>()
  const now = Date.now()
  for (const [root, entries] of groups) {
    const probed = entries.slice(0, MAX_PROBE)
    const rels = probed.map((entry) => entry.rel)
    const key = `${root}\0${rels.join("\0")}`
    const hit = cache.get(key)
    let ignored: Set<string>
    if (hit && now - hit.at < CACHE_TTL_MS) {
      ignored = hit.ignored
    } else {
      ignored = probeIgnored(root, rels)
      cache.set(key, { at: now, ignored })
      // The key carries the whole path list, so a long-lived server would otherwise accumulate one entry
      // per distinct thread-and-write-set. Cheap bound: drop the oldest once it grows past a few boards.
      if (cache.size > 256) for (const k of [...cache.keys()].slice(0, 64)) cache.delete(k)
    }
    for (const entry of probed) if (ignored.has(entry.rel)) dropped.add(entry.abs)
  }
  return paths.filter((p) => !dropped.has(p))
}

/** `repoCarriedFiles` over the rail's own rows, preserving their order and their diffstats. */
export function repoCarriedEditedFiles<T extends { path: string }>(projectDir: string, files: readonly T[]): T[] {
  if (files.length === 0) return []
  const kept = new Set(repoCarriedFiles(projectDir, files.map((f) => f.path)))
  return files.filter((f) => kept.has(f.path))
}

/** The paths (relative to `root`, as given) that `root`'s checkout ignores. */
function probeIgnored(root: string, rels: readonly string[]): Set<string> {
  try {
    // `--is-inside-work-tree` is the cheap "is there an ignore list at all" probe; it throws for a
    // non-repository, which is the case that filters nothing.
    git(["rev-parse", "--is-inside-work-tree"], root)
  } catch {
    return new Set()
  }
  // `check-ignore -z --stdin` prints the paths it IS ignoring, NUL-separated, as they were given.
  // INDEX-AWARE, i.e. WITHOUT `--no-index`: a file force-added under an ignored directory (`git add -f
  // secret/kept.txt`) is one the repository genuinely carries, and the default mode says so while
  // `--no-index` calls it ignored and would drop it from the rail. Verified against `git ls-files` as
  // ground truth, 2026-09-04.
  try {
    const out = execFileSync("git", ["check-ignore", "-z", "--stdin"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      input: rels.join("\0"),
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 8 << 20,
    })
    return new Set(out.split("\0").filter(Boolean))
  } catch (error) {
    // Exit 1 means "nothing here is ignored" and arrives as a thrown error with an empty stdout — a
    // verdict, not a failure. Anything else (git missing, a broken repo) filters nothing.
    const status = (error as { status?: number }).status
    const stdout = (error as { stdout?: string }).stdout
    if (status === 1) return new Set((stdout ?? "").split("\0").filter(Boolean))
    return new Set()
  }
}
