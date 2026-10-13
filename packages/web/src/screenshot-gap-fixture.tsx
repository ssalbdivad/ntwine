import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView as ThreadViewModel, TranscriptMessage } from "@ntwine/shared"
import { ThreadView } from "./components/ChatView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for the space UNDER a rendered PICTURE card — the one card in the transcript that is a big
// visual mass rather than a one-line band (maintainer 2026-08-11, on an image `Read` followed by the
// live shimmer: "we need better spacing under the screenshots … it's too close").
//
// The picture card is a tool-activity EXCEPTION (lib/toolActivity), so every spacing predicate used to
// see "a card" and charge the tight run's 6px — the pitch that exists to erase the seam between two
// compact bands. Under a picture that pitch glues the next row to the frame's bottom edge.
//
// The picture card is a SendUserFile delivery now, drawn open as a gallery. An image `Read` was one
// until 2026-10-03, when the maintainer folded every picture a tool merely returned into the collapsed
// digest ("No images or screenshots are visible unless you make them visible to the user with the light
// box"); `?case=folded` pins that it is an ordinary label row now, spaced like one.
//
// The GAPS are readable on a plain Vite dev server — they are decided by the tool's `sentImages`
// field, not by whether the bytes arrived (pictureSpacing.e2e.test.ts asserts them there). To SEE the
// frames, the picture has to load, and `/local-image` is not something Vite serves: run
// `scripts/adhoc-stack.mjs`, proxy `/_ntwine` at it from the Vite server, and pass `?shot=<abs path>` to
// a real PNG under a trusted root (the OS temp dir is one). Without that, the gallery lists its path as
// text — which is honest, but it is not the mass this page exists to judge.
//
//   ?case=shimmer (default) — picture → the live shimmer. The reported shape.
//   ?case=folded            — an image `Read` → the live shimmer: a folded label row, no picture in sight.
//   ?case=cards             — two pictures stacked, then an ordinary tool band. The pitch BETWEEN
//                             pictures, and out of one into a compact band.
//   ?case=prose             — picture → assistant prose, which already took the full step.
//   ?case=prose-picture     — the two ways a worker EMBEDS a shot in its own prose, in one message: a
//                             Markdown `![](…)` and a bare absolute PATH. They must render as ONE
//                             object (see ImageFrame), so both keep the PROSE rhythm — the picture step
//                             is for the tool CARD, which is its own transcript object rather than part
//                             of the sentence introducing it. This page is where that is checked.
//   ?case=control           — the SAME shapes with no picture in them: two background-op cards batched,
//                             then the shimmer. Both must still sit at the tight run, which is what
//                             proves PICTURE_STEP is charged to pictures and not to every exception.
//   ?font=mono              — the other type family (lib/font.ts owns this attribute in the real app).

const SLUG = "screenshot-gap"
const PARAMS = new URLSearchParams(location.search)
const CASE = PARAMS.get("case") ?? "shimmer"
const LIVE = CASE === "shimmer" || CASE === "control" || CASE === "folded"
const AGO = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString()
const SHOT = PARAMS.get("shot") ?? "/tmp/ntwine-shot-gap/report.png"

document.documentElement.dataset.font = PARAMS.get("font") === "mono" ? "mono" : "sans"

