import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useState } from "react"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView } from "@ntwine/shared"
import { Message } from "./components/ChatView.tsx"
import { useLiveAnswering } from "./lib/answering.ts"
import { pairAllAnswers } from "./lib/answersMessage.ts"
import type { ChatMessage } from "./hooks.ts"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for "a ONE-question ask answers into the Answers card too". A single-block ask used to send
// its answer as BARE text, which carried no marker for the renderer and landed as a flat run-on bubble
// while every other answer shape got the structured card. This drives the whole real path — chip click →
// useLiveAnswering → composeAnswerWire → the appended user turn → pairAllAnswers → Message — so the card
// is observed, not inferred from the wire string.
//
// The second thread below is the LEGACY case: transcripts already hold bare answers from before the
// numbering, recovered by exact option match (pairBareChipAnswer), alongside a freeform reply to the same
// ask that must KEEP its plain bubble.

const slug = "single-answer-thread"
const thread: ThreadView = {
  id: slug, title: "Prune the orphaned binaries", status: "active", mechanism: null, humanBlocked: false,
  ready: false, dependsOn: [], externalDeps: [], agents: [], errors: [], warnings: [], runtime: "running",
  unread: false, archived: false, hasPlan: false, pendingQuestion: false, kind: "session", foreign: false,
  backend: "claude", permissionMode: "default", subAgents: [], bgShells: [], watches: [], questions: [],
}
store.board = { projectDir: "/fixture/ntwine", threads: [thread] } as BoardSnapshot

const asMsg = (m: Partial<ChatMessage> & { role: string; text: string }): ChatMessage => ({
  tools: [], parts: [{ kind: "text", text: m.text }], ...m,
} as ChatMessage)

const ASK = "```question\nDelete the orphaned hardlinked binaries?\n- A. Yes, delete them (recommended: `npm uninstall -g` leaves ~45 MB behind)\n- B. Leave them — reclaim the space by hand later\n```"

const live: ChatMessage[] = [
  asMsg({ role: "user", text: "Clean up the stale global installs." }),
  asMsg({ role: "assistant", sourceId: "ask-prune", text: `Two of them are orphaned.\n\n${ASK}` }),
]

// A bare answer already in the transcript (pre-numbering), plus a freeform reply to the same ask.
const legacy: ChatMessage[] = [
  asMsg({ role: "assistant", sourceId: "ask-legacy", text: ASK }),
  asMsg({ role: "user", sourceId: "legacy-answer", text: "A. Yes, delete them" }),
  asMsg({ role: "assistant", sourceId: "ask-legacy-2", text: ASK }),
  asMsg({ role: "user", sourceId: "legacy-freeform", text: "Neither — check what still links them first." }),
]

function Fixture() {
  // The sent answer is appended to the live transcript exactly as the server would echo it back, so the
  // card that appears is the product of the real wire text going back through the real render path.
  const [sent, setSent] = useState<string | null>(null)
  const messages = sent ? [...live, asMsg({ role: "user", sourceId: "sent-answer", text: sent })] : live
  const { answeringForMessage } = useLiveAnswering(slug, messages)
  const paired = pairAllAnswers(messages)
  const legacyPaired = pairAllAnswers(legacy)
  return (
    <main className="mx-auto min-h-screen w-full px-4 py-8">
      <section style={{ width: 720 }} className="mx-auto mb-6 rounded-lg border border-border bg-panel p-5 shadow-2xl">
        <p className="petite-caps mb-3 text-[10px] text-accent">One-question ask → answer</p>
        <div data-live-thread className="flex flex-col gap-3.5">
          {messages.map((m, i) => (
            <Message key={i} m={m} answering={answeringForMessage(m)} showSendButton paired={paired[i]} />
          ))}
        </div>
        <div className="mt-4 border-t border-border pt-3">
          <p className="petite-caps text-[10px] text-muted">Composed wire text on send:</p>
          <pre data-sent-wire className="mt-1 whitespace-pre-wrap text-[12px] text-accent">(nothing sent yet)</pre>
        </div>
      </section>
      <section style={{ width: 720 }} className="mx-auto rounded-lg border border-border bg-panel p-5 shadow-2xl">
        <p className="petite-caps mb-3 text-[10px] text-accent">Legacy bare answer vs. a freeform reply</p>
        <div data-legacy-thread className="flex flex-col gap-3.5">
          {legacy.map((m, i) => (
            <Message key={i} m={m} paired={legacyPaired[i]} />
          ))}
        </div>
      </section>
      <SendCapture onSend={setSent} />
    </main>
  )
}

// The followUp RPC is the only stubbed piece — it records the wire bytes and hands them back so the
// fixture can append the echoed turn. Installed inside the tree so it is in place before any click.
function SendCapture({ onSend }: { onSend: (text: string) => void }) {
  useState(() => {
    const originalFetch = window.fetch
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), window.location.origin)
      if (url.pathname === "/_ntwine/rpc/followUp") {
        const body = JSON.parse(String(init?.body ?? "{}"))
        const node = document.querySelector("[data-sent-wire]")
        if (node) node.textContent = body.message
        onSend(String(body.message))
        return new Response(JSON.stringify({ result: {} }), { headers: { "content-type": "application/json" } })
      }
      if (url.pathname === "/_ntwine/rpc/markRead") return new Response(JSON.stringify({ result: {} }), { headers: { "content-type": "application/json" } })
      return originalFetch(input, init)
    }
    return null
  })
  return null
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <Fixture />
  </QueryClientProvider>,
)
