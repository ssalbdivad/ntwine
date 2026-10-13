import assert from "node:assert/strict"
import test from "node:test"

// Runtime coverage for the Settings drawer's AUTOSAVE. There is no Save button any more, so the only
// thing that can prove a change persisted is watching the settingsSet requests leave the page. Skipped
// unless a Vite URL serving the fixtures is provided (same pattern as the other *.e2e.test.ts here):
// start `vite` in packages/web and set FRIZZ_SETTINGS_AUTOSAVE_E2E_URL to its origin.
//
// settings-formatting-fixture records every write on window.__settingsWrites and echoes the payload
// back, so these assertions read the real wire traffic of a real drawer, not a stub of it.
const baseUrl = process.env.FRIZZ_SETTINGS_AUTOSAVE_E2E_URL

type Write = { at: number; body: Record<string, unknown>; ok: boolean }

async function launch(query = "") {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  await page.setViewport({ width: 900, height: 1000, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.goto(`${baseUrl}/settings-formatting-fixture.html${query}`, { waitUntil: "networkidle0" })
  await page.waitForSelector('button[aria-label="Local file link opener"]')
  return { browser, page, errors }
}

const readWrites = (page: import("puppeteer").Page) =>
  page.evaluate(() => (window as unknown as { __settingsWrites: Write[] }).__settingsWrites.map((w) => ({ ...w })))

// The Off of the Desktop notifications row, found by its field's label: other rows have an Off|On pair
// too, and the first of them (Project sidebar) already starts Off, so its click writes nothing.
function clickNotificationsOff() {
  const off = [...document.querySelectorAll("button")].find((b) => {
    if (b.textContent?.trim() !== "Off") return false
    for (let el = b.parentElement; el; el = el.parentElement) {
      if (el.textContent?.trimStart().startsWith("Desktop notifications")) return true
    }
    return false
  })
  if (!off) throw new Error("no Off button in the Desktop notifications row")
  off.click()
}

test("the drawer offers no Save or Cancel — a toggle writes on the click", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    const buttons = await page.evaluate(() =>
      [...document.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim()),
    )
    assert.ok(!buttons.some((label) => /^(Save|Saving…|Cancel)$/.test(label)), `no Save/Cancel button: ${buttons.join("|")}`)

    // Desktop notifications: Off (the fixture starts it On, and turning it off asks the browser for
    // nothing). One discrete intent, so it must be on the wire without a debounce to wait out.
    await page.evaluate(clickNotificationsOff)
    await page.waitForFunction(() => (window as unknown as { __settingsWrites: Write[] }).__settingsWrites.length === 1, { timeout: 2000 })

    const writes = await readWrites(page)
    assert.equal(writes.length, 1, "exactly one write for one click")
    assert.equal(writes[0]!.body.notifications, false)
    // The whole object goes over, not a patch — anything dropped here is a setting silently reset.
    assert.equal(writes[0]!.body.permissionMode, "auto")

    // The header reports the save rather than leaving the operator guessing.
    await page.waitForFunction(() => /Saving…|Saved/.test(document.querySelector("header")?.textContent ?? ""), { timeout: 2000 })

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// Removing the Save button removed the operator's own retry. A mutation refused mid-update is
// certified side-effect-free (`retryable` in the envelope), so the drawer has to replay it — otherwise
// restarting Frizz while Settings is open silently discards whatever was changed in that window.
test("a replayable refusal is replayed until it lands, and says so meanwhile", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch("?retryableFailures=1")
  try {
    await page.evaluate(clickNotificationsOff)
    await page.waitForFunction(() => (window as unknown as { __settingsWrites: Write[] }).__settingsWrites.length === 1, { timeout: 2000 })
    // While the retry is pending the header owns up to it rather than implying the change was stored.
    assert.match(await page.evaluate(() => document.querySelector("header")!.textContent ?? ""), /Couldn't save/)

    await page.waitForFunction(() => (window as unknown as { __settingsWrites: Write[] }).__settingsWrites.length === 2, { timeout: 6000 })
    const writes = await readWrites(page)
    assert.equal(writes[0]!.ok, false, "the first attempt was refused")
    assert.equal(writes[1]!.ok, true, "the replay landed")
    assert.equal(writes[1]!.body.notifications, false, "the replay carries the same value, not a reverted one")
    await page.waitForFunction(() => /Saved/.test(document.querySelector("header")?.textContent ?? ""), { timeout: 2000 })
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// The drawer has no free-text field any more: the triage prompt — the one DEBOUNCED input — moved to
// the GitHub picker's own settings popover on 2026-09-19, and its one-write-per-burst, flush-on-close
// and reset-to-unset behaviours are pinned there (githubPromptPopover.e2e.test.ts). What is left here
// is what the drawer still does: discrete controls that write on the click, and the replay above.
test("the drawer carries no prompt editor and no tab strip", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    assert.equal(await page.evaluate(() => document.querySelectorAll("textarea").length), 0)
    assert.equal(await page.evaluate(() => document.querySelectorAll('[role="tab"]').length), 0)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
