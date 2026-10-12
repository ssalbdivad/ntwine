import assert from "node:assert/strict"
import test from "node:test"

const baseUrl = process.env.FRIZZ_DRAWER_COMPOSER_INSET_E2E_URL

test("thread drawer counts its ops over the prompt box and keeps the box inset evenly", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--force-color-profile=srgb"],
  })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()) })
  page.on("pageerror", (error) => errors.push(String(error)))

  try {
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/drawer-composer-footer-fixture.html`, { waitUntil: "networkidle0" })
    const measure = () => page.$eval("[data-thread-action-bar]", (actionBar) => {
      const composer = actionBar.querySelector<HTMLElement>("[data-surface=drawerFooterFixture]")?.closest<HTMLElement>(".group")
      const chatFooter = document.querySelector<HTMLElement>("[data-thread-chat-footer]")
      const summary = actionBar.querySelector<HTMLElement>("[data-queue-ops-summary]")
      if (!composer || !chatFooter || !summary) throw new Error("drawer footer fixture is incomplete")
      const bar = actionBar.getBoundingClientRect()
      const box = composer.getBoundingClientRect()
      const line = summary.getBoundingClientRect()
      return {
        // The line of op counts takes the whole of the bar's 12px top inset (QueueOpsSummary's `-mt-3`),
        // the way it does on the queue card's dock: its 32px line starts on the rule, then the prompt
        // box. Where the counts stand INSIDE that line is queueOpsPanels.e2e.test.ts's to pin.
        lineTop: line.top - bar.top,
        top: box.top - bar.top,
        right: bar.right - box.right,
        left: box.left - bar.left,
        // Nothing hangs under the box any more (the rows moved into the counts' hover panel on
        // 2026-10-09), so its bottom inset is the bar's own 12px, border to edge, like the other three.
        bottom: bar.bottom - box.bottom,
        counts: [...summary.querySelectorAll<HTMLElement>("[data-ops-count]")].map((count) => count.innerText.replace(/\s+/g, " ").trim()),
        hangingRows: actionBar.querySelectorAll("[data-background-ops], [data-queue-subagents]").length,
        chatFooterBottom: getComputedStyle(chatFooter).paddingBottom,
      }
    })

    const inset = await measure()
    assert.deepEqual([inset.lineTop, inset.top, inset.right, inset.bottom, inset.left], [0, 32, 12, 12, 12])
    assert.deepEqual(inset.counts, ["2 agents", "1 terminal"], "the drawer counts its ops the way the queue card does")
    assert.equal(inset.hangingRows, 0, "no ops rows are drawn in the footer until the counts are hovered")
    // The chat footer carries the device's bottom inset now that no lifecycle footer sits under it — 0px
    // on a desktop screen, so the bar's own 12px stays the whole inset there.
    assert.equal(inset.chatFooterBottom, "0px")

    // Hover opens the rows, the drawer's own, in a panel above the count that names them — the agents'
    // rows over "2 agents", the shell's over "1 terminal", and neither panel holds the other's.
    const AGENTS = ["Trace the layout regression in the drawer", "Exercise desktop and narrow viewport behavior"]
    const SHELLS = ["Watch the production fixture build"]
    await page.hover('[data-queue-ops-summary] [data-ops-count="agent"]')
    await page.waitForSelector('[data-queue-ops-panel="agent"] [data-queue-subagents]')
    const agents = await page.$eval('[data-queue-ops-panel="agent"]', (el) => (el as HTMLElement).innerText)
    for (const row of AGENTS) assert.ok(agents.includes(row), `the agents panel lists "${row}"`)
    for (const row of SHELLS) assert.ok(!agents.includes(row), `the agents panel does not list the shell "${row}"`)
    await page.hover('[data-queue-ops-summary] [data-ops-count="terminal"]')
    await page.waitForSelector('[data-queue-ops-panel="terminal"] [data-background-ops]')
    await page.waitForFunction(() => !document.querySelector('[data-queue-ops-panel="agent"]'))
    const shells = await page.$eval('[data-queue-ops-panel="terminal"]', (el) => (el as HTMLElement).innerText)
    for (const row of SHELLS) assert.ok(shells.includes(row), `the shells panel lists "${row}"`)
    for (const row of AGENTS) assert.ok(!shells.includes(row), `the shells panel does not list the agent "${row}"`)

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
