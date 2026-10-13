import assert from "node:assert/strict"
import test from "node:test"

// Runtime coverage for the QUIET META COLUMN — the `Ran N tool calls` digest, a collapsed reasoning row
// and the live shimmer. Skipped unless a Vite URL serving the fixtures is provided (same pattern as the
// other *.e2e.test.ts here): start `vite` in packages/web and set NTWINE_META_COLUMN_RHYTHM_E2E_URL to
// its origin.
//
// Two invariants, both from the same report (maintainer 2026-08-01, on a column reading `Ran 8 tool
// calls` / `Thought for 33s` / the shimmer: "All of these labels are way too close together"):
//
//   1. A QUEUED steer is invisible inline — it is pinned to the bottom of the pane — so it must not end
//      the activity run it happens to sit inside. It used to, which stranded the calls above it as a
//      settled digest for no cause the reader could see.
//   2. Two bare single-line LABEL rows sit at the ordinary STEP. The 6px tight run needs a bordered
//      CARD on at least one side of the seam — two borders that close together still read as two
//      blocks, whereas two bare grey lines that close together read as one wrapped paragraph.
//      Measured in the browser because it is layout.
const baseUrl = process.env.NTWINE_META_COLUMN_RHYTHM_E2E_URL

const STEP = 14
// The virtualizer positions rows at fractional offsets, so a measured gap lands within a sub-pixel of
// its constant.
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

const fixtureUrl = (query: string) => new URL(`/meta-column-rhythm-fixture.html${query}`, baseUrl).href

// Every rendered row of the transcript column in paint order, plus the live shimmer, with the box gap
// above each. The queued bubbles render BELOW the runtime-status row, so ordering by `top` is what puts
// them where the reader actually sees them rather than where the transcript array puts them.
async function column(page: import("puppeteer").Page) {
  return page.evaluate(() => {
    const scope = document.querySelector("[data-virtualized-transcript]")
    if (!scope) return { error: "transcript not mounted" }
    const round = (n: number) => Math.round(n * 10) / 10
    const items = [...scope.querySelectorAll("[data-ntwine-msg]")].map((e) => ({
      id: e.getAttribute("data-ntwine-msg")!,
      top: e.getBoundingClientRect().top,
      bottom: e.getBoundingClientRect().bottom,
    }))
    const working = scope.querySelector("[data-working-indicator]")
    if (working) items.push({ id: "SHIMMER", top: working.getBoundingClientRect().top, bottom: working.getBoundingClientRect().bottom })
    items.sort((a, b) => a.top - b.top)
    return {
      order: items.map((i) => i.id),
      gapAbove: Object.fromEntries(items.slice(1).map((item, i) => [item.id, round(item.top - items[i].bottom)])),
      digests: [...scope.querySelectorAll("[data-tool-activity] button")].map((b) => b.getAttribute("aria-label") ?? ""),
      shimmer: working?.querySelector("[data-working-label]")?.textContent ?? null,
    }
  })
}

test("a queued steer is transparent to the activity run, and label rows keep their own step", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { browser, page, errors } = await launch()
  try {
    // 1. The reported state: the steer is still QUEUED, so nothing visible breaks the run it sits in.
    //    The whole thing is one live run — withheld from history behind the shimmer — so no digest may
    //    appear between the prose and it.
    await page.goto(fixtureUrl(""), { waitUntil: "domcontentloaded" })
    await page.waitForSelector("[data-working-indicator]")
    const queued = await column(page)
    assert.equal(queued.error, undefined, `fixture must mount: ${queued.error}`)
    // The queued bubbles stay out of the run, and the typing dots come AFTER them: the dots answer the
    // newest message, never sit above it (maintainer 2026-10-08).
    assert.deepEqual(queued.order, ["m0", "m1", "m8", "m11", "SHIMMER"], "the queued bubbles render above the typing dots, not inside the run")
    assert.deepEqual(queued.digests, [], "a live run stays behind the shimmer — the queued steer must not strand it as a settled digest")
    assert.equal(queued.shimmer, "Finding callers of the socket resolver", "the newest ordinary call still names the shimmer")

    // 2. SETTLED: the turn is over, so the whole run returns as ONE digest — never `Ran 8` / `Ran 2`
    //    split by the bubble that was never drawn between them.
    await page.goto(fixtureUrl("?state=settled"), { waitUntil: "domcontentloaded" })
    await page.waitForSelector("[data-tool-activity] button")
    const settled = await column(page)
    assert.deepEqual(settled.digests, ["Expand 10 tool calls: Ran 10 tool calls"], "one digest for the whole run")
    assert.deepEqual(settled.order, ["m0", "m1", "m8", "m11"], "the queued bubbles still render last, below the settled column")

    // 3. CONTROL — the steer LANDED, so it genuinely ends the run: it sits inline and the calls above it
    //    settle into their own digest, which is exactly what must NOT happen while it is still queued.
    await page.goto(fixtureUrl("?steer=landed"), { waitUntil: "domcontentloaded" })
    await page.waitForSelector("[data-working-indicator]")
    const landed = await column(page)
    assert.deepEqual(landed.order, ["m0", "m1", "m8", "m11", "SHIMMER"], "a delivered steer sits inline, between the run it interrupted and the one it started; the still-queued send stays above the typing dots")
    assert.deepEqual(landed.digests, ["Expand 8 tool calls: Ran 8 tool calls"], "the interrupted run settles at its real count")
    // The human's own words still open a wider break below them, so the label step did not quietly
    // flatten the rest of the rhythm into one uniform gap.
    assert.ok(landed.gapAbove!.SHIMMER > STEP, `a user bubble above the shimmer keeps its break, got ${landed.gapAbove!.SHIMMER}px`)

    // 4. THE reported arrangement, and the one this rhythm exists for: three bare labels in a row. A
    //    Codex `reasoning` row splits a run — digest, label, shimmer — and codex thinks before nearly
    //    every call, so this is the common shape rather than an edge case. Every seam is the ordinary
    //    step; none may fall back to the card run, which is what made the column paint as one block of
    //    grey.
    await page.goto(fixtureUrl("?stack=three"), { waitUntil: "domcontentloaded" })
    await page.waitForSelector("[data-working-indicator]")
    const three = await column(page)
    assert.deepEqual(three.order, ["m0", "m1", "r1", "SHIMMER"], "digest, reasoning label and shimmer stack with nothing between them")
    assert.deepEqual(three.digests, ["Expand 8 tool calls: Ran 8 tool calls"], "the reasoning row splits the run, settling the calls above it")
    near(three.gapAbove!.r1, STEP, "a reasoning label under a settled digest")
    near(three.gapAbove!.SHIMMER, STEP, "the shimmer under that reasoning label")

    assert.deepEqual(errors, [], "no console/page errors")
  } finally {
    await browser.close()
  }
})
