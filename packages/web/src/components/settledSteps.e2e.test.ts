import assert from "node:assert/strict"
import test from "node:test"

// Opt-in, like every other e2e here: start `vite` in packages/web and point this at its origin (or run
// `nub run test:e2e`, which does both).
//   cd packages/web && nubx vite --port 5234 --strictPort --host 127.0.0.1 &
//   FRIZZ_SETTLED_STEPS_E2E_URL=http://127.0.0.1:5234 nub --test src/components/settledSteps.e2e.test.ts
const baseUrl = process.env.FRIZZ_SETTLED_STEPS_E2E_URL

// A STEPS CARD OUTLIVES ITS REST (2026-10-08, maintainer: "We need to continue showing the to do
// instructions even after they are complete & the thread has moved on"). Every other settled ```awaiting
// fence draws nothing; one that handed the human `steps:` keeps its card, minus the Done verb nobody is
// waiting on any more. Pinned in the real drawer (settled-steps-fixture.html), whose transcript also holds
// an earlier settled shell wait — the negative control, which must stay invisible in every state.

const CARD = "[data-awaiting-background]"
const STEPS = [
  "Run npm login --auth-type=web in a terminal on this machine.",
  "Approve the browser prompt with the acme-bot account.",
]

test("a steps card stays in the transcript after its rest, with no Done", {
  skip: !baseUrl,
  timeout: 120_000,
}, async () => {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
  const errors: string[] = []
  try {
    const page = await browser.newPage()
    page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("404")) errors.push(m.text()) })
    page.on("pageerror", (e) => errors.push(String(e)))
    await page.setViewport({ width: 900, height: 1000 })

    const read = async (at: string) => {
      await page.goto(`${baseUrl}/settled-steps-fixture.html?at=${at}`, { waitUntil: "networkidle0" })
      await page.waitForSelector(`${CARD} [data-awaiting-steps] li`)
      return page.evaluate((sel) => {
        const cards = [...document.querySelectorAll(sel)] as HTMLElement[]
        return {
          cards: cards.map((el) => ({
            chip: (el.querySelector("[data-card-chip]") as HTMLElement | null)?.innerText.trim(),
            title: (el.querySelector("[data-card-title]") as HTMLElement | null)?.innerText.trim(),
            steps: [...el.querySelectorAll("[data-awaiting-steps] li")].map((li) => (li as HTMLElement).innerText.trim()),
            done: !!el.querySelector("[data-steps-done]"),
          })),
          // The earlier settled shell wait — card AND prose — must be gone.
          shellProse: document.body.innerText.includes("The release build is running in the background."),
          // …while the steps fence's own prose rides its card, once.
          stepsProse: document.body.innerText.split("The 4.2.0 tag is cut and verified.").length - 1,
          doneBubble: [...document.querySelectorAll("[data-transcript-source-id='u2']")].length,
        }
      }, CARD)
    }

    const stepsCard = { chip: "Awaiting human", title: "Sign in to npm so the acme 4.2.0 release can publish", steps: STEPS }

    // AT REST on the steps: the tail's resting card states them, WITH Done — and the transcript does not
    // draw them a second time above it.
    const rest = await read("rest")
    assert.deepEqual(rest.cards, [{ ...stepsCard, done: true }], "one card, the live one, with its verb")
    assert.equal(rest.shellProse, false, "a settled shell wait still draws nothing")
    assert.equal(rest.stepsProse, 1)

    // DONE PRESSED, worker mid-turn: the card stays where it was, without the verb.
    const running = await read("running")
    assert.deepEqual(running.cards, [{ ...stepsCard, done: false }], "the steps stay, and nobody is waiting on their Done")
    assert.equal(running.shellProse, false)
    assert.equal(running.stepsProse, 1)

    // THE THREAD MOVED ON to a later rest: still there, still no verb, beside the new resting card.
    const moved = await read("moved")
    assert.equal(moved.cards.length, 2, "the settled steps card and the new resting card")
    assert.deepEqual(moved.cards[0], { ...stepsCard, done: false })
    assert.equal(moved.cards[1].steps.length, 0, "the later rest is a plain wait")
    assert.equal(moved.shellProse, false)
    assert.equal(moved.stepsProse, 1)

    assert.deepEqual(errors, [], "no console or page errors")
  } finally {
    await browser.close()
  }
})
