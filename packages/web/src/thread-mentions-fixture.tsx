import { useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardSnapshot, ProjectCard, ThreadView } from "@ntwine/shared"
import { ThreadRow, type RowScope } from "./components/Sidebar.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { Composer } from "./components/Composer.tsx"
import { LinkifiedText } from "./components/LinkifiedText.tsx"
import { MentionIndexProvider } from "./components/MentionLinks.tsx"
import { useMentionCandidates, useOwnMention } from "./hooks/useMentionCandidates.ts"
import { useMarkdownHtml } from "./lib/useMarkdown.ts"
import { setMentionIndex } from "./lib/mentionAutolink.ts"
import { installThreadLinkInterceptor } from "./lib/thread-links.ts"
import { setProjectMentions } from "./lib/projectMentions.ts"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for THREAD HANDLES (2026-09-29): a thread's name shows as its kebab-case handle in the rail,
// the prompt box offers those handles after `@`, and a sent `@handle` links to its thread. Everything
// here is the real component on a stubbed board.
//
//   /thread-mentions-fixture.html?draft=ask%20%40b   — types the draft into the box, caret at its end
//   /thread-mentions-fixture.html?draft=%40shell-budgets.   — the thread's SUB-AGENTS after the dot
//
// `shell-budgets` has a stubbed `subAgentDirectory` (every child it ever dispatched: two live, one under
// a Workflow, one sentence-named and so unaddressable, two returned), so `@shell-budgets.` completes its
// children and `@shell-budgets.cache-keys` in a message opens one. `window.__directoryRequests` counts the
// fetches, so a test can prove typing on does not refetch per keystroke.
//
// `[data-agent-prose]` is AGENT markdown through the real pipeline (useMarkdownHtml → marked → the
// sanitizer) with the app's real delegated `/thread/` listener installed, so its mentions are the links
// an assistant turn draws (lib/mentionAutolink.ts), and clicking one runs the app's own click path.
//
// PROJECTS (2026-10-06): `#` offers this machine's projects (stubbed below, as main.tsx feeds them from the
// project list), a sent `#arktype` links to the page focused on it, and agent prose does the same.
//
// Sans only: `data-font="sans"` is on <html>, the one font the product renders.
document.documentElement.dataset.font = "sans"

const ROW_SCOPE: RowScope = { open: () => {}, page: true }
const base = {
  kind: "session", backend: "claude", titleAuto: false, titleLocked: true, humanBlocked: false, pendingQuestion: false,
  archived: false, foreign: false, state: "open", status: "active", needsYou: false, subAgents: [], bgShells: [],
  watches: [], questions: [], spawnedAt: "2026-09-29T09:00:00.000Z",
} as const
const t = (over: Record<string, unknown>) => ({ ...base, ...over }) as unknown as ThreadView

const threads = [
  t({ id: "shell-budgets", title: "Shell budgets", runtime: "running", statusLine: "Tuning the per-thread cap", lastAssistantAt: "2026-09-29T12:00:00Z" }),
  t({ id: "focus-mode", title: "Focus mode", runtime: "turn-idle", needsYou: true, statusLine: "Waiting on your call about the drawer", lastAssistantAt: "2026-09-29T11:00:00Z" }),
  t({ id: "budget-report", title: "Budget report", runtime: "turn-idle", statusLine: "Drafting the weekly numbers", lastAssistantAt: "2026-09-29T10:00:00Z" }),
  t({ id: "arktype-perf", title: "ArkType perf", runtime: "running", lastAssistantAt: "2026-09-29T09:30:00Z" }),
  t({ id: "resolver", title: "Ship the resolver cache fix", runtime: "turn-idle", lastAssistantAt: "2026-09-29T09:10:00Z" }),
  t({ id: "legacy", title: "Rework the session-limit banner so the countdown reads in the house grammar", runtime: "turn-idle" }),
  t({ id: "billing", title: "Billing webhooks", state: "archived", archived: true, runtime: "exited", statusLine: "Merged", lastAssistantAt: "2026-09-28T10:00:00Z" }),
]
store.board = { threads, projectSlug: "ntwine" } as unknown as BoardSnapshot
// What setBoard does on a real page: point the markdown mention linker at this board.
setMentionIndex("ntwine", threads)
const projectCard = (slug: string, name: string, stale = false) =>
  ({ id: `id-${slug}`, slug, name, path: `/home/u/${slug}`, lastOpenedAt: "", stale, iconStatus: "unknown" }) as ProjectCard
