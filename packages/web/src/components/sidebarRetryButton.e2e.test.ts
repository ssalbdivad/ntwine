import assert from "node:assert/strict"
import test from "node:test"

// The stalled row's one-click Retry is a HOVER affordance whose click must (a) fire the recovery
// follow-up and (b) NOT also navigate the row — two behaviors only a real browser proves: that the
// button is hidden until hover, that it reveals on hover, that stopPropagation actually keeps the row
// click from co-firing, and that the real retrySession → showToast → Toaster path runs.
const baseUrl = process.env.FRIZZ_SIDEBAR_RETRY_E2E_URL

test("hovering a stalled sidebar row reveals a Retry button that restarts the session in one click", {
  skip: !baseUrl,
  timeout: 90_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  const errors: string[] = []
  const notFound: string[] = []
  page.on("response", (response) => { if (response.status() === 404) notFound.push(new URL(response.url()).pathname) })
  page.on("console", (message) => { if (message.type() === "error" && !message.text().includes("404")) errors.push(message.text()) })
  page.on("pageerror", (error) => errors.push(String(error)))

  const retry = '[data-sidebar-retry="stalled-migration"]'
  // getClientRects, NOT getComputedStyle: the hover reveal's `hidden` class sits on the ACTIONS CLUSTER
  // wrapper (Sidebar's group-hover div), and a descendant of a display:none ancestor still reports its
  // OWN computed display — so a style probe on the button reads "visible" while nothing paints. Zero
  // client rects is what "hidden by any ancestor" actually measures.
  const visible = (sel: string) => page.$eval(sel, (el) => el.getClientRects().length > 0).catch(() => false)

  try {
    await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/sidebar-retry-fixture.html`, { waitUntil: "networkidle0" })
    await page.waitForSelector('[data-sidebar-item="stalled-migration"]')

    // The two STOPPED rows (a [!] crash and a […] exited-at-rest) AND the limit-KILLED row carry a
    // retry control; the live working row and the live turn-idle resting row must not.
    const retryCount = await page.$$eval("[data-sidebar-retry]", (els) => els.map((e) => e.getAttribute("data-sidebar-retry")))
    assert.deepEqual(retryCount, ["stalled-migration", "exited-at-rest", "limit-killed"], "the two stopped rows and the limit-killed row carry Retry")

    // Hidden at rest…
    assert.equal(await visible(retry), false, "the Retry button is hidden until the row is hovered")

    // …revealed on hover.
    await page.hover('[data-sidebar-item="stalled-migration"]')
    await page.waitForFunction((sel) => (document.querySelector(sel)?.getClientRects().length ?? 0) > 0, { timeout: 5_000 }, retry)
    assert.equal(await visible(retry), true, "hovering the row reveals Retry")

    // It sits at the row's RIGHT edge (right-justified), past the row's horizontal midpoint.
    const geo = await page.evaluate((rowSel, btnSel) => {
      const row = document.querySelector(rowSel)!.getBoundingClientRect()
      const btn = document.querySelector(btnSel)!.getBoundingClientRect()
      return { rowLeft: row.left, rowRight: row.right, btnLeft: btn.left, btnRight: btn.right }
    }, '[data-sidebar-item="stalled-migration"]', retry)
    assert.ok(geo.btnLeft > (geo.rowLeft + geo.rowRight) / 2, "Retry is right-justified in the row")
    assert.ok(geo.rowRight - geo.btnRight < 12, "…pinned near the right edge")

    // Click it. The recovery follow-up must fire with the shared restart message, and — crucially — the
    // row must NOT also navigate (stopPropagation): no thread drawer opens.
    await page.click(retry)
    await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("followUpCalls") ?? "[]").length === 1, { timeout: 5_000 })
    const calls = await page.evaluate(() => JSON.parse(sessionStorage.getItem("followUpCalls") ?? "[]"))
    // retrySession is now an ordinary eager send (lib/retrySession → sendEagerFollowUp), so the body
    // carries a `deliveryId` — the delivery-ledger handle the old direct call omitted, which is exactly
    // what let a retry ghost. sendEagerFollowUp resolves the session-guard id from the live board; the
    // fixture thread carries none, so it sends "" (the server fails a stale/absent row closed). The
    // message is the shared restart constant.
    assert.equal(calls.length, 1, "exactly one recovery follow-up fires")
    const [call] = calls
    assert.equal(call.slug, "stalled-migration")
    assert.equal(call.sessionId, "")
    assert.equal(call.message, "Continue exactly where you left off.")
    assert.equal(typeof call.deliveryId, "string", "it went through the eager path — a ledger deliveryId rides the send")
    assert.ok(call.deliveryId.length > 0, "…and it is non-empty")

    // The retry toast confirms it to the user.
    await page.waitForFunction(() => /Retrying/.test(document.body.innerText), { timeout: 5_000 })

    // ── The limit-KILLED row: same one-click Retry, and since 2026-08-31 it is YELLOW too — the
    // accent-boxed hourglass, not the [!] (the glyphs differ, the color and the verb do not).
    const limitRetry = '[data-sidebar-retry="limit-killed"]'
    const limitMark = await page.$eval('[data-sidebar-item="limit-killed"]', (row) => ({
      kind: row.querySelector("[data-rail-glyph]")?.getAttribute("data-rail-glyph"),
      accentBox: Boolean(row.querySelector('[data-rail-glyph] .border-accent\\/90')),
      accentHourglass: Boolean(row.querySelector("svg.lucide-hourglass.text-accent")),
      stallBang: /(?:^|>)!(?:<|$)/.test(row.querySelector("[data-rail-glyph]")?.innerHTML ?? ""),
    }))
    assert.equal(limitMark.kind, "limit", "the resolved kind is the limit mark")
    assert.equal(limitMark.accentBox, true, "the limit-killed row's box wears the accent yellow")
    assert.equal(limitMark.accentHourglass, true, "…around a yellow hourglass")
    assert.equal(limitMark.stallBang, false, "…and never the [!] — that mark stays the crash's")

    // Hidden until hover, revealed on hover — exactly like a stalled row.
    assert.equal(await visible(limitRetry), false, "the limit-killed Retry is hidden until its row is hovered")
    await page.hover('[data-sidebar-item="limit-killed"]')
    await page.waitForFunction((sel) => (document.querySelector(sel)?.getClientRects().length ?? 0) > 0, { timeout: 5_000 }, limitRetry)
    assert.equal(await visible(limitRetry), true, "hovering the limit-killed row reveals Retry")

    // Clicking it fires the SAME recovery follow-up (the shared continue message) — a second RPC call.
    await page.click(limitRetry)
    await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("followUpCalls") ?? "[]").length === 2, { timeout: 5_000 })
    const allCalls = await page.evaluate(() => JSON.parse(sessionStorage.getItem("followUpCalls") ?? "[]"))
    // Field by field, exactly as the stalled row's call is read above — and for the same reason: the
    // eager path stamps a fresh `deliveryId` UUID, so a whole-object deepEqual could never hold. This
    // line called a `stable()` helper that dropped that field, and `a7b40082` rewrote the FIRST
    // assertion into the spelling above while deleting the helper both of them shared. Nothing caught
    // it, because nothing has run this file: every e2e here gates on a `FRIZZ_*_E2E_URL` that no runner
    // set, so the whole suite reported `skipped` and counted as green. It has thrown
    // `ReferenceError: stable is not defined` on its last assertion ever since (2026-08-24).
    const [, limitCall] = allCalls
    assert.equal(limitCall.slug, "limit-killed")
    assert.equal(limitCall.sessionId, "")
    assert.equal(limitCall.message, "Continue exactly where you left off.")
    assert.equal(typeof limitCall.deliveryId, "string", "the limit-killed retry goes through the same eager path")
    assert.ok(limitCall.deliveryId.length > 0, "…and carries its own ledger handle")

    assert.deepEqual(errors, [])
    assert.deepEqual(notFound.filter((path) => path !== "/favicon.ico"), [])
  } finally {
    await browser.close()
  }
})
