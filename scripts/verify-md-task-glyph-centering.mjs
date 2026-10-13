// OPTICAL CENTERING OF THE GLYPH INSIDE EACH `.md-task` BOX.
//
// The box's own placement beside the text is a different measurement (that one aligns the box's ink to
// the prose cap band, and lives in the fixture's ink probe). This asserts the OTHER half, which is what
// a reader actually sees as "the tick is off-centre in its checkbox": where the INNER mark's ink sits
// inside the box's interior.
//
// It has to be a PIXEL measurement. Every inner mark here is invisible to DOM geometry — a mask-image's
// ink is wherever the lucide path falls inside its 24-unit viewBox (lucide's `Check` is NOT centred: its
// ink spans y 4.5..18.5, centre 11.5, so `mask-position: center` centres the VIEWBOX and leaves the ink
// riding high), and a text `?` has font metrics that no rect reports. `getBoundingClientRect` returns
// the same numbers whether the glyph is centred or hard against an edge.
//
// Method: render each state large, make the BORDER transparent so only the inner mark paints, screenshot
// the element at high deviceScaleFactor, and take the ink bounding box of what is left. The element's
// own centre is the reference — the border is symmetric, so the border box's centre IS the interior's.
//
// WHY IT MEASURES AT A BIG BOX RATHER THAN THE SHIPPED 14px. Everything in the CSS is a fraction of
// `--md-task-box`, so a genuine misalignment normalises to the SAME number at every size. Measured
// across 14 / 28 / 56 / 160px, the residual instead HALVES as the box doubles — a fixed count of device
// pixels, i.e. rasterisation of a fractionally-positioned mask, not a geometry error. Reading the 14px
// number as truth would send you chasing a 0.5px "error" that does not exist in the CSS; the large box
// is where one device pixel is a small fraction of the mark. The `__calibration__` row guards the rest:
// it is centred by construction, so if IT does not measure centred, the instrument is off and the run
// fails rather than quietly subtracting a bogus offset.
//
// Usage: nub scripts/verify-md-task-glyph-centering.mjs --url=http://localhost:5412/markdown-task-fixture.html
import { mkdirSync } from "node:fs"
import { join } from "node:path"

const args = process.argv.slice(2)
const opt = (k, d) => { const hit = args.find((a) => a.startsWith(`--${k}=`)); return hit ? hit.slice(k.length + 3) : d }
const url = opt("url", "http://localhost:5412/markdown-task-fixture.html")
const shots = opt("shots")
// Big, so one CSS pixel of error is many device pixels and the centroid is not quantisation noise.
const SIZE = Number(opt("size", "160"))
const DSF = Number(opt("dsf", "4"))
// Sub-pixel at the shipped 14px box is invisible; the gate is expressed against the SHIPPED size.
const SHIPPED_BOX = 14
const TOL_SHIPPED_PX = 0.15

const STATES = [
  { cls: "md-task-checked", name: "[x] checked  (lucide Check)" },
  { cls: "md-task-in-progress", name: "[/] in progress (dot)" },
  { cls: "md-task-cancelled", name: "[-] cancelled (lucide X)" },
  { cls: "md-task-blocked", name: "[?] blocked  (sans '?')" },
]

