// Real-browser verification of the Update/Restart FAILURE panel, driven over a REAL seeded board.
//
// The defect this pins: the panel used to be `bg-red-500/10` — a 10%-opaque tint hanging off the
// top-left status bar — so the sidebar thread list and the dispatch composer read straight through the
// failure text (maintainer, 2026-08-01: "these translucent error messages look insane"). A computed
// `backgroundColor` alone would not catch a regression that reintroduced translucency further up the
// tree, so the decisive check is a PIXEL test: a saturated magenta sheet is painted behind the panel
// and the panel's own pixels must contain none of it.
//
// The supervisor is reached only over HTTP, so the failure state is produced by intercepting
// `/_frizz/control/status` — the app's REAL polling path, its REAL store transition and the REAL
// component render. Nothing about the panel is stubbed.
//
// Usage: node scripts/verify-restart-failure-panel.mjs --base=http://127.0.0.1:4967/
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { launchHeadless } from "./lib/headless-browser.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const BASE = flags.base ?? process.env.BASE ?? "http://127.0.0.1:4967/"
const OUT = join(tmpdir(), "frizz-restart-failure")
mkdirSync(OUT, { recursive: true })

// The maintainer's actual failure, verbatim from the screenshot — the shape the panel must survive.
const SUPERVISOR_LOG = [
  "Command failed: nub run typecheck from /Users/colinmcd94/.frizz/builds/.source-snapshot-31038-bc7e214d-e24a-48b4-8ce6-1e084df7ecca",
  "> @frizz/web@0.0.1 typecheck /Users/colinmcd94/.frizz/builds/.source-snapshot-31038-bc7e214d-e24a-48b4-8ce6-1e084df7ecca/packages/web",
  "> tsc --noEmit",
  "src/groups.ts(440,27): error TS2304: Cannot find name 'restedQueueHandoff'.",
  "/Users/colinmcd94/.frizz/builds/.source-snapshot-31038-bc7e214d-e24a-48b4-8ce6-1e084df7ecca/packages/web:",
  "ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @frizz/web@0.0.1 typecheck: `tsc --noEmit` Exit status 2",
  "$ tsc -b packages/shared packages/rpc packages/server . && pnpm --filter @frizz/web typecheck",
].join("\n")

const results = []
const fail = (m) => { console.log("FAIL:", m); results.push(false) }
const pass = (m) => { console.log("pass:", m); results.push(true) }

const json = (body) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) })

