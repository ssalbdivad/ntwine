import assert from "node:assert/strict"
import test from "node:test"

const baseUrl = process.env.FRIZZ_SNOOZE_CARD_E2E_URL

// The transcript's snooze COUNTDOWN card (SnoozeCard, maintainer 2026-08-24: a wall-clock-snoozed
// thread "should just be a card that renders at the bottom of the transcript … It should basically
// look like a countdown"). All four facts are RENDERING facts, so they are pinned in a real browser
// against the real component (snooze-card-fixture.html):
//
//   1. The countdown is the headline, in the padded two-unit shape, and it TICKS — the seconds digit
//      moves on its own while the page just sits there.
//   2. The two snooze shapes say different sentences: a plain park promises the queue card, a
//      scheduled bump names the follow-up it will send.
//   3. Wake now fires the real setThreadSnooze mutation with `until: null`, and the card unmounts when
//      the snooze clears.
//   4. A foreign session gets the statement without the verb.
//
// Run it against a plain vite over packages/web:
//   npx vite --port 5211 --strictPort --host 127.0.0.1
//   FRIZZ_SNOOZE_CARD_E2E_URL=http://127.0.0.1:5211 nub --test packages/web/src/components/snoozeCard.e2e.test.ts
test("the snooze card counts down, names the wake, and Wake now clears the park", {
  skip: !baseUrl,
  timeout: 120_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("404")) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))

  try {
    await page.setViewport({ width: 900, height: 700, deviceScaleFactor: 1 })

    // ---- 1. the countdown headline, far out: the unpadded above-a-day shape ----
    await page.goto(`${baseUrl}/snooze-card-fixture.html`, { waitUntil: "networkidle0" })
    await page.waitForSelector("[data-snooze-card]")
    const far = await page.$eval("[data-snooze-countdown]", (n) => (n as HTMLElement).innerText.trim())
    assert.match(far, /^2d 3h$/, "the default 2d3h remaining renders the smhdw ladder's two-unit day shape")
    const plainBody = await page.$eval("[data-snooze-card] p", (n) => (n as HTMLElement).innerText.trim())
    assert.match(plainBody, /^Returns to the queue .+ at .+\.$/, "a plain snooze promises the queue card at the wake instant")

    // ---- 1b. near-in: padded minutes-and-seconds, and it actually ticks ----
    await page.goto(`${baseUrl}/snooze-card-fixture.html?in=95`, { waitUntil: "networkidle0" })
    await page.waitForSelector("[data-snooze-countdown]")
    const before = await page.$eval("[data-snooze-countdown]", (n) => (n as HTMLElement).innerText.trim())
    assert.match(before, /^1m \d{2}s$/, "under an hour the countdown keeps seconds, padded to two digits")
    await new Promise((r) => setTimeout(r, 2_200))
    const after = await page.$eval("[data-snooze-countdown]", (n) => (n as HTMLElement).innerText.trim())
    assert.notEqual(after, before, "the seconds digit moves on its own — the countdown is live, not a caption")

    // ---- 2. the scheduled-bump shape names its follow-up ----
    await page.goto(`${baseUrl}/snooze-card-fixture.html?prompt=1`, { waitUntil: "networkidle0" })
    await page.waitForSelector("[data-snooze-card]")
    const bumpBody = await page.$eval("[data-snooze-card] p", (n) => (n as HTMLElement).innerText.trim())
    assert.match(bumpBody, /^Resumes .+ and sends: “Re-check the deploy/, "a snooze carrying a prompt says what the wake will send")

    // ---- 3. Wake now → setThreadSnooze(until: null) → the card unmounts ----
    await page.goto(`${baseUrl}/snooze-card-fixture.html`, { waitUntil: "networkidle0" })
    await page.waitForSelector("[data-snooze-wake-now]")
    await page.evaluate(() => {
      ;(window as unknown as { __rpc: unknown[] }).__rpc = []
      window.addEventListener("fixture-rpc", (e) => {
        ;(window as unknown as { __rpc: unknown[] }).__rpc.push((e as CustomEvent).detail)
      })
    })
    await page.click("[data-snooze-wake-now]")
    await page.waitForSelector("[data-snooze-cleared]")
    const calls = await page.evaluate(() => (window as unknown as { __rpc: Array<{ rpc: string; body: { slug?: string; until?: unknown } }> }).__rpc)
    assert.equal(calls.length, 1, "one Wake now click is one mutation")
    assert.equal(calls[0].rpc, "setThreadSnooze")
    assert.equal(calls[0].body.slug, "snooze-card-demo")
    assert.equal(calls[0].body.until, null, "waking clears the deadline rather than moving it")

    // ---- 4. a foreign session states the park and offers no verb ----
    await page.goto(`${baseUrl}/snooze-card-fixture.html?foreign=1`, { waitUntil: "networkidle0" })
    await page.waitForSelector("[data-snooze-card]")
    assert.equal(await page.$("[data-snooze-wake-now]"), null, "no Wake now on a session the RPC would refuse to edit")

    assert.deepEqual(errors, [], "the fixture renders with a clean console")
  } finally {
    await browser.close()
  }
})
