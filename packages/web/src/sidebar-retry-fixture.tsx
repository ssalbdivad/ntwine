import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardSnapshot, ThreadView } from "@ntwine/shared"
import { ThreadRow, type RowScope } from "./components/Sidebar.tsx"
import { Toaster } from "./components/Toaster.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Where a row's click leads. This page only draws rows; every real row has a scope (ProjectList.tsx).
const ROW_SCOPE: RowScope = { open: () => {}, page: true }

// The sidebar's one-click recovery verb: a STOPPED row (an exited session) — and a row KILLED by a
// usage limit ntwine will auto-resume — expose a hover-revealed Retry on the right edge. This fixture
// renders the REAL ThreadRow for the two stopped rows (a [!] stalled crash AND a […] exited-at-rest)
// and the limit-killed row (the YELLOW hourglass — accent like the [!], since 2026-08-31), plus — for
// contrast — a live working row and a live turn-idle resting row (neither may grow the button).
// Clicking Retry POSTs the ordinary
// follow-up; we stub /rpc/followUp so the click drives the real retrySession → showToast → Toaster path
// end to end and records that the RPC actually fired.

const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const url = new URL(requestUrl, window.location.href)
  if (url.pathname === "/_ntwine/rpc/followUp") {
    const body = JSON.parse(String(init?.body ?? "{}"))
    const log = JSON.parse(window.sessionStorage.getItem("followUpCalls") ?? "[]")
    log.push(body)
    window.sessionStorage.setItem("followUpCalls", JSON.stringify(log))
    return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  }
  // Retry is an ordinary eager send, which also fires markRead for the slug — stub it so the click path
  // runs clean (no stray 404) exactly as it does against the real server.
  if (url.pathname === "/_ntwine/rpc/markRead") {
    return new Response(JSON.stringify({ result: {} }), { headers: { "content-type": "application/json" } })
  }
  return nativeFetch(input, init)
}

const base = {
  kind: "session",
  backend: "claude",
  titleAuto: false,
  humanBlocked: false,
  pendingAsk: false,
  pendingQuestion: false,
  archived: false,
  foreign: false,
  state: "open",
  subAgents: [],
  bgShells: [],
  spawnedAt: "2026-07-23T09:00:00.000Z",
  lastAssistantAt: "2026-07-23T12:00:00.000Z",
} as const

// A worker that EXITED mid-turn — the [!] stalled state. This row gets the hover Retry.
const stalledThread = {
  ...base,
  id: "stalled-migration",
  title: "Migrate the tailer launch-race fix onto every backend",
  runtime: "exited",
  status: "active",
  crashed: true,
  needsYou: true,
} as unknown as ThreadView

// A worker whose process EXITED after resting WITHOUT a done fence — the […] at-rest mark, not a crash.
// The drawer offered Retry (canRetry) but the rail did not; now this stopped row gets the hover Retry too.
const exitedAtRestThread = {
  ...base,
  id: "exited-at-rest",
  title: "Draft the changelog",
  runtime: "exited",
  status: "active",
  crashed: false,
  needsYou: true,
} as unknown as ThreadView

// A worker KILLED because it hit its session limit, which ntwine will auto-resume when the window
// resets. It wears the YELLOW hourglass — accent like the stalled [!], hourglass because a wake is
// coming — and queues (needsYou), with the same hover Retry as a stall (maintainer 2026-08-31: every
// yellow row carries the hover Retry).
const limitKilledThread = {
  ...base,
  id: "limit-killed",
  title: "Rework the session-limit banner",
  runtime: "exited",
  status: "active",
  crashed: false,
  needsYou: true,
  limitPause: { backend: "claude", window: "session", at: "2026-07-23T00:00:00.000Z", autoResume: true },
} as unknown as ThreadView

// A live worker — spinner, NO retry (retrying would interrupt real work).
const workingThread = {
  ...base,
  id: "working-audit",
  title: "Audit the quota read path",
  runtime: "running",
  status: "active",
  crashed: false,
  needsYou: false,
} as unknown as ThreadView

// An ordinary rested worker — ellipsis, NO retry (it did not stall).
const restingThread = {
  ...base,
  id: "resting-notes",
  title: "Jot the release notes",
  runtime: "turn-idle",
  status: "active",
  crashed: false,
  needsYou: false,
} as unknown as ThreadView

store.board = { threads: [stalledThread, exitedAtRestThread, limitKilledThread, workingThread, restingThread] } as BoardSnapshot

// Retry is an ordinary eager send now (lib/retrySession → sendEagerFollowUp), so it writes the
// optimistic bubble into the transcript cache — the row needs a real client, exactly as the app gives it.
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <TooltipProvider>
      <main className="min-h-screen bg-bg px-10 py-10 text-fg">
        <div data-sidebar-rail className="w-[clamp(320px,34vw,680px)]">
          <ThreadRow scope={ROW_SCOPE} t={stalledThread} />
          <ThreadRow scope={ROW_SCOPE} t={exitedAtRestThread} />
          <ThreadRow scope={ROW_SCOPE} t={limitKilledThread} />
          <ThreadRow scope={ROW_SCOPE} t={workingThread} />
          <ThreadRow scope={ROW_SCOPE} t={restingThread} />
        </div>
        <Toaster />
      </main>
    </TooltipProvider>
  </QueryClientProvider>,
)
