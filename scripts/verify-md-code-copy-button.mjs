// OPTICAL CENTERING AND WEIGHT OF THE GLYPH INSIDE THE FENCED-CODE COPY BUTTON (`.md-code-copy`).
//
// The button's PLACEMENT in the code block's corner is plain DOM geometry and is asserted by the
// behavioural e2e (packages/web/src/lib/copyCodeBlock.e2e.test.ts, which also drives the real click and
// the real clipboard). What no rect can see is the part a reader actually judges: where the glyph's INK
// sits inside the chip, and whether the check that replaces it on copy reads as the same weight of mark.
//
// Both glyphs are mask-images, so their ink is wherever the lucide path falls inside its 24-unit viewBox
// — lucide's `Check` is NOT centred there (its ink spans y 4.5..18.5, centre 11.5), which is why the
// stylesheet ships it on a `0 -0.5 24 24` viewBox. `getBoundingClientRect` returns the same numbers
// whether that correction is present or not, so this has to be a PIXEL measurement.
//
// Method, and the traps, are the same as scripts/verify-md-task-glyph-centering.mjs — read that file's
// header for the full reasoning. In short: render the button huge (every internal dimension is a
// fraction of `--md-copy-box`, so blowing it up scales the real geometry rather than approximating it),
// make the chip's border and background transparent so only the glyph paints, screenshot at a high
// deviceScaleFactor, and take the ink bounding box. A `__calibration__` mark that is centred by
// CONSTRUCTION goes first: if IT does not measure centred, the instrument is off and the run fails
// rather than quietly subtracting a bogus bias.
//
// Usage:
//   cd packages/web && nubx vite --port 5731 --strictPort
//   nub scripts/verify-md-code-copy-button.mjs --url=http://localhost:5731/syntax-highlighting-fixture.html
import { mkdirSync } from "node:fs"
import { join } from "node:path"

const args = process.argv.slice(2)
const opt = (k, d) => { const hit = args.find((a) => a.startsWith(`--${k}=`)); return hit ? hit.slice(k.length + 3) : d }
const url = opt("url", "http://localhost:5731/syntax-highlighting-fixture.html")
const shots = opt("shots")
const SIZE = Number(opt("size", "160"))
const DSF = Number(opt("dsf", "4"))
// The shipped chip is 1.7em on 14px prose. Sub-pixel error there is invisible, so the gate is expressed
// against that size rather than against the blown-up probe.
const SHIPPED_BOX = 23.8
const TOL_SHIPPED_PX = 0.15
// Two states, one button: the resting icon and the check that confirms the copy. A wider spread than
// this and the confirmation reads as a lighter, different-sized mark than the thing it replaced.
//
// GATED ON PERCEIVED INK, NOT INK AREA, and that is a real difference here: a bare pixel count reads
// 2.80× between these two, because a single-polyline tick simply cannot lay down the area an outlined
// two-sheet icon does. Chasing that number with the pen alone would put the check at stroke ~3.9 —
// chunkier than any other glyph in the app. What actually closes the gap is the TONE step the states
// already carry (muted → fg), which is deliberate and is what the eye integrates; weighting each pixel
// by how far it rose above the chip reads 1.53×. The task-mark family compares raw area instead
// (verify-md-task-glyph-centering.mjs) because its four marks sit in ONE COLUMN at once, all in their
// own tones — a simultaneous comparison, where tone is a variable rather than part of the mark. These
// two are never on screen together.
const MAX_WEIGHT_SPREAD = 1.6

