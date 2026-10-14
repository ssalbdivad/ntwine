import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ThreadView } from "@ntwine/shared"
import { ThreadRow, awaitingReason, sessionIndicatorFor, type RowScope } from "./Sidebar.tsx"
import { TooltipProvider } from "./Tooltip.tsx"

// Where a click would lead. Nothing here clicks; the prop is required because every real row has one.
const ROW_SCOPE: RowScope = { open: () => {}, page: true }

// A RAIL ROW IS ITS TITLE, AND EVERYTHING ELSE IS ONE HOVER AWAY (maintainer 2026-08-19: "there should
// never ever be any fucking thing in the sidebar except for the fucking title"). The row has no
// subtitle line in any state — no PR ref, no snooze, no activity gloss — and the indicator's popover is
// where what ntwine knows about the wait now lives.
//
// That popover is ONE SENTENCE, not a stack of facts. Its first cut printed a fragment per hint kind,
// which read as a machine dumping its record (same day: "that popover text looks fucking terrible"), so
// the state and the fence's clause are joined the way every other tooltip on this rail already joins
// them, and only the worker's own handoff prose gets a line of its own.
//
// The two halves are one decision, and this file pins both. The popover half is asserted on the TIP
// rather than on rendered markup, deliberately: a Radix tooltip renders nothing until it opens, so
// `renderToStaticMarkup` cannot see it, and asserting on the icon alone would happily pass a popover
// that said the wrong thing. The row half is asserted on the MARKUP, because that is the surface the
// rule is about.

const base = {
  kind: "session",
  backend: "claude",
  title: "Ship the resolver fix",
  status: "active",
  runtime: "turn-idle",
  needsYou: false,
  subAgents: [],
} as unknown as ThreadView

// What the worker WROTE, and what the popover SETS — a fence's reason arrives as a lowercase fragment
// (ntwine's own contract modelled one until 2026-08-19), and every surface that draws it standing alone
// presents it as the sentence it is. reasonSentence owns that, and only the first letter moves.
const REASON = "waiting on the three-platform run before porting the v2 drivers"
const SET = "Waiting on the three-platform run before porting the v2 drivers"

const thread = (hints: { kind: string; value: string }[], extra: Partial<ThreadView> = {}, body = "") =>
  ({ ...base, id: "resting-thread", lastFence: { kind: "awaiting", body, hints }, ...extra }) as unknown as ThreadView

function markup(t: ThreadView) {
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(TooltipProvider, null, createElement(ThreadRow, { t, scope: ROW_SCOPE })),
    ),
  )
}

const WAIT = [{ kind: "shell", value: "bzvtnt3ig" }, { kind: "for", value: "2h" }]

test("a parked awaiting thread reads as one sentence, with the worker's own line under it", () => {
  const t = thread([...WAIT], {}, REASON)
  // The band the row is IN leads — that is what the glyph you pointed at is claiming — and what the
  // fence names finishes the sentence. The reason is the only line ntwine did not write, so it is the
  // only one set off on its own: a PARAGRAPH, because the sentence above it wraps and a reason tucked
  // straight under a wrapped line reads as its third line.
  assert.deepEqual((sessionIndicatorFor(t).tip ?? "").split("\n\n"), ["At rest — waiting on an agent terminal", SET])
})

// The same fence ntwine could NOT honour (nothing running behind it) leaves the row in the queue wearing
// the at-rest ellipsis. The popover keeps its shape: only the state word changes, so the two rows never
// mean different things by the same lines.
test("a fence ntwine did not park on swaps the state word and nothing else", () => {
  // needsYou keeps the row in the queue (isSnoozed refuses it), which is the shape of a park the server
  // could not honour: the fence still says what it thinks it is waiting on, and the popover still says it.
  const t = thread([...WAIT], { needsYou: true } as Partial<ThreadView>, REASON)
  assert.deepEqual((sessionIndicatorFor(t).tip ?? "").split("\n\n"), ["At rest — waiting on an agent terminal", SET])
})

