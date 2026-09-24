import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ThreadView } from "@frizz/shared"
import { ThreadRow } from "./Sidebar.tsx"
import { TooltipProvider } from "./Tooltip.tsx"

// THE CUE'S REST-TIME COLUMN (maintainer 2026-08-08: "a right-justified label on each item in the cue
// indicating when the thread came to rest"). Three things are pinned here, and the middle one is the
// one a plausible-looking implementation gets wrong:
//
//   · it renders ONLY on the cue's rows — a spinning row has not handed anything back, so there is no
//     rest to date, and the column would be printing its live activity under a heading that says rest;
//   · the instant is the agent's OWN last output (`lastAssistantAt`), NOT the tailer's last record of
//     any kind — a background sub-agent completing bumps `lastActivityAt` and must not re-date a rest
//     the human is still holding. That is `lastActiveLabelAt`'s whole job, and the same key the band is
//     ordered by, so the column reads monotonically down the cue;
//   · the visible text carries no "ago" (the column position is the "ago"); the exact phrase stays in
//     the hover title, where there is room for it.

const base = {
  kind: "session",
  backend: "claude",
  title: "Fix queue focus after an archive",
  status: "active",
  runtime: "turn-idle",
  needsYou: true,
  subAgents: [],
} as unknown as ThreadView

// Padded off the exact unit boundary on purpose. `useNowMs` reads a MODULE-LEVEL clock that only
// re-samples once something subscribes to it, and a static render never subscribes — so the "now" this
// markup is built against is the instant liveClock.ts was imported, a second or two before the test
// body runs. Land each case mid-unit and that skew cannot flip a floor()ed reading down a unit.
const ago = (ms: number) => new Date(Date.now() - ms - 30_000).toISOString()

function row(extra: Partial<ThreadView>, restedAge = true) {
  const t = { ...base, id: "fix-queue-focus", ...extra } as ThreadView
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(TooltipProvider, null, createElement(ThreadRow, { t, restedAge })),
    ),
  )
}

test("a cue row dates its rest from the agent's own last output, without the word ago", () => {
  const html = row({ lastAssistantAt: ago(12 * 60_000), lastActivityAt: ago(0) })
  assert.match(html, /data-rail-rested-age/)
  // 12m, from lastAssistantAt — NOT "just now" off the later lastActivityAt a child bumped.
  assert.match(html, />12m</)
  assert.doesNotMatch(html, />12m ago</)
  // The full phrase survives on the hover title, which has the room the column does not.
  assert.match(html, /title="12m ago"/)
})

test("the column is the CUE's alone — a running row carries no rest time", () => {
  const html = row({ runtime: "running", needsYou: false, lastActivityAt: ago(60_000) }, false)
  assert.doesNotMatch(html, /data-rail-rested-age/)
})

test("a thread that has never produced output falls back rather than printing nothing", () => {
  // No lastAssistantAt at all (a dispatch that has not spoken yet): lastActiveLabelAt falls through to
  // the tailer's activity, then to spawn — the column stays populated instead of leaving a hole in it.
  const html = row({ lastAssistantAt: undefined, lastActivityAt: undefined, spawnedAt: ago(3 * 60 * 60_000) })
  assert.match(html, />3h</)
})

test("a thread that entered the queue off a wait dates from its ENTRY, so the column stays monotonic", () => {
  // Rested 3h ago behind a wait that let it into the queue 12m ago: the cue orders it by the entry
  // (orderQueue), so the column prints the entry too — "3h" at the bottom of a line of "12m"s would read
  // as the order being wrong.
  const html = row({ lastAssistantAt: ago(3 * 60 * 60_000), queuedAt: ago(12 * 60_000) })
  assert.match(html, />12m</)
  assert.match(html, /aria-label="Queued 12m ago"/)
})
