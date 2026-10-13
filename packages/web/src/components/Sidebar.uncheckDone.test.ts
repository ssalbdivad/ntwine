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

// The rail's done [✓] is a checkbox: on a row ntwine owns it renders as its own checked button, outside
// the row's button, so unchecking it reopens the thread instead of opening the drawer.

const base = {
  kind: "session",
  backend: "claude",
  title: "A thread",
  status: "active",
  runtime: "turn-idle",
  subAgents: [],
} as unknown as ThreadView

function row(extra: Partial<ThreadView>) {
  const t = { ...base, id: "thread", ...extra } as ThreadView
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(TooltipProvider, null, createElement(ThreadRow, { t, scope: ROW_SCOPE })),
    ),
  )
}

const DONE = { state: "archived", archived: true } as Partial<ThreadView>
const UNCHECK = 'data-sidebar-uncheck-done="thread"'

test("an archived row's check is a checked checkbox outside the row button", () => {
  const html = row(DONE)
  assert.match(html, /<button[^>]*role="checkbox"[^>]*aria-checked="true"[^>]*data-sidebar-uncheck-done="thread"/)
  const rowButtonEnd = html.indexOf("</button>")
  assert.ok(html.indexOf(UNCHECK) > rowButtonEnd, "the checkbox is a sibling, never nested in the row's button")
  assert.equal(html.match(/data-rail-glyph="archived"/g)?.length, 1, "the check is drawn exactly once")
})

test("open and foreign rows carry no uncheck control", () => {
  assert.doesNotMatch(row({}), /data-sidebar-uncheck-done/)
  assert.doesNotMatch(row({ ...DONE, foreign: true }), /data-sidebar-uncheck-done/)
})

test("a done row whose worker is still running keeps its uncheck — and shows its spinner in it", () => {
  const html = row({ ...DONE, runtime: "running" })
  // Only the human unchecks Done, so the control stays…
  assert.match(html, /data-sidebar-uncheck-done/)
  // …but the glyph in it is the running spinner, never a silent check (maintainer, hit 3x; 7a20f425).
  assert.match(html, /data-rail-glyph="working"/)
  assert.doesNotMatch(html, /data-rail-glyph="archived"/)
  assert.match(html, /aria-label="Done, still working — uncheck to reopen"/)
})
