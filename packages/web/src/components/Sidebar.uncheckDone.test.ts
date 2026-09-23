import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ThreadView } from "@frizz/shared"
import { ThreadRow } from "./Sidebar.tsx"
import { TooltipProvider } from "./Tooltip.tsx"

// The rail's done [✓] is a checkbox: on a row frizz owns it renders as its own checked button, outside
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
      createElement(TooltipProvider, null, createElement(ThreadRow, { t })),
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

test("open, foreign and running-yet-archived rows carry no uncheck control", () => {
  assert.doesNotMatch(row({}), /data-sidebar-uncheck-done/)
  assert.doesNotMatch(row({ ...DONE, foreign: true }), /data-sidebar-uncheck-done/)
  assert.doesNotMatch(row({ ...DONE, runtime: "running" }), /data-sidebar-uncheck-done/)
})
