import assert from "node:assert/strict"
import test from "node:test"

// Runtime coverage for the NUMBER KEYS (lib/questionKeys.ts): a bare 1–9 answers the question in front
// of the operator. The router is a window listener whose every decision is layout — which grid holds
// focus, which card is on screen, whether a row sits under a sticky header or behind a scrim — so it is
// tested where layout exists, against the registered-question fixture's `?keys=1`: two queue cards (the
// settings store + the land-it tree, then the commit gates) with the real Settings drawer and ⌘K palette
// mounted off the store. Skipped unless a Vite URL serving the fixtures is provided (same pattern as the
// other *.e2e.test.ts here): start `vite` in packages/web and set FRIZZ_QUESTION_KEYS_E2E_URL to its
// origin, or run `nub run test:e2e`, which sets it.
const baseUrl = process.env.FRIZZ_QUESTION_KEYS_E2E_URL

type Page = import("puppeteer").Page

const SETTINGS = "[data-question-id='qst_0001aaaa']"
const TREE = "[data-question-id='qst_0002bbbb']"
const GATES = "[data-question-id='qst_0004dddd']"
const CARD_A = "[data-queue-card-root='registered-question-demo']"
const CARD_B = "[data-queue-card-root='registered-question-gates']"

async function launch() {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--use-mock-keychain", "--force-color-profile=srgb"] })
  const page = await browser.newPage()
  // These are independent keyboard cases, not navigation persistence cases. A fresh document now
  // restores staged picks, so explicitly clear their tab cache before each fixture load.
  await page.evaluateOnNewDocument(() => sessionStorage.removeItem("frizz-drafts:v1"))
  await page.setViewport({ width: 900, height: 800 })
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  return { browser, page, errors }
}

// A fresh board: nothing staged, nothing focused, scrolled to the top.
async function fresh(page: Page, height = 800) {
  await page.setViewport({ width: 900, height })
  await page.goto(`${baseUrl}/registered-question-fixture.html?keys=1&font=sans`, { waitUntil: "networkidle0" })
  await page.waitForSelector(`${GATES} [data-question-grid]`)
}

// Which option rows of each question wear the selection border, by index — the whole board's staged
// state in one read, so every assertion also proves nothing ELSE was picked.
const picks = (page: Page) =>
  page.evaluate((ids: string[]) => Object.fromEntries(ids.map((sel) => [
    sel.match(/qst_\w+/)![0],
    [...document.querySelectorAll(`${sel} [data-question-option]`)].flatMap((n, i) => (n.classList.contains("border-selection-border") ? [i] : [])),
  ])), [SETTINGS, TREE, GATES])

const NONE = { qst_0001aaaa: [], qst_0002bbbb: [], qst_0004dddd: [] }

// Put a page Y at the top of the viewport (instant, whatever the stylesheet's scroll-behavior says).
const scrollToY = (page: Page, y: number) => page.evaluate((y) => window.scrollTo({ top: y, behavior: "instant" }), y)
// The document Y of an element's top edge.
const docTop = (page: Page, sel: string) => page.$eval(sel, (el) => el.getBoundingClientRect().top + window.scrollY)
const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
const focusGrid = (page: Page, q: string) => page.$eval(`${q} [data-question-grid]`, (g) => {
  g.scrollIntoView({ block: "center", behavior: "instant" })
  ;(g as HTMLElement).focus()
})
const activeQuestion = (page: Page) => page.evaluate(() => document.activeElement?.closest("[data-question-id]")?.getAttribute("data-question-id") ?? null)
const settle = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

