import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ThreadView } from "@ntwine/shared"
import { ThreadRow, sessionIndicatorFor, type RowScope } from "./Sidebar.tsx"
import { TooltipProvider } from "./Tooltip.tsx"

// Where a click would lead. Nothing here clicks; the prop is required because every real row has one.
const ROW_SCOPE: RowScope = { open: () => {}, page: true }

// A QUEUED WAIT ON A TIMER WEARS THE HOURGLASS, NOT THE SHELL'S DOT (2026-09-07). A timer park queues
// (board.deriveNeedsYou keeps it a visible handoff), so its row sits in the Rested band — and there,
// from 2026-08-24, it wore the pulsing blue dot: groups.restingOnLiveBackgroundWork counted an armed
// timer as motion. The dot is the rail's word for "a process it launched is still running", and nothing
// runs behind a timer (maintainer: "an item in the queue that's awaiting a timer should show up with the
// hourglass icon in the sidebar, not with the flashing blue dot").
//
// Two halves, pinned on two surfaces. The MARK is asserted on the rendered markup — lucide stamps its
// icon name onto the <svg>, and the dot is a styled span (Sidebar.tsx shellDot) matched by class. The
// TIP is asserted through the sessionIndicatorFor seam, because a Radix tooltip renders nothing until
// it opens and static markup cannot see it.

const base = {
  kind: "session",
  backend: "claude",
  title: "Close the August numbers",
  status: "active",
  runtime: "turn-idle",
  needsYou: true,
  awaitingBackground: true,
  subAgents: [],
  bgShells: [],
} as unknown as ThreadView

// Two hours out, so the countdown below reads as a fixed "2h" whatever the wall clock says.
const fireAt = new Date(Date.now() + 2 * 60 * 60 * 1000 + 30_000).toISOString()
const armedTimer = {
  id: "timer:close-the-august-numbers:tmr_0028d7f6c28d",
  kind: "timer" as const,
  target: "tmr_0028d7f6c28d",
  state: "armed" as const,
  createdAt: "2026-09-07T09:00:00.000Z",
  timer: { fireAt, prompt: "August is closed — generate the investor update." },
}

function html(extra: Partial<ThreadView>) {
  const t = { ...base, id: "close-the-august-numbers", ...extra } as ThreadView
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(TooltipProvider, null, createElement(ThreadRow, { t, scope: ROW_SCOPE })),
    ),
  )
}

const HOURGLASS = /lucide-hourglass/
const SHELL_DOT = /ntwine-rail-dot/

test("a queued thread resting on a registered timer wears the hourglass and names the wake", () => {
  // The shape the worker contract steers toward: `mcp__ntwine__timer` armed, then a bare rest. No fence
  // to read, so the clause is synthesized and the countdown is the resting card's own words.
  const t = { ...base, id: "close-the-august-numbers", watches: [armedTimer] } as ThreadView
  const markup = html({ watches: [armedTimer] })
  assert.match(markup, HOURGLASS, "the row says it is parked on the clock")
  assert.doesNotMatch(markup, SHELL_DOT, "…and never claims a running process")
  assert.equal(sessionIndicatorFor(t).tip, "At rest — waiting on a timer — fires in 2h")
})

test("a fenced timer park in the queue reads its clause off the fence and still counts down", () => {
  const fenced = {
    lastFence: {
      kind: "awaiting" as const,
      body: "Seven commits on the branch, lint and typecheck clean.",
      hints: [{ kind: "timer" as const, value: "tmr_0028d7f6c28d" }, { kind: "for" as const, value: "7d" }],
    },
    watches: [armedTimer],
  }
  const t = { ...base, id: "close-the-august-numbers", ...fenced } as ThreadView
  assert.match(html(fenced), HOURGLASS)
  // State, then the fence's clause, then the wake — and the worker's own prose on its own line.
  assert.equal(
    sessionIndicatorFor(t).tip,
    "At rest — waiting on a timer — fires in 2h\n\nSeven commits on the branch, lint and typecheck clean.",
  )
})

test("a running shell beside the timer does not take the mark back, and a PR watch does", () => {
  const shell = { watches: [armedTimer], bgShells: [{ label: "nub run dev", startedAt: "2026-09-07T09:00:00.000Z", state: "running" as const }] }
  assert.match(html(shell), HOURGLASS, "a dev server it also left running is not what it waits FOR")
  assert.doesNotMatch(html(shell), SHELL_DOT)
  const pr = { id: "github:close-the-august-numbers:acme/app#391", kind: "github" as const, target: "acme/app#391", state: "armed" as const, createdAt: "2026-09-07T09:00:00.000Z" }
  assert.match(html({ watches: [armedTimer, pr] }), /lucide-github/, "the timer is the watch's backstop, not the subject")
})
