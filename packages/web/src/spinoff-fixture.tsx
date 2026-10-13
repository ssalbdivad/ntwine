import { useMemo } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { spinoffChildPrompt, spinoffContext, type BoardSnapshot, type SpinoffView, type ThreadHandoff, type ThreadView as ThreadViewModel, type TranscriptMessage } from "@ntwine/shared"
import { AllQueuesCard } from "./components/AllQueuesCard.tsx"
import { ThreadView } from "./components/ChatView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import type { QueuesProject } from "./lib/allQueues.ts"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for SPINOFFS' own UI (2026-09-30): both ends of the edge as the real drawer draws them —
// ThreadView with the virtualized transcript, the shipped call site — on a stubbed board and a stubbed
// transcript RPC, plus the queue card of a spinoff child. Everything drawn is the real component; only the
// network is fake.
//
//   ?panel=parent   the PARENT at rest: three requests — two started (cards the server draws from their
//                   rows, the second with a long handle), and one an older build delivered to the worker as
//                   a `<spinoff-request>` turn that never started: the envelope must draw as the card, and
//                   the worker's failed spawn_thread call under it is an ordinary tool line.
//   ?panel=child    the CHILD: the header's "Spinoff of @parent", then its first turn as the origin card
//                   with the context Ntwine assembled folded beneath (`&open=1` opens it on load).
//   ?panel=queue    the child's QUEUE CARD, whose meta line names its parent too.
//   (default)       all three, stacked.
//   &w=<px>         the panel width — 560 is the drawer's, 420 a phone / narrow card. Default 560.
//   &theme=light    the light theme (default dark).
//
// Sans only: the one font the product renders (CLAUDE.md), set before first paint.
const params = new URLSearchParams(location.search)
document.documentElement.dataset.font = "sans"
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark"
const PANEL = params.get("panel") ?? "all"
const WIDTH = Number(params.get("w") ?? 560)

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()

function thread(id: string, title: string, extra: Partial<ThreadViewModel> = {}): ThreadViewModel {
  return {
    id, title, status: "active", statusText: "", mechanism: null, humanBlocked: false, needsYou: false, ready: false,
    dependsOn: [], externalDeps: [], agents: [], errors: [], warnings: [], runtime: "turn-idle", unread: false,
    archived: false, hasPlan: false, pendingQuestion: false, kind: "session", foreign: false, backend: "claude",
    permissionMode: "default", state: "open", sessionId: `sess-${id}`, subAgents: [], bgShells: [], watches: [],
    questions: [], titleAuto: false, titleLocked: true, spawnedAt: at(240), lastActivityAt: at(3), lastAssistantAt: at(3),
    ...extra,
  } as unknown as ThreadViewModel
}

const edge = (id: string, parentSlug: string, childSlug: string | null, instructions: string): SpinoffView => ({ id, parentSlug, childSlug, instructions, createdAt: Date.now() })

// ── The edges ────────────────────────────────────────────────────────────────────────────────────
const A = edge("spn_a000000000000001", "sub-agent-liveness", "evaluate-addresses", "Evaluate whether the sub-agent addresses feature is worth keeping. Be blunt about what it costs us.")
const B = edge("spn_b000000000000002", "sub-agent-liveness", "audit-projection-paths", "Audit every place the transcript projection reads a tool call's input.")
const C = edge("spn_c000000000000003", "sub-agent-liveness", null, "Write a migration that backfills the child slugs.")

// The parent's own words, as Ntwine quotes them into the child's context (spinoffContext).
const REQUEST = "Why do live sub-agents read as not running in the rail?"
const HANDOFF = `## Where this stands

Live sub-agents now read as running: the rail reads liveness off the broker's own child registry rather than the shell telemetry. Along the way I added *sub-agent addresses*: every child a worker dispatches gets a \`thread.child\` handle (\`@sub-agent-liveness.cache-keys\`).

## What exists today

- \`packages/shared/src/thread-handle.ts\` — \`subAgentHandle(label)\` kebab-cases a dispatch name.
- \`packages/web/src/groups.ts\` — \`subAgentName\` and \`subAgentAddressOf\` render the address.
- \`packages/server/src/router.ts\` — \`subAgentDirectory\` serves every child a thread ever dispatched.

## The open question

Nobody has typed a dotted address in anger yet, and the feature added ~900 lines across four packages.`
const BRIEF = spinoffContext({ parentSlug: "sub-agent-liveness", parentTitle: "Sub-agent liveness", parentHandle: "sub-agent-liveness", readAs: "sub-agent-liveness", request: REQUEST, handoff: HANDOFF })

