// A PROJECT'S THREADS, as "Send to ntwine thread…" lists them. Only threads a follow-up can reach: open
// (not Done), ntwine's own (not an external terminal session), and real sessions (not a legacy row) with
// a session to address. Ordered the way the human scans the page: the queue first (Ready — waiting on
// them), then what is spinning, then the rest, newest activity first within each.
//
// The NAME each row shows is ported from the page (packages/web/src/groups.ts `displayTitle`,
// `threadHandleOf`, and @ntwine/shared's `threadHandle`) rather than imported: the page's module pulls
// the shared index (zod, yaml) into the bundle for a dozen lines of string rules. threads.test.ts runs
// the originals beside these copies over the same rows, so a change to either fails there.

import type { ThreadView } from "@ntwine/shared"

export type PickerThread = Pick<
  ThreadView,
  | "id"
  | "sessionId"
  | "title"
  | "aiTitle"
  | "titleAuto"
  | "titleLocked"
  | "titleNamed"
  | "spawnedAt"
  | "backend"
  | "runtime"
  | "foreign"
  | "held"
  | "kind"
  | "state"
  | "needsYou"
  | "statusLine"
  | "lastAssistant"
  | "lastActivityAt"
  | "lastAssistantAt"
  | "lastUserAt"
  | "checkout"
>

export type ThreadBand = "ready" | "working" | "rest"

// ── names: a port of groups.ts titleSource / displayTitle / threadHandleOf ──────────────────────────

const SPINNING_UP_TITLE = "Spinning up a thread…"
const UNTITLED_THREAD_TITLE = "Untitled thread"
const SPIN_UP_MS = 60_000
const CODEX_TITLE_SIGNAL_GRACE_MS = 15_000
const HANDLE_MAX_WORDS = 5

type TitleFields = Pick<PickerThread, "title" | "aiTitle" | "id" | "titleAuto" | "titleLocked" | "titleNamed" | "spawnedAt" | "backend" | "runtime" | "foreign" | "held">

/** @ntwine/shared thread-handle.ts `threadHandle`: the words lowercased and joined by `-`; none past five words. */
export function threadHandle(name: string): string | undefined {
  const parts = name.normalize("NFKD").replace(/\p{M}+/gu, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  if (parts.length === 0 || parts.length > HANDLE_MAX_WORDS) return undefined
  return parts.map((w) => w.toLowerCase()).join("-")
}

function readableMachineTitle(raw: string): string {
  const title = raw.trim()
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/i.test(title)) return title
  const words = title.split(/[-_]+/).filter(Boolean)
  if (words.length === 0) return title
  const joined = words.join(" ").toLowerCase()
  return joined.charAt(0).toUpperCase() + joined.slice(1)
}

function titleIsProvisional(t: TitleFields, now: number): boolean {
  if (t.held !== undefined) return false
  if (!t.titleAuto || (t.titleNamed ?? Boolean(t.aiTitle))) return false
  const spawned = Date.parse(t.spawnedAt ?? "")
  if (t.backend === "codex") {
    if (t.runtime === "spawning") return true
    return Number.isFinite(spawned) && now - spawned < CODEX_TITLE_SIGNAL_GRACE_MS
  }
  return Number.isFinite(spawned) && now - spawned < SPIN_UP_MS
}

function titleIsHumanOwned(t: Pick<TitleFields, "titleAuto" | "titleLocked">): boolean {
  return t.titleLocked ?? t.titleAuto === false
}

function titleSource(t: TitleFields, now: number): { text: string; name: boolean } {
  if (t.foreign === true && t.title.trim()) return { text: t.title.trim(), name: false }
  if (titleIsProvisional(t, now)) return { text: SPINNING_UP_TITLE, name: false }
  if (t.aiTitle?.trim() && !titleIsHumanOwned(t)) return { text: readableMachineTitle(t.aiTitle), name: t.titleNamed !== false }
  if (t.backend === "codex" && t.titleAuto === true && !t.aiTitle?.trim()) return { text: UNTITLED_THREAD_TITLE, name: false }
  if (t.titleAuto === false && t.title.trim()) return { text: t.title.trim(), name: true }
  if (t.title.trim() && !(t.titleAuto === true && t.title.trim() === t.id)) {
    return { text: t.titleAuto === true ? readableMachineTitle(t.title) : t.title.trim(), name: t.titleNamed !== false }
  }
  return { text: t.titleAuto === true ? UNTITLED_THREAD_TITLE : t.id, name: false }
}

/** The title the page shows: a real name as its handle (`shell-budgets`), anything else verbatim. */
export function displayTitle(t: TitleFields, now = Date.now()): string {
  const source = titleSource(t, now)
  return source.name ? threadHandle(source.text) ?? source.text : source.text
}

