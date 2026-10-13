import assert from "node:assert/strict"
import test from "node:test"

// Range selection is a MOUSE gesture: the modifier, the anchor, the browser's own text-selection
// reflex. Unit tests pin the reducer, but only a real browser proves the wiring — that shift reaches
// the handler, that the row's title link doesn't swallow the click, and that dragging across rows
// doesn't paint a text selection over the list. Drive the real component in the fixture page.
const baseUrl = process.env.FRIZZ_GITHUB_PICKER_RANGE_E2E_URL

test("shift-clicking two rows in the GitHub picker selects every row in between, across pages and uncapped", {
  skip: !baseUrl,
  timeout: 90_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  const errors: string[] = []
  const notFound: string[] = []
  page.on("response", (response) => { if (response.status() === 404) notFound.push(new URL(response.url()).pathname) })
  page.on("console", (message) => { if (message.type() === "error" && !message.text().includes("404")) errors.push(message.text()) })
  page.on("pageerror", (error) => errors.push(String(error)))

  // The checkbox sits at the row's left edge — click there so the gesture never lands on the title
  // link (which stops propagation and would open GitHub instead of selecting).
  const CHECKBOX = { x: 14, y: 14 }
  const row = (n: number) => `[data-row-number="${n}"]`
  const click = async (n: number, shift = false) => {
    if (shift) await page.keyboard.down("Shift")
    await page.click(row(n), { offset: CHECKBOX })
    if (shift) await page.keyboard.up("Shift")
  }
  const checked = () => page.$$eval("[data-row-number]", (rows) =>
    rows.filter((r) => r.getAttribute("aria-pressed") === "true").map((r) => Number(r.getAttribute("data-row-number"))))
  const rowNumbers = () => page.$$eval("[data-row-number]", (rows) => rows.map((r) => Number(r.getAttribute("data-row-number"))))
  const bodyText = () => page.$eval("body", (node) => node.innerText.replace(/\s+/g, " "))
  // Wait on the PAGER's own label rather than a row number, so the assertions below never have to
  // hard-code which of the fixture's 74 rows happens to land on which page.
  const turnPage = async (label: "Next page" | "Previous page", expected: number) => {
    await page.click(`[aria-label="${label}"]`)
    await page.waitForFunction((n: number) => document.body.innerText.includes(`Page ${n} of 3`), {}, expected)
  }

  try {
    await page.setViewport({ width: 1100, height: 950, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/github-picker-range-fixture.html`, { waitUntil: "networkidle0" })
    await page.waitForSelector('[data-row-number="412"]')
    const numbers = await rowNumbers()
    assert.equal(numbers.length, 30, "page one renders a full page of rows")
    assert.match(await bodyText(), /74 open issues/, "the pager states the full result count, not the page's")
    assert.match(await bodyText(), /Page 1 of 3/, "the pager states which page of how many")
    assert.deepEqual(await checked(), [], "nothing is selected before the first click")

    // The gesture from the task: click one row, shift-click another, get everything in between.
    await click(400)
    await click(366, true)
    assert.deepEqual(await checked(), [400, 398, 395, 390, 388, 381, 377, 370, 366])

    // Shift+click must not leave the browser's own text selection smeared across the rows.
    assert.equal(await page.evaluate(() => String(window.getSelection() ?? "")), "")

    // A second shift-click re-spans from the SAME anchor, so the range widens rather than restarting.
    await click(348, true)
    assert.deepEqual(await checked(), [400, 398, 395, 390, 388, 381, 377, 370, 366, 361, 359, 352, 348])

    // Shift-clicking UPWARD from a fresh anchor is symmetric, and rows outside the span are untouched.
    await click(321)
    await click(330, true)
    assert.deepEqual(await checked(), [400, 398, 395, 390, 388, 381, 377, 370, 366, 361, 359, 352, 348, 330, 328, 321])

    // Plain-click an already-checked row to uncheck it, then shift-click: the range CLEARS.
    await click(390)
    await click(377, true)
    assert.deepEqual(await checked(), [400, 398, 395, 370, 366, 361, 359, 352, 348, 330, 328, 321])

    // Selecting a WHOLE page in one shift-click is no longer capped at 20 — every row it spans is
    // checked. Reload first for a clean, empty selection.
    await page.reload({ waitUntil: "networkidle0" })
    await page.waitForSelector('[data-row-number="412"]')
    await click(412)
    await click(numbers[numbers.length - 1]!, true)
    assert.deepEqual(await checked(), numbers, "a range across the whole page selects all 30 rows, uncapped")
    assert.match(await bodyText(), /30 selected/, "the pager counts the running selection")

    // Paging forward: new rows, and the page-1 selection SURVIVES — off-page checks still count.
    await turnPage("Next page", 2)
    const secondPage = await rowNumbers()
    assert.equal(secondPage.length, 30, "page two renders its own full page")
    assert.equal(secondPage.some((n) => numbers.includes(n)), false, "page two is a different window of the list")
    assert.deepEqual(await checked(), [], "no page-two row is checked yet…")
    assert.match(await bodyText(), /30 selected/, "…but the page-one selection is still counted")

    // Checking rows here ADDS to the batch, and the dispatch button names the cross-page total.
    const alsoPicked = secondPage.slice(0, 4)
    await click(alsoPicked[0]!)
    await click(alsoPicked[3]!, true)
    assert.deepEqual(await checked(), alsoPicked)
    assert.match(await bodyText(), /34 selected/)
    assert.match(await bodyText(), /Start 34 investigations/, "the button names the whole cross-page batch")

    // The last page is short, and "next" is spent there.
    await turnPage("Next page", 3)
    assert.equal((await rowNumbers()).length, 14, "the final page holds the remainder")
    assert.equal(await page.$eval('[aria-label="Next page"]', (b) => (b as HTMLButtonElement).disabled), true)

    // Stepping back lands on the same rows, with the same checks, unchanged.
    await turnPage("Previous page", 2)
    assert.deepEqual(await checked(), alsoPicked, "paging back restores the page's own checks")

    // What dispatches is the whole cross-page batch — 34 items, well past the old cap of 20.
    await page.$$eval("button", (buttons) => {
      const start = buttons.find((b) => b.textContent?.trim() === "Start 34 investigations")
      if (!start) throw new Error("the dispatch button is missing")
      if ((start as HTMLButtonElement).disabled) throw new Error("the dispatch button is disabled")
      ;(start as HTMLButtonElement).click()
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const sent = await page.evaluate(() => window.githubPickerRangeFixture?.dispatched ?? [])
    assert.equal(sent.length, 1, "one batch went out")
    const batch = (sent[0] as { items: { number: number }[] }).items
    assert.equal(batch.length, 34, "every checked row dispatches, across pages and past the old 20 cap")
    assert.deepEqual(
      batch.map((item) => item.number).sort((a, b) => b - a),
      [...numbers, ...alsoPicked].sort((a, b) => b - a),
    )

    assert.deepEqual(errors, [])
    assert.deepEqual(notFound.filter((path) => path !== "/favicon.ico"), [])
  } finally {
    await browser.close()
  }
})

test("a repo that fits on one page gets the totals line but no page controls", {
  skip: !baseUrl,
  timeout: 90_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  try {
    await page.setViewport({ width: 1100, height: 950, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/github-picker-range-fixture.html?rows=8`, { waitUntil: "networkidle0" })
    await page.waitForSelector('[data-row-number="412"]')
    const body = await page.$eval("body", (node) => node.innerText.replace(/\s+/g, " "))
    assert.match(body, /8 open issues/, "the totals line is worth showing even on one page")
    assert.doesNotMatch(body, /Page 1 of 1/, "a dead one-of-one pager is not")
    assert.equal(await page.$('[aria-label="Next page"]'), null, "no page controls when there is nowhere to page to")
    assert.equal(await page.$('[aria-label="Previous page"]'), null)
  } finally {
    await browser.close()
  }
})
