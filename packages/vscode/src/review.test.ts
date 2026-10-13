import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  baseQuery,
  baseText,
  branchBase,
  creationOf,
  mainWorktreeBranch,
  nothingToReview,
  parseBaseQuery,
  parseBinary,
  parseNameStatus,
  reviewCheckout,
  type CheckoutReview,
} from "./review.ts"

// EVERY CASE AGAINST REAL GIT: the base and the file list are git's answers to git's questions — reflogs,
// merge-bases, rename pairing, ignore rules — and a mocked git would only repeat what this module assumes.

function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-review-")))
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  const write = (path: string, text: string | Buffer) => {
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, text)
  }
  git(dir, "init", "-q", "-b", "main")
  write(join(dir, ".gitignore"), ".ntwine/\nnode_modules/\n")
  write(join(dir, "README.md"), "# readme\n")
  write(join(dir, "src", "a.ts"), "export const a = 1\nexport const shared = 'a long enough line for rename pairing'\n")
  write(join(dir, "docs", "old.md"), "old\n")
  git(dir, "add", ".")
  git(dir, "commit", "-qm", "init")
  const commit = (cwd: string, message: string) => {
    git(cwd, "add", "-A")
    git(cwd, "commit", "-qm", message)
    return git(cwd, "rev-parse", "HEAD")
  }
  const worktree = (slug: string, start = "main", at = join(dir, ".ntwine", "worktrees", slug)) => {
    git(dir, "worktree", "add", "-q", "-b", slug, at, start)
    return realpathSync(at)
  }
  return { dir, git, write, commit, worktree }
}

/** A worktree a thread worked in: every kind of change, committed and not, beside what must not show. */
function workedWorktree() {
  const r = repo()
  const forkedAt = r.git(r.dir, "rev-parse", "HEAD")
  const wt = r.worktree("tidy")
  r.write(join(wt, "README.md"), "# readme\n\nTidied.\n")
  r.write(join(wt, "src", "feature.ts"), "export const feature = 1\n")
  unlinkSync(join(wt, "docs", "old.md"))
  r.git(wt, "mv", "src/a.ts", "src/alpha.ts")
  r.commit(wt, "tidy")
  // Uncommitted: an edit on top, a new file never added, an ignored build file, a binary picture.
  r.write(join(wt, "src", "feature.ts"), "export const feature = 2\n")
  r.write(join(wt, "src", "new.ts"), "export const fresh = true\n")
  r.write(join(wt, "node_modules", "pkg", "index.js"), "module.exports = 1\n")
  r.write(join(wt, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01]))
  // main moves on after the fork: none of it is the thread's.
  r.write(join(r.dir, "main-only.md"), "landed on main later\n")
  r.commit(r.dir, "main moves")
  return { ...r, wt, forkedAt }
}

const rows = (review: CheckoutReview, root: string) =>
  review.entries.map((entry) => ({ ...entry, path: entry.path.slice(root.length + 1) }))

const review = async (dir: string, scope: "branch" | "files", files: string[] = []) => {
  const result = await reviewCheckout({ dir, scope, files })
  if ("error" in result) assert.fail(result.error)
  return result
}

test("a worktree's review: every change since the branch was made, committed or not, and nothing from main since", async () => {
  const { wt, forkedAt } = workedWorktree()
  const result = await review(wt, "branch")
  assert.equal(result.top, wt)
  assert.equal(result.base, forkedAt)
  assert.equal(result.baseNote, "where tidy started")
  assert.deepEqual(rows(result, wt), [
    { path: "README.md", status: "modified", basePath: "README.md" },
    { path: "docs/old.md", status: "deleted", basePath: "docs/old.md" },
    { path: "src/alpha.ts", status: "renamed", basePath: "src/a.ts" },
    { path: "src/feature.ts", status: "added" },
    { path: "src/new.ts", status: "added" },
  ])
  assert.deepEqual(result.binary, [join(wt, "logo.png")], "a picture is not a text diff")
  assert.equal(result.more, 0)
  // The left side is the file as the base had it.
  assert.equal(await baseText(result.top, result.base, "README.md"), "# readme\n")
  assert.equal(await baseText(result.top, result.base, "src/a.ts"), "export const a = 1\nexport const shared = 'a long enough line for rename pairing'\n")
})

test("a thread that merged main in is shown against the merge, so what main brought is not its change", async () => {
  const { git, wt, commit } = workedWorktree()
  commit(wt, "the uncommitted half")
  git(wt, "merge", "-q", "--no-edit", "main")
  const result = await review(wt, "branch")
  assert.equal(result.base, git(wt, "rev-parse", "main"))
  assert.equal(result.baseNote, "where it left main")
  assert.ok(!result.entries.some((entry) => entry.path.endsWith("main-only.md")), "main's own file is not the thread's")
  assert.ok(result.entries.some((entry) => entry.path.endsWith("src/feature.ts")))
})

test("after the branch is merged back into main its review still shows its work, not nothing", async () => {
  const { dir, git, wt, commit, forkedAt } = workedWorktree()
  commit(wt, "the uncommitted half")
  git(dir, "merge", "-q", "--no-edit", "tidy")
  const result = await review(wt, "branch")
  assert.equal(result.base, forkedAt, "main holds HEAD now, so only where the branch started can say")
  assert.ok(result.entries.some((entry) => entry.path.endsWith("README.md")))
})

test("a worktree made from another branch is reviewed from where it left THAT branch, not from main", async () => {
  const r = repo()
  r.git(r.dir, "checkout", "-q", "-b", "feature-base")
  r.write(join(r.dir, "base-work.ts"), "export const fromBase = 1\n")
  const baseTip = r.commit(r.dir, "work on the base branch")
  r.git(r.dir, "checkout", "-q", "main")
  const wt = r.worktree("on-top", "feature-base")
  r.write(join(wt, "mine.ts"), "export const mine = 1\n")
  r.commit(wt, "mine")
  const result = await review(wt, "branch")
  assert.equal(result.base, baseTip)
  assert.deepEqual(rows(result, wt).map((row) => row.path), ["mine.ts"])
})