/** The thread's name in the words it is stored as ("Tidy the sample loop") — for a title in prose, where a handle reads as an id. */
export function displayName(t: TitleFields, now = Date.now()): string {
  return titleSource(t, now).text
}

/** The `@` handle the thread is addressed by, or undefined when what it shows is not a name. */
export function threadHandleOf(t: TitleFields, now = Date.now()): string | undefined {
  const source = titleSource(t, now)
  return source.name ? threadHandle(source.text) : undefined
}

// ── which threads, in what order ─────────────────────────────────────────────────────────────────────

/** A thread a follow-up can reach. */
export function pickable<T extends PickerThread>(t: T): t is T & { sessionId: string } {
  return t.kind === "session" && t.foreign !== true && t.state !== "archived" && typeof t.sessionId === "string" && t.sessionId.length > 0
}

/**
 * Ready is the queue itself (`needsYou`). Working is a turn in flight — `running` or `spawning`; the
 * page's band rule also counts a rest held open by live sub-agents, which needs fields the picker does
 * not carry, and only ever moves a row within this list.
 */
export function bandOf(t: Pick<PickerThread, "needsYou" | "runtime">): ThreadBand {
  if (t.needsYou === true) return "ready"
  if (t.runtime === "running" || t.runtime === "spawning") return "working"
  return "rest"
}

const BAND_ORDER: Record<ThreadBand, number> = { ready: 0, working: 1, rest: 2 }

function lastActivity(t: PickerThread): number {
  for (const at of [t.lastActivityAt, t.lastAssistantAt, t.lastUserAt, t.spawnedAt]) {
    const ms = Date.parse(at ?? "")
    if (Number.isFinite(ms)) return ms
  }
  return 0
}

/** The threads to offer, in the order to offer them. */
export function pickerThreads<T extends PickerThread>(threads: readonly T[]): (T & { sessionId: string })[] {
  return threads
    .filter((t) => pickable(t))
    .map((t) => ({ t, band: BAND_ORDER[bandOf(t)], at: lastActivity(t) }))
    .sort((a, b) => a.band - b.band || b.at - a.at || a.t.id.localeCompare(b.t.id))
    .map(({ t }) => t)
}

// ── the window's own thread ──────────────────────────────────────────────────────────────────────────
//
// A VS Code window whose workspace folder IS a thread's worktree (the drawer's "Open in editor" on a thread
// in `.ntwine/worktrees/<slug>` opens exactly that) is about that thread, not about the project in general:
// the sidebar opens on it, and "Send to ntwine thread…" offers it first. The thread's `checkout` is the
// server's own reading of where its agent works (thread-cwd.ts, the same one the terminal and Done use),
// so the match needs nothing new from ntwine. Decided on the EXTENSION's side, after the page says it is
// ready, rather than through the frame's address: the page already takes `ntwine:navigate`, and the
// address is read once per frame — a thread chosen there would be stale the moment the human moved on.

/**
 * The open thread whose own checkout IS one of the window's folders, or undefined: none does, or the window
 * is on the project root (a thread at the root has no `checkout`). Several threads in one worktree (a
 * spinoff child keeps working in its parent's) give the one the picker would list first — waiting on the
 * human, then working, then the newest. `same` says whether two folders are one (realpath identity).
 */
export function windowThread<T extends PickerThread>(threads: readonly T[], folders: readonly string[], same: (a: string, b: string) => boolean): (T & { sessionId: string }) | undefined {
  return pickerThreads(threads).find((t) => t.checkout && folders.some((folder) => same(folder, t.checkout!.dir)))
}

/** The picker's list with the window's own thread moved to the top, everything else in its order. */
export function windowThreadFirst<T extends PickerThread>(threads: readonly T[], own: T | undefined): T[] {
  return own ? [own, ...threads.filter((t) => t.id !== own.id)] : [...threads]
}

/** A thread named by a command argument: its slug, or its handle with or without the `@`. */
export function findThread<T extends PickerThread>(threads: readonly T[], name: string, now = Date.now()): T | undefined {
  const wanted = name.trim().replace(/^@/u, "")
  return threads.find((t) => t.id === wanted) ?? threads.find((t) => threadHandleOf(t, now) === wanted.toLowerCase())
}

export interface ThreadItem {
  label: string
  description: string
  detail?: string
}

/** One quick-pick row: `@handle` (or the shown title), where it stands, and what it is doing or said last. */
export function threadItem(t: PickerThread, now = Date.now()): ThreadItem {
  const handle = threadHandleOf(t, now)
  const band = bandOf(t)
  const detail = (t.statusLine?.trim() || t.lastAssistant?.trim() || "").replace(/\s+/gu, " ")
  return {
    label: handle ? `@${handle}` : displayTitle(t, now),
    description: band === "ready" ? "Ready" : band === "working" ? "Working" : "",
    ...(detail ? { detail: detail.length > 140 ? `${detail.slice(0, 139)}…` : detail } : {}),
  }
}
