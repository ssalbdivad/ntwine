import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { repoCarriedFiles, repoCarriedEditedFiles } from "./repo-files.ts"
import { resetCheckoutMemo } from "./thread-cwd.ts"

// A REAL repository every time: the whole module is a question put to git, so a mocked git would only
// ever confirm what this file already believes. The force-added case below is exactly the one a
// hand-rolled ignore matcher gets wrong.
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "frizz-repo-files-"))
  const run = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" })
  run(["init", "-q", "-b", "main"])
  run(["config", "user.email", "t@example.com"])
  run(["config", "user.name", "t"])
  writeFileSync(join(dir, ".gitignore"), ".frizz/\nnode_modules/\n*.log\n")
  mkdirSync(join(dir, ".frizz"), { recursive: true })
  mkdirSync(join(dir, "src"), { recursive: true })
  writeFileSync(join(dir, ".frizz", "notes.md"), "scratch\n")
  writeFileSync(join(dir, "src", "app.ts"), "export {}\n")
  writeFileSync(join(dir, "build.log"), "noise\n")
  writeFileSync(join(dir, "forced.log"), "kept anyway\n")
  run(["add", ".gitignore", "src/app.ts"])
  run(["add", "-f", "forced.log"])
  run(["commit", "-qm", "init"])
  return dir
}

test("the rail keeps repo work and drops what git ignores", () => {
  const dir = repo()
  const kept = repoCarriedFiles(dir, [
    join(dir, "src/app.ts"),
    join(dir, ".frizz/notes.md"),
    join(dir, "build.log"),
  ])
  assert.deepEqual(kept, [join(dir, "src/app.ts")])
})

test("a file created but never `git add`ed still counts — the index is not the test", () => {
  const dir = repo()
  writeFileSync(join(dir, "src", "brand-new.ts"), "export {}\n")
  const kept = repoCarriedFiles(dir, [join(dir, "src/brand-new.ts")])
  assert.deepEqual(kept, [join(dir, "src/brand-new.ts")], "new work must be visible before it is committed")
})

test("a force-added file the repository really carries is kept, ignore rule notwithstanding", () => {
  const dir = repo()
  // `git add -f forced.log` against a `*.log` rule: `git ls-files` carries it, so the rail must too.
  const kept = repoCarriedFiles(dir, [join(dir, "forced.log"), join(dir, "build.log")])
  assert.deepEqual(kept, [join(dir, "forced.log")])
})

test("a path outside the project is passed through — git has no opinion on another checkout", () => {
  const dir = repo()
  const outside = join(tmpdir(), "somewhere-else", "x.ts")
  assert.deepEqual(repoCarriedFiles(dir, [outside]), [outside])
})

// A worktree Frizz's way: `.frizz/worktrees/<slug>`, INSIDE the project, whose `.gitignore` ignores all
// of `.frizz/`. Asked in the project root, every one of these paths read as ignored and the rail of a
// worktree thread was empty; asked in the worktree, its own rules apply.
function worktreeOf(dir: string, slug: string, at = join(dir, ".frizz", "worktrees", slug)): string {
  execFileSync("git", ["worktree", "add", "-q", "-b", slug, at], { cwd: dir, stdio: "ignore" })
  mkdirSync(join(at, "node_modules", "pkg"), { recursive: true })
  writeFileSync(join(at, "node_modules", "pkg", "index.js"), "module.exports = 1\n")
  writeFileSync(join(at, "src", "feature.ts"), "export const feature = 1\n")
  writeFileSync(join(at, "src", "app.ts"), "export const changed = 1\n")
  writeFileSync(join(at, "debug.log"), "noise\n")
  return at
}

test("a worktree under the project's ignored .frizz/ keeps its repo work and drops what IT ignores", () => {
  resetCheckoutMemo()
  const dir = repo()
  const wt = worktreeOf(dir, "feature")
  // The control: the project root really does ignore this path, which is the whole bug.
  const rootSays = execFileSync("git", ["check-ignore", join(wt, "src", "feature.ts")], { cwd: dir, encoding: "utf8" }).trim()
  assert.equal(rootSays, join(wt, "src", "feature.ts"), "the project root ignores a path inside its .frizz/worktrees")
  const kept = repoCarriedFiles(dir, [
    join(wt, "src", "feature.ts"),
    join(wt, "src", "app.ts"),
    join(wt, "node_modules", "pkg", "index.js"),
    join(wt, "debug.log"),
    join(dir, "src", "app.ts"),
    join(dir, ".frizz", "notes.md"),
  ])
  assert.deepEqual(kept, [join(wt, "src", "feature.ts"), join(wt, "src", "app.ts"), join(dir, "src", "app.ts")])
})

test("a sibling worktree outside the project is judged by its own checkout, not passed through", () => {
  resetCheckoutMemo()
  const dir = repo()
  const sibling = worktreeOf(dir, "perf", `${dir}-perf`)
  const kept = repoCarriedFiles(dir, [join(sibling, "src", "feature.ts"), join(sibling, "node_modules", "pkg", "index.js")])
  assert.deepEqual(kept, [join(sibling, "src", "feature.ts")])
})

