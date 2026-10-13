import assert from "node:assert/strict"
import test from "node:test"

// Opt-in, like every other e2e here: start `vite` in packages/web and point this at its origin (or run
// `nub run test:e2e`, which does both).
//   cd packages/web && nubx vite --port 5233 --strictPort --host 127.0.0.1 &
//   FRIZZ_AWAITING_STEPS_E2E_URL=http://127.0.0.1:5233 nub --test src/components/AwaitingSteps.e2e.test.ts
const baseUrl = process.env.FRIZZ_AWAITING_STEPS_E2E_URL

// STEPS FOR THE HUMAN (2026-10-03): an ```awaiting fence carrying `steps:` draws them on the resting card
// over ONE verb. The steps render through the markdown sanitizer, which needs a real DOM, so this is
// pinned in a real browser against the real queue card (awaiting-bg-fixture.html?steps=…). Only the RPC
// answers are stubbed, in the fixture; the send itself goes through the composer's own eager follow-up,
// which is the point:
//
//   1. The card states the steps in order, as markdown, under a "Awaiting human" chip and the worker's heading
//      (the chip alone when the worker named none), ruled off from the body — in the paragraph's own
//      colour, every item on the same line height whether or not it carries a command — with Done as its
//      only verb: no Snooze, no second verb, no text box of its own (anything else the human has to
//      say goes through the prompt box like any steer).
//   2. Each step is a checkbox on a stepper (2026-10-12): a tick marks it done and moves the accent to
//      the next step, survives a reload, and a second click unticks it. Nothing is sent.
//   3. Done sends ONE ordinary reply, the word itself, bound to the thread's session, and the card
//      leaves the queue.

const CARD = "[data-awaiting-background]"

type Sent = { rpc: string; body: { slug?: string; sessionId?: string; message?: string } }

