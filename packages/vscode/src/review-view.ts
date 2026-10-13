// REVIEW CHANGES, IN THE EDITOR — a thread's changes as VS Code's multi-file diff (`vscode.changes`, the
// editor Source Control opens for "View changes"), the glue half: review.ts asks git, this shows it.
// Design: ARCHITECTURE.md § VS Code extension.
//
// Claude Code and Cursor show an agent's edits as diffs in the editor. A Ntwine worker edits files directly,
// usually in a worktree of its own, so here the review is of what is on disk: the LEFT side is the file
// as the base commit had it, served by a content provider (`ntwine-base:`, read-only); the RIGHT side is
// the real file, so the human can fix what they see in place, with the language server running. Each
// checkout's base is its own (a worktree's fork point; the project folder's HEAD), and one review can
// span both when a thread wrote in both.
//
// Only `import type` from vscode, like app.ts.

import path from "node:path"
import type * as vscode from "vscode"
import type { EditorReviewTarget } from "@ntwine/shared/editor-protocol"
import { BASE_SCHEME, baseQuery, baseText, nothingToReview, parseBaseQuery, reviewCheckout, type CheckoutReview } from "./review.ts"

type Vscode = typeof vscode

/** The last review this window opened, for the end-to-end suite: what the diff editor was handed. */
export interface ReviewSnapshot {
  title: string
  /** `[label, base side, file]` as URI strings; a side is absent for an added or a deleted file. */
  resources: { label: string; original?: string; modified?: string }[]
  checkouts: { top: string; base: string; baseNote: string; binary: string[]; more: number }[]
}

export interface Reviews {
  /** Open the target's changes; the answer a `review` frame takes, `error` in words a toast can show. */
  open(target: EditorReviewTarget): Promise<{ ok: boolean; error?: string }>
  last(): ReviewSnapshot | undefined
}

export function registerReviews(api: Vscode, context: vscode.ExtensionContext, log: { info(line: string): void; warn(line: string): void }): Reviews {
  let last: ReviewSnapshot | undefined

  context.subscriptions.push(api.workspace.registerTextDocumentContentProvider(BASE_SCHEME, {
    async provideTextDocumentContent(uri) {
      const ref = parseBaseQuery(uri.query)
      if (!ref) return ""
      try {
        return await baseText(ref.top, ref.base, ref.basePath)
      } catch (error) {
        log.warn(`Couldn't read ${ref.basePath} at ${ref.base.slice(0, 7)}: ${(error as Error).message.split("\n")[0]}`)
        return ""
      }
    },
  }))

  async function open(target: EditorReviewTarget): Promise<{ ok: boolean; error?: string }> {
    if (target.checkouts.length === 0) return { ok: false, error: "This thread hasn't changed any files yet." }
    const reviews: CheckoutReview[] = []
    const errors: string[] = []
    for (const checkout of target.checkouts) {
      const result = await reviewCheckout(checkout)
      if ("error" in result) {
        errors.push(result.error)
        log.warn(`Reviewing ${target.title}: ${result.error}`)
      } else reviews.push(result)
    }
    const resources: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][] = []
    for (const review of reviews) {
      for (const entry of review.entries) {
        const file = api.Uri.file(entry.path)
        const original = entry.basePath === undefined
          ? undefined
          : api.Uri.file(path.join(review.top, ...entry.basePath.split("/"))).with({ scheme: BASE_SCHEME, query: baseQuery({ top: review.top, base: review.base, basePath: entry.basePath }) })
        resources.push([file, original, entry.status === "deleted" ? undefined : file])
      }
      const left = [
        review.binary.length ? `${review.binary.length} binary left out` : "",
        review.more ? `${review.more} more past the first ${review.entries.length}` : "",
      ].filter(Boolean).join(", ")
      log.info(`Reviewing ${target.title}: ${review.entries.length} file${review.entries.length === 1 ? "" : "s"} in ${review.top} against ${review.base.slice(0, 7)}, ${review.baseNote}${left ? ` (${left})` : ""}.`)
    }
    if (resources.length === 0) return { ok: false, error: errors[0] ?? nothingToReview(reviews) }
    const title = `Changes in ${target.title}`
    await api.commands.executeCommand("vscode.changes", title, resources)
    last = {
      title,
      resources: resources.map(([label, original, modified]) => ({ label: label.toString(), ...(original ? { original: original.toString() } : {}), ...(modified ? { modified: modified.toString() } : {}) })),
      checkouts: reviews.map(({ top, base, baseNote, binary, more }) => ({ top, base, baseNote, binary, more })),
    }
    return { ok: true }
  }

  return { open, last: () => last }
}
