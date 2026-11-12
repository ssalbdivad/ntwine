// A THREAD'S UNCOMMITTED WORK, carried between two clones of one repository (plans/thread-handoff.md § 3).
//
// Pure git plumbing: every input is an absolute path or plain data, nothing here reads ntwine's own state,
// so the whole module runs against real temp repositories in its tests.
//
//   origin:       locateThreadCheckout → snapshotWip → writeWipBundle  … the move …  revertMovedPaths
//   destination:  restoreWip
//
// The snapshot is a commit W whose parent is the checkout's HEAD (H) and whose tree is H's plus the WIP
// paths' working-tree state. It is built through a private index seeded from H, so neither the checkout,
// its index nor HEAD moves while other agents keep working in it. W travels as a git bundle; the
// destination keeps it at refs/ntwine/moved/<slug> and applies the H → W diff as uncommitted changes,
// after checking every precondition first, so a refused import writes no file.
import { execFileSync } from "node:child_process"
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readlinkSync, readSync, realpathSync, rmdirSync, rmSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseWorktreeList } from "./worktree-sweep.ts"

export const WIP_EXPORT_REF = "refs/ntwine/wip-export"

/** Where a moved thread's snapshot W is kept, on both machines. */
export const movedRef = (slug: string): string => `refs/ntwine/moved/${slug}`

export interface WipSnapshot {
  /** H: the checkout's HEAD when the snapshot was taken. */
  head: string
  /** The checked-out branch's short name; null when HEAD is detached. */
  branch: string | null
  /** W: H plus the WIP paths' working-tree state, as a commit whose parent is H. Equals H when nothing moves. */
  wip: string
  /** Repo-relative ('/'-separated) paths that differ between H and W, sorted. */
  paths: string[]
  /** Main checkout only: uncommitted paths this thread did not edit, which stay where they are. Sorted. */
  leftBehind: string[]
}

export type CheckoutLocation = { kind: "main" | "worktree"; rel: string; root: string } | { refused: string }

export type RestoreResult = { ok: true; root: string; created: boolean; fastForwarded: boolean } | { refused: string }

// ── LOCATING THE THREAD'S CHECKOUT ───────────────────────────────────────────────────────────────────────

/** The checkout a thread works in, from its newest working folder. A folder that is gone, or is not in a
 *  checkout of this repository at all, reads as the main checkout: the thread's work is not anywhere we can
 *  see, and the main checkout is where its edited paths would be. */
