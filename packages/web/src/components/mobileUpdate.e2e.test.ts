import assert from "node:assert/strict"
import test from "node:test"

// Point at the BOARD URL of an isolated adhoc-stack, never the live instance. Only the supervisor is
// simulated, and every POST to it is REJECTED, so no state here can update or restart a real Frizz:
// the real App chooses its shell and renders the shared update control (useUpdateRestart).
// Start with `nub scripts/adhoc-stack.mjs --port=49637 --project=/path/to/disposable/demo`, then run
// `FRIZZ_MOBILE_UPDATE_E2E_URL=<board URL> nub run test packages/web/src/components/mobileUpdate.e2e.test.ts`.
//
// The phone shape is the maintainer's (2026-10-08, on #52): the board header keeps its gear, the gear
// wears a dot for a new release line only, and "Update Frizz" is a row on the phone Settings page.
const url = process.env.FRIZZ_MOBILE_UPDATE_E2E_URL

test("the phone updates from Settings, and the board gear's dot follows the desktop badge rule", { skip: !url, timeout: 120_000 }, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless({ protocolTimeout: 30_000 })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(String(error)))
    let status: Record<string, unknown> | null = null
    let requests = 0
    await page.setRequestInterception(true)
    page.on("request", async (request) => {
      const path = new URL(request.url()).pathname
      if (path === "/_frizz/control/status") {
        if (!status) return request.respond({ status: 404, body: "" })
        return request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ protocol: 1, state: "ready", ...status }) })
      }
      if (path.startsWith("/_frizz/control/") && request.method() === "POST") {
        requests++
        await new Promise((resolve) => setTimeout(resolve, 500))
        return request.respond({ status: 500, contentType: "application/json", body: "{}" })
      }
      return request.continue()
    })
    const minor = { updateRestart: true, updateAvailable: true, version: "0.13.8", updateVersion: "0.14.0" }
    const load = async (width: number, next: Record<string, unknown> | null) => {
      status = next
      await page.setViewport({ width, height: 844 })
      await page.goto(url!, { waitUntil: "networkidle2" })
      await page.waitForSelector(width <= 700 ? "[data-mobile-board]" : "[data-status-row]")
    }
    const openSettings = async () => {
      await page.click("[data-mobile-settings]")
      await page.waitForSelector("[data-mobile-settings-page]")
      // The page slides in from the right; measure it where it lands.
      await page.waitForFunction(() => Math.abs(document.querySelector("[data-mobile-settings-page]")!.getBoundingClientRect().left) < 0.5)
    }
    const gearDot = async () => Boolean(await page.$("[data-mobile-settings] [data-mobile-update-notification]"))
    const rowText = () => page.$eval("[data-mobile-update-row]", (el) => ({ text: el.textContent, disabled: (el as HTMLButtonElement).disabled, dot: Boolean(el.querySelector("[data-mobile-update-row-notification]")) }))

    // A new release line: the gear is dotted and says so; Settings offers the step.
    for (const width of [320, 390, 700]) {
      await load(width, minor)
      await page.waitForSelector("[data-mobile-settings] [data-mobile-update-notification]")
      assert.equal(await page.$eval("[data-mobile-settings]", (el) => el.getAttribute("aria-label")), "Settings, update available")
      assert.equal(await page.$("[data-mobile-more]"), null, "no ⋯ sheet on the board")
      await openSettings()
      await page.waitForSelector("[data-mobile-update-row]")
      assert.deepEqual(await rowText(), { text: "Update Frizz0.13.8 → 0.14.0", disabled: false, dot: true })
      const rect = await page.$eval("[data-mobile-update-row]", (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, height: r.height } })
      assert.ok(rect.left >= 0 && rect.right <= width && rect.height >= 44, JSON.stringify(rect))
    }

    // A patch: no gear dot (frizz-server ships those most days), but Settings still offers it.
    await load(390, { ...minor, updateVersion: "0.13.9" })
    await page.waitForFunction(() => document.querySelector("[data-mobile-settings]")?.getAttribute("aria-label") === "Settings")
    assert.equal(await gearDot(), false)
    await openSettings()
    await page.waitForSelector("[data-mobile-update-row]")
    assert.deepEqual(await rowText(), { text: "Update Frizz0.13.8 → 0.13.9", disabled: false, dot: true })

    // frizz-dev names no version: no dot anywhere, but the row stays live.
    await load(390, { updateRestart: true, dev: true })
    assert.equal(await gearDot(), false)
    await openSettings()
    await page.waitForSelector("[data-mobile-update-row]")
    assert.deepEqual(await rowText(), { text: "Update Frizz", disabled: false, dot: false })

    // Up to date: a muted, inert row.
    await load(390, { updateRestart: true, updateAvailable: false, version: "0.14.0" })
    assert.equal(await gearDot(), false)
    await openSettings()
    await page.waitForSelector("[data-mobile-update-row]")
    assert.deepEqual(await rowText(), { text: "Frizz is up to date", disabled: true, dot: false })

    // No supervisor: the gear opens Settings with no update row at all.
    await load(390, null)
    assert.equal(await gearDot(), false)
    await openSettings()
    assert.equal(await page.$("[data-mobile-update-row]"), null)

    // A rejected update: the blocking overlay rises, drops, and the failure stays inline, dismissible.
    await load(390, minor)
    await openSettings()
    await page.waitForSelector("[data-mobile-update-row]")
    await page.click("[data-mobile-update-row]")
    await page.waitForSelector('[role="alertdialog"]')
    assert.ok(await page.$("[inert]"), "updating blocks background interaction")
    await page.waitForSelector('[data-mobile-update] [role="alert"]')
    assert.equal(requests, 1)
    assert.equal(await page.$('[role="alertdialog"]'), null)
    await page.click('[data-mobile-update] button[aria-label="Dismiss"]')
    assert.equal(await page.$('[data-mobile-update] [role="alert"]'), null)
    assert.equal((await rowText()).disabled, false, "the row is live again after a rejection")

    // The Projects page hosts Settings without App's update monitor, so it offers no update.
    await page.goto(new URL("/", url!).href, { waitUntil: "networkidle2" })
    await page.waitForSelector("[data-mobile-projects-page]")
    await openSettings()
    assert.equal(await page.$("[data-mobile-update-row]"), null)
    assert.equal(await gearDot(), false)

    // Desktop is unchanged: one icon button in the status row, dotted for a release line only.
    await load(1440, minor)
    await page.waitForSelector('[data-status-row] button[aria-label="Update Frizz"]')
    assert.ok(await page.$('[data-status-row] button[aria-label="Update Frizz"] .bg-accent'))
    assert.equal(await page.$("[data-mobile-update-row]"), null)
    await load(1440, { ...minor, updateVersion: "0.13.9" })
    await page.waitForFunction(() => document.querySelector("#update-restart-popover") === null)
    await page.waitForSelector('[data-status-row] button[aria-label="Update Frizz"]')
    assert.equal(await page.$('[data-status-row] button[aria-label="Update Frizz"] .bg-accent'), null)

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
