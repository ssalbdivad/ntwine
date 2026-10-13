import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EDITOR_REVIEW_MAX_FILES } from "@ntwine/shared"
import { reviewTargetOf } from "./review-target.ts"
import { resetCheckoutMemo } from "./thread-cwd.ts"

// Real repositories and real `git worktree add`: which checkout a file is in is a question about git's
// own `.git` files, and a mocked one would only confirm what this module already believes.
function project(): { dir: string; worktree: (slug: string, at?: string) => string } {
  resetCheckoutMemo()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-review-target-")))
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", ...args], { cwd, stdio: "ignore" })
  git(dir, "init", "-q", "-b", "main")
  writeFileSync(join(dir, ".gitignore"), ".ntwine/\n")
  mkdirSync(join(dir, "src"))
  writeFileSync(join(dir, "src", "a.ts"), "export {}\n")
  git(dir, "add", ".")
  git(dir, "commit", "-qm", "init")
  return {
    dir,
    worktree(slug, at = join(dir, ".ntwine", "worktrees", slug)) {
      git(dir, "worktree", "add", "-q", "-b", slug, at)
      return realpathSync(at)
    },
  }
}

test("a worktree's edits make a branch review; the project folder's make a files review of those files only", () => {
  const { dir, worktree } = project()
  const wt = worktree("tidy")
  const target = reviewTargetOf({
    projectDir: dir,
    title: "Tidy the loop",
    // Most recent first, as the rail lists them.
    edited: [{ path: join(wt, "src", "b.ts") }, { path: join(dir, "src", "a.ts") }, { path: join(wt, "src", "a.ts") }],
    working: { dir: wt, kind: "worktree" },
  })
  assert.deepEqual(target, {
    title: "Tidy the loop",
    checkouts: [
      { dir: wt, scope: "branch", files: [join(wt, "src", "b.ts"), join(wt, "src", "a.ts")] },
      { dir, scope: "files", files: [join(dir, "src", "a.ts")] },
    ],
  })
})

test("the worktree the agent works in is reviewed even when no edit was seen there (a shell made the changes)", () => {
  const { dir, worktree } = project()
  const wt = worktree("codemod")
  assert.deepEqual(reviewTargetOf({ projectDir: dir, title: "t", edited: [], working: { dir: join(wt, "src"), kind: "worktree" } }).checkouts, [
    { dir: wt, scope: "branch", files: [] },
  ])
})

test("a thread working in the project folder with nothing written has nothing to review", () => {
  const { dir } = project()
  assert.deepEqual(reviewTargetOf({ projectDir: dir, title: "t", edited: [], working: { dir, kind: "root" } }).checkouts, [])
})

test("a sibling worktree outside the project is the same repository, so its edits are reviewed; another repository's are not", () => {
  const { dir, worktree } = project()
  const sibling = worktree("perf", `${dir}-perf`)
  const other = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-review-other-")))
  execFileSync("git", ["init", "-q"], { cwd: other, stdio: "ignore" })
  const target = reviewTargetOf({ projectDir: dir, title: "t", edited: [{ path: join(other, "x.ts") }, { path: join(sibling, "src", "a.ts") }] })
  assert.deepEqual(target.checkouts, [{ dir: sibling, scope: "branch", files: [join(sibling, "src", "a.ts")] }])
})

test(`at most ${EDITOR_REVIEW_MAX_FILES} files in all, so the frame and the schema always agree`, () => {
  const { dir } = project()
  const edited = Array.from({ length: EDITOR_REVIEW_MAX_FILES + 10 }, (_, i) => ({ path: join(dir, "src", `f${i}.ts`) }))
  const [checkout] = reviewTargetOf({ projectDir: dir, title: "t", edited }).checkouts
  assert.equal(checkout!.files.length, EDITOR_REVIEW_MAX_FILES)
})
