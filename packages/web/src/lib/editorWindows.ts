import type { EditorWindowSummary, LocalFileOpener } from "@ntwine/shared"

// WHAT THE PAGE MAKES OF THE CONNECTED EDITOR WINDOWS (store.editorWindows; packages/vscode is the
// extension, design in ARCHITECTURE.md § VS Code extension) — the pure half: which Local file links choices
// have a window behind them, where a code file goes, and whether this browser should be offered an editor.
// lib/editorBridge.ts acts on it.

/** The Local file links choices an editor window can stand behind. Windsurf runs the extension, but the setting has no Windsurf. */
export type EditorOpener = Extract<LocalFileOpener, "vscode" | "cursor">

export const EDITOR_OPENER_LABEL: Record<EditorOpener, string> = { vscode: "VS Code", cursor: "Cursor" }

/**
 * The Local file links choices a connected window would take a file for. Only a window that ACCEPTS opens
 * counts: one whose `ntwine.openFileLinks` is off is connected, but a file sent to that app would go to
 * its CLI exactly as if no window were there, so marking it connected would promise what it will not do.
 */
export function connectedOpeners(windows: readonly EditorWindowSummary[]): Set<EditorOpener> {
  const kinds = new Set<EditorOpener>()
  for (const window of windows) {
    if (window.acceptsOpens && (window.kind === "vscode" || window.kind === "cursor")) kinds.add(window.kind)
  }
  return kinds
}

/**
 * Where a click on a code file goes: the Local file links app ("editor") or ntwine's reader ("ntwine").
 * The app exactly while it is VS Code or Cursor with a window connected that takes opens
 * (connectedOpeners) — a connected editor is proof the app is there, on this machine, and that its owner
 * installed something whose whole job is to take these clicks — and the reader otherwise. Never the app
 * from the phone layout or a remote-access session, whose click would open in a window on the desk
 * nobody there can see: the same two gates as the offer. (A per-browser "Open code files" choice that
 * could pin either answer was dropped 2026-10-07, folding back into upstream's one setting.)
 */
export function codeFilesDestination({ windows, opener, phone, remote }: {
  windows: readonly EditorWindowSummary[]
  opener: LocalFileOpener | undefined
  phone: boolean
  remote: boolean
}): "ntwine" | "editor" {
  if (phone || remote || (opener !== "vscode" && opener !== "cursor")) return "ntwine"
  return connectedOpeners(windows).has(opener) ? "editor" : "ntwine"
}

/**
 * The editor to offer code files to, or null. Offered when a window of that editor is connected and
 * accepting, code files do not already go there (Local file links is not that editor —
 * codeFilesDestination), it has never been offered here before, and the page is neither the phone
 * layout nor a remote-access session: a device reaching this ntwine over a tunnel should not be asked to
 * send its clicks to an editor on the desk, where an open lands in a window it cannot see. Phone width alone stood in
 * for "remote" until review C8, so a laptop on the tunnel was asked. Windows are taken in the order the
 * server lists them, so two editors connecting at once are offered one at a time.
 */
export function editorOffer({ windows, opener, offered, phone, remote }: {
  windows: readonly EditorWindowSummary[]
  opener: LocalFileOpener | undefined
  offered: ReadonlySet<string>
  phone: boolean
  /** The supervisor says this page came in over remote access (api/signOut.ts isRemoteSession). */
  remote: boolean
}): EditorOpener | null {
  if (phone || remote) return null
  for (const window of windows) {
    if (!window.acceptsOpens || (window.kind !== "vscode" && window.kind !== "cursor")) continue
    const kind: EditorOpener = window.kind
    if (offered.has(kind)) continue
    if (opener === kind) continue
    return kind
  }
  return null
}

/** The editors this browser has been offered (a localStorage marker), read leniently: damage reads as none. */
export function parseOffered(raw: string | null): Set<string> {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [])
  } catch {
    return new Set()
  }
}
