import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BgShellView, EndedShellView, ThreadTerminal, ThreadView } from "@ntwine/shared"
import { ProcessRow, ThreadProcessStrip } from "./components/ThreadTerminals.tsx"
import { humanProcess } from "./lib/threadProcesses.ts"
import { ThreadCheckoutToken } from "./components/ThreadCheckoutToken.tsx"
import { HumanTerminalHeader, TerminalSheet } from "./components/TerminalSheet.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { Toaster } from "./components/Toaster.tsx"
import { initFont } from "./lib/font.ts"
import { setThemePreference } from "./lib/theme.ts"
// xterm's own sheet, as main.tsx loads it: without it the agent drawer's hidden measure row (`1111…`) and
// helper textarea render visibly above the log, and a shot of it is not the product's.
import "@xterm/xterm/css/xterm.css"
import "./styles.css"

// ONE STRIP, TWO OWNERS — every state a terminal row can be in, side by side, for the states a live stack
// cannot reach on demand: a finished and a failed run of yours, an agent shell over its budget or quiet,
// a Codex exec whose output ntwine cannot read, a monitor — once as the drawer draws them (every row) and once
// as a queue card does (the live rows only). A row names its folder only when it is not where the header
// token says the agent is (`?here=`); a row the server could not place names nothing.
// `?mode=codex` / `?mode=gone` show the agent drawer's two empty states, `?mode=agent` a streaming one with a
// long title and a worktree folder (for the narrow header), `?mode=header` your terminal's drawer header while
// it waits for input in a worktree (the folder must survive beside `waiting for input · 4m` at 390px). `data-font="sans"` is on the page, as in the product. No server: every RPC
// is answered here, and nothing is started or stopped.
const params = new URLSearchParams(location.search)
const mode = params.get("mode") ?? "strip"
setThemePreference(params.get("theme") === "dark" ? "dark" : "light")
initFont()
const json = (result: unknown) => new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json" } })
const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  const url = new URL(href, location.href)
  if (!url.pathname.startsWith("/_ntwine/rpc/")) return nativeFetch(input, init)
  const method = url.pathname.split("/").at(-1)
  if (method === "backgroundShellActivity") {
    // A query: its input rides the URL (`?input=<json>`), not a body.
    const input = JSON.parse(url.searchParams.get("input") ?? "{}") as { ids?: string[] }
    return json({ shells: (input.ids ?? []).map((id, i) => ({ id, lines: 40 + i * 37, running: true })) })
  }
  if (method === "backgroundShellOutput") {
    if (mode === "agent") {
      const body = init?.body ? JSON.parse(String(init.body)) as { input?: { from?: number } } : {}
      const from = body.input?.from ?? 0
      const line = `\x1b[32mtick\x1b[0m ${Math.floor(from / 16) + 1}\n`
      return json({ state: "running", command: "for i in $(seq 600); do printf '\\e[32mtick\\e[0m %s\\n' $i; sleep 1; done", output: from === 0 ? line.repeat(3) : line, truncated: false, stoppable: true, stopNote: null, end: from + 16, cwd: "/home/u/repo/.ntwine/worktrees/probe", checkout: WT })
    }
    return mode === "codex"
      ? json({ state: "running", command: "cargo watch -x test", output: "", truncated: false, stoppable: true, stopNote: null, end: 0, outputUnavailable: true, cwd: "/home/u/repo/.ntwine/worktrees/probe", checkout: { dir: "/home/u/repo/.ntwine/worktrees/probe", kind: "worktree" } })
      : json({ state: "done", command: "nub run test", output: "", truncated: false, stoppable: false, stopNote: null, end: 0, missing: true, cwd: "/home/u/repo" })
  }
  return json({})
}