test("an unrelated clone in the project's scratch is still the project's ignored scratch", () => {
  resetCheckoutMemo()
  const dir = repo()
  const clone = join(dir, ".frizz", "scratch", "lib")
  mkdirSync(clone, { recursive: true })
  execFileSync("git", ["init", "-q"], { cwd: clone, stdio: "ignore" })
  writeFileSync(join(clone, "index.ts"), "export {}\n")
  assert.deepEqual(repoCarriedFiles(dir, [join(clone, "index.ts")]), [])
})

test("rows from two checkouts keep their order and diffstats", () => {
  resetCheckoutMemo()
  const dir = repo()
  const wt = worktreeOf(dir, "rows")
  const rows = [
    { path: join(wt, "src", "feature.ts"), edits: 3, added: 4 },
    { path: join(wt, "node_modules", "pkg", "index.js"), edits: 1 },
    { path: join(dir, "src", "app.ts"), edits: 1, added: 1, removed: 1 },
  ]
  assert.deepEqual(repoCarriedEditedFiles(dir, rows), [rows[0], rows[2]])
})

// THE WORKER CONTRACT'S OWN WORKTREE LOCATION, in the shape a real project has it: no top-level rule
// for `.frizz/` at all, only the `*` Frizz writes inside it (project-root.ts). Asked from the project
// root, git ignores every file in that checkout, so before this an isolated effort left the rail empty.
function repoWithWorktree(): { dir: string; worktree: string } {
  const dir = repo()
  writeFileSync(join(dir, ".frizz", ".gitignore"), "*\n")
  const worktree = join(dir, ".frizz", "worktrees", "feature")
  execFileSync("git", ["worktree", "add", "-q", "-b", "feature", worktree], { cwd: dir, stdio: "ignore" })
  return { dir, worktree }
}

test("a file in a worktree inside the project is judged by that worktree's own ignore rules", () => {
  const { dir, worktree } = repoWithWorktree()
  writeFileSync(join(worktree, "src", "new.ts"), "export {}\n")
  writeFileSync(join(worktree, "build.log"), "noise\n")
  const kept = repoCarriedFiles(dir, [
    join(worktree, "src/app.ts"),
    join(worktree, "src/new.ts"),
    join(worktree, "build.log"),
    join(dir, ".frizz/notes.md"),
    join(dir, "src/app.ts"),
  ])
  assert.deepEqual(kept, [join(worktree, "src/app.ts"), join(worktree, "src/new.ts"), join(dir, "src/app.ts")])
})

test("a plain directory under .frizz/worktrees is still scratch — only a registered worktree answers for itself", () => {
  const { dir } = repoWithWorktree()
  mkdirSync(join(dir, ".frizz", "worktrees", "not-a-checkout"), { recursive: true })
  writeFileSync(join(dir, ".frizz", "worktrees", "not-a-checkout", "a.ts"), "export {}\n")
  assert.deepEqual(repoCarriedFiles(dir, [join(dir, ".frizz/worktrees/not-a-checkout/a.ts")]), [])
})

// Git will not judge a path spelled through a symlinked directory, and it fails the whole batch rather
// than the one path — so before this, one write through a link (this repo's `.claude/skills/<name>` is
// one) left every ignored row on the rail.
test("a path through a symlinked directory is judged where the file really is, and does not silence the rest", () => {
  const dir = repo()
  symlinkSync("src", join(dir, "linked-src"))
  symlinkSync(".frizz", join(dir, "linked-scratch"))
  const kept = repoCarriedFiles(dir, [
    join(dir, "linked-src/app.ts"),
    join(dir, "linked-scratch/notes.md"),
    join(dir, "build.log"),
  ])
  assert.deepEqual(kept, [join(dir, "linked-src/app.ts")])
})

test("a project that is not a git repository filters nothing", () => {
  const plain = mkdtempSync(join(tmpdir(), "frizz-not-a-repo-"))
  writeFileSync(join(plain, "a.ts"), "export {}\n")
  assert.deepEqual(repoCarriedFiles(plain, [join(plain, "a.ts")]), [join(plain, "a.ts")])
})

test("row order and diffstats survive the filter", () => {
  const dir = repo()
  const rows = [
    { path: join(dir, ".frizz/notes.md"), edits: 1 },
    { path: join(dir, "src/app.ts"), edits: 2, added: 7, removed: 1 },
    { path: join(dir, "build.log"), edits: 1 },
  ]
  assert.deepEqual(repoCarriedEditedFiles(dir, rows), [{ path: join(dir, "src/app.ts"), edits: 2, added: 7, removed: 1 }])
})

test("nothing in, nothing out", () => {
  assert.deepEqual(repoCarriedFiles(repo(), []), [])
  assert.deepEqual(repoCarriedEditedFiles(repo(), []), [])
})