const thread = {
  id: SLUG,
  title: "spacing under the screenshots",
  status: LIVE ? "running" : "idle",
  statusText: LIVE ? "Working" : "Idle",
  mechanism: null,
  humanBlocked: false,
  needsYou: false,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  runtime: LIVE ? "running" : "turn-idle",
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

const bash = (desc: string, command: string, status = "completed") => ({ name: "Bash", detail: command, command, desc, status })
const picture = (caption: string) => ({ name: "SendUserFile", detail: caption, sentImages: [SHOT], caption, status: "completed", durationMs: 120 })
const imageRead = (detail: string) => ({ name: "Read", detail, outputImage: SHOT, status: "completed", durationMs: 120 })
// A background op: an exception card like the picture, but a COMPACT one — so it is the control that
// keeps the tight run.
const background = (desc: string, command: string) => ({ ...bash(desc, command, "pending"), backgroundState: "background" })

const tail: TranscriptMessage[] = (
  CASE === "prose-picture"
    ? ([
        {
          sourceId: "m3",
          role: "assistant",
          text: "",
          tools: [],
          parts: [{
            kind: "text",
            text: [
              "The shot a worker embeds in its own handoff, both ways it can write one.",
              "",
              "As MARKDOWN — a block inside the prose body, spaced by that body's own paragraph rhythm:",
              "",
              `![the reported spacing](${SHOT})`,
              "",
              "As a BARE PATH — its own block in the transcript's rhythm, so it takes the picture step:",
              "",
              SHOT,
              "",
              "Prose closing the message, so both pictures have a neighbour below as well as above.",
            ].join("\n"),
          }],
          at: AGO(40),
        },
      ] as unknown as TranscriptMessage[])
    : CASE === "folded"
    ? ([
        { sourceId: "m3", role: "assistant", text: "", tools: [], parts: [{ kind: "tools", tools: [imageRead("/tmp/ntwine-shot-gap/report.png")] }], at: AGO(40) },
      ] as unknown as TranscriptMessage[])
    : CASE === "control"
    ? ([
        {
          sourceId: "m3",
          role: "assistant",
          text: "",
          tools: [],
          parts: [{ kind: "tools", tools: [background("Booting a disposable stack", "nub scripts/adhoc-stack.mjs --port=4938"), background("Starting the fixture dev server", "nub .fixture-dev-tmp.mjs")] }],
          at: AGO(40),
        },
      ] as unknown as TranscriptMessage[])
    : CASE === "cards"
    ? ([
        { sourceId: "m3", role: "assistant", text: "", tools: [], parts: [{ kind: "tools", tools: [picture("Before"), picture("After")] }], at: AGO(40) },
        { sourceId: "m4", role: "assistant", text: "", tools: [], parts: [{ kind: "tools", tools: [bash("Measuring the ink gap under the frame", "nub scripts/ink-gaps.mjs --url=http://127.0.0.1:4930/")] }], at: AGO(20) },
      ] as unknown as TranscriptMessage[])
    : CASE === "prose"
      ? ([
          { sourceId: "m3", role: "assistant", text: "", tools: [], parts: [{ kind: "tools", tools: [picture("The report")] }], at: AGO(40) },
          { sourceId: "m4", role: "assistant", text: "The card sits flush against the picture — the frame's bottom border and the next row read as one object.", tools: [], parts: [{ kind: "text", text: "The card sits flush against the picture — the frame's bottom border and the next row read as one object." }], at: AGO(20) },
        ] as unknown as TranscriptMessage[])
      : ([
          { sourceId: "m3", role: "assistant", text: "", tools: [], parts: [{ kind: "tools", tools: [picture("The report")] }], at: AGO(40) },
        ] as unknown as TranscriptMessage[])
)

const messages = [
  {
    sourceId: "m0",
    role: "user",
    text: "we need better spacing under the screenshots. this is a READ tool call i believe, followed by the summary shimmer",
    tools: [],
    parts: [],
    at: AGO(400),
  },
  {
    sourceId: "m1",
    role: "assistant",
    text: "I'll start by looking at the screenshot.",
    tools: [],
    parts: [
      { kind: "text", text: "I'll start by looking at the screenshot." },
      { kind: "tools", tools: [bash("Searching for the shimmer summary component", "grep -rn 'tool calls' --include='*.tsx' packages/web/src")] },
    ],
    at: AGO(200),
  },
  ...tail,
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
  // The thread view reads its answered questions on mount; an empty object would hand React Query an
  // undefined list, which it logs as an error.
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