const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
const ahead = (m: number) => new Date(Date.now() + m * 60_000).toISOString()
const WT = { dir: "/home/u/repo/.ntwine/worktrees/probe", kind: "worktree" as const }
// Where the header says the agent is working: `?here=probe` (the default) puts it in the worktree, so the
// rows still at the root say `root`; `?here=root` puts it at the root, so the rows in `probe` say `probe`.
const here = params.get("here") === "root" ? undefined : WT
const ROOT = "/home/u/repo"
const terminals: ThreadTerminal[] = [
  { id: "t-prompt", command: "npm login", cwd: ROOT, atRoot: true, state: "running", awaitingInput: true, awaitingSince: ago(1), runId: 1, startedAt: ago(2) },
  { id: "t-run", command: "npm run dev", cwd: WT.dir, checkout: WT, state: "running", runId: 1, startedAt: ago(40) },
  { id: "t-long", command: 'read -p "Deploy to staging? " x; sleep 200', cwd: ROOT, atRoot: true, state: "running", runId: 1, startedAt: ago(4) },
  { id: "t-ok", command: "git status", cwd: ROOT, atRoot: true, state: "exited", exitCode: 0, runId: 1, startedAt: ago(9) },
  { id: "t-fail", command: "nub run typecheck-that-fails-on-purpose", cwd: ROOT, atRoot: true, state: "exited", exitCode: 2, runId: 1, startedAt: ago(5) },
  // Left in a worktree that has since been removed: the server has no reading, so it claims no place.
  { id: "t-gone", command: "tail -f build.log", cwd: `${ROOT}/.ntwine/worktrees/removed`, state: "running", runId: 1, startedAt: ago(30) },
]
const bgShells: BgShellView[] = [
  { id: "s-root", label: "vite dev server", startedAt: ago(72), state: "running", stoppable: true, taskId: "b1", cwd: ROOT, atRoot: true },
  { id: "s-wt", label: "Test watch in the probe worktree", startedAt: ago(12), state: "running", stoppable: true, taskId: "b2", budgetEndsAt: ahead(33), cwd: WT.dir, checkout: WT },
  { id: "s-over", label: "Watch the CI run for the strip branch", startedAt: ago(61), state: "running", stoppable: true, taskId: "b3", budgetEndsAt: ago(1), cwd: ROOT, atRoot: true },
  { id: "s-quiet", label: "tail the deploy log", startedAt: ago(20), state: "stale", taskId: "b4", monitor: true },
  // A long name beside a short status, where the agent is: a rail row with no hint, whose name must run up to
  // its own status rather than stop where the group's widest status begins.
  { id: "s-docs", label: "Serve the docs site with live reload for the review", startedAt: ago(5), state: "running", stoppable: true, taskId: "b5", cwd: WT.dir, checkout: WT },
  // A Codex exec whose item named no folder: no place claimed.
  { id: "s-codex", label: "cargo watch -x test", command: "cargo watch -x test", startedAt: ago(3), state: "running", stoppable: true, outputUnavailable: true },
]
// Finished agent terminals, listed as your finished ones are (the drawer's strip only — a card lists what is live).
const endedShells: EndedShellView[] = [
  { id: "e-quick", label: "Quick build at the root", status: "completed", startedAt: ago(8), finishedAt: ago(7), cwd: ROOT, atRoot: true },
  { id: "e-lint", label: "Lint the probe worktree", status: "failed", startedAt: ago(15), finishedAt: ago(14), cwd: WT.dir, checkout: WT },
  // Older runs, enough that the drawer's strip folds its finished rows past the newest three (collapseFinished).
  { id: "e-old1", label: "Restarting the docs dev server", status: "killed", startedAt: ago(50), finishedAt: ago(45), cwd: ROOT, atRoot: true },
  { id: "e-old2", label: "Running the root test suite", status: "completed", startedAt: ago(58), finishedAt: ago(52), cwd: ROOT, atRoot: true },
  { id: "e-old3", label: "Building the docs site for production", status: "completed", startedAt: ago(66), finishedAt: ago(60), cwd: ROOT, atRoot: true },
]
const thread = { id: "fixture", terminals, bgShells, endedShells, watches: [], ...(here ? { checkout: here } : {}) } as Pick<ThreadView, "id" | "terminals" | "bgShells" | "endedShells" | "watches" | "checkout">

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <TooltipProvider>
      <main data-terminals-fixture={mode} className="mx-auto min-h-screen max-w-[720px] bg-bg p-5 text-fg">
        {mode === "strip" && (
          <div className="flex flex-col gap-6">
            {/* The drawer header's second line and the card's meta line, each with the token. */}
            <div data-fixture-meta="header" className="flex min-w-0 items-center gap-1.5 text-[11px] leading-tight text-muted-75">
              <span>READY</span>
              <span aria-hidden className="shrink-0 opacity-60">·</span>
              <time className="min-w-0 truncate">Last active 9m ago</time>
              <ThreadCheckoutToken checkout={here} homeDir="/home/u" lead={<span aria-hidden className="shrink-0 opacity-60">·</span>} />
            </div>
            <div data-fixture-meta="card" className="flex min-w-0 items-baseline gap-1.5 text-[11px] leading-tight text-muted-75">
              <span className="min-w-0 truncate">Ready 9m ago</span>
              <ThreadCheckoutToken checkout={{ dir: "/srv/other-checkout", kind: "folder" }} homeDir="/home/u" lead={<span aria-hidden>·</span>} />
            </div>
            <div data-fixture-strip="drawer" className="rounded-md border border-border bg-panel px-4 py-3">
              <ThreadProcessStrip thread={thread} surface="drawer" onOpen={() => {}} />
            </div>
            <div data-fixture-strip="card" className="rounded-md border border-border bg-panel px-4 py-3">
              {/* The prompting terminal's own row, as a queue card captions its live screen with it
                  (TerminalPromptPane) — the screen itself needs a pty, so it is a box here. */}
              <div data-fixture-caption className="px-1">
                <ProcessRow process={humanProcess(terminals[0]!)} slug="fixture" here={here} caption onOpen={() => {}} />
              </div>
              <div className="mt-1.5 mb-3 h-10 rounded-md border border-attention/40" />
              <ThreadProcessStrip thread={thread} surface="card" onOpen={() => {}} />
            </div>
          </div>
        )}
        {mode === "header" && (
          <div data-fixture-header className="fixed inset-x-0 top-0 bg-panel">
            <HumanTerminalHeader
              terminal={{ id: "t-read", command: 'read -p "name? " x; echo "got $x"; sleep 600', cwd: "/tmp/tu-r3-v-repo/.ntwine/worktrees/probe", checkout: { dir: "/tmp/tu-r3-v-repo/.ntwine/worktrees/probe", kind: "worktree" }, state: "running", awaitingInput: true, awaitingSince: ago(4), runId: 1, startedAt: ago(4) }}
              homeDir="/home/u"
              pending={null}
              onAct={() => {}}
              onClose={() => {}}
            />
          </div>
        )}
        {(mode === "codex" || mode === "gone" || mode === "agent") && (
          <TerminalSheet
            id={1}
            slug="fixture"
            source={{ owner: "agent", shellId: mode === "codex" ? "s-codex" : mode === "agent" ? "s-wt" : "s-gone" }}
            label={mode === "codex" ? "cargo watch -x test" : mode === "agent" ? "Test watch in the probe worktree" : "nub run test"}
            startedAt={ago(mode === "agent" ? 9 : 3)}
            depth={0}
            widthDepth={0}
          />
        )}
      </main>
      <Toaster />
    </TooltipProvider>
  </QueryClientProvider>,
)
