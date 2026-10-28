import assert from "node:assert/strict"
import test from "node:test"

const baseUrl = process.env.NTWINE_TERMINAL_CONTROL_E2E_URL

// THE CONTROL BAR AT EVERY WIDTH, measured in a real browser — it is a layout rule, which a markup test cannot see.
// 2026-10-15, on a live stack: a shared `shrink-0` in the bar's button class outranked Hand back's own `min-w-0
// truncate`, so "Hand back to @<five-word handle>" stayed 592px wide, ran 222px past a 390px drawer, and
// squeezed "You're driving" to 0px; the agent side cut " is driving" off a long handle. So, on the terminals
// fixture (`?mode=control`: both states, a short and the longest handle, edge to edge):
//   1. nothing leaves the bar, and the bar never scrolls;
//   2. "You're driving", " is driving" and "Take control" are always whole — only a handle gives way;
//   3. the label and the button never touch;
//   4. a short handle is never cut, and the long one is cut at a phone width (so rule 2 was exercised).
//
// Run it against a plain vite over packages/web:
//   pnpm exec vite --port 5392 --strictPort --host 127.0.0.1
//   NTWINE_TERMINAL_CONTROL_E2E_URL=http://127.0.0.1:5392 node --test packages/web/src/components/terminalControlBar.e2e.test.ts
test("the terminal control bar keeps its words whole and its button inside, at every width", {
  skip: !baseUrl,
  timeout: 120_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const errors: string[] = []
  try {
    const page = await browser.newPage()
    page.on("pageerror", (e) => errors.push(String(e)))
    for (const width of [1400, 560, 390]) {
      await page.setViewport({ width, height: 600, deviceScaleFactor: 1 })
      await page.goto(`${baseUrl}/terminals-unified-fixture.html?mode=control`, { waitUntil: "networkidle0" })
      await page.evaluate(() => document.fonts.ready)
      const bars = await page.$$eval("[data-fixture-control]", (nodes) => nodes.map((holder) => {
        const name = holder.getAttribute("data-fixture-control")!
        const agent = name.endsWith("agent")
        const bar = holder.querySelector("[data-terminal-control]") as HTMLElement
        const button = bar.querySelector("button") as HTMLElement
        const label = bar.querySelector(":scope > span") as HTMLElement
        const cut = (el: HTMLElement) => el.scrollWidth > el.clientWidth + 0.5
        const b = bar.getBoundingClientRect(), btn = button.getBoundingClientRect(), lab = label.getBoundingClientRect()
        // The words that must stay whole, found by their TEXT so the check does not depend on the markup: the
        // painted box of " is driving" / "You're driving" must lie inside the label (which clips) and short of
        // the button.
        const textRect = (root: Element, words: string) => {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const at = n.textContent!.indexOf(words)
            if (at < 0) continue
            const range = document.createRange()
            range.setStart(n, at)
            range.setEnd(n, at + words.length)
            return range.getBoundingClientRect()
          }
          return null
        }
        const verb = textRect(label, agent ? "is driving" : "You're driving")
        const verbWhole = !!verb && verb.width > 0 && verb.right <= lab.right + 0.5 && verb.right <= btn.left
        // The handle's own box: the innermost element holding the `@`, which truncates.
        const holders = [...bar.querySelectorAll("*")].filter((el) => el.textContent!.includes("@")) as HTMLElement[]
        const handle = holders[holders.length - 1] ?? label
        return {
          name,
          text: bar.innerText,
          inside: btn.right <= b.right + 0.5 && lab.left >= b.left - 0.5,
          scrolls: bar.scrollWidth > bar.clientWidth + 0.5,
          wordsWhole: verbWhole && (!agent || !cut(button)),
          gap: btn.left - lab.right,
          handleCut: cut(handle),
        }
      }))
      assert.equal(bars.length, 4, `${width}px: the fixture drew every bar`)
      for (const bar of bars) {
        const at = `${width}px ${bar.name}: ${bar.text}`
        assert.ok(bar.inside && !bar.scrolls, `${at} — a part leaves the bar`)
        assert.ok(bar.wordsWhole, `${at} — a word that must stay whole is cut`)
        assert.ok(bar.gap >= 4, `${at} — the label and the button sit ${bar.gap}px apart`)
        if (bar.name.startsWith("short")) assert.ok(!bar.handleCut, `${at} — a short handle is cut`)
        if (width === 390 && bar.name.startsWith("long")) assert.ok(bar.handleCut, `${at} — the long handle fits at 390px, so nothing was tested`)
      }
    }
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
