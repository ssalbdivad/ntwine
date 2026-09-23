import assert from "node:assert/strict"
import test from "node:test"

// Runtime coverage for the OPTIMISTIC Mark-as-done dismissal. Skipped unless a Vite URL serving the
// fixtures is provided (same pattern as the other *.e2e.test.ts here): start `vite` in packages/web and
// set FRIZZ_QUEUE_OPTIMISTIC_DONE_E2E_URL to its origin. The optimistic-done-fixture delays the
// completeThread RPC 1500ms, so these assertions prove the card leaves the queue BEFORE the RPC resolves.
const baseUrl = process.env.FRIZZ_QUEUE_OPTIMISTIC_DONE_E2E_URL

const SLUG = "auth-refresh"
const cardSel = (slug: string) => `[data-queue-card-root="${slug}"]`

async function launch() {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  return { browser, page, errors }
}

test("Mark-as-done dismisses a resting card instantly — the fade precedes the completeThread round-trip", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { browser, page, errors } = await launch()
  try {
    await page.goto(`${baseUrl}/optimistic-done-fixture.html`, { waitUntil: "networkidle0" })
    await page.waitForSelector(cardSel(SLUG))

    await page.evaluate((slug) => {
      const card = document.querySelector(`[data-queue-card-root="${slug}"]`)!
      card.querySelector<HTMLButtonElement>('[data-thread-lifecycle-footer] button[aria-label="Mark as done"]')!.click()
    }, SLUG)

    // ~150ms in: the card is already fading and the (1500ms-delayed) RPC has NOT resolved.
    await new Promise((r) => setTimeout(r, 150))
    const midFlight = await page.evaluate((slug) => {
      const card = document.querySelector(`[data-queue-card-root="${slug}"]`)
      return {
        leaving: card ? card.getAttribute("data-queue-leaving") : "unmounted",
        rpcResolvedAt: (window as unknown as { __rpc: { completeResolvedAt: number | null } }).__rpc.completeResolvedAt,
      }
    }, SLUG)
    assert.equal(midFlight.leaving, "true", "card must be marked leaving right after the click")
    assert.equal(midFlight.rpcResolvedAt, null, "the completeThread RPC must still be in flight while the card fades")

    // The exit animation finishes and the card unmounts — still before the RPC resolves.
    await new Promise((r) => setTimeout(r, 550))
    const afterFade = await page.evaluate((slug) => ({
      cardPresent: !!document.querySelector(`[data-queue-card-root="${slug}"]`),
      remaining: document.querySelectorAll("[data-queue-card-root]").length,
      rpcResolvedAt: (window as unknown as { __rpc: { completeResolvedAt: number | null } }).__rpc.completeResolvedAt,
    }), SLUG)
    assert.equal(afterFade.cardPresent, false, "card is gone from the queue before the RPC resolves")
    assert.equal(afterFade.remaining, 2, "the other two cards remain")
    assert.equal(afterFade.rpcResolvedAt, null, "still before the RPC resolved")

    // Once the RPC resolves the card stays gone — no flicker-back.
    await new Promise((r) => setTimeout(r, 1400))
    const settled = await page.evaluate((slug) => ({
      cardPresent: !!document.querySelector(`[data-queue-card-root="${slug}"]`),
      remaining: document.querySelectorAll("[data-queue-card-root]").length,
      rpcResolvedAt: (window as unknown as { __rpc: { completeResolvedAt: number | null } }).__rpc.completeResolvedAt,
    }), SLUG)
    assert.equal(settled.cardPresent, false, "card remains dismissed after the RPC resolves")
    assert.equal(settled.remaining, 2)
    assert.notEqual(settled.rpcResolvedAt, null, "the delayed RPC did eventually resolve")
    assert.deepEqual(errors, [], "no console/page errors during the flow")
  } finally {
    await browser.close()
  }
})

