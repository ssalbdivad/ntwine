import { useState } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView as ThreadViewModel, TranscriptMessage } from "@ntwine/shared"
import { ThreadView } from "./components/ChatView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { mergeOptimistic, preserveMessageIdentity } from "./lib/transcript-sync.ts"
import { reconcileLiveMessages, type PaginatedTranscriptData } from "./lib/transcriptPagination.ts"
import { prefs } from "./lib/prefs.ts"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for the SATURATED RENDER WINDOW — the configuration every long thread is in and the one
// that dragged a reader parked mid-thread on /full.
//
// The server projects at most MAX_MESSAGES (300), so once a thread passes that cap every new message also
// pushes one off the HEAD of the live window. Those rows vanish from ABOVE the reader and the content
// above them shrinks, so with scrollTop untouched the whole transcript slides up past their eye. The
// virtualizer cannot see it: its `anchorTo: "end"` preservation is gated on the first/last row keys and
// `count`, and a trim changes none of those on this list.
//
// This drives the EXACT client push pipeline socket.ts uses (`handle("transcript")`):
//   reconcileLiveMessages → mergeOptimistic → preserveMessageIdentity → the same query cache key.
// so both halves of the fix are under test — the reconciler keeping the page envelope across a slid
// window, and the transcript holding the reader's anchor across the trim.
//
// It deliberately does NOT boot an ntwine server. The seam it skips (tailer → socket) is not where the bug
// lives, and a full stack plus a 300-message first render is what this machine OOM-kills.
//   ?messages=340   how many messages to seed (must exceed the 300 cap to saturate)
const params = new URLSearchParams(location.search)
const SEEDED = Number(params.get("messages") ?? 340)
const CAP = 300
const SLUG = "window-slide-demo"
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

const T0 = Date.parse("2026-07-27T09:00:00.000Z")
const at = (i: number) => new Date(T0 + i * 1000).toISOString()

const prose = (n: number, label: string) =>
  Array.from({ length: n }, (_, i) =>
    `**${label} ¶${i + 1}.** Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.`,
  ).join("\n\n")

const text = (sourceId: string, role: "user" | "assistant", body: string, i: number): TranscriptMessage =>
  ({ sourceId, role, text: body, at: at(i), tools: [], parts: [{ kind: "text", text: body }] }) as unknown as TranscriptMessage

// A settled prefix long enough to saturate the cap, then a live turn substantial enough to park inside.
const all: TranscriptMessage[] = []
for (let i = 0; all.length < SEEDED - 14; i++) {
  all.push(text(`u${i}`, "user", `Ask ${i + 1}: earlier settled exchange.`, all.length))
  all.push(text(`a${i}`, "assistant", `Reply ${i + 1}: settled, and long enough to occupy a row of its own.`, all.length))
}
all.push(text("standing-ask", "user", prose(3, "The standing ask"), all.length))
for (let i = 0; i < 13; i++) all.push(text(`w${i}`, "assistant", prose(2 + (i % 3), `Working step ${i + 1}`), all.length))

// `serverTail` is the server's own view: the LATEST `CAP` messages, exactly what a push carries.
let produced = all.length
const serverWindow = () => all.slice(Math.max(0, all.length - CAP))

const initialPage: PaginatedTranscriptData = {
  messages: serverWindow(),
  transcriptKey: "fixture-key",
  beforeCursor: "cursor-seed",
  hasEarlier: true,
  reachedTurnBoundary: false,
  historyLoaded: false,
}