const PARENT = thread("sub-agent-liveness", "Sub-agent liveness", { spinoffs: [A, B, C], lastUserAt: at(20) })
const CHILD = thread("evaluate-addresses", "Evaluate sub-agent addresses", {
  spinoffs: [A], statusLine: "Counting dotted mentions", needsYou: true, humanBlocked: true, status: "needs-human", spawnedAt: at(18),
})
const LONG_CHILD = thread("audit-projection-paths", "Audit every transcript projection path", { spinoffs: [B], needsYou: true, humanBlocked: true, status: "needs-human" })
store.board = { projectDir: "/fixture/ntwine", projectSlug: "ntwine", threads: [PARENT, CHILD, LONG_CHILD] } as unknown as BoardSnapshot
// The e2e reads which drawer a plain click on a thread link opened (Spinoff.e2e.test.ts).
;(window as unknown as { __store: typeof store }).__store = store

// ── The transcripts ─────────────────────────────────────────────────────────────────────────────
const user = (sourceId: string, text: string, minutesAgo: number, extra: Partial<TranscriptMessage> = {}): TranscriptMessage =>
  ({ sourceId, role: "user", text, tools: [], parts: [], at: at(minutesAgo), ...extra }) as TranscriptMessage
const said = (sourceId: string, text: string, minutesAgo: number, tools: TranscriptMessage["tools"] = []): TranscriptMessage =>
  ({ sourceId, role: "assistant", text, tools, parts: [...(text ? [{ kind: "text" as const, text }] : []), ...(tools.length ? [{ kind: "tools" as const, tools }] : [])], at: at(minutesAgo) }) as TranscriptMessage
// A request the server draws from its row (transcript.ts withSpinoffCards): the instructions, stamped.
const card = (e: SpinoffView, minutesAgo: number): TranscriptMessage =>
  user(`spinoff:${e.id}`, e.instructions, minutesAgo, { displayText: e.instructions, spinoff: { id: e.id, instructions: e.instructions } })
// …and one an older build DELIVERED to the worker: the turn's raw text is the envelope.
const legacyRequest = (sourceId: string, e: SpinoffView, minutesAgo: number): TranscriptMessage =>
  user(sourceId, `<spinoff-request id="${e.id}">\nThe human asked to spinoff a NEW thread from this conversation. Their instructions for it:\n<instructions>\n${e.instructions}\n</instructions>\n\nDo this now, before anything else: …\n</spinoff-request>`, minutesAgo, { displayText: e.instructions, spinoff: { id: e.id, instructions: e.instructions } })
const refusedSpawn = (e: SpinoffView) => ({ name: "mcp__ntwine__spawn_thread", detail: "spawn thread", status: "failed" as const, input: JSON.stringify({ spinoff: e.id, prompt: "…" }), output: `Error: model "opus-9" is not available here — pick one of opus, sonnet, haiku.` })
const read = (detail: string) => ({ name: "Read", detail, status: "completed" as const })

const TRANSCRIPTS: Record<string, TranscriptMessage[]> = {
  [PARENT.id]: [
    user("p-u1", REQUEST, 60),
    said("p-a1", "The rail's liveness reads `bgState`, and a sub-agent inside the broker never sets it — so every child reads idle until it reports.", 55, [read("packages/web/src/components/Sidebar.tsx"), read("packages/server/src/board.ts")]),
    card(A, 40),
    said("p-a3", "Back to the rail. The fix is to read liveness off the broker's own child registry rather than the shell telemetry.", 38, [read("packages/server/src/claude-broker-host.ts"), { name: "Edit", detail: "packages/server/src/board.ts", status: "completed" }]),
    card(B, 30),
    legacyRequest("p-u4", C, 20),
    said("p-a5", "", 19, [refusedSpawn(C)]),
    said("p-a6", "I could not start that one: the model I asked for does not exist here. Say the word and I will try again on the default.", 19),
  ],
  [CHILD.id]: [
    user("c-u0", spinoffChildPrompt({ parentSlug: PARENT.id, parentTitle: PARENT.title, parentHandle: "sub-agent-liveness", instructions: A.instructions, brief: BRIEF }), 18, {
      displayText: A.instructions,
      spinoffOrigin: { instructions: A.instructions, brief: BRIEF },
    }),
    said("c-a0", "Starting with the count. I'll grep the worker transcripts for dotted mentions first, then weigh the cost side.", 17, [read("packages/shared/src/thread-handle.ts")]),
  ],
}

