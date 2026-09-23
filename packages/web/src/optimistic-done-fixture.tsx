import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView as ThreadViewModel, TranscriptMessage } from "@frizz/shared"
import { TodosView } from "./components/TodosView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA proving the Mark-as-done OPTIMISTIC dismissal: the card must begin fading the INSTANT it is
// clicked, decoupled from (and BEFORE) the completeThread RPC round-trip — not after it. To make that
// observable we DELIBERATELY DELAY the completeThread response (RPC_DELAY_MS) and instrument the timings,
// so a driver can check the card is already `data-queue-leaving="true"` long before the RPC resolves.
// This renders the REAL TodosView / QueueCard / StateButton; only the network is stubbed (that stub is the
// point — it lets us control latency to prove the fade no longer waits on it).

const RPC_DELAY_MS = 1500

const CARDS = [
  { id: "auth-refresh", title: "Silent token refresh on 401" },
  { id: "csv-export", title: "Streaming CSV export for large tables" },
  { id: "flaky-e2e", title: "Flaky checkout e2e in CI" },
]

// A resting, done-fenced thread: needsYou (so it queues), turn-idle runtime with no live background work
// (so completionArchivesImmediately → optimistic path), and a ```done fence (so the in-card white
// "Mark as done" button renders too, exercising the QueueDismissContext dismiss/cancel wiring).
function makeThread(id: string, title: string): ThreadViewModel {
  return {
    id,
    title,
    status: "done",
    statusText: "Completed",
    mechanism: null,
    humanBlocked: false,
    needsYou: true,
    ready: false,
    dependsOn: [],
    externalDeps: [],
    agents: [],
    errors: [],
    warnings: [],
    runtime: "turn-idle",
    unread: false,
    archived: false,
    hasPlan: false,
    pendingQuestion: false,
    kind: "session",
    foreign: false,
    backend: "claude",
    permissionMode: "default",
    state: "open",
    subAgents: [],
    bgShells: [],
    lastFence: { kind: "done", body: "Shipped the fix and the regression test; gates green.", hints: [] },
    lastActivityAt: new Date().toISOString(),
    lastAssistantAt: new Date().toISOString(),
    spawnedAt: new Date().toISOString(),
  } as unknown as ThreadViewModel
}

const threads = CARDS.map((c) => makeThread(c.id, c.title))
store.board = { projectDir: "/fixture/frizz", threads } as BoardSnapshot
// A driver delivers a message into a thread by bumping its `lastUserAt` through the live store, the same
// field the real board refresh moves when the human sends one.
;(window as unknown as { __deliverMessage: (slug: string) => void }).__deliverMessage = (slug) => {
  const thread = store.board!.threads.find((t) => t.id === slug)!
  thread.lastUserAt = new Date().toISOString()
}

function transcriptFor(slug: string, title: string): { messages: TranscriptMessage[]; transcriptKey: string; hasEarlier: boolean; historyLoaded: boolean } {
  const body = `**${title}** — implemented, verified, and self-reviewed.\n\n\`\`\`done\nShipped the fix and the regression test; gates green.\n\`\`\``
  const messages: TranscriptMessage[] = [
    { sourceId: `${slug}-u1`, role: "user", text: `Please handle: ${title}.`, tools: [], parts: [] },
    { sourceId: `${slug}-a1`, role: "assistant", text: body, tools: [], parts: [{ kind: "text", text: body }] },
  ]
  return { messages, transcriptKey: `${slug}-key`, hasEarlier: false, historyLoaded: false }
}

function slugFromBody(init?: RequestInit): string | null {
  try {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null
    return body?.slug ?? body?.params?.slug ?? null
  } catch {
    return null
  }
}

// Timing telemetry a driver reads to prove the ordering: fade (leaving) must flip BEFORE completeResolvedAt.
interface RpcTelemetry {
  delayMs: number
  completeCalledAt: number | null
  completeResolvedAt: number | null
}
const telemetry: RpcTelemetry = { delayMs: RPC_DELAY_MS, completeCalledAt: null, completeResolvedAt: null }
;(window as unknown as { __rpc: RpcTelemetry }).__rpc = telemetry

const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.origin)
  if (url.pathname === "/_frizz/rpc/threadTranscript" || url.pathname === "/_frizz/rpc/threadTranscriptEarlier") {
    const slug = slugFromBody(init) ?? CARDS[0].id
    const card = CARDS.find((c) => c.id === slug) ?? CARDS[0]
    return new Response(JSON.stringify({ result: transcriptFor(card.id, card.title) }), { headers: { "content-type": "application/json" } })
  }
  // The action under test. FAITHFUL to production timing: the real server does real teardown work (stop
  // the resting worker + prove it stopped) before responding, THEN board.refresh() drops the row. We model that
  // with a fixed delay and prune the board only when the (delayed) response resolves. The card must already
  // be fading well before this point — that is the whole fix.
  if (url.pathname === "/_frizz/rpc/completeThread") {
    const slug = slugFromBody(init)
    telemetry.completeCalledAt = performance.now()
    // ?needsConfirmation=1 models a mispredict / executing turn. FAITHFUL to the server: it returns
    // needsConfirmation from a cheap liveness + telemetry check BEFORE any worker teardown, so this path is FAST
    // (well under the ~320ms card-exit window) — the optimistically-dismissed card is still mounted and must
    // reinstate (onDismissCancel → unresolve) and open the "End this session?" dialog. Nothing is archived.
    if (new URLSearchParams(location.search).get("needsConfirmation") === "1") {
      await new Promise((resolve) => setTimeout(resolve, 90))
      telemetry.completeResolvedAt = performance.now()
      // The decline carries the server's EVIDENCE (completionConfirmationHold), so the dialog names the
      // work Done is about to kill instead of the useless "this thread is still running".
      const hold = {
        turnInFlight: false,
        unobservable: false,
        subAgents: [{ label: "Audit the refresh-token rotation", state: "running" }],
        subAgentCount: 1,
        bgShells: [{ label: "Watch origin/main CI", state: "running" }, { label: "vite dev server", state: "stale" }],
        bgShellCount: 2,
      }
      return new Response(JSON.stringify({ result: { needsConfirmation: true, hold } }), { headers: { "content-type": "application/json" } })
    }
    // The real completion path does real teardown work (stop the worker + prove it stopped) before responding,
    // THEN board.refresh() drops the row — modelled by the fixed delay + prune. The card must already be
    // fading well before this point.
    await new Promise((resolve) => setTimeout(resolve, RPC_DELAY_MS))
    if (slug && store.board) {
      store.board = { ...store.board, threads: store.board.threads.filter((t) => t.id !== slug) } as BoardSnapshot
    }
    telemetry.completeResolvedAt = performance.now()
    return new Response(JSON.stringify({ result: { needsConfirmation: false } }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname.startsWith("/_frizz/rpc/")) {
    return new Response(JSON.stringify({ result: {} }), { headers: { "content-type": "application/json" } })
  }
  return originalFetch(input, init)
}

function Fixture() {
  return (
    <div className="relative min-h-screen bg-bg text-fg text-sm">
      <div className="flex min-h-screen justify-center">
        <main className="w-[720px] max-w-[62vw] min-w-0 flex flex-col py-5 min-h-screen max-[800px]:w-full max-[800px]:max-w-none">
          <TodosView />
        </main>
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
