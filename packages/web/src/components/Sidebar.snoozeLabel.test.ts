import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ThreadView } from "@ntwine/shared"
import { ThreadRow, type RowScope } from "./Sidebar.tsx"
import { TooltipProvider } from "./Tooltip.tsx"

// Where a click would lead. Nothing here clicks; the prop is required because every real row has one.
const ROW_SCOPE: RowScope = { open: () => {}, page: true }

// A SNOOZE IS TOOLTIP-ONLY ON THE RAIL, and so is everything else. No sidebar row spends a subtitle line
// on a park — not the Snoozed ones (single-line since the two-styles fix), and since 2026-08-03 not the ones
// a park does not quiet either: a running thread and one still waiting on a sub-agent kept an inline
// "SNOOZED · Today at 5:00 PM" / "BUMPS · …" gloss, which spent the rail's scarcest real estate
// restating what the hourglass beside it already signals ("hide the SNOOZED label from the sidebar … the
// user should be able to see the snooze duration by hovering over the icon"). The rail has since dropped
// the subtitle ENTIRELY (2026-08-19), which is the last test in this file.
//
// This pins the ABSENCE. The tooltip half cannot be asserted here — Radix portals its content only once
// open, so static markup never contains it — and is pinned by a real hover in
// scripts/verify-snooze-tooltip.mjs against snoozed-rows-fixture.html.

const base = {
  kind: "session",
  backend: "claude",
  title: "A thread the human parked",
  status: "active",
  runtime: "turn-idle",
  subAgents: [],
} as unknown as ThreadView

// Far enough out that the park is always in the future, whenever the suite runs.
const UNTIL = new Date(Date.now() + 26 * 60 * 60 * 1000).toISOString()

function row(extra: Partial<ThreadView>) {
  const t = { ...base, id: "parked-thread", ...extra } as ThreadView
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(TooltipProvider, null, createElement(ThreadRow, { t, scope: ROW_SCOPE })),
    ),
  )
}

test("a snoozed row never glosses its park inline, in any band", () => {
  const cases: [string, Partial<ThreadView>][] = [
    // Snoozed: the park has taken effect and the row is a single line already.
    ["a plain park at rest", { snoozedUntil: UNTIL }],
    ["a park with an armed bump", { snoozedUntil: UNTIL, snoozePrompt: "Check whether CI went green." }],
    // NOT held — isSnoozed excuses a running thread and one with live sub-agents, so these stay in Active
    // wearing their live glyph. They are exactly the rows the label used to sit on.
    ["a park on a running thread", { snoozedUntil: UNTIL, runtime: "running" }],
    [
      "a park on a thread still waiting on a sub-agent",
      {
        snoozedUntil: UNTIL,
        snoozePrompt: "Check whether CI went green.",
        subAgents: [{ id: "op-1", label: "verify", state: "running", startedAt: new Date().toISOString() }],
      } as Partial<ThreadView>,
    ],
  ]
  for (const [what, extra] of cases) {
    const html = row(extra)
    assert.doesNotMatch(html, /SNOOZED/, `${what}: the rail must not carry a SNOOZED label`)
    assert.doesNotMatch(html, /BUMPS/, `${what}: the rail must not carry a BUMPS label`)
    // The wake time itself is equally out — it is the tooltip's job, not the subtitle's.
    assert.doesNotMatch(html, /Snoozed until|Auto-snoozed until/, `${what}: the wake time belongs in the tooltip only`)
  }
})

test("and neither does anything else — the row is a title, full stop", () => {
  // The park label went first (2026-08-03), the worker's reason next (2026-08-16), and the PR ref last
  // (maintainer 2026-08-19: "there should never ever be any fucking thing in the sidebar except for the
  // fucking title"). `needsYou` is the row that held out longest: the server leaves an unhonoured park in
  // the QUEUE, and that row is the one that still had a subtitle to put a ref in.
  const html = row({ needsYou: true, lastFence: { kind: "awaiting", body: "", hints: [{ kind: "pr", value: "acme/app#391" }] } } as Partial<ThreadView>)
  assert.doesNotMatch(html, /acme\/app#391/, "the ref is a hover away, on the indicator's popover")
})
