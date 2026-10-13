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

// Browser QA for the TOOL-ROW RHYTHM (maintainer 2026-07-27: "there's a bigger gap between independent
// batches as opposed to within a batch"). The invariant: two adjacent tool cards sit at the SAME pitch
// whether they were batched inside one assistant message or split across successive ones — the tailer
// chunks a burst of calls arbitrarily, so the chunking must be invisible.
//
// The transcript below deliberately mixes every chunking shape in one column, so a single measurement
// pass over `.ntwine-bash` cards catches any boundary that reads wider than the intra-batch run:
//   • a 3-call batch in ONE message (intra-batch pitch, the reference)
//   • a following message that is ONE call (batch boundary)
//   • a following message that is a 2-call batch (batch boundary + intra)
//   • a message whose parts are text-then-tools (a "let me check:" lead-in) after a tool-only message
//   • a message with TWO tools parts separated by nothing renderable
// Prose / user-bubble adjacency is included as the CONTROL: those boundaries must KEEP their STEP.

const SLUG = "tool-batch-spacing"
const PARAMS = new URLSearchParams(location.search)
const SETTLED = PARAMS.get("state") === "settled"
// The INTER-CALL GAP: the turn is still running, but the last call's result has landed and the model is
// reasoning over it. Same transcript as the live state save for that one status, so the pair isolates
// exactly what the tail's status decides — the bottom slot reverts to the generic `Thinking…` reading
// while history still shows no digest for the run (lib/toolActivity.liveToolActivityTail).
const GAP = PARAMS.get("state") === "gap"
// `?bg=finished` — the background shell's completion has landed. Its card was the reader's handle on a
// process still running; finished, it is history and folds into the run around it (2026-09-13: "Fold it
// once finished"), so the digest/card/digest arrangement the default pins becomes ONE digest.
const BG_FINISHED = PARAMS.get("bg") === "finished"

const thread = {
  id: SLUG,
  title: "Run background sleep process and monitor completion",
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
  runtime: SETTLED ? "idle" : "running",
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
  lastActivityAt: "2026-07-27T10:00:00.000Z",
  spawnedAt: "2026-07-27T09:00:00.000Z",
} as unknown as ThreadViewModel

store.board = { projectDir: "/fixture/ntwine", threads: [thread] } as BoardSnapshot

const call = (over: Record<string, unknown>) => ({ name: "Bash", status: "completed", durationMs: 1200, ...over })

const toolsPart = (tools: Record<string, unknown>[]) => ({ kind: "tools", tools })
const textPart = (text: string) => ({ kind: "text", text })

