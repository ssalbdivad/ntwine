import assert from "node:assert/strict"
import test from "node:test"

// The two in-drawer cards that RESTART A TURN on an at-rest thread — a provider sign-in fault
// (ProviderFaultCard) and a usage-limit pause (LimitPauseCard). Both used to call rpc.followUp
// DIRECTLY, so alone with the sidebar Retry they bypassed the eager send: no optimistic bubble, no
// rail reorder, and — the machine-checkable tell — no delivery-ledger `deliveryId` on the send. This
// drives the real cards (turn-restart-cards-fixture) and asserts each button now goes through
// sendEagerFollowUp: the recorded /rpc/followUp body carries a non-empty deliveryId.
//
// Runs against a `vite dev` server serving the web package (multi-page); the middleware dev server
// hardcodes index.html and cannot serve a fixture route, so this is skip-gated on the URL exactly like
// sidebarRetryButton.e2e.test.ts.
const baseUrl = process.env.FRIZZ_TURN_RESTART_CARDS_E2E_URL

test("the provider-fault Retry and limit-pause Continue both send through the eager path", {
  skip: !baseUrl,
  timeout: 90_000,
}, async () => {
  const { launchHeadless } = await import("../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("404")) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))

  try {
    await page.setViewport({ width: 760, height: 700, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/turn-restart-cards-fixture.html`, { waitUntil: "networkidle0" })
    await page.waitForSelector("[data-provider-fault]")
    await page.waitForSelector("[data-limit-pause]")

    // Provider-fault Retry (the first button in the card — the sign-in button follows it).
    await page.click("[data-provider-fault] button")
    await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("followUpCalls") ?? "[]").length === 1, { timeout: 5_000 })
    // Limit-pause Continue now (its only button).
    await page.click("[data-limit-pause] button")
    await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("followUpCalls") ?? "[]").length === 2, { timeout: 5_000 })

    const calls = await page.evaluate(() => JSON.parse(sessionStorage.getItem("followUpCalls") ?? "[]"))
    assert.equal(calls.length, 2, "both cards fire exactly one follow-up")

    const [retry, cont] = calls
    assert.equal(retry.slug, "auth-faulted")
    assert.equal(retry.message, "fix the flaky test", "the provider-fault card resends the previous message")
    assert.equal(typeof retry.deliveryId, "string")
    assert.ok(retry.deliveryId.length > 0, "provider-fault Retry rides the eager path — a ledger deliveryId is present")

    assert.equal(cont.slug, "limit-paused")
    assert.equal(cont.message, "Continue exactly where you left off.", "the limit-pause card sends the shared restart message")
    assert.equal(typeof cont.deliveryId, "string")
    assert.ok(cont.deliveryId.length > 0, "limit-pause Continue rides the eager path — a ledger deliveryId is present")

    // The two deliveryIds are distinct — each click mints its own ledger entry.
    assert.notEqual(retry.deliveryId, cont.deliveryId)

    await page.waitForFunction(() => /Retrying|Continuing/.test(document.body.innerText), { timeout: 5_000 })
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
