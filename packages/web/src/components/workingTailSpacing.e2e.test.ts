import assert from "node:assert/strict"
import test from "node:test"

// Runtime coverage for the LIVE TAIL's rhythm — the shimmer that closes a running
// transcript. Skipped unless a Vite URL serving the fixtures is provided (same pattern as the other
// *.e2e.test.ts here): start `vite` in packages/web and set FRIZZ_WORKING_TAIL_SPACING_E2E_URL to its
// origin.
//
// The invariant (maintainer 2026-07-31: "there's more space above the working shimmer than there is
// below the 'Thought for 37 seconds'"): the shimmer is the LIVE member of the quiet meta column, so
// under a meta tail it joins the same tight 6px run that binds a thought label to the tool bands below
// it — and it must land at the SAME optical white as a settled meta label sitting in that slot. Prose
// above it is the control: that boundary keeps the full STEP break.
//
// Measured in the browser rather than asserted on the tree because this is layout, and specifically
// because the box gap alone is not the claim — a line box 1.4px shorter than its peers put the shimmer's
// INK nearer the card above while every box reading said the gaps agreed.
const baseUrl = process.env.FRIZZ_WORKING_TAIL_SPACING_E2E_URL

// The tight run needs a CARD on at least one side: two bordered blocks 6px apart still read as two.
// Two bare LABEL rows do not — a label has no inset, so the gap is the only separation there is, and
// they take the ordinary STEP. See META_CARD_STEP in ChatView.
const TIGHT = 6
const STEP = 14
// The virtualizer positions rows at fractional offsets, so a measured gap lands within a sub-pixel of
// its constant. Assert the pitch, not the rounding.
const near = (actual: number, expected: number, what: string) =>
  assert.ok(Math.abs(actual - expected) < 0.5, `${what}: expected ~${expected}px, got ${actual}px`)

async function launch() {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 800, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  return { browser, page, errors }
}

const fixtureUrl = (query: string) => new URL(`/working-tail-spacing-fixture.html${query}`, baseUrl).href

// The box gap between the last rendered message row and the runtime-status row, scoped to a surface.
// `drawer` picks the sub-agent sheet's plain column; otherwise the thread's virtualized one.
async function tailGap(page: import("puppeteer").Page, drawer: boolean) {
  return page.evaluate((inDrawer) => {
    const scope = inDrawer
      ? document.querySelector("[data-transcript-column]")
      : document.querySelector("[data-virtualized-transcript]")
    if (!scope) return { error: "surface not mounted" }
    const rows = [...scope.querySelectorAll("[data-frizz-msg]")]
    const working = scope.querySelector("[data-working-indicator]")
    if (!working || rows.length === 0) return { error: "no live tail" }
    const last = rows[rows.length - 1]
    const round = (n: number) => Math.round(n * 10) / 10
    return {
      lastRow: last.getAttribute("data-frizz-msg"),
      aboveWorking: round(working.getBoundingClientRect().top - last.getBoundingClientRect().bottom),
      betweenRows: rows.slice(1).map((r, i) => round(r.getBoundingClientRect().top - rows[i].getBoundingClientRect().bottom)),
    }
  }, drawer)
}

test("the live row joins the meta run, and its typing dots sit like the next card", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { browser, page, errors } = await launch()
  try {
    // 1. The reported column: thought label → two Agent cards → Working…
    await page.goto(fixtureUrl(""), { waitUntil: "domcontentloaded" })
    await page.waitForSelector("[data-working-indicator]")
    const live = await tailGap(page, false)
    assert.equal(live.error, undefined, `thread transcript must mount a live tail: ${live.error}`)
    assert.equal(live.lastRow, "a2", "the shimmer must follow the last Agent card")
    const [afterBubble, ...metaRun] = live.betweenRows!
    assert.ok(afterBubble > TIGHT * 2, `the user bubble keeps a real break, got ${afterBubble}px`)
    for (const gap of metaRun) near(gap, TIGHT, "a meta-run boundary")
    near(live.aboveWorking!, TIGHT, "the shimmer under a meta tail")

    // The row's optical white — the number the report was actually about. Since 2026-10-08 the generic
    // reading is the typing-dots bubble rather than a "Thinking…" label, and a bubble is a FILLED shape:
    // its edge is its ink, so under a card it stands the tight run's own distance away, exactly as the
    // next card would. (A label's cap-top white is the wrong reference for a filled mark.)
    const dotsWhite = await page.evaluate(() => {
      const card = document.querySelector('[data-frizz-msg="a2"]')!.getBoundingClientRect()
      const dots = document.querySelector("[data-working-indicator] .typing-dots")?.getBoundingClientRect()
      return dots ? Math.round((dots.top - card.bottom) * 100) / 100 : null
    })
    assert.ok(dotsWhite !== null, "the generic reading is the typing dots")
    near(dotsWhite!, TIGHT, "the typing dots under a card, as the next card would sit")

    await page.goto(fixtureUrl("?tail=meta"), { waitUntil: "domcontentloaded" })
    await page.waitForSelector('[data-frizz-msg="m1"]')
    // The same page also holds the OTHER pair: that settled label is itself a bare row, and the shimmer
    // sits under IT — two labels, so the ordinary step rather than the card run.
    const metaTail = await tailGap(page, false)
    assert.equal(metaTail.lastRow, "m1", "the meta control must end on the settled label")
    near(metaTail.aboveWorking!, STEP, "the shimmer under a bare label row")

    // 3. CONTROL: prose under the cards restores the full break.
    await page.goto(fixtureUrl("?tail=prose"), { waitUntil: "domcontentloaded" })
    await page.waitForSelector("[data-working-indicator]")
    const prose = await tailGap(page, false)
    assert.equal(prose.lastRow, "p1", "the prose control must be the last rendered row")
    near(prose.aboveWorking!, STEP, "prose above the shimmer")

    // 4. The sub-agent drawer runs the plain column and must not disagree.
    await page.goto(fixtureUrl("?surface=child"), { waitUntil: "domcontentloaded" })
    await page.waitForSelector("[data-transcript-column] [data-working-indicator]")
    const drawer = await tailGap(page, true)
    near(drawer.aboveWorking!, TIGHT, "the drawer shimmer")

    await page.goto(fixtureUrl("?surface=child&tail=prose"), { waitUntil: "domcontentloaded" })
    await page.waitForSelector("[data-transcript-column] [data-working-indicator]")
    const drawerProse = await tailGap(page, true)
    near(drawerProse.aboveWorking!, STEP, "the drawer prose control")

    assert.deepEqual(errors, [], "no console/page errors")
  } finally {
    await browser.close()
  }
})
