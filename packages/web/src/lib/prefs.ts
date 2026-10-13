import { proxy, subscribe } from "valtio"
import type { QueueDirection } from "../groups.ts"
import { DEFAULT_SNOOZE_PRESET, isSnoozePreset, type SnoozePreset } from "./snooze.ts"
import { sanitizeOverrides, type Overrides } from "./keybindings.ts"

// Client-only VIEW preferences — persisted in localStorage, never in the server Settings schema
// (that's operator dispatch config; this is how one browser likes to render). Seeded synchronously
// from localStorage so the first paint already reflects the saved choice, then mirrored back on
// every change. Components read via useSnapshot(prefs).
const KEY = "ntwine.prefs.v1"

export interface Prefs {
  // Collapse rendered diff blocks to just their header row (click a header to expand that one).
  compactDiffs: boolean
  // The PHONE's snooze length: the duration the board's swipe snoozes for, set in Settings and by a pick
  // in the ⋯ sheet. The desktop snooze menu neither reads nor writes it — every click there lists every
  // preset (SnoozeMenu.tsx), because a remembered default made one click mean different spans on
  // different days. A custom date is deliberately one-off and never overwrites this reusable preset.
  snoozePreset: SnoozePreset
  // Direction the Needs-you queue + the sidebar's rested band order by. FIFO (default) surfaces the
  // longest-waiting item first so the human cycles through everything; LIFO surfaces the most recent
  // arrival first. See groups.ts orderQueue.
  queueOrder: QueueDirection
  // The fullscreen rail's "Edited files" group folded to its heading (maintainer 2026-09-03: "make
  // Edited Files collapsible"). Open by default — the list is the rail's one non-wait group and the
  // reason the page has a rail at all — and remembered here rather than in the store because a
  // 22-file list a human folded once should stay folded on the next thread and the next reload.
  railFilesCollapsed: boolean
  // The operator's keyboard-shortcut CHANGES from the defaults (lib/keybindings.ts), not the whole
  // map: an action still on its default has no entry, so a default that changes in a later release
  // reaches everyone who never touched it. Per browser on purpose — a keyboard belongs to a machine.
  keybindings: Overrides
  // A working thread's status line written out after its name on every thread row, instead of shown when
  // you point at the row (Sidebar.tsx ThreadRow). Off by default (2026-10-07): upstream's standup call of
  // 2026-10-01, always-visible status lines are too dense for a list of names, taken from the project
  // board (2489fc34) to every row. Per browser, beside Density: it is how this screen likes to read.
  alwaysShowStatusLines: boolean
  // The threads this tab opened in the last half hour shown under the FOLDED Snoozed and Done headers, so one
  // sent back there is a click away without opening the band (lib/recentThreads.ts). Off by default
  // (David 2026-10-09): upstream's density call keeps a folded band to its header unless asked.
  showRecentThreads: boolean
  // (No `sendEditorContext` here any more. The context bar's eye was a pref of the sidebar's frame from
  // 2026-10-01 to 2026-10-02; it is now the extension's `ntwine.shareEditorState` (lib/editorContext.ts
  // setShareEditor), the one switch that also keeps the agents' tool out of the editor. A stored value is
  // ignored: the eye had not reached anyone's installed extension.)
  // The prompt box's on-device dictation microphone (lib/dictation.ts). On by default; off for an
  // operator who dictates with a system-wide tool and does not want a second microphone in the box
  // (maintainer 2026-10-10, using Wispr Flow).
  dictation: boolean
}

function coerceQueueOrder(v: unknown, fallback: QueueDirection): QueueDirection {
  return v === "fifo" || v === "lifo" ? v : fallback
}

// One-time re-default markers. They ride along in the stored blob but never in `Prefs` (what
// components read), and they are seeded into the fallback too — otherwise a browser starting FRESH
// after a migration ships stores no marker, and the very next load would revert the deliberate
// toggle that browser just made.
interface RedefaultMarkers {
  diffsRedefaulted?: boolean
  snoozeRedefaulted?: boolean
}

export function parseStoredPrefs(raw: string | null): Prefs {
  // Compact diffs by DEFAULT — expanded diff bodies are the opt-in.
  const fallback: Prefs & RedefaultMarkers = {
    compactDiffs: true,
    snoozePreset: DEFAULT_SNOOZE_PRESET,
    queueOrder: "fifo",
    railFilesCollapsed: false,
    keybindings: {},
    alwaysShowStatusLines: false,
    showRecentThreads: false,
    dictation: true,
    diffsRedefaulted: true,
    snoozeRedefaulted: true,
  }
  try {
    if (!raw) return fallback
    const stored = JSON.parse(raw) as Partial<Prefs> & RedefaultMarkers
    // The context bar's eye was a pref here for a day (2026-10-01); it is the extension's setting now
    // (lib/editorContext.ts setShareEditor). Dropped, so a stored value never rides the blob again.
    delete (stored as Record<string, unknown>).sendEditorContext
    // "Open code files" was a per-browser pref from 2026-09-30 to 2026-10-07; code files follow the one
    // Local file links setting now (lib/editorWindows.ts codeFilesDestination). Dropped the same way.
    delete (stored as Record<string, unknown>).codeFiles
    delete (stored as Record<string, unknown>).codeFilesRedefaulted
    // ONE-TIME migration (2026-07-09): the maintainer settled diffs as collapsed-by-default for
    // card-family consistency. A stored `compactDiffs: false` predating that decision was the OLD
    // default, not a choice — re-default it once. The marker makes a subsequent deliberate
    // Settings-toggle OFF stick forever.
    if (!stored.diffsRedefaulted) {
      stored.compactDiffs = true
      stored.diffsRedefaulted = true
    }
    // ONE-TIME migration (2026-09-29): the default moved from "1d" to "until tomorrow". Every pref
    // write persists the whole blob, so a stored "1d" is almost always the old default riding along
    // with some other toggle rather than a pick — re-default it once. A later deliberate "1d" sticks.
    if (!stored.snoozeRedefaulted) {
      if (stored.snoozePreset === "1d") stored.snoozePreset = "tomorrow"
      stored.snoozeRedefaulted = true
    }
    return {
      ...fallback,
      ...stored,
      snoozePreset: isSnoozePreset(stored.snoozePreset) ? stored.snoozePreset : fallback.snoozePreset,
      queueOrder: coerceQueueOrder(stored.queueOrder, fallback.queueOrder),
      railFilesCollapsed: typeof stored.railFilesCollapsed === "boolean" ? stored.railFilesCollapsed : fallback.railFilesCollapsed,
      keybindings: sanitizeOverrides(stored.keybindings),
      alwaysShowStatusLines: stored.alwaysShowStatusLines === true,
      showRecentThreads: stored.showRecentThreads === true,
      dictation: typeof stored.dictation === "boolean" ? stored.dictation : fallback.dictation,
    }
  } catch {
    return fallback
  }
}

function seed(): Prefs {
  try {
    return parseStoredPrefs(typeof localStorage === "undefined" ? null : localStorage.getItem(KEY))
  } catch {
    return parseStoredPrefs(null)
  }
}

export const prefs = proxy<Prefs>(seed())

subscribe(prefs, () => {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(prefs))
  } catch {
    /* private mode / quota — the in-memory proxy still drives this session */
  }
})