test("a detached worktree with no reflog of its own falls back to where it left the project folder's branch", async () => {
  const r = repo()
  const at = join(r.dir, ".ntwine", "worktrees", "detached")
  r.git(r.dir, "worktree", "add", "-q", "--detach", at, "main")
  const wt = realpathSync(at)
  const start = r.git(wt, "rev-parse", "HEAD")
  r.write(join(wt, "x.ts"), "export const x = 1\n")
  r.commit(wt, "x")
  assert.deepEqual(await branchBase(wt, r.git(wt, "rev-parse", "HEAD")), { base: start, note: "where it left main" })
})

test("the project folder's review is the thread's own files' uncommitted changes and nothing else", async () => {
  const r = repo()
  // Another agent's edit in the same tree, and one of this thread's files already committed.
  r.write(join(r.dir, "README.md"), "# someone else's edit\n")
  r.write(join(r.dir, "src", "a.ts"), "export const a = 2\n")
  r.write(join(r.dir, "src", "committed.ts"), "export const done = 1\n")
  r.git(r.dir, "add", "src/committed.ts")
  r.git(r.dir, "commit", "-qm", "the thread committed this one")
  r.write(join(r.dir, "src", "created.ts"), "export const created = 1\n")
  unlinkSync(join(r.dir, "docs", "old.md"))
  const files = [join(r.dir, "src", "a.ts"), join(r.dir, "src", "committed.ts"), join(r.dir, "src", "created.ts"), join(r.dir, "docs", "old.md")]
  const result = await review(r.dir, "files", files)
  assert.equal(result.base, r.git(r.dir, "rev-parse", "HEAD"))
  assert.deepEqual(rows(result, r.dir), [
    { path: "docs/old.md", status: "deleted", basePath: "docs/old.md" },
    { path: "src/a.ts", status: "modified", basePath: "src/a.ts" },
    { path: "src/created.ts", status: "added" },
  ])
  // None of the thread's files changed: nothing, said for what it is.
  const clean = await review(r.dir, "files", [join(r.dir, "src", "committed.ts")])
  assert.deepEqual(clean.entries, [])
  assert.equal(nothingToReview([clean]), "The files this thread edited have no uncommitted changes.")
})

test("a file whose name looks like a pathspec is that file", async () => {
  const r = repo()
  r.write(join(r.dir, "src", "*.ts"), "odd\n")
  r.write(join(r.dir, "src", "a.ts"), "export const a = 3\n")
  const result = await review(r.dir, "files", [join(r.dir, "src", "*.ts")])
  assert.deepEqual(rows(result, r.dir).map((row) => row.path), ["src/*.ts"])
})

test("no repository, or one with no commits, is said in words", async () => {
  const plain = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-review-plain-")))
  const none = await reviewCheckout({ dir: plain, scope: "branch", files: [] })
  assert.ok("error" in none && /isn't a git repository/.test(none.error))
  const empty = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-review-empty-")))
  execFileSync("git", ["init", "-q"], { cwd: empty })
  const unborn = await reviewCheckout({ dir: empty, scope: "branch", files: [] })
  assert.ok("error" in unborn && /no commits yet/.test(unborn.error))
  rmSync(plain, { recursive: true })
  rmSync(empty, { recursive: true })
})

test("git's own outputs, parsed: name-status with renames, numstat's binary marks, the creation record, the main branch", () => {
  assert.deepEqual(parseNameStatus("M\0a.ts\0R087\0old.ts\0new.ts\0D\0gone.ts\0A\0b.ts\0T\0link\0"), [
    { status: "modified", rel: "a.ts", baseRel: "a.ts" },
    { status: "renamed", rel: "new.ts", baseRel: "old.ts" },
    { status: "deleted", rel: "gone.ts", baseRel: "gone.ts" },
    { status: "added", rel: "b.ts" },
    { status: "modified", rel: "link", baseRel: "link" },
  ])
  assert.deepEqual([...parseBinary("3\t1\ta.ts\0-\t-\tlogo.png\0-\t-\t\0old.bin\0new.bin\0")], ["logo.png", "old.bin", "new.bin"])
  const sha = "0".repeat(39) + "1"
  assert.deepEqual(creationOf(`${"a".repeat(40)}\tcommit: later\n${sha}\tbranch: Created from main\n`), { sha, from: "main" })
  assert.equal(creationOf(`${sha}\tcommit: the reflog was cut\n`), undefined)
  assert.equal(mainWorktreeBranch("worktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /r/w\nHEAD def\nbranch refs/heads/w\n"), "main")
  assert.equal(mainWorktreeBranch("worktree /r\nHEAD abc\ndetached\n\n"), undefined)
})

test("the base side's address carries a repository, a commit and a path inside it, and nothing else", () => {
  const ref = { top: "/work/repo", base: "a".repeat(40), basePath: "src/a b.ts" }
  assert.deepEqual(parseBaseQuery(baseQuery(ref)), ref)
  assert.equal(parseBaseQuery(baseQuery({ ...ref, basePath: "../../etc/passwd" })), undefined)
  assert.equal(parseBaseQuery(baseQuery({ ...ref, basePath: "/etc/passwd" })), undefined)
  assert.equal(parseBaseQuery(baseQuery({ ...ref, base: "HEAD; rm -rf /" })), undefined)
  assert.equal(parseBaseQuery(baseQuery({ ...ref, top: "relative" })), undefined)
})
