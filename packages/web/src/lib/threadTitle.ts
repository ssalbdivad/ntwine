// The server's RenameThreadInput carries the same cap. Kept here too so a pasted title cannot make the
// inline editor appear to accept text the RPC will reject.
export const THREAD_TITLE_MAX_LENGTH = 200

// Resolve an inline-edit draft to a mutation payload. Empty/whitespace and unchanged commits are
// deliberate no-ops: blur/Enter cannot erase a good title, while Escape simply never calls this.
export function threadTitleToCommit(draft: string, current: string): string | undefined {
  const title = draft.trim()
  if (!title || title === current.trim()) return undefined
  return title
}

export function manualThreadTitleSeed(current: string, slug: string): string {
  const title = current.trim()
  return !title || title === slug || title === "Untitled thread" || title === "Spinning up a thread…" ? "" : title
}