export function locateThreadCheckout(cwd: string, mainCheckout: string): CheckoutLocation {
  const main = canonical(mainCheckout)
  const asMain = { kind: "main" as const, rel: ".", root: mainCheckout }
  if (!existsSync(cwd)) return asMain
  let top: string
  let common: string
  try {
    top = canonical(git(cwd, ["rev-parse", "--show-toplevel"]).trim())
    common = canonical(git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim())
  } catch {
    return asMain
  }
  if (common !== canonical(git(mainCheckout, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim())) return asMain
  if (top === main) return asMain
  const rel = path.relative(main, top).split(path.sep).join("/")
  if (/^\.ntwine\/worktrees\/[^/]+$/.test(rel)) return { kind: "worktree", rel, root: top }
  return {
    refused: `This thread works in ${top}, a checkout outside the project's .ntwine/worktrees, so its uncommitted work cannot move`,
  }
}

/** The checkout a thread's work is in, and the files it edited that are uncommitted in ANOTHER of the
 *  project's checkouts (paths relative to the main checkout), which stay behind.
 *
 *  Its newest `cwd` decides when that is a linked worktree. Otherwise its newest edit inside the project
 *  does (`editedPaths`, absolute, oldest first, as `editedFilesOf` orders them): a worker often runs
 *  `git worktree add` and then writes by absolute path without ever `cd`-ing in, so its cwd stays at the
 *  root while all its work is in the worktree — what the real-worker e2e did on its first run (2026-11-12),
 *  where reading the cwd alone would have moved nothing. Else the main checkout. */
export function threadCheckout(opts: { cwd: string; mainCheckout: string; editedPaths: readonly string[] }): { location: CheckoutLocation; elsewhere: string[] } {
  const main = canonical(opts.mainCheckout)
  const checkoutOf = (file: string): { rel: string; inCheckout: string } | undefined => {
    const rel = path.relative(main, canonicalFile(file)).split(path.sep).join("/")
    if (!rel || rel.startsWith("../") || rel === ".." || path.isAbsolute(rel)) return undefined
    const worktree = /^(\.ntwine\/worktrees\/[^/]+)\/(.+)$/.exec(rel)
    if (worktree) return { rel: worktree[1]!, inCheckout: worktree[2]! }
    return rel.startsWith(".ntwine/") ? undefined : { rel: ".", inCheckout: rel }
  }
  let location = locateThreadCheckout(opts.cwd, opts.mainCheckout)
  if (!("refused" in location) && location.kind === "main") {
    for (let i = opts.editedPaths.length - 1; i >= 0; i--) {
      const hit = checkoutOf(opts.editedPaths[i]!)
      if (!hit) continue
      if (hit.rel !== ".") {
        const root = path.join(main, hit.rel)
        const found = existsSync(root) ? locateThreadCheckout(root, opts.mainCheckout) : undefined
        if (found && !("refused" in found) && found.kind === "worktree") location = found
      }
      break
    }
  }
  if ("refused" in location) return { location, elsewhere: [] }
  // The thread's own edits in the checkouts it is NOT moving from, that are still uncommitted there.
  const byCheckout = new Map<string, Set<string>>()
  for (const file of opts.editedPaths) {
    const hit = checkoutOf(file)
    if (!hit || hit.rel === location.rel) continue
    byCheckout.set(hit.rel, (byCheckout.get(hit.rel) ?? new Set()).add(hit.inCheckout))
  }
  const elsewhere: string[] = []
  for (const [rel, files] of byCheckout) {
    const root = path.join(main, rel)
    if (!existsSync(root)) continue
    let dirty: string[]
    try {
      dirty = dirtyPaths(root)
    } catch {
      continue
    }
    for (const p of dirty) if (files.has(p)) elsewhere.push(rel === "." ? p : `${rel}/${p}`)
  }
  return { location, elsewhere: elsewhere.sort() }
}

// ── THE SNAPSHOT ─────────────────────────────────────────────────────────────────────────────────────────

/** Snapshot a checkout's work in progress as a commit W on top of HEAD, without touching the checkout, its
 *  index or HEAD. In a worktree every uncommitted path moves; in the main checkout, which other agents
 *  share, only the ones in `editedPaths` (absolute) do and the rest are listed in `leftBehind`.
 *  Throws on a repository with no commits: there is no H to build on, and the caller refuses the move. */
export function snapshotWip(opts: { root: string; kind: "main" | "worktree"; editedPaths?: readonly string[]; message: string }): WipSnapshot {
  const { root } = opts
  let head: string
  try {
    head = git(root, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]).trim()
  } catch {
    throw new Error(`${root} has no commits yet, so its uncommitted work cannot move`)
  }
  const branch = currentBranch(root)
  const dirty = dirtyPaths(root)

  let candidates: string[]
  let leftBehind: string[] = []
  if (opts.kind === "worktree") candidates = dirty
  else {
    const realRoot = canonical(root)
    const edited = new Set<string>()
    for (const file of opts.editedPaths ?? []) {
      const rel = path.relative(realRoot, canonicalFile(file))
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue
      edited.add(rel.split(path.sep).join("/"))
    }
    candidates = dirty.filter((p) => edited.has(p))
    leftBehind = dirty.filter((p) => !edited.has(p))
  }

  let wip = head
  let paths: string[] = []
  if (candidates.length) {
    const scratch = mkdtempSync(path.join(tmpdir(), "ntwine-wip-"))
    try {
      const env = { GIT_INDEX_FILE: path.join(scratch, "index") }
      // Seed from H FIRST. A private index that starts empty would record every file not named below as
      // deleted in W — the trap AGENTS.local.md describes, which has cost this repo real recoveries.
      git(root, ["read-tree", head], { env })
      // A path neither on disk nor in H (staged as new, then deleted) has nothing to stage, and `git add`
      // would fail the whole pathspec on it.
      const inHead = new Set(git(root, ["ls-files", "-z"], { env }).split("\0"))
      const stageable = candidates.filter((p) => inHead.has(p) || lexists(path.join(root, p)))
      if (stageable.length) {
        // `-A` stages deletions too. Through a file, so thousands of paths cannot overflow argv.
        git(root, ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], { env, input: stageable.join("\0") })
      }
      const tree = git(root, ["write-tree"], { env }).trim()
      if (tree !== git(root, ["rev-parse", `${head}^{tree}`]).trim()) {
        // The identity is always ntwine's: the snapshot is ntwine's commit, not the human's, and a machine
        // with no user.name configured must not fail here.
        wip = git(root, ["commit-tree", tree, "-p", head, "-F", "-"], { env: NTWINE_IDENTITY, input: opts.message }).trim()
        paths = changedPaths(root, head, wip)
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }
  return { head, branch, wip, paths, leftBehind: leftBehind.sort() }
}

// ── THE BUNDLE ───────────────────────────────────────────────────────────────────────────────────────────

/** Write W, under WIP_EXPORT_REF, to a bundle at `file`, excluding what the origin's remote-tracking refs
 *  already hold. Returns the commits the bundle needs the destination to have already. */
export function writeWipBundle(opts: { root: string; wip: string; file: string }): { prerequisites: string[] } {
  const { root, wip, file } = opts
  git(root, ["update-ref", WIP_EXPORT_REF, wip])
  try {
    let exclusions: string[]
    if (git(root, ["for-each-ref", "--count=1", "--contains", wip, "refs/remotes"]).trim()) {
      // W is already on a remote (nothing to move, and its branch is pushed). `--not --remotes` would leave
      // an empty bundle, which git refuses to write, so carry W alone; its parents become prerequisites,
      // which the destination gets by fetching its own remote.
      const parents = git(root, ["rev-list", "--parents", "-n", "1", wip]).trim().split(" ").slice(1)
      exclusions = parents.length ? ["--not", ...parents] : []
    } else exclusions = ["--not", "--remotes"]
    git(root, ["bundle", "create", "-q", file, WIP_EXPORT_REF, ...exclusions])
  } finally {
    git(root, ["update-ref", "-d", WIP_EXPORT_REF])
  }
  return { prerequisites: bundlePrerequisites(file) }
}

/** The prerequisite commits a bundle names in its header (`-<sha> <subject>` lines). */
export function bundlePrerequisites(file: string): string[] {
  const fd = openSync(file, "r")
  try {
    const chunk = Buffer.alloc(64 * 1024)
    let header = ""
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null)
      if (!read) break
      header += chunk.subarray(0, read).toString("latin1")
      if (header.includes("\n\n")) break
    }
    const end = header.indexOf("\n\n")
    return (end < 0 ? header : header.slice(0, end))
      .split("\n")
      .filter((line) => line.startsWith("-"))
      .map((line) => line.slice(1).split(" ")[0]!)
  } finally {
    closeSync(fd)
  }
}

