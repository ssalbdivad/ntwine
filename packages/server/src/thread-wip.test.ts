// MOVING A THREAD'S UNCOMMITTED WORK between two clones — against REAL repositories.
//
// Every test builds a bare "remote" and two clones of it: A, the machine the thread leaves, and B, the one
// it arrives on. The clones carry no user identity and git is told never to guess one
// (`user.useConfigOnly`), so every snapshot here also proves W can be committed on a machine with no
// user.name configured.
import { after, describe, it } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { locateThreadCheckout, movedRef, restoreWip, revertMovedPaths, snapshotWip, threadCheckout, writeWipBundle, type WipSnapshot } from "./thread-wip.ts"

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-wip-test-")))
after(() => rmSync(scratch, { recursive: true, force: true }))

// Isolate from the machine's own git config (hooks, autocrlf, a global identity).
const globalConfig = join(scratch, "gitconfig")
writeFileSync(globalConfig, "[user]\n\tuseConfigOnly = true\n[init]\n\tdefaultBranch = main\n[protocol \"file\"]\n\tallow = always\n")
process.env.GIT_CONFIG_GLOBAL = globalConfig
process.env.GIT_CONFIG_NOSYSTEM = "1"

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
const commitAll = (cwd: string, message: string): string => {
  git(cwd, "add", "-A")
  git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message)
  return git(cwd, "rev-parse", "HEAD").trim()
}
const put = (file: string, body: string) => {
  mkdirSync(join(file, ".."), { recursive: true })
  writeFileSync(file, body)
}
const read = (file: string) => readFileSync(file, "utf8")
const status = (cwd: string) => git(cwd, "status", "--porcelain=v1", "--untracked-files=all")

let n = 0
/** A remote holding one commit on main, cloned as A (origin) and B (destination). */
function machines() {
  const dir = join(scratch, `case-${++n}`)
  const seed = join(dir, "seed")
  mkdirSync(seed, { recursive: true })
  git(seed, "init", "-q")
  put(join(seed, "a.txt"), "a\n")
  put(join(seed, "b.txt"), "b\n")
  put(join(seed, "src/c.txt"), "c\n")
  put(join(seed, ".gitignore"), ".ntwine/\n")
  commitAll(seed, "seed")
  git(dir, "clone", "-q", "--bare", seed, "remote.git")
  git(dir, "clone", "-q", "remote.git", "A")
  git(dir, "clone", "-q", "remote.git", "B")
  return { dir, A: join(dir, "A"), B: join(dir, "B") }
}

/** Snapshot + bundle on the origin, as the caller will. */
function pack(dir: string, root: string, kind: "main" | "worktree", editedPaths?: string[]): WipSnapshot & { bundleFile: string } {
  const snap = snapshotWip({ root, kind, editedPaths, message: "ntwine: moved work" })
  const bundleFile = join(dir, `wip-${++n}.bundle`)
  writeWipBundle({ root, wip: snap.wip, file: bundleFile })
  return { ...snap, bundleFile }
}

const restoreInto = (mainCheckout: string, rel: string, snap: WipSnapshot & { bundleFile: string }, over: { fetchRemote?: boolean } = {}) =>
  restoreWip({ mainCheckout, rel, slug: "fix-it", ...snap, ...over })

