import assert from "node:assert/strict"
import test from "node:test"

const baseUrl = process.env.FRIZZ_THREAD_CORDS_E2E_URL

// THE CORDS FOLLOW THE ROWS WHEN SOMETHING ABOVE THE RAIL GROWS (ThreadConnector.tsx `movers`).
//
// The bug this pins (2026-10-07): typing a schedule into the prompt box folds the schedule strip open under
// it, which pushes the whole rail down 51px — and the project cords stayed where they were, every crossing
// a strip's height off, sitting on the row icons, for as long as nothing unrelated re-measured. The strip
// mounts in one frame and grows over the next 200ms, and the connector re-measured on the mount, scrolls,
// window resizes and the COLUMNS' sizes — none of which change while a box inside a fixed-height column
// grows. So this shifts the rows with a pure transition: no scroll, no resize, and no mutation the
// connector watches (an inline style write), then checks the drawn geometry against the real icons.
//
// Read off what the connector actually drew, not off its inputs: the mask's cut-out per icon (each one
// `ICON_CLEAR` outside the icon's box) and the strands' segment ends, where the strand on top passes
// through each crossing uncut, halfway between two icon centres.
test("the project cords follow the rows when a box above the rail grows and shrinks", {
  skip: !baseUrl,
  timeout: 120_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless({ protocolTimeout: 30_000 })
  const errors: string[] = []
  const page = await browser.newPage()
  page.on("console", (message) => { if (message.type() === "error" && !message.text().includes("404")) errors.push(message.text()) })
  page.on("pageerror", (error) => errors.push(String(error)))

  const probe = () => {
    const icons: { top: number; centre: number }[] = []
    const crossings: number[] = []
    for (const project of document.querySelectorAll<HTMLElement>("[data-xq-rail] [data-xq-rail-project]")) {
      let centres: number[] = []
      for (const slot of project.querySelectorAll<HTMLElement>(":scope > * > [data-xq-indicator]")) {
        const b = (slot.firstElementChild ?? slot).getBoundingClientRect()
        icons.push({ top: b.top, centre: b.top + b.height / 2 })
        centres.push(b.top + b.height / 2)
      }
      for (let i = 1; i < centres.length; i++) crossings.push((centres[i - 1]! + centres[i]!) / 2)
      centres = []
    }
    const svg = document.querySelector("[data-thread-connector]")!
    const cutTops = [...(svg.querySelector("mask path")!.getAttribute("d") ?? "").matchAll(/M(-?[\d.]+) (-?[\d.]+)/g)].map((m) => Number(m[2]))
    const ends = [...svg.querySelectorAll("[data-thread-cords] path")].flatMap((p) =>
      (p.getAttribute("d") ?? "").split(/[MC]/).filter(Boolean).map((s) => s.trim().split(/[ ,]+/).map(Number)).flatMap((n) => [n[1]!, n[n.length - 1]!]),
    )
    const round = (n: number) => Math.round(n * 100) / 100
    return {
      railTop: round(document.querySelector("[data-xq-rail]")!.getBoundingClientRect().top),
      icons: icons.length,
      cuts: cutTops.length,
      crossings: crossings.length,
      // How far each icon's cut-out sits from the icon it is for: ICON_CLEAR (1.5) when it is where it belongs.
      cutError: round(Math.max(0, ...icons.map((ic, i) => Math.abs(ic.top - (cutTops[i] ?? Infinity) - 1.5)))),
      // How far the nearest strand end is from each crossing: 0 when every crossing sits between its icons.
      crossingError: round(Math.max(0, ...crossings.map((c) => Math.min(...ends.map((e) => Math.abs(e - c)))))),
    }
  }
  const slot = (rows: string) => page.evaluate((rows) => { document.querySelector<HTMLElement>("[data-fixture-slot]")!.style.gridTemplateRows = rows }, rows)
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  try {
    await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 2 })
    await page.goto(`${baseUrl}/thread-cords-fixture.html`, { waitUntil: "networkidle0" })
    await sleep(300)
    const rest = await page.evaluate(probe)
    // Two projects: a square and 3 rows, a square and 4 rows — 9 icons, 3 + 4 crossings.
    assert.equal(rest.icons, 9, "the fixture draws its rows")
    assert.equal(rest.cuts, 9, "every icon is cut out of the cords")
    assert.equal(rest.crossings, 7, "one crossing in each gap between two icons")
    assert.ok(rest.cutError < 0.5 && rest.crossingError < 0.5, `at rest the cords sit on the rows: ${JSON.stringify(rest)}`)

    await slot("1fr")
    // Mid-transition as well as after it: the cords follow it frame by frame, not only where it lands.
    await sleep(160)
    const moving = await page.evaluate(probe)
    await sleep(500)
    const open = await page.evaluate(probe)
    assert.ok(open.railTop - rest.railTop > 40, `the slot pushed the rail down (control): ${rest.railTop} -> ${open.railTop}`)
    assert.ok(moving.cutError < 0.5 && moving.crossingError < 0.5, `mid-transition the cords follow the rows: ${JSON.stringify(moving)}`)
    assert.ok(open.cutError < 0.5 && open.crossingError < 0.5, `with the slot open the cords sit on the rows: ${JSON.stringify(open)}`)

    await slot("0fr")
    await sleep(500)
    const closed = await page.evaluate(probe)
    assert.equal(closed.railTop, rest.railTop, "the slot folded away")
    assert.ok(closed.cutError < 0.5 && closed.crossingError < 0.5, `with the slot closed again the cords sit on the rows: ${JSON.stringify(closed)}`)

    assert.deepEqual(errors, [], "the fixture renders with no console or page errors")
  } finally {
    await browser.close()
  }
})