const { launchHeadless } = await import("./lib/headless-browser.mjs")
const browser = await launchHeadless()
const failures = []
const rows = []
let bias = { dx: 0, dy: 0 }
try {
  const page = await browser.newPage()
  const pageErrors = []
  // The fixture HTML declares no favicon, so the browser asks for /favicon.ico and vite 404s it. That
  // is a property of every bare fixture page here, not of the thing under test.
  const isFaviconNoise = (t) => /favicon\.ico/.test(t) || /404 \(Not Found\)/.test(t)
  page.on("pageerror", (e) => pageErrors.push(String(e)))
  page.on("console", (m) => { if (m.type() === "error" && !isFaviconNoise(m.text())) pageErrors.push(m.text()) })
  page.on("requestfailed", (r) => { if (!isFaviconNoise(r.url())) pageErrors.push(`request failed: ${r.url()}`) })
  // Sized to the probe row, so nothing wraps or falls outside the viewport. An element that is not
  // fully in view screenshots unreliably, which is what made the calibration reference report a bogus
  // 2px bias at large sizes — and a bogus bias silently poisons every row it is subtracted from.
  const probeW = (SIZE + 40) * (STATES.length + 1) + 120
  await page.setViewport({ width: Math.max(900, probeW), height: SIZE + 220, deviceScaleFactor: DSF })
  await page.goto(url, { waitUntil: "networkidle0", timeout: 30_000 })
  await page.waitForSelector(".md-task", { timeout: 20_000 })

  // One isolated row per state at SIZE, on a flat surface. `--md-task-box` drives every internal
  // dimension, so blowing it up scales the real geometry rather than approximating it.
  await page.evaluate((size, states) => {
    document.body.innerHTML = ""
    document.body.style.cssText = "margin:0;background:#0d0e10"
    const host = document.createElement("div")
    host.className = "md-body"
    host.style.cssText = `padding:40px;background:#0d0e10;--md-task-box:${size}px`
    // `position: RELATIVE`, never static. The inner mark is an absolutely-positioned `::after` with
    // `inset: 0`, so a static span hands it the INITIAL containing block and the glyph renders against
    // the viewport instead of the box — the probe then screenshots an empty box and reports "no ink",
    // which reads exactly like a CSS bug. Relative reproduces the shipped containing block (the span's
    // own padding box) while letting the probe lay the boxes out in a row.
    // A CALIBRATION reference first: a mark centred by CONSTRUCTION (`inset:0; margin:auto`), so any
    // offset reported for it is the instrument's own bias, not the CSS's. Without it the probe reads a
    // fixed ~4-device-pixel capture offset as a real error — which normalises to 0.5px at a 14px box
    // and 0.04px at 160px, i.e. it looks like a genuine misalignment that mysteriously improves with
    // size. Every measurement below is reported net of this.
    host.innerHTML = `<span data-probe="__calibration__" style="position:relative;display:inline-block;margin:20px;width:${size}px;height:${size}px;border:${Math.max(1, size / 15)}px solid transparent;box-sizing:border-box"
        ><i style="position:absolute;inset:0;margin:auto;width:${size * 0.4}px;height:${size * 0.4}px;background:#8b8f96"></i></span>`
      + states.map((s) => `<span class="md-task ${s.cls}" data-probe="${s.cls}"
      style="position:relative;display:inline-block;margin:20px"></span>`).join("")
    document.body.appendChild(host)
  }, SIZE, STATES)
  await new Promise((r) => setTimeout(r, 250))

  for (const state of [{ cls: "__calibration__", name: "calibration (centred by construction)" }, ...STATES]) {
    const sel = `[data-probe="${state.cls}"]`
    // Hide the border so ONLY the inner mark paints. Its ink box is then unambiguous.
    await page.evaluate((s) => { document.querySelector(s).style.borderColor = "transparent" }, sel)
    await new Promise((r) => setTimeout(r, 80))
    const buf = await (await page.$(sel)).screenshot({ encoding: "base64" })
    await page.evaluate((s) => { document.querySelector(s).style.borderColor = "" }, sel)

    const ink = await page.evaluate(async (b64, dsf) => {
      const img = new Image()
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = `data:image/png;base64,${b64}` })
      const c = document.createElement("canvas")
      c.width = img.width; c.height = img.height
      const ctx = c.getContext("2d", { willReadFrequently: true })
      ctx.drawImage(img, 0, 0)
      const { data } = ctx.getImageData(0, 0, c.width, c.height)
      // The surface behind is the page background; anything that differs from the corner pixel is ink.
      const bg = [data[0], data[1], data[2]]
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4
          const d = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2])
          if (d < 24) continue // ignore antialias haze; a real mark is far brighter than this
          n++
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
      if (!n) return null
      return {
        boxW: c.width / dsf, boxH: c.height / dsf,
        inkL: minX / dsf, inkR: (maxX + 1) / dsf, inkT: minY / dsf, inkB: (maxY + 1) / dsf,
        // COVERAGE — the count of inked device pixels over the box's area. This is the OPTICAL WEIGHT
        // question, and the bounding box cannot answer it: a solid disc and an outlined tick can share
        // a bbox and read as completely different amounts of mark. Tone is deliberately not equalised
        // (the live states wear the accent); only the geometry is compared.
        coverage: n / (c.width * c.height),
      }
    }, buf, DSF)

    if (!ink) { failures.push(`${state.name}: no ink found`); continue }
    // POSITIVE dx = the mark sits LEFT of centre and must move RIGHT. POSITIVE dy = it sits ABOVE
    // centre and must move DOWN. Reported at the SHIPPED box size, which is what the eye judges.
    const rawDx = (ink.boxW / 2 - (ink.inkL + ink.inkR) / 2) * (SHIPPED_BOX / ink.boxW)
    const rawDy = (ink.boxH / 2 - (ink.inkT + ink.inkB) / 2) * (SHIPPED_BOX / ink.boxH)
    if (state.cls === "__calibration__") {
      bias = { dx: rawDx, dy: rawDy }
      console.log(`      calibration bias: right ${rawDx.toFixed(3)}px, down ${rawDy.toFixed(3)}px`)
      // A mark centred by construction must measure centred. If it does not, the INSTRUMENT is wrong
      // and every number after it is noise — say so instead of quietly subtracting a bogus offset.
      if (Math.max(Math.abs(rawDx), Math.abs(rawDy)) > 0.6) {
        failures.push(`instrument is unreliable at this size: the calibration reference, which is centred by construction, measured right ${rawDx.toFixed(2)}px / down ${rawDy.toFixed(2)}px`)
      }
      continue
    }
    const dx = rawDx - bias.dx
    const dy = rawDy - bias.dy
    const row = {
      glyph: state.name,
      inkW: +((ink.inkR - ink.inkL) / ink.boxW).toFixed(3),
      inkH: +((ink.inkB - ink.inkT) / ink.boxH).toFixed(3),
      coverage: +(ink.coverage * 100).toFixed(2),
      nudgeRightPx: +dx.toFixed(3),
      nudgeDownPx: +dy.toFixed(3),
    }
    rows.push(row)
    const worst = Math.max(Math.abs(dx), Math.abs(dy))
    console.log(`${worst <= TOL_SHIPPED_PX ? "PASS" : "FAIL"}  ${state.name.padEnd(30)} ink ${row.inkW}×${row.inkH}  cover ${String(row.coverage).padStart(5)}%  ·  right ${row.nudgeRightPx > 0 ? "+" : ""}${row.nudgeRightPx}px  down ${row.nudgeDownPx > 0 ? "+" : ""}${row.nudgeDownPx}px  (at a ${SHIPPED_BOX}px box)`)
    if (worst > TOL_SHIPPED_PX) failures.push(`${state.name} off by right ${row.nudgeRightPx}px / down ${row.nudgeDownPx}px`)
  }

  // OPTICAL BALANCE across the family. Four marks in one column must read as the same WEIGHT of mark,
  // or the column looks like a bug even when every glyph is perfectly centred. Compared as a spread
  // rather than an absolute, since what matters is that no one mark dominates its neighbours.
  const cov = rows.map((r) => r.coverage)
  const spread = Math.max(...cov) / Math.min(...cov)
  const heaviest = rows.reduce((a, b) => (a.coverage > b.coverage ? a : b))
  const lightest = rows.reduce((a, b) => (a.coverage < b.coverage ? a : b))
  console.log(`\n      weight spread ${spread.toFixed(2)}× — heaviest ${heaviest.glyph.trim()} ${heaviest.coverage}%, lightest ${lightest.glyph.trim()} ${lightest.coverage}%`)
  if (spread > 1.6) failures.push(`optical weight is unbalanced: ${spread.toFixed(2)}× between ${heaviest.glyph.trim()} and ${lightest.glyph.trim()}`)
  // ...and no mark may TOWER inside its box. Deliberately not a bbox-parity check between the marks:
  // a dot is legitimately compact next to a check, and forcing equal heights would blow the dot up.
  // The real constraint is that nothing crowds the box walls — the sidebar's glyphs sit at 10/15.
  const MAX_EXTENT = 0.62
  for (const r of rows) {
    if (Math.max(r.inkW, r.inkH) > MAX_EXTENT)
      failures.push(`${r.glyph.trim()} fills ${Math.max(r.inkW, r.inkH)} of its box (max ${MAX_EXTENT}) — it crowds the walls`)
  }
  console.log(`      largest extent ${Math.max(...rows.map((r) => Math.max(r.inkW, r.inkH))).toFixed(3)} of box (max ${MAX_EXTENT})`)

  if (shots) {
    mkdirSync(shots, { recursive: true })
    await (await page.$(".md-body")).screenshot({ path: join(shots, "md-task-glyph-centering.png") })
    console.log(`      shot → ${join(shots, "md-task-glyph-centering.png")}`)
  }
  if (pageErrors.length) failures.push(`console/page errors: ${pageErrors.join(" | ")}`)
} finally {
  await browser.close()
}

console.log(failures.length ? `\n${failures.length} FAILED:\n- ${failures.join("\n- ")}` : "\nevery mark is optically centred in its box")
process.exit(failures.length ? 1 : 0)