test("a steps card states the steps over one Done, and Done sends one ordinary reply", {
  skip: !baseUrl,
  timeout: 120_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const errors: string[] = []
  try {
    const page = await browser.newPage()
    page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("404")) errors.push(m.text()) })
    page.on("pageerror", (e) => errors.push(String(e)))
    await page.setViewport({ width: 900, height: 900 })

    // ---- an untitled card is headed by its chip alone ----
    await page.goto(`${baseUrl}/awaiting-bg-fixture.html?steps=1`, { waitUntil: "networkidle0" })
    await page.waitForSelector(`${CARD} [data-awaiting-steps] li`)
    const untitled = await page.$eval(CARD, (el) => ({
      chip: (el.querySelector("[data-card-chip]") as HTMLElement | null)?.innerText.trim(),
      title: !!el.querySelector("[data-card-title]"),
    }))
    assert.deepEqual(untitled, { chip: "Awaiting human", title: false }, "the chip already says what the card is for")

    // ---- 1. the statement ----
    await page.goto(`${baseUrl}/awaiting-bg-fixture.html?steps=titled`, { waitUntil: "networkidle0" })
    await page.waitForSelector(`${CARD} [data-awaiting-steps] li`)
    await page.evaluate(() => {
      ;(window as unknown as { __rpc: unknown[] }).__rpc = []
      window.addEventListener("fixture-rpc", (e) => {
        ;(window as unknown as { __rpc: unknown[] }).__rpc.push((e as CustomEvent).detail)
      })
    })
    const card = await page.$eval(CARD, (el) => {
      const top = (sel: string) => el.querySelector(sel)?.getBoundingClientRect().top ?? NaN
      return {
        chip: (el.querySelector("[data-card-chip]") as HTMLElement | null)?.innerText.trim(),
        title: (el.querySelector("[data-card-title]") as HTMLElement | null)?.innerText.trim(),
        glyph: el.querySelector("[data-card-chip] svg")?.getAttribute("class") ?? "",
        // chip → title → rule → body, top to bottom
        order: [top("[data-card-chip]"), top("[data-card-title]"), top("[data-card-rule]"), top(".card-md")],
        proseColour: getComputedStyle(el.querySelector(".card-md p") as Element).color,
        stepColour: getComputedStyle(el.querySelector("[data-awaiting-steps] li") as Element).color,
        stepHeights: [...el.querySelectorAll("[data-awaiting-steps] .frizz-step-text")].map((t) => t.getBoundingClientRect().height),
        steps: [...el.querySelectorAll("[data-awaiting-steps] .frizz-step-text")].map((t) => (t as HTMLElement).innerText.trim()),
        code: [...el.querySelectorAll("[data-awaiting-steps] li code")].map((c) => c.textContent),
        strong: [...el.querySelectorAll("[data-awaiting-steps] li strong")].map((c) => c.textContent),
        snooze: !!el.querySelector("[data-awaiting-snooze]"),
        buttons: [...el.querySelectorAll("button:not([role=checkbox])")].map((b) => (b as HTMLElement).innerText.trim()),
        ticks: [...el.querySelectorAll("[data-awaiting-steps] button[role=checkbox]")].map((b) => b.getAttribute("aria-label")),
        textBoxes: el.querySelectorAll("textarea, input").length,
      }
    })
    assert.equal(card.chip, "Awaiting human", "the card's kind, in its chip")
    assert.equal(card.title, "Sign in to npm so the acme 4.2.0 release can publish", "the worker's own heading, under the chip")
    assert.match(card.glyph, /lucide-list-todo/, "the to-do glyph rides inside the chip, not the hourglass beside a title")
    assert.ok(card.order.every(Number.isFinite), "the chip, the title, the rule and the body are all drawn")
    assert.deepEqual([...card.order].sort((a, b) => a - b), card.order, "chip, title, rule, body — top to bottom")
    assert.equal(card.stepColour, card.proseColour, "one body is one colour: the steps are not brighter than the paragraph above them")
    assert.equal(new Set(card.stepHeights).size, 1, `a step carrying a command is no taller than one without (${card.stepHeights.join(", ")})`)
    assert.deepEqual(card.steps, [
      "Run npm login --auth-type=web in a terminal on this machine.",
      "Approve the browser prompt with the acme-bot account.",
      "Reply here once npm whoami prints acme-bot.",
    ], "every step, in the order the worker wrote them")
    assert.deepEqual(card.code, ["npm login --auth-type=web", "npm whoami", "acme-bot"], "a step is markdown: its code spans are code")
    assert.deepEqual(card.strong, ["acme-bot"])
    assert.equal(card.snooze, false, "the reader is the wait, so there is nothing to snooze until")
    assert.deepEqual(card.buttons, ["Done"], "one verb — a failed step is the human's own message, in the prompt box")
    assert.deepEqual(card.ticks, ["Step 1", "Step 2", "Step 3"], "every step is a checkbox the reader ticks")
    assert.equal(card.textBoxes, 0, "and no text box of the card's own beside the prompt box")

    // ---- 2. the stepper: a tick marks the step done and moves the accent to the next one, and it
    //         survives a reload, because the reader is halfway through a sign-in ----
    const stepper = () => page.$$eval("[data-awaiting-steps] .frizz-step", (lis) => lis.map((li) => ({
      state: li.getAttribute("data-step-state"),
      checked: li.querySelector("button[role=checkbox]")?.getAttribute("aria-checked"),
    })))
    assert.deepEqual((await stepper()).map((s) => s.state), ["next", "todo", "todo"], "the first step is the one to do")
    await page.click("[data-awaiting-steps] .frizz-step:nth-child(1) button[role=checkbox]")
    await page.waitForFunction(() => document.querySelector("[data-awaiting-steps] .frizz-step")?.getAttribute("data-step-state") === "done")
    assert.deepEqual(await stepper(), [{ state: "done", checked: "true" }, { state: "next", checked: "false" }, { state: "todo", checked: "false" }])
    await page.reload({ waitUntil: "networkidle0" })
    await page.waitForSelector(`${CARD} [data-awaiting-steps] li`)
    assert.deepEqual((await stepper()).map((s) => s.state), ["done", "next", "todo"], "the tick outlives a reload")
    await page.click("[data-awaiting-steps] .frizz-step:nth-child(1) button[role=checkbox]")
    await page.waitForFunction(() => document.querySelector("[data-awaiting-steps] .frizz-step")?.getAttribute("data-step-state") === "next")
    assert.deepEqual((await stepper()).map((s) => s.state), ["next", "todo", "todo"], "and a second click unticks it")
    assert.equal(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("frizz-steps-ticked:")).length), 0, "an unticked list leaves nothing behind")
    await page.evaluate(() => {
      ;(window as unknown as { __rpc: unknown[] }).__rpc = []
      window.addEventListener("fixture-rpc", (e) => {
        ;(window as unknown as { __rpc: unknown[] }).__rpc.push((e as CustomEvent).detail)
      })
    })

    // ---- 3. Done: one ordinary reply, then the card leaves the queue ----
    await page.click("[data-steps-done]")
    await page.waitForFunction(() => (window as unknown as { __rpc: Sent[] }).__rpc.some((c) => c.rpc === "followUp"), { timeout: 10_000 })
    const replies = await page.evaluate(() => (window as unknown as { __rpc: Sent[] }).__rpc.filter((c) => c.rpc === "followUp"))
    assert.equal(replies.length, 1, "one click is one reply")
    assert.equal(replies[0].body.message, "Done", "exactly the word, as if the human had typed it")
    assert.equal(replies[0].body.slug, "awaiting-bg-demo")
    assert.equal(replies[0].body.sessionId, "aaaaaaaa-bbbb-cccc-dddd-000000000001", "bound to the session that posted the steps")
    await page.waitForFunction((sel) => !document.querySelector(sel), { timeout: 10_000 }, CARD)

    assert.deepEqual(errors, [], "a clean console")
  } finally {
    await browser.close()
  }
})
