import assert from "node:assert/strict"
import test from "node:test"

// Opt-in like the other *.e2e.test.ts here. Needs a REAL Ntwine with a project, so `/` is the page rather
// than the welcome, which one command builds:
//   nub scripts/adhoc-stack.mjs --port=45783 --project=/abs/repo > /tmp/stack.log 2>&1 &
//   NTWINE_FIRST_PAINT_E2E_URL=http://127.0.0.1:45783 nub --test --test-force-exit \
//     packages/web/src/App.firstPaint.e2e.test.ts
const baseUrl = process.env.NTWINE_FIRST_PAINT_E2E_URL

// THE FIRST FRAME IS THE FINAL LAYOUT, on a reload in a browser that has seen this machine before.
// Two things the page is built from arrive AFTER React's first render — the font and the project rail,
// both in `settingsGet` — and each used to be guessed at first and corrected a round trip later, moving
// everything on screen: the type family flipped mono → sans (a document-wide reflow), and the rail
// appeared and pushed the page 57px right (maintainer 2026-08-25: "This is layout shift"). The rail keeps
// its last answer in localStorage and uses it for the first frame; the font stopped being a setting on
// 2026-09-19 and is pinned sans on <html>. A requestAnimationFrame sampler installed before any script
// runs records every change to the two and to where the queue column (`#workpane`) sits, so the
// assertion is over the whole load rather than a screenshot of one moment. (The rail was removed on
// 2026-09-30 and this check with it; both came back with upstream's rail on 2026-10-06. It loads All
// projects, `/all`; the rail shows on a board the same way.)
//
// Until 2026-09-28 there was a third: whether the project's BOARD had a sidebar, from its first push,
// mirrored the same way — it pushed the workpane 269px right when it mounted late. The board went with
// the project view, and the one page's list column is always there, so there is nothing left to mirror.
//
// The CONTROL clears the mirrors: the same sampler must then SEE the rail arrive late and the
// workpane move, or the assertions above were passing on a sampler that could not observe a shift.
type Sample = { t: number; font: string | undefined; rail: boolean; workpaneLeft: number | null }

test("a reload paints the font and the project rail in their final state on the first frame", {
  skip: !baseUrl,
  timeout: 90_000,
}, async () => {
  const rpc = `${baseUrl}/_ntwine/rpc`
  const headers = { origin: baseUrl!, "content-type": "application/json" }
  const current = (await (await fetch(`${rpc}/settingsGet`, { headers })).json()) as { result: Record<string, unknown> }
  const set = async (patch: Record<string, unknown>) => {
    const r = await fetch(`${rpc}/settingsSet`, { method: "POST", headers, body: JSON.stringify({ ...current.result, ...patch }) })
    assert.equal(r.status, 200, `settingsSet must succeed: ${await r.text()}`)
  }
  await set({ projectRail: true })

  const { launchHeadless } = await import("../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(String(error)))
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
    await page.evaluateOnNewDocument(() => {
      const t0 = performance.now()
      const log: Sample[] = ((window as unknown as { __samples: Sample[] }).__samples = [])
      let last = ""
      const tick = () => {
        const wp = document.getElementById("workpane")?.getBoundingClientRect()
        const s: Sample = {
          t: Math.round(performance.now() - t0),
          font: document.documentElement.dataset.font,
          rail: document.querySelector('nav[aria-label="Projects"]') !== null,
          workpaneLeft: wp ? Math.round(wp.left) : null,
        }
        const key = JSON.stringify([s.font, s.rail, s.workpaneLeft])
        if (key !== last) { last = key; log.push(s) }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    const samples = () => page.evaluate(() => (window as unknown as { __samples: Sample[] }).__samples)
    const load = async () => {
      await page.goto(`${baseUrl}/all`, { waitUntil: "networkidle2" })
      await page.waitForSelector("#workpane", { timeout: 20_000 })
      await page.waitForSelector("[data-xq-project-row]", { timeout: 20_000 })
      await new Promise((r) => setTimeout(r, 500))
      return samples()
    }

    // The first load in a fresh profile is allowed to shift: it is what writes the mirrors.
    const first = await load()
    assert.ok(first.some((s) => s.workpaneLeft !== null), "the page rendered a workpane")
    const settledLeft = first.at(-1)!.workpaneLeft

    // The reload is the case: every sample is the final answer.
    const warm = await load()
    const painted = warm.filter((s) => s.workpaneLeft !== null)
    assert.ok(painted.length > 0, "the reload rendered a workpane")
    // `data-font` is pinned on the <html> tag since 2026-09-19 (the mono setting is gone), so it is
    // sans on every frame by construction; sampled anyway so a regression that reintroduces a
    // late-applied font shows up here.
    assert.deepEqual(new Set(warm.map((s) => s.font)), new Set(["sans"]), `the font never left sans: ${JSON.stringify(warm)}`)
    assert.deepEqual(new Set(painted.map((s) => s.workpaneLeft)), new Set([settledLeft]), `the workpane never moved: ${JSON.stringify(warm)}`)
    assert.equal(painted[0]!.rail, true, `the rail is on the first painted frame: ${JSON.stringify(warm)}`)

    // Old Mono settings and cache must not change the font. Clearing the rail's mirror
    // remains the negative control: the sampler must see the rail arrive and the workpane move.
    await set({ font: "mono", projectRail: true })
    await page.evaluate(() => { localStorage.clear(); localStorage.setItem("ntwine-font", "mono") })
    const control = await load()
    const controlPainted = control.filter((s) => s.workpaneLeft !== null)
    assert.deepEqual(new Set(control.map((s) => s.font)), new Set(["sans"]), `obsolete Mono settings cannot change the font: ${JSON.stringify(control)}`)
    assert.ok(new Set(controlPainted.map((s) => s.workpaneLeft)).size > 1, `the control saw the workpane move: ${JSON.stringify(control)}`)
    assert.equal(controlPainted[0]!.rail, false, `the control saw the rail arrive late: ${JSON.stringify(control)}`)

    assert.deepEqual(errors, [], "no page errors")
  } finally {
    await browser.close()
    await set({})
  }
})
