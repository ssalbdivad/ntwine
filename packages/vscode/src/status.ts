// THE STATUS BAR ITEM, as data: what it says, what hovering it says, and what clicking it does.
//
// Connected, it is "Ntwine", with this workspace's Queue count beside it when anything is waiting on the
// human — the one number worth a glance from the editor, and the one the sidebar's badge shows. A click
// shows the Ntwine sidebar, where those threads are. "Queued" and "running" are the page's own words
// for the queue and for what is spinning (its bands, Queue and Running, since 2026-10-06; Ready and
// Working before). A project the server has not opened yet has no counts (the
// `projects` push omits them), and says nothing rather than claiming zero.
//
// Offline, it stays short — a window with no Ntwine running should not shout about it in every status
// bar — and the tooltip says what is true and that a click tries again.

import type { EditorProject } from "@ntwine/shared/editor-protocol"
import type { ConnectionStatus } from "./connection.ts"

export interface StatusView {
  text: string
  tooltip: string
  command: "ntwine.sidebar.focus" | "ntwine.reconnect"
  /** This workspace's Queue count; 0 when not connected. */
  ready: number
}

/**
 * The item for this connection and workspace. `build` is the extension's own label (build-info.ts), the
 * tooltip's last line in every state — the one place in the window it can be read at a glance, which is
 * what "is this window running the fix?" needs.
 */
export function statusView(connection: ConnectionStatus, projects: readonly EditorProject[], build?: string): StatusView {
  const view = statusFor(connection, projects)
  return build ? { ...view, tooltip: `${view.tooltip}\nNtwine extension ${build}` } : view
}

function statusFor(connection: ConnectionStatus, projects: readonly EditorProject[]): StatusView {
  switch (connection.kind) {
    case "connecting":
      return { text: "$(sync~spin) Ntwine", tooltip: "Looking for Ntwine…", command: "ntwine.reconnect", ready: 0 }
    case "offline":
      return { text: "$(debug-disconnect) Ntwine", tooltip: `${connection.reason.replace(/\.$/u, "")}. Click to try again.`, command: "ntwine.reconnect", ready: 0 }
    case "incompatible":
      return { text: "$(warning) Ntwine", tooltip: `${connection.reason} Click to try again.`, command: "ntwine.reconnect", ready: 0 }
    case "connected": {
      const ready = projects.reduce((sum, project) => sum + (project.ready ?? 0), 0)
      const lines = projects.map((project) => {
        if (project.ready === undefined && project.working === undefined) return project.name
        return `${project.name}: ${project.ready ?? 0} queued · ${project.working ?? 0} running`
      })
      return {
        text: ready > 0 ? `Ntwine · ${ready} queued` : "Ntwine",
        tooltip: [...lines, "Click to show Ntwine."].join("\n"),
        command: "ntwine.sidebar.focus",
        ready,
      }
    }
  }
}

/**
 * What a command that needs the connection says without one: the connection's own reason, the one the
 * tooltip shows. A Ntwine that is running but refused this window (one from before the editor connection,
 * a version mismatch) is told to update, never reported as stopped.
 */
export function notConnectedMessage(connection: ConnectionStatus): string {
  if (connection.kind === "offline" || connection.kind === "incompatible") return connection.reason
  return "Still connecting to Ntwine. Try again in a moment."
}
