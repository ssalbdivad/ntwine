import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import * as RadixTabs from "@radix-ui/react-tabs"
import type { BoardSnapshot, CodexModel, DispatchInput, DispatchPreferences, SetThreadDeadlineInput, ThreadView } from "@ntwine/shared"
import { ThreadHeader } from "./components/ChatView.tsx"
import { DispatchForm } from "./components/NewThreadModal.tsx"
import { ThreadRow, type RowScope } from "./components/Sidebar.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { Toaster } from "./components/Toaster.tsx"
import { draftKey, draftStore } from "./lib/drafts.ts"
import { useSnapshot } from "valtio"
import { store } from "./store.ts"
import "./styles.css"

// A THREAD'S TIME LIMIT in every place it shows (components/DeadlineControl.tsx): the prompt box's control,
// the rail rows' countdown in their right-edge column, and the drawer header's facts line, each in the
// three tones — plenty of time, the last stretch, over time — plus a Done row that must show nothing.
// (The queue card's facts line is queue-card-states-fixture `?case=deadline`.)
//
//   ?limit=2h            the prompt box opens on that limit, already typed into its draft
//   ?outcome=failure     the dispatch RPC fails, so the limit has to come back with the prompt
//   &w=<px>              the rail's width (default 320)
//
// Every dispatch body and every setThreadDeadline call is recorded on window.deadlineFixture; `&deadlineFail=1`
// makes setThreadDeadline fail, so its toast can be seen. Always sans:
// it is the only font the app renders (index.html), and a mono measurement is of a page nobody sees.

document.documentElement.dataset.font = "sans"
const params = new URLSearchParams(location.search)

const MIN = 60_000
const deadline = (leftMin: number, budgetMin: number, setBy: "human" | "worker" = "human") => ({
  at: new Date(Date.now() + leftMin * MIN).toISOString(),
  setAt: new Date(Date.now() + (leftMin - budgetMin) * MIN).toISOString(),
  setBy,
})

const base = {
  kind: "session",
  backend: "claude",
  titleAuto: false,
  humanBlocked: false,
  pendingAsk: false,
  pendingQuestion: false,
  archived: false,
  foreign: false,
  state: "open",
  status: "active",
  crashed: false,
  needsYou: false,
  subAgents: [],
  bgShells: [],
  watches: [],
  questions: [],
  spawnedAt: new Date(Date.now() - 3 * 60 * MIN).toISOString(),
  lastAssistantAt: new Date(Date.now() - 6 * MIN).toISOString(),
  lastActivityAt: new Date(Date.now() - 2 * MIN).toISOString(),
} as const

const working = (since: number) => ({ runtime: "running", statusLine: "Running focused tests", statusSince: new Date(Date.now() - since * MIN).toISOString() })

const threads = [
  { ...base, id: "plenty", title: "Rotate the signing key", ...working(12), deadline: deadline(42, 120), context: { tokens: 148_000, window: 200_000 }, subAgents: [{ id: "a1", label: "Audit refresh tokens", state: "running", kind: "agent" }] },
  { ...base, id: "closing", title: "Deflake the auth integration suite", ...working(51), deadline: deadline(4, 60) },
  { ...base, id: "over", title: "Port the parser", ...working(33), deadline: deadline(-8, 30, "worker") },
  { ...base, id: "seconds", title: "Cut the release notes", ...working(3), deadline: deadline(0.7, 10) },
  { ...base, id: "rested", title: "Draft the migration plan", runtime: "turn-idle", needsYou: true, deadline: deadline(95, 240) },
  { ...base, id: "none", title: "No time limit on this one", ...working(7) },
  { ...base, id: "done", title: "A Done thread keeps no clock", runtime: "turn-idle", state: "archived", archived: true, deadline: deadline(-30, 60) },
] as unknown as ThreadView[]

