import assert from "node:assert/strict"
import test from "node:test"

// Runtime coverage for the prompt box's PICK over the new-thread default (useDispatchProfile): a pick
// is for the next thread, the dispatch that sends it puts the box back on the default, and only
// "Make default" writes the durable record. The pieces that make that true are all runtime ones — the
// pick lives in sessionStorage beside the draft, the reset rides the dispatch mutation's lifecycle,
// and the default is an optimistic TanStack write — so a source test could pin none of them.
//
// Drives dispatch-composer-profile-fixture (default GPT-5.6 Sol › medium), which records every
// preference write and every dispatch body. Skipped unless NTWINE_DISPATCH_PICK_E2E_URL names a vite
// serving the fixtures (scripts/e2e-web.mjs sets it).
const baseUrl = process.env.NTWINE_DISPATCH_PICK_E2E_URL

type Page = import("puppeteer").Page
type Recorded = { writes: Record<string, unknown>[]; dispatches: { backend?: string; model?: string; effort?: string; prompt?: string }[] }
const PILL = 'button[aria-label="Model and effort"]'
const MENU = ".profile-grid-menu"
const MAKE_DEFAULT = "[data-make-default]"
const PICK_KEY = "dispatch-profile:"

async function launch(query = "") {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 1 })
  const errors: string[] = []
  // The fixture answers only the RPCs the box needs; the rest (authStatus, claudeModels) 404 by design
  // and the box fails open on them.
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon|Failed to load resource/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.goto(`${baseUrl}/dispatch-composer-profile-fixture.html${query}`, { waitUntil: "networkidle0" })
  await page.waitForSelector(`${PILL}[data-profile-known="true"]`)
  return { browser, page, errors }
}

const recorded = (page: Page): Promise<Recorded> =>
  page.evaluate(() => {
    const fixture = (window as unknown as { dispatchComposerProfileFixture: Recorded }).dispatchComposerProfileFixture
    return { writes: fixture.writes.map((w) => ({ ...w })), dispatches: fixture.dispatches.map((d) => ({ ...d })) }
  })

const pill = (page: Page) => page.$eval(PILL, (el) => el.textContent?.replace(/\s+/g, " ").trim())
const storedPick = (page: Page) =>
  page.evaluate((prefix) => {
    const entries = JSON.parse(sessionStorage.getItem("ntwine-drafts:v1") ?? "{}").entries ?? {}
    return Object.entries(entries).find(([key]) => key.startsWith(prefix))?.[1] ?? null
  }, PICK_KEY)

async function pickEffort(page: Page, effort: string) {
  await page.click(PILL)
  await page.waitForSelector(MENU)
  await page.click(`${MENU} [aria-label="GPT-5.6 Sol, ${effort} effort"]`)
  await page.waitForFunction((menu) => !document.querySelector(menu), {}, MENU)
}

async function send(page: Page, text: string) {
  await page.click("textarea")
  await page.keyboard.type(text)
  await page.keyboard.press("Enter")
}

// The fixture mounts no toast, so a started thread shows as the box's own "Starting thread…" card
// going away once the (900ms) fixture dispatch acknowledges.
const settled = (page: Page) => page.waitForFunction(() => !document.querySelector("[data-pending-dispatch]"), { timeout: 5_000 })

async function dispatchCount(page: Page, count: number) {
  await page.waitForFunction(
    (n) => (window as unknown as { dispatchComposerProfileFixture: Recorded }).dispatchComposerProfileFixture.dispatches.length >= n,
    { timeout: 5_000 },
    count,
  )
}

test("a pick is for the next thread: sending it puts the box back on the default, and nothing is saved", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    assert.equal(await pill(page), "GPT-5.6 Sol › medium")
    assert.equal(await page.$(MAKE_DEFAULT), null, "no pick, no Make default")

    // Choosing the default's own cell again drops the pick instead of storing a copy of the default.
    await pickEffort(page, "High")
    assert.ok(await storedPick(page), "the pick is kept beside the draft")
    await pickEffort(page, "Medium")
    assert.equal(await storedPick(page), null, "landing back on the default drops the pick")
    assert.equal(await page.$(MAKE_DEFAULT), null)

    await pickEffort(page, "High")
    assert.equal(await pill(page), "GPT-5.6 Sol › high")
    assert.ok(await page.$(MAKE_DEFAULT), "a pick that differs from the default offers Make default")

    await send(page, "the hard one")
    await dispatchCount(page, 1)
    assert.equal((await recorded(page)).dispatches[0]!.effort, "high", "the thread starts on the pick")
    // Back on the default the moment the prompt clears — the pill is always the NEXT thread's profile.
    await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.includes("medium"), {}, PILL)
    assert.equal(await page.$(MAKE_DEFAULT), null)
    assert.equal(await storedPick(page), null)

    await settled(page)
    await send(page, "the easy one")
    await dispatchCount(page, 2)
    assert.equal((await recorded(page)).dispatches[1]!.effort, "medium", "the next thread starts on the default again")
    assert.deepEqual((await recorded(page)).writes, [], "no pick ever wrote the default")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("Make default writes the pick once, and the box stays on it after sending", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await pickEffort(page, "Low")
    await page.click(MAKE_DEFAULT)
    await page.waitForFunction((sel) => !document.querySelector(sel), {}, MAKE_DEFAULT)
    assert.deepEqual((await recorded(page)).writes, [{ field: "profile", backend: "codex", model: "gpt-5.6-sol", effort: "low" }])
    assert.equal(await pill(page), "GPT-5.6 Sol › low")
    await page.waitForFunction((prefix) => !Object.keys(JSON.parse(sessionStorage.getItem("ntwine-drafts:v1") ?? "{}").entries ?? {}).some((key) => key.startsWith(prefix)), {}, PICK_KEY)

    await send(page, "on the new default")
    await dispatchCount(page, 1)
    assert.equal((await recorded(page)).dispatches[0]!.effort, "low")
    await settled(page)
    assert.equal(await pill(page), "GPT-5.6 Sol › low", "the default is where the box returns to")
    assert.equal((await recorded(page)).writes.length, 1, "exactly one write")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("the pick belongs to the draft: it survives a reload, and a failed dispatch hands it back", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch("?outcome=failure")
  try {
    await pickEffort(page, "High")
    await page.click("textarea")
    await page.keyboard.type("half written")
    await page.reload({ waitUntil: "networkidle0" })
    await page.waitForSelector(`${PILL}[data-profile-known="true"]`)
    assert.equal(await pill(page), "GPT-5.6 Sol › high", "a same-tab reload keeps the pick with its draft")
    assert.equal(await page.$eval("textarea", (el) => (el as HTMLTextAreaElement).value), "half written")
    assert.ok(await page.$(MAKE_DEFAULT))

    await page.click("textarea")
    await page.keyboard.press("Enter")
    await dispatchCount(page, 1)
    assert.equal((await recorded(page)).dispatches[0]!.effort, "high")
    // Cleared with the prompt at submit, then — the fixture rejects after 900ms — handed back with it,
    // so a retry is the same thread.
    await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.includes("medium"), {}, PILL)
    await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.includes("high"), { timeout: 5_000 }, PILL)
    await page.waitForFunction(() => document.querySelector("textarea")?.value === "half written")
    assert.ok(await page.$(MAKE_DEFAULT))
    assert.deepEqual((await recorded(page)).writes, [])
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
