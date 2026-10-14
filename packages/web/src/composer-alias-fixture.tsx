import { useState } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router"
import type { BoardSnapshot, ThreadHandoff, ThreadView as ThreadViewModel, TranscriptMessage } from "@ntwine/shared"
import { AllQueuesCard } from "./components/AllQueuesCard.tsx"
import { QueueOpsSummary } from "./components/QueueOpsSummary.tsx"
import { ThreadActionBar } from "./components/ThreadActionBar.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import type { QueuesProject } from "./lib/allQueues.ts"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for the two boxes a reply to a thread is typed into: THE STANDARD PROMPT BOX in the thread
// drawer (components/ThreadComposerBox.tsx, under ThreadActionBar) and the reply box of the page's QUEUE
// CARD (components/AllQueuesCard.tsx ReplyBox). Two things are proven here, both of which have differed
// between the surfaces:
//
//   D7 — `/login` and `/logout` are NTWINE-OWNED aliases. They must open the sign-in / sign-out modal and
//        must NEVER be delivered to the worker's stdin. Before the box was shared this only worked in
//        the drawer; the board's queue card injected the literal "/login" string into the running agent.
//        It happened AGAIN with the board's deletion (2026-09-28): the page's card had its own send path
//        with no alias check, and ReplyBox now intercepts through `parseAccountAlias` itself.
//   D8 — an ordinary follow-up still reaches the worker.
//
// The REAL ThreadActionBar / ThreadComposerBox and AllQueuesCard render; only the network is stubbed.
// Every followUp the app attempts — unprefixed from the drawer, `/_ntwine/<project id>/rpc/followUp` from
// the card, which addresses its own project — is recorded on window.__worker.sent. That array IS the
// worker's stdin as far as this fixture is concerned, so "the alias never reached the worker" is a
// direct assertion, not an inference.
//
//   ?surface=drawer (default) — the drawer footer (ThreadActionBar)
//   ?surface=card             — the page's queue card for the same thread
//   ?surface=both             — both, side by side (the comparison screenshot). They share the thread
//                               and so its draft, so a test drives one surface at a time.
//   ?answerable=1             — the agent's last message carries a ```question block (layout check)
//
// The card mounted here until 2026-09-28 was the board's (TodosView); the one mounted now is the page's,
// under a MemoryRouter with a QueuesProject, the way registered-question-fixture.tsx mounts it.

const SLUG = "alias-thread"
const params = new URLSearchParams(location.search)
const SURFACE = params.get("surface") ?? "drawer"
const ANSWERABLE = params.get("answerable") === "1"
// `?runtime=exited` rests the thread on an exited session with nothing asked, so the card offers Retry in
// its header (groups.ts offersRetry: a stalled session, which an open ask would outrank).
const RUNTIME = params.get("runtime") ?? "turn-idle"
const STALLED = RUNTIME === "exited"

const thread = {
  id: SLUG,
  title: "Rotate the signing key without downtime",
  status: STALLED ? "active" : "needs-human",
  statusText: STALLED ? "" : "Waiting on your call",
  mechanism: null,
  humanBlocked: !STALLED,
  needsYou: true,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  runtime: RUNTIME,
  unread: false,
  archived: false,
  hasPlan: false,
  pendingQuestion: false,
  kind: "session",
  foreign: false,
  backend: "claude",
  permissionMode: "default",
  state: "open",
  sessionId: "sess-alias-1",
  subAgents: [],
  bgShells: [],
  lastFence: null,
  lastActivityAt: new Date().toISOString(),
  lastAssistantAt: new Date().toISOString(),
  spawnedAt: new Date().toISOString(),
} as unknown as ThreadViewModel

store.board = { projectDir: "/fixture/ntwine", threads: [thread] } as BoardSnapshot

const ASK = [
  "I can rotate the key in place or stage a second key first.",
  "",
  "```question",
  "Which rollout do you want?",
  "- Rotate in place",
  "- Stage a second key",
  "```",
].join("\n")
const PLAIN = "Standing by — tell me which rollout you want and I'll start."
const body = ANSWERABLE ? ASK : PLAIN

const messages: TranscriptMessage[] = [
  { sourceId: `${SLUG}-u1`, role: "user", text: "Rotate the signing key without downtime.", tools: [], parts: [] },
  { sourceId: `${SLUG}-a1`, role: "assistant", text: body, tools: [], parts: [{ kind: "text", text: body }] },
]

// Every message the UI tried to deliver to the worker, in order. An alias that leaks past the composer
// intercept shows up here — which is exactly the D7 regression.
interface WorkerTelemetry { sent: string[]; rpc: string[] }
const worker: WorkerTelemetry = { sent: [], rpc: [] }
;(window as unknown as { __worker: WorkerTelemetry }).__worker = worker

