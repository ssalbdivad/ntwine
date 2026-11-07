import { type } from "./ark.ts"

// One identifier contract for every thread-bearing boundary. Keeping this deliberately narrower
// than a filesystem basename also makes the value safe as a process identity string, an environment
// value, and a literal path segment without relying on shell escaping or platform-specific filename
// rules.
export const THREAD_SLUG_MAX_CHARS = 200
export const ThreadSlug = type(`1 <= string <= ${THREAD_SLUG_MAX_CHARS} & /^[a-z0-9][a-z0-9-]*$/`)
export type ThreadSlug = typeof ThreadSlug.infer

// title -> slug matching the id regex above. Non-alnum collapses to a single '-'; leading/trailing
// '-' trimmed; empty falls back to "thread". Lives beside the contract it produces so both the
// dispatcher (which mints slugs from titles) and the registry (which recognises a slug a title
// produced) read the same rule — a second copy of this normalisation would drift.
export function slugify(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  // Leave no partial trailing separator after the cap. The dispatcher's collision suffixer preserves
  // this same bound when it appends -2, -3, … to a maximum-length base.
  return s.slice(0, THREAD_SLUG_MAX_CHARS).replace(/-+$/g, "") || "thread"
}
