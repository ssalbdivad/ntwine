import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useEffect } from "react"
import { createRoot } from "react-dom/client"
import { useSnapshot } from "valtio"
import type { BoardSnapshot, ThreadView as ThreadViewModel, TranscriptMessage } from "@ntwine/shared"
import { ThreadView } from "./components/ChatView.tsx"
import { SubAgentSheet } from "./components/SubAgentSheet.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { pushSubAgentDrawer, store } from "./store.ts"
import "./styles.css"

// Browser QA for the LIVE TAIL's rhythm (maintainer 2026-07-31: "there's more space above the working
// shimmer than there is below the 'Thought for 37 seconds'" — that row reads "Reasoning" now, but the
// geometry the report was about is unchanged). The reported column is reproduced exactly:
// a reasoning label, then two Agent dispatch cards, then the running Working… row. The label sits 6px
// above the first card (the tight meta run), so the shimmer under the last card must sit at 6px too —
// it is the same column of quiet activity rows, still being written.
//
// `?tail=prose` is the CONTROL: a prose-bearing message below the cards must push the shimmer back to
// the full STEP break, so the tight run stays a statement about META adjacency rather than a blanket
// "the shimmer always hugs".
//
// `?surface=child` mounts the REAL sub-agent drawer on the same transcript — the drawer runs the plain
// (non-virtualized) column, so both spacing paths are measured from one fixture.

const SLUG = "working-tail-spacing"
const PARAMS = new URLSearchParams(location.search)
const PROSE_TAIL = PARAMS.get("tail") === "prose"
const META_TAIL = PARAMS.get("tail") === "meta"
// Relative to NOW so the shimmer and the dispatch cards read the report's own durations ("1m 12s")
// instead of a years-old wall clock. Nothing here is asserted on — only the geometry is.
const AGO = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString()

const thread = {
  id: SLUG,
  title: "Fix the b14 bootstrap regressions",
  status: "running",
  statusText: "Working",
  mechanism: null,
  humanBlocked: false,
  needsYou: false,
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
  // Two LIVE children, so the dispatch cards below wear their running mark exactly as in the report.
  subAgents: [
    { id: "sa1", label: "b14_js_bootstrap_runtime", state: "running", startedAt: AGO(70) },
    { id: "sa2", label: "b14_preload_bootstrap_fork", state: "running", startedAt: AGO(69) },
  ],
  bgShells: [],
  lastActivityAt: AGO(1),
  lastUserAt: AGO(72),
  spawnedAt: AGO(900),
} as unknown as ThreadViewModel

store.board = { projectDir: "/fixture/ntwine", threads: [thread] } as BoardSnapshot

const agentCall = (agentId: string, detail: string) => ({
  name: "Agent",
  detail,
  prompt: `Reproduce ${detail} and report the failing assertion verbatim.`,
  agentId,
  status: "running",
})

const messages: TranscriptMessage[] = [
  { sourceId: "u1", role: "user", text: "Two bootstrap tests are failing on b14 — find out why.", tools: [], parts: [] },

  // The reasoning label from the report: quiet meta row, chevron flush right of the text.
  { sourceId: "r1", role: "assistant", kind: "reasoning", text: "Both failures land in the preload fork path, so the two suites should be probed independently.", durationMs: 37_000, tools: [], parts: [] },

  // Two Agent dispatch cards, one per message — the batch boundary the tight run is meant to erase.
  { sourceId: "a1", role: "assistant", text: "", tools: [], parts: [{ kind: "tools", tools: [agentCall("sa1", "b14_js_bootstrap_runtime")] }] },
  { sourceId: "a2", role: "assistant", text: "", tools: [], parts: [{ kind: "tools", tools: [agentCall("sa2", "b14_preload_bootstrap_fork")] }] },

  // CONTROL tail: prose under the cards must restore the full break above the shimmer.
  ...(PROSE_TAIL
    ? ([{ sourceId: "p1", role: "assistant", text: "Both probes are out; I'll fold their findings together when they land.", tools: [], parts: [] }] as unknown as TranscriptMessage[])
    : []),

  // REFERENCE tail: an ordinary meta label under the same cards. The shimmer is a peer of THIS row, so
  // whatever optical white the shipped rhythm gives here is what the shimmer must get too.
  ...(META_TAIL
    ? ([{ sourceId: "m1", role: "assistant", kind: "reasoning", text: "Waiting on both probes.", durationMs: 8_000, tools: [], parts: [] }] as unknown as TranscriptMessage[])
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
  if (url.pathname === "/_ntwine/rpc/subAgentTranscript") {
    return new Response(JSON.stringify({ result: { messages, state: "running" } }), {
      headers: { "content-type": "application/json" },
    })
  }
  // The transcript reads its settled registered questions; `{}` would leave that query's data undefined,
  // which React Query reports to the console and the no-errors assertion trips on.
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

function Drawers() {
  const snap = useSnapshot(store)
  let below = 0
  return (
    <>
      {snap.drawers.map((d, i) => {
        const widthDepth = below
        if (!d.closing) below++
        return d.kind === "subagent" ? (
          <SubAgentSheet key={d.id} id={d.id} slug={d.slug} subId={d.subId ?? ""} label={d.label ?? d.slug} depth={i} widthDepth={widthDepth} />
        ) : null
      })}
    </>
  )
}

function Fixture() {
  const child = PARAMS.get("surface") === "child"
  useEffect(() => {
    if (child) pushSubAgentDrawer(SLUG, "sa1", { label: "b14_js_bootstrap_runtime" })
  }, [child])
  return (
    <div className="relative h-screen bg-bg text-fg text-sm">
      <div className="mx-auto flex h-screen w-full max-w-full flex-col border-x border-border">
        {/* The PRODUCTION path: both real ThreadView callers virtualize. */}
        <ThreadView slug={SLUG} virtualized />
      </div>
      <Drawers />
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
