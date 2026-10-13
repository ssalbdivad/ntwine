import path from "node:path"
import { EDITOR_REVIEW_MAX_CHECKOUTS, EDITOR_REVIEW_MAX_FILES, type EditorReviewCheckout, type EditorReviewTarget, type ThreadWorkingDir } from "@ntwine/shared"
import { liftRepoWorktree } from "./thread-cwd.ts"

// WHAT "REVIEW CHANGES" SHOWS FOR A THREAD — the checkouts its edits are in, for the editor extension to
// diff (packages/vscode review.ts asks git for the rest). Design: ARCHITECTURE.md § VS Code
// extension.
//
// Ntwine records nothing about a thread's base: it stays out of the worktree decision (thread-cwd.ts), and
// a thread's start is a transcript, not a commit. What it DOES know is where the thread wrote — the rail's
// edited files, read off the whole transcript and filtered to what git carries (edited-files.ts,
// repo-files.ts) — and where its agent is working now. Those name the checkouts; git names the base:
//
//   - A WORKTREE of the project's repository (thread-cwd.ts liftRepoWorktree) is the thread's own — the
//     way an agent isolates itself — so the review is the whole branch: everything that changed there
//     since it left the branch it came from, committed or not ("branch").
//   - THE PROJECT FOLDER is shared. On this machine several agents and the human edit one working tree at
//     once, so "everything uncommitted" would be mostly other people's work. The review is the thread's
//     own files and nothing else, against the last commit ("files").
//   - A file in no checkout of the project (another repository, a scratch folder outside it) has nothing
//     to diff against that this project can name, and is left out.
//
// The checkout written last comes first — the one the editor window is chosen by — and the folder the
// agent is working in is included even with no edit seen there: a worktree whose changes came from a
// shell (`sed -i`, a codemod, `git apply`) is still the thread's work, and the branch review finds it.

export interface ReviewTargetInput {
  /** The project folder (`workDirOf`). */
  projectDir: string
  title: string
  /** The rail's edited files — absolute, the most recent first, already filtered to what git carries. */
  edited: readonly { path: string }[]
  /** Where the thread's agent is working now (router threadWorkingDir). */
  working?: Pick<ThreadWorkingDir, "dir" | "kind">
}

function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

export function reviewTargetOf(input: ReviewTargetInput): EditorReviewTarget {
  const { projectDir } = input
  const checkouts = new Map<string, EditorReviewCheckout>()
  let files = 0
  const add = (dir: string, scope: EditorReviewCheckout["scope"], file?: string) => {
    let checkout = checkouts.get(dir)
    if (!checkout) {
      if (checkouts.size >= EDITOR_REVIEW_MAX_CHECKOUTS) return
      checkout = { dir, scope, files: [] }
      checkouts.set(dir, checkout)
    }
    if (file !== undefined && files < EDITOR_REVIEW_MAX_FILES) {
      checkout.files.push(file)
      files++
    }
  }
  for (const { path: file } of input.edited) {
    const worktree = liftRepoWorktree(path.dirname(file), projectDir)
    if (worktree) add(worktree.dir, "branch", file)
    else if (within(file, projectDir)) add(projectDir, "files", file)
  }
  const working = input.working
  if (working?.kind === "worktree") {
    const worktree = liftRepoWorktree(working.dir, projectDir)
    if (worktree) add(worktree.dir, "branch")
  }
  // A project folder with nothing the thread wrote in it has nothing to show: its scope is the files.
  return { title: input.title, checkouts: [...checkouts.values()].filter((c) => c.scope === "branch" || c.files.length > 0) }
}
