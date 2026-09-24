import assert from "node:assert/strict"
import test from "node:test"

// Runtime coverage for the model picker's AGENT SETTINGS panel — the gear on a runtime's band that
// replaced the context dropdown on 2026-09-19. The dropdown it replaced died the moment the pointer
// left its trigger (a non-modal popover inside a Radix menu item: the menu focuses its own content on
// item-leave, which the popover read as focus-outside). Nothing but a real browser can prove the
// replacement cannot: a source test can pin the `modal` flag, not what Radix does with it.
//
// Drives dispatch-composer-profile-fixture, which records every settingsSet the panel makes. Skipped
// unless FRIZZ_AGENT_SETTINGS_E2E_URL names a vite serving the fixtures (scripts/e2e-web.mjs sets it).
const baseUrl = process.env.FRIZZ_AGENT_SETTINGS_E2E_URL

type Fixture = { settingsWrites: Record<string, unknown>[] }
const MENU = ".profile-grid-menu"
const PANEL = '[data-agent-settings-menu="claude"]'
const GEAR = 'button[aria-label="Claude Code settings"]'
const PERMISSION = 'button[aria-label="Claude permission mode"]'
// The Select's own rows. The picker's grid cells are menuitemradios too, so the rows are scoped to
// the one menu that is NOT the profile grid — the Select portals its menu at z-[260], above the panel.
const SELECT_MENU = '[role="menu"]:not(.profile-grid-menu)'
const SELECT_ROW = `${SELECT_MENU} [role="menuitemradio"]`

async function launch(query = "") {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.goto(`${baseUrl}/dispatch-composer-profile-fixture.html${query}`, { waitUntil: "networkidle0" })
  await page.waitForSelector('button[aria-label="Model and effort"]')
  return { browser, page, errors }
}

const writes = (page: import("puppeteer").Page) =>
  page.evaluate(() => (window as unknown as { dispatchComposerProfileFixture: Fixture }).dispatchComposerProfileFixture.settingsWrites.map((w) => ({ ...w })))

async function openPanel(page: import("puppeteer").Page) {
  await page.click('button[aria-label="Model and effort"]')
  await page.waitForSelector(MENU)
  await page.click(GEAR)
  await page.waitForSelector(PANEL)
}

