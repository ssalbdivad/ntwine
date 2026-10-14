import { useSyncExternalStore } from "react"
import type { ProjectCard } from "@ntwine/shared"
import { humpStarts } from "./threadMentions.ts"

// `#slug` NAMES A PROJECT (David 2026-10-06: "add # syntax for referring to projects like #home and
// #arktype that autocompletes and is styled similarly to @thread-name"). The sibling of the `@handle`
// grammar (threadMentions.ts): the prompt box offers the projects on this machine as `#` is typed and
// tints a finished one, a human's bubble links it, and agent prose links it the same way
// (mentionAutolink.ts). What lands after `#` is the project's registry slug — the `<slug>` in
// `/project/<slug>`, already kebab-case and unique — so there is nothing to fold: a mention resolves when
// its text IS a slug, case aside.
//
// A bare `#123` stays GitHub's (githubAutolink.ts, plainLinks.ts): an all-digit token is never a project
// mention, even where a project's slug happens to be digits.

export interface ProjectMentionCandidate {
  /** The registry slug — what lands after `#`. */
  slug: string
  /** The project's display name, shown dimmed beside the slug in the menu and as a link's tooltip. */
  name: string
}

/** The projects a `#` can name, in the project list's own order (the switcher's): every registered
 *  project whose directory still exists. */
export function projectMentionCandidates(cards: readonly ProjectCard[] | null | undefined): ProjectMentionCandidate[] {
  return (cards ?? []).filter((card) => !card.stale).map((card) => ({ slug: card.slug, name: card.name }))
}

// THE PAGE'S PROJECTS, as module state. Every surface that draws a `#` — the prompt box, a human's
// bubble, the markdown pipeline (which renders synchronously, far from any React tree) — reads this one
// list, set from the `projectsList` query by initProjectMentions (main.tsx). A prompt box therefore needs
// no query client of its own, which a fixture page or the editor's sidebar may not have.
let projects: readonly ProjectMentionCandidate[] = []
let projectsKey = ""
const listeners = new Set<() => void>()

/** Point every `#` surface at this machine's projects. Notifies only when a slug or name changes. */
export function setProjectMentions(cards: readonly ProjectCard[] | null | undefined): void {
  const next = projectMentionCandidates(cards)
  const key = next.map((p) => `${p.slug}\u0000${p.name}`).join("\u0001")
  if (key === projectsKey) return
  projectsKey = key
  projects = next
  for (const listener of listeners) listener()
}

export function projectMentionIndex(): readonly ProjectMentionCandidate[] {
  return projects
}

