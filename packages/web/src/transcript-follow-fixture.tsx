import { useState } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView as ThreadViewModel, TranscriptMessage } from "@ntwine/shared"
import { ThreadView } from "./components/ChatView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { mergeOptimistic, preserveMessageIdentity } from "./lib/transcript-sync.ts"
import { prefs } from "./lib/prefs.ts"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for TAIL FOLLOW in the virtualized thread transcript: a reader parked at the bottom must
// STAY at the bottom when the tail grows (a big message landing in one push, a queued send flipping to
// landed), and must NOT be yanked down when they are reading up-thread. Drives the same
// `qc.setQueryData(["transcript", slug])` path the live socket push uses (api/socket.ts), so the render
// → measure → scroll sequence under test is production's.
//   ?surface=page|drawer   full-pane standalone (default) or the 460x640 drawer box
const params = new URLSearchParams(location.search)
const surface = params.get("surface") === "drawer" ? "drawer" : "page"

const SLUG = "follow-demo"
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

const T0 = Date.parse("2026-07-24T18:00:00.000Z")
const at = (i: number) => new Date(T0 + i * 1000).toISOString()

const prose = (n: number, label: string) =>
  Array.from({ length: n }, (_, i) =>
    `**${label} ¶${i + 1}.** Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco.`,
  ).join("\n\n")

const text = (sourceId: string, role: "user" | "assistant", body: string, i: number): TranscriptMessage =>
  ({ sourceId, role, text: body, at: at(i), tools: [], parts: [{ kind: "text", text: body }] }) as unknown as TranscriptMessage

// A transcript long enough that the pane genuinely scrolls at every viewport we check.
const seed: TranscriptMessage[] = []
for (let i = 0; i < 7; i++) {
  seed.push(text(`u${i}`, "user", `Ask ${i + 1}: please keep going on the tail-follow investigation.`, i * 2))
  seed.push(text(`a${i}`, "assistant", prose(i === 6 ? 2 : 3, `Reply ${i + 1}`), i * 2 + 1))
}

type Page = { messages: TranscriptMessage[]; transcriptKey: string; hasEarlier: boolean; historyLoaded: boolean }
let page: Page = { messages: seed, transcriptKey: "fixture-key", hasEarlier: false, historyLoaded: false }

const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.origin)
  if (url.pathname === "/_ntwine/rpc/threadTranscript" || url.pathname === "/_ntwine/rpc/threadTranscriptEarlier") {
    return new Response(JSON.stringify({ result: page }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname.startsWith("/_ntwine/rpc/")) {
    return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  }
  return originalFetch(input, init)
}

const thread = {
  id: SLUG,
  title: "Tail-follow demo",
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
  subAgents: [],
  bgShells: [],
  sessionId: "sess-follow",
  lastUserAt: at(0),
  lastActivityAt: at(20),
} as unknown as ThreadViewModel

store.board = { projectDir: "/fixture/ntwine", threads: [thread] } as BoardSnapshot
// Socket mode: no 1.5s interval refetch racing the scripted pushes below.
store.socketTranscripts = true

// EXACTLY the live push path (api/socket.ts handle("transcript")): server truth into the same cache
// useTranscript reads, through mergeOptimistic + preserveMessageIdentity.
function push(messages: TranscriptMessage[]) {
  page = { ...page, messages }
  queryClient.setQueryData(["transcript", SLUG], (prev: { messages?: TranscriptMessage[] } | undefined) => ({
    ...page,
    messages: preserveMessageIdentity(prev?.messages, mergeOptimistic(prev?.messages, messages)),
  }))
}

function setRunning(running: boolean) {
  store.board = {
    projectDir: "/fixture/ntwine",
    threads: [{ ...thread, runtime: running ? "running" : "idle" } as ThreadViewModel],
  } as BoardSnapshot
}

const scroller = () => document.querySelector<HTMLElement>("[data-drawer-transcript-scroll]")

declare global {
  interface Window {
    __fx: {
      metrics(): { scrollTop: number; scrollHeight: number; clientHeight: number; distance: number }
      setRunning(running: boolean): void
      scrollToBottom(): void
      scrollBy(dy: number): void
      count(): number
      appendAssistant(paragraphs: number): void
      appendQueuedUser(): void
      landQueuedUser(): void
    }
  }
}

let n = 100
window.__fx = {
  metrics() {
    const el = scroller()
    if (!el) return { scrollTop: -1, scrollHeight: -1, clientHeight: -1, distance: -1 }
    return {
      scrollTop: Math.round(el.scrollTop),
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      distance: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
    }
  },
  setRunning,
  scrollToBottom() {
    const el = scroller()
    if (el) el.scrollTop = el.scrollHeight
  },
  scrollBy(dy: number) {
    const el = scroller()
    if (el) el.scrollTop += dy
  },
  count: () => page.messages.length,
  // A whole agent reply landing in ONE push — the "big message comes in all at once" case.
  appendAssistant(paragraphs: number) {
    n += 1
    push([...page.messages, text(`a-new-${n}`, "assistant", prose(paragraphs, `Fresh reply ${n}`), n)])
  },
  // The server's own PENDING projection: a user turn the worker has not picked up yet. Renders as the
  // 50%-opacity bubble pinned below everything (row kind "queued").
  appendQueuedUser() {
    n += 1
    push([...page.messages, { ...text(`q-${n}`, "user", `Queued follow-up ${n} that is still waiting to be delivered.`, n), queued: true } as TranscriptMessage])
  },
  // enqueued → dequeued: the same message, no longer queued. The queued row disappears from the tail
  // and a normal message row appears above the runtime-status row — the row COUNT is unchanged.
  landQueuedUser() {
    push(page.messages.map((m) => ((m as { queued?: boolean }).queued ? ({ ...m, queued: false }) : m)))
  },
}

function Harness() {
  if (surface === "drawer") {
    return (
      <div className="mx-auto my-8 flex h-[640px] w-[460px] flex-col overflow-hidden rounded-lg border border-border bg-panel shadow-2xl">
        <ThreadView slug={SLUG} virtualized />
      </div>
    )
  }
  return (
    <div className="mx-auto flex h-screen w-full max-w-[900px] flex-col overflow-hidden border-x border-border bg-panel">
      <ThreadView slug={SLUG} virtualized />
    </div>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Harness />
    </TooltipProvider>
  </QueryClientProvider>,
)
