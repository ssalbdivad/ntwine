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

// The rail row's PIN verb and mark. Order and fill ARE the contract (maintainer 2026-09-03): a row that
// can be pinned offers an OUTLINE pin LEFTMOST in the hover strip; a PINNED row wears the solid mark in its right-edge column
// and offers the solid slashed unpin RIGHTMOST in the hover strip — after Retry too — so it appears where
// the mark was. And the strip draws no box of its own: its backing is the
// rail's base colour under the row's hover wash, never the old `bg-panel` pill.

const base = {
  kind: "session",
  backend: "claude",
  title: "A thread",
  status: "active",
  runtime: "turn-idle",
  subAgents: [],
} as unknown as ThreadView

// Retry (on the stalled rows) is an eager send and wants the app's query client; the harness supplies
// it exactly as Sidebar.retry.test.ts does.
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

const PINNED = { pinnedAt: "2026-09-02T10:00:00.000Z" } as Partial<ThreadView>
const STALLED = { runtime: "exited", crashed: true, needsYou: true } as Partial<ThreadView>

/** The hover strip's class list — the element the retry test also finds by its `absolute right-1.5`. */
function stripClasses(html: string): string {
  const at = html.indexOf('class="absolute right-1.5')
  assert.notEqual(at, -1, "the row renders its hover strip")
  const start = at + 'class="'.length
  return html.slice(start, html.indexOf('"', start))
}

/** The pin button's icon markup: from the button's data attribute to the end of its svg. */
function pinIcon(html: string): string {
  const at = html.indexOf("data-sidebar-pin=")
  assert.notEqual(at, -1, "the row offers the pin verb")
  return html.slice(at, html.indexOf("</svg>", at))
}

/** The class list of the element carrying `marker`, and the rendered size of the glyph inside it. */
function slot(html: string, marker: string): { classes: string[]; glyph: string | undefined } {
  const at = html.indexOf(marker)
  assert.notEqual(at, -1, `the row renders ${marker}`)
  const start = html.indexOf('class="', at) + 'class="'.length
  const svg = html.indexOf("<svg", at)
  return {
    classes: html.slice(start, html.indexOf('"', start)).split(" ").filter(Boolean),
    glyph: /width="(\d+)" height="(\d+)"/.exec(html.slice(svg))?.slice(1, 3).join("×"),
  }
}

test("a row that can be pinned offers an OUTLINE pin, leftmost in the strip", () => {
  const html = row({})
  assert.doesNotMatch(html, /data-rail-pin-mark/, "no mark in the column — the row is not pinned")
  const icon = pinIcon(html)
  assert.match(icon, /aria-label="Pin thread"/)
  assert.match(icon, /fill="none"/, "the pin is drawn as an outline: a filled pin means pinned")
  assert.doesNotMatch(icon, /fill="currentColor"/)
  const strip = html.lastIndexOf("absolute right-1.5", html.indexOf("data-sidebar-pin="))
  assert.ok(strip !== -1, "the pin is in the hover strip")
  // The only control opened between the strip's start and the pin's attribute is the pin's own button.
  assert.equal(html.slice(strip, html.indexOf("data-sidebar-pin=")).split(/<(?:a|button)\b/).length - 1, 1, "nothing precedes the pin in the strip")
})

test("a pinned row wears the solid mark and offers the solid unpin RIGHTMOST", () => {
  const html = row(PINNED)
  assert.match(html, /data-rail-pin-mark/, "the column carries the pin mark")
  const icon = pinIcon(html)
  assert.match(icon, /aria-label="Unpin thread"/)
  assert.match(icon, /fill="currentColor"/, "the unpin keeps the solid body the mark wears")
  const pinAt = html.indexOf("data-sidebar-pin=")
  // Nothing renders after the unpin inside the strip: its button is the strip's last child.
  const rest = html.slice(html.indexOf("</button>", pinAt) + "</button>".length)
  assert.ok(rest.startsWith("</div>"), `the unpin is the strip's last action, got: ${rest.slice(0, 40)}`)
})

