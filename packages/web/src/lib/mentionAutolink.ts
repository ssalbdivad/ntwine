import type { Token, Tokens } from "marked"
import type { ProjectQueue, ThreadView } from "@ntwine/shared"
import { crossProjectHref } from "./base-path.ts"
import { childArrays } from "./githubAutolink.ts"
import { crossProjectMentionCandidates, mentionCandidates, scanMentions, type MentionCandidate } from "./threadMentions.ts"
import { projectMentionIndex, scanProjectMentions, subscribeProjectMentions } from "./projectMentions.ts"
import { projectViewHref } from "./pageView.ts"

// `@handle` AND `@thread.child` IN AGENT PROSE ARE LINKS (David 2026-09-30: "ensure that in cases
// where agents refer to each other, it doesn't refer to 'another agent' but refers to the fully
// qualified name so you can easily click to view that agent"). The worker is prompted to write the
// address; this is what makes it a click. A human's bubble already did it (MentionLinks.tsx); every
// surface that renders AGENT markdown — the transcript's assistant turns, a queue card's handoff, the
// done and awaiting cards — goes through lib/markdown.ts instead, so the same resolution runs here as a
// token pass beside the GitHub autolinker, with the same reasons for being one (githubAutolink.ts):
// code spans and blocks are literal by construction, and an existing link is never descended into.
//
// A mention links only when its THREAD resolves against the page's board, by the same fold a human's
// mention uses (threadMentions.ts resolveMention) — so `@types/node`, a decorator, an email address
// and a handle nobody has stay exactly what they were. A plain `@thread` becomes an in-app
// `/thread/<slug>` link, which the one delegated listener already opens in the drawer
// (lib/thread-links.ts); a dotted one carries its address in the fragment, `/thread/<slug>#<address>`,
// and the same listener resolves it against the thread's sub-agent directory. A modified click follows
// the href to the thread itself, as it does for a human's mention.

// The page's handles, and the project they belong to. Module state for the reason the GitHub repo is
// (githubAutolink.ts `repo`): a dozen memoizing call sites, one project per page, and the board is the
// source — set from its own door (store.ts setBoard/seedBoard), notified so memoized HTML rebuilds.
let project: string | null = null
let board: readonly MentionCandidate[] = []
let boardKey = ""
// Showing All projects, every open project's threads too (setCrossProjectMentions), so a mention of
// another project's thread links to it there — each tagged with its project, and a handle the page's
// own board carries still meaning the page's thread (threadMentions.ts crossProjectMentionCandidates).
let queues: readonly ProjectQueue[] | null = null
let queuesKey = ""
// What a render resolves against: the page's own prose's index, or — under withMentionProject — a card's.
let index: readonly MentionCandidate[] = []
let version = 0
const listeners = new Set<() => void>()

function handlesKey(candidates: readonly MentionCandidate[]): string {
  return candidates.map((c) => `${c.slug}\u0000${c.handle}`).join("\u0001")
}

function rebuild(): void {
  index = queues ? [...board, ...crossProjectMentionCandidates(queues, project ?? undefined, board)] : board
  version++
  for (const listener of listeners) listener()
}

/**
 * Point the mention linker at this page's board. Called on every board push, so it notifies only when
 * a handle is added, removed or renamed (or the project changes) — never on the status and timestamp
 * churn a push mostly carries, which would re-render every prose block on screen many times a minute.
 * Done threads are all kept, not the typeahead's recent twenty: prose resolves what was already written.
 */
export function setMentionIndex(projectSlug: string | null | undefined, threads: readonly ThreadView[] | null | undefined): void {
  const next = threads ? mentionCandidates(threads, undefined, Number.POSITIVE_INFINITY) : []
  const key = `${projectSlug ?? ""}\u0002${handlesKey(next)}`
  project = projectSlug ?? null
  board = next
  if (key === boardKey) {
    // Same handles: keep what renders resolving against the fresh rows without a rebuild everywhere.
    if (!queues) index = next
    return
  }
  boardKey = key
  rebuild()
}

/**
 * Every open project's threads, while the page shows All projects (the page's own poll, AllQueues.tsx);
 * null on a project's own page, where a mention means that project's threads alone. Notifies only when a
 * handle anywhere is added, removed or renamed, for the reason setMentionIndex does.
 */
export function setCrossProjectMentions(next: readonly ProjectQueue[] | null | undefined): void {
  const key = next ? next.map((q) => `${q.projectSlug}\u0002${handlesKey(mentionCandidates(q.threads))}`).join("\u0003") : ""
  queues = next ?? null
  if (key === queuesKey) return
  queuesKey = key
  rebuild()
}

// `#slug` names a PROJECT (lib/projectMentions.ts), and links to the page focused on it in every project's
// prose alike — the machine's projects are no one project's. Their list arriving or changing is one more
// reason to rebuild what renders.
subscribeProjectMentions(() => {
  version++
  for (const listener of listeners) listener()
})

