// ONE AGENT TALKING TO ANOTHER, drawn as a message in a chat app rather than as Frizz machinery.
//
// Four channels carry agent-to-agent words into a thread's transcript: another Frizz thread
// (`mcp__frizz__message_thread`), another Claude session (cross-session `SendMessage`), a sub-agent
// reporting up mid-flight, and this worker steering a child. Until 2026-10-08 each had its own shape — a
// "Frizz" card that printed the recipient's own instructions under the message, a petite-caps hairline
// with the body one or two clicks away, an outgoing call folded inside "Ran 1 tool call" — so an exchange
// between two agents read as four unrelated system events (maintainer 2026-10-08: "a clean dedicated UI
// for these type of agent exchanges that more closely mirrors an elegant message UI you'd have in a chat
// app"). They now share this one component.
//
// The layout follows a group chat, where the human is "me":
// - The HUMAN keeps the right-hand bubble (UserBubble), the only thing on that side.
// - The WORKER's own prose stays unbubbled on the left, and a message it SENDS to another agent stays on
//   its left edge — it is the worker speaking — in an OUTLINED bubble under a "To <name>" line.
// - A message the worker RECEIVES from another agent sits one avatar in, in a FILLED bubble under the
//   sender's name, the way a third participant's message reads in a group chat.
// Long bodies clamp at CLAMP_PX with a fade and a "Show more" toggle, so a long report stays one glance
// tall without hiding any of it behind a drawer.
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { ArrowUpRight, Bot, MessagesSquare, type LucideIcon } from "lucide-react"
import { useMarkdownHtml } from "../lib/useMarkdown.ts"
import { useInnerHtml } from "../lib/innerHtml.ts"
import { useLocalFileCodeLinks } from "../lib/localFileCode.ts"
import { useMermaidIslands } from "./CodexRichOutput.tsx"
import { useLightboxIslands } from "./Lightbox.tsx"
import { useNowMs } from "../lib/liveClock.ts"
import { compactAge, exactStamp } from "../lib/activityTime.ts"
// The human's bubble's corner, with the tail on the speaker's side: top-left here, bottom-right there.
import { BLOCK_RADIUS } from "./TranscriptCard.tsx"

export type AgentMessageKind = "thread" | "sub-agent" | "session"

const KIND_ICON: Record<AgentMessageKind, LucideIcon> = { thread: MessagesSquare, "sub-agent": Bot, session: Bot }
const KIND_LABEL: Record<AgentMessageKind, string> = { thread: "thread", "sub-agent": "sub-agent", session: "Claude session" }

// About eleven lines of 14px prose: a short message never clamps, a long report shows its opening.
const CLAMP_PX = 264

export function AgentMessage({ direction, kind, name, body, at, sourceId, status }: {
  direction: "in" | "out"
  kind: AgentMessageKind
  /** The other party: a link or drill-in button when it resolves, plain text when it does not. */
  name: ReactNode
  body: string
  at?: string
  sourceId?: string
  /** A short state beside the name — "replied", "reply requested". */
  status?: string
}) {
  const Icon = KIND_ICON[kind]
  const incoming = direction === "in"
  return (
    <div
      data-frizz-msg={sourceId}
      data-agent-message={direction}
      data-agent-kind={kind}
      className={`flex min-w-0 max-w-[85%] gap-2.5 ${incoming ? "" : "flex-col gap-1"}`}
    >
      {incoming && (
        // The avatar wears the incoming bubble's own fill, so the pair reads as one participant. Centred on
        // the 18px name line: 24px box, 2px above it (both centres measured equal 2026-10-08).
        <span aria-hidden="true" data-agent-avatar className="-mt-[2px] flex size-6 shrink-0 items-center justify-center rounded-full bg-user-bubble text-muted">
          <Icon size={13} strokeWidth={2} />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-baseline gap-1.5 text-[12px] leading-[18px] text-muted">
          {/* Lucide's arrow paints 5 of its 12 box px, 3.5px of dead box per side: the negative margins put
              its ink flush with the bubble's left edge and 6px from "To", the row's own rhythm. */}
          {!incoming && <ArrowUpRight aria-hidden="true" data-agent-arrow size={12} className="-mx-[3.5px] shrink-0 self-center" />}
          {!incoming && <span data-agent-to className="shrink-0">To</span>}
          <span data-agent-name className="min-w-0 truncate text-[13px] font-medium text-fg">{name}</span>
          <span className="shrink-0">{KIND_LABEL[kind]}</span>
          {status && (
            <>
              <span aria-hidden="true" className="shrink-0 opacity-50">·</span>
              <span className="shrink-0">{status}</span>
            </>
          )}
          <Age at={at} />
        </div>
        <Bubble body={body} incoming={incoming} />
      </div>
    </div>
  )
}

function Bubble({ body, incoming }: { body: string; incoming: boolean }) {
  const html = useMarkdownHtml(body)
  const inner = useInnerHtml(html)
  const ref = useRef<HTMLDivElement>(null)
  const [overflows, setOverflows] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const bodyId = useId()
  // The decoration every card's prose gets (LinkedHtml), inlined because the clamp needs this element's
  // own ref: a file the message names links once the server confirms it, and a gallery or a diagram in
  // it is drawn as one (upstream 9ba8a364 gave the peer-message card's body the same).
  useLocalFileCodeLinks(ref, html)
  const galleries = useLightboxIslands(ref, html)
  const diagrams = useMermaidIslands(ref, html)
  // Measured, not guessed from a line count: a body of three long paragraphs clamps, a body of twenty
  // one-word lines may not, and markdown (lists, code) changes the height either way.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setOverflows(el.scrollHeight > CLAMP_PX + 24)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [html])
  const clamped = overflows && !expanded
  return (
    <div
      className={`min-w-0 self-start ${BLOCK_RADIUS} rounded-tl-sm px-3.5 py-3 ${incoming ? "bg-user-bubble text-user-bubble-fg" : "border border-border"}`}
    >
      <div
        id={bodyId}
        ref={ref}
        className="md-body [overflow-wrap:anywhere] [&>:first-child]:mt-0 [&>:last-child]:mb-0"
        style={clamped ? { maxHeight: CLAMP_PX, overflow: "hidden", maskImage: "linear-gradient(to bottom, black 70%, transparent)", WebkitMaskImage: "linear-gradient(to bottom, black 70%, transparent)" } : undefined}
        dangerouslySetInnerHTML={inner}
      />
      {galleries}
      {diagrams}
      {overflows && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded((v) => !v)}
          onMouseDown={(e) => e.preventDefault()}
          className="mt-1 rounded-sm text-[12px] text-muted underline decoration-muted/30 underline-offset-2 outline-none transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  )
}

function Age({ at }: { at?: string }) {
  const now = useNowMs()
  const age = compactAge(at, now)
  if (!age) return null
  return (
    <>
      <span aria-hidden="true" className="shrink-0 opacity-50">·</span>
      <span title={exactStamp(at) ?? undefined} className="shrink-0 tabular-nums">{age}</span>
    </>
  )
}
