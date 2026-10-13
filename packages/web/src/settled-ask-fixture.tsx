import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView, TranscriptToolCall } from "@ntwine/shared"
import { Message } from "./components/ChatView.tsx"
import type { ChatMessage } from "./hooks.ts"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for the SETTLED NATIVE ASK: an AskUserQuestion the operator steered past (or answered)
// must keep rendering in the transcript as a read-only question card, through the REAL path — Message →
// parts walk → ToolCardRouter → SettledAskBlock. States on this page:
//   1. WITHDRAWN, unanswered — dim chips + the "Not answered" note.
//   2. ANSWERED single-select — the recorded choice in the quiet settled treatment.
//   3. ANSWERED multi-select — two settled checks.
//   4. ANSWERED with free text that names no option — the recessed answer row.
//   5. PENDING (negative control) — folds into the ordinary "Ran N tool calls" disclosure.
//
// `?font=sans|mono` sets `data-font`. The prose font is a user setting applied before first paint, and a
// fixture that does not set it silently renders the mono default.
const font = new URLSearchParams(location.search).get("font")
if (font === "sans" || font === "mono") document.documentElement.dataset.font = font

const slug = "settled-ask-thread"
const thread: ThreadView = {
  id: slug, title: "Pick the banner treatment", status: "active", mechanism: null, humanBlocked: false,
  ready: false, dependsOn: [], externalDeps: [], agents: [], errors: [], warnings: [], runtime: "turn-idle",
  unread: false, archived: false, hasPlan: false, pendingQuestion: false, kind: "session", foreign: false,
  backend: "claude", permissionMode: "default", subAgents: [], bgShells: [], watches: [], questions: [],
}
store.board = { projectDir: "/fixture/ntwine", threads: [thread] } as BoardSnapshot

const BANNER_ASK = [{
  question: "Which colour should the banner be? The header sits over a photo, so contrast is the real constraint.",
  header: "Banner colour",
  options: [
    { label: "Red", description: "warm and loud" },
    { label: "Blue", description: "calm and cool" },
  ],
}]

const PLATFORM_ASK = [{
  question: "Which platforms should CI cover?",
  multiSelect: true,
  options: [{ label: "macOS" }, { label: "Linux" }, { label: "Windows" }],
}]

const toolMsg = (lead: string, tools: TranscriptToolCall[]): ChatMessage => ({
  role: "assistant", text: "", tools: [],
  parts: [{ kind: "text", text: lead }, { kind: "tools", tools }],
} as unknown as ChatMessage)

const messages: ChatMessage[] = [
  { role: "user", text: "Sort out the banner and the CI matrix.", tools: [], parts: [{ kind: "text", text: "Sort out the banner and the CI matrix." }] } as unknown as ChatMessage,
  toolMsg("1 — WITHDRAWN: the operator sent a follow-up instead of answering.", [
    { name: "AskUserQuestion", detail: "Banner colour", ask: BANNER_ASK, status: "failed" },
  ]),
  toolMsg("2 — ANSWERED single-select: the human picked Red.", [
    { name: "AskUserQuestion", detail: "Banner colour", ask: BANNER_ASK, askAnswers: ["Red"], status: "completed" },
  ]),
  toolMsg("3 — ANSWERED multi-select: macOS and Windows.", [
    { name: "AskUserQuestion", detail: "CI platforms", ask: PLATFORM_ASK, askAnswers: ["macOS, Windows"], status: "completed" },
  ]),
  toolMsg("4 — ANSWERED with free text that names no option.", [
    { name: "AskUserQuestion", detail: "Banner colour", ask: BANNER_ASK, askAnswers: ["Make it green instead"], status: "completed" },
  ]),
  toolMsg("5 — PENDING negative control: folds into the ordinary disclosure, drawn nowhere else here.", [
    { name: "Read", detail: "src/banner.tsx", status: "completed" },
    { name: "AskUserQuestion", detail: "Banner colour", ask: BANNER_ASK, status: "pending" },
  ]),
]

function Fixture() {
  return (
    <main className="mx-auto min-h-screen w-full px-4 py-8">
      <p className="mx-auto mb-4 max-w-2xl petite-caps text-[10px] text-accent">Settled native ask states</p>
      <section className="mx-auto max-w-2xl rounded-lg border border-border bg-panel p-5 shadow-2xl">
        <div className="flex flex-col gap-3.5">
          {messages.map((m, i) => (
            <Message key={i} m={m} paired={null} />
          ))}
        </div>
      </section>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <Fixture />
  </QueryClientProvider>,
)