const json = (result: unknown) => new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json" } })
const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : ((input as Request).url ?? input.toString()), location.origin)
  if (!url.pathname.startsWith("/_ntwine/")) return originalFetch(input, init)
  const rpc = /\/rpc\/([^/]+)$/.exec(url.pathname)?.[1]
  const raw = typeof init?.body === "string" ? init.body : url.searchParams.get("input")
  const body = raw ? (JSON.parse(raw) as { slug?: string }) : {}
  if (rpc === "threadTranscript" || rpc === "threadTranscriptEarlier") {
    return json({ messages: TRANSCRIPTS[body.slug ?? ""] ?? [], transcriptKey: `${body.slug}-key`, hasEarlier: false, historyLoaded: true })
  }
  // The brief's inline code paths ask whether each is a real file; none is, here.
  if (rpc === "resolveLocalPaths") {
    return json({ resolved: ((body as { paths?: string[] }).paths ?? []).map((input) => ({ input, path: null })) })
  }
  // The Spinoff dialog's project picker reads the machine-wide lists; one project here, so no picker.
  if (rpc === "projectsQueues" || rpc === "projectsList") return json([])
  if (rpc === "threadHandoff") {
    // The server's handoff for a spinoff child quotes the human's instructions, never the context.
    const t = body.slug === LONG_CHILD.id ? B : A
    const handoff: ThreadHandoff = { asked: t.instructions, askedAt: at(18), text: "Counted 3 dotted mentions across 212 transcripts, all by the parent that introduced them. My recommendation is below.", at: at(2) }
    return json(handoff)
  }
  return json({})
}

function Drawer({ slug, label, height }: { slug: string; label: string; height: number }) {
  return (
    <section data-fixture-panel={slug} className="flex flex-col gap-1.5">
      <p className="text-[11px] text-muted">{label}</p>
      <div className="flex flex-col overflow-hidden border border-border bg-bg" style={{ width: WIDTH, maxWidth: "100%", height }}>
        <ThreadView slug={slug} virtualized />
      </div>
    </section>
  )
}

function Queue() {
  const project: QueuesProject = useMemo(() => ({
    id: "fixture-ntwine", slug: "ntwine", name: "ntwine", card: undefined, open: true, stale: false,
    projectDir: "/fixture/ntwine", homeDir: "/fixture", githubRepo: undefined,
    queued: [CHILD, LONG_CHILD], running: [], snoozed: [], pinnedDone: [], doneCount: 0,
  }), [])
  return (
    <section data-fixture-panel="queue" className="flex flex-col gap-1.5">
      <p className="text-[11px] text-muted">Queue cards of two spinoff children</p>
      <div className="flex flex-col gap-5" style={{ width: WIDTH, maxWidth: "100%" }}>
        {[CHILD, LONG_CHILD].map((t) => (
          <AllQueuesCard key={t.id} project={project} thread={t} leaving={false} onLeave={() => {}} onReturn={() => {}} />
        ))}
      </div>
    </section>
  )
}

function Fixture() {
  const show = (panel: string) => PANEL === "all" || PANEL === panel
  return (
    <div className="min-h-screen bg-bg p-4 text-sm text-fg">
      <div className="flex flex-col gap-8">
        {show("parent") && <Drawer slug={PARENT.id} label="Parent at rest: started, started (long handle), an older build's request that didn't start" height={900} />}
        {show("child") && <Drawer slug={CHILD.id} label="Child: the origin card" height={PARAMS_OPEN ? 1700 : 760} />}
        {show("queue") && <Queue />}
      </div>
    </div>
  )
}
const PARAMS_OPEN = params.get("open") === "1"
if (PARAMS_OPEN) {
  // Open the context once the card is on screen (the virtualized list mounts it after the transcript lands).
  const timer = setInterval(() => {
    const toggle = document.querySelector<HTMLButtonElement>("[data-spinoff-context-toggle][aria-expanded='false']")
    if (!toggle) return
    toggle.click()
    clearInterval(timer)
  }, 50)
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter>
      <TooltipProvider>
        <Fixture />
      </TooltipProvider>
    </MemoryRouter>
  </QueryClientProvider>,
)
