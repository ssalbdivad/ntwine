import assert from "node:assert/strict"
import test from "node:test"

// FRIZZ_PHONE_BAND_TABS_E2E_URL=<vite origin> — `nub run test:e2e` sets it.
const baseUrl = process.env.FRIZZ_PHONE_BAND_TABS_E2E_URL

// The phone page's band tabs (PhonePage.tsx BandTabs). With a question waiting, 15 queued and a schedule,
// the Queue tab broke "Queue 1 · 15" across two lines and the strip ran 4px off a 390px screen (QA
// 2026-10-06), because the tabs shrank and the gaps were sized for counts one digit shorter. The
// contract, at every phone width and every count: a tab is ONE line; the gaps give way first, equally,
// from 22px to 10; past that the strip scrolls sideways rather than leaving a tab off-screen; and the
// selected tab is scrolled fully into view. Geometry, so a real browser at real widths, sans.
const WIDTHS = [360, 390, 430]
const CASES = ["usual", "qa", "worst"]
const MARGIN = 18

test("a phone's band tabs never wrap, never run off-screen, and bring the selected tab into view", {
  skip: !baseUrl,
  timeout: 90_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()) })
  page.on("pageerror", (error) => errors.push(String(error)))

  const read = (id: string) => page.$eval(`[data-case="${id}"]`, (block) => {
    const strip = block.querySelector<HTMLElement>("[role=tablist]")!
    const border = strip.parentElement!.getBoundingClientRect()
    const box = strip.getBoundingClientRect()
    return {
      strip: { left: box.left, right: box.right, clientWidth: strip.clientWidth, scrollWidth: strip.scrollWidth, scrollLeft: strip.scrollLeft, clientHeight: strip.clientHeight, scrollHeight: strip.scrollHeight, offsetHeight: strip.offsetHeight, overflowX: getComputedStyle(strip).overflowX, borderBottom: border.bottom },
      tabs: [...strip.querySelectorAll<HTMLElement>("[data-mobile-tab]")].map((tab) => {
        const rect = tab.getBoundingClientRect()
        const face = tab.querySelector<HTMLElement>(".grid > :last-child")!
        return {
          band: tab.dataset.mobileTab!,
          selected: tab.getAttribute("aria-selected") === "true",
          left: rect.left,
          right: rect.right,
          bottom: rect.bottom,
          faceHeight: face.getBoundingClientRect().height,
          lineHeight: parseFloat(getComputedStyle(face).lineHeight),
          parts: [...face.children].map((part) => (part as HTMLElement).getClientRects().length),
        }
      }),
    }
  })
  const click = (id: string, band: string) => page.$eval(`[data-case="${id}"] [data-mobile-tab="${band}"]`, (tab) => (tab as HTMLElement).click())

  try {
    for (const width of WIDTHS) {
      await page.setViewport({ width, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
      await page.goto(`${baseUrl}/phone-band-tabs-fixture.html`, { waitUntil: "networkidle0" })
      await page.waitForSelector('[data-case="worst"] [data-mobile-tab="schedules"]')
      await page.evaluate(() => document.fonts.ready)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `${width}px: nothing may widen the page past the screen`)

      for (const id of CASES) {
        const at = `${id} @ ${width}px`
        const { strip, tabs } = await read(id)
        for (const tab of tabs) {
          // A pixel over one line is the baseline-aligned 12.5px count beside the 14.5px label; two lines is 40.
          assert.ok(tab.faceHeight < tab.lineHeight * 1.5, `${at}: the ${tab.band} tab's label and count must sit on ONE line (face ${tab.faceHeight}px, line ${tab.lineHeight}px)`)
          assert.ok(tab.parts.every((rects) => rects === 1), `${at}: no part of the ${tab.band} tab may break across lines (${tab.parts})`)
          // The underline overlaps the strip's bottom border by its own pixel, as it did before the strip scrolled.
          assert.ok(Math.abs(tab.bottom - strip.borderBottom) < 0.5, `${at}: the ${tab.band} tab must reach the strip's bottom border (${tab.bottom} vs ${strip.borderBottom})`)
        }
        const gaps = tabs.slice(1).map((tab, index) => tab.left - tabs[index]!.right)
        for (const gap of gaps) assert.ok(gap > 9.99 && gap < 22.01, `${at}: a gap between tabs stays within 10-22px (${gaps})`)
        assert.ok(Math.max(...gaps) - Math.min(...gaps) < 0.1, `${at}: the gaps give way equally (${gaps})`)
        assert.equal(strip.clientHeight, strip.scrollHeight, `${at}: the strip never scrolls vertically`)
        assert.equal(strip.offsetHeight, strip.clientHeight, `${at}: the strip draws no scrollbar`)
        const fits = strip.scrollWidth <= strip.clientWidth
        if (fits) {
          assert.ok(tabs.at(-1)!.right <= strip.right - MARGIN + 0.5, `${at}: a strip that fits keeps its ${MARGIN}px margin`)
        } else {
          // It only scrolls once every gap is at its floor, and then nothing is out of reach.
          for (const gap of gaps) assert.ok(Math.abs(gap - 10) < 0.01, `${at}: the strip scrolls only once the gaps are at 10px (${gaps})`)
          assert.equal(strip.overflowX, "auto", `${at}: a strip wider than the screen scrolls`)
        }
      }

      // The everyday counts never come near the floor: their gaps are the full 22px at every width.
      const usual = (await read("usual")).tabs
      assert.deepEqual(usual.slice(1).map((tab, index) => Math.round((tab.left - usual[index]!.right) * 100) / 100), [22, 22], `${width}px: everyday counts keep 22px gaps`)

      // Two-digit counts everywhere are wider than a 390px phone: the strip scrolls there, and selecting the
      // tab past the edge brings it fully into view with its margin, and the first tab brings the strip home.
      if (width <= 390) {
        assert.ok((await read("worst")).strip.scrollWidth > width, `${width}px: the worst counts overflow a ${width}px strip (the case under test)`)
        await click("worst", "schedules")
        const scrolled = await read("worst")
        const schedules = scrolled.tabs.find((tab) => tab.band === "schedules")!
        assert.ok(schedules.selected, "the tab clicked is the one selected")
        assert.ok(scrolled.strip.scrollLeft > 0, `${width}px: selecting the tab past the edge scrolls the strip`)
        assert.ok(schedules.right <= scrolled.strip.right - MARGIN + 0.5 && schedules.left >= scrolled.strip.left, `${width}px: the selected tab is fully in view, its margin with it (${schedules.left}-${schedules.right})`)
        await click("worst", "queue")
        assert.equal((await read("worst")).strip.scrollLeft, 0, `${width}px: selecting the first tab scrolls the strip back to its start`)
      }
    }
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
