import { useEffect, useMemo } from "react"
import { proxy, subscribe, useSnapshot } from "valtio"
import { contextSourceLabel, hasToken, type ComposerContextItem } from "./composerContext.ts"
import { draftStore } from "./drafts.ts"
import { splitComposerValue } from "./imagePaths.ts"

// SELECTED CONTEXT staged for a prompt box's next message: a selection sent from an editor window
// (lib/editorCompose.ts). Each item is the
// quote its `@` token stands for — the token sits in the draft prose, the item here — and on send the
// items serialize under the prose (composerContext.ts buildMessageWithContext). Every box that shows a
// draft paints its tokens as chips: a thread's reply box in the drawer and on the queue card, and the
// new-thread box.
//
// KEYED BY THE DRAFT KEY (lib/drafts.ts), not by the thread's slug, which is what it was keyed by until
// 2026-10-01. Staging belongs to exactly one draft — the one its token is typed into — and a draft key
// already says whose: a project's new-thread box, or one session of one thread in one project. A bare
// slug said neither, and slugs are unique only within a project, so the store had to forget every
// staged item on each project switch (resetProjectState) — which would also have forgotten the item an
// editor insert had just staged for the project the page was switching TO.
//
// PERSISTED BESIDE THE DRAFT, in this tab's sessionStorage, for the same reason the draft is. The token
// survives a reload in the draft; an item that did not would leave the token as bare text, and the send
// would carry `@a.ts:12-20` with no definition behind it — a reference the agent cannot resolve, typed
// by nobody. Memory-only was tolerable while every item was a ⌘I quote the human could re-make in two
// keystrokes; an editor selection cannot be re-made from the page at all.

export const STAGED_CONTEXT_STORAGE_KEY = "ntwine-staged-context:v1"
// Bounded like the drafts (lib/drafts.ts): a quote can be 64 KiB (EDITOR_COMPOSE_MAX_TEXT), and the
// tab's whole sessionStorage is ~5 MB, two of which the drafts may hold.
const MAX_SNAPSHOT_BYTES = 1024 * 1024

type Staged = Record<string, ComposerContextItem[]>

function isItem(value: unknown): value is ComposerContextItem {
  const item = value as Partial<ComposerContextItem> | null
  return !!item && typeof item === "object"
    && typeof item.id === "number" && typeof item.token === "string" && typeof item.path === "string" && typeof item.text === "string"
    && (item.startLine === undefined || typeof item.startLine === "number")
    && (item.endLine === undefined || typeof item.endLine === "number")
}

/**
 * The staged items stored for this tab, kept only where they can still mean something: an item whose
 * token is no longer in its draft's prose (the send went through, the token was deleted, the draft was
 * cleared) is the same garbage the live sweep (useStagedContextTokens) would drop.
 */
export function parseStagedContext(raw: string | null, draftValue: (key: string) => string): Staged {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  const staged: Staged = {}
  for (const [key, items] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(items)) continue
    const { prose } = splitComposerValue(draftValue(key))
    const kept = items.filter(isItem).filter((item) => hasToken(prose, item.token))
    if (kept.length) staged[key] = kept
  }
  return staged
}

/**
 * The snapshot sessionStorage holds — whole drafts' worth, newest draft first, dropped whole past the cap.
 *
 * `touchedAt` is the draft store's own clock for a key (lib/drafts.ts), undefined when there is no such
 * draft. Two rules, both the drafts' own `bounded`: a key with no draft behind it is not written at all
 * (its token has nowhere to sit, so parseStagedContext would drop it on load anyway), and past the cap
 * the OLDEST drafts go first. Insertion order was the order until review C10 — and a newly staged draft
 * is appended last, so once older quotes filled the cap, the selection just sent to the box in front of
 * the human was the one left out, and after a reload it went out as a bare `@a.ts:12-20`.
 */
export function serializeStagedContext(staged: Staged, touchedAt: (key: string) => number | undefined): string {
  const live = Object.entries(staged)
    .flatMap(([key, items]) => {
      const at = touchedAt(key)
      return items.length && at !== undefined ? [{ key, items, at }] : []
    })
    .sort((a, b) => b.at - a.at)
  const kept: Staged = {}
  for (const { key, items } of live) {
    kept[key] = items
    if (JSON.stringify(kept).length > MAX_SNAPSHOT_BYTES) delete kept[key]
  }
  return JSON.stringify(kept)
}

function load(): Staged {
  if (typeof sessionStorage === "undefined") return {}
  try {
    return parseStagedContext(sessionStorage.getItem(STAGED_CONTEXT_STORAGE_KEY), (key) => draftStore.get(key))
  } catch {
    return {}
  }
}