// ── THE DESTINATION ──────────────────────────────────────────────────────────────────────────────────────

/** Bring a moved thread's work into this clone. Every check runs before anything is written to a checkout:
 *  a refusal leaves every checkout, index, branch and HEAD as it was. Two things may already have happened
 *  by then, both deliberately: a `git fetch` of this clone's remotes when the bundle needs commits it lacks
 *  (refreshing remote-tracking refs, as a pull would), and W landing at refs/ntwine/moved/<slug>, since its
 *  objects are what the checks read. That private ref is kept on a refusal: it is harmless, and a retry
 *  overwrites it. Applying twice is a no-op the second time: a path already holding W's content is skipped. */
export function restoreWip(opts: {
  mainCheckout: string
  rel: string
  branch: string | null
  head: string
  wip: string
  paths: readonly string[]
  bundleFile: string
  slug: string
  fetchRemote?: boolean
}): RestoreResult {
  const { mainCheckout, rel, branch, head, wip, bundleFile, slug } = opts
  const main = canonical(mainCheckout)
  // Everything below came from another machine. A worktree name of plain characters only: a `\` would be a
  // separator on Windows and walk out of the project.
  if (rel !== "." && !WORKTREE_REL.test(rel)) return { refused: `${rel} is not a folder a thread can move into` }
  if (!/^[0-9a-f]{40,64}$/.test(head) || !/^[0-9a-f]{40,64}$/.test(wip)) return { refused: "The moved work does not name its commits" }
  if (branch !== null) {
    try {
      if (branch.startsWith("-")) throw new Error()
      git(main, ["check-ref-format", "--branch", branch])
    } catch {
      return { refused: `${branch} is not a branch name` }
    }
  }
  // ntwine's own folder never moves as work: a path there (a symlinked `.ntwine/threads`, say) would steer
  // where this import writes the thread's notes.
  const reserved = opts.paths.filter((p) => p === ".ntwine" || p.startsWith(".ntwine/"))
  if (reserved.length) return { refused: `The moved work writes inside ntwine's own folder: ${nameList(reserved)}` }
  const ref = movedRef(slug)
  try {
    git(main, ["check-ref-format", ref])
  } catch {
    return { refused: `${slug} cannot name a git ref` }
  }

  // The bundle, and the commits it builds on.
  let missing = bundlePrerequisites(bundleFile).filter((sha) => !hasCommit(main, sha))
  if (missing.length && opts.fetchRemote !== false) {
    for (const remote of git(main, ["remote"]).split("\n").filter(Boolean)) {
      try {
        git(main, ["fetch", "--quiet", remote])
      } catch {
        // An unreachable remote is one source fewer; whether the commits arrived is checked below.
      }
    }
    missing = missing.filter((sha) => !hasCommit(main, sha))
  }
  if (missing.length) return { refused: "This clone is missing commits the thread's branch builds on; pull it and retry" }
  try {
    git(main, ["bundle", "verify", "-q", bundleFile])
    git(main, ["fetch", "--quiet", "--no-write-fetch-head", bundleFile, `+${WIP_EXPORT_REF}:${ref}`])
  } catch (error) {
    return { refused: `The moved work could not be read: ${errorText(error)}` }
  }

  // W is what the origin said it is.
  const fetched = git(main, ["rev-parse", ref]).trim()
  const parent = git(main, ["rev-list", "--parents", "-n", "1", fetched]).trim().split(" ").slice(1)
  if (fetched !== wip || (wip !== head && (parent.length !== 1 || parent[0] !== head))) {
    return { refused: "The moved work does not match its snapshot" }
  }
  const paths = changedPaths(main, head, wip)
  if (paths.join("\0") !== [...opts.paths].sort().join("\0")) return { refused: "The moved work does not match its snapshot" }
  // A symlink in the moved work could point anywhere on this machine, and a submodule entry names another
  // repository; neither is uncommitted work worth that. The thread commits them, or leaves them behind.
  const linked = specialEntries(main, wip, paths)
  if (linked.length) return { refused: `The moved work adds a symlink or submodule, which cannot move: ${nameList(linked)}` }

  const root = rel === "." ? main : path.join(main, ...rel.split("/"))
  const worktrees = parseWorktreeList(git(main, ["worktree", "list", "--porcelain"]))
  let prune = false

  if (!existsSync(root)) {
    // A worktree to create, on the thread's branch at H.
    const registered = worktrees.find((w) => canonical(w.path) === root)
    if (registered && !registered.prunable) return { refused: `${rel} is registered as a worktree but its folder is gone; run git worktree prune and retry` }
    if (registered) prune = true
    // The folder it goes in must be a real one all the way down: a symlinked `.ntwine/worktrees` would
    // put the checkout, and the moved work, wherever it points.
    const linkedDir = symlinkedComponent(main, rel)
    if (linkedDir) return { refused: `${linkedDir} is a symlink, so the thread's checkout cannot be created there` }
    let add: string[]
    if (branch === null) add = ["--detach", root, head]
    else if (!hasRef(main, `refs/heads/${branch}`)) add = ["-b", branch, root, head]
    else {
      // An existing branch is used only where it already is: an import never moves a branch, since the one
      // named could be any branch of this clone's (a release branch, say).
      const holder = worktrees.find((w) => w.branch === `refs/heads/${branch}`)
      if (holder && !holder.prunable) return { refused: `The branch ${branch} is checked out in ${holder.path}; switch that checkout off it and retry` }
      if (holder) prune = true
      if (git(main, ["rev-parse", `refs/heads/${branch}`]).trim() !== head) {
        return { refused: `This clone already has a branch ${branch} at another commit; delete or rename it and retry` }
      }
      add = [root, branch]
    }
    // APPLY: nothing above wrote to a checkout.
    if (prune) git(main, ["worktree", "prune"])
    mkdirSync(path.dirname(root), { recursive: true })
    git(main, ["worktree", "add", "--quiet", ...add])
    applyDiff(root, head, wip, paths)
    return { ok: true, root, created: true, fastForwarded: false }
  }

  // An existing checkout: it must be this repository's, on the thread's branch, and able to take W.
  try {
    const top = canonical(git(root, ["rev-parse", "--show-toplevel"]).trim())
    const common = canonical(git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim())
    if (top !== root || common !== canonical(git(main, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim())) throw new Error()
  } catch {
    return { refused: `${root} exists but is not a checkout of this project` }
  }
  const current = currentBranch(root)
  if (current !== branch) {
    return { refused: `The checkout at ${root} is on ${current ?? "a detached HEAD"}, not the thread's ${branch ?? "detached HEAD"}; switch it and retry` }
  }
  const tip = git(root, ["rev-parse", "HEAD"]).trim()
  const dirty = dirtyPaths(root)
  let fastForward = false
  if (tip !== head) {
    if (isAncestor(root, tip, head)) {
      // The main checkout is the one every agent here commits on and autosync pushes from, so it only moves
      // forward to commits this clone's own remotes already hold, never to ones only the other machine has.
      // A thread's worktree branch is its own, and takes the other machine's commits.
      if (rel === "." && !onARemote(main, head, opts.fetchRemote !== false)) {
        return { refused: `The other machine's ${branch ?? "HEAD"} has commits this clone's remotes don't; push them from there and retry` }
      }
      fastForward = true
      // git would refuse the fast-forward over these anyway; asking first keeps the refusal ahead of every write.
      const moving = new Set(changedPaths(root, tip, head))
      const blocking = dirty.filter((p) => moving.has(p))
      if (blocking.length) return { refused: `Uncommitted changes in this checkout would be overwritten by moving it forward: ${nameList(blocking)}` }
    } else if (!isAncestor(root, head, tip) || (paths.length && !diffQuiet(root, head, tip, paths))) {
      return { refused: `This checkout's ${branch ?? "HEAD"} has diverged from the thread's; sync it first` }
    }
  }
  // Every WIP path must be clean here, unless it already holds exactly what W carries (a retry).
  const dirtySet = new Set(dirty)
  const wipBlobs = treeBlobs(root, wip, paths)
  const onDisk = worktreeBlobs(root, paths.filter((p) => dirtySet.has(p)))
  const applied = new Set<string>()
  const conflicts: string[] = []
  for (const p of paths) {
    if (!dirtySet.has(p)) continue
    if (onDisk.get(p) === (wipBlobs.get(p) ?? null)) applied.add(p)
    else conflicts.push(p)
  }
  if (conflicts.length) return { refused: `This checkout has its own uncommitted changes to ${nameList(conflicts)}` }

  // APPLY.
  if (fastForward) {
    try {
      git(root, ["merge", "--ff-only", "--quiet", head])
    } catch (error) {
      return { refused: errorText(error) }
    }
  }
  applyDiff(
    root,
    head,
    wip,
    paths.filter((p) => !applied.has(p)),
  )
  return { ok: true, root, created: false, fastForwarded: fastForward }
}

/** Write the H → W changes at `paths` into the working tree as uncommitted changes (index untouched). */
function applyDiff(root: string, head: string, wip: string, paths: readonly string[]): void {
  if (!paths.length) return
  const patch = gitBuffer(root, ["diff", "--binary", "--no-renames", "--no-color", "--no-ext-diff", head, wip, "--", ...paths])
  if (patch.length) git(root, ["apply", "--binary", "--whitespace=nowarn", "-"], { input: patch })
}

// ── THE ORIGIN, AFTER THE MOVE ───────────────────────────────────────────────────────────────────────────

/** Put the moved paths back to H on the origin, so the same work cannot be committed on both machines.
 *  Only a path that still holds exactly what W captured goes back; one changed since the snapshot is kept,
 *  and so is one whose index holds anything but H's or W's version of it. A path whose W version was also
 *  staged has its index entry reset with it, or a later bare `git commit` would land the moved work here
 *  anyway. No other path is touched. */
export function revertMovedPaths(opts: { root: string; head: string; wip: string; paths: readonly string[] }): { reverted: string[]; kept: string[] } {
  const { root, head, wip } = opts
  const paths = [...opts.paths].sort()
  const wipBlobs = treeBlobs(root, wip, paths)
  const headBlobs = treeBlobs(root, head, paths)
  const indexBlobs = indexBlobsOf(root, paths)
  const onDisk = worktreeBlobs(root, paths)
  const reverted: string[] = []
  const kept: string[] = []
  const restoreWorktree: string[] = []
  const restoreBoth: string[] = []
  const unstage: string[] = []
  const remove: string[] = []
  for (const p of paths) {
    const w = wipBlobs.get(p) ?? null
    const h = headBlobs.get(p) ?? null
    const idx = indexBlobs.get(p) ?? null
    if (onDisk.get(p) !== w || (idx !== h && idx !== w)) {
      kept.push(p)
      continue
    }
    reverted.push(p)
    if (h !== null) (idx === h ? restoreWorktree : restoreBoth).push(p)
    else {
      remove.push(p)
      if (idx !== null) unstage.push(p)
    }
  }
  if (restoreWorktree.length) git(root, ["restore", `--source=${head}`, "--worktree", "--", ...restoreWorktree])
  if (restoreBoth.length) git(root, ["restore", `--source=${head}`, "--staged", "--worktree", "--", ...restoreBoth])
  if (unstage.length) git(root, ["rm", "--cached", "-q", "--", ...unstage])
  for (const p of remove) {
    const file = path.join(root, p)
    if (lexists(file)) unlinkSync(file)
    removeEmptyParents(root, path.dirname(file))
  }
  return { reverted, kept }
}

/** `.ntwine/worktrees/<name>`, the name plain characters. */
const WORKTREE_REL = /^\.ntwine\/worktrees\/[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/

/** The paths at which `rev` holds a symlink (mode 120000) or a submodule (160000). */
function specialEntries(cwd: string, rev: string, paths: readonly string[]): string[] {
  if (!paths.length) return []
  const out: string[] = []
  for (const entry of git(cwd, ["ls-tree", "-z", "--full-tree", rev, "--", ...paths]).split("\0")) {
    const tab = entry.indexOf("\t")
    if (tab < 0) continue
    const mode = entry.slice(0, entry.indexOf(" "))
    if (mode === "120000" || mode === "160000") out.push(entry.slice(tab + 1))
  }
  return out
}

/** The first existing component of `rel` under `root` that is a symlink, as `root`-relative text. */
export function symlinkedComponent(root: string, rel: string): string | undefined {
  let at = root
  for (const part of rel.split("/").filter((p) => p && p !== ".")) {
    at = path.join(at, part)
    let stat
    try {
      stat = lstatSync(at)
    } catch {
      return undefined
    }
    if (stat.isSymbolicLink()) return path.relative(root, at).split(path.sep).join("/")
  }
  return undefined
}

/** Whether any remote-tracking ref of this clone contains `sha`, fetching the remotes once if none does. */
function onARemote(cwd: string, sha: string, fetch: boolean): boolean {
  const held = () => git(cwd, ["for-each-ref", "--count=1", "--contains", sha, "--format=%(refname)", "refs/remotes"]).trim() !== ""
  if (held()) return true
  if (!fetch) return false
  for (const remote of git(cwd, ["remote"]).split("\n").filter(Boolean)) {
    try {
      git(cwd, ["fetch", "--quiet", remote])
    } catch {
      // Unreachable: one source fewer.
    }
  }
  return held()
}

// ── GIT ──────────────────────────────────────────────────────────────────────────────────────────────────

const NTWINE_IDENTITY = {
  GIT_AUTHOR_NAME: "ntwine",
  GIT_AUTHOR_EMAIL: "ntwine@localhost",
  GIT_COMMITTER_NAME: "ntwine",
  GIT_COMMITTER_EMAIL: "ntwine@localhost",
}

type GitOptions = { env?: Record<string, string>; input?: string | Buffer }

function gitEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // A path is a path: `*.ts` in a filename must not glob over other files.
    GIT_LITERAL_PATHSPECS: "1",
    // `git status` would otherwise refresh the index under a lock, colliding with an agent committing.
    GIT_OPTIONAL_LOCKS: "0",
    // NO HOOKS, ever. The destination runs these commands over commits a paired machine sent, and a repo
    // whose `core.hooksPath` is a tracked folder (this one's is `scripts/githooks`) would run the sender's
    // own post-merge after a fast-forward — the security review reproduced exactly that, and the stock
    // hook here pushes `main` to origin. Nothing in this module needs a hook on either machine.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: process.platform === "win32" ? "NUL" : "/dev/null",
    ...extra,
  }
  // Inherited from a hook or a wrapper, these would point every command at some other repository.
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", ...(extra?.GIT_INDEX_FILE ? [] : ["GIT_INDEX_FILE"])]) delete env[key]
  return env
}

