import assert from "node:assert/strict"
import test from "node:test"

// Runtime coverage for a thread's TIME LIMIT in the browser (DeadlineControl.tsx): the prompt box's limit is
// raw text in the draft, resolved at the Enter that starts the thread, cleared by the dispatch and handed back
// by a failed one; a limit that no longer parses stops the submit; and the drawer's chip and ⋯ menu extend,
// set and remove a thread's limit through setThreadDeadline. All of it rides the draft store, the dispatch
// mutation's lifecycle and Radix popovers — runtime pieces no source test can pin.
//
// Drives deadline-fixture, which records every dispatch body and every setThreadDeadline call and applies the
// latter to its board as the server's push would. Skipped unless NTWINE_DEADLINE_E2E_URL names a vite serving
// the fixtures (scripts/e2e-web.mjs sets it).
const baseUrl = process.env.NTWINE_DEADLINE_E2E_URL

type Page = import("puppeteer").Page
type Recorded = { dispatches: { prompt?: string; deadline?: string }[]; deadlines: { slug: string; deadline: string | null }[] }
const PILL = "[data-dispatch-time-limit]"
const MIN = 60_000

async function launch(query = "") {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !/404|500|favicon|Failed to load resource/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.goto(`${baseUrl}/deadline-fixture.html${query}`, { waitUntil: "networkidle0" })
  await page.waitForSelector('button[aria-label="Model and effort"][data-profile-known="true"]')
  return { browser, page, errors }
}

const recorded = (page: Page): Promise<Recorded> =>
  page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as { deadlineFixture: Recorded }).deadlineFixture)) as Recorded)
const pillState = (page: Page) => page.$eval(PILL, (el) => ({ state: (el as HTMLElement).dataset.dispatchTimeLimit, text: el.querySelector("[data-time-limit-text]")?.textContent ?? "" }))
const toast = (page: Page, pattern: RegExp) =>
  page.waitForFunction((source) => new RegExp(source).test(document.querySelector("[data-toast]")?.textContent ?? ""), { timeout: 5_000 }, pattern.source)

async function send(page: Page, text: string) {
  await page.click("textarea")
  await page.keyboard.type(text)
  await page.keyboard.press("Enter")
}