const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.origin)
  if (url.pathname === "/_ntwine/rpc/threadTranscript") {
    return new Response(JSON.stringify({ result: { ...initialPage, messages: serverWindow() } }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname === "/_ntwine/rpc/threadTranscriptEarlier") {
    // One page of genuinely earlier history, the way the server would answer the cursor.
    const earlier = all.slice(0, Math.max(0, all.length - CAP)).slice(-40)
    return new Response(JSON.stringify({ result: { messages: earlier, transcriptKey: "fixture-key", beforeCursor: "cursor-older", hasEarlier: true, reachedTurnBoundary: false } }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname.startsWith("/_ntwine/rpc/")) {
    return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  }
  return originalFetch(input, init)
}

const thread = {
  id: SLUG,
  title: "Window slide demo",
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
  sessionId: "sess-slide",
  lastUserAt: at(0),
  lastActivityAt: at(all.length),
} as unknown as ThreadViewModel

store.board = { projectDir: "/fixture/ntwine", threads: [thread] } as BoardSnapshot
store.socketTranscripts = true

// EXACTLY socket.ts `handle("transcript")`: server truth (messages only — a push never carries an
// envelope) through reconcileLiveMessages, then the optimistic/identity preserving pair.
function push(messages: TranscriptMessage[]) {
  queryClient.setQueryData(["transcript", SLUG], (prev: PaginatedTranscriptData | undefined) => {
    const reconciled = reconcileLiveMessages(prev, messages)
    return {
      ...reconciled,
      messages: preserveMessageIdentity(prev?.messages, mergeOptimistic(prev?.messages, reconciled.messages)),
    }
  })
}

const scroller = () => document.querySelector<HTMLElement>("[data-drawer-transcript-scroll]")
const box = () => document.querySelector<HTMLElement>("[data-virtualized-transcript]")

declare global {
  interface Window {
    __ws: {
      probe(key?: string | null): {
        key: string | null
        y: number | null
        found: boolean
        scrollTop: number
        scrollHeight: number
        distance: number
        jumpVisible: boolean
        totalHeight: number
        held: number
        hasEarlier: boolean
        transcriptKey: string | null
      }
      /** One new message at the tail — which, on a saturated window, also trims one off the head. */
      appendMessage(paragraphs?: number): void
      /** A tool call merged into the message already at the tail: the row grows, no row is added. */
      growTail(): void
      scrollToBottom(): void
      seeded(): number
    }
  }
}

window.__ws = {
  probe(key) {
    const el = scroller()
    const boxEl = box()
    const cached = queryClient.getQueryData<PaginatedTranscriptData>(["transcript", SLUG])
    if (!el || !boxEl) {
      return { key: null, y: null, found: false, scrollTop: -1, scrollHeight: -1, distance: -1, jumpVisible: false, totalHeight: -1, held: -1, hasEarlier: false, transcriptKey: null }
    }
    const top = el.getBoundingClientRect().top
    const rows = Array.from(boxEl.querySelectorAll<HTMLElement>("[data-transcript-row-key]"))
      .map((r) => ({ key: r.dataset.transcriptRowKey ?? "", y: r.getBoundingClientRect().top - top, h: r.getBoundingClientRect().height }))
      .sort((a, b) => a.y - b.y)
    const named = key ? rows.find((r) => r.key === key) : undefined
    const chosen = named ?? rows.find((r) => r.y + r.h > 240) ?? rows[0]
    return {
      key: chosen?.key ?? null,
      y: chosen ? Math.round(chosen.y) : null,
      found: Boolean(named),
      scrollTop: Math.round(el.scrollTop),
      scrollHeight: el.scrollHeight,
      distance: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
      jumpVisible: Boolean(document.querySelector("[data-jump-to-latest]")),
      totalHeight: Math.round(parseFloat(boxEl.style.height || "0")),
      held: cached?.messages.length ?? -1,
      hasEarlier: cached?.hasEarlier === true,
      transcriptKey: cached?.transcriptKey ?? null,
    }
  },
  appendMessage(paragraphs = 3) {
    produced += 1
    all.push(text(`new-${produced}`, "assistant", prose(paragraphs, `Fresh reply ${produced}`), produced))
    push(serverWindow())
  },
  growTail() {
    const tail = all[all.length - 1]
    const grown = `${tail.text}\n\n${prose(1, "A tool call landed in this same turn")}`
    all[all.length - 1] = { ...tail, text: grown, parts: [{ kind: "text", text: grown }] } as unknown as TranscriptMessage
    push(serverWindow())
  },
  scrollToBottom() {
    const el = scroller()
    if (el) el.scrollTop = el.scrollHeight
  },
  seeded: () => all.length,
}

function Harness() {
  // A full-height, max-w-[900px] column.
  return (
    <div className="mx-auto flex h-dvh w-full max-w-[900px] min-w-0 flex-col overflow-hidden border-x border-border bg-panel">
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
