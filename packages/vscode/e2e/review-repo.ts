// A THREAD'S WORKTREE, WORKED IN — the repository the end-to-end runs review (scripts/e2e.ts: the suite in
// FAKE mode builds one inside the workspace; STACK mode seeds one in the tenant project and a transcript
// whose agent edited it). Real git, every kind of change a review must show and everything it must not:
//
//   committed on the branch   src/loop.ts modified, src/feature.ts added, docs/old.md deleted,
//                             src/rename-me.ts renamed to src/renamed.ts
//   uncommitted               src/feature.ts edited again, src/fresh.ts never added
//   never shown               node_modules/ (ignored), logo.png (binary), main-only.md (landed on main
//                             AFTER the fork: a base at main's tip would show the branch deleting it)
//
// Pure node, no `vscode`: the suite runs it inside the editor's extension host, the harness outside it.

import { execFileSync } from "node:child_process"
import { mkdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export interface ReviewRepo {
  /** The project folder: the repository's main checkout. */
  dir: string
  /** The thread's worktree, `<dir>/.ntwine/worktrees/<slug>`, real-pathed. */
  worktree: string
  branch: string
  /** The commit the branch was made at: the review's base. */
  base: string
  /** What the review must list, relative to the worktree, in git's order. */
  expected: { path: string; status: "modified" | "added" | "deleted" | "renamed"; basePath?: string }[]
  /** Each listed file's text at the base (absent for an added file) and on disk now (absent for a deleted one). */
  text: Record<string, { base?: string; now?: string }>
  /** The files an agent would have edited with its tools, absolute, newest first — for a transcript. */
  edited: string[]
}

export const LOOP_BEFORE = "export function loop(xs: number[]): number {\n  let total = 0\n  for (const x of xs) total += x\n  return total\n}\n"
export const LOOP_AFTER = "export function loop(xs: number[]): number {\n  return xs.reduce((total, x) => total + x, 0)\n}\n"
const RENAMED = "export const renamed = 'a file long enough for git to pair its rename across the commit'\n"

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=ntwine e2e", "-c", "user.email=e2e@ntwine.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function write(path: string, text: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/** Build the worktree in `dir`, a git repository with at least one commit (made one when it is not). */
export function seedReviewRepo(dir: string, branch = "tidy-the-loop"): ReviewRepo {
  try {
    git(dir, "rev-parse", "HEAD")
  } catch {
    mkdirSync(dir, { recursive: true })
    git(dir, "init", "-q", "-b", "main")
    write(join(dir, "README.md"), "# review e2e\n")
    git(dir, "add", ".")
    git(dir, "commit", "-qm", "init")
  }
  // The project ignores its own `.ntwine/`, as every Ntwine project does — which is exactly what made a
  // worktree's files read as ignored from the project root.
  write(join(dir, ".gitignore"), ".ntwine/\nnode_modules/\n")
  write(join(dir, "src", "loop.ts"), LOOP_BEFORE)
  write(join(dir, "src", "rename-me.ts"), RENAMED)
  write(join(dir, "docs", "old.md"), "# old notes\n")
  git(dir, "add", "-A")
  git(dir, "commit", "-qm", "the code the thread starts from")
  const base = git(dir, "rev-parse", "HEAD")

  const at = join(dir, ".ntwine", "worktrees", branch)
  git(dir, "worktree", "add", "-q", "-b", branch, at)
  const worktree = realpathSync(at)
  write(join(worktree, "src", "loop.ts"), LOOP_AFTER)
  write(join(worktree, "src", "feature.ts"), "export const feature = 1\n")
  unlinkSync(join(worktree, "docs", "old.md"))
  git(worktree, "mv", "src/rename-me.ts", "src/renamed.ts")
  git(worktree, "add", "-A")
  git(worktree, "commit", "-qm", "tidy the loop")
  const featureNow = "export const feature = 2 // edited after the commit\n"
  write(join(worktree, "src", "feature.ts"), featureNow)
  write(join(worktree, "src", "fresh.ts"), "export const fresh = true\n")
  write(join(worktree, "node_modules", "pkg", "index.js"), "module.exports = 1\n")
  write(join(worktree, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]))

  write(join(dir, "main-only.md"), "landed on main after the fork\n")
  git(dir, "add", "main-only.md")
  git(dir, "commit", "-qm", "main moves on")

  return {
    dir: realpathSync(dir),
    worktree,
    branch,
    base,
    expected: [
      { path: "docs/old.md", status: "deleted", basePath: "docs/old.md" },
      { path: "src/feature.ts", status: "added" },
      { path: "src/fresh.ts", status: "added" },
      { path: "src/loop.ts", status: "modified", basePath: "src/loop.ts" },
      { path: "src/renamed.ts", status: "renamed", basePath: "src/rename-me.ts" },
    ],
    text: {
      "docs/old.md": { base: "# old notes\n" },
      "src/feature.ts": { now: featureNow },
      "src/fresh.ts": { now: "export const fresh = true\n" },
      "src/loop.ts": { base: LOOP_BEFORE, now: LOOP_AFTER },
      "src/renamed.ts": { base: RENAMED, now: RENAMED },
    },
    edited: [join(worktree, "src", "feature.ts"), join(worktree, "src", "loop.ts"), join(worktree, "src", "fresh.ts")],
  }
}
