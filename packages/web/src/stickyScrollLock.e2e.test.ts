import assert from "node:assert/strict"
import test from "node:test"

// Runtime coverage for the ROOT SCROLL MODEL, which only a browser can settle: `html` must keep its
// own overflow `visible` so a modal's `body{overflow:hidden}` propagates to the VIEWPORT instead of
// turning <body> into a scroll container that re-anchors every `position: sticky` descendant. When it
// did, opening the "End this session?" confirmation over a scrolled queue moved the whole sidebar
// column `scrollY` pixels above the fold and it read as gone (2026-08-26). Skipped unless a Vite URL
// serving the fixtures is provided (same pattern as the other *.e2e.test.ts here): start `vite` in
// packages/web and set FRIZZ_STICKY_SCROLL_LOCK_E2E_URL to its origin.
const baseUrl = process.env.FRIZZ_STICKY_SCROLL_LOCK_E2E_URL

const SCROLL_TO = 600

test("a modal scroll lock leaves the rail exactly where it was, and still pins the page", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { launchHeadless } = await import("../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
    const errors: string[] = []
    page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
    page.on("pageerror", (e) => errors.push(String(e)))

    await page.goto(`${baseUrl}/sticky-scroll-lock-fixture.html`, { waitUntil: "networkidle0" })
    await page.waitForSelector("[data-sticky-rail]")

    const probe = () => page.evaluate(() => {
      const rail = document.querySelector("[data-sticky-rail]")!.getBoundingClientRect()
      return {
        railTop: Math.round(rail.top),
        railLeft: Math.round(rail.left),
        scrollY: Math.round(window.scrollY),
        // The scrollbar gutter every layout number in this app assumes is 0 (see styles.css). Radix
        // compensates for whatever it measures, so a non-zero reading here would shift the page.
        gutter: window.innerWidth - document.documentElement.clientWidth,
        locked: document.body.hasAttribute("data-scroll-locked"),
      }
    })

    await page.evaluate((y) => window.scrollTo(0, y), SCROLL_TO)
    await new Promise((r) => setTimeout(r, 120))
    const scrolled = await probe()
    assert.equal(scrolled.scrollY, SCROLL_TO)
    assert.equal(scrolled.railTop, 0, "the rail sticks to the top of the viewport while the page scrolls")
    assert.equal(scrolled.gutter, 0)

    // Dispatched in-page rather than through page.click, which scrolls its target into view first and
    // would undo the scroll offset this test is entirely about.
    await page.evaluate(() => document.querySelector<HTMLButtonElement>("[data-open-dialog]")!.click())
    await page.waitForSelector('[role="dialog"]')
    await page.waitForFunction(() => document.body.hasAttribute("data-scroll-locked"))
    await new Promise((r) => setTimeout(r, 200))
    const open = await probe()
    assert.equal(open.locked, true, "the modal must actually engage react-remove-scroll's body lock")
    // THE REGRESSION: this read -600 with `html { overflow-y: scroll }` in styles.css.
    assert.equal(open.railTop, scrolled.railTop, "the rail must not move when the modal opens")
    assert.equal(open.railLeft, scrolled.railLeft, "…and must not shift horizontally either")
    assert.equal(open.scrollY, SCROLL_TO, "the page must not jump")
    assert.equal(open.gutter, 0, "no scrollbar gutter appears for Radix to compensate for")

    // The lock is not merely cosmetic — a wheel over the page still must not scroll it.
    await page.mouse.move(300, 700)
    await page.mouse.wheel({ deltaY: 500 })
    await new Promise((r) => setTimeout(r, 250))
    const wheeled = await probe()
    assert.equal(wheeled.scrollY, SCROLL_TO, "the page stays pinned under the modal")
    assert.equal(wheeled.railTop, 0)

    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'))
    await new Promise((r) => setTimeout(r, 200))
    const closed = await probe()
    assert.equal(closed.railTop, 0, "the rail is still stuck to the viewport after the modal closes")
    assert.equal(closed.scrollY, SCROLL_TO, "closing restores nothing because nothing was displaced")

    // A PIN DEEPER THAN THE PAGE (App.tsx's drawer lock, `body{position:fixed; top:-y}`, after the queue
    // shrank under the drawer). A sticky column could never ride past the bottom of its container, so with
    // the page ending above the fold it was dragged up by the difference (2026-10-07, and again 2026-10-08
    // after a page-height patch). The fixed column answers to the viewport alone.
    const pinned = await page.evaluate(() => {
      const depth = document.documentElement.scrollHeight + 800
      Object.assign(document.body.style, { position: "fixed", top: `${-depth}px`, left: "0", right: "0", width: "100%" })
      const rail = document.querySelector("[data-sticky-rail]")!.getBoundingClientRect()
      return { railTop: Math.round(rail.top), railLeft: Math.round(rail.left) }
    })
    assert.deepEqual(pinned, { railTop: 0, railLeft: closed.railLeft }, "the rail stays on screen under a pin deeper than the page")
    assert.deepEqual(errors, [], "no console/page errors during the flow")
  } finally {
    await browser.close()
  }
})