// ---- 3. ink alignment of the icons beside their text ------------------------------------------
// Judged against the popover this card mirrors, not against a threshold picked out of the air: the
// popover's chip+heading row is the shipped pattern, so the notice is correct exactly when it lands
// on the same number. The absolute cap-band offset is printed too — if the shipped row were itself
// off, both would have to move together.
const measureChipRow = (rootSelector) => {
  const baselineOfTextNode = (node) => {
    const span = document.createElement("span")
    node.parentNode.insertBefore(span, node)
    span.appendChild(node)
    span.style.whiteSpace = "nowrap"
    const probe = document.createElement("span")
    probe.style.cssText = "display:inline-block;width:0;height:0;padding:0;margin:0;border:0"
    span.appendChild(probe)
    const baseline = probe.getBoundingClientRect().bottom
    const cs = getComputedStyle(span)
    const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} / ${cs.lineHeight} ${cs.fontFamily}`
    probe.remove()
    span.parentNode.insertBefore(node, span)
    span.remove()
    return { baseline, font }
  }
  // Beside PROSE the reference is the string-independent cap band, not the string's own ink box.
  const capBand = (font, baseline) => {
    const c = document.createElement("canvas").getContext("2d")
    c.font = font
    return { top: baseline - c.measureText("H").actualBoundingBoxAscent, bottom: baseline }
  }
  const inkOfSvg = (svg) => {
    const rects = [...svg.querySelectorAll("path,rect,circle,ellipse,polyline,polygon,line")].map((g) => g.getBoundingClientRect())
    return { top: Math.min(...rects.map((r) => r.top)), bottom: Math.max(...rects.map((r) => r.bottom)) }
  }
  const mid = (o) => (o.top + o.bottom) / 2

  const panel = document.querySelector(rootSelector)
  const heading = [...panel.querySelectorAll("span")].find((s) => s.textContent.trim() && !s.querySelector("svg") && !s.hasAttribute("aria-hidden"))
  const textNode = [...heading.childNodes].find((n) => n.nodeType === 3 && /\S/.test(n.textContent))
  const { baseline, font } = baselineOfTextNode(textNode)
  const band = capBand(font, baseline)
  const chipSvg = panel.querySelector("span svg")
  const chip = chipSvg.closest("span")
  const chipBox = chip.getBoundingClientRect()
  const headBox = heading.getBoundingClientRect()
  const dismiss = panel.querySelector('[aria-label="Dismiss"]')
  const dismissBox = dismiss?.getBoundingClientRect()
  const g = inkOfSvg(chipSvg)
  return {
    headingText: textNode.textContent.trim(),
    font,
    chipSize: `${Math.round(chipBox.width)}×${Math.round(chipBox.height)}`,
    // The chip is a BOX centred on the flex line, so what matters is its centre against the text's
    // cap band — the glyph is already centred inside the chip by the chip's own flexbox.
    chipBoxOffset: +(mid(band) - (chipBox.top + chipBox.height / 2)).toFixed(2),
    glyphInsideChip: +((chipBox.top + chipBox.height / 2) - mid(g)).toFixed(2),
    glyphInkHeight: +(g.bottom - g.top).toFixed(2),
    dismissOffset: dismissBox ? +((headBox.top + headBox.height / 2) - (dismissBox.top + dismissBox.height / 2)).toFixed(2) : null,
    dismissInside: dismissBox ? dismissBox.right <= panel.getBoundingClientRect().right - 1 : null,
    headTone: getComputedStyle(heading).color,
  }
}

const browser = await launchHeadless()
try {
  const page = await browser.newPage()
  const errors = []
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("favicon")) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))

  // `failed` flips only after the click, so the button first has to see a healthy updatable supervisor.
  let supervisorFailed = false
  await page.setRequestInterception(true)
  page.on("request", (req) => {
    const path = new URL(req.url()).pathname
    if (path === "/_frizz/control/status") {
      return void req.respond(json(
        supervisorFailed
          ? { protocol: 1, state: "failed", message: SUPERVISOR_LOG }
          : { protocol: 1, state: "ready", updateRestart: true },
      ))
    }
    // Accept the POST the way the real supervisor does — it takes the job, then fails while building.
    if (path === "/_frizz/control/update-restart") {
      supervisorFailed = true
      return void req.respond(json({ protocol: 1, state: "restarting" }))
    }
    void req.continue()
  })

  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 })
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 })
  await page.waitForSelector('[aria-label="Update Frizz"]', { timeout: 30000 })
  // Let the seeded board paint behind the panel — an empty board cannot show a bleed-through.
  await page.waitForSelector("[data-sidebar-item]", { timeout: 30000 })
  await new Promise((r) => setTimeout(r, 1200))
  const behind = await page.$$eval("[data-sidebar-item]", (els) => els.length)
  if (behind >= 3) pass(`${behind} seeded threads are painted behind the panel's anchor`)
  else fail(`only ${behind} threads on the board — not a fair bleed-through test`)
  await page.screenshot({ path: join(OUT, "00-board-before.png") })

  // Baseline the SHIPPED popover's chip+heading row first (a real hover — React's enter/leave can't be
  // faked with dispatchEvent). The failure card mirrors this row, so this is the number it must match.
  const reload = await page.$('[aria-label="Update Frizz"]')
  await reload.hover()
  await page.waitForSelector("#update-restart-popover", { timeout: 10000 })
  await new Promise((r) => setTimeout(r, 300))
  const popoverInk = await page.evaluate(measureChipRow, "#update-restart-popover")
  await page.screenshot({ path: join(OUT, "00b-popover-baseline.png"), clip: { x: 0, y: 0, width: 560, height: 260 } })

  await page.click('[aria-label="Update Frizz"]')
  await page.waitForSelector('[role="alert"]', { timeout: 20000 })
  await page.mouse.move(1200, 500)
  await new Promise((r) => setTimeout(r, 600))

  // ---- 1. the panel is OPAQUE -------------------------------------------------------------------
  const surface = await page.$eval('[role="alert"]', (el) => {
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    return {
      background: cs.backgroundColor,
      opacity: cs.opacity,
      box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) },
      text: el.innerText.replace(/\n/g, " · ").slice(0, 120),
    }
  })
  console.log("surface:", JSON.stringify(surface))
  const alpha = surface.background.startsWith("rgba") ? Number(surface.background.match(/([\d.]+)\)$/)?.[1] ?? "1") : 1
  if (alpha === 1 && surface.opacity === "1") pass(`the panel fill is fully opaque (${surface.background})`)
  else fail(`the panel is translucent: background=${surface.background} opacity=${surface.opacity}`)

  // The decisive test, and the only one that actually answers "is it see-through": paint a saturated
  // sheet BEHIND the panel (z-10, under the status bar's z-20) and photograph the panel's interior
  // against TWO different backdrops. `elementFromPoint` is NOT this test — a translucent panel is
  // still the topmost hit target, so hit-testing proves z-order and says nothing about opacity.
  // Identical bytes across two maximally different backdrops proves zero contribution from behind,
  // without having to assume which colour a bleed would produce.
  const paintSheet = async (color) => {
    await page.evaluate((c) => {
      let el = document.getElementById("opacity-probe-sheet")
      if (!el) {
        el = document.createElement("div")
        el.id = "opacity-probe-sheet"
        el.style.cssText = "position:fixed;inset:0;z-index:10"
        document.body.appendChild(el)
      }
      el.style.background = c
    }, color)
    await new Promise((r) => setTimeout(r, 300))
  }
  const inset = 4
  const clip = { x: surface.box.x + inset, y: surface.box.y + inset, width: surface.box.w - inset * 2, height: surface.box.h - inset * 2 }

  await paintSheet("#ff00ff")
  const onMagenta = await page.screenshot({ clip, encoding: "base64" })
  await page.screenshot({ path: join(OUT, "01-opacity-probe-magenta.png") })
  await paintSheet("#00ff00")
  const onGreen = await page.screenshot({ clip, encoding: "base64" })
  await page.screenshot({ path: join(OUT, "01-opacity-probe-green.png") })

  if (onMagenta === onGreen) {
    pass("the panel's interior is byte-identical over a magenta and a green backdrop — nothing behind it contributes a single pixel")
  } else {
    // Quantify the leak rather than just reporting a mismatch: decode both shots in-page and count.
    const diff = await page.evaluate(async ([a, b]) => {
      const decode = async (data) => {
        const img = new Image()
        img.src = `data:image/png;base64,${data}`
        await img.decode()
        const c = document.createElement("canvas")
        c.width = img.width
        c.height = img.height
        const ctx = c.getContext("2d")
        ctx.drawImage(img, 0, 0)
        return ctx.getImageData(0, 0, c.width, c.height).data
      }
      const [pa, pb] = [await decode(a), await decode(b)]
      let differing = 0
      let worst = 0
      for (let i = 0; i < pa.length; i += 4) {
        const d = Math.max(Math.abs(pa[i] - pb[i]), Math.abs(pa[i + 1] - pb[i + 1]), Math.abs(pa[i + 2] - pb[i + 2]))
        if (d > 2) differing++
        worst = Math.max(worst, d)
      }
      return { differing, total: pa.length / 4, worst }
    }, [onMagenta, onGreen])
    fail(`the backdrop bleeds through: ${diff.differing}/${diff.total} interior pixels change with it (worst channel delta ${diff.worst})`)
  }

  // Independently: no pixel of the panel's interior may be anywhere near the magenta behind it.
  await paintSheet("#ff00ff")
  const magentaPixels = await page.evaluate(async (data) => {
    const img = new Image()
    img.src = `data:image/png;base64,${data}`
    await img.decode()
    const c = document.createElement("canvas")
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext("2d")
    ctx.drawImage(img, 0, 0)
    const px = ctx.getImageData(0, 0, c.width, c.height).data
    let magentaish = 0
    for (let i = 0; i < px.length; i += 4) {
      // Any pull toward #ff00ff: red and blue both lifted well clear of green.
      if (px[i] > 90 && px[i + 2] > 90 && px[i + 1] < px[i] - 40 && px[i + 1] < px[i + 2] - 40) magentaish++
    }
    return { magentaish, total: px.length / 4 }
  }, onMagenta)
  if (magentaPixels.magentaish === 0) pass(`none of the ${magentaPixels.total} interior pixels carry the magenta behind the card`)
  else fail(`${magentaPixels.magentaish}/${magentaPixels.total} interior pixels are tinted by the sheet behind the card`)

  await page.evaluate(() => document.getElementById("opacity-probe-sheet")?.remove())
  await new Promise((r) => setTimeout(r, 200))

  // ---- 1b. the toast announcing the same failure is a STRIP, not a second wall of log ------------
  // The first desktop shot of the fixed panel caught this one: App's failure toast pasted the whole
  // supervisor message in, so a strip stretched the full 1440px viewport and four lines deep beneath
  // the panel that was already showing the same text properly.
  const toast = await page.$eval("[data-toast]", (el) => {
    const r = el.getBoundingClientRect()
    return {
      w: Math.round(r.width),
      h: Math.round(r.height),
      right: Math.round(r.right),
      viewport: window.innerWidth,
      text: el.innerText.replace(/\n/g, " · "),
    }
  }).catch(() => null)
  if (!toast) fail("no failure toast was raised at all")
  else {
    console.log("toast:", JSON.stringify(toast))
    if (toast.w <= 480 && toast.w < toast.viewport - 100) pass(`the failure toast stays a ${toast.w}px strip on a ${toast.viewport}px viewport`)
    else fail(`the failure toast spans the viewport: ${toast.w}px of ${toast.viewport}px`)
    if (toast.h <= 44) pass(`the toast stays ${toast.h}px — one line, not a panel`)
    else fail(`the toast grew to ${toast.h}px: "${toast.text}"`)
    if (!/\.frizz\/builds|ERR_PNPM|tsc --noEmit/.test(toast.text)) pass(`the toast announces the failure without re-pasting the build log ("${toast.text}")`)
    else fail(`the toast is dumping the supervisor's raw log: "${toast.text}"`)
  }

  // ---- 2. the log is contained ------------------------------------------------------------------
  const log = await page.$eval('[role="alert"] pre', (el) => {
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    return {
      family: cs.fontFamily.split(",")[0],
      maxHeight: cs.maxHeight,
      overflowY: cs.overflowY,
      h: Math.round(r.height),
      scrollH: el.scrollHeight,
      overflowsX: el.scrollWidth > el.clientWidth + 1,
      hasTsError: el.textContent.includes("error TS2304"),
      // A clipped last line only reads as "scroll me" if a scrollbar is actually painted; styles.css
      // forces a 7px inner scrollbar with a stable gutter, so the gutter must really be reserved here.
      gutterPx: Math.round(el.offsetWidth - el.clientWidth - 2),
      // The one line that says what BROKE has to be readable without scrolling.
      errorLineVisible: (() => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        const range = document.createRange()
        const node = walker.nextNode()
        if (!node) return false
        const idx = node.textContent.indexOf("error TS2304")
        if (idx < 0) return false
        range.setStart(node, idx)
        range.setEnd(node, idx + 12)
        const box = range.getBoundingClientRect()
        const view = el.getBoundingClientRect()
        return box.top >= view.top - 1 && box.bottom <= view.bottom + 1
      })(),
    }
  })
  console.log("log block:", JSON.stringify(log))
  // The cap must BIND (an unbounded block is the defect) while still fitting an ordinary failure —
  // Chrome paints no scrollbar thumb at rest here, so a fold that lands mid-glyph reads as broken.
  if (log.maxHeight === "256px" && log.overflowY === "auto") pass(`the log block is capped at ${log.maxHeight} and scrolls past it, so no supervisor output can stretch the card`)
  else fail(`the log block is not scroll-capped: ${JSON.stringify(log)}`)
  if (log.scrollH <= log.h + 1) pass(`this ordinary typecheck failure (${log.scrollH}px) lands inside the ${log.h}px box with no mid-glyph fold`)
  else fail(`an ordinary typecheck failure still overflows the box: ${log.scrollH}px of ${log.h}px`)
  if (!log.overflowsX) pass("long absolute paths wrap instead of overflowing horizontally")
  else fail("the log block overflows horizontally — long paths are not breaking")
  if (log.hasTsError) pass("the actionable `error TS2304` line is present in the log")
  else fail("the log block dropped the actual compiler error")
  if (log.errorLineVisible) pass("the `error TS2304` line — the one that says what broke — is readable without scrolling")
  else fail("the actionable compiler-error line sits below the scroll fold")
  if (log.gutterPx >= 6) pass(`the log block reserves its ${log.gutterPx}px scrollbar gutter permanently, so text never reflows when huge output makes it scroll`)
  else fail(`no scrollbar gutter on the log block (${log.gutterPx}px) — text will reflow the moment a scrollbar appears`)

  const viewportFits = surface.box.bottom < 900 && surface.box.x >= 0 && surface.box.w <= 560
  if (viewportFits) pass(`the card stays a fixed ${surface.box.w}×${surface.box.h} panel inside the viewport`)
  else fail(`the card escapes the viewport: ${JSON.stringify(surface.box)}`)

  await page.screenshot({ path: join(OUT, "02-failure-desktop.png") })
  // Frame the whole card with a little context, at a scale where the type is actually judgeable.
  await page.screenshot({
    path: join(OUT, "03-failure-closeup.png"),
    clip: { x: 0, y: 0, width: Math.min(1440, surface.box.x + surface.box.w + 40), height: surface.box.bottom + 40 },
  })

  const ink = await page.evaluate(measureChipRow, '[role="alert"]')
  console.log("ink · failure notice:", JSON.stringify(ink, null, 2))
  console.log("ink · shipped popover:", JSON.stringify(popoverInk, null, 2))

  const matchesShipped = Math.abs(ink.chipBoxOffset - popoverInk.chipBoxOffset) <= 0.2
  if (matchesShipped) pass(`the alert chip sits exactly where the shipped popover's chip sits (${ink.chipBoxOffset}px vs ${popoverInk.chipBoxOffset}px off the cap band)`)
  else fail(`the alert chip row diverges from the popover it mirrors: ${ink.chipBoxOffset}px vs ${popoverInk.chipBoxOffset}px`)
  if (Math.abs(ink.chipBoxOffset) <= 1) pass(`the chip is optically centred on the heading's cap band (${ink.chipBoxOffset}px)`)
  else fail(`the chip rides off the heading's cap band by ${ink.chipBoxOffset}px — fix it in BOTH panels`)
  if (Math.abs(ink.glyphInsideChip) <= 0.6) pass(`the AlertTriangle ink is centred in its chip (${ink.glyphInsideChip}px)`)
  else fail(`the AlertTriangle ink is ${ink.glyphInsideChip}px off its chip's centre`)
  if (Math.abs(ink.dismissOffset) <= 0.6 && ink.dismissInside) pass(`the dismiss target shares the heading's line (${ink.dismissOffset}px) and stays inside the card`)
  else fail(`the dismiss target is misaligned or escapes the card: ${ink.dismissOffset}px inside=${ink.dismissInside}`)

  // ---- 4. narrow viewport -----------------------------------------------------------------------
  await page.setViewport({ width: 420, height: 780, deviceScaleFactor: 2 })
  await new Promise((r) => setTimeout(r, 600))
  const narrow = await page.$eval('[role="alert"]', (el) => {
    const r = el.getBoundingClientRect()
    const pre = el.querySelector("pre")
    return {
      x: Math.round(r.x), right: Math.round(r.right), bottom: Math.round(r.bottom), w: Math.round(r.width),
      viewport: window.innerWidth,
      bodyOverflows: document.documentElement.scrollWidth > window.innerWidth,
      preOverflowsX: pre.scrollWidth > pre.clientWidth + 1,
    }
  })
  console.log("narrow:", JSON.stringify(narrow))
  if (narrow.x >= 0 && narrow.right <= narrow.viewport && !narrow.bodyOverflows && !narrow.preOverflowsX) {
    pass(`narrow (420px): the card spans ${narrow.x}→${narrow.right} inside the viewport with no overflow`)
  } else fail(`narrow viewport broke the card: ${JSON.stringify(narrow)}`)
  await page.screenshot({ path: join(OUT, "04-failure-narrow.png") })

  // ---- 5. dismiss actually closes it, and a repeat "failed" poll cannot re-open it ---------------
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 })
  await new Promise((r) => setTimeout(r, 400))
  await page.click('[aria-label="Dismiss"]')
  // The supervisor keeps answering "failed"; the poll runs on an 8s rest cadence, so wait past one.
  await new Promise((r) => setTimeout(r, 9000))
  const stillGone = await page.$('[role="alert"]')
  if (!stillGone) pass("dismiss closes the panel and the next `failed` poll does not re-open it")
  else fail("the panel came back after dismiss — the poll is re-opening it")
  await page.screenshot({ path: join(OUT, "05-dismissed.png") })

  if (errors.length) fail(`console/page errors: ${errors.join(" | ")}`)
  else pass("no console or page errors")
} finally {
  await browser.close()
}

console.log(`\nshots in ${OUT}`)
const failed = results.filter((r) => !r).length
console.log(failed ? `${failed} CHECK(S) FAILED` : "ALL CHECKS PASSED")
process.exit(failed ? 1 : 0)