export function subscribeProjectMentions(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The projects a `#` can name, re-rendering when one is added, removed or renamed. */
export function useProjectMentions(): readonly ProjectMentionCandidate[] {
  return useSyncExternalStore(subscribeProjectMentions, projectMentionIndex, projectMentionIndex)
}

// What may sit right before the `#`: a mention starts at a word boundary, and never after another `#`
// (a markdown heading's `##`), an `&` (an HTML entity, `&#39;`), a `/` (a URL fragment) or a `.`.
const SLUG_CHAR = /[\p{L}\p{N}_-]/u
const QUERY_BEFORE_CARET = /(?:^|[^\p{L}\p{N}_#&/.])#((?:[\p{L}\p{N}_][\p{L}\p{N}_-]*)?)$/u

/** The project mention being typed at the caret: where its `#` sits and what follows it so far. */
export function projectQueryAt(prose: string, caret: number | null): { start: number; query: string } | undefined {
  if (caret === null || caret > prose.length) return undefined
  const m = QUERY_BEFORE_CARET.exec(prose.slice(0, caret))
  if (!m) return undefined
  return { start: caret - m[1]!.length - 1, query: m[1]! }
}

function isSubsequence(query: string, text: string): boolean {
  let i = 0
  for (const c of text) if (c === query[i]) i++
  return i === query.length
}

/** Rank projects for what was typed after `#` — the `@` menu's ranking (threadMentions.ts matchMentions)
 *  over the slug, then the same over the display name: a prefix, a prefix of any word, anywhere inside,
 *  letters in order. An empty query offers every project; an all-digit one offers none, since `#12` is a
 *  GitHub reference being typed. */
export function matchProjects(candidates: readonly ProjectMentionCandidate[], query: string, limit = 50): ProjectMentionCandidate[] {
  if (/^\d+$/u.test(query)) return []
  const squeeze = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")
  const q = squeeze(query)
  if (!q) return candidates.slice(0, limit)
  const ranked: ProjectMentionCandidate[][] = [[], [], [], [], []]
  for (const c of candidates) {
    const slug = squeeze(c.slug)
    if (slug.startsWith(q)) ranked[0]!.push(c)
    else if (humpStarts(c.slug).some((i) => squeeze(c.slug.slice(i)).startsWith(q))) ranked[1]!.push(c)
    else if (slug.includes(q)) ranked[2]!.push(c)
    else if (humpStarts(c.name.replace(/\s+/gu, "-")).some((i) => squeeze(c.name.replace(/\s+/gu, "-").slice(i)).startsWith(q))) ranked[3]!.push(c)
    else if (isSubsequence(q, slug)) ranked[4]!.push(c)
  }
  return ranked.flat().slice(0, limit)
}

/** Complete the mention at `start` to `#slug`, replacing what was typed of it (including any part of the
 *  token after the caret) and leaving the caret after one separating space. */
export function insertProjectMention(prose: string, start: number, caret: number, slug: string): { prose: string; caret: number } {
  let end = caret
  while (end < prose.length && SLUG_CHAR.test(prose[end]!)) end++
  const after = prose.slice(end)
  const sep = /^\s/.test(after) ? "" : " "
  return { prose: `${prose.slice(0, start)}#${slug}${sep}${after}`, caret: start + 1 + slug.length + 1 }
}

// A LEADING `#slug` IS AN ADDRESS, NOT A MENTION (David 2026-10-14). In a new-thread box, a prompt that
// OPENS with a project's `#slug` and a space goes to that project: the box re-aims at it and the token
// leaves the text, the way a picked project leaves nothing in the prose. Anywhere later in the prompt a
// `#slug` stays a reference ("do it the way #arktype does"). The `@` grammar was passed over for this:
// `@` already names threads and files, and both of those only point.
const LEADING = /^\s*#([\p{L}\p{N}]+(?:[-_][\p{L}\p{N}]+)*)\s/u

/** The project a prompt opens with — `#slug` then whitespace — and the prompt without it, or undefined
 *  when it opens with anything else (an all-digit `#12` is GitHub's). */
export function leadingProjectRoute(prose: string, candidates: readonly ProjectMentionCandidate[]): { slug: string; rest: string } | undefined {
  const m = LEADING.exec(prose)
  if (!m || /^\d+$/u.test(m[1]!)) return undefined
  const lower = m[1]!.toLowerCase()
  const hit = candidates.find((c) => c.slug.toLowerCase() === lower)
  return hit && { slug: hit.slug, rest: prose.slice(m[0].length).replace(/^[ \t]+/u, "") }
}

// A whole mention in finished text. The tail guard is the `@` grammar's (threadMentions.ts MENTION): a
// token running on into a path, another `#` or a word joint followed by more word is not a slug, and
// without the guard the engine would back off a letter at a time until something matched.
const MENTION = /(^|[^\p{L}\p{N}_#&/.])(#([\p{L}\p{N}]+(?:[-_][\p{L}\p{N}]+)*))(?![\p{L}\p{N}_/#]|[-_.][\p{L}\p{N}])/gu

/** One `#slug` found in plain text that names a project: where it sits, its text with the `#`, and the
 *  project it names. */
export type ProjectMentionMatch = { start: number; text: string; slug: string; name: string }

/** Every `#slug` in `text` that names one of `candidates`; the rest are not mentions and are skipped. */
export function scanProjectMentions(text: string, candidates: readonly ProjectMentionCandidate[]): ProjectMentionMatch[] {
  if (candidates.length === 0 || !text.includes("#")) return []
  const out: ProjectMentionMatch[] = []
  for (const m of text.matchAll(MENTION)) {
    const written = m[3]!
    if (/^\d+$/u.test(written)) continue
    const lower = written.toLowerCase()
    const hit = candidates.find((c) => c.slug.toLowerCase() === lower)
    if (!hit) continue
    out.push({ start: m.index! + m[1]!.length, text: m[2]!, slug: hit.slug, name: hit.name })
  }
  return out
}
