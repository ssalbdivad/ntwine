import { useCallback, useMemo, useSyncExternalStore } from "react"
import { useSnapshot } from "valtio"
import { store } from "../store.ts"

// Drafts are deliberately session-scoped: they survive React unmounts and a same-tab reload, but never
// escape this browser tab. Keep this schema tiny and text-only; server records, credentials and secret
// interaction fields must never enter this cache.
export const DRAFT_STORAGE_KEY = "frizz-drafts:v1"
export const DRAFT_SCHEMA_VERSION = 1
const MAX_ENTRIES = 80
const MAX_VALUE_BYTES = 512 * 1024
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
const encoder = new TextEncoder()

export type DraftSnapshot = { version: 1; entries: Record<string, { value: string; touchedAt: number }> }
type Listener = () => void

function bytes(value: string): number { return encoder.encode(value).byteLength }
function empty(): DraftSnapshot { return { version: DRAFT_SCHEMA_VERSION, entries: {} } }
export function parseDraftSnapshot(raw: string | null): DraftSnapshot {
  if (!raw) return empty()
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== DRAFT_SCHEMA_VERSION) return empty()
    const entries = (value as { entries?: unknown }).entries
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) return empty()
    const valid: DraftSnapshot["entries"] = {}
    for (const [key, entry] of Object.entries(entries)) {
      if (typeof entry?.value !== "string" || typeof entry?.touchedAt !== "number" || !Number.isFinite(entry.touchedAt)) continue
      if (key.length > 512 || bytes(entry.value) > MAX_VALUE_BYTES) continue
      valid[key] = { value: entry.value, touchedAt: entry.touchedAt }
    }
    return { version: DRAFT_SCHEMA_VERSION, entries: valid }
  } catch { return empty() }
}

function bounded(snapshot: DraftSnapshot): DraftSnapshot {
  const kept = Object.entries(snapshot.entries)
    .filter(([, entry]) => entry.value && bytes(entry.value) <= MAX_VALUE_BYTES)
    .sort((a, b) => b[1].touchedAt - a[1].touchedAt)
  const entries: DraftSnapshot["entries"] = {}
  for (const [key, entry] of kept) {
    if (Object.keys(entries).length >= MAX_ENTRIES) break
    entries[key] = entry
    if (bytes(JSON.stringify({ version: DRAFT_SCHEMA_VERSION, entries })) > MAX_SNAPSHOT_BYTES) delete entries[key]
  }
  return { version: DRAFT_SCHEMA_VERSION, entries }
}

export class DraftStore {
  // `snapshot` is the current tab's complete controlled-input source of truth. Persistence is a
  // bounded projection of it: quota or a hard persisted-value cap must never blank a textarea that
  // the user is actively editing.
  private snapshot: DraftSnapshot
  private listeners = new Set<Listener>()
  private readonly storage: Pick<Storage, "getItem" | "setItem"> | undefined
  constructor(storage: Pick<Storage, "getItem" | "setItem"> | undefined = typeof sessionStorage === "undefined" ? undefined : sessionStorage) {
    this.storage = storage
    let raw: string | null = null
    try { raw = storage?.getItem(DRAFT_STORAGE_KEY) ?? null } catch {}
    this.snapshot = bounded(parseDraftSnapshot(raw))
  }
  getSnapshot = (): DraftSnapshot => this.snapshot
  subscribe = (listener: Listener) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  get(key: string): string { return this.snapshot.entries[key]?.value ?? "" }
  set(key: string, value: string): void { this.setMany({ [key]: value }) }
  // Several values in ONE commit and so ONE notify ("" deletes, as `set` does): a draft that moves keys with
  // its siblings (lib/stagedContext.ts carryDraft) lands whole, never as text without what was said about it.
  setMany(values: Readonly<Record<string, string>>): void {
    const entries = { ...this.snapshot.entries }
    const now = Date.now()
    for (const [key, value] of Object.entries(values)) {
      if (!value) delete entries[key]
      else entries[key] = { value, touchedAt: now }
    }
    this.commit({ version: DRAFT_SCHEMA_VERSION, entries })
  }
  clear(key: string): void { this.clearMany([key]) }
  // Several keys in ONE commit and so ONE notify. A draft that spans keys (a new thread's prompt, its
  // profile pick and its schedule dismissal, lib/scheduleDraftState.ts) must never be observed
  // half-cleared: a subscriber rendering between two single-key clears saw one draft's text with
  // another's state.
  clearMany(keys: readonly string[]): void {
    if (!keys.some((key) => this.snapshot.entries[key])) return
    const drop = new Set(keys)
    this.commit({ version: DRAFT_SCHEMA_VERSION, entries: Object.fromEntries(Object.entries(this.snapshot.entries).filter(([candidate]) => !drop.has(candidate))) })
  }
  private commit(next: DraftSnapshot): void {
    this.snapshot = next
    // A too-large value remains in this tab's memory and subscribers see it immediately. `bounded`
    // excludes it from the reload snapshot, instead of replacing the controlled input with "".
    try { this.storage?.setItem(DRAFT_STORAGE_KEY, JSON.stringify(bounded(next))) } catch {}
    for (const listener of this.listeners) listener()
  }
}

