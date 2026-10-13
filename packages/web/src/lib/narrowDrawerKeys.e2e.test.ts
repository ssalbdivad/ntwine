import assert from "node:assert/strict"
import test from "node:test"
import type { Page } from "puppeteer"

// NTWINE_NARROW_DRAWER_KEYS_E2E_URL=<vite origin> — `nub run test:e2e` sets it.
const baseUrl = process.env.NTWINE_NARROW_DRAWER_KEYS_E2E_URL

// At 800px and below a thread drawer is a MODAL Radix dialog: it wears `aria-modal` and pins the body's
// pointer events, which were exactly the keyboard runtime's two tells for "an overlay is open". So in a
// half-width laptop window every plain key (j/k, d, s, r, f) died the moment a thread was opened, while
// the same drawer at 1200px took them all (found 2026-09-29). The drawer is the page being read, not an
// overlay; a real dialog raised over it still is, and must still swallow the keys — the negative control.

type Probe = { landed: string[]; done: number; ariaModal: string | null; bodyLocked: boolean }

const probe = (page: Page) =>
  page.evaluate((): Probe => {
    const fixture = (window as unknown as { __narrowDrawerKeys: { landed: () => string[] } }).__narrowDrawerKeys
    return {
      landed: fixture.landed(),
      done: Number(document.body.dataset.doneClicks ?? 0),
      ariaModal: document.querySelector("[data-drawer-layer]")?.getAttribute("aria-modal") ?? null,
      bodyLocked: document.body.style.pointerEvents === "none",
    }
  })

async function press(page: Page, key: string) {
  await page.keyboard.press(key)
  await new Promise((resolve) => setTimeout(resolve, 150))
}

test("plain keys reach an open thread drawer at every width, and a real dialog over it still takes them", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const errors: string[] = []
  try {
    for (const width of [1200, 700]) {
      const page = await browser.newPage()
      page.on("pageerror", (error) => errors.push(String(error)))
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()) })
      await page.setViewport({ width, height: 900 })
      await page.goto(`${baseUrl}/narrow-drawer-keys-fixture.html`, { waitUntil: "networkidle0" })
      await page.waitForSelector("[data-drawer-layer]")
      // The drawer's own "Mark as done", as far as `d` can tell: the runtime presses whichever
      // `data-command="done"` control the top drawer layer holds.
      await page.evaluate(() => {
        const button = document.createElement("button")
        button.dataset.command = "done"
        button.addEventListener("click", () => { document.body.dataset.doneClicks = String(Number(document.body.dataset.doneClicks ?? 0) + 1) })
        document.querySelector("[data-drawer-layer]")!.append(button)
      })

      // The case under test is the MODAL drawer, so prove the fixture actually produced one — a fixture
      // that drifted into a non-modal sheet would pass this test without exercising the bug.
      const start = await probe(page)
      const narrow = width <= 800
      assert.equal(start.ariaModal, narrow ? "true" : null, `${width}px: drawer aria-modal`)
      assert.equal(start.bodyLocked, narrow, `${width}px: Radix body pointer lock`)

      await press(page, "j")
      await press(page, "d")
      const after = await probe(page)
      assert.deepEqual(after.landed, ["card-b"], `${width}px: j must step the queue cursor with a drawer open`)
      assert.equal(after.done, 1, `${width}px: d must press the drawer's own done control`)

      if (narrow) {
        // Negative control: a genuine modal over the modal drawer. Same body lock, same drawer — only the
        // dialog differs, and it alone must make the keys inert.
        await page.evaluate(() => (window as unknown as { __narrowDrawerKeys: { openDialog: () => void } }).__narrowDrawerKeys.openDialog())
        await page.waitForSelector('[role="dialog"][aria-modal="true"]:not([data-drawer-layer])')
        await press(page, "j")
        await press(page, "d")
        const covered = await probe(page)
        assert.deepEqual(covered.landed, ["card-b"], "j must do nothing under a dialog")
        assert.equal(covered.done, 1, "d must do nothing under a dialog")
      }
      await page.close()
    }
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
