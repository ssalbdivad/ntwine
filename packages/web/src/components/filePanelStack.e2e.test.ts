import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync } from "node:fs"

// Real server, real transcript, real file reads; only the absent launcher status probe is stubbed.
// Boot scripts/adhoc-stack.mjs, then scripts/seed-file-panel-stack.mjs --home=<its HOME>.
// NTWINE_FILE_STACK_E2E_URL=http://127.0.0.1:<port> nub --test <this file>
const baseUrl = process.env.NTWINE_FILE_STACK_E2E_URL
const shots = process.env.NTWINE_FILE_STACK_SHOTS

test("full-screen file links push readers and Escape restores the reader underneath", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(String(e)))
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
    await page.setRequestInterception(true)
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/_ntwine/control/status") {
        void r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ protocol: 1, state: "ready", updateRestart: false }) })
      } else void r.continue()
    })
    const slot = "[data-file-viewer-slot]"
    const top = `${slot}:last-child`
    const waitCount = async (count: number) => {
      await page.waitForFunction((count) => document.querySelectorAll("[data-file-viewer-slot]").length === count, {}, count)
      await page.waitForFunction(() => [...document.querySelectorAll("[data-file-viewer-slot]")].every((el) => el.getAnimations().length === 0 && getComputedStyle(el).translate === "0px"))
    }
    // The prose font is no longer a setting (index.html pins `data-font="sans"`, 2026-09-19), so the
    // run varies only the width.
    for (const width of [1440, 1200]) {
      await page.setViewport({ width, height: 900 })
      await page.goto(`${baseUrl}/thread/file-panel-stack/full`, { waitUntil: "networkidle2" })
      const firstLink = 'main[data-standalone-thread] [data-local-path$="/first.md"]'
      await page.waitForSelector(firstLink)
      await page.click(firstLink)
      await waitCount(1)
      await page.waitForSelector(`${top} .md-body [data-local-path]`)
      const original = await page.$(slot)
      const threadWidth = await page.$eval("main[data-standalone-thread]", (el) => el.getBoundingClientRect().width)
      // Mark the original DOM node and scroll to its final link. Returning must preserve both.
      const scroll = await page.$eval(`${top} .overflow-y-auto`, (el) => { el.scrollTop = el.scrollHeight; return el.scrollTop })
      assert.ok(scroll > 0)
      await original!.evaluate((el) => { el.dataset.originalReader = "true" })
      await page.evaluate(() => {
        (window as any).fileSlides = []
        document.addEventListener("transitionrun", (event) => {
          if ((event.target as Element).matches("[data-file-viewer-slot]") && event.propertyName === "translate") {
            (window as any).fileSlides.push(event.target)
          }
        })
      })
      await page.click(`${top} .md-body p:last-child [data-local-path]`)
      await waitCount(2)
      assert.equal(await page.evaluate(() => (window as any).fileSlides.length), 1, "the nested reader actually slides, not just swaps content")
      await page.waitForSelector(`${top} [data-local-path$="/first.md"]`)
      assert.equal(await page.$eval(slot, (el) => el.inert), true)
      assert.equal(await page.$eval("main[data-standalone-thread]", (el) => el.getBoundingClientRect().width), threadWidth)
      await page.click(`${top} [data-local-path$="/first.md"]`)
      await waitCount(3)
      assert.equal(await page.$eval(`${top} .overflow-y-auto`, (el) => el.scrollTop), 0, "revisits start a fresh reader")
      await page.keyboard.press("Escape")
      await waitCount(2)
      await page.click(`${top} [data-local-path$="/example.ts"]`)
      await waitCount(3)
      await page.waitForFunction(() => document.querySelector('[data-file-viewer-slot]:last-child pre')?.textContent?.includes("stacked"))
      await page.click(`${top} button[aria-label="Close"]`)
      await waitCount(2)
      // A mounted reader below must not intercept or duplicate the top reader's selection shortcut.
      await page.$eval(`${top} .md-body p:last-child`, (el) => {
        const range = document.createRange(); range.selectNodeContents(el)
        window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
      })
      await page.keyboard.down("Control"); await page.keyboard.press("i"); await page.keyboard.up("Control")
      assert.equal(await page.evaluate(async () => {
        // Staged under the thread's follow-up DRAFT key (lib/stagedContext.ts), which names its slug.
        const path = "/src/lib/stagedContext.ts"; const { stagedContext } = await import(path)
        return Object.entries(stagedContext as Record<string, unknown[]>).filter(([key]) => key.includes(":file-panel-stack:")).flatMap(([, items]) => items).length
      }), 1)
      await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
      // Source mode stays alive while another visit covers it.
      await page.click(`${top} [aria-label="File view"] button:last-child`)
      await page.click(firstLink)
      await waitCount(3)
      await page.keyboard.press("Escape")
      await waitCount(2)
      assert.equal(await page.$eval(`${top} [aria-label="File view"] button:last-child`, (el) => el.getAttribute("aria-pressed")), "true")
      if (shots) {
        mkdirSync(shots, { recursive: true })
        await page.screenshot({ path: `${shots}/file-stack-${width}.png` })
      }
      await page.keyboard.press("Escape")
      await waitCount(1)
      assert.equal(await original!.evaluate((el) => el.isConnected && el.dataset.originalReader === "true"), true)
      assert.equal(await page.$eval(`${top} .overflow-y-auto`, (el) => el.scrollTop), scroll)
      assert.equal(await page.$eval(top, (el) => el.inert), false)
      // Shrinking uses the existing Markdown drawers without destroying the hidden split stack.
      await page.setViewport({ width: 390, height: 844 })
      await page.click(firstLink)
      await page.waitForSelector(".ntwine-sheet-panel .md-body [data-local-path]")
      await page.waitForFunction(() => [...document.querySelectorAll(".ntwine-sheet-panel")].every((el) => el.classList.contains("translate-x-0") && el.getAnimations().length === 0))
      await page.click('.ntwine-sheet-panel [data-local-path$="/second.md"]')
      await page.waitForFunction(() => document.querySelectorAll(".ntwine-sheet-panel").length === 2)
      await page.keyboard.press("Escape")
      await page.waitForFunction(() => document.querySelectorAll(".ntwine-sheet-panel").length === 1)
      if (shots) await page.screenshot({ path: `${shots}/file-stack-narrow-${width}.png` })
      await page.keyboard.press("Escape")
      await page.waitForFunction(() => !document.querySelector(".ntwine-sheet-panel"))
      assert.equal(await page.$$eval(slot, (els) => els.length), 1, "drawers unwind before split readers")
      await page.setViewport({ width, height: 900 })
      await page.keyboard.press("Escape")
      await waitCount(0)
      assert.equal(await page.$eval("[data-side-pane] > div", (el) => el.inert), false)
    }
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }])
    await page.click('main[data-standalone-thread] [data-local-path$="/first.md"]')
    await waitCount(1)
    await page.click(`${top} [data-local-path$="/second.md"]`)
    await waitCount(2)
    assert.equal(await page.$eval(top, (el) => getComputedStyle(el).transitionProperty), "none")
    await page.keyboard.press("Escape")
    await waitCount(1)
    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle2" })
    assert.equal(await page.evaluate(async () => {
      const path = "/src/store.ts"; const { store } = await import(path)
      return store.filePanels.length
    }), 0, "leaving full screen clears the file stack")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
