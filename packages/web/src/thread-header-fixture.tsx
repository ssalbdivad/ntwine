import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import * as RadixTabs from "@radix-ui/react-tabs"
import type { BoardSnapshot, ThreadView } from "@ntwine/shared"
import { ThreadHeader } from "./components/ChatView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import { FACT_CASES } from "./facts-fixture-cases.ts"
import "./styles.css"

// `?facts=1`: one header per combination of facts in facts-fixture-cases.ts — the band stamp or none, a
// context reading, a goal loop, a worktree, a spinoff, a long status line — for judging the facts line's
// drop-whole rule (ThreadHeaderFacts FACTS_LINE_CLASS) at every width at once.
const FACTS = new URLSearchParams(location.search).get("facts") === "1"

const calls: string[] = []
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.toString(), window.location.origin)
  const body = JSON.parse(String(init?.body ?? "{}")) as { message?: string }
  if (url.pathname === "/_ntwine/rpc/followUp") {
    calls.push(`followUp: ${body.message ?? ""}`)
    const output = document.querySelector("[data-fixture-rpc-calls]")
    if (output) output.textContent = `RPC calls: ${calls.join(" | ")}`
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return new Response(JSON.stringify({ result: null }), {
    headers: { "content-type": "application/json", "x-ntwine-boot": "thread-header-fixture" },
  })
}

const base = {
  status: "active",
  mechanism: null,
  humanBlocked: false,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  unread: false,
  archived: false,
  hasPlan: false,
  pendingQuestion: false,
  kind: "session",
  foreign: false,
  spawnedAt: "2026-07-14T14:30:00.000Z",
  lastActivityAt: "2026-07-14T15:15:00.000Z",
} as const

const claudeThread = {
  ...base,
  id: "claude-header-fixture",
  title: "Source maps",
  backend: "claude",
  runtime: "turn-idle",
} as unknown as ThreadView

const codexThread = {
  ...base,
  id: "codex-header-fixture",
  title: "Implement the durable title protocol for new Codex sessions",
  backend: "codex",
  runtime: "exited",
  crashed: true,
} as unknown as ThreadView

const factThreads = FACT_CASES.map((c) => ({ ...base, id: c.id, title: c.title, backend: "claude", runtime: "turn-idle", lastActivityAt: new Date(Date.now() - 37 * 60_000).toISOString(), ...c.extra }) as unknown as ThreadView)

store.board = { projectDir: "/fixture", homeDir: "/fixture", threads: FACTS ? factThreads : [claudeThread, codexThread] } as BoardSnapshot

function HeaderFixture({ slug, body = true }: { slug: string; body?: boolean }) {
  return (
    <RadixTabs.Root value="chat" className="flex min-h-0 flex-1 flex-col">
      <ThreadHeader slug={slug} onStatusApplied={() => {}} onClose={() => {}} />
      {body && <div className="flex min-h-28 flex-1 items-center justify-center px-5 text-center text-[12px] text-muted">
        Drawer body — title controls remain in the header title line.
      </div>}
    </RadixTabs.Root>
  )
}

function FactsFixture() {
  return (
    <main className="min-h-screen bg-bg p-4 sm:p-8">
      <div className="mx-auto grid max-w-[900px] gap-4">
        {factThreads.map((t) => (
          <section key={t.id} data-facts-case={t.id} className="overflow-hidden border border-border bg-panel shadow-xl shadow-black/30">
            <HeaderFixture slug={t.id} body={false} />
          </section>
        ))}
      </div>
    </main>
  )
}

function Fixture() {
  if (FACTS) return <FactsFixture />
  return (
    <main className="min-h-screen bg-bg p-4 sm:p-8">
      <div className="mx-auto grid max-w-[900px] gap-6">
        <section className="overflow-hidden border border-border bg-panel shadow-xl shadow-black/30">
          <p className="border-b border-border px-3 py-2 text-[11px] text-muted">Claude idle — click the title itself to edit; no manual-title icon</p>
          <HeaderFixture slug={claudeThread.id} />
        </section>
        <section className="overflow-hidden border border-border bg-panel shadow-xl shadow-black/30">
          <p className="border-b border-border px-3 py-2 text-[11px] text-muted">Codex stalled — retry the recoverable turn without discarding the session</p>
          <HeaderFixture slug={codexThread.id} />
        </section>
        <p data-fixture-rpc-calls className="text-[11px] text-muted">RPC calls: {calls.join(" | ") || "none"}</p>
      </div>
    </main>
  )
}

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <TooltipProvider>
      <Fixture />
    </TooltipProvider>
  </QueryClientProvider>,
)