function git(cwd: string, args: readonly string[], opts: GitOptions = {}): string {
  return execFileSync("git", args, {
    cwd,
    windowsHide: true,
    encoding: "utf8",
    env: gitEnv(opts.env),
    input: opts.input,
    stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    maxBuffer: 512 * 1024 * 1024,
  })
}

function gitBuffer(cwd: string, args: readonly string[]): Buffer {
  return execFileSync("git", args, {
    cwd,
    windowsHide: true,
    env: gitEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 512 * 1024 * 1024,
  })
}

const errorText = (error: unknown): string => {
  const stderr = (error as { stderr?: string | Buffer }).stderr
  return stderr?.toString().trim() || (error instanceof Error ? error.message : String(error))
}

function currentBranch(root: string): string | null {
  try {
    return git(root, ["symbolic-ref", "--short", "-q", "HEAD"]).trim() || null
  } catch {
    return null
  }
}

function hasCommit(cwd: string, sha: string): boolean {
  try {
    git(cwd, ["cat-file", "-e", `${sha}^{commit}`])
    return true
  } catch {
    return false
  }
}

function hasRef(cwd: string, ref: string): boolean {
  try {
    git(cwd, ["rev-parse", "--verify", "-q", ref])
    return true
  } catch {
    return false
  }
}