test("a preset sets the box's limit, the dispatch carries it resolved at the Enter, and the box clears", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    assert.deepEqual(await pillState(page), { state: "none", text: "" }, "no limit reads as the stopwatch alone")
    await page.click(PILL)
    await page.waitForSelector("[data-time-limit-panel]")
    await page.click('[data-time-limit-preset="1h"]')
    await page.waitForFunction(() => !document.querySelector("[data-time-limit-panel]"))
    assert.deepEqual(await pillState(page), { state: "set", text: "1h" })

    const before = Date.now()
    await send(page, "port the parser")
    await page.waitForFunction(() => (window as unknown as { deadlineFixture: Recorded }).deadlineFixture.dispatches.length === 1, { timeout: 5_000 })
    const after = Date.now()
    const sent = Date.parse((await recorded(page)).dispatches[0]!.deadline ?? "")
    assert.ok(sent >= before + 60 * MIN - 1_000 && sent <= after + 60 * MIN + 1_000, "an hour from the Enter")
    await page.waitForFunction((sel) => document.querySelector<HTMLElement>(sel)?.dataset.dispatchTimeLimit === "none", {}, PILL)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("a failed dispatch hands the limit back with its prompt", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch("?outcome=failure&limit=2h")
  try {
    assert.deepEqual(await pillState(page), { state: "set", text: "2h" })
    await send(page, "half written")
    await page.waitForFunction(() => (window as unknown as { deadlineFixture: Recorded }).deadlineFixture.dispatches.length === 1, { timeout: 5_000 })
    assert.ok((await recorded(page)).dispatches[0]!.deadline, "the failed dispatch did carry a limit")
    await page.waitForFunction(() => document.querySelector("textarea")?.value === "half written", { timeout: 5_000 })
    assert.deepEqual(await pillState(page), { state: "set", text: "2h" }, "the limit comes back with its words")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("a limit that no longer parses at the Enter stops the submit and says why", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch("?limit=8d")
  try {
    await send(page, "a week and a day")
    await toast(page, /Time limit: A time limit can be at most 7d\./)
    assert.equal((await recorded(page)).dispatches.length, 0, "nothing was started")
    assert.equal(await page.$eval("textarea", (el) => (el as HTMLTextAreaElement).value), "a week and a day", "the words stay")
    assert.deepEqual(await pillState(page), { state: "set", text: "8d" })
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("the drawer's chip extends from now once over, and removes", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    const chip = '[data-fixture-header="over"] [data-deadline-chip]'
    assert.equal(await page.$eval(chip, (el) => (el as HTMLElement).dataset.deadlineChip), "over")
    await page.click(chip)
    await page.waitForSelector("[data-time-limit-panel]")
    assert.match(await page.$eval("[data-time-limit-heading]", (el) => el.textContent ?? ""), /Set by the agent/)
    const before = Date.now()
    await page.click('[data-time-limit-preset="+30m"]')
    await page.waitForFunction(() => (window as unknown as { deadlineFixture: Recorded }).deadlineFixture.deadlines.length === 1)
    const extended = Date.parse((await recorded(page)).deadlines[0]!.deadline!)
    assert.ok(extended >= before + 30 * MIN - 1_000 && extended <= Date.now() + 30 * MIN + 1_000, "thirty minutes from NOW, not from the passed deadline")
    await page.waitForFunction((sel) => document.querySelector(sel)?.textContent === "30m left", {}, chip)
    assert.equal(await page.$eval(chip, (el) => (el as HTMLElement).dataset.deadlineChip), "plenty")

    const plenty = '[data-fixture-header="plenty"] [data-deadline-chip]'
    await page.click(plenty)
    await page.waitForSelector("[data-time-limit-clear]")
    await page.click("[data-time-limit-clear]")
    await page.waitForFunction((sel) => !document.querySelector(sel), {}, plenty)
    assert.deepEqual((await recorded(page)).deadlines[1], { slug: "plenty", deadline: null })
    assert.equal(await page.$('[data-sidebar-item="plenty"] [data-rail-deadline]'), null, "the rail drops it too")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("the ⋯ menu sets a limit on a thread with none, in the same grammar", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await page.click('[data-fixture-header="none"] [data-thread-menu]')
    await page.waitForSelector('[role="menuitem"][data-value="time-limit"]')
    await page.click('[role="menuitem"][data-value="time-limit"]')
    await page.waitForSelector("[data-time-limit-input]")
    await page.type("[data-time-limit-input]", "45m")
    await page.waitForFunction(() => document.querySelector("[data-time-limit-preview]")?.textContent?.startsWith("Ends "))
    const before = Date.now()
    await page.keyboard.press("Enter")
    await page.waitForFunction(() => (window as unknown as { deadlineFixture: Recorded }).deadlineFixture.deadlines.length === 1)
    const set = (await recorded(page)).deadlines[0]!
    assert.equal(set.slug, "none")
    assert.ok(Math.abs(Date.parse(set.deadline!) - (before + 45 * MIN)) < 2_000)
    await page.waitForFunction(() => document.querySelector('[data-fixture-header="none"] [data-deadline-chip]')?.textContent === "45m left")

    // Text that does not parse never reaches the server: the preview says why, and Enter does nothing.
    await page.click('[data-fixture-header="none"] [data-deadline-chip]')
    await page.waitForSelector("[data-time-limit-input]")
    await page.type("[data-time-limit-input]", "30")
    await page.waitForFunction(() => document.querySelector("[data-time-limit-preview]")?.getAttribute("data-time-limit-preview") === "error")
    await page.keyboard.press("Enter")
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal((await recorded(page)).deadlines.length, 1)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("an RPC that refuses the change is a toast", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page } = await launch("?deadlineFail=1")
  try {
    await page.click('[data-fixture-header="closing"] [data-deadline-chip]')
    await page.waitForSelector('[data-time-limit-preset="+15m"]')
    await page.click('[data-time-limit-preset="+15m"]')
    await toast(page, /Could not set the time limit/)
  } finally {
    await browser.close()
  }
})