const messages: TranscriptMessage[] = [
  { sourceId: "u1", role: "user", text: "Run `sleep 45` in the background, then poll until it finishes.", tools: [], parts: [] },

  // Prose then a single call — the CONTROL boundary above the card (must stay STEP).
  {
    sourceId: "a1",
    role: "assistant",
    text: "",
    tools: [],
    parts: [
      textPart("I'll start the background sleep and poll until it completes."),
      toolsPart([call({ name: "Bash", command: "sleep 45 &", desc: "Sleep 45 seconds in background" })]),
    ],
  },

  // ONE message, THREE calls — the intra-batch reference pitch.
  {
    sourceId: "a2",
    role: "assistant",
    text: "",
    tools: [],
    parts: [
      toolsPart([
        call({ name: "ToolSearch", detail: "select:Monitor,TaskGet", durationMs: 3 }),
        call({ name: "Monitor", detail: 'while pgrep -f "sleep 45" >/dev/null 2>&1; do sleep 2; done', status: "cancelled" }),
        call({ name: "Read", read: "…excerpt…", detail: "/private/tmp/claude-501/out.log", durationMs: 10 }),
      ]),
    ],
  },

  // A SEPARATE message with one call. Provider batching is presentation-transparent, so this still
  // belongs to the activity run that started in a1.
  {
    sourceId: "a3",
    role: "assistant",
    text: "",
    tools: [],
    // A LIVE background launch DOES fracture the run into digest/card/digest, and since 2026-08-01 that is
    // the point rather than a defect: a detached process outlives the batch that started it, so its card
    // is ejected from the activity disclosure and stays visible ("It's important that those show up in
    // the chat" — see lib/toolActivity.isToolActivityException). Only while it runs, though: a finished
    // one folds back into the run (2026-09-13, `?bg=finished` above), so this row stays `pending` by
    // default — a detached process that outlives even the settled turn — to keep the arrangement it
    // pins: a real layout case, so this fixture pins ITS pitch too: the ejected card must join the
    // tight 6px run rather than opening a paragraph break either side of itself.
    parts: [toolsPart([call({
      name: "Bash",
      command: "wait %1",
      desc: "Waiting for background sleep 45",
      backgroundState: "background",
      status: BG_FINISHED ? "completed" : "pending",
      durationMs: BG_FINISHED ? 45_000 : undefined,
    })])],
  },

  // Another separate message, this time a 2-call batch (boundary + intra in one message).
  {
    sourceId: "a4",
    role: "assistant",
    text: "",
    tools: [],
    parts: [
      toolsPart([
        call({ name: "Grep", detail: "sleep-45-done", durationMs: 40 }),
        call({ name: "Glob", detail: "/private/tmp/**/out.log", durationMs: 8 }),
      ]),
    ],
  },

  // A message whose parts are text-then-tools, following a tool-only message: the boundary ABOVE the
  // prose is a control (STEP); the boundary between the prose and its own tool band is also STEP.
  {
    sourceId: "a5",
    role: "assistant",
    text: "",
    tools: [],
    parts: [
      textPart("Confirming the marker file landed."),
      toolsPart([call({ name: "Read", read: "sleep-45-done", detail: "/private/tmp/out.log", durationMs: 6 })]),
    ],
  },

  // Two adjacent TOOLS parts inside one message (the server coalesces contiguous same-kind blocks, but
  // a text part that renders nothing can still split a run) — must read as one batch, not two.
  ...(PARAMS.get("split") === "0"
    ? []
    : ([
        {
          sourceId: "a6",
          role: "assistant",
          text: "",
          tools: [],
          parts: [
            toolsPart([call({ name: "Bash", command: "ls -la", desc: "List the temp dir" })]),
            textPart("   "),
            toolsPart([call({
              name: "Bash",
              command: "cd /fixture/ntwine && actionlint .github/workflows/release.yml .github/workflows/ci.yml",
              // Noun-phrase descriptions occur in real Claude Bash calls. The authored description
              // must still beat the command fallback even though it is not already a gerund.
              desc: "Final workflow validation",
              // The run's tail, and therefore whatever the bottom slot reads. Pending in the live state
              // (the gerund owns the slot), completed in `settled` AND in `gap` — the latter is the whole
              // point of that state: a landed result while the turn runs on hands the slot back to
              // `Thinking…` without letting the run's digest into history.
              status: SETTLED || GAP ? "completed" : "pending",
            })]),
          ],
        },
      ] as unknown as TranscriptMessage[])),
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
  // The SUB-AGENT DRAWER reads its child's transcript from its own RPC — same messages, so the two
  // surfaces are directly comparable.
  if (url.pathname === "/_ntwine/rpc/subAgentTranscript") {
    return new Response(JSON.stringify({ result: { messages, state: SETTLED ? "done" : "running" } }), {
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

// ?surface=child mounts the REAL sub-agent drawer over the thread, on the same messages: a child's own
// transcript is nearly all tool calls, so it is the surface where an inter-message gap that differs
// from the intra-batch run is most visible.
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
    if (child) pushSubAgentDrawer(SLUG, "child-1", { label: "Sweep the call sites" })
  }, [child])
  return (
    <div className="relative h-screen bg-bg text-fg text-sm">
      <div className="mx-auto flex h-screen w-full max-w-full flex-col border-x border-border">
        <ThreadView slug={SLUG} />
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
