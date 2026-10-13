import assert from "node:assert/strict"
import test from "node:test"

// Runtime coverage for a REGISTERED `multi` over a LONG option list. The `ask` tool's option count
// carried `.max(8)` until 2026-09-03 (maintainer: "allow arbitrary numbers of options"), so nothing past
// eight had ever reached the card. Options were lettered until 2026-10-07, which ran past `Z.` into `AA.`;
// they are numbered now, and only 1–9 are keys, so rows 10 and on carry a plain `10.` rather than a
// keycap. The fixture's `?wide=1` is thirty options; this drives the real card end
// to end — every chip toggled, the question's own Send answer, the payload the worker would receive — so the answer that
// picks the whole list is OBSERVED rather than inferred from the schema alone. Skipped unless a Vite
// URL serving the fixtures is provided (same pattern as the other *.e2e.test.ts here): start `vite` in
// packages/web and set NTWINE_REGISTERED_QUESTION_WIDE_E2E_URL to its origin.
const baseUrl = process.env.NTWINE_REGISTERED_QUESTION_WIDE_E2E_URL

async function launch() {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  await page.setViewport({ width: 900, height: 2400, deviceScaleFactor: 2 })
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  return { browser, page, errors }
}

const CARD = "[data-question-id='qst_0006ffff']"
const OPTION = `${CARD} [data-question-option]`

test("a registered multi over thirty options numbers every row past the 1–9 keys, toggles every chip, and sends all thirty", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await page.goto(`${baseUrl}/registered-question-fixture.html?wide=1`, { waitUntil: "networkidle0" })
    await page.waitForSelector(OPTION)

    // All thirty rows render, in order: keycaps `1`…`9`, then plain `10.`…`30.` (no key names them).
    const rows = await page.$$eval(OPTION, (ns) => ns.map((n) => (n.textContent ?? "").replace(/\s+/g, " ").trim()))
    assert.equal(rows.length, 30)
    assert.match(rows[0], /^1 ?Finding 1\b/)
    assert.match(rows[25], /^26\. ?Finding 26\b/)
    assert.match(rows[26], /^27\. ?Finding 27\b/)
    assert.match(rows[29], /^30\. ?Finding 30\b/)

    // The card's writes are echoed onto the window by the fixture; collect them before anything is sent.
    await page.evaluate(() => {
      ;(window as unknown as { __rpc: unknown[] }).__rpc = []
      window.addEventListener("fixture-rpc", (e) => {
        ;(window as unknown as { __rpc: unknown[] }).__rpc.push((e as CustomEvent).detail)
      })
    })

    // Toggle every chip. A chip is a row whose stretched, empty button takes the click.
    // The selected row wears `border-selection-border` since 457ad8eb (2026-09-19); this read `border-accent`,
    // which no row has worn since, until 2026-09-28.
    await page.$$eval(OPTION, (ns) => { for (const n of ns) (n.querySelector("button") as HTMLButtonElement).click() })
    const selected = await page.$$eval(OPTION, (ns) => ns.flatMap((n, i) => (n.classList.contains("border-selection-border") ? [i] : [])))
    assert.deepEqual(selected, Array.from({ length: 30 }, (_, i) => i), "every one of the thirty rows wears the selection border")

    await page.click("[data-send-question]")
    await page.waitForFunction(() => (window as unknown as { __rpc: unknown[] }).__rpc.length === 1, { timeout: 10_000 })
    const calls = await page.evaluate(() => (window as unknown as {
      __rpc: Array<{ rpc: string; body: { answers?: Array<{ questionId: string; question: string; chosen: string[] }> } }>
    }).__rpc)
    // The fixture's card is the cross-project queue card, which mounts no prompt box Send of the thread's
    // own (lib/sendScope), so the question's own Send answer sends it.
    assert.equal(calls[0].rpc, "answerQuestions")
    const answer = calls[0].body.answers?.[0]
    assert.equal(answer?.questionId, "qst_0006ffff")
    // The payload carries the worker's OWN labels — thirty of them, in option order — not the numbered
    // chip text. `chosen` carried the same `.max(8)` the options did and had to go with it.
    assert.deepEqual(answer?.chosen, Array.from({ length: 30 }, (_, i) => `Finding ${i + 1}`))

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