export const draftStore = new DraftStore()

// Put words back into a draft WITHOUT losing what is already there — the one rule every "give the
// operator their text back" path shares (an unqueued send, a failed send, a failed bubble's Edit).
// The returned text goes ABOVE the existing draft, separated by a blank line: it was written first,
// and whatever is in the box was typed after it. The composer's rollback used to restore only into an
// EMPTY box and silently drop the failed message otherwise.
//
// Already present verbatim → nothing to add (a second rollback of the same send, or an Edit of words
// the rollback already put back).
export function mergeIntoDraft(key: string, text: string): void {
  if (!text) return
  const existing = draftStore.get(key)
  if (existing.includes(text)) return
  draftStore.set(key, existing ? `${text}\n\n${existing}` : text)
}

export function projectDraftScope(projectDir: string | undefined): string {
  return encodeURIComponent(projectDir || "unresolved-project")
}
export const draftKey = {
  dispatch: (projectDir: string | undefined) => `dispatch:${projectDraftScope(projectDir)}:new`,
  // The profile picked for that same prompt (useDraftDispatchPick): `{backend, model, effort}` as JSON,
  // one small non-secret record, kept and cleared with the prompt it belongs to.
  dispatchProfile: (projectDir: string | undefined) => `dispatch-profile:${projectDraftScope(projectDir)}:new`,
  // What the human said about that same prompt's SCHEDULE (lib/scheduleDraftState.ts): `{v, dismissed,
  // undone}` as JSON — "not a schedule", or an Undo — so what Enter does with the draft lives and dies with
  // the draft: across a remount and a same-tab reload, and cleared in the same commit as the prompt
  // (clearDispatchDraft). Absent means nothing dismissed.
  dispatchSchedule: (projectDir: string | undefined) => `dispatch-schedule:${projectDraftScope(projectDir)}:new`,
  // The TIME LIMIT typed for that same prompt (lib/threadDeadline.ts): the human's raw text (`2h`, `15:30`),
  // resolved to an instant only at the Enter that starts the thread. Kept and cleared with the prompt, like
  // the profile pick, and absent means no limit.
  dispatchDeadline: (projectDir: string | undefined) => `dispatch-deadline:${projectDraftScope(projectDir)}:new`,
  // A thread's "Spinoff" dialog (SpinoffDialog) — the instructions for the new thread, one per thread.
  spinoff: (projectDir: string | undefined, slug: string) => `spinoff:${projectDraftScope(projectDir)}:${encodeURIComponent(slug)}`,
  // A finished terminal's next line (TerminalFollowUp) — one per terminal.
  terminalNext: (projectDir: string | undefined, id: string) => `terminal-next:${projectDraftScope(projectDir)}:${encodeURIComponent(id)}`,
  followUp: (projectDir: string | undefined, slug: string, sessionId?: string) => `followup:${projectDraftScope(projectDir)}:${encodeURIComponent(slug)}:${encodeURIComponent(sessionId ?? "unowned")}`,
  adopt: (projectDir: string | undefined, slug: string) => `adopt:${projectDraftScope(projectDir)}:${encodeURIComponent(slug)}`,
  answer: (projectDir: string | undefined, slug: string, sessionId: string | undefined, messageId: string, block: number) => `answer:${projectDraftScope(projectDir)}:${encodeURIComponent(slug)}:${encodeURIComponent(sessionId ?? "unowned")}:${encodeURIComponent(messageId)}:${block}`,
  interaction: (projectDir: string | undefined, projectId: string, slug: string, sessionId: string, epoch: number, id: string, field: string) => `interaction:${projectDraftScope(projectDir)}:${encodeURIComponent(projectId)}:${encodeURIComponent(slug)}:${encodeURIComponent(sessionId)}:${epoch}:${encodeURIComponent(id)}:${encodeURIComponent(field)}`,
  // A REGISTERED question's free-text box. Keyed by the question's own durable id and its node path in
  // the follow-up tree — no session or epoch, because a registered question outlives the session that
  // asked it (that is the whole point of it being a row), and a half-typed answer must survive the
  // worker restarting under it.
  question: (projectDir: string | undefined, slug: string, id: string, path: string) => `question:${projectDraftScope(projectDir)}:${encodeURIComponent(slug)}:${encodeURIComponent(id)}:${encodeURIComponent(path)}`,
  // The same node's chip/toggle half (lib/registeredPicks encodes it, with each option's label as a
  // stale-data guard), keyed as its text is plus a suffix, so a pick staged but not yet sent — a multi's
  // toggles, a branch partly answered — shares its exact scope and survives a navigation, a remount and
  // the reload a dev-server restart forces, as the typed half always has. The encoded path never holds a `:`.
  questionPick: (projectDir: string | undefined, slug: string, id: string, path: string) => `${draftKey.question(projectDir, slug, id, path)}:picks`,
  // There is no `settings:` key: the Settings drawer autosaves, so the server IS its draft store. A
  // sessionStorage mirror could only ever hold the ~500ms of typing the debounce has not written yet,
  // and it outlived the save — a stale entry that reappeared over the stored value on the next open.
}

