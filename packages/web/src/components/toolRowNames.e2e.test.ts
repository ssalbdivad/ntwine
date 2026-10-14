import assert from "node:assert/strict"
import test from "node:test"

const baseUrl = process.env.NTWINE_TOOL_ROW_NAMES_E2E_URL

// A tool card's accessible name says what the row says — kind, subject, reading — and never whether it
// is open (toolRowName in ChatView.tsx). Read from the browser's own accessibility tree, not from the
// attribute, because the name is what a screen reader announces: an `aria-label` on the header button
// REPLACES its contents, so a reading drawn inside it but left out of the label never reached one. A
// failed Bash was announced exactly like the one that passed.
test("a tool card is named by what it says, its outcome included, and toggling it leaves the name alone", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1000, height: 1500, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/operation-indicators-fixture.html`, { waitUntil: "networkidle0" })

    const names = async () => {
      const tree = await page.accessibility.snapshot({ interestingOnly: true })
      const out: { name: string; expanded?: boolean }[] = []
      const walk = (node: { role?: string; name?: string; expanded?: boolean; children?: unknown[] } | null) => {
        if (!node) return
        if (node.role === "button" && node.expanded !== undefined) out.push({ name: node.name ?? "", expanded: node.expanded })
        for (const child of node.children ?? []) walk(child as typeof node)
      }
      walk(tree)
      return out
    }

    const closed = await names()
    assert.ok(closed.length > 0, "the fixture renders disclosure controls")
    assert.deepEqual(closed.filter((c) => /^(Expand|Collapse)\b/.test(c.name)), [], "no name carries the open state")
    // The outcome rides the name, in the reading's own words.
    assert.ok(closed.some((c) => c.name === "Bash: Typecheck, exit 1 · 12s"), `a failed shell says it failed: ${JSON.stringify(closed.map((c) => c.name))}`)
    assert.ok(closed.some((c) => c.name === "Bash: Run the unit suite, done · 32s"), "a passing shell says it passed")
    assert.ok(closed.some((c) => c.name === "Agent dispatch: Crashed dependency sweep, sonnet › medium · Failed after 12m 18s"), "a failed dispatch says it failed")

    // Toggle the failed shell open: the state moves, the name does not.
    await page.evaluate(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((b) => b.getAttribute("aria-label") === "Bash: Typecheck, exit 1 · 12s")
      button!.click()
    })
    const open = await names()
    const failed = open.filter((c) => c.name === "Bash: Typecheck, exit 1 · 12s")
    assert.deepEqual(failed.map((c) => c.expanded), [true], "the same name, now expanded")
  } finally {
    await browser.close()
  }
})
