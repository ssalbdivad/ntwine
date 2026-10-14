import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { SectionHeader } from "./Sidebar.tsx"

// A band's header in the list (TierList.tsx): Pinned, Ready and Working are static lines that nothing
// folds (upstream 2026-09-19: they "should not be collapsible"); a quiet band's header is its fold. Each
// says its band's name from the band table and carries `data-band-header`, and its glyph stands in the
// rows' indicator column.

const html = (props: Parameters<typeof SectionHeader>[0]) => renderToStaticMarkup(createElement(SectionHeader, props))

test("a loud band's header is a static line: no button, no fold, no chevron", () => {
  for (const band of ["pinned", "ready", "working"] as const) {
    const out = html({ band, count: 3 })
    assert.match(out, new RegExp(`^<div data-band-header="${band}" data-xq-band-label="${band}"`))
    assert.doesNotMatch(out, /<button|aria-expanded|data-band-chevron/)
    assert.match(out, /data-xq-indicator/, "the glyph stands in the indicator column")
    assert.match(out, />3</)
  }
})

test("a quiet band's header is its fold, with the chevron in the gutter and its state said", () => {
  const closed = html({ band: "done", count: 34, collapsed: true, onToggle: () => {} })
  assert.match(closed, /^<button type="button" data-band-header="done"/)
  assert.match(closed, /aria-expanded="false"/)
  assert.match(closed, /title="Show done"/)
  assert.match(closed, /data-band-chevron/)
  const open = html({ band: "snoozed", count: 2, collapsed: false, onToggle: () => {} })
  assert.match(open, /aria-expanded="true"/)
  assert.match(open, /title="Hide snoozed"/)
})

test("Schedules has a header of its own, and its count takes the warning tone when one wants the human", () => {
  const out = html({ band: "schedules", count: 1, collapsed: true, onToggle: () => {}, attention: true })
  assert.match(out, /Schedules/)
  assert.match(out, /text-attention-soft[^>]*>1</)
})
