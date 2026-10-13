import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

// A file dragged ANYWHERE onto a queue card goes into that card's prompt box (lib/fileDrop). Skipped
// unless a Vite URL serving the fixtures is provided: start `vite` in packages/web and set
// NTWINE_QUEUE_CARD_FILE_DROP_E2E_URL to its origin (or run `nub run test:e2e`). Drives the queue-card
// fixture's two real cross-project queue cards (AllQueuesCard; upstream drove its board's TodosView cards). The drags are Chrome's OWN drag pipeline (CDP Input.dispatchDragEvent
// with a real file path, the way a Finder drag arrives), not synthetic DOM events, so the browser decides
// which element is under the pointer and what `relatedTarget` a dragleave carries. Only the /attach upload
// is stubbed: it answers with a path named after the file, which is all the chip reads.
const baseUrl = process.env.NTWINE_QUEUE_CARD_FILE_DROP_E2E_URL

// The fixture's cards belong to the `fixture-card` project (lib/allQueues.ts threadKey).
const card = (slug: string) => `[data-xq-card="fixture-card/${slug}"] [data-xq-card-root]`
const chipSel = (slug: string) => `${card(slug)} [data-composer-box] button[aria-label^="Remove "]`

test("a file dropped anywhere on a queue card attaches to that card's prompt box, once", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "queue-card-file-drop-"))
  const png = join(dir, "screenshot.png")
  const txt = join(dir, "notes.txt")
  writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64"))
  writeFileSync(txt, "notes\n")
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
    const errors: string[] = []
    page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
    page.on("pageerror", (e) => errors.push(String(e)))
    // Installed before the fixture's own fetch stub, which falls through to it for anything not an RPC.
    await page.evaluateOnNewDocument(() => {
      const fallthrough = window.fetch
      window.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : (input as Request).url ?? input.toString()
        if (!/\/_ntwine\/(?:[^/]+\/)?attach$/.test(new URL(url, location.href).pathname)) return fallthrough(input, init)
        const { name } = JSON.parse(String(init?.body)) as { name: string }
        return new Response(JSON.stringify({ path: `/fixture/uploads/${name}` }), { headers: { "content-type": "application/json" } })
      }
    })
    await page.goto(`${baseUrl}/queue-card-states-fixture.html`, { waitUntil: "networkidle0" })
    await page.waitForSelector(`${card("rotate-key")} [data-composer-box]`)
    await page.waitForSelector(`${card("flaky-ci")} [data-composer-box]`)

    const files = (paths: string[]) => ({ items: [], files: paths, dragOperationsMask: 1 })
    const state = (slug: string) => page.$eval(card(slug), (el) => {
      const box = el.querySelector("[data-composer-box]")
      return { hint: box?.textContent?.includes("Drop file to attach") ?? false, boxDashed: box ? getComputedStyle(box).borderTopStyle === "dashed" : false }
    })
    const chips = (slug: string) => page.$$eval(chipSel(slug), (els) => els.map((e) => e.getAttribute("aria-label")))

    // The card's HEADER — as far from its prompt box as the card goes.
    const header = await page.$eval(card("rotate-key"), (el) => {
      const r = el.getBoundingClientRect()
      return { x: r.left + 80, y: r.top + 24 }
    })
    await page.mouse.dragEnter(header, files([png]))
    await page.mouse.dragOver(header, files([png]))
    await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.includes("Drop file to attach"), { timeout: 5000 }, `${card("rotate-key")} [data-composer-box]`)
    assert.deepEqual(await state("rotate-key"), { hint: true, boxDashed: true }, "the hovered card's prompt box shows where the file will go")
    assert.deepEqual(await state("flaky-ci"), { hint: false, boxDashed: false }, "no other card claims the file")

    // Off every card: the hover ends.
    await page.mouse.dragOver({ x: 20, y: header.y }, files([png]))
    await page.waitForFunction((sel) => !document.querySelector(sel)?.textContent?.includes("Drop file to attach"), { timeout: 5000 }, `${card("rotate-key")} [data-composer-box]`)

    // Back onto the header, and drop.
    const urlBefore = page.url()
    await page.mouse.dragOver(header, files([png]))
    await page.mouse.drop(header, files([png]))
    await page.waitForSelector(chipSel("rotate-key"))
    assert.deepEqual(await chips("rotate-key"), ["Remove screenshot.png"])
    assert.deepEqual(await chips("flaky-ci"), [])
    assert.equal(page.url(), urlBefore, "the browser did not open the dropped file in place of the app")
    assert.deepEqual(await state("rotate-key"), { hint: false, boxDashed: false }, "the hint clears on drop")

    // A drop ON the prompt box is still one upload, not one from the box and another from the card.
    const box = await page.$eval(`${card("rotate-key")} [data-composer-box]`, (el) => {
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + 16 }
    })
    await page.mouse.dragEnter(box, files([txt]))
    await page.mouse.dragOver(box, files([txt]))
    await page.mouse.drop(box, files([txt]))
    await page.waitForFunction((sel) => document.querySelectorAll(sel).length >= 2, { timeout: 5000 }, chipSel("rotate-key"))
    await new Promise((r) => setTimeout(r, 300))
    assert.deepEqual(await chips("rotate-key"), ["Remove screenshot.png", "Remove notes.txt"])

    // A COLLAPSED card has no prompt box: the drop opens it, and the box takes the file as it mounts.
    await page.$eval(card("flaky-ci"), (el) => el.scrollIntoView({ block: "center" }))
    await page.click(`${card("flaky-ci")} button[data-xq-collapse]`)
    await page.waitForFunction((sel) => !document.querySelector(sel), { timeout: 5000 }, `${card("flaky-ci")} [data-composer-box]`)
    const collapsed = await page.$eval(card("flaky-ci"), (el) => {
      const r = el.getBoundingClientRect()
      return { x: r.left + 80, y: r.top + r.height / 2 }
    })
    await page.mouse.dragEnter(collapsed, files([png]))
    await page.mouse.dragOver(collapsed, files([png]))
    await page.mouse.drop(collapsed, files([png]))
    await page.waitForSelector(chipSel("flaky-ci"))
    assert.deepEqual(await chips("flaky-ci"), ["Remove screenshot.png"])

    assert.deepEqual(errors, [], "no console/page errors during the flow")
  } finally {
    await browser.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
