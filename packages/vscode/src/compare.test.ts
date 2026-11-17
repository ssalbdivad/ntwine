import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { seedReviewRepo } from "../e2e/review-repo.ts"
import { gitLensCompareLink, planCompare } from "./compare.ts"

const dir = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-compare-")))
after(() => rmSync(dir, { recursive: true, force: true }))
const repo = seedReviewRepo(dir)
const rev = (ref: string, cwd = repo.dir) => execFileSync("git", ["rev-parse", ref], { cwd, encoding: "utf8" }).trim()

test("a branch against main's tip shows the branch's commits since the fork, as a PR does: not main's later commit, not uncommitted files", async () => {
  // main moved on after the fork (main-only.md); the worktree has uncommitted and untracked edits on top.
  const plan = await planCompare({ dir: repo.worktree, base: rev("main"), head: rev(repo.branch) })
  assert.ok(!("error" in plan))
  assert.equal(plan.mergeBase, repo.base)
  assert.deepEqual(plan.entries, [
    { status: "deleted", rel: "docs/old.md", baseRel: "docs/old.md" },
    { status: "added", rel: "src/feature.ts" },
    { status: "modified", rel: "src/loop.ts", baseRel: "src/loop.ts" },
    { status: "renamed", rel: "src/renamed.ts", baseRel: "src/rename-me.ts" },
  ])
  assert.equal(plan.more, 0)
})

test("a commit the checkout does not have is named, with the fetch that would get it", async () => {
  const missing = "0123456789abcdef0123456789abcdef01234567"
  const plan = await planCompare({ dir: repo.dir, base: rev("main"), head: missing })
  assert.deepEqual(plan, { error: `Commit 0123456 isn't in ${repo.dir}. Fetch it there first (\`git fetch origin ${missing}\`).` })
})

test("GitLens's link puts the base first, and names the remote it finds the repository by", () => {
  assert.deepEqual(gitLensCompareLink("vscode", "aaa", "bbb", "https://github.com/acme/app.git"), {
    scheme: "vscode",
    authority: "eamodio.gitlens",
    path: "/link/r/-/compare/aaa...bbb",
    query: "url=https://github.com/acme/app.git",
  })
})
