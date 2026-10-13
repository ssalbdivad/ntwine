import assert from "node:assert/strict"
import test from "node:test"

// Runtime coverage for "focusing the free-text box unselects the chosen option" on a REGISTERED
// question (maintainer 2026-08-28: "Focusing the free text option is supposed to unselect the other
// options"). The card's onFocus hands the producer its unchanged text and relies on THAT clearing the
// pick; this producer wrote only the draft and left the chip lit beside a focused box. Skipped unless a
// Vite URL serving the fixtures is provided (same pattern as the other *.e2e.test.ts here): start
// `vite` in packages/web and set NTWINE_REGISTERED_QUESTION_FOCUS_E2E_URL to its origin.
const baseUrl = process.env.NTWINE_REGISTERED_QUESTION_FOCUS_E2E_URL

type Page = import("puppeteer").Page

async function launch() {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  await page.setViewport({ width: 900, height: 1200, deviceScaleFactor: 2 })
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  return { browser, page, errors }
}

// A real mouse click at the centre of the i-th element `selector` matches. A chip's hit area is a
// stretched button whose mousedown is prevented, so only a pointer click exercises the focus dance the
// bug lives in — `el.click()` would skip it. And a pointer only reaches what is ON SCREEN: `?many=1`
// stacks three cards, so the lower card's rows and box can sit below the 1200px viewport, where a
// click at their centre lands on nothing — the multi checks failed that way once the cards above grew.
// The target scrolls into view before its centre is read.
async function mouseClick(page: Page, selector: string, i = 0) {
  const box = await page.$$eval(selector, (ns, i) => {
    const el = ns[i as number]!
    el.scrollIntoView({ block: "center" })
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, i)
  await page.mouse.click(box.x, box.y)
}

// Which option rows of the card wear the selection border, by index.
// `border-selection-border` since 457ad8eb (2026-09-19, the neutral palette); this read `border-accent`
// until 2026-09-28 and so failed on every surface — QuestionBlockCard paints the selected row.
const selectedRows = (page: Page, card: string) =>
  page.$$eval(`${card} [data-question-option]`, (ns) => ns.flatMap((n, i) => (n.classList.contains("border-selection-border") ? [i] : [])))
const boxFocused = (page: Page, card: string) =>
  page.$eval(`${card} textarea[data-surface='questionAnswer']`, (ta) => document.activeElement === ta)

test("focusing the free-text box unselects a registered question's chosen option; a multi keeps its set", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await page.goto(`${baseUrl}/registered-question-fixture.html?many=1`, { waitUntil: "networkidle0" })
    const single = "[data-question-id='qst_0001aaaa']"
    const multi = "[data-question-id='qst_0004dddd']"
    await page.waitForSelector(`${single} [data-question-option]`)
    await page.waitForSelector(`${multi} [data-question-option]`)

    // ── EVERY pixel of a row reads as clickable, because every pixel picks the option ──
    // Sampled by hit test rather than by reading the rule, because the hit test IS the failure: an
    // option's markdown body wears `opacity-90`, which paints it in the positioned layer above the
    // stretched button, so the row showed a pointer on its label line and a plain arrow over every line
    // below it (maintainer 2026-09-03). `?many=1`'s first card is the one with multi-line bodies and a
    // code fence, so the sweep crosses prose, a `pre` and the recommended badge, not just a label.
    const nonPointer = await page.$$eval(`${single} [data-question-option]`, (rows) => {
      const bad: string[] = []
      for (const row of rows) {
        const r = row.getBoundingClientRect()
        for (let y = r.top + 4; y < r.bottom - 2; y += 6) {
          for (const fx of [0.06, 0.3, 0.6, 0.95]) {
            const el = document.elementFromPoint(r.left + r.width * fx, y)
            if (el && getComputedStyle(el).cursor !== "pointer") bad.push(`${el.tagName.toLowerCase()}@${Math.round(y - r.top)}`)
          }
        }
      }
      return bad
    })
    assert.deepEqual(nonPointer, [], "every pixel of a live option row reads as clickable")

    // ── SINGLE: pick B, then click into the box — B must let go ──
    // A draft in the reply box first: a single-choice pick that completes its question SENDS it
    // (2026-09-29, one question at a time), and a card sent is greyed and done. A draft holds the send
    // for the reply's Enter, which leaves the pick staged and the card live to focus into.
    await page.focus("textarea[data-surface='queueComposer']")
    await page.keyboard.type("draft")
    await mouseClick(page, `${single} [data-question-option]`, 1)
    assert.deepEqual(await selectedRows(page, single), [1])
    await mouseClick(page, `${single} textarea[data-surface='questionAnswer']`)
    assert.equal(await boxFocused(page, single), true)
    assert.deepEqual(await selectedRows(page, single), [])
    // Climbing back out without typing does not resurrect the pick.
    await page.keyboard.press("Escape")
    assert.equal(await boxFocused(page, single), false)
    assert.deepEqual(await selectedRows(page, single), [])
    // A chip click still takes over from a typed answer — but it LEAVES the text. This assertion read
    // the other way until `4a6b5b49` (2026-09-02) deliberately reversed it: the typed draft stays in the
    // box as an unselected draft, and registeredAnswer submits the chip beside it. That commit did not
    // update this test, so it pinned the retired behaviour until 2026-09-03.
    await mouseClick(page, `${single} textarea[data-surface='questionAnswer']`)
    await page.keyboard.type("neither")
    assert.deepEqual(await selectedRows(page, single), [])
    await mouseClick(page, `${single} [data-question-option]`, 0)
    assert.deepEqual(await selectedRows(page, single), [0])
    assert.equal(await page.$eval(`${single} textarea[data-surface='questionAnswer']`, (ta) => (ta as HTMLTextAreaElement).value), "neither")

    // ── MULTI: the note box only adds colour, so the toggled set survives its focus ──
    await mouseClick(page, `${multi} [data-question-option]`, 0)
    await mouseClick(page, `${multi} [data-question-option]`, 2)
    assert.deepEqual(await selectedRows(page, multi), [0, 2])
    await mouseClick(page, `${multi} textarea[data-surface='questionAnswer']`)
    assert.equal(await boxFocused(page, multi), true)
    assert.deepEqual(await selectedRows(page, multi), [0, 2])

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// Enter inside one card sends THAT question and moves on to the next unanswered one (2026-09-29, one
// question at a time: "the agent should receive the answer to one question at a time so it can start
// working"). It never sends another question — the bug before per-question sending was one of seven
// answered, Enter pressed, all seven sent — and on an EMPTY card it sends nothing and just moves on.
test("Enter in one registered question sends that question alone and moves to the next unanswered one", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await page.goto(`${baseUrl}/registered-question-fixture.html?many=1`, { waitUntil: "networkidle0" })
    await page.waitForSelector("[data-answerable-question]")
    await page.evaluate(() => {
      const w = window as unknown as { sent: string[][] }
      w.sent = []
      window.addEventListener("fixture-rpc", (e) => {
        const { rpc, body } = (e as CustomEvent).detail
        if (rpc === "answerQuestions") w.sent.push(body.answers.map((a: { questionId: string }) => a.questionId))
      })
    })
    const sent = () => page.evaluate(() => (window as unknown as { sent: string[][] }).sent)
    const focusedQuestion = () => page.evaluate(() => (document.activeElement?.closest("[data-question-id]") as HTMLElement | null)?.dataset.questionId ?? null)
    const box = (id: string) => `[data-question-id='${id}'] textarea[data-surface='questionAnswer']`
    const pause = () => new Promise((r) => setTimeout(r, 150))

    // Answer the FIRST card by typing and press Enter: it goes, ALONE, and the caret lands on the second.
    await mouseClick(page, box("qst_0001aaaa"))
    await page.keyboard.type("first")
    await page.keyboard.press("Enter")
    await pause()
    assert.deepEqual(await sent(), [["qst_0001aaaa"]], "Enter sends its own question and no other")
    assert.equal(await focusedQuestion(), "qst_0002bbbb")

    // Enter on an EMPTY card sends nothing and moves on to the next unanswered one.
    await page.keyboard.press("Enter")
    await pause()
    assert.deepEqual(await sent(), [["qst_0001aaaa"]])
    assert.equal(await focusedQuestion(), "qst_0004dddd")

    // The last card in the stack: its Enter sends it and WRAPS to the one skipped above.
    await page.keyboard.type("only typecheck")
    await page.keyboard.press("Enter")
    await pause()
    assert.deepEqual(await sent(), [["qst_0001aaaa"], ["qst_0004dddd"]])
    assert.equal(await focusedQuestion(), "qst_0002bbbb")

    await page.keyboard.type("hold it for now")
    await page.keyboard.press("Enter")
    await pause()
    assert.deepEqual(await sent(), [["qst_0001aaaa"], ["qst_0004dddd"], ["qst_0002bbbb"]], "three Enters, three sends, one question each")
    assert.equal(await page.$$eval("[data-registered-questions] [data-settled-question]", (ns) => ns.length), 3, "every card greyed in its own slot")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
