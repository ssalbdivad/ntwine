import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { ThreadView } from "@frizz/shared"
import { ThreadRow } from "./Sidebar.tsx"
import { TooltipProvider } from "./Tooltip.tsx"

const thread = {
  id: "reading-position",
  kind: "session",
  title: "A currently visible queue card",
  backend: "codex",
  runtime: "turn-idle",
  status: "needs-human",
  needsYou: true,
  subAgents: [],
} as unknown as ThreadView

function row(active: boolean, open = false) {
  return renderToStaticMarkup(
    createElement(TooltipProvider, null, createElement(ThreadRow, { t: thread, active, open })),
  )
}

test("the scroll marker is a full-row-height vertical rule in a dedicated rail", () => {
  const html = row(true)
  const railStart = html.indexOf("data-sidebar-marker-rail")
  const markerStart = html.indexOf("data-sidebar-scroll-marker")
  const buttonStart = html.indexOf("<button")

  assert.ok(railStart >= 0, "every thread row reserves a marker rail")
  assert.ok(markerStart > railStart, "the active rule renders inside that rail")
  assert.ok(buttonStart > markerStart, "the row content follows the marker rail")
  assert.match(html, /w-5/, "the rail reserves a 20px gutter")
  assert.match(html, /inset-y-0 left-1 w-\[2px\]/, "the rule is vertical and follows the complete row height")
  assert.doesNotMatch(html, /h-\[2px\] w-3/, "the obsolete horizontal bar cannot return")
  assert.match(html, /pl-5 pr-1\.5/, "the icon and text begin after the reserved rail")
})

test("inactive sidebar rows reserve the same rail without rendering a false current-position bar", () => {
  const html = row(false)
  assert.match(html, /data-sidebar-marker-rail/)
  assert.doesNotMatch(html, /data-sidebar-scroll-marker/)
})


// The drawer's row is LIT, not marked: the scroll marker stays the queue's reading position (the
// keyboard steps from it), and the row whose thread is up in the side drawer holds its wash instead —
// one step stronger than hover, so pointing at a neighbour never reads as opening it.
test("a row whose thread is open in the drawer holds a stronger wash and no scroll marker", () => {
  const open = row(false, true)
  assert.match(open, /data-sidebar-open="true"/)
  assert.match(open, /after:bg-hover-strong after:opacity-100/)
  assert.doesNotMatch(open, /data-sidebar-scroll-marker/, "opening a thread does not move the reading marker")
  const closed = row(false)
  assert.doesNotMatch(closed, /data-sidebar-open/)
  assert.match(closed, /after:bg-hover after:opacity-0 hover:after:opacity-100/)
})

