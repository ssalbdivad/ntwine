import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import { SectionHeader, ThreadRow } from "./components/Sidebar.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Reproduces the HELD band from the maintainer's screenshot: a user-snoozed thread and an
// `awaiting timer:` thread. Before the fix these rendered on TWO lines in two divergent styles
// ("SNOOZED · Tomorrow at 11:11 AM" vs "Snoozed until today at 11:09 PM"); after the fix both are a
// SINGLE line and the wake detail lives only in the hourglass tooltip (hover the indicator).
//
// The ACTIVE band below carries the rows a snooze does NOT quiet — a running thread, and one still
// waiting on a sub-agent. Those kept an inline "SNOOZED · …" / "BUMPS · …" subtitle until 2026-08-03
// ("hide the SNOOZED label from the sidebar … the user should be able to see the snooze duration by
// hovering over the icon"), so they are single-line too now and their park rides the SPINNER's tooltip
// as a second line under "Working".

// Wall-clock targets computed at load so the rows always sit in the future (Snoozed requires it).
const timerAt = (() => {
  const d = new Date()
  d.setHours(23, 9, 0, 0) // "today at 11:09 PM"
  if (d.getTime() <= Date.now() + 60_000) d.setDate(d.getDate() + 1)
  return d.toISOString()
})()
const snoozeAt = (() => {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(11, 11, 0, 0) // "tomorrow at 11:11 AM"
  return d.toISOString()
})()

const base = {
  kind: "session",
  backend: "codex",
  runtime: "turn-idle",
  status: "active",
  titleAuto: false,
  needsYou: false,
  humanBlocked: false,
  pendingAsk: false,
  pendingQuestion: false,
  crashed: false,
  archived: false,
  foreign: false,
  state: "open",
  subAgents: [],
  bgShells: [],
  spawnedAt: "2026-07-21T09:00:00.000Z",
  lastAssistantAt: "2026-07-21T12:00:00.000Z",
} as const

// Row A — a worker parked itself with an ```awaiting timer:` fence.
const timerThread = {
  ...base,
  id: "check-in-on-create-prs",
  title: "Check in on create-* pull requests",
  lastFence: { kind: "awaiting", hints: [{ kind: "timer", value: timerAt }] },
} as unknown as ThreadView

// Row B — the human hit Snooze on the thread (snoozedUntil set by rpc.setThreadSnooze).
const snoozeThread = {
  ...base,
  id: "dependabot-nub-ecosystem",
  title: "dependabot-nub-ecosystem",
  snoozedUntil: snoozeAt,
} as unknown as ThreadView

// Row C — a worker whose turn was CUT OFF by the subscription SESSION limit; frizz will auto-resume it
// when the window resets. NOT a snoozed row any more (2026-08-31): it queues as a failed thread and
// wears the YELLOW hourglass — the counter-example this fixture keeps so the two hourglasses can be
// compared side by side. Like a stalled row it carries the hover-revealed Retry, so an operator with
// capacity elsewhere can continue it now.
const limitAt = Math.floor((Date.now() + 42 * 60_000) / 1000) // "resets in ~42 min"
const limitThread = {
  ...base,
  id: "refactor-usage-endpoint",
  title: "Refactor the usage-limit endpoint",
  runtime: "exited",
  needsYou: true,
  limitPause: { backend: "claude", window: "session", at: "2026-07-23T00:00:00.000Z", resumesAt: limitAt, autoResume: true },
} as unknown as ThreadView

// Row F — a PR-watching thread (`prs:`) the human parked with the "PR watcher armed" card's Snooze. A
// watch never parks itself, so this is how one reaches the Snoozed band — as did a `human:` gate co-declared
// beside the watch, until the 2026-08-15 grammar deleted that kind along with the `pr-watch:` spelling
// this row was named for. Until 2026-08-03 it sat here under the same hourglass as A and B, saying nothing
// about the PR that is actually going to wake it. It now wears GitHub's mark, and its tooltip leads
// with the ref: the snooze is only a safety timeout, and new PR activity clears it.
const watchThread = {
  ...base,
  id: "watch-the-resolver-pr",
  title: "Fix the cache collision in the resolver",
  snoozedUntil: snoozeAt,
  lastFence: { kind: "awaiting", body: "PR is open and CI is green. Watching for review.", hints: [{ kind: "pr", value: "acme/app#391" }] },
} as unknown as ThreadView

// Row D — snoozed WHILE ITS OWN TURN RUNS. isSnoozed excuses a running thread, so the park has not taken
// effect: the row keeps its spinner and stays in Active. It is the row that used to read "SNOOZED · …".
const runningSnoozed = {
  ...base,
  id: "seed-the-buried-question-queue",
  title: "Seed the buried-question queue",
  runtime: "running",
  snoozedUntil: snoozeAt,
} as unknown as ThreadView

// Row E — snoozed with a BUMP armed (a follow-up frizz sends at the deadline), still waiting on a live
// sub-agent. Same excusal, and it is the row that used to read "BUMPS · …".
const bumpingSnoozed = {
  ...base,
  id: "watch-the-release-workflow",
  title: "Watch the release workflow",
  snoozedUntil: snoozeAt,
  snoozePrompt: "Check whether the release job went green and cut the tag if so.",
  subAgents: [{ id: "op-1", label: "verify:release", state: "running", startedAt: new Date().toISOString() }],
} as unknown as ThreadView

store.board = { threads: [timerThread, snoozeThread, watchThread, limitThread, runningSnoozed, bumpingSnoozed] } as BoardSnapshot

function ActiveBand() {
  return (
    <section aria-label="Active">
      <SectionHeader band="working" count={2} />
      <ThreadRow t={runningSnoozed} />
      <ThreadRow t={bumpingSnoozed} />
    </section>
  )
}

function HeldBand() {
  // Mirrors the real Sidebar HELD section markup (hr + label + count) so the visual context matches;
  // the ROWS are the real ThreadRow component under test. The limit-killed row sits OUTSIDE this band
  // on purpose (see RestedBand): since 2026-08-31 a limit kill queues instead of snoozing.
  return (
    <section aria-label="Snoozed">
      <hr className="my-3 border-border/50" />
      <SectionHeader band="snoozed" count={3} />
      <ThreadRow t={timerThread} />
      <ThreadRow t={snoozeThread} />
      <ThreadRow t={watchThread} />
    </section>
  )
}

function RestedBand() {
  // The limit-killed row's real home: THE QUEUE — the cue band the real rail draws at the TOP, one row
  // per queue card (this is not a new band; the fixture mocks the existing one). Undimmed, accent
  // hourglass — rendered on the same page as the muted Snoozed hourglasses precisely so the two can be
  // told apart at a glance.
  return (
    <section aria-label="Rested">
      <SectionHeader band="ready" count={1} />
      <ThreadRow t={limitThread} restedAge />
      <hr className="my-3 border-border/50" />
    </section>
  )
}

// The usage-limit row now renders RowRetryButton, whose Retry is an ordinary eager send
// (lib/retrySession → sendEagerFollowUp) and so reads the query client the real app always provides.
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <main className="min-h-screen bg-bg px-10 py-10 text-fg">
        <div data-sidebar-rail className="w-[clamp(320px,34vw,680px)]">
          <RestedBand />
          <ActiveBand />
          <HeldBand />
        </div>
      </main>
    </TooltipProvider>
  </QueryClientProvider>,
)
