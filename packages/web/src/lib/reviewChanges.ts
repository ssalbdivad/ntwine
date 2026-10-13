import type { EditorKind, EditorWindowSummary } from "@ntwine/shared"
import type { Api } from "../api/contract.ts"
import { embedded, postToHost } from "./embed.ts"
import { runExternalOpen } from "./externalOpen.ts"
import { projectSlug } from "./base-path.ts"
import { store } from "../store.ts"

// REVIEW CHANGES — everything a thread changed, as the editor's multi-file diff against where it started
// (ARCHITECTURE.md § VS Code extension). Claude Code and Cursor show an agent's edits
// as native diffs; a Ntwine worker edits files directly, often in a worktree of its own, so here the
// review is of what is on disk, opened in the editor where the human can fix what they see in place.
//
// WHERE IT IS OFFERED, and why only there. The diff is the EDITOR's (the Ntwine extension's), so the action
// exists only where one can show it:
//   - in the editor's sidebar (embed mode), always: the page names the thread to its host
//     (`ntwine:review`), which asks Ntwine for what it changed and opens the diff in THAT window;
//   - in a browser tab, while an editor window that can review is connected (`reviews` on the window
//     summary — an extension from before the feature never says it can): Ntwine pushes the review to the
//     window that has the thread's checkout open, which opens it and comes to the front. The label names
//     that editor, because the click leaves the browser.
// No editor connected, no item: an in-browser diff is a different feature, and an item that could only
// say "connect an editor" is a dead end in a menu.

const EDITOR_NAME: Partial<Record<EditorKind, string>> = { vscode: "VS Code", cursor: "Cursor", windsurf: "Windsurf" }

/** The menu item's label, or null where nothing can show the changes. */
export function reviewLabel(windows: readonly EditorWindowSummary[], inEditor: boolean): string | null {
  if (inEditor) return "Review changes"
  const able = windows.filter((window) => window.reviews && window.acceptsOpens)
  if (able.length === 0) return null
  const kinds = new Set(able.map((window) => window.kind))
  const name = kinds.size === 1 ? EDITOR_NAME[[...kinds][0]!] : undefined
  return `Review changes in ${name ?? "your editor"}`
}

/**
 * Show a thread's changes. `projectId` is the thread's project when the control is scoped to one other
 * than the page's (a card on the cross-project page); the sidebar's host matches it, or the page's slug,
 * against the projects it knows. `title` is the thread's name in words, for the diff's tab.
 */
export function reviewChanges(api: Api, slug: string, title: string, projectId?: string): void {
  if (embedded()) {
    // The address's project (a drawer's is its thread's), else the board's — the launching project is
    // served unprefixed and only its board knows its slug.
    const project = projectId ?? projectSlug() ?? store.board?.projectSlug
    if (project) postToHost({ type: "ntwine:review", thread: slug, project, title })
    return
  }
  void runExternalOpen(`review:${projectId ?? ""}:${slug}`, "Opening the changes…", () => api.reviewInEditor({ slug, title }), () => {}, (message) => message)
}
