import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView as ThreadViewModel, TranscriptMessage } from "@ntwine/shared"
import { ThreadView } from "./components/ChatView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for the QUIET META COLUMN — the `Ran N tool calls` digest, a collapsed reasoning row and
// the live shimmer, stacked (maintainer 2026-08-01: "All of these labels are way too close together.
// Specifically, the ran 8 tool calls, the thought, and then the active shimmer").
//
// The transcript below is the REAL one from that screenshot, session 1dbbe276 records 1..51, replayed
// shape-for-shape minus the thinking rows the transcript no longer carries: an opening prose message, a
// run of 8 calls, a QUEUED steer, and a live two-call tail whose newest member supplies the shimmer's
// gerund.
//
// The queued bubble is the whole point. It renders at the BOTTOM of the pane (never inline), yet it used
// to end the activity run in coalesceToolActivityMessages — which stranded the run above as a settled
// digest for no cause the reader could see.
//
// Three controls:
//   ?steer=landed — the same column with the steer DELIVERED. Breaking the run is correct there, so the
//                   calls above it settle into their own digest.
//   ?state=settled — the turn is over, so nothing is withheld: the whole run returns as one digest.
//   ?stack=three   — THREE bare labels in a row, which is the arrangement the report was actually about.
//                   It survives the queued-steer fix because a Codex `reasoning` row is deliberately NOT
//                   folded into a run (it carries real content and is already its own disclosure), so it
//                   splits one: digest → reasoning label → the live tail's shimmer. Codex thinks before
//                   nearly every call, so this is the COMMON shape, not an edge case — it is the one to
//                   judge the label rhythm on.

const SLUG = "meta-column-rhythm"
const PARAMS = new URLSearchParams(location.search)
const STEER_LANDED = PARAMS.get("steer") === "landed"
const SETTLED = PARAMS.get("state") === "settled"
const THREE_STACK = PARAMS.get("stack") === "three"
const AGO = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString()

// The report came from a sans instance, and the type family decides where a row's ink sits inside its
// line box — so a mono fixture would be reviewing a different column than the one that was reported.
// `?font=mono` is the other half of the matrix (lib/font.ts owns this attribute in the real app).
document.documentElement.dataset.font = PARAMS.get("font") === "mono" ? "mono" : "sans"

const thread = {
  id: SLUG,
  title: "npx ntwine tmux socket ownership failure",
  status: SETTLED ? "idle" : "running",
  statusText: SETTLED ? "Idle" : "Working",
  mechanism: null,
  humanBlocked: false,
  needsYou: false,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  runtime: SETTLED ? "turn-idle" : "running",
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
  lastActivityAt: AGO(1),
  lastUserAt: AGO(130),
  spawnedAt: AGO(400),
} as unknown as ThreadViewModel

store.board = { projectDir: "/Users/colinmcd94/Documents/projects/ntwine", threads: [thread] } as BoardSnapshot

const bash = (desc: string, command: string, status?: string) => ({ name: "Bash", detail: command, command, desc, status })

const messages = [
  {
    sourceId: "m0",
    role: "user",
    text: "A user hit this on `npx ntwine`: a tmux socket ownership failure — the socket exists but is owned by another uid, or a canonical-root collision.",
    tools: [],
    parts: [],
    at: AGO(400),
  },
  {
    sourceId: "m1",
    role: "assistant",
    text: "I'll start by understanding this error — a user hit a tmux socket ownership failure on `npx ntwine`.",
    tools: [],
    parts: [
      { kind: "text", text: "I'll start by understanding this error — a user hit a tmux socket ownership failure on `npx ntwine`." },
      {
        kind: "tools",
        tools: [
          bash("Searching for the ownership error string", "grep -rn 'socket ownership' --include='*.ts' packages/"),
          bash("Reading recent history and root package files", "git log --oneline -20; cat package.json"),
        ],
      },
    ],
    at: AGO(390),
  },
  { sourceId: "m2", role: "assistant", text: "", tools: [], parts: [{ kind: "tools", tools: [bash("Searching for the ownership error string", "grep -rn 'is owned by uid' packages/server/src")] }], at: AGO(380) },
  { sourceId: "m3", role: "assistant", text: "", tools: [], parts: [{ kind: "tools", tools: [{ name: "Read", detail: "/Users/colinmcd94/Documents/projects/ntwine/packages/server/src/tmux.ts" }] }], at: AGO(360) },
  {
    sourceId: "m5",
    role: "assistant",
    text: "",
    tools: [],
    parts: [
      {
        kind: "tools",
        tools: [
          bash("Finding where tmux ownership markers get written", "grep -rn 'ownershipMarker' packages/server/src"),
          bash("Checking for a tmux preflight check", "grep -rn 'preflight' packages/server/src | head -20"),
        ],
      },
    ],
    at: AGO(300),
  },
  { sourceId: "m6", role: "assistant", text: "", tools: [], parts: [{ kind: "tools", tools: [bash("Probing tmux inspect behavior with and without the socket", "tmux -L probe list-sessions; echo EXIT=$?")] }], at: AGO(260) },
  { sourceId: "m7", role: "assistant", text: "", tools: [], parts: [{ kind: "tools", tools: [bash("Probing inspect with tmux absent from PATH", "env PATH=/usr/bin nub scripts/inspect.mjs; echo EXIT=$?")] }], at: AGO(200) },
  // The three-label stack: a Codex reasoning row splits the run, so the digest above it settles, the row
  // itself is a second label, and the live tail below supplies the third.
  ...(THREE_STACK
    ? ([{
        sourceId: "r1",
        role: "assistant",
        kind: "reasoning",
        text: "The resolver is called from two places, and only one of them normalizes the canonical root first.",
        durationMs: 33_000,
        tools: [],
        parts: [],
        at: AGO(150),
      }] as unknown as TranscriptMessage[])
    : []),
  ...(THREE_STACK
    ? []
    : ([{
        sourceId: "m8",
        role: "user",
        text: "So we still require TMUX? Is that true for both Claude Code and Codex?",
        tools: [],
        parts: [],
        at: AGO(160),
        ...(STEER_LANDED ? {} : { queued: true }),
      }] as unknown as TranscriptMessage[])),
  {
    sourceId: "m10",
    role: "assistant",
    text: "",
    tools: [],
    parts: [
      {
        kind: "tools",
        tools: [
          bash("Locating the CLI entry point", "ls src/ 2>/dev/null | head -40; grep -rn 'ntwine.js' package.json", SETTLED ? "completed" : "pending"),
          bash("Finding callers of the socket resolver", "grep -rn 'resolveProjectTmuxSocket' --include='*.ts' packages/ | head -30", SETTLED ? "completed" : "pending"),
        ],
      },
    ],
    at: AGO(130),
  },
  ...(THREE_STACK
    ? []
    : ([{
        sourceId: "m11",
        role: "user",
        text: "Why do we need it exactly? I thought we'd investigated how T3 code works, and they don't use TMUX. They use node PTY. What exactly led us to continue using TMUX?",
        tools: [],
        parts: [],
        at: AGO(20),
        queued: true,
      }] as unknown as TranscriptMessage[])),
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

function Fixture() {
  return (
    <div className="relative h-screen bg-bg text-fg text-sm">
      <div className="mx-auto flex h-screen w-full max-w-full flex-col border-x border-border">
        {/* The PRODUCTION path: both real ThreadView callers virtualize. */}
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