test("a needsConfirmation reply reinstates the optimistically-dismissed card and opens the dialog", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { browser, page, errors } = await launch()
  try {
    // ?needsConfirmation=1 makes completeThread decline (a mispredict / executing turn), returning fast.
    await page.goto(`${baseUrl}/optimistic-done-fixture.html?needsConfirmation=1`, { waitUntil: "networkidle0" })
    await page.waitForSelector(cardSel(SLUG))

    await page.evaluate((slug) => {
      const card = document.querySelector(`[data-queue-card-root="${slug}"]`)!
      card.querySelector<HTMLButtonElement>('[data-thread-lifecycle-footer] button[aria-label="Mark as done"]')!.click()
    }, SLUG)

    // The fast decline lands before the ~320ms exit: the card must snap back and the dialog must open.
    await new Promise((r) => setTimeout(r, 450))
    const reconciled = await page.evaluate((slug) => {
      const card = document.querySelector(`[data-queue-card-root="${slug}"]`)
      const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]')
      return {
        cardPresent: !!card,
        leaving: card ? card.getAttribute("data-queue-leaving") : "unmounted",
        remaining: document.querySelectorAll("[data-queue-card-root]").length,
        dialogOpen: !!dialog,
        dialogMentionsEndSession: !!dialog && /End this session|stop its agent session/i.test(dialog.textContent ?? ""),
        holdText: document.querySelector("[data-completion-hold]")?.textContent ?? null,
      }
    }, SLUG)
    assert.equal(reconciled.cardPresent, true, "declined completion must reinstate the card")
    assert.notEqual(reconciled.leaving, "true", "the reinstated card is no longer fading")
    assert.equal(reconciled.remaining, 3, "all three cards are back")
    assert.equal(reconciled.dialogOpen, true, "the confirmation dialog opens over the reinstated card")
    assert.equal(reconciled.dialogMentionsEndSession, true)
    // The whole point of the dialog: it must name WHAT is still running, counted and labelled, so the
    // human can tell "a CI watcher I forgot about" from "a child still mid-audit" without leaving it.
    const hold = reconciled.holdText ?? ""
    assert.match(hold, /1 sub-agent(?!s)/, "the live child is counted, singular")
    assert.match(hold, /Audit the refresh-token rotation/, "…and named")
    assert.match(hold, /2 background shells/, "both shells are counted, plural")
    assert.match(hold, /Watch origin\/main CI/)
    assert.match(hold, /vite dev server/)
    assert.match(hold, /no recent output/, "the quiet shell is marked, not overclaimed as running")
    assert.deepEqual(errors, [], "no console/page errors during the reconcile flow")
  } finally {
    await browser.close()
  }
})

test("a message delivered while the confirmation dialog is up withdraws it", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { browser, page, errors } = await launch()
  try {
    await page.goto(`${baseUrl}/optimistic-done-fixture.html?needsConfirmation=1`, { waitUntil: "networkidle0" })
    await page.waitForSelector(cardSel(SLUG))
    await page.evaluate((slug) => {
      const card = document.querySelector(`[data-queue-card-root="${slug}"]`)!
      card.querySelector<HTMLButtonElement>('[data-thread-lifecycle-footer] button[aria-label="Mark as done"]')!.click()
    }, SLUG)
    await page.waitForSelector("[data-completion-hold]")

    // Negative control: a message to a DIFFERENT thread leaves this dialog alone.
    await page.evaluate(() => (window as unknown as { __deliverMessage: (s: string) => void }).__deliverMessage("csv-export"))
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(await page.$("[data-completion-hold]") !== null, true, "an unrelated thread's message keeps the dialog")

    await page.evaluate((slug) => (window as unknown as { __deliverMessage: (s: string) => void }).__deliverMessage(slug), SLUG)
    await page.waitForFunction(() => !document.querySelector("[data-completion-hold]"), { timeout: 2000 })

    // …and Mark as done still works afterwards: a fresh decline reopens it.
    await page.evaluate((slug) => {
      const card = document.querySelector(`[data-queue-card-root="${slug}"]`)!
      card.querySelector<HTMLButtonElement>('[data-thread-lifecycle-footer] button[aria-label="Mark as done"]')!.click()
    }, SLUG)
    await page.waitForSelector("[data-completion-hold]", { timeout: 2000 })
    assert.deepEqual(errors, [], "no console/page errors")
  } finally {
    await browser.close()
  }
})