/** A scalar that moves whenever the index does — the `getSnapshot` half of the subscription. */
export function mentionIndexVersion(): number {
  return version
}

export function subscribeMentionIndex(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Run a SYNCHRONOUS render for prose of the project `projectSlug`: with the page's index when that is
 * the page's project, and with none at all otherwise — the All queues page draws every project's cards
 * on a page bound to one, and a `@fix-auth` in project B's handoff must not open project A's `fix-auth`.
 * Absent means the page's own prose. Marked parses synchronously, so the override cannot leak.
 */
export function withMentionProject<T>(projectSlug: string | undefined, run: () => T): T {
  if (projectSlug === undefined || projectSlug === project) return run()
  const previous = index
  index = cardIndex(projectSlug)
  try {
    return run()
  } finally {
    index = previous
  }
}

/** Another project's card's index, showing All projects: its own open threads first, then every other
 *  project's, ALL tagged with their project — none of them is the page's board, whose bare `/thread/`
 *  link would open the page project's same-slug thread. Nothing when the page is not showing them all. */
const cardIndexes = new Map<string, { version: number; candidates: readonly MentionCandidate[] }>()
function cardIndex(projectSlug: string): readonly MentionCandidate[] {
  const own = queues?.find((q) => q.projectSlug === projectSlug)
  if (!queues || !own) return []
  const cached = cardIndexes.get(projectSlug)
  if (cached?.version === version) return cached.candidates
  const tagged = mentionCandidates(own.threads).map((c) => ({ ...c, project: { slug: own.projectSlug, name: own.projectName } }))
  const candidates = [...tagged, ...crossProjectMentionCandidates(queues, projectSlug, tagged)]
  cardIndexes.set(projectSlug, { version, candidates })
  return candidates
}

/** The in-app destination a mention links to: its thread, and for a dotted one the address after `#`.
 *  A thread of another project links to it there (`/all/<project>/thread/…`), which lib/thread-links.ts
 *  opens in place. */
export function mentionHref(slug: string, address?: string, projectSlug?: string): string {
  const path = address ? `/thread/${slug}#${address}` : `/thread/${slug}`
  return projectSlug ? `${crossProjectHref(encodeURIComponent(projectSlug))}${path}` : path
}

function textToken(text: string): Tokens.Text {
  return { type: "text", raw: text, text }
}

function linkToken(text: string, href: string, title: string): Tokens.Link {
  return { type: "link", raw: text, href, title, text, tokens: [textToken(text)] }
}

function splitMentions(source: string): Token[] | null {
  // Threads and projects in one pass, by position: the two grammars never overlap (a project mention
  // never follows a word character, and `@` is one neither starts with `#`).
  const matches = [
    ...scanMentions(source, index).map(({ start, text, slug, address, project: projectSlug }) => ({
      start, text, href: mentionHref(slug, address, projectSlug), title: address ? "Open sub-agent" : "Open thread",
    })),
    ...scanProjectMentions(source, projectMentionIndex()).map(({ start, text, slug, name }) => ({ start, text, href: projectViewHref(slug), title: name })),
  ].sort((a, b) => a.start - b.start)
  if (matches.length === 0) return null
  const pieces: Token[] = []
  let consumed = 0
  for (const { start, text, href, title } of matches) {
    if (start > consumed) pieces.push(textToken(source.slice(consumed, start)))
    pieces.push(linkToken(text, href, title))
    consumed = start + text.length
  }
  if (consumed < source.length) pieces.push(textToken(source.slice(consumed)))
  return pieces
}

// The GitHub pass's opaque set: the author's literal bytes, or already an anchor.
const OPAQUE = new Set(["code", "codespan", "html", "link", "image"])
// Raw inline HTML arrives as SEPARATE tokens around the text they wrap (`<a href="…">`, text, `</a>`), so
// an author's hand-written anchor is not one opaque token — it is tracked open and shut across siblings.
const HTML_ANCHOR_OPEN = /^<a[\s>]/i
const HTML_ANCHOR_CLOSE = /^<\/a\s*>/i

/** Rewrite every plain-text token in the tree whose mentions resolve into text + link tokens. Mutates
 *  in place; walks forwards and skips what it splices in. A no-op while the index is empty. */
export function linkifyThreadMentions(tokens: Token[]): void {
  if (index.length === 0 && projectMentionIndex().length === 0) return
  let inAnchor = false
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.type === "html") {
      const raw = (token as Tokens.HTML).raw
      if (HTML_ANCHOR_OPEN.test(raw)) inAnchor = true
      else if (HTML_ANCHOR_CLOSE.test(raw)) inAnchor = false
      continue
    }
    if (inAnchor || OPAQUE.has(token.type)) continue
    const children = childArrays(token)
    for (const array of children) linkifyThreadMentions(array)
    if (token.type !== "text" || children.length > 0) continue
    const pieces = splitMentions((token as Tokens.Text).text)
    if (!pieces) continue
    tokens.splice(i, 1, ...pieces)
    i += pieces.length - 1
  }
}