function isAncestor(cwd: string, ancestor: string, of: string): boolean {
  try {
    git(cwd, ["merge-base", "--is-ancestor", ancestor, of])
    return true
  } catch {
    return false
  }
}

function diffQuiet(cwd: string, a: string, b: string, paths: readonly string[]): boolean {
  try {
    git(cwd, ["diff", "--quiet", "--no-ext-diff", a, b, "--", ...paths])
    return true
  } catch {
    return false
  }
}

function changedPaths(cwd: string, a: string, b: string): string[] {
  return git(cwd, ["diff", "--name-only", "-z", "--no-renames", a, b])
    .split("\0")
    .filter(Boolean)
    .sort()
}

/** Uncommitted paths: staged, unstaged and untracked (each untracked file on its own), never ignored, and
 *  never ntwine's own `.ntwine/` folder. A rename's source counts as well as its destination. */
function dirtyPaths(root: string): string[] {
  const fields = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-ahead-behind"]).split("\0")
  const out = new Set<string>()
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!
    if (field.length < 4) continue
    const xy = field.slice(0, 2)
    const paths = [field.slice(3)]
    // In -z mode a rename or copy carries its source as the NEXT field. A copy's source is unchanged.
    if (xy.includes("R") || xy.includes("C")) {
      const source = fields[++i]
      if (source && xy.includes("R")) paths.push(source)
    }
    // A trailing '/' is a nested repository git will not descend into; nothing in it can be staged.
    for (const p of paths) if (!p.endsWith("/") && !p.startsWith(".ntwine/")) out.add(p)
  }
  return [...out].sort()
}