export const stagedContext = proxy<Staged>(load())

let contextSeq = Math.max(0, ...Object.values(stagedContext).flat().map((item) => item.id))

if (typeof sessionStorage !== "undefined") {
  subscribe(stagedContext, () => {
    try {
      sessionStorage.setItem(STAGED_CONTEXT_STORAGE_KEY, serializeStagedContext(stagedContext, (key) => draftStore.getSnapshot().entries[key]?.touchedAt))
    } catch {
      // Quota or disabled storage: the items stay in this page's memory, as they always did.
    }
  })
}

/** The items staged for one draft, as plain data (for `uniqueToken`). */
export function stagedItems(key: string): readonly ComposerContextItem[] {
  return stagedContext[key] ?? []
}

export function addContextItem(key: string, item: Omit<ComposerContextItem, "id">): void {
  const items = stagedContext[key] ?? (stagedContext[key] = [])
  items.push({ ...item, id: ++contextSeq })
}

// There is no remove-by-id: an item leaves the roster when its `@` token leaves the draft prose
// (useStagedContextTokens' sweep) — the token in the text is the only handle the human has on it.

// Take (and clear) a draft's staged items at send time. Returns plain copies so the caller can restore
// them on a rejected send — the proxy entries themselves are gone by then.
export function takeContextItems(key: string): ComposerContextItem[] {
  const items = (stagedContext[key] ?? []).map((item) => ({ ...item }))
  delete stagedContext[key]
  return items
}

export function restoreContextItems(key: string, items: ComposerContextItem[]): void {
  if (!items.length) return
  // Never clobber items staged while the failed send was in flight — put the old ones first.
  stagedContext[key] = [...items, ...(stagedContext[key] ?? [])]
}

/**
 * Move a draft to another key WITH what its tokens stand for — the new-thread box re-aimed at another
 * project (AllQueues, through `carryDispatchDraft`). Only into an empty draft, so one already waiting there
 * is never overwritten; a no-op when there is nothing to move. Text first, then the items, the order an
 * insert uses: a mounted box sweeps any staged item whose token its draft lacks. Moving the text alone left
 * the chips filed under the old project (review C5): the new box showed `@a.ts:12-20` as bare text,
 * the dispatch went out with no definition behind it, and the next reload's load dropped the orphans.
 *
 * `siblings`: `[from, to]` keys whose values belong to this text and travel with it — what the human said
 * about its schedule (lib/scheduleDraftState.ts). Each lands in the SAME commit as the text, replacing whatever
 * the target key held (a value of "" clears it), and leaves in the same commit as the text leaves.
 */
export function carryDraft(from: string, to: string, siblings: readonly (readonly [string, string])[] = []): void {
  if (from === to) return
  const text = draftStore.get(from)
  if (!text || draftStore.get(to)) return
  draftStore.setMany({ [to]: text, ...Object.fromEntries(siblings.map(([f, t]) => [t, draftStore.get(f)])) })
  restoreContextItems(to, takeContextItems(from))
  draftStore.clearMany([from, ...siblings.map(([f]) => f)])
}

/**
 * The tokens a box paints as chips (Composer `contextTokens`), and THE SWEEP: whenever the draft or the
 * roster changes, any staged item whose token no longer appears in the prose is dropped — so
 * backspacing a reference out of the text retires its chip, exactly as the chip's × strips the
 * reference out of the text. Terminates: the write only fires when something is actually dropped.
 */
export function useStagedContextTokens(key: string, value: string): string[] {
  const staged = useSnapshot(stagedContext)[key]
  const tokens = useMemo(() => staged?.map((item) => item.token) ?? [], [staged])
  useEffect(() => {
    const items = stagedContext[key]
    if (!items?.length) return
    const { prose } = splitComposerValue(value)
    const kept = items.filter((item) => hasToken(prose, item.token))
    if (kept.length === items.length) return
    if (kept.length) stagedContext[key] = kept
    else delete stagedContext[key]
  }, [key, value, staged])
  return tokens
}

/**
 * Where each staged chip came from, by token — the hover a box shows over a chip (Composer
 * `contextSources`): `src/a.ts, lines 12-20`, the same words its definition will carry.
 */
export function useStagedContextSources(key: string, projectDir: string | undefined): Readonly<Record<string, string>> {
  const staged = useSnapshot(stagedContext)[key]
  return useMemo(() => Object.fromEntries((staged ?? []).map((item) => [item.token, contextSourceLabel(item, projectDir)])), [staged, projectDir])
}