store.board = { projectDir: "/fixture/deadline", homeDir: "/fixture", threads } as unknown as BoardSnapshot
if (params.get("limit")) draftStore.set(draftKey.dispatchDeadline("/fixture/deadline"), params.get("limit")!)

// ---- the network ------------------------------------------------------------------------------------
const codexModels: CodexModel[] = [{ slug: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", defaultEffort: "medium", efforts: ["low", "medium", "high"] }]
const preferences: DispatchPreferences = { backend: "codex", claude: { permissionMode: "auto" }, codex: { model: "gpt-5.6-sol", effort: "medium", permissionMode: "default" } }
const recorded = { dispatches: [] as DispatchInput[], deadlines: [] as SetThreadDeadlineInput[] }
;(window as unknown as { deadlineFixture: typeof recorded }).deadlineFixture = recorded
const failing = params.get("outcome") === "failure"

const json = (result: unknown) => new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json", "x-ntwine-boot": "fixture" } })
const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin)
  if (!url.pathname.startsWith("/_ntwine/")) return nativeFetch(input, init)
  const rpc = /\/rpc\/([^/]+)$/.exec(url.pathname)?.[1]
  const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
  if (rpc === "dispatchPreferencesGet") return json(preferences)
  if (rpc === "codexModels") return json(codexModels)
  if (rpc === "acpAgents") return json([])
  if (rpc === "dispatch") {
    recorded.dispatches.push(body as unknown as DispatchInput)
    await new Promise((resolve) => setTimeout(resolve, 600))
    if (failing) return new Response(JSON.stringify({ error: "Fixture dispatch rejected" }), { status: 500, headers: { "content-type": "application/json" } })
    return json({ slug: "fixture-started", sessionId: "fixture-session" })
  }
  if (rpc === "setThreadDeadline") {
    const call = body as unknown as SetThreadDeadlineInput
    recorded.deadlines.push(call)
    if (params.get("deadlineFail") === "1") return new Response(JSON.stringify({ error: "Fixture refused the time limit" }), { status: 500, headers: { "content-type": "application/json" } })
    // The board push the server would send: the thread's deadline as now set, by the human.
    store.board!.threads = store.board!.threads.map((t) =>
      t.id === call.slug ? { ...t, deadline: call.deadline ? { at: call.deadline, setAt: new Date().toISOString(), setBy: "human" as const } : undefined } : t,
    )
    return json({ deadline: null })
  }
  return json(null)
}

// ---- the page --------------------------------------------------------------------------------------
const ROW_SCOPE: RowScope = { open: () => {}, page: true }
const railWidth = Number(params.get("w") ?? 320)

function Header({ slug }: { slug: string }) {
  return (
    <section data-fixture-header={slug} className="overflow-hidden border border-border bg-panel">
      <RadixTabs.Root value="chat">
        <ThreadHeader slug={slug} onStatusApplied={() => {}} onClose={() => {}} />
      </RadixTabs.Root>
    </section>
  )
}

function Fixture() {
  // The rail reads the board, as the page's does, so a setThreadDeadline the fixture applies shows there too.
  const rows = (useSnapshot(store).board?.threads ?? []) as ThreadView[]
  return (
    <main className="min-h-screen bg-bg p-6 text-fg">
      <div className="flex flex-wrap items-start gap-8">
        <div data-sidebar-rail data-fixture-rail style={{ width: railWidth }}>
          {rows.map((t) => <ThreadRow key={t.id} scope={ROW_SCOPE} t={t} restedAge={t.id === "rested"} />)}
        </div>
        <div className="flex w-[560px] flex-col gap-4">
          <section data-fixture-dispatch className="rounded-xl border border-border bg-panel p-5">
            <DispatchForm />
          </section>
          <Header slug="plenty" />
          <Header slug="closing" />
          <Header slug="over" />
          <Header slug="none" />
        </div>
      </div>
      <Toaster />
    </main>
  )
}

const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <TooltipProvider>
      <Fixture />
    </TooltipProvider>
  </QueryClientProvider>,
)
