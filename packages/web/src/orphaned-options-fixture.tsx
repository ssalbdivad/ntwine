import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView } from "@ntwine/shared"
import { Message } from "./components/ChatView.tsx"
import { useLiveAnswering } from "./lib/answering.ts"
import type { ChatMessage } from "./hooks.ts"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for the orphaned-option self-heal: a worker that closes its ```question fence after the
// question sentence and writes the lettered options OUTSIDE it (pullfrog-app, 2026-08-25) must still
// get an answerable card — the splitter adopts the orphan list into the block. Renders the real
// Message + useLiveAnswering path with the failing shape (two option-less fences, lists outside),
// plus a well-formed control block that must be unaffected.

const slug = "orphaned-options-thread"
const thread: ThreadView = {
  id: slug, title: "Confirm pullfrog pricing emails went out", status: "active", mechanism: null, humanBlocked: false,
  ready: false, dependsOn: [], externalDeps: [], agents: [], errors: [], warnings: [], runtime: "running",
  unread: false, archived: false, hasPlan: false, pendingQuestion: false, kind: "session", foreign: false,
  backend: "claude", permissionMode: "default", subAgents: [], bgShells: [], watches: [], questions: [],
}
store.board = { projectDir: "/fixture/ntwine", threads: [thread] } as BoardSnapshot

const asMsg = (m: Partial<ChatMessage> & { role: string; text: string }): ChatMessage => ({
  tools: [], parts: [{ kind: "text", text: m.text }], ...m,
} as ChatMessage)

// The real failure shape, verbatim in structure: fence carries ONLY the question, options follow as
// ordinary markdown, twice in one message. Both must render chips, with A badged as recommended.
const messages: ChatMessage[] = [
  asMsg({ role: "user", text: "Did the pricing emails go out?" }),
  asMsg({
    role: "assistant", sourceId: "ask-orphaned",
    text: [
      "An opt-out notice fixes both objections cleanly.",
      "",
      "```question",
      "Pullfrog runs stop for 85 active orgs on Sep 8. Only 36 have a card. What should happen?",
      "```",
      "",
      "- A. Send an opt-out notice, then auto-start for card-on-file orgs (recommended: keeps the gate intact)",
      "- B. Auto-charge the 36 card-on-file orgs with no further notice",
      "- C. Keep confirmation mandatory, but soften the deadline",
      "- D. Change nothing — the 85 pause on Sep 8",
      "",
      "```question",
      "Separately: the hourly sweep has been erroring because 8 orgs have no contact email. What should happen to that?",
      "```",
      "",
      "- A. Fix the code and backfill the 8 contacts (recommended: no org is paused unnotified)",
      "- B. Fix only the code — the 8 pause with no notice",
    ].join("\n"),
  }),
  asMsg({
    role: "assistant", sourceId: "ask-control",
    text: "A well-formed control block:\n\n```question\nWhich database should the layer target?\n- A. Postgres\n- B. SQLite\n```",
  }),
]

// Stub the RPCs the live-answering path touches so the fixture stays self-contained (no 404s).
const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), window.location.origin)
  if (url.pathname === "/_ntwine/rpc/followUp" || url.pathname === "/_ntwine/rpc/markRead")
    return new Response(JSON.stringify({ result: {} }), { headers: { "content-type": "application/json" } })
  return originalFetch(input, init)
}

function Fixture() {
  const { answeringForMessage } = useLiveAnswering(slug, messages)
  return (
    <main className="mx-auto min-h-screen w-full px-4 py-8">
      <p className="petite-caps mx-auto mb-4 max-w-2xl text-[10px] text-accent">Orphaned-options self-heal</p>
      <section className="mx-auto w-[720px] rounded-lg border border-border bg-panel p-5 shadow-2xl">
        <div className="flex flex-col gap-3.5">
          {messages.map((m, i) => (
            <Message key={i} m={m} answering={answeringForMessage(m)} showSendButton paired={null} />
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
