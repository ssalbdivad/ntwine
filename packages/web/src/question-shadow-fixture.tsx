import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, RegisteredQuestionView, ThreadView as ThreadViewModel, TranscriptMessage } from "@ntwine/shared"
import { ThreadView } from "./components/ChatView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for the FOLD of a ```question fence into the registered question it restates
// (lib/questionShadow): the thread page, with the transcript shape of the 2026-08-28 report — the worker
// fenced a release go/no-go, a watcher's wake buried it, it registered the question with `ask`, then
// re-fenced it at sign-off. One card must render at the tail: the registered one, with its ×.
//
//   (default)      — the final fence RESTATES the registration ⇒ one card, and one Send answers.
//   ?different=1   — the final fence asks ANOTHER question ⇒ two cards, each answerable: the fold
//                    never hides a question the human has not seen elsewhere.
//   ?virtualized=1 — the thread page's virtualized transcript path. Same expectations. (A `?view=`
//                    switch chose the board's queue card until that card was deleted, 2026-09-28.)
//   ?font=sans     — the other of the two fonts this app renders in.
const params = new URLSearchParams(location.search)
document.documentElement.dataset.font = params.get("font") === "sans" ? "sans" : "mono"
const at = (min: number) => new Date(Date.UTC(2026, 7, 28, 17, min)).toISOString()

const RELEASE: RegisteredQuestionView = {
  id: "qst_6b9bdbe563fa",
  askedAt: at(11),
  spec: {
    header: "Cut 4.5.0",
    question: "Cut 4.5.0 now? The memoizer opt-in PR #6482 is still open, and the published announcement documents its API (z.config({ memoizer: z.memoizer() })) in the Zod Mini tab.",
    kind: "question",
    options: [
      { label: "Merge #6482, then cut 4.5.0", description: "Its CI is green and it is mergeable; the release then includes the memoizer API the post documents.", recommended: true },
      { label: "Cut 4.5.0 without #6482", description: "The Zod Mini memoizer tab gets stripped from the announcement first; the API ships in a later 4.5.x." },
      { label: "Hold the release", description: "Nothing is bumped until further instruction." },
    ],
  },
}

const FIRST_FENCE = [
  "On cutting 4.5.0 — one blocker to resolve first: **#6482** (the `z.memoizer()` opt-in) is still open, and the now-merged announcement documents that API in the Zod Mini cyclical tab.",
  "",
  "```question",
  "Cut 4.5.0 now? The memoizer opt-in PR #6482 is still open, and the published announcement documents its API (`z.config({ memoizer: z.memoizer() })`) in the Zod Mini tab.",
  "",
  "- A. Merge #6482 first, then bump the three version files to 4.5.0 and push — the release includes the memoizer API the post documents (recommended)",
  "- B. Cut 4.5.0 without #6482 — the Zod Mini memoizer tab gets stripped from the announcement first, and the API ships in a later 4.5.x",
  "- C. Hold the release — nothing is bumped until further instruction",
  "```",
].join("\n")

const RESTATED = [
  "Cut 4.5.0 now? The memoizer opt-in PR #6482 is still open, and the published announcement documents its API (`z.config({ memoizer: z.memoizer() })`) in the Zod Mini tab. (also on the board as a card)",
  "",
  "- A. Merge #6482 first, then bump to 4.5.0 and push — the release includes the memoizer API the post documents (recommended)",
  "- B. Cut 4.5.0 without #6482 — the Zod Mini memoizer tab gets stripped from the announcement first; the API ships in a later 4.5.x",
  "- C. Hold the release — nothing is bumped until further instruction",
].join("\n")

const DIFFERENT = [
  "Which npm dist-tag should 4.5.0 publish under?",
  "",
  "- A. `latest` — it is the stable line now (recommended)",
  "- B. `next` — hold `latest` at 4.4.3 for a week",
].join("\n")

const FINAL = [
  "Everything is staged for the cut: the three version files on `main` all read 4.4.3, so the bump is `4.4.3 → 4.5.0`, committed as `4.5.0` and pushed to `main` — that push triggers the npm + JSR publish. The go/no-go card on the board is the only thing between here and that push.",
  "",
  "```question",
  params.get("different") === "1" ? DIFFERENT : RESTATED,
  "```",
].join("\n")

const text = (t: string) => ({ tools: [], parts: [{ kind: "text" as const, text: t }] })
const messages: TranscriptMessage[] = [
  { role: "user", text: "Start gearing up for the 4.5 release.", at: at(0), ...text("Start gearing up for the 4.5 release.") },
  { role: "assistant", sourceId: "fence-1", text: FIRST_FENCE, at: at(5), ...text(FIRST_FENCE) },
  { role: "user", text: "⏰ arktypeio/arktype#6481 was MERGED.\n\n(This watcher is spent — there is nothing further to report on a finished PR.)", at: at(6), wake: true, ...text("⏰ arktypeio/arktype#6481 was MERGED.") },
  { role: "assistant", sourceId: "final", text: FINAL, at: at(12), ...text(FINAL) },
] as TranscriptMessage[]

const thread = {
  id: "start-gearing-up-for-the-4-5",
  title: "Start gearing up for the 4.5 release",
  status: "active",
  mechanism: null,
  humanBlocked: false,
  needsYou: true,
  awaitingBackground: false,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  runtime: "turn-idle",
  sessionId: "cc2fdd33-15dd-4d44-b504-4aed570e86b0",
  unread: false,
  archived: false,
  hasPlan: false,
  pendingQuestion: true,
  questions: [RELEASE],
  kind: "session",
  foreign: false,
  backend: "claude",
  permissionMode: "default",
  subAgents: [],
  bgShells: [],
  watches: [],
  lastActivityAt: at(12),
} as unknown as ThreadViewModel

store.board = { projectDir: "/fixture/ntwine", threads: [thread] } as BoardSnapshot

const transcriptPage = { messages, transcriptKey: "fixture-key", hasEarlier: false, historyLoaded: false }
const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.origin)
  if (url.pathname === "/_ntwine/rpc/threadTranscript" || url.pathname === "/_ntwine/rpc/threadTranscriptEarlier") {
    return new Response(JSON.stringify({ result: transcriptPage }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname.startsWith("/_ntwine/rpc/")) {
    return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  }
  return originalFetch(input, init)
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <TooltipProvider>
      <div className="mx-auto h-screen w-[min(760px,100%)]">
        <ThreadView slug={thread.id} virtualized={params.get("virtualized") === "1"} />
      </div>
    </TooltipProvider>
  </QueryClientProvider>,
)