// The card as the page would build it: this thread, Ready in its project's queue.
const project: QueuesProject = {
  id: "fixture",
  slug: "ntwine",
  name: "ntwine",
  card: undefined,
  open: true,
  stale: false,
  projectDir: "/fixture/ntwine",
  homeDir: "/fixture",
  githubRepo: undefined,
  queued: [thread],
  running: [],
  snoozed: [],
  pinnedDone: [], recentDone: [],
  doneCount: 0,
}
// The card reads the thread's handoff — the human's last ask and the worker's answer to it — never the
// transcript (AllQueuesCard's header comment).
const handoff: ThreadHandoff = { asked: messages[0]!.text, askedAt: new Date(Date.now() - 120_000).toISOString(), text: body, at: new Date().toISOString() }

const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.origin)
  // `/_ntwine/rpc/<name>` from the drawer (the page's project), `/_ntwine/<project id>/rpc/<name>` from the
  // card: routed on the procedure's name alone.
  const rpc = /^\/_ntwine\/(?:[^/]+\/)?rpc\/([^/]+)$/.exec(url.pathname)?.[1]
  if (!rpc) return originalFetch(input, init)
  worker.rpc.push(rpc)
  if (rpc === "threadHandoff") {
    return new Response(JSON.stringify({ result: handoff }), { headers: { "content-type": "application/json" } })
  }
  if (rpc === "threadTranscript" || rpc === "threadTranscriptEarlier") {
    return new Response(
      JSON.stringify({ result: { messages, transcriptKey: `${SLUG}-key`, hasEarlier: false, historyLoaded: false } }),
      { headers: { "content-type": "application/json" } },
    )
  }
  if (rpc === "followUp") {
    try {
      const parsed = typeof init?.body === "string" ? (JSON.parse(init.body) as { message?: string }) : null
      worker.sent.push(parsed?.message ?? "")
    } catch {
      worker.sent.push("<unparseable>")
    }
    return new Response(JSON.stringify({ result: {} }), { headers: { "content-type": "application/json" } })
  }
  // The queue card reads its settled registered questions; an empty `{}` leaves the query's data
  // undefined, which React Query reports to the console and the no-errors assertion then trips on.
  if (url.pathname === "/_ntwine/rpc/threadSettledQuestions") {
    return new Response(JSON.stringify({ result: { questions: [] } }), { headers: { "content-type": "application/json" } })
  }
  // The `@` typeahead reads every project's queue (lib/threadMentions), and iterates the result: `{}` threw
  // "queues is not iterable" and took the whole page down.
  if (rpc === "projectsQueues") {
    return new Response(JSON.stringify({ result: [] }), { headers: { "content-type": "application/json" } })
  }
  return new Response(JSON.stringify({ result: {} }), { headers: { "content-type": "application/json" } })
}

// The drawer's real footer arrangement (ChatView renders exactly this pair): the chat footer frame,
// with ThreadActionBar inside it and the line of op counts passed as its `above`.
function DrawerSurface() {
  return (
    <div data-fixture-drawer className="my-5 flex h-[420px] w-[560px] max-w-full min-w-0 flex-col rounded-lg border border-border bg-panel">
      <div className="min-h-0 flex-1 overflow-y-auto p-4 text-[13px] leading-relaxed text-muted">
        {messages.map((m) => (
          <p key={m.sourceId} className="mb-3 whitespace-pre-wrap">
            <span className="petite-caps mr-2 text-[11px] text-muted-60">{m.role}</span>
            {m.text}
          </p>
        ))}
      </div>
      <div data-thread-chat-footer className="z-10 shrink-0 border-t border-border/60 bg-panel">
        <ThreadActionBar slug={SLUG} above={<QueueOpsSummary thread={thread} />} />
      </div>
    </div>
  )
}

// The page's queue card, alone in its column. A sent reply fades it (`onLeave`), as on the page.
function CardSurface() {
  const [leaving, setLeaving] = useState(false)
  return (
    <div data-fixture-card className="my-5 w-[640px] max-w-full min-w-0">
      <AllQueuesCard project={project} thread={thread} leaving={leaving} onLeave={() => setLeaving(true)} onReturn={() => setLeaving(false)} />
    </div>
  )
}

function Fixture() {
  return (
    <div className="relative min-h-screen bg-bg text-fg text-sm">
      <div className="flex min-h-screen justify-center gap-6 px-4">
        {SURFACE !== "card" && <DrawerSurface />}
        {SURFACE !== "drawer" && <CardSurface />}
      </div>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter>
      <TooltipProvider>
        <Fixture />
      </TooltipProvider>
    </MemoryRouter>
  </QueryClientProvider>,
)
