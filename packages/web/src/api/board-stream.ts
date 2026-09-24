import type { ServerEvent } from "@frizz/shared"
import { deltaAction } from "@frizz/shared"
import { store, setBoard, applyDelta, openThread } from "../store.ts"
import { noteServerBootId } from "./boot.ts"
import { modeProjectHref, projectHref, projectSlug } from "../lib/base-path.ts"
import { spaNavigate } from "../lib/router.ts"

// The transport-agnostic board/notify handler — the stage-1 delta/seq/boot state machine, extracted so
// BOTH transports drive it identically: SSE (sse.ts, the fallback) and the /ws multiplex (socket.ts).
// A full "board" frame is the connect keyframe + the resync frame; "board-delta" frames carry only the
// threads that changed and must arrive in order (deltaAction). A seq gap can't be trusted, so the owner
// resyncs by RECONNECTING its transport (SSE re-opens EventSource; the socket re-opens the WebSocket) —
// the fresh connect handshake re-sends a full keyframe with the current seq. `resync` is injected so this
// module stays ignorant of the transport.
export class BoardStream {
  // The seq of the last board frame we adopted/applied. -1 = no keyframe yet. A full "board" keyframe
  // sets it; each delta must be exactly currentSeq+1 (see deltaAction) or we resync.
  private currentSeq = -1
  private readonly resync: () => void
  private readonly interactionsInvalidated: (
    event: Extract<ServerEvent, { type: "interactions-invalidated" }>,
  ) => void

  constructor(
    resync: () => void,
    interactionsInvalidated: (
      event: Extract<ServerEvent, { type: "interactions-invalidated" }>,
    ) => void = () => {},
  ) {
    this.resync = resync
    this.interactionsInvalidated = interactionsInvalidated
  }

  // Drop the adopted seq — call on (re)connect so any stray delta arriving before the next keyframe
  // forces a resync rather than applying against a torn base.
  reset(): void {
    this.currentSeq = -1
  }

  handle(event: ServerEvent): void {
    switch (event.type) {
      case "board":
        noteServerBootId(event.bootId)
        setBoard(event.board)
        // Keyframe: adopt its seq. A pre-restart server omits seq → -1 (it only ever sends full frames,
        // never deltas, so seq tracking is moot against it — we just keep taking whole boards).
        this.currentSeq = typeof event.seq === "number" ? event.seq : -1
        break
      case "board-delta":
        noteServerBootId(event.bootId)
        switch (deltaAction(this.currentSeq, event.seq)) {
          case "apply":
            if (applyDelta(event)) this.currentSeq = event.seq
            else this.resync() // no base board yet (shouldn't happen once a keyframe landed) — fetch one
            break
          case "ignore":
            break // a buffered duplicate the connect keyframe already covers
          case "resync":
            this.resync() // a delta was dropped (seq gap) — incremental state is untrustworthy; get a keyframe
            break
        }
        break
      case "notify":
        notify(event)
        break
      case "interactions-invalidated":
        this.interactionsInvalidated(event)
        break
    }
  }
}

// Fire a desktop notification for a server-pushed event, but only when the user opted in
// (settings.notifications, mirrored on the store) and the app isn't the focused/visible window —
// we never notify for what the user is already looking at. Clicking focuses the thread.
export function notify(event: Extract<ServerEvent, { type: "notify" }>): void {
  if (!store.notificationsEnabled) return
  if (!document.hidden) return
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return
  // THE PROJECT THIS NOTIFICATION IS ABOUT, frozen now — the last place in the client where "which
  // project" was resolved at the moment of USE rather than travelling with the thing that needed it.
  // A notification is clicked when the operator gets back to their machine, which can be long after it
  // was raised and in a tab that has since switched projects. `openThread` opens a slug in whatever
  // project is showing, and slugs are unique only WITHIN a project (see `rebindProject`), so the click
  // opened a DIFFERENT thread that happened to share the name rather than failing and saying so.
  const project = projectSlug() ?? store.board?.projectSlug
  // The tag is the browser's REPLACE key, so a bare slug collapses two projects' identically-named
  // threads into one notification — and the click would open whichever tab happened to fire it. Spelled
  // by the project's BOARD whatever page raised it, so a board tab and a cross-project tab on the same
  // project raise one notification between them, not two.
  const n = new Notification(event.title, { body: event.body, tag: `${project ? projectHref(project) : ""}/${event.slug}` })
  n.onclick = () => {
    window.focus()
    // Same project (the overwhelmingly common case): the in-app drawer. Otherwise that project's page in
    // this page's MODE, through the router — the cross-project page opens it in place.
    if (project === undefined || projectSlug() === project) {
      openThread(event.slug) // side drawer: chat, or the frizz doc for a never-spawned thread
    } else {
      spaNavigate(`${modeProjectHref(project)}/thread/${encodeURIComponent(event.slug)}`)
    }
    n.close()
  }
}