describe("a worktree thread", () => {
  it("moves its branch and every uncommitted change, leaving the origin untouched", () => {
    const { dir, A, B } = machines()
    git(A, "worktree", "add", "-q", ".ntwine/worktrees/feat", "-b", "feat")
    const wt = join(A, ".ntwine/worktrees/feat")
    put(join(wt, "feat.txt"), "local only\n")
    commitAll(wt, "a commit the remote never saw")
    put(join(wt, "a.txt"), "a, edited\n")
    put(join(wt, "src/new.txt"), "new\n")
    unlinkSync(join(wt, "b.txt"))

    assert.deepEqual(locateThreadCheckout(join(wt, "src"), A), { kind: "worktree", rel: ".ntwine/worktrees/feat", root: wt })

    const indexFile = join(A, ".git/worktrees/feat/index")
    const before = { status: status(wt), head: git(wt, "rev-parse", "HEAD"), index: readFileSync(indexFile) }
    const snap = pack(dir, wt, "worktree")
    assert.deepEqual(readFileSync(indexFile), before.index)
    assert.deepEqual({ status: status(wt), head: git(wt, "rev-parse", "HEAD") }, { status: before.status, head: before.head })
    assert.deepEqual([snap.branch, snap.paths, snap.leftBehind], ["feat", ["a.txt", "b.txt", "src/new.txt"], []])

    const result = restoreInto(B, ".ntwine/worktrees/feat", snap)
    const bwt = join(realpathSync(B), ".ntwine/worktrees/feat")
    assert.deepEqual(result, { ok: true, root: bwt, created: true, fastForwarded: false })
    assert.equal(git(bwt, "symbolic-ref", "--short", "HEAD").trim(), "feat")
    assert.equal(git(bwt, "rev-parse", "HEAD").trim(), snap.head)
    assert.equal(status(bwt), " M a.txt\n D b.txt\n?? src/new.txt\n")
    assert.equal(read(join(bwt, "a.txt")), "a, edited\n")
    assert.equal(read(join(bwt, "src/new.txt")), "new\n")
    assert.equal(read(join(bwt, "feat.txt")), "local only\n")
    assert.equal(git(B, "rev-parse", movedRef("fix-it")).trim(), snap.wip)
  })

  it("is refused in a checkout outside .ntwine/worktrees", () => {
    const { dir, A } = machines()
    git(A, "worktree", "add", "-q", join(dir, "beside"), "-b", "beside")
    assert.deepEqual(locateThreadCheckout(join(dir, "beside"), A), {
      refused: `This thread works in ${join(dir, "beside")}, a checkout outside the project's .ntwine/worktrees, so its uncommitted work cannot move`,
    })
    // Gone, or not this repository at all: the main checkout.
    assert.deepEqual(locateThreadCheckout(join(dir, "gone"), A), { kind: "main", rel: ".", root: A })
    assert.deepEqual(locateThreadCheckout(join(dir, "B"), A), { kind: "main", rel: ".", root: A })
  })

  it("is found by the files it edited when it never cd'd into its worktree, and its other edits stay", () => {
    const { A } = machines()
    git(A, "worktree", "add", "-q", ".ntwine/worktrees/feat", "-b", "feat")
    git(A, "worktree", "add", "-q", ".ntwine/worktrees/old", "-b", "old")
    const feat = join(A, ".ntwine/worktrees/feat")
    put(join(feat, "a.txt"), "a, edited\n")
    put(join(A, ".ntwine/worktrees/old/b.txt"), "b, edited earlier\n")
    put(join(A, "b.txt"), "b, edited in main\n")
    put(join(A, "c.txt"), "another agent's\n")
    // Oldest first, as editedFilesOf orders them; the scratch note is not a checkout's file.
    const edited = [join(A, ".ntwine/worktrees/old/b.txt"), join(A, "b.txt"), join(A, ".ntwine/threads/s/notes.md"), join(feat, "a.txt")]
    assert.deepEqual(threadCheckout({ cwd: A, mainCheckout: A, editedPaths: edited }), {
      location: { kind: "worktree", rel: ".ntwine/worktrees/feat", root: feat },
      elsewhere: [".ntwine/worktrees/old/b.txt", "b.txt"],
    })
    // Its newest edit back in the main checkout makes that its checkout again; a cwd in a worktree decides outright.
    assert.deepEqual(threadCheckout({ cwd: A, mainCheckout: A, editedPaths: [...edited, join(A, "b.txt")] }).location, { kind: "main", rel: ".", root: A })
    assert.deepEqual(threadCheckout({ cwd: join(A, ".ntwine/worktrees/old"), mainCheckout: A, editedPaths: edited }).location, { kind: "worktree", rel: ".ntwine/worktrees/old", root: join(A, ".ntwine/worktrees/old") })
  })
})

describe("a main-checkout thread", () => {
  /** A is one unpushed commit ahead of B; the thread edited x.txt and z.txt, another agent y.txt. */
  function mainMove() {
    const m = machines()
    put(join(m.A, "x.txt"), "x\n")
    put(join(m.A, "y.txt"), "y\n")
    commitAll(m.A, "ahead of B")
    put(join(m.A, "x.txt"), "x, edited\n")
    put(join(m.A, "y.txt"), "y, someone else's\n")
    put(join(m.A, "z.txt"), "z\n")
    const edited = [join(m.A, "x.txt"), join(m.A, "z.txt"), join(m.A, "a.txt"), join(m.dir, "elsewhere.txt")]
    return { ...m, snap: pack(m.dir, m.A, "main", edited) }
  }

  it("moves only what the thread edited, and fast-forwards a clone that is behind", () => {
    const { B, snap } = mainMove()
    assert.deepEqual([snap.paths, snap.leftBehind], [["x.txt", "z.txt"], ["y.txt"]])

    put(join(B, "b.txt"), "B's own work\n")
    assert.deepEqual(restoreInto(B, ".", snap), { ok: true, root: realpathSync(B), created: false, fastForwarded: true })
    assert.equal(git(B, "rev-parse", "HEAD").trim(), snap.head)
    assert.equal(status(B), " M b.txt\n M x.txt\n?? z.txt\n")
    assert.equal(read(join(B, "x.txt")), "x, edited\n")
    assert.equal(read(join(B, "y.txt")), "y\n")

    // A retry finds the work already there and changes nothing.
    assert.deepEqual(restoreInto(B, ".", snap), { ok: true, root: realpathSync(B), created: false, fastForwarded: false })
    assert.equal(status(B), " M b.txt\n M x.txt\n?? z.txt\n")
    assert.equal(read(join(B, "x.txt")), "x, edited\n")
  })

  it("is refused, before anything moves, over the destination's own change at a moved path", () => {
    const { B, snap } = mainMove()
    const head = git(B, "rev-parse", "HEAD")
    put(join(B, "z.txt"), "B's z\n")
    assert.deepEqual(restoreInto(B, ".", snap), { refused: "This checkout has its own uncommitted changes to z.txt" })
    assert.equal(git(B, "rev-parse", "HEAD"), head)
    assert.equal(status(B), "?? z.txt\n")
  })

  it("is refused when the destination's branch has diverged", () => {
    const { B, snap } = mainMove()
    put(join(B, "own.txt"), "only on B\n")
    commitAll(B, "B's own commit")
    assert.deepEqual(restoreInto(B, ".", snap), { refused: "This checkout's main has diverged from the thread's; sync it first" })
  })
})

