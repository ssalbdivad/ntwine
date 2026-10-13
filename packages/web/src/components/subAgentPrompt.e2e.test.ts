import assert from "node:assert/strict"
import test from "node:test"

const baseUrl = process.env.FRIZZ_SUBAGENT_PROMPT_E2E_URL
const screenshotBase = process.env.FRIZZ_SUBAGENT_PROMPT_SCREENSHOT

test("expanded sub-agent dispatches show only the initial prompt", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const errors: string[] = []
  try {
    const page = await browser.newPage()
    page.on("pageerror", (error) => errors.push(String(error)))
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()) })
    await page.goto(`${baseUrl}/subagent-prompt-fixture.html`, { waitUntil: "networkidle0" })
    await page.waitForSelector("[data-tool-disclosure]")
    const disclosures = await page.$$("[data-tool-disclosure]")
    assert.equal(disclosures.length, 4)
    for (const disclosure of disclosures) {
      assert.equal(await disclosure.evaluate((element) => element.getAttribute("aria-expanded")), "false")
      await disclosure.click()
      assert.equal(await disclosure.evaluate((element) => element.getAttribute("aria-expanded")), "true")
    }
    const bodies = await page.$$eval("[data-prompt-case] .frizz-bash-body", (elements) => elements.map((element) => element.textContent))
    assert.deepEqual(bodies, [
      "Inspect the resolver.\n\nReport the failing case.",
      "Inspect the resolver.\n\nReport the failing case.",
      "Initial prompt unavailable.",
      Array.from({ length: 20 }, (_, i) => `Instruction ${i + 1}`).join("\n"),
    ])
    assert.doesNotMatch(await page.$eval("main", (element) => element.textContent ?? ""), /fork_turns|service_tier|agent_id|agent_name/)
    assert.equal(await page.$(".frizz-bash-output-label"), null)
    assert.equal(await page.$(".frizz-bash-output-body"), null)
    assert.ok(await page.$('[data-prompt-case="3"] .frizz-bash-clamp'))
    await page.click('[data-prompt-case="3"] .frizz-bash-expand')
    assert.equal(await page.$('[data-prompt-case="3"] .frizz-bash-clamp'), null)

    for (const font of ["sans", "mono"]) {
      await page.evaluate((value) => { document.documentElement.dataset.font = value }, font)
      for (const width of [1000, 390]) {
        await page.setViewport({ width, height: 1000, deviceScaleFactor: 2 })
        assert.ok(await page.$eval("main", (element) => element.scrollWidth <= element.clientWidth + 1), `${font} ${width}: no horizontal overflow`)
        if (screenshotBase) await page.screenshot({ path: `${screenshotBase}-${font}-${width}.png` })
      }
    }
    await disclosures[0].click()
    const controls = await disclosures[0].evaluate((element) => element.getAttribute("aria-controls"))
    assert.ok(await page.$eval(`[id="${controls}"]`, (element) => (element as HTMLElement).hidden))
    // The title still drills into the child's transcript instead of toggling the prompt.
    await page.click('[data-prompt-case="0"] [aria-label^="Open sub-agent transcript:"]')
    const drawer = await page.evaluate(async (modulePath) => {
      const { store } = await import(modulePath)
      const last = store.drawers.at(-1)
      return { kind: last?.kind, subId: last?.subId }
    }, "/src/store.ts")
    assert.deepEqual(drawer, { kind: "subagent", subId: "dispatch-0" })
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