setProjectMentions([projectCard("ntwine", "Ntwine"), projectCard("home", "Home"), projectCard("arktype", "ArkType"), projectCard("beanemachine", "Beane machine"), projectCard("gone", "Gone", true)])

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
const DIRECTORY = {
  threadHandle: "shell-budgets",
  agents: [
    { id: "toolu_keys", label: "Cache keys", address: "shell-budgets.cache-keys", depth: 1, state: "running", startedAt: minutesAgo(12), subagentType: "ntwine:opus-high" },
    { id: "toolu_wave", label: "Wave 2", address: "shell-budgets.wave-2", depth: 1, state: "running", workflow: true, startedAt: minutesAgo(30) },
    { id: "wave2:impl-w3", label: "impl:W3", address: "shell-budgets.wave-2.impl-w3", parentId: "toolu_wave", depth: 2, state: "stale", startedAt: minutesAgo(40) },
    { id: "toolu_sentence", label: "Look at every call site of the cap and report back", depth: 1, state: "running", startedAt: minutesAgo(5) },
    { id: "toolu_audit", label: "Cap audit", address: "shell-budgets.cap-audit", depth: 1, state: "done", outcome: "completed", startedAt: minutesAgo(300), finishedAt: minutesAgo(180) },
    { id: "toolu_sweep", label: "Cache sweep", address: "shell-budgets.cache-sweep", depth: 1, state: "done", outcome: "failed", startedAt: minutesAgo(3000), finishedAt: minutesAgo(2880) },
  ],
}
const directoryRequests: string[] = []
;(window as unknown as { __directoryRequests: string[] }).__directoryRequests = directoryRequests
const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof Request ? input.url : input.toString(), window.location.origin)
  if (url.pathname === "/_ntwine/rpc/subAgentDirectory") {
    const slug = (JSON.parse(url.searchParams.get("input") ?? "{}") as { slug?: string }).slug ?? ""
    directoryRequests.push(slug)
    const result = slug === "shell-budgets" ? DIRECTORY : { threadHandle: undefined, agents: [] }
    return new Response(JSON.stringify({ result }), { status: 200, headers: { "content-type": "application/json" } })
  }
  return nativeFetch(input, init)
}

const hooks = { submitted: [] as string[], value: "" }
;(window as unknown as { __mentions: typeof hooks }).__mentions = hooks
// The drawer stack a mention click pushes, for the e2e to read (a sub-agent layer adds its child's id).
;(window as unknown as { __drawers: () => string[] }).__drawers = () => store.drawers.map((d) => (d.subId ? `${d.kind}:${d.slug}:${d.subId}` : `${d.kind}:${d.slug}`))

function Box() {
  const [value, setValue] = useState("")
  hooks.value = value
  const mentions = useMentionCandidates("focus-mode")
  const ownMention = useOwnMention("focus-mode")
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const draft = new URLSearchParams(location.search).get("draft")
    const ta = root.current?.querySelector("textarea")
    if (!draft || !ta) return
    ta.focus()
    document.execCommand("insertText", false, draft)
  }, [])
  return (
    <div ref={root} className="w-full max-w-[520px]">
      <Composer
        surface="chatComposer"
        value={value}
        onChange={setValue}
        onSubmit={() => {
          hooks.submitted.push(hooks.value)
          setValue("")
        }}
        placeholder="Reply…"
        mentionCandidates={mentions}
        ownMention={ownMention}
      />
    </div>
  )
}

const AGENT_PROSE = [
  "Handed the cap to @shell-budgets; @shell-budgets.cache-keys has the key table, and @ShellBudget.capAudit.",
  "The same bug is in #arktype, and #home has the notes; #12 is GitHub's and #nobody stays text.",
  "",
  "- `@shell-budgets` in code stays code, and so does @types/node.",
  "- [@shell-budgets](https://example.com) is the author's own link. @nobody.cache-keys stays text.",
].join("\n")

function AgentProse() {
  const html = useMarkdownHtml(AGENT_PROSE)
  return <div data-agent-prose className="md-body max-w-[520px] text-[14px]" dangerouslySetInnerHTML={{ __html: html }} />
}

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
installThreadLinkInterceptor(client)

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <TooltipProvider>
      <main className="flex min-h-screen gap-10 bg-bg p-10 text-fg">
        <div data-sidebar-rail className="w-[240px] shrink-0">
          {threads.map((thread) => (
            <ThreadRow key={thread.id} scope={ROW_SCOPE} t={thread} />
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col justify-between gap-10">
          <MentionIndexProvider>
            <div data-mention-bubble className="ml-auto max-w-[420px] rounded-2xl rounded-br-sm bg-user-bubble px-3.5 py-3 text-[14px] whitespace-pre-wrap text-user-bubble-fg">
              <LinkifiedText text={"Ask @shell-budgets about this, and reconcile with @focus-mode. @nobody stays text."} />
            </div>
            <div data-mention-bubble-sub className="ml-auto mt-3 max-w-[420px] rounded-2xl rounded-br-sm bg-user-bubble px-3.5 py-3 text-[14px] whitespace-pre-wrap text-user-bubble-fg">
              <LinkifiedText text={"Compare @shell-budgets.cache-keys with @ShellBudget.capAudit. @shell-budgets.nothing opens the thread."} />
            </div>
            <div data-project-bubble className="ml-auto mt-3 max-w-[420px] rounded-2xl rounded-br-sm bg-user-bubble px-3.5 py-3 text-[14px] whitespace-pre-wrap text-user-bubble-fg">
              <LinkifiedText text={"Port the fix from #arktype and ask @focus-mode. #Home has notes; #nobody stays text."} />
            </div>
          </MentionIndexProvider>
          <AgentProse />
          <Box />
        </div>
      </main>
    </TooltipProvider>
  </QueryClientProvider>,
)
