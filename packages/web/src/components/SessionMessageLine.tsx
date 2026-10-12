// A MESSAGE FROM ANOTHER THREAD — one top-level session's `SendMessage` into this one, most often the
// coordinator thread that spawned it steering its work.
//
// It reached the chat as an ordinary user turn whose text was Claude Code's raw wrapper, so it rendered
// in the human's own right-justified bubble with `<cross-session-message from="uds:/tmp/cc-socks/2908.sock"
// from-name="frizz-11" from-mode="bypass">` printed above the body (maintainer 2026-10-08: "There should
// be a link to the originating thread, and it should not look like fucking XML"). The server now
// unwraps it (`sessionPeer`, displayText = the body) and names the sending thread.
//
// AN EXPANDABLE HAIRLINE (maintainer 2026-10-09, over the card it first shipped as: "this should
// probably just be an expandable hairline"). It is the same class as a sub-agent reporting up — another
// agent reaching into this thread's turn — so it wears that divider's shape, and like the fired timer it
// keeps a body one click away, because the instruction is text nobody else in the app renders.
//
// The row is the INERT divider, not the clickable one, because it carries two affordances: the sender's
// title links to the sending thread (the in-project link opens it in the drawer — thread-links.ts
// intercepts `/thread/<slug>`; a sender in another project navigates to that board), and "Click to
// expand" toggles the body. A whole-row button would have to nest the link, which HTML forbids.
import { useId, useState } from "react"
import { MessagesSquare } from "lucide-react"
import { useSnapshot } from "valtio"
import type { ThreadView, TranscriptMessage } from "@frizz/shared"
import { DIVIDER_LINK } from "./FrizzWake.tsx"
import { QUEUE_WRAP } from "./TranscriptCard.tsx"
import { WakeDivider } from "./WakeDivider.tsx"
import { displayTitle } from "../groups.ts"
import { crossProjectHref, outerPath } from "../lib/base-path.ts"
import { useInnerHtml } from "../lib/innerHtml.ts"
import { useMarkdownHtml } from "../lib/useMarkdown.ts"
import { store, threadBySlug } from "../store.ts"

type SessionPeer = NonNullable<TranscriptMessage["sessionPeer"]>

export function sessionPeerHref(thread: NonNullable<SessionPeer["thread"]>): string {
  // The fork's view-keeping prefix (`/project/<p>` on a board, `/all/<p>` on All projects).
  return thread.project ? `${crossProjectHref(thread.project)}/thread/${thread.slug}` : outerPath(`/thread/${thread.slug}`)
}

export function SessionMessageLine({ peer, text, queued, sourceId, at, wrap }: { peer: SessionPeer; text: string; queued?: boolean; sourceId?: string; at?: string; wrap?: boolean }) {
  const snap = useSnapshot(store)
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const sender = peer.thread
  // A sender on THIS board takes the title the sidebar shows, live — the server's copy is the row's
  // title at read time, which is all it can offer for a thread in another project.
  const local = sender && !sender.project ? (threadBySlug(snap.board as typeof store.board, sender.slug) as ThreadView | undefined) : undefined
  const title = local ? displayTitle(local) : sender?.title
  const body = useInnerHtml(useMarkdownHtml(text))
  return (
    <div data-frizz-msg={sourceId} data-session-message className={`flex flex-col ${queued ? "opacity-50" : ""}`}>
      <WakeDivider icon={MessagesSquare} marker="session-message" at={at}>
        {sender ? (
          <>
            <span className="shrink-0">Message from</span>
            {/* Guillemets OUTSIDE the truncating element, as on the sub-agent line: a title clipped at
                a narrow width still closes its quote, and only the title shrinks. */}
            <span className="flex min-w-0 items-center">
              <span className="shrink-0">«</span>
              <a href={sessionPeerHref(sender)} data-session-peer-link title="Open the thread that sent this" onMouseDown={(e) => e.preventDefault()} className={`min-w-0 truncate ${DIVIDER_LINK}`}>
                {title}
              </a>
              <span className="shrink-0">»</span>
            </span>
          </>
        ) : (
          // Not a Frizz thread, or one that exited before Frizz could trace it: the session's own name is
          // all there is, said as a name rather than dressed up as a link.
          <span className="min-w-0 truncate">{peer.name ? `Message from session ${peer.name}` : "Message from another session"}</span>
        )}
        <span aria-hidden="true" className="shrink-0 opacity-50">·</span>
        <button
          type="button"
          data-session-message-toggle
          onClick={() => setOpen((v) => !v)}
          onMouseDown={(e) => e.preventDefault()}
          aria-expanded={open}
          aria-controls={bodyId}
          className="shrink-0 rounded-sm outline-none transition-colors hover:text-fg focus-visible:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60"
        >
          {open ? "Click to collapse" : "Click to expand"}
        </button>
      </WakeDivider>
      {open && (
        // The fired timer's ruled aside, flush left for the same reason (the label above is centred, so an
        // inset would align to nothing). Markdown, unlike the timer's plain text: this is an agent's
        // message, written as Markdown — lists and code spans — like any other agent prose. `card-md` puts
        // md-body on the 13px scale with an inherited colour, so it reads as the quiet aside the timer's
        // is rather than as more of the agent's own 14px prose.
        <div id={bodyId} className="card-md mt-1.5 border-l border-border/70 pl-3 text-muted">
          <div className={`md-body [overflow-wrap:anywhere]${wrap ? ` ${QUEUE_WRAP}` : ""}`} dangerouslySetInnerHTML={body} />
        </div>
      )}
    </div>
  )
}
