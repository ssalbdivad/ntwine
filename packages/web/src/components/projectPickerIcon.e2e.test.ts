import assert from "node:assert/strict"
import test from "node:test"

// Opt-in like the other *.e2e.test.ts here. Needs a REAL Frizz serving at least three projects that
// each have an icon (`public/icon.svg` is enough), which `scripts/adhoc-stack.mjs` builds in one command:
//   nub scripts/adhoc-stack.mjs --port=45782 --project=/abs/a --also-project=/abs/b --also-project=/abs/c > /tmp/stack.log 2>&1 &
//   FRIZZ_PICKER_ICON_E2E_URL=http://127.0.0.1:45782 nub --test --test-force-exit \
//     packages/web/src/components/projectPickerIcon.e2e.test.ts
const baseUrl = process.env.FRIZZ_PICKER_ICON_E2E_URL

// STEPPING THE PROMPT BOX'S PROJECT WITH ⌥↓ DRAWS EACH ICON ON THE FRAME IT ARRIVES. Every step re-keys
// the prompt box, so the picker pill's square is a fresh mount, and it used to start transparent and fade
// in on `onLoad` — a dark tile for the async decode plus a 150ms fade on every step, even with the bytes
// cached (reported 2026-09-30). Recorded per animation frame, because the defect lived between frames.
test("stepping the picker with ⌥↓ never paints a project's icon square empty", {
  skip: !baseUrl,
  timeout: 90_000,
}, async () => {
  const headers = { origin: baseUrl!, "content-type": "application/json" }
  const listed = (await (await fetch(`${baseUrl}/_frizz/rpc/projectsList`, { headers })).json()) as { result: Array<{ slug: string; home?: boolean; stale?: boolean }> }
  const slugs = listed.result.filter((p) => !p.home && !p.stale).map((p) => p.slug)
  assert.ok(slugs.length >= 3, `needs a stack serving ≥3 projects, saw: ${slugs.join(", ") || "none"}`)
  for (const slug of slugs) await fetch(`${baseUrl}/_frizz/${slug}/rpc/board`, { headers })

  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/all`, { waitUntil: "networkidle2" })
    await page.waitForSelector("[data-xq-project-picker] img", { timeout: 15_000 })
    const box = '[data-surface="newComposer"]'
    await page.waitForSelector(box, { visible: true, timeout: 15_000 })
    await page.focus(box)

    // Settle the first icon, then step through every project twice: the first lap is the one where a
    // project's icon has never been drawn in the pill, which is what the picker's warm-up covers.
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>("[data-xq-project-picker] img")
      return img?.complete && img.naturalWidth > 0 && getComputedStyle(img).opacity === "1"
    }, { timeout: 15_000 })
    for (let step = 0; step < slugs.length * 2; step++) {
      const before = await page.$eval("[data-xq-picker-name]", (el) => el.textContent)
      await page.evaluate(() => {
        const w = window as unknown as { __frames: Array<{ name: string | null; img: boolean; drawn: boolean; opacity: string }>; __stop: boolean }
        w.__frames = []
        w.__stop = false
        const tick = () => {
          const img = document.querySelector<HTMLImageElement>("[data-xq-project-picker] img")
          w.__frames.push({
            name: document.querySelector("[data-xq-picker-name]")?.textContent ?? null,
            img: !!img,
            drawn: !!img && img.complete && img.naturalWidth > 0,
            opacity: img ? getComputedStyle(img).opacity : "",
          })
          if (!w.__stop) requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      await page.keyboard.down("Alt")
      await page.keyboard.press("ArrowDown")
      await page.keyboard.up("Alt")
      await page.waitForFunction((b) => document.querySelector("[data-xq-picker-name]")?.textContent !== b, { timeout: 10_000 }, before)
      await new Promise((resolve) => setTimeout(resolve, 400))
      const frames = await page.evaluate(() => {
        const w = window as unknown as { __frames: Array<{ name: string | null; img: boolean; drawn: boolean; opacity: string }>; __stop: boolean }
        w.__stop = true
        return w.__frames
      })
      const after = frames.filter((f) => f.name !== before)
      assert.ok(after.length > 0, `step ${step}: no frame recorded after the switch`)
      const blank = after.filter((f) => !f.img || !f.drawn || f.opacity !== "1")
      assert.deepEqual(blank, [], `step ${step} (${before} → ${after[0]!.name}): ${blank.length} of ${after.length} frames drew the square without its icon`)
    }
  } finally {
    await browser.close()
  }
})
