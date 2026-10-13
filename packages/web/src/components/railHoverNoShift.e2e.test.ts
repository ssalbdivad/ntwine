import assert from "node:assert/strict"
import test from "node:test"

const baseUrl = process.env.FRIZZ_RAIL_HOVER_NO_SHIFT_E2E_URL

// NOTHING IN A RAIL ROW MOVES WHEN THE POINTER ARRIVES (maintainer 2026-09-03: "there should be no
// layout shift here between these two versions on hover … it should be in the exact same place when
// you hover versus not hover. This should be true for all icons that show up in the sidebar rows").
//
// The bug this pins: a pinned row wore its solid mark in the right-edge column, and the unpin that
// replaces it on hover sat in the hover strip — two different layout mechanisms landing 4.00px apart
// horizontally and, in mono, 0.65px apart vertically. Both boxes read as "the row's right edge" in the
// source; only the pixels disagreed. So this asserts GEOMETRY in a real browser rather than class
// names, because the classes looked right the whole time it was broken.
//
// BOTH FONTS, because the mark's old placement was a `cap`-derived nudge onto the title's cap band and
// the strip centres on the title's first LINE BOX — readings that agree to 0.08px in sans and diverge
// to 0.65px in mono. A one-font check would have called the old code correct.
test("no icon in a rail row moves between rest and hover, in either app font", {
  skip: !baseUrl,
  timeout: 120_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  const errors: string[] = []
  // The bare fixture page serves no favicon; every other missing resource still fails the test.
  const notFound: string[] = []
  page.on("response", (response) => { if (response.status() === 404) notFound.push(new URL(response.url()).pathname) })
  page.on("console", (message) => { if (message.type() === "error" && !message.text().includes("404")) errors.push(message.text()) })
  page.on("pageerror", (error) => errors.push(String(error)))

  // Read every mark a row can carry, plus the boxes that would betray a reflow. An svg's geometry
  // children ARE its ink, so the ink centre is the union of their rects — the number the eye reads,
  // and the only one that survives a glyph swapping for a differently-shaped one.
  const probe = () => {
    const round = (n: number) => Math.round(n * 100) / 100
    const boxOf = (el: Element | null) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) return null
      return { x: round(r.left), y: round(r.top), w: round(r.width), h: round(r.height) }
    }
    const inkOf = (el: Element | null) => {
      const svg = el?.querySelector("svg")
      if (!svg) return null
      const rects = [...svg.querySelectorAll("path,rect,circle,ellipse,polyline,polygon,line")].map((g) => g.getBoundingClientRect())
      if (rects.length === 0) return null
      const left = Math.min(...rects.map((r) => r.left))
      const right = Math.max(...rects.map((r) => r.right))
      const top = Math.min(...rects.map((r) => r.top))
      const bottom = Math.max(...rects.map((r) => r.bottom))
      return { cx: round((left + right) / 2), cy: round((top + bottom) / 2) }
    }
    const out: Record<string, Record<string, unknown>> = {}
    for (const row of document.querySelectorAll<HTMLElement>("[data-sidebar-item]")) {
      out[row.dataset.sidebarItem!] = {
        row: boxOf(row),
        title: boxOf(row.querySelector("span.break-words")),
        // The status glyph in the row's own left column: always on, and it must not budge either.
        indicator: boxOf(row.querySelector("span.w-4")),
        indicatorInk: inkOf(row.querySelector("span.w-4")),
        markBox: boxOf(row.querySelector("[data-rail-pin-mark]")),
        markInk: inkOf(row.querySelector("[data-rail-pin-mark]")),
        pinBox: boxOf(row.querySelector("[data-sidebar-pin]")),
        pinInk: inkOf(row.querySelector("[data-sidebar-pin]")),
      }
    }
    return out
  }

  try {
    await page.setViewport({ width: 900, height: 900, deviceScaleFactor: 1 })
    for (const font of ["sans", "mono"]) {
      await page.goto(`${baseUrl}/sidebar-pin-fixture.html?font=${font}`, { waitUntil: "networkidle0" })
      const rest = await page.evaluate(probe)
      const ids = Object.keys(rest)
      assert.ok(ids.length >= 4, `${font}: the fixture renders its rows, got ${ids.length}`)

      for (const id of ids) {
        await page.hover(`[data-sidebar-item="${id}"]`)
        const hover = (await page.evaluate(probe))[id]
        const at = rest[id]

        // NO REFLOW: the row, its title and its status glyph are where they were. A hover action that
        // took layout instead of overlaying would move all three, and a wrapped title would rewrap.
        for (const part of ["row", "title", "indicator", "indicatorInk"] as const) {
          assert.deepEqual(hover[part], at[part], `${font} / ${id}: the row's ${part} moved on hover`)
        }

        // THE PINNED ROW'S ONE SLOT: the mark at rest and the unpin on hover are the same box, and
        // their ink centres coincide — so the pin swaps for the slashed pin without moving.
        if (at.markBox) {
          assert.ok(hover.pinBox, `${font} / ${id}: a pinned row offers its unpin on hover`)
          assert.deepEqual(hover.pinBox, at.markBox, `${font} / ${id}: the unpin does not land on the mark's box`)
          assert.deepEqual(hover.pinInk, at.markInk, `${font} / ${id}: the unpin's ink centre is not the mark's`)
        }
      }
      // Hovering a row must not disturb its NEIGHBOURS either: a mark that reflowed one row's title
      // could push every row below it down the rail.
      await page.mouse.move(0, 0)
      assert.deepEqual(await page.evaluate(probe), rest, `${font}: the rail did not return to its resting layout`)
    }

    assert.deepEqual(errors, [], "the fixture renders with no console or page errors")
    assert.deepEqual(notFound.filter((p) => p !== "/favicon.ico"), [], "no missing resources")
  } finally {
    await browser.close()
  }
})
