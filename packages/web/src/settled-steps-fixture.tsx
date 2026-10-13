import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { AwaitingHint, BoardSnapshot, ThreadView as ThreadViewModel, TranscriptMessage } from "@ntwine/shared"
import { ThreadView } from "./components/ChatView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for A STEPS CARD THAT OUTLIVES ITS REST (2026-10-08, maintainer: "We need to continue showing
// the to do instructions even after they are complete & the thread has moved on"). The drawer, mounted as
// production mounts it (ThreadView, virtualized), over a transcript whose ```awaiting fence handed the
// human steps — and then, per `?at=`, where the thread has got to since:
//
//   ?at=rest     the thread is still resting on the steps — the tail's resting card states them, with Done
//   ?at=running  the human pressed Done and the worker is mid-turn (the default)
//   ?at=moved    the worker finished and rested again on a later fence of its own
//
// The transcript also carries an EARLIER settled fence with no steps — a plain shell wait — which must
// keep drawing nothing in every state: that is the negative control for the exception.

const SLUG = "settled-steps"
const PARAMS = new URLSearchParams(location.search)
const AT = PARAMS.get("at") ?? "running"
document.documentElement.dataset.font = PARAMS.get("font") === "mono" ? "mono" : "sans"

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()

const SHELL_FENCE = "```awaiting\nshells: [bzvtnt3ig]\nstatus: working\nfor: 30m\n---\nThe release build is running in the background.\n```"
const STEPS_PROSE = "The 4.2.0 tag is cut and verified. The publish step runs as the acme-bot account, and no token for it is available to this thread."
const STEPS_HINTS: AwaitingHint[] = [
  { kind: "title", value: "Sign in to npm so the acme 4.2.0 release can publish" },
  { kind: "step", value: "Run `npm login --auth-type=web` in a terminal on this machine." },
  { kind: "step", value: "Approve the browser prompt with the **acme-bot** account." },
]
const STEPS_FENCE = [
  "```awaiting",
  "title: Sign in to npm so the acme 4.2.0 release can publish",
  "steps:",
  "  - Run `npm login --auth-type=web` in a terminal on this machine.",
  "  - Approve the browser prompt with the **acme-bot** account.",
  "---",
  STEPS_PROSE,
  "```",
].join("\n")
const LATER_FENCE = "```awaiting\nprs: [acme/app#391]\nstatus: watching\nfor: 1d\n---\nPublished acme 4.2.0. Watching the follow-up PR for review.\n```"

const say = (sourceId: string, text: string, min: number) =>
  ({ sourceId, role: "assistant", text, tools: [], parts: [{ kind: "text", text }], at: ago(min) }) as unknown as TranscriptMessage
const human = (sourceId: string, text: string, min: number) =>
  ({ sourceId, role: "user", text, tools: [], parts: [], at: ago(min) }) as unknown as TranscriptMessage

const messages: TranscriptMessage[] = [
  human("u1", "Cut the acme 4.2.0 release.", 40),
  say("a1", `Building the release artifacts.\n\n${SHELL_FENCE}`, 38),
  say("a2", `The build is green.\n\n${STEPS_FENCE}`, 20),
  ...(AT === "rest" ? [] : [human("u2", "Done", 5)]),
  ...(AT === "moved" ? [say("a3", LATER_FENCE, 1)] : []),
]

const thread = {
  id: SLUG,
  title: "Cut the acme 4.2.0 release",
  status: "active",
  mechanism: null,
  humanBlocked: false,
  needsYou: AT !== "running",
  awaitingBackground: AT !== "running",
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  runtime: AT === "running" ? "running" : "turn-idle",
  sessionId: "sid-settled-steps",
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
  watches: [],
  questions: [],
  ...(AT === "rest" ? { lastFence: { kind: "awaiting", body: STEPS_PROSE, hints: STEPS_HINTS } } : {}),
  ...(AT === "moved" ? { lastFence: { kind: "awaiting", body: "Published acme 4.2.0. Watching the follow-up PR for review.", hints: [{ kind: "pr", value: "acme/app#391" }] }, waitStatus: "watching" } : {}),
  lastActivityAt: ago(1),
  spawnedAt: ago(41),
} as unknown as ThreadViewModel

store.board = { projectDir: "/fixture/ntwine", threads: [thread] } as BoardSnapshot

const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : ((input as Request).url ?? input.toString()), location.origin)
  if (url.pathname === "/_ntwine/rpc/threadTranscript" || url.pathname === "/_ntwine/rpc/threadTranscriptEarlier") {
    return new Response(
      JSON.stringify({ result: { messages, transcriptKey: `${SLUG}-${AT}`, hasEarlier: false, historyLoaded: true } }),
      { headers: { "content-type": "application/json" } },
    )
  }
  if (url.pathname === "/_ntwine/rpc/threadSettledQuestions") {
    return new Response(JSON.stringify({ result: { questions: [] } }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname.startsWith("/_ntwine/rpc/")) {
    return new Response(JSON.stringify({ result: {} }), { headers: { "content-type": "application/json" } })
  }
  return originalFetch(input, init)
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <TooltipProvider>
      <div className="relative h-screen bg-bg text-fg text-sm">
        <div className="mx-auto flex h-screen w-[760px] max-w-full flex-col border-x border-border">
          <ThreadView slug={SLUG} virtualized />
        </div>
      </div>
    </TooltipProvider>
  </QueryClientProvider>,
)
