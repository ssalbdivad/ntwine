import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardSnapshot, CodexModel, DispatchPreferences, GithubItem } from "@ntwine/shared"
import { GithubPickerModal } from "./components/GithubPickerModal.tsx"
import { Toaster } from "./components/Toaster.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Drives the REAL GitHub picker against a stubbed /rpc seam (same idiom as
// dispatch-composer-profile-fixture) so shift-click range selection and PAGING can be exercised in a
// real browser: real React state, real rows, real mouse events, a real page boundary. Row numbers are
// deliberately NON-contiguous and descending, which is what the list really looks like, and it catches
// any code that confuses a row's key with its index.
//
// 74 rows at the picker's 30-per-page = three pages (30 / 30 / 14), so the e2e can prove that paging
// forward keeps a selection made on page 1 and that the batch is no longer capped at 20. `?rows=N`
// shortens the list, which is how the single-page case (no page controls at all) gets driven.
const PAGE_SIZE = 30
const HEAD = [412, 409, 407, 400, 398, 395, 390, 388, 381, 377, 370, 366, 361, 359, 352, 348, 344, 340, 337, 333, 330, 328, 321, 318]
const ALL = [...HEAD, ...Array.from({ length: 50 }, (_, i) => 314 - i * 3)]
const NUMBERS = ALL.slice(0, Number(new URLSearchParams(location.search).get("rows")) || ALL.length)

const items: GithubItem[] = NUMBERS.map((number, i) => ({
  kind: "issue",
  number,
  title: `Fixture issue ${number} — an issue title long enough to truncate in the row`,
  url: `https://github.com/fixture/repo/issues/${number}`,
  state: "OPEN",
  author: i % 3 === 0 ? "octocat" : "hubot",
  createdAt: new Date(Date.now() - (i + 1) * 3 * 60 * 60 * 1000).toISOString(),
  updatedAt: new Date(Date.now() - (i + 1) * 60 * 60 * 1000).toISOString(),
  labels: i % 4 === 0 ? [{ name: "bug", color: "d73a4a" }] : [],
  comments: (i * 3) % 7,
  reactions: (i * 5) % 11,
  // Every 4th row carries linked PRs, cycling open → merged → draft and single → multiple, so the
  // badge is observable in every shape next to rows that have none (the common case must stay
  // uncluttered) and beside the comment/reaction badges it has to tone-match.
  ...(i % 4 === 0
    ? {
        linkedPrs: {
          count: i % 8 === 0 ? 1 : 2,
          number: number + 1,
          url: `https://github.com/fixture/repo/pull/${number + 1}`,
          state: i % 12 === 4 ? "MERGED" : "OPEN",
          isDraft: i % 12 === 8,
        },
      }
    : {}),
}))

const codexModels: CodexModel[] = []
const preferences: DispatchPreferences = {
  backend: "claude",
  claude: { model: "opus", effort: "high", permissionMode: "auto" },
  codex: { permissionMode: "default" },
} as DispatchPreferences

const dispatched: unknown[] = []
// The project settings the header gear edits (GithubPromptPopover): every settingsSet is recorded so
// a test can prove a typing burst writes ONCE, and `?settingsDelay=N` holds each write for N ms to
// drive the dispatch gate.
let settings: Record<string, unknown> = { permissionMode: "bypassPermissions", notifications: true }
const settingsWrites: Record<string, unknown>[] = []
const settingsDelay = Number(new URLSearchParams(location.search).get("settingsDelay") ?? 0)

declare global {
  interface Window { githubPickerRangeFixture?: { dispatched: unknown[]; settingsWrites: Record<string, unknown>[] } }
}
window.githubPickerRangeFixture = { dispatched, settingsWrites }

const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const url = new URL(requestUrl, window.location.origin)
  if (url.pathname === "/_ntwine/rpc/githubStatus") return json({ inRepo: true, authed: true, nameWithOwner: "fixture/repo" })
  if (url.pathname === "/_ntwine/rpc/githubList") {
    // Serve a real PAGE, exactly as the server does: queries carry their input as ?input=<json>, and
    // the response reports which page was served plus the totals the pager renders.
    const input = JSON.parse(url.searchParams.get("input") ?? "{}") as { page?: number; perPage?: number }
    const perPage = input.perPage ?? PAGE_SIZE
    const pageCount = Math.max(1, Math.ceil(items.length / perPage))
    const page = Math.min(Math.max(1, input.page ?? 1), pageCount)
    return json({ items: items.slice((page - 1) * perPage, page * perPage), total: items.length, page, pageCount })
  }
  if (url.pathname === "/_ntwine/rpc/codexModels") return json(codexModels)
  if (url.pathname === "/_ntwine/rpc/acpAgents") return json([])
  if (url.pathname === "/_ntwine/rpc/dispatchPreferencesGet") return json(preferences)
  if (url.pathname === "/_ntwine/rpc/settingsGet") return json(settings)
  if (url.pathname === "/_ntwine/rpc/githubPromptDefaults") return json({ prompt: "Triage {repo}#{n}: {title}\n{url}\n\nRead the whole thread and say what you actually checked." })
  if (url.pathname === "/_ntwine/rpc/settingsSet") {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    if (settingsDelay > 0) await new Promise((resolve) => window.setTimeout(resolve, settingsDelay))
    settings = body
    settingsWrites.push(body)
    return json(settings)
  }
  if (url.pathname === "/_ntwine/rpc/githubDispatchBatch") {
    // Isolated seam: the fixture never starts a worker. It records the payload so a test can assert
    // that what dispatches is exactly what the human watched themselves check.
    dispatched.push(JSON.parse(String(init?.body ?? "{}")))
    return json({ dispatched: [], failed: [] })
  }
  return nativeFetch(input, init)
}

function json(result: unknown): Response {
  return new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json", "x-ntwine-boot": "fixture" } })
}

store.board = { projectDir: "/fixture/github-picker-range" } as BoardSnapshot

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <GithubPickerModal onClose={() => {}} />
      {/* Mounted so any toast the picker raises is observable, exactly as it is in the app. */}
      <Toaster />
    </TooltipProvider>
  </QueryClientProvider>,
)