export function useProjectDir(): string | undefined { return useSnapshot(store).board?.projectDir }
export function useThreadSessionId(slug: string): string | undefined {
  return useSnapshot(store).board?.threads.find((thread) => thread.id === slug)?.sessionId
}
// SUBSCRIBE TO THE VALUE, NEVER TO THE SNAPSHOT OBJECT. `commit` replaces `this.snapshot` wholesale on
// every keystroke, so a hook whose `getSnapshot` returns that object re-renders on EVERY edit to ANY
// draft anywhere in the app — and `useLiveAnswering` called `useDraftValues` from TodosView (the project
// board, until 2026-09-28), near the top of the board tree, so one keystroke in the composer re-rendered
// the entire board: every queue card,
// every Radix tooltip/popover/menu under it. Measured before this change: 1096 React renders and 47ms of
// render work for ONE character typed into the composer.
//
// `useSyncExternalStore` bails out when `getSnapshot` returns an Object.is-equal value, so returning the
// key's own STRING makes an unrelated field's edit a genuine no-op instead of an app-wide render.
export function useDraft(key: string): readonly [string, (value: string) => void, () => void] {
  const read = useCallback(() => draftStore.get(key), [key])
  const value = useSyncExternalStore(draftStore.subscribe, read, read)
  const set = useCallback((next: string) => draftStore.set(key, next), [key])
  const clear = useCallback(() => draftStore.clear(key), [key])
  return [value, set, clear] as const
}

// A form can expose several independently addressed text fields. One subscription keeps duplicate
// representations (queue card + drawer) coherent without serializing the form object itself.
//
// Same rule as useDraft, one step harder: the subscribed value has to collapse SEVERAL keys into one
// Object.is-comparable primitive. JSON of exactly these keys does that — it changes when one of THEM
// changes and not otherwise — and doubles as the memo key, so the returned Map also keeps a stable
// identity for whatever downstream memoization depends on it.
export function useDraftValues(keys: readonly string[]): ReadonlyMap<string, string> {
  const read = useCallback(
    () => JSON.stringify(Object.fromEntries(keys.map((key) => [key, draftStore.get(key)]))),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `keys` is rebuilt every render by every
    // caller; the JOINED key list is the real dependency, and it is what the callers keep stable.
    [keys.join(" ")],
  )
  const serialized = useSyncExternalStore(draftStore.subscribe, read, read)
  return useMemo(() => new Map(Object.entries(JSON.parse(serialized) as Record<string, string>)), [serialized])
}
