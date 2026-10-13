import assert from "node:assert/strict"
import test from "node:test"

// Runtime coverage for "a ONE-question ask answers into the Answers card too". Skipped unless a Vite URL
// serving the fixtures is provided (same pattern as the other *.e2e.test.ts here): start `vite` in
// packages/web and set FRIZZ_SINGLE_ANSWER_CARD_E2E_URL to its origin.
//
// A single-block ask used to send its answer as BARE text, which carried no marker for
// parseAnswersMessage — so it rendered as a flat user bubble while every other answer shape got the
// structured card. The fixture drives the REAL path end to end (chip click → useLiveAnswering →
// composeAnswerWire → the echoed user turn → pairAllAnswers → Message), so the card is OBSERVED rather
// than inferred from the wire string alone.
const baseUrl = process.env.FRIZZ_SINGLE_ANSWER_CARD_E2E_URL

async function launch() {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  await page.setViewport({ width: 1000, height: 1400, deviceScaleFactor: 2 })
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  return { browser, page, errors }
}

// Click the control whose visible text contains `needle`, within `scope`. Contains, not startsWith: a
// recommended chip leads with its "Recommended" badge, which is part of the row's text content. An
// answer chip is a `[data-question-option]` ROW whose button is empty and stretched over the text
// (QuestionBlockCard's Chip), so the row is what carries the text and its button is what takes the click.
const clickByText = (scope: string, needle: string) => `(() => {
  const root = document.querySelector('${scope}') ?? document
  const hit = [...root.querySelectorAll('[data-question-option], button')].find((x) => (x.textContent ?? '').includes(${JSON.stringify(needle)}))
  if (!hit) throw new Error('no control containing ' + ${JSON.stringify(needle)})
  ;(hit.matches('button') ? hit : hit.querySelector('button')).click()
  return true
})()`

test("answering a one-question ask renders the Answers card, not a flat bubble", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await page.goto(`${baseUrl}/single-answer-card-fixture.html`, { waitUntil: "networkidle0" })
    await page.waitForSelector("[data-live-thread]")

    // Nothing answered yet: the live thread holds the ask and no answers card.
    assert.equal(await page.$$eval("[data-live-thread] [data-answers-card]", (n) => n.length), 0)

    await page.evaluate(clickByText("[data-live-thread]", "Yes, delete them"))
    await page.evaluate(clickByText("[data-live-thread]", "Send answers"))
    await page.waitForSelector("[data-live-thread] [data-answers-card]", { timeout: 10_000 })

    // The wire the send actually produced — the numbered form, for a single block.
    const wire = await page.$eval("[data-sent-wire]", (n) => n.textContent ?? "")
    assert.equal(wire, "Answers:\n1. A. Yes, delete them")

    // …and it rendered as the structured card, carrying its question and its answer.
    const card = await page.$eval("[data-live-thread] [data-answers-card]", (n) => (n.textContent ?? "").replace(/\s+/g, " ").trim())
    assert.match(card, /^Answers/)
    assert.match(card, /Delete the orphaned hardlinked binaries\?/)
    assert.match(card, /A\. Yes, delete them/)

    // The LEGACY pair: a bare answer matching an option cards up; a freeform reply keeps its bubble.
    const legacy = await page.$$eval("[data-legacy-thread] [data-answers-card]", (nodes) =>
      nodes.map((n) => ({ id: n.getAttribute("data-frizz-msg"), text: (n.textContent ?? "").replace(/\s+/g, " ").trim() })))
    assert.equal(legacy.length, 1, "only the option-matching bare answer is recovered")
    assert.equal(legacy[0].id, "legacy-answer")
    assert.match(legacy[0].text, /Delete the orphaned hardlinked binaries\?/)
    assert.match(legacy[0].text, /A\. Yes, delete them/)

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
