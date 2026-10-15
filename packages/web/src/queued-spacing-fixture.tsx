import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView as ThreadViewModel, TranscriptMessage } from "@ntwine/shared"
import { ThreadView } from "./components/ChatView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for the QUEUED TAIL. Two things live here:
//  · SPACING — successive queued (optimistic) user bubbles must carry the same STEP rhythm as any other
//    pair of messages.
//  · THE PUSH-NOW CONTROL — the ↑ that appears left of a queued bubble on hover and preempts the turn
//    standing in front of the queue. It needs exactly what this fixture already sets up: `runtime:
//    "running"` on a claude thread plus queued bubbles. `deliveryId`s are set so the bubbles are also
//    UNQUEUEABLE, which is the real-app shape and the only way to see that the hover lift still fires
//    from the group rather than the bubble.
// The drawer (ThreadView/ChatView) is the one surface that renders the queued tail. The board's queue
// card built its own copy of the pinned queued group and was mounted here too, as the default, until it
// was deleted with the single-project board (2026-09-28); `?surface=drawer` is still accepted, and is now
// what every load renders.

const SLUG = "queued-spacing"
const PARAMS = new URLSearchParams(location.search)
const QUEUED = PARAMS.get("queued") !== "0"
const INTERLEAVE = PARAMS.get("interleave") === "1"
// The app picks its prose face in `index.html` before first paint, and a fixture that leaves it unset
// renders the MONO default — so a reading fitted here would only ever be right in one of the two faces
// this app ships. `?font=sans` (the default here, matching the maintainer's own window) / `?font=mono`.
document.documentElement.dataset.font = PARAMS.get("font") === "mono" ? "mono" : "sans"

const thread = {
  id: SLUG,
  title: "Spacing between successive queued messages",
  status: "needs-human",
  statusText: "Waiting on your call",
  mechanism: null,
  humanBlocked: true,
  needsYou: true,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  runtime: "running",
  unread: false,
  archived: false,
  hasPlan: false,
  pendingQuestion: false,
  kind: "session",
  foreign: false,
  backend: "claude",
  permissionMode: "default",
  subAgents: [],
  bgShells: [],
  lastActivityAt: "2026-07-18T10:00:00.000Z",
  spawnedAt: "2026-07-18T09:00:00.000Z",
  // The push-now click resolves this at CLICK time and refuses without it, so the control is only
  // driveable here if the fixture thread carries one — same as any live row.
  sessionId: "sid-queued-spacing",
} as unknown as ThreadViewModel

store.board = { projectDir: "/fixture/ntwine", threads: [thread] } as BoardSnapshot

const messages: TranscriptMessage[] = [
  { sourceId: "u1", role: "user", text: "Look at the queued-message spacing.", tools: [], parts: [], at: "2026-07-18T17:15:00.000Z" },
  {
    sourceId: "a1",
    role: "assistant",
    text: "On it — reproducing the queued tail now.",
    tools: [],
    parts: [{ kind: "text", text: "On it — reproducing the queued tail now." }],
    at: "2026-07-18T17:16:00.000Z",
  },
  // The queued TAIL: three successive optimistic sends, the case in the report. ?queued=0 drops it
  // entirely — the no-regression control for the always-rendered queued GROUP wrapper, which must add
  // no height and no stray gap when nothing is queued.
  ...(QUEUED
    ? ([
        { sourceId: "q1", role: "user", text: "and  what's the fic", tools: [], parts: [], queued: true, deliveryId: "d-q1", at: "2026-07-18T17:17:00.000Z" },
        // A message that RENDERS NOTHING between two queued sends: the queued pass skips it, so the old
        // "previous array element is queued" margin test failed and the two bubbles butted together.
        ...(INTERLEAVE ? [{ sourceId: "ev1", role: "assistant", kind: "event", text: "", tools: [], parts: [] }] : []),
        { sourceId: "q2", role: "user", text: "I want to see both.", tools: [], parts: [], queued: true, deliveryId: "d-q2", at: "2026-07-18T17:18:00.000Z" },
        {
          sourceId: "q3",
          role: "user",
          text: "third one, deliberately long enough to wrap onto a second line so the multi-line case is covered too",
          tools: [],
          parts: [],
          queued: true,
          deliveryId: "d-q3",
          at: "2026-07-18T17:19:00.000Z",
        },
      ] as unknown as TranscriptMessage[])
    : []),
] as unknown as TranscriptMessage[]

const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : ((input as Request).url ?? input.toString()), location.origin)
  if (url.pathname === "/_ntwine/rpc/threadTranscript" || url.pathname === "/_ntwine/rpc/threadTranscriptEarlier") {
    return new Response(
      JSON.stringify({ result: { messages, transcriptKey: `${SLUG}-key`, hasEarlier: false, historyLoaded: true } }),
      { headers: { "content-type": "application/json" } },
    )
  }
  // Record the push-now call rather than swallowing it into the generic `{}` below: a control that
  // renders correctly and asks the server for nothing is the failure this fixture has to be able to see.
  if (url.pathname === "/_ntwine/rpc/deliverQueuedNow") {
    const calls = ((window as unknown as { __pushNowCalls?: unknown[] }).__pushNowCalls ??= [])
    calls.push(JSON.parse(String(init?.body ?? "{}")))
    return new Response(JSON.stringify({ result: { interrupted: true } }), { headers: { "content-type": "application/json" } })
  }
  // A LIST, not the generic `{}`: the thread view iterates it, and `{}` threw before the transcript drew.
  if (url.pathname === "/_ntwine/rpc/threadSettledQuestions") {
    return new Response(JSON.stringify({ result: { questions: [] } }), { headers: { "content-type": "application/json" } })
  }
  // Lists too: the spinoff dialog iterates both.
  if (url.pathname === "/_ntwine/rpc/projectsQueues" || url.pathname === "/_ntwine/rpc/projectsList") {
    return new Response(JSON.stringify({ result: [] }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname.startsWith("/_ntwine/rpc/")) {
    return new Response(JSON.stringify({ result: {} }), { headers: { "content-type": "application/json" } })
  }
  return originalFetch(input, init)
}

function Fixture() {
  return (
    <div className="relative h-screen bg-bg text-fg text-sm">
      <div className="mx-auto flex h-screen w-[760px] max-w-full flex-col border-x border-border">
        {/* `virtualized`, as production mounts it (the drawer, ThreadSheet).
            Without it this fixture rendered ChatView's eager fallback — a branch whose own comment
            says no production surface reaches it. */}
        <ThreadView slug={SLUG} virtualized />
      </div>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <TooltipProvider>
      <Fixture />
    </TooltipProvider>
  </QueryClientProvider>,
)