// A pinned row that is WORKING shows its task clock in the right-edge column, and the mark must survive
// beside it, rightmost where the unpin appears on hover (David 2026-09-30: "i shouldnt have to mouse
// over a thread to see that it is pinned" — the mark was gated off every spinning row).
test("a pinned row that is working still wears the mark, after its task clock", () => {
  const html = row({
    ...PINNED,
    runtime: "running",
    statusLine: "Running focused tests",
    statusSince: new Date(Date.now() - 754_000).toISOString(),
  } as Partial<ThreadView>)
  const clockAt = html.indexOf("data-rail-working-age")
  const markAt = html.indexOf("data-rail-pin-mark")
  assert.notEqual(clockAt, -1, "the working row shows its task clock")
  assert.notEqual(markAt, -1, "…and still shows the pin mark")
  assert.ok(clockAt < markAt, "clock → mark, left to right")
})

// The GEOMETRY of that swap is pinned in the browser by railHoverNoShift.e2e.test.ts, which is where a
// 4px jump actually shows up. This is the cheap half of the same contract: the mark and the unpin share
// ONE box, so a future edit that resizes either has to change both deliberately rather than by drift.
test("the mark wears the unpin's own box, so hovering swaps the glyph instead of moving it", () => {
  const html = row(PINNED)
  const mark = slot(html, "data-rail-pin-mark")
  const unpin = slot(html, "data-sidebar-pin=")
  for (const token of ["flex", "h-[19px]", "w-[19px]", "items-center", "justify-center"]) {
    assert.ok(mark.classes.includes(token), `the mark wears the action box's ${token}: ${mark.classes.join(" ")}`)
    assert.ok(unpin.classes.includes(token), `the unpin wears ${token}: ${unpin.classes.join(" ")}`)
  }
  // `self-start` is what puts the in-flow mark's top on the strip's `top-1`; without it the mark
  // baseline-aligns in the title's row and lands wherever the font's metrics put it.
  assert.ok(mark.classes.includes("self-start"), "the mark is pinned to the flex line's cross-start")
  assert.equal(mark.glyph, unpin.glyph, "one glyph size, or the pin grows the moment the pointer arrives")
  assert.equal(mark.glyph, "12×12")
})

test("on a pinned row that also offers Retry, the unpin still sits past Retry, at the far right", () => {
  const html = row({ ...PINNED, ...STALLED })
  const retryAt = html.indexOf("data-sidebar-retry=")
  const pinAt = html.indexOf("data-sidebar-pin=")
  assert.ok(retryAt !== -1 && pinAt !== -1, "Retry and unpin both render")
  assert.ok(retryAt < pinAt, "Retry → unpin, left to right")
})

test("on an unpinned row that offers Retry, the pin keeps its place left of Retry", () => {
  const html = row(STALLED)
  assert.ok(html.indexOf("data-sidebar-pin=") < html.indexOf("data-sidebar-retry="), "pin → Retry")
})

// A terminal thread ntwine only reads offers no pin and no Retry, so it draws no strip at all — an empty
// one would still paint its backing and fade over the title, and take the rest time away on hover.
test("a row with no verb draws no strip", () => {
  const html = row({ foreign: true })
  assert.doesNotMatch(html, /absolute right-1\.5 top-1/, "no hover strip")
})

test("the strip draws no box: its backing is the rail's base colour, and the row's wash paints above it", () => {
  const html = row(PINNED)
  const strip = stripClasses(html)
  assert.doesNotMatch(strip, /\bbg-panel\b/, "the old opaque pill is gone")
  assert.doesNotMatch(strip, /\brounded\b/, "…and so is its rounding")
  assert.match(strip, /\bbg-bg\b/, "the backing is the rail's base colour, so the title cannot bleed through")
  assert.match(strip, /\bbefore:.*from-transparent\b/, "with a fade off its left edge so a covered letter dissolves")
  // The row's hover wash sits ABOVE the strip (an `after:` pseudo), which is what makes the backing
  // invisible — a `hover:bg-*` under the strip would show the backing as a box again.
  const rowAt = html.indexOf('data-sidebar-item="thread"')
  const rowClasses = html.slice(rowAt, html.indexOf(">", rowAt))
  assert.match(rowClasses, /hover:after:opacity-100/, "the wash is the row's after: pseudo, revealed on hover")
  assert.doesNotMatch(rowClasses, /hover:bg-/, "no background wash under the strip")
})

test("a foreign (read-only) row offers no pin verb in either position", () => {
  const html = row({ foreign: true })
  assert.doesNotMatch(html, /data-sidebar-pin=/)
})