test("a focused options grid takes the digit, a pick moves on, a held key answers once, and a text box keeps its digits", { skip: !baseUrl, timeout: 90_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await fresh(page)
    // Focused grid: `2` picks option 2 there, and focus moves to the next unanswered question.
    await focusGrid(page, SETTINGS)
    await page.keyboard.press("2")
    await settle(page)
    assert.deepEqual(await picks(page), { ...NONE, qst_0001aaaa: [1] })
    assert.equal(await activeQuestion(page), "qst_0002bbbb", "a single-select pick hands the keyboard to the next unanswered question")
    await page.keyboard.press("2")
    await settle(page)
    assert.deepEqual(await picks(page), { ...NONE, qst_0001aaaa: [1], qst_0002bbbb: [1] })

    // A HELD key is one answer: the auto-repeats must not walk the pick down the rest.
    await fresh(page)
    await focusGrid(page, SETTINGS)
    await page.keyboard.down("1")
    await page.keyboard.down("1") // puppeteer sends this one as an auto-repeat
    await page.keyboard.up("1")
    await settle(page)
    assert.deepEqual(await picks(page), { ...NONE, qst_0001aaaa: [0] })

    // The key one past the last option takes the caret to the free-text row; digits typed THERE are text.
    await fresh(page)
    await focusGrid(page, SETTINGS)
    await page.keyboard.press("3")
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-surface")), "questionAnswer")
    await page.keyboard.type("12")
    assert.equal(await page.$eval(`${SETTINGS} textarea[data-surface='questionAnswer']`, (t) => (t as HTMLTextAreaElement).value), "12")
    assert.deepEqual(await picks(page), NONE)

    // A composer keeps its digits too; Escape then hands the keyboard to its card's question.
    const composer = `${CARD_B} textarea[data-surface='queueComposer']`
    await page.$eval(composer, (t) => t.scrollIntoView({ block: "center", behavior: "instant" }))
    await page.focus(composer)
    await page.keyboard.type("7")
    assert.equal(await page.$eval(composer, (t) => (t as HTMLTextAreaElement).value), "7")
    assert.deepEqual(await picks(page), NONE)
    await page.keyboard.press("Escape")
    await page.keyboard.press("3")
    await settle(page)
    assert.deepEqual(await picks(page), { ...NONE, qst_0004dddd: [2] })
    assert.equal(await page.$eval(composer, (t) => (t as HTMLTextAreaElement).value), "7")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("with nothing focused a digit answers only a question on screen, preferring the card being read", { skip: !baseUrl, timeout: 90_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    // ── The card being read wins over a card whose question still shows an edge above it ──
    // Card A's tree question sits at the very top, its settings question scrolled away above; card B
    // holds most of the screen and the rail marks it. Until 2026-10-08 this `2` was staged on card A's
    // settings question, which nobody could see.
    await fresh(page, 1000)
    const treeTop = await docTop(page, `${TREE} [data-question-grid]`)
    await scrollToY(page, treeTop + 20)
    await blur(page)
    assert.equal(await page.$eval(`${SETTINGS} [data-question-grid]`, (g) => g.getBoundingClientRect().bottom < 0), true, "card A's first question is off-screen above")
    // The docked composer covers the second option in an 800px window. This case needs that row
    // genuinely visible, not just its layout box inside the viewport: the hit-test gate is the contract.
    assert.equal(await page.$$eval(`${GATES} [data-question-option]`, (rows) => {
      const row = rows[1], r = row.getBoundingClientRect()
      return row.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
    }), true, "card B's second option is uncovered")
    await page.keyboard.press("2")
    await settle(page)
    assert.deepEqual(await picks(page), { ...NONE, qst_0004dddd: [1] })

    // ── No question on screen: the digit does nothing ──
    // A short window over card A's header and transcript; its first question begins below the fold.
    await fresh(page, 300)
    await blur(page)
    assert.equal(await page.$eval(`${SETTINGS} [data-question-grid]`, (g) => g.getBoundingClientRect().top > window.innerHeight), true, "the first question is below the fold")
    await page.keyboard.press("1")
    await settle(page)
    assert.deepEqual(await picks(page), NONE, "a digit with no question on screen must stage nothing")
    // Negative control: the same key with that question brought on screen does pick.
    await page.$eval(`${SETTINGS} [data-question-option]`, (row) => row.scrollIntoView({ block: "center", behavior: "instant" }))
    await blur(page)
    await page.keyboard.press("1")
    await settle(page)
    assert.deepEqual(await picks(page), { ...NONE, qst_0001aaaa: [0] })

    // ── A FOCUSED grid scrolled out of view does not take the key either ──
    await fresh(page)
    await focusGrid(page, SETTINGS)
    await scrollToY(page, await docTop(page, CARD_B))
    assert.equal(await activeQuestion(page), "qst_0001aaaa", "focus is still on the settings question")
    await page.keyboard.press("1")
    await settle(page)
    assert.deepEqual(await picks(page), NONE, "a focused question scrolled away must not be answered blind")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("Settings and the command palette swallow digits; closed, the same digit answers", { skip: !baseUrl, timeout: 90_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await fresh(page)
    await blur(page)

    // ── Settings open: a digit from the body, or from a control inside the drawer, picks nothing ──
    await page.evaluate(() => { (window as unknown as { fixtureStore: { showSettings: boolean } }).fixtureStore.showSettings = true })
    await page.waitForSelector('[role="dialog"][aria-modal="true"][aria-label="Settings"]')
    await blur(page)
    await page.keyboard.press("1")
    await page.focus('[role="dialog"][aria-label="Settings"] button')
    await page.keyboard.press("2")
    await settle(page)
    assert.deepEqual(await picks(page), NONE, "nothing behind the Settings drawer is answered")
    await page.evaluate(() => { (window as unknown as { fixtureStore: { showSettings: boolean } }).fixtureStore.showSettings = false })
    await page.waitForFunction(() => !document.querySelector('[aria-label="Settings"]'))

    // ── The palette: its input keeps typed digits; blurred, a digit still answers nothing behind it ──
    await page.evaluate(() => { (window as unknown as { fixtureStore: { showPalette: boolean } }).fixtureStore.showPalette = true })
    await page.waitForSelector('[role="dialog"][aria-modal="true"][aria-label="Command palette"] input')
    await page.waitForFunction(() => document.activeElement?.tagName === "INPUT")
    await page.keyboard.type("1")
    assert.equal(await page.$eval('[aria-label="Command palette"] input', (i) => (i as HTMLInputElement).value), "1")
    await blur(page)
    await page.keyboard.press("2")
    await settle(page)
    assert.deepEqual(await picks(page), NONE, "nothing behind the palette is answered")
    await page.evaluate(() => { (window as unknown as { fixtureStore: { showPalette: boolean } }).fixtureStore.showPalette = false })
    await page.waitForFunction(() => !document.querySelector('[aria-label="Command palette"]'))

    // Negative control: with both closed, the same key from the body answers the question on screen.
    await blur(page)
    await page.keyboard.press("2")
    await settle(page)
    assert.deepEqual(await picks(page), { ...NONE, qst_0001aaaa: [1] })
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
