import assert from "node:assert/strict"
import test from "node:test"

// Runtime coverage for ONE QUESTION AT A TIME on a REGISTERED ask (David 2026-09-29: "the agent
// should receive the answer to one question at a time so it can start working but the remaining
// questions … should stay there"). What RegisteredQuestionCards useRegisteredAnswering promises:
//   · a question is SENT the moment it is complete, ALONE — a single-choice pick that opens no follow-up,
//     the answer to the last of its follow-ups, an Enter in its own box, a multi confirmed with Enter;
//   · the rest stay open and answerable, and the one sent greys in its own slot (the queue card holds);
//   · a half-filled question carries its OWN Send answer, inside its card, and sends alone;
//   · the group's footer button says exactly what it does — "Skip the rest", "Send 1, skip 2" — and
//     appears once the human has started on the group;
//   · a typed reply is NOT a verdict on the open questions: it sends anything staged FIRST, then itself,
//     and every question it did not answer stays open (the worker decides what the reply made moot);
//   · a pick made while the reply box holds a draft waits for that reply's Enter.
// Skipped unless a Vite URL serving the fixtures is provided (same pattern as the other *.e2e.test.ts
// here): start `vite` in packages/web and set FRIZZ_REGISTERED_QUESTION_AUTOSEND_E2E_URL to its origin.
const baseUrl = process.env.FRIZZ_REGISTERED_QUESTION_AUTOSEND_E2E_URL

type Page = import("puppeteer").Page
type Answer = { questionId: string; question: string; chosen: string[]; text?: string; followUps?: unknown[] }

