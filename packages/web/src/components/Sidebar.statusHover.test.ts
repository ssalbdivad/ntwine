import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ThreadView } from "@ntwine/shared"
import { ThreadRow, type RowScope } from "./Sidebar.tsx"
import { TooltipProvider } from "./Tooltip.tsx"
import { prefs } from "../lib/prefs.ts"

// A WORKING ROW'S STATUS: inline after its name, the same text either way. By default it is drawn only
// while the row is pointed at or focused (upstream's standup of 2026-10-01: always-visible status lines are
// too dense for a sidebar); Settings → Always show status lines (prefs `alwaysShowStatusLines`) keeps it
// drawn. The task clock stays on the line in both. Static markup pins the classes; the browser QA reads
// the hover.

const ROW_SCOPE: RowScope = { open: () => {}, page: true }

const working = {
  kind: "session",
  backend: "claude",
  title: "Fix the parser",
  status: "active",
  runtime: "running",
  subAgents: [],
  id: "thread",
  statusLine: "Tracing the cache miss",
  statusSince: new Date(Date.now() - 254_000).toISOString(),
} as unknown as ThreadView

function row(t: ThreadView, alwaysShowStatusLines = false): string {
  prefs.alwaysShowStatusLines = alwaysShowStatusLines
  try {
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        createElement(TooltipProvider, null, createElement(ThreadRow, { t, scope: ROW_SCOPE })),
      ),
    )
  } finally {
    prefs.alwaysShowStatusLines = false
  }
}

test("by default a working row's status is inline but drawn only while the row is hovered, and the clock stays", () => {
  const html = row(working)
  const status = html.match(/<span data-rail-status="true"[^>]*>/)?.[0]
  assert.ok(status, "the status is inline after the name")
  assert.match(status, /data-rail-status-hover=""/)
  assert.match(status, /\bhidden group-hover:block group-focus-within:block\b/, "hidden until the row is pointed at or focused")
  assert.match(html, /Tracing the cache miss/)
  assert.match(html, /data-rail-working-age/, "the clock is still on the line")
})

test("with Always show status lines the status is inline after its name, beside its clock", () => {
  const html = row(working, true)
  const status = html.match(/<span data-rail-status="true"[^>]*>/)?.[0]
  assert.ok(status, "the status is on the line")
  assert.doesNotMatch(status, /data-rail-status-hover|\bhidden\b/, "and always drawn")
  assert.match(html, /Tracing the cache miss/)
  assert.match(html, /data-rail-working-age/, "the clock is on the line")
})

test("a row that is not working has no status anywhere, inline or hover", () => {
  const resting = { ...working, runtime: "turn-idle" } as ThreadView
  for (const always of [false, true]) {
    const html = row(resting, always)
    assert.doesNotMatch(html, /data-rail-status/, `alwaysShowStatusLines=${always}`)
    assert.doesNotMatch(html, /data-rail-working-age/, `alwaysShowStatusLines=${always}`)
  }
})