/** `<rev>:<path>` blob ids for the paths present in `rev`. */
function treeBlobs(root: string, rev: string, paths: readonly string[]): Map<string, string> {
  const out = new Map<string, string>()
  if (!paths.length) return out
  for (const entry of git(root, ["ls-tree", "-r", "-z", "--full-tree", rev, "--", ...paths]).split("\0")) {
    const tab = entry.indexOf("\t")
    if (tab > 0) out.set(entry.slice(tab + 1), entry.slice(0, tab).split(" ")[2]!)
  }
  return out
}

/** Stage-0 index blob ids for the paths the index holds. */
function indexBlobsOf(root: string, paths: readonly string[]): Map<string, string> {
  const out = new Map<string, string>()
  if (!paths.length) return out
  for (const entry of git(root, ["ls-files", "-s", "-z", "--", ...paths]).split("\0")) {
    const tab = entry.indexOf("\t")
    if (tab < 0) continue
    const [, sha, stage] = entry.slice(0, tab).split(" ")
    if (stage === "0") out.set(entry.slice(tab + 1), sha!)
  }
  return out
}

/** What each path holds on disk, as the blob id git would store for it (clean filters applied); null when
 *  absent. A directory standing where a file was gets a value no blob id can equal. */
function worktreeBlobs(root: string, paths: readonly string[]): Map<string, string | null> {
  const out = new Map<string, string | null>()
  const files: string[] = []
  for (const p of paths) {
    let stat
    try {
      stat = lstatSync(path.join(root, p))
    } catch {
      out.set(p, null)
      continue
    }
    if (stat.isSymbolicLink()) out.set(p, git(root, ["hash-object", "--stdin"], { input: readlinkSync(path.join(root, p)) }).trim())
    else if (!stat.isFile()) out.set(p, "<not a file>")
    else if (p.includes("\n")) out.set(p, git(root, ["hash-object", "--", p]).trim())
    else files.push(p)
  }
  if (files.length) {
    const ids = git(root, ["hash-object", "--stdin-paths"], { input: files.join("\n") + "\n" }).trim().split("\n")
    files.forEach((p, i) => out.set(p, ids[i]!))
  }
  return out
}

function canonical(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return path.resolve(dir)
  }
}

/** A file's canonical path even when it no longer exists: its nearest existing ancestor, resolved. */
function canonicalFile(file: string): string {
  let dir = path.resolve(file)
  const rest: string[] = []
  for (;;) {
    try {
      return path.join(realpathSync(dir), ...rest.reverse())
    } catch {
      const parent = path.dirname(dir)
      if (parent === dir) return path.resolve(file)
      rest.push(path.basename(dir))
      dir = parent
    }
  }
}

function lexists(file: string): boolean {
  try {
    lstatSync(file)
    return true
  } catch {
    return false
  }
}

function removeEmptyParents(root: string, dir: string): void {
  const top = path.resolve(root)
  for (let current = path.resolve(dir); current.startsWith(top + path.sep); current = path.dirname(current)) {
    try {
      rmdirSync(current)
    } catch {
      return
    }
  }
}

const nameList = (paths: readonly string[]): string =>
  paths.length > 10 ? `${paths.slice(0, 10).join(", ")} and ${paths.length - 10} more` : paths.join(", ")
