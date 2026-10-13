import type { GithubRefCard } from "@ntwine/shared"
import { rpc } from "../api/rpc.ts"

// The client half of the GitHub hovercards: one store holding every reference the page has rendered,
// filled by ONE batched request per render burst, read synchronously when a pointer lands on a link.
//
// WHY A MODULE STORE AND NOT useQuery PER ANCHOR. A transcript routinely carries dozens of `#123`
// anchors and the same number appears again and again down one thread. Per-anchor queries would mean
// one request per anchor, a fetch beginning at hover (~300-800ms of GitHub round trip, longer than a
// pointer rests), and a re-request every time virtualization remounts the row. Collecting refs as the
// prose renders instead means the data is already here before anyone points at anything: the hover is
// a Map lookup. It mirrors githubAutolink.ts's own module-scalar-plus-subscription shape, for the same
// reason — this is page-level state that every prose block feeds and any anchor may read.
//
// FRESHNESS is stale-while-revalidate, and the card on screen is never the thing waiting. An entry is
// rendered immediately however old it is; if it is older than CARD_TTL_MS the hover ALSO sends a
// `refresh` for that one ref, and the card updates underneath the reader if the issue moved. The
// server holds its own five-minute TTL, so an ordinary scroll re-uses its cache and only a reader
// genuinely looking at a stale card pays for a fetch.

/** How old a card may be before pointing at it also revalidates it. */
const CARD_TTL_MS = 60_000

// The window refs collect in before a batch goes out. Long enough that a screenful of prose blocks —
// which mount across several React commits as the transcript hydrates and virtualization fills in —
// lands in ONE request; short enough that the data beats the reader to the first hover.
const BATCH_DELAY_MS = 80

// The server caps a request at 100 refs. Anything past that in one window is simply sent as a second
// request rather than dropped — a long transcript legitimately has more.
const MAX_REFS_PER_REQUEST = 100

export interface GithubCardEntry {
  /** The card, once it has arrived. */
  card?: GithubRefCard
  /** The reference resolves to nothing on GitHub — a wrong number, or a repo this token cannot see. */
  missing?: true
  /** A batch carrying this ref is on the wire. */
  loading?: boolean
}

const LOADING: GithubCardEntry = { loading: true }

const entries = new Map<string, GithubCardEntry>()
const listeners = new Set<() => void>()
const pending = new Set<string>()
let flushTimer: ReturnType<typeof setTimeout> | undefined

function notify(): void {
  for (const listener of listeners) listener()
}

export function subscribeGithubCards(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * What is known about one reference right now — a stable object per ref, so a component subscribed
 * through `useSyncExternalStore` only re-renders when this ref's own state actually changed.
 */
export function githubCardEntry(ref: string): GithubCardEntry | undefined {
  return entries.get(ref)
}

/** Whether a card is old enough that pointing at it should also revalidate it. */
export function isGithubCardStale(entry: GithubCardEntry | undefined, now = Date.now()): boolean {
  // A commit is immutable; nothing about it can have moved, so it is never worth re-asking.
  if (!entry?.card || entry.card.kind === "commit") return false
  return now - entry.card.fetchedAt > CARD_TTL_MS
}

// Every `data-gh-ref` the sanitizer stamped on this HTML (see lib/markdown.ts). Scanning the STRING
// rather than the DOM keeps this callable from the render hook that already owns the string, before
// anything is mounted — so the batch is on the wire while React is still committing the prose.
const REF_ATTR = /data-gh-ref="([^"]+)"/g

export function githubRefsInHtml(html: string): string[] {
  if (!html.includes("data-gh-ref")) return []
  const refs = new Set<string>()
  for (const match of html.matchAll(REF_ATTR)) refs.add(match[1])
  return [...refs]
}

/**
 * Register the references one rendered prose block contains. Cheap and idempotent: anything already
 * known or already queued is dropped here, so re-rendering the same message costs nothing.
 */
export function noteGithubRefs(refs: readonly string[]): void {
  let added = false
  for (const ref of refs) {
    if (entries.has(ref) || pending.has(ref)) continue
    pending.add(ref)
    added = true
  }
  if (!added || flushTimer !== undefined) return
  flushTimer = setTimeout(() => {
    flushTimer = undefined
    void flush()
  }, BATCH_DELAY_MS)
}

function applyResult(refs: string[], result: { cards: GithubRefCard[]; missing: string[] }): void {
  for (const card of result.cards) entries.set(card.ref, { card })
  for (const ref of result.missing) entries.set(ref, { missing: true })
  // Anything the server neither resolved nor refused (a failed chunk) loses its loading marker, so a
  // later render of the same prose queues it again rather than showing a spinner forever.
  for (const ref of refs) if (entries.get(ref) === LOADING) entries.delete(ref)
  notify()
}

async function flush(): Promise<void> {
  const refs = [...pending].slice(0, MAX_REFS_PER_REQUEST)
  if (refs.length === 0) return
  for (const ref of refs) {
    pending.delete(ref)
    entries.set(ref, LOADING)
  }
  notify()
  try {
    applyResult(refs, await rpc.githubRefPreview({ refs }))
  } catch {
    // A hovercard is decoration. A server without gh, a rate limit, a dropped connection — the anchor
    // stays a plain working link and nothing is surfaced to the reader.
    applyResult(refs, { cards: [], missing: [] })
  }
  // Whatever did not fit in this request goes out immediately behind it.
  if (pending.size > 0 && flushTimer === undefined) {
    flushTimer = setTimeout(() => {
      flushTimer = undefined
      void flush()
    }, 0)
  }
}

const revalidating = new Set<string>()

/**
 * Re-fetch ONE reference because a reader is looking at it and its card is older than the TTL. The
 * cached card stays on screen throughout — this only swaps it when a newer one lands, so a hover
 * never shows a spinner over data it already has.
 */
export function revalidateGithubRef(ref: string): void {
  if (revalidating.has(ref)) return
  revalidating.add(ref)
  void rpc
    .githubRefPreview({ refs: [ref], refresh: true })
    .then((result) => {
      for (const card of result.cards) entries.set(card.ref, { card })
      // A ref that has GONE missing is left alone: the reader is pointing at the card right now, and
      // replacing it mid-hover with "not found" reads as a bug rather than as news.
      notify()
    })
    .catch(() => {})
    .finally(() => revalidating.delete(ref))
}

/**
 * Drop everything. Called on a project switch (store.ts's resetProjectState), alongside the
 * autolinker's own repo reset — a bare `#123` means a different issue under a different project, so
 * a card cached under the old page's repo must not survive into the new one.
 *
 * Keys are fully qualified `owner/repo#N`, so this is belt-and-braces rather than a correctness fix;
 * what it genuinely buys is not carrying one project's transcript history in memory into the next.
 */
export function resetGithubCards(): void {
  entries.clear()
  pending.clear()
  revalidating.clear()
  if (flushTimer !== undefined) {
    clearTimeout(flushTimer)
    flushTimer = undefined
  }
  notify()
}
