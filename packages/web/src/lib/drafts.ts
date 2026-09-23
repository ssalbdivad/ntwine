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
  set(key: string, value: string): void {
    const entries = { ...this.snapshot.entries }
    if (!value) delete entries[key]
    else entries[key] = { value, touchedAt: Date.now() }
    this.commit({ version: DRAFT_SCHEMA_VERSION, entries })
  }
  clear(key: string): void { if (this.snapshot.entries[key]) this.commit({ version: DRAFT_SCHEMA_VERSION, entries: Object.fromEntries(Object.entries(this.snapshot.entries).filter(([candidate]) => candidate !== key)) }) }
  private commit(next: DraftSnapshot): void {
    this.snapshot = next
    // A too-large value remains in this tab's memory and subscribers see it immediately. `bounded`
    // excludes it from the reload snapshot, instead of replacing the controlled input with "".
    try { this.storage?.setItem(DRAFT_STORAGE_KEY, JSON.stringify(bounded(next))) } catch {}
    for (const listener of this.listeners) listener()
  }
}

export const draftStore = new DraftStore()

export function projectDraftScope(projectDir: string | undefined): string {
  return encodeURIComponent(projectDir || "unresolved-project")
}
export const draftKey = {
  dispatch: (projectDir: string | undefined) => `dispatch:${projectDraftScope(projectDir)}:new`,
  // The prompt box's Terminal tab: the shell command about to be run, kept apart from the prompt draft.
  command: (projectDir: string | undefined) => `command:${projectDraftScope(projectDir)}:new`,
  followUp: (projectDir: string | undefined, slug: string, sessionId?: string) => `followup:${projectDraftScope(projectDir)}:${encodeURIComponent(slug)}:${encodeURIComponent(sessionId ?? "unowned")}`,
  adopt: (projectDir: string | undefined, slug: string) => `adopt:${projectDraftScope(projectDir)}:${encodeURIComponent(slug)}`,
  answer: (projectDir: string | undefined, slug: string, sessionId: string | undefined, messageId: string, block: number) => `answer:${projectDraftScope(projectDir)}:${encodeURIComponent(slug)}:${encodeURIComponent(sessionId ?? "unowned")}:${encodeURIComponent(messageId)}:${block}`,
  interaction: (projectDir: string | undefined, projectId: string, slug: string, sessionId: string, epoch: number, id: string, field: string) => `interaction:${projectDraftScope(projectDir)}:${encodeURIComponent(projectId)}:${encodeURIComponent(slug)}:${encodeURIComponent(sessionId)}:${epoch}:${encodeURIComponent(id)}:${encodeURIComponent(field)}`,
  // A REGISTERED question's free-text box. Keyed by the question's own durable id and its node path in
  // the follow-up tree — no session or epoch, because a registered question outlives the session that
  // asked it (that is the whole point of it being a row), and a half-typed answer must survive the
  // worker restarting under it.
  question: (projectDir: string | undefined, slug: string, id: string, path: string) => `question:${projectDraftScope(projectDir)}:${encodeURIComponent(slug)}:${encodeURIComponent(id)}:${encodeURIComponent(path)}`,
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
// draft anywhere in the app — and `useLiveAnswering` calls `useDraftValues` from TodosView, near the top
// of the board tree, so one keystroke in the composer re-rendered the entire board: every queue card,
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