const center = async (page: import("puppeteer").Page, selector: string) => {
  const box = (await (await page.$(selector))!.boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

test("the panel survives the pointer leaving it, and a pick writes the whole settings object once", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await openPanel(page)
    // The failure this guards: leave the gear, cross the menu's own items, park far away. The old
    // control was gone before the pointer reached its panel.
    const gear = await center(page, GEAR)
    await page.mouse.move(gear.x, gear.y)
    for (const item of await page.$$(`${MENU} [role="menuitemradio"]`)) {
      const box = await item.boundingBox()
      if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 })
    }
    await page.mouse.move(8, 8, { steps: 10 })
    await new Promise((r) => setTimeout(r, 400))
    assert.ok(await page.$(PANEL), "the panel is still open after the pointer wandered off it")
    assert.ok(await page.$(MENU), "and the picker under it is still open too")
    // While the panel is open the picker beneath it is inert: its rows cannot be hit.
    const row = await center(page, `${MENU} [role="menuitemradio"]`)
    const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[role=menuitemradio]") !== null, row)
    assert.equal(hit, false, "a picker row is not hittable through the modal panel")

    // A Select inside the panel portals ABOVE it — its rows take the click, not the panel.
    await page.click(PERMISSION)
    await page.waitForSelector(`${SELECT_ROW}[aria-checked="false"]`)
    assert.ok(Number(await page.$eval(SELECT_MENU, (el) => getComputedStyle(el).zIndex)) > 250, "the Select's menu stacks above the z-[250] panel")
    const option = await center(page, `${SELECT_ROW}[aria-checked="false"]`)
    const optionHit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[role=menuitemradio]")?.getAttribute("aria-checked"), option)
    assert.equal(optionHit, "false", "the Select's own row receives the pointer above the panel")
    await page.mouse.click(option.x, option.y)
    await page.waitForFunction(() => (window as unknown as { dispatchComposerProfileFixture: Fixture }).dispatchComposerProfileFixture.settingsWrites.length === 1, { timeout: 3000 })
    await new Promise((r) => setTimeout(r, 300))
    const sent = await writes(page)
    assert.equal(sent.length, 1, "one click, one write")
    assert.equal(sent[0]!.permissionMode, "auto")
    // The whole object goes over — anything dropped here is a setting silently reset.
    assert.equal(sent[0]!.notifications, true)
    assert.equal("font" in sent[0]!, false)
    assert.equal(sent[0]!.autoCompactWindow, 500000)
    assert.ok(await page.$(PANEL), "picking a value leaves the panel open")
    assert.match(await page.$eval(PERMISSION, (el) => el.textContent ?? ""), /Auto/)
    assert.match(await page.$eval(PANEL, (el) => el.textContent ?? ""), /Saving…|Saved/)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("Escape peels one layer at a time: Select, then panel, then picker", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await openPanel(page)
    await page.click(PERMISSION)
    await page.waitForSelector(SELECT_MENU)
    await page.keyboard.press("Escape")
    await page.waitForFunction((menu) => !document.querySelector(menu), {}, SELECT_MENU)
    assert.ok(await page.$(PANEL), "the first Escape closed only the Select")
    await page.keyboard.press("Escape")
    await page.waitForFunction((panel) => !document.querySelector(panel), {}, PANEL)
    assert.ok(await page.$(MENU), "the second Escape closed only the panel")
    await page.keyboard.press("Escape")
    await page.waitForFunction((menu) => !document.querySelector(menu), {}, MENU)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("a click outside closes the panel and nothing else; the Codex band carries its own panel", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await openPanel(page)
    await page.mouse.click(8, 8)
    await page.waitForFunction((panel) => !document.querySelector(panel), {}, PANEL)
    assert.ok(await page.$(MENU), "the picker stays open under a dismissed panel")
    await page.click('button[aria-label="Codex settings"]')
    await page.waitForSelector('[data-agent-settings-menu="codex"] button[aria-label="Codex context window"]')
    assert.equal(await page.$('[data-agent-settings-menu="codex"] button[aria-label="Claude permission mode"]'), null, "the Codex panel carries no Claude field")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("a settings write still in flight holds the composer until it lands", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch("?settingsDelay=1500")
  try {
    await openPanel(page)
    await page.click(PERMISSION)
    await page.waitForSelector(`${SELECT_ROW}[aria-checked="false"]`)
    const option = await center(page, `${SELECT_ROW}[aria-checked="false"]`)
    await page.mouse.click(option.x, option.y)
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("textarea")?.disabled === true, { timeout: 2000 })
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("textarea")?.disabled === false, { timeout: 5000 })
    assert.equal((await writes(page)).length, 1)
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("project instructions save to FRIZZ.md and never overwrite a change a worker made meanwhile", { skip: !baseUrl, timeout: 60_000 }, async () => {
  type Instructions = { disk: string; revision: number; writes: { content: string; baseRevision: string }[] }
  const read = (page: import("puppeteer").Page) =>
    page.evaluate(() => structuredClone((window as unknown as { dispatchComposerProfileFixture: { instructions: Instructions } }).dispatchComposerProfileFixture.instructions))
  const FIELD = `${PANEL} textarea[aria-label="Project instructions"]`
  const { browser, page, errors } = await launch()
  try {
    await openPanel(page)
    await page.waitForFunction((f) => document.querySelector<HTMLTextAreaElement>(f)?.value === "Run the tests before committing.", {}, FIELD)
    await page.click(FIELD)
    await page.keyboard.press("End")
    await page.keyboard.type(" Never push.")
    await page.waitForFunction(() => (window as unknown as { dispatchComposerProfileFixture: { instructions: Instructions } }).dispatchComposerProfileFixture.instructions.writes.length === 1, { timeout: 3000 })
    let state = await read(page)
    assert.deepEqual(state.writes[0], { content: "Run the tests before committing. Never push.", baseRevision: "1" }, "one debounced write, based on the revision it loaded")
    assert.ok(await page.$(PANEL), "typing leaves the panel open")

    // A worker rewrites FRIZZ.md behind the open panel; the next edit is refused, not saved over it.
    await page.evaluate(() => {
      const i = (window as unknown as { dispatchComposerProfileFixture: { instructions: Instructions } }).dispatchComposerProfileFixture.instructions
      i.disk = "Edited by a worker."
      i.revision += 1
    })
    await page.keyboard.type("!")
    await page.waitForFunction((p) => /changed on disk/.test(document.querySelector(p)?.textContent ?? ""), { timeout: 3000 }, PANEL)
    state = await read(page)
    assert.equal(state.disk, "Edited by a worker.", "the worker's edit survives")
    await page.click(`${PANEL} button::-p-text(Load latest)`)
    assert.equal(await page.$eval(FIELD, (el) => (el as HTMLTextAreaElement).value), "Edited by a worker.")
    await page.click(FIELD)
    await page.keyboard.press("End")
    await page.keyboard.type(" Mine.")
    await page.waitForFunction(() => (window as unknown as { dispatchComposerProfileFixture: { instructions: Instructions } }).dispatchComposerProfileFixture.instructions.disk === "Edited by a worker. Mine.", { timeout: 3000 })
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
