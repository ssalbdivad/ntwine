import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView as ThreadViewModel, TranscriptMessage } from "@frizz/shared"
import { ThreadView } from "./components/ChatView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for TIME BREAKS (lib/timeBreaks): the centred `Today 10:51 AM` reading the virtualized
// transcript draws where a day starts or 20m+ pass between messages. The excerpt is the one that
// prompted them — two split sends, an agent reply, and a send half an hour later — preceded by a
// stretch from YESTERDAY, so a day break, a same-day time break and a burst with no break all show.
// Instants are relative to the real clock so "Today" and "Yesterday" read true whenever this is opened.
//
//   nubx vite --port 5478 --strictPort      (from packages/web)
//   http://localhost:5478/time-breaks-fixture.html

const SLUG = "time-breaks"
document.documentElement.dataset.font = new URLSearchParams(location.search).get("font") === "mono" ? "mono" : "sans"

const thread = {
  id: SLUG,
  title: "Encrypt the token file at rest",
  status: "needs-human",
  statusText: "Waiting on your call",
  mechanism: null,
  humanBlocked: true,
  needsYou: true,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  runtime: "idle",
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
  lastActivityAt: "2026-07-18T10:00:00.000Z",
  spawnedAt: "2026-07-18T09:00:00.000Z",
  // The push-now click resolves this at CLICK time and refuses without it, so the control is only
  // driveable here if the fixture thread carries one — same as any live row.
  sessionId: "sid-time-breaks",
} as unknown as ThreadViewModel

store.board = { projectDir: "/fixture/frizz", threads: [thread] } as BoardSnapshot

const today = new Date()
const on = (daysAgo: number, h: number, m: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysAgo, h, m).toISOString()
const user = (id: string, at: string, text: string) => ({ sourceId: id, role: "user", text, tools: [], parts: [], at })
const agent = (id: string, at: string, text: string) => ({ sourceId: id, role: "assistant", text, tools: [], parts: [{ kind: "text", text }], at })

const messages = [
  user("u0", on(1, 15, 2), "Can you check whether the relay token file is encrypted at rest?"),
  agent("a0", on(1, 15, 3), "It is not — `~/.frizz/relay-token` is plain text at `0600`. Encrypting it means a keychain read on every boot."),
  user("u1", on(0, 10, 51), "I don't want to give you m"),
  user("u2", on(0, 10, 51), "y macOS password."),
  agent("a1", on(0, 10, 52), "That's fine — the keychain read needs it once per boot, so the fallback is to skip encryption at rest and keep the token file at `0600`."),
  user("u3", on(0, 11, 24), "maybe its not worth encrypting"),
] as unknown as TranscriptMessage[]

const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : ((input as Request).url ?? input.toString()), location.origin)
  if (url.pathname === "/_frizz/rpc/threadTranscript" || url.pathname === "/_frizz/rpc/threadTranscriptEarlier") {
    return new Response(
      JSON.stringify({ result: { messages, transcriptKey: `${SLUG}-key`, hasEarlier: false, historyLoaded: true } }),
      { headers: { "content-type": "application/json" } },
    )
  }
    if (url.pathname.startsWith("/_frizz/rpc/")) {
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