async function launch(query: string) {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  await page.setViewport({ width: 900, height: 1400, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.goto(`${baseUrl}/registered-question-fixture.html${query}`, { waitUntil: "networkidle0" })
  // Generous on the first paint only: the run's first page waits on vite's cold dependency pass, which
  // took over 30s on a loaded machine (2026-09-29) and failed whichever test happened to go first.
  await page.waitForSelector("[data-question-option]", { timeout: 90_000 })
  // Every answerQuestions payload, in order — the fixture echoes each write as a `fixture-rpc` event.
  await page.evaluate(() => {
    const w = window as unknown as { __answers: unknown[][] }
    w.__answers = []
    window.addEventListener("fixture-rpc", (e) => {
      const { rpc, body } = (e as CustomEvent).detail
      if (rpc === "answerQuestions") w.__answers.push(body.answers)
    })
  })
  // The SENDS, in the order they went out — the fixture's fetch stub logs every RPC, since a stubbed
  // fetch never reaches the network where puppeteer could see it; reads are dropped.
  const rpcs = async () =>
    (await page.evaluate(() => (window as unknown as { __rpcs?: string[] }).__rpcs ?? [])).filter((r) => r === "answerQuestions" || r === "followUp" || r === "dismissQuestions")
  const answers = () => page.evaluate(() => (window as unknown as { __answers: Answer[][] }).__answers)
  return { browser, page, errors, rpcs, answers }
}

// A real pointer click: a chip's mousedown is prevented, so `el.click()` would skip the path the card uses.
async function mouseClick(page: Page, selector: string, i = 0) {
  const box = await page.$$eval(selector, (ns, i) => {
    const r = ns[i as number]!.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }, i)
  await page.mouse.click(box.x, box.y)
}

const settle = (page: Page) => page.evaluate(() => new Promise((r) => setTimeout(r, 300)))
const reply = "textarea[data-surface='queueComposer']"
const SETTINGS = "[data-question-id='qst_0001aaaa']"
const TREE = "[data-question-id='qst_0002bbbb']"
const GATES = "[data-question-id='qst_0004dddd']"
// Which of the stack's questions are still answerable, and which are drawn greyed as sent.
const live = (page: Page) => page.$$eval("[data-registered-questions] [data-question-id]:not([data-settled-question])", (ns) => ns.map((n) => (n as HTMLElement).dataset.questionId))
const greyed = (page: Page) => page.$$eval("[data-registered-questions] [data-settled-question]", (ns) => ns.map((n) => (n as HTMLElement).dataset.questionId))
// The GROUP's footer button, and one question's own Send (inside its card).
const sendButton = (page: Page) => page.$eval("[data-send-answers]", (b) => b.textContent?.trim() ?? "").catch(() => null)
const ownSend = (page: Page, q: string) => page.$eval(`${q} [data-send-question]`, (b) => b.textContent?.trim() ?? "").catch(() => null)

test("a single-choice pick that completes its question sends it", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { browser, page, errors, rpcs } = await launch("")
  try {
    await mouseClick(page, `${SETTINGS} [data-question-option]`, 0)
    await settle(page)
    assert.deepEqual(await rpcs(), ["answerQuestions"], "the pick sent the answer")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("a pick sends ITS question alone; the others stay open and it greys in its slot", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { browser, page, errors, rpcs, answers } = await launch("?many=1")
  try {
    assert.equal(await sendButton(page), null, "nothing staged, so no Send button stands under the cards")
    await mouseClick(page, `${SETTINGS} [data-question-option]`, 0)
    await settle(page)
    assert.deepEqual(await rpcs(), ["answerQuestions"])
    assert.deepEqual((await answers()).map((call) => call.map((a) => [a.questionId, a.chosen])), [[["qst_0001aaaa", ["SQLite"]]]], "one question, not the batch")
    assert.deepEqual(await greyed(page), ["qst_0001aaaa"], "the answered question greys where it stood")
    assert.deepEqual(await live(page), ["qst_0002bbbb", "qst_0004dddd"], "the other two are still answerable, in order")
    assert.equal(await sendButton(page), "Skip the rest", "the group is started, so its footer offers to finish it")
    assert.match(await page.$eval(SETTINGS, (n) => n.textContent ?? ""), /^Answered/, "the greyed card says it was answered")
    assert.equal(await page.$eval("[data-registered-questions]", (s) => s.getAttribute("aria-label")), "2 questions waiting for an answer")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("a pick that opens follow-ups waits for them; the last one sends the whole branch", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { browser, page, errors, rpcs, answers } = await launch("?tree=1")
  try {
    // "Land it" opens two follow-ups: a single-choice and a free text.
    await mouseClick(page, `${TREE} [data-question-option]`, 0)
    await settle(page)
    assert.deepEqual(await rpcs(), [], "a pick that opened follow-ups is not the whole answer")
    const nodes = await page.$$eval(`${TREE} [data-answerable-question]`, (ns) => ns.length)
    assert.equal(nodes, 3, "the root and its two follow-ups")
    // Answering the first follow-up still leaves the second.
    const followUpOptions = await page.$$(`${TREE} [data-question-option]`)
    // The root's two options, then the first follow-up's two ("Tag 0.9.0", "Leave it unreleased").
    assert.equal(followUpOptions.length, 4)
    await mouseClick(page, `${TREE} [data-question-option]`, 2)
    await settle(page)
    assert.deepEqual(await rpcs(), [], "one follow-up is still unanswered")
    assert.equal(await ownSend(page, TREE), "Send answer", "the half-filled branch can be sent on purpose, from its own card")
    assert.equal(await sendButton(page), null, "a lone question needs no group button beside its own")
    // The notes follow-up: type, then Enter — the Enter that completes the question sends it.
    const boxes = `${TREE} textarea[data-surface='questionAnswer']`
    const last = (await page.$$(boxes)).length - 1
    await mouseClick(page, boxes, last)
    await page.keyboard.type("mention the parser rewrite")
    await page.keyboard.press("Enter")
    await settle(page)
    assert.deepEqual(await rpcs(), ["answerQuestions"])
    const [[sent]] = await answers()
    assert.equal(sent.questionId, "qst_0002bbbb")
    assert.deepEqual(sent.chosen, ["Land it"])
    assert.equal(JSON.stringify(sent.followUps).includes("Tag 0.9.0"), true, "the first follow-up rides with it")
    assert.equal(JSON.stringify(sent.followUps).includes("mention the parser rewrite"), true, "and the second")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("a multi stages its toggles until Enter confirms it, and sends it alone", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { browser, page, errors, rpcs, answers } = await launch("?many=1")
  try {
    await mouseClick(page, `${GATES} [data-question-option]`, 0)
    await mouseClick(page, `${GATES} [data-question-option]`, 2)
    await settle(page)
    assert.deepEqual(await rpcs(), [], "a toggle is one of several, never the whole answer")
    assert.equal(await ownSend(page, GATES), "Send answer", "the multi carries its own Send")
    assert.equal(await ownSend(page, SETTINGS), null, "a question holding nothing has none")
    assert.equal(await sendButton(page), "Send 1, skip 2", "the group button names the skip it would make")
    await mouseClick(page, `${GATES} textarea[data-surface='questionAnswer']`)
    await page.keyboard.press("Enter")
    await settle(page)
    assert.deepEqual(await rpcs(), ["answerQuestions"])
    assert.deepEqual((await answers()).map((call) => call.map((a) => [a.questionId, a.chosen])), [[["qst_0004dddd", ["Typecheck", "The browser e2e pass"]]]])
    assert.deepEqual(await live(page), ["qst_0001aaaa", "qst_0002bbbb"])
    // Enter moved on to the next unanswered question: after this one there is none, so it wrapped.
    assert.equal(await page.evaluate(() => (document.activeElement?.closest("[data-question-id]") as HTMLElement | null)?.dataset.questionId), "qst_0001aaaa")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// A dev-server restart reloads the page, and the toggles used to live in React state alone: every restart
// cleared a half-answered card (David 2026-10-08). They ride the draft store now, as typed text does.
test("staged toggles survive a reload, and still send", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { browser, page, errors, rpcs } = await launch("?many=1")
  try {
    await mouseClick(page, `${GATES} [data-question-option]`, 0)
    await mouseClick(page, `${GATES} [data-question-option]`, 2)
    await settle(page)
    await page.reload({ waitUntil: "networkidle0" })
    await page.waitForSelector(`${GATES} [data-question-option]`)
    const pressed = await page.$$eval(`${GATES} [data-question-option]`, (ns) => ns.map((n) => n.querySelector("button[aria-pressed]")?.getAttribute("aria-pressed")))
    assert.deepEqual(pressed.map((p, i) => [i, p]).filter(([, p]) => p === "true").map(([i]) => i), [0, 2], "both toggles are still on")
    assert.equal(await ownSend(page, GATES), "Send answer", "and the multi still offers its Send")
    await mouseClick(page, `${GATES} textarea[data-surface='questionAnswer']`)
    await page.keyboard.press("Enter")
    await settle(page)
    assert.deepEqual(await rpcs(), ["answerQuestions"], "the restored toggles send")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("a typed reply sends what is staged first, then itself — and every question it did not answer stays open", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { browser, page, errors, rpcs, answers } = await launch("?many=1")
  try {
    // Nothing staged: the reply goes alone, and it settles nothing — no answer, no dismissal.
    await page.focus(reply)
    await page.keyboard.type("which thread should this land on?")
    await page.keyboard.press("Enter")
    await settle(page)
    assert.deepEqual(await rpcs(), ["followUp"], "a reply is not an answer and not a dismissal")
    assert.deepEqual(await live(page), ["qst_0001aaaa", "qst_0002bbbb", "qst_0004dddd"], "a side question leaves every card open")

    // Staged, half-filled: a multi's toggle and a typed-but-not-Entered answer ride ahead of the reply.
    await mouseClick(page, `${GATES} [data-question-option]`, 1)
    await mouseClick(page, `${SETTINGS} textarea[data-surface='questionAnswer']`)
    await page.keyboard.type("Postgres, actually")
    assert.equal(await sendButton(page), "Send 2, skip 1")
    assert.equal(await page.$eval(reply, (ta) => (ta as HTMLTextAreaElement).placeholder), "Add a note to your answers…")
    await page.focus(reply)
    await page.keyboard.type("and skip the e2e pass for now")
    await page.keyboard.press("Enter")
    await settle(page)
    assert.deepEqual(await rpcs(), ["followUp", "answerQuestions", "followUp"], "the staged answers first, then the reply")
    const staged = (await answers())[0]
    assert.deepEqual(staged.map((a) => a.questionId).sort(), ["qst_0001aaaa", "qst_0004dddd"])
    assert.deepEqual(await live(page), ["qst_0002bbbb"], "the one question the reply did not answer is still open")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("a pick made while the reply box holds a draft waits for the reply's Enter", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { browser, page, rpcs } = await launch("")
  try {
    await page.focus(reply)
    await page.keyboard.type("one more thing")
    await mouseClick(page, `${SETTINGS} [data-question-option]`, 1)
    await settle(page)
    assert.equal((await rpcs()).includes("answerQuestions"), false, "a draft in the reply box holds the auto-send")
    await page.focus(reply)
    await page.keyboard.press("Enter")
    await settle(page)
    assert.deepEqual(await rpcs(), ["answerQuestions", "followUp"], "the answer first, then the reply")
  } finally {
    await browser.close()
  }
})

test("the question's own Send sends it alone; Skip the rest then settles the group", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { browser, page, errors, rpcs, answers } = await launch("?many=1")
  try {
    await mouseClick(page, `${GATES} [data-question-option]`, 1)
    await settle(page)
    await mouseClick(page, `${GATES} [data-send-question]`)
    await settle(page)
    assert.deepEqual((await answers()).map((call) => call.map((a) => [a.questionId, a.chosen])), [[["qst_0004dddd", ["Unit tests"]]]], "its own Send skips nothing")
    assert.deepEqual(await live(page), ["qst_0001aaaa", "qst_0002bbbb"])
    assert.equal(await sendButton(page), "Skip the rest")
    await mouseClick(page, "[data-send-answers]")
    await settle(page)
    assert.deepEqual(await rpcs(), ["answerQuestions", "answerQuestions"])
    const skipped = (await answers())[1] as (Answer & { skipped?: boolean })[]
    assert.deepEqual(skipped.map((a) => [a.questionId, a.skipped]).sort(), [["qst_0001aaaa", true], ["qst_0002bbbb", true]])
    assert.deepEqual(await live(page), [], "nothing left open")
    assert.equal(await sendButton(page), null)
    assert.match(await page.$eval(SETTINGS, (n) => n.textContent ?? ""), /^Skipped/, "a skipped card says so")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// CHANGE (David 2026-10-08: "unsubmit an answer to a question as you move through them if you change
// your mind"). The greyed card offers Change; it reopens the question on the answer it replaces, a new
// pick sends the replacement (the server takes an answered row as a change), and Cancel keeps the old
// one without sending anything.
test("Change reopens an answered question on its answer; a new pick sends the replacement", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { browser, page, errors, rpcs, answers } = await launch("?many=1")
  try {
    await mouseClick(page, `${SETTINGS} [data-question-option]`, 0)
    await settle(page)
    assert.deepEqual(await greyed(page), ["qst_0001aaaa"])
    await mouseClick(page, `${SETTINGS} [data-change-answer]`)
    await settle(page)
    assert.deepEqual(await greyed(page), [], "Change reopened it")
    assert.deepEqual(await live(page), ["qst_0001aaaa", "qst_0002bbbb", "qst_0004dddd"], "in its own slot")
    assert.equal(await page.$$eval(`${SETTINGS} [data-question-option] button[aria-pressed='true']`, (ns) => ns.length), 1, "opened on the earlier pick")
    assert.deepEqual(await rpcs(), ["answerQuestions"], "reopening sends nothing")
    assert.equal(await ownSend(page, SETTINGS), null, "opened on its old answer, there is nothing new to send")
    assert.equal(await sendButton(page), "Skip the rest", "the group button leaves a reopened answer alone")
    await mouseClick(page, `${SETTINGS} [data-question-option]`, 1)
    await settle(page)
    assert.deepEqual(await rpcs(), ["answerQuestions", "answerQuestions"])
    assert.deepEqual((await answers())[1].map((a) => [a.questionId, a.chosen]), [["qst_0001aaaa", ["A JSON file"]]])
    assert.deepEqual(await greyed(page), ["qst_0001aaaa"], "greyed again, with the new answer")
    assert.match(await page.$eval(SETTINGS, (n) => n.textContent ?? ""), /JSON file/)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("Cancel on a reopened answer keeps the earlier one and sends nothing", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { browser, page, errors, rpcs } = await launch("?many=1")
  try {
    await mouseClick(page, `${SETTINGS} [data-question-option]`, 0)
    await settle(page)
    await mouseClick(page, `${SETTINGS} [data-change-answer]`)
    await settle(page)
    await mouseClick(page, `${SETTINGS} [data-keep-answer]`)
    await settle(page)
    assert.deepEqual(await greyed(page), ["qst_0001aaaa"])
    assert.match(await page.$eval(SETTINGS, (n) => n.textContent ?? ""), /SQLite/)
    assert.deepEqual(await rpcs(), ["answerQuestions"])
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