const STATES = [
  { cls: "", name: "resting (lucide Copy)" },
  { cls: "is-copied", name: "copied  (lucide Check)" },
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
  await page.setViewport({ width: (SIZE + 40) * 3 + 200, height: SIZE + 200, deviceScaleFactor: DSF })
  await page.goto(url, { waitUntil: "networkidle0", timeout: 30_000 })
  await page.waitForSelector(".md-code-copy", { timeout: 20_000 })

  await page.evaluate((size, states) => {
    document.body.innerHTML = ""
    document.body.style.cssText = "margin:0;background:#0d0e10"
    const host = document.createElement("div")
    host.className = "md-body"
    host.style.cssText = `padding:40px;background:#0d0e10`
    // The shipped button is `position: absolute` inside `.md-code`; laid out inline here it would take
    // the initial containing block and its `inset: 0` ::after would render against the viewport, which
    // reads exactly like "the glyph vanished". `position: relative` restores the shipped containing
    // block (the button's own padding box) while letting the probe lay the states out in a row.
    // `opacity` is forced because the shipped button is hover-revealed and nothing here hovers.
    const probeStyle = `position:relative;display:inline-block;margin:20px;opacity:1;--md-copy-box:${size}px`
    host.innerHTML = `<span data-probe="__calibration__" style="${probeStyle};width:${size}px;height:${size}px;box-sizing:border-box"
        ><i style="position:absolute;inset:0;margin:auto;width:${size * 0.4}px;height:${size * 0.4}px;background:#8b8f96"></i></span>`
      + states.map((s) => `<button type="button" class="md-code-copy ${s.cls}" data-probe="${s.cls || "resting"}" style="${probeStyle}"></button>`).join("")
    document.body.appendChild(host)
  }, SIZE, STATES)
  await new Promise((r) => setTimeout(r, 250))

  for (const state of [{ cls: "__calibration__", name: "calibration (centred by construction)" }, ...STATES]) {
    const sel = `[data-probe="${state.cls === "__calibration__" ? "__calibration__" : state.cls || "resting"}"]`
    // Hide the chip so ONLY the glyph paints; its ink box is then unambiguous.
    await page.evaluate((s) => {
      const el = document.querySelector(s)
      el.style.borderColor = "transparent"
      el.style.background = "transparent"
    }, sel)
    await new Promise((r) => setTimeout(r, 80))
    const buf = await (await page.$(sel)).screenshot({ encoding: "base64" })

    const ink = await page.evaluate(async (b64, dsf) => {
      const img = new Image()
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = `data:image/png;base64,${b64}` })
      const c = document.createElement("canvas")
      c.width = img.width; c.height = img.height
      const ctx = c.getContext("2d", { willReadFrequently: true })
      ctx.drawImage(img, 0, 0)
      const { data } = ctx.getImageData(0, 0, c.width, c.height)
      const bg = [data[0], data[1], data[2]]
      const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b
      const bgLum = lum(bg[0], bg[1], bg[2])
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0, perceived = 0
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          const i = (y * c.width + x) * 4
          const d = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2])
          if (d < 24) continue // antialias haze; a real mark is far brighter than this
          n++
          perceived += Math.min(1, Math.max(0, (lum(data[i], data[i + 1], data[i + 2]) - bgLum) / (255 - bgLum)))
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
        // Two answers to the optical-WEIGHT question a bounding box cannot answer at all (an outlined
        // two-sheet icon and a single-polyline tick can share a bbox and read as very different amounts
        // of mark). `area` is the raw inked fraction; `perceived` weights each pixel by how far it rose
        // above the chip, so the states' deliberate tone step counts as the mark it is. See the gate.
        area: n / (c.width * c.height),
        perceived: perceived / (c.width * c.height),
      }
    }, buf, DSF)

    await page.evaluate((s) => {
      const el = document.querySelector(s)
      el.style.borderColor = ""
      el.style.background = ""
    }, sel)

    if (!ink) { failures.push(`${state.name}: no ink found`); continue }
    // POSITIVE dx = the mark sits LEFT of centre and must move RIGHT; positive dy = it sits ABOVE
    // centre and must move DOWN. Reported at the SHIPPED chip size, which is what the eye judges.
    const rawDx = (ink.boxW / 2 - (ink.inkL + ink.inkR) / 2) * (SHIPPED_BOX / ink.boxW)
    const rawDy = (ink.boxH / 2 - (ink.inkT + ink.inkB) / 2) * (SHIPPED_BOX / ink.boxH)
    if (state.cls === "__calibration__") {
      bias = { dx: rawDx, dy: rawDy }
      console.log(`      calibration bias: right ${rawDx.toFixed(3)}px, down ${rawDy.toFixed(3)}px`)
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
      area: +(ink.area * 100).toFixed(2),
      perceived: +(ink.perceived * 100).toFixed(2),
      nudgeRightPx: +dx.toFixed(3),
      nudgeDownPx: +dy.toFixed(3),
    }
    rows.push(row)
    const worst = Math.max(Math.abs(dx), Math.abs(dy))
    console.log(`${worst <= TOL_SHIPPED_PX ? "PASS" : "FAIL"}  ${state.name.padEnd(24)} ink ${row.inkW}×${row.inkH}  area ${String(row.area).padStart(5)}%  perceived ${String(row.perceived).padStart(5)}%  ·  right ${row.nudgeRightPx > 0 ? "+" : ""}${row.nudgeRightPx}px  down ${row.nudgeDownPx > 0 ? "+" : ""}${row.nudgeDownPx}px  (at a ${SHIPPED_BOX}px chip)`)
    if (worst > TOL_SHIPPED_PX) failures.push(`${state.name} off by right ${row.nudgeRightPx}px / down ${row.nudgeDownPx}px`)
  }

  if (rows.length === STATES.length) {
    const spreadOf = (key) => Math.max(...rows.map((r) => r[key])) / Math.min(...rows.map((r) => r[key]))
    const spread = spreadOf("perceived")
    console.log(`\n      perceived weight spread ${spread.toFixed(2)}× — resting ${rows[0].perceived}%, copied ${rows[1].perceived}% (max ${MAX_WEIGHT_SPREAD}×)`)
    console.log(`      raw ink AREA spread ${spreadOf("area").toFixed(2)}× — reported, not gated: see MAX_WEIGHT_SPREAD`)
    if (spread > MAX_WEIGHT_SPREAD)
      failures.push(`the copied check reads as a different weight of mark: ${spread.toFixed(2)}× perceived spread against the resting icon`)
  }

  if (shots) {
    mkdirSync(shots, { recursive: true })
    await (await page.$(".md-body")).screenshot({ path: join(shots, "md-code-copy-glyphs.png") })
    console.log(`      shot → ${join(shots, "md-code-copy-glyphs.png")}`)
  }
  if (pageErrors.length) failures.push(`console/page errors: ${pageErrors.join(" | ")}`)
} finally {
  await browser.close()
}

console.log(failures.length ? `\n${failures.length} FAILED:\n- ${failures.join("\n- ")}` : "\nboth copy-button glyphs are optically centred and evenly weighted")
if (failures.length) process.exitCode = 1
