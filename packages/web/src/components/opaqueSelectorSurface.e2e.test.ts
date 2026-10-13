import assert from "node:assert/strict"
import test from "node:test"

// This deliberately checks the browser-resolved paint, rather than the utility string. The
// regression was an opacity animation on the portaled layer: it could have a `bg-*` class and
// still composite the queue through the menu during its opening frame.
const baseUrl = process.env.FRIZZ_OPAQUE_SELECTOR_E2E_URL

test("board rail and open drawer keep the profile menu above queue rows", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  page.on("pageerror", (error) => errors.push(String(error)))

  async function assertOpaqueMenu(trigger: string, label: string, expectedTriggerText: string): Promise<void> {
    await page.click(trigger)
    await page.waitForSelector('[role="menu"]')
    const surface = await page.$eval('[role="menu"]', (node) => {
      const style = getComputedStyle(node)
      const color = style.backgroundColor.match(/rgba?\(([^)]+)\)/)?.[1].split(",").map(Number) ?? []
      return {
        backgroundColor: style.backgroundColor,
        alpha: color.length === 4 ? color[3] : 1,
        opacity: style.opacity,
        animationName: style.animationName,
        zIndex: style.zIndex,
      }
    })
    assert.equal(surface.alpha, 1, `${label} background must have an opaque resolved alpha channel`)
    assert.equal(surface.opacity, "1", `${label} surface must not composite through its parent`)
    assert.equal(surface.animationName, "none", `${label} surface must not begin with an opacity animation`)
    assert.ok(Number(surface.zIndex) > 100, `${label} surface must paint above the desktop queue rail`)
    // Assert the real hit target over the overlapping board rail, then use a physical click rather
    // than a DOM-dispatched event. This would hit a queue row when the portal is below z-[100].
    const hit = await page.$eval('[role="menu"]', (menu) => {
      const item = menu.querySelector<HTMLElement>('[role="menuitemradio"]')!
      const box = item.getBoundingClientRect()
      const hit = document.elementFromPoint(box.left + Math.min(12, box.width / 2), box.top + box.height / 2)
      return hit?.closest('[role="menuitemradio"]') === item
    })
    assert.equal(hit, true, `${label} menu item must receive pointer hits above the board rail`)
    await page.click('[role="menuitemradio"]')
    await page.waitForFunction(() => !document.querySelector('[role="menu"]'))
    assert.match(await page.$eval(trigger, (node) => node.textContent ?? ""), new RegExp(expectedTriggerText))
  }

  try {
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/drawer-composer-footer-fixture.html`, { waitUntil: "domcontentloaded" })
    await page.waitForSelector('button[aria-label="Thread model and effort"]')

    // The fixture opens on `› high`; the first radio in the grid is Medium, so a real click has to move
    // the trigger to `› medium`. LOWERCASE, and that is the point rather than an oversight: the menu
    // ITEM is titled `Medium`, while the trigger prints the recorded effort VERBATIM — see
    // profileGridDisplayLabel ("a concrete effort is displayed verbatim when present, and no effort is
    // ever inferred"), pinned at the unit level as `Sonnet › high`. This assertion asked for /Medium/
    // and so had been failing against a trigger that is behaving exactly as designed; nothing noticed,
    // because nothing set this file's env gate and the whole suite reported `skipped` (2026-08-24).
    await assertOpaqueMenu('button[aria-label="Thread model and effort"]', "model and effort", "› medium")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
