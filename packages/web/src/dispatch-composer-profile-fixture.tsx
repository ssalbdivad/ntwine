import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardSnapshot, CodexModel, DispatchInput, DispatchPreferences, SetDispatchPreferenceInput } from "@ntwine/shared"
import { DispatchForm } from "./components/NewThreadModal.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { draftKey, draftStore } from "./lib/drafts.ts"
import { store } from "./store.ts"
import "./styles.css"

const codexModels: CodexModel[] = [
  { slug: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", defaultEffort: "medium", efforts: ["low", "medium", "high"] },
  { slug: "gpt-5.3-codex-spark", displayName: "GPT-5.3-Codex-Spark", defaultEffort: "low", efforts: ["low", "medium"] },
]

let preferences: DispatchPreferences = {
  backend: "codex",
  claude: { permissionMode: "auto" },
  codex: { model: "gpt-5.6-sol", effort: "medium", permissionMode: "default" },
}
const writes: SetDispatchPreferenceInput[] = []
// Every dispatch the box sends, in order — the profile a thread would actually have started on.
const dispatches: DispatchInput[] = []
// The project settings the model picker's gear edits (AgentSettingsPopover). Every settingsSet the
// panel makes is recorded, in order, so a test can prove a pick writes once and writes the whole
// object — and `?settingsDelay=N` holds each write for N ms, which is how the dispatch gate is driven.
let settings: Record<string, unknown> = { permissionMode: "bypassPermissions", notifications: true, autoCompactWindow: 500000, promptCacheTtl: "auto" }
const settingsWrites: Record<string, unknown>[] = []
// The project's NTWINE.md, as the "Project instructions" field sees it. `instructions.disk` stands in
// for the file: a test rewrites it to play a worker editing NTWINE.md behind the open panel, and a
// write whose base revision no longer matches is refused the way the server refuses it.
const instructions = { disk: "Run the tests before committing.", revision: 1, writes: [] as { content: string; baseRevision: string }[] }
const settingsDelay = Number(new URL(window.location.href).searchParams.get("settingsDelay") ?? 0)
const outcome = new URL(window.location.href).searchParams.get("outcome") === "failure" ? "failure" : "success"

declare global {
  interface Window { dispatchComposerProfileFixture?: { preferences: DispatchPreferences; writes: SetDispatchPreferenceInput[]; dispatches: DispatchInput[]; settingsWrites: Record<string, unknown>[]; instructions?: typeof instructions } }
}

window.dispatchComposerProfileFixture = { preferences, writes, dispatches, settingsWrites, instructions }

const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const url = new URL(requestUrl, window.location.origin)
  if (url.pathname === "/_ntwine/rpc/dispatchPreferencesGet") return json(preferences)
  if (url.pathname === "/_ntwine/rpc/codexModels") return json(codexModels)
  if (url.pathname === "/_ntwine/rpc/acpAgents") return json([])
  if (url.pathname === "/_ntwine/rpc/dispatchPreferenceSet") {
    const update = JSON.parse(String(init?.body ?? "{}")) as SetDispatchPreferenceInput
    writes.push(update)
    if (update.field === "profile") {
      preferences = {
        ...preferences,
        backend: update.backend,
        [update.backend]: { ...preferences[update.backend], model: update.model, effort: update.effort },
      }
    }
    window.dispatchComposerProfileFixture = { preferences, writes, dispatches, settingsWrites, instructions }
    return json(preferences)
  }
  if (url.pathname === "/_ntwine/rpc/settingsGet") return json(settings)
  if (url.pathname === "/_ntwine/rpc/projectInstructionsGet") return json({ content: instructions.disk, revision: String(instructions.revision), editable: true })
  if (url.pathname === "/_ntwine/rpc/projectInstructionsSet") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { content: string; baseRevision: string }
    instructions.writes.push(body)
    if (body.baseRevision !== String(instructions.revision)) return json({ ok: false, reason: "conflict", content: instructions.disk, revision: String(instructions.revision) })
    instructions.disk = body.content
    instructions.revision += 1
    return json({ ok: true, content: instructions.disk, revision: String(instructions.revision) })
  }
  if (url.pathname === "/_ntwine/rpc/settingsSet") {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    if (settingsDelay > 0) await new Promise((resolve) => window.setTimeout(resolve, settingsDelay))
    settings = body
    settingsWrites.push(body)
    return json(settings)
  }
  if (url.pathname === "/_ntwine/rpc/dispatch") {
    // A deliberately isolated RPC seam for visual QA: no local server state, worker, terminal, or
    // live thread can be touched from this fixture. The short delay leaves the optimistic task card
    // visible long enough to inspect before either acknowledgement or rollback.
    dispatches.push(JSON.parse(String(init?.body ?? "{}")) as DispatchInput)
    await new Promise((resolve) => window.setTimeout(resolve, 900))
    if (outcome === "failure") return new Response(JSON.stringify({ error: "Fixture dispatch rejected" }), { status: 500, headers: { "content-type": "application/json" } })
    return json({ slug: "fixture-started-thread", sessionId: "fixture-session" })
  }
  return nativeFetch(input, init)
}

function json(result: unknown): Response {
  return new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json", "x-ntwine-boot": "fixture" } })
}

store.board = { projectDir: "/fixture/dispatch-composer" } as BoardSnapshot
// `?pick=<effort>` opens the box on a pick over the default (GPT-5.6 Sol at that effort), the state
// that shows "Make default" — so a screenshot or an ink measurement can start there without driving
// the menu first.
const pick = new URL(window.location.href).searchParams.get("pick")
if (pick) draftStore.set(draftKey.dispatchProfile(store.board.projectDir), JSON.stringify({ backend: "codex", model: "gpt-5.6-sol", effort: pick }))

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <main className="min-h-screen bg-bg p-6">
        <section className="mx-auto max-w-xl rounded-xl border border-border bg-panel p-5">
          <h1 className="mb-3 text-sm font-medium">New thread</h1>
          <DispatchForm />
        </section>
      </main>
    </TooltipProvider>
  </QueryClientProvider>,
)