test("…and NONE of it reaches the row, which is a title and nothing else", () => {
  const html = markup(thread([{ kind: "pr", value: "acme/app#391" }, ...WAIT], {}, REASON))
  assert.match(html, /resolver/, "the title (shown as its handle, `ship-the-resolver-fix`) is what a row is")
  assert.doesNotMatch(html, new RegExp(REASON.slice(0, 30)), "no reason under it")
  assert.doesNotMatch(html, /acme\/app#391/, "no PR ref under it either — the popover has that now")
})

test("a legacy activity gloss is not a subtitle either", () => {
  const t = { ...base, id: "legacy-thread", activity: "Awaiting CI on PR #391" } as unknown as ThreadView
  assert.doesNotMatch(markup(t), /Awaiting CI on PR #391/)
})

test("a fence with no reason leaves the popover saying only what it knows", () => {
  const tip = sessionIndicatorFor(thread(WAIT)).tip ?? ""
  assert.deepEqual(tip.split("\n"), ["At rest — waiting on an agent terminal"], "and no blank paragraph where a reason would have gone")
  assert.doesNotMatch(tip, new RegExp(REASON.slice(0, 20)), "nothing invented")
})

test("a watched PR leads the list, because it names a thing rather than a shape", () => {
  const t = thread([{ kind: "pr", value: "acme/app#391" }, ...WAIT], {}, REASON)
  assert.deepEqual((sessionIndicatorFor(t).tip ?? "").split("\n\n"), [
    "At rest — waiting on acme/app#391 and an agent terminal",
    SET,
  ])
})

// A snooze on a row the park does not quiet (running, or still waiting on a sub-agent) is stacked onto
// the STATE, not onto the end of the tooltip — the end is the worker's paragraph, and a park line
// landing inside it is the same running-together this shape exists to prevent.
test("a snooze stacks under the state, never inside the worker's paragraph", () => {
  // A row with live background work is excused from Snoozed (hasLiveOps), so it keeps its own glyph and the
  // snooze has to be said in the popover — over a fence that still carries the worker's own prose.
  const t = thread([...WAIT], {
    awaitingBackground: true,
    snoozedUntil: new Date(Date.now() + 26 * 60 * 60 * 1000).toISOString(),
  } as Partial<ThreadView>, REASON)
  const [state, reason] = (sessionIndicatorFor(t).tip ?? "").split("\n\n")
  assert.match(state ?? "", /^At rest — waiting on an agent terminal\nSnoozed until /, "the park is the state's second line")
  assert.equal(reason, SET, "…and the worker's sentence still owns the paragraph below")
})

// A fence written the CURRENT way — YAML frontmatter, a `---`, then Markdown — carries its handoff in the
// BODY, and since 2026-08-24 there is no other source: `reason:` was retired with the YAML cutover, and
// `lastFence` is re-derived from the transcript on every fold rather than persisted, so no fence — however
// old — can still arrive carrying that hint. The popover reads the body, or it shows the state and drops
// the worker's own words entirely.
test("the popover shows the fence's Markdown body", () => {
  const t = thread([...WAIT], {}, "The tap submission is queued behind their CI backlog.")
  assert.deepEqual((sessionIndicatorFor(t).tip ?? "").split("\n\n"), [
    "At rest — waiting on an agent terminal",
    "The tap submission is queued behind their CI backlog.",
  ])
})

test("awaitingReason reads only an awaiting fence, and only a non-empty one", () => {
  assert.equal(awaitingReason(thread([...WAIT], {}, REASON)), SET)
  assert.equal(awaitingReason(thread([...WAIT], {}, "   ")), null, "whitespace is not a reason")
  assert.equal(awaitingReason(thread(WAIT)), null)
  assert.equal(awaitingReason({ lastFence: { kind: "done", body: "", hints: [] } } as unknown as ThreadView), null)
})