it("revert puts back only the moved paths that still hold the snapshot", () => {
  const { dir, A } = machines()
  put(join(A, "a.txt"), "a, edited\n")
  put(join(A, "b.txt"), "b, edited\n")
  put(join(A, "src/deep/new.txt"), "new\n")
  put(join(A, "untouched.txt"), "not the thread's\n")
  const snap = pack(dir, A, "main", ["a.txt", "b.txt", "src/deep/new.txt"].map((p) => join(A, p)))
  put(join(A, "b.txt"), "b, edited again after the snapshot\n")

  assert.deepEqual(revertMovedPaths({ root: A, ...snap }), { reverted: ["a.txt", "src/deep/new.txt"], kept: ["b.txt"] })
  assert.equal(read(join(A, "a.txt")), "a\n")
  assert.equal(existsSync(join(A, "src/deep")), false)
  assert.equal(status(A), " M b.txt\n?? untouched.txt\n")
})

it("work moved to B moves back into A's existing worktree, fast-forwarding it", () => {
  const { dir, A, B } = machines()
  git(A, "worktree", "add", "-q", ".ntwine/worktrees/feat", "-b", "feat")
  const wt = join(A, ".ntwine/worktrees/feat")
  put(join(wt, "a.txt"), "a, edited on A\n")
  put(join(wt, "new.txt"), "new\n")
  const there = pack(dir, wt, "worktree")
  const bwt = (restoreInto(B, ".ntwine/worktrees/feat", there) as { root: string }).root
  assert.deepEqual(revertMovedPaths({ root: wt, ...there }), { reverted: ["a.txt", "new.txt"], kept: [] })
  assert.equal(status(wt), "")

  // B carries on: a commit on feat, and fresh uncommitted work.
  commitAll(bwt, "B commits the work")
  put(join(bwt, "b.txt"), "b, edited on B\n")
  const back = pack(dir, bwt, "worktree")
  assert.deepEqual(restoreWip({ mainCheckout: A, rel: ".ntwine/worktrees/feat", slug: "fix-it", ...back, bundleFile: back.bundleFile }), {
    ok: true,
    root: wt,
    created: false,
    fastForwarded: true,
  })
  assert.equal(git(wt, "rev-parse", "HEAD").trim(), back.head)
  assert.equal(status(wt), " M b.txt\n")
  assert.equal(read(join(wt, "a.txt")), "a, edited on A\n")
})

it("a bundle built on commits the destination lacks is refused until its remote is fetched", () => {
  const { dir, A, B } = machines()
  // A pushes a commit B has not fetched, then builds unpushed work on it: the bundle needs that commit.
  put(join(A, "pushed.txt"), "pushed\n")
  commitAll(A, "pushed after B cloned")
  git(A, "push", "-q", "origin", "main")
  put(join(A, "local.txt"), "local\n")
  commitAll(A, "not pushed")
  put(join(A, "a.txt"), "a, edited\n")
  const snap = pack(dir, A, "main", [join(A, "a.txt")])

  assert.deepEqual(restoreInto(B, ".", snap, { fetchRemote: false }), {
    refused: "This clone is missing commits the thread's branch builds on; pull it and retry",
  })
  assert.equal(status(B), "")
  // Positive control: the same bundle goes through once the remote is fetched.
  assert.deepEqual(restoreInto(B, ".", snap), { ok: true, root: realpathSync(B), created: false, fastForwarded: true })
  assert.equal(status(B), " M a.txt\n")
})
