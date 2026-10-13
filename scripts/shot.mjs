// Headless screenshot + in-page evaluate loop for iterating on the frizz UI.
// It drives puppeteer's own headless shell through `launchHeadless()` (lib/headless-browser.mjs): no
// window, no Dock tile, a temp profile, never the installed Chrome, and a page that sees a dark system.
// This is the visual-review loop: screenshot + evaluate_script routines
// (occlusion/clip/alignment/optical-center) against the live app.
//
// Usage:
//   nub scripts/shot.mjs <url> [out.png] [evalExprOr@file] [--before=exprOr@file] [--hover=<css selector>]
//     [--mouse] [--light] [--w=1440] [--h=900] [--wait=1500] [--clip=<css selector>] [--pad=8] [--dsf=2]
//   evalExpr: a JS expression string evaluated in page context (completion value → printed as JSON).
//   @file:    read the expression from a file (e.g. an occlusion routine).
//   --hover:  park the pointer on that element (after --before, before the shot), so a surface that
//             reveals on CSS :hover — a rail row's action strip — is photographed as the eye sees it.
//             No in-page expression can enter that state; only a real pointer can. Implies --mouse.
//   --hover-wait=<ms>: rest the pointer this long after --hover before shooting, for a delayed tooltip.
//   --mouse:  render as a desktop with a mouse — `(hover: hover)`, fine pointer — instead of headless
//             Chrome's touch screen (lib/mouse-pointer.mjs). Without it every Tailwind hover: style is
//             dead and the app's `(hover: none)` touch rules apply.
//   --light:  render with `prefers-color-scheme: light`. The launcher pins dark otherwise, the theme the
//             app follows by default on the maintainer's machine; `--dark` is accepted and is the default.
//   --clip:   shoot only that element's box (+ --pad px of margin) instead of the viewport, and --dsf
//             raises the device pixel ratio — together they make a 27px row judgeable without zooming
//             the page (a `zoom`/`transform` hack reflows this app's centered layout and moves the very
//             thing you were trying to photograph off-screen).
import { readFileSync } from "node:fs"
import { launchHeadless } from "./lib/headless-browser.mjs"

const args = process.argv.slice(2)
const pos = args.filter((a) => !a.startsWith("--"))
// Split on the FIRST "=" only. A --clip selector ([data-x="y"]) and an inline --before expression both
// carry their own "=", and a naive split("=") silently truncated the value to everything before it —
// so the flag became a no-op and the run produced a confident, wrong screenshot rather than an error.
const flags = Object.fromEntries(args.filter((a) => a.startsWith("--")).map((a) => { const s = a.replace(/^--/, ""); const i = s.indexOf("="); return i < 0 ? [s, true] : [s.slice(0, i), s.slice(i + 1)] }))
const [url, out, evalArg] = pos
const W = Number(flags.w) || 1440
const H = Number(flags.h) || 900
const WAIT = Number(flags.wait) || 1500

if (!url) {
  console.error("usage: nub shot.mjs <url> [out.png] [evalExprOr@file] [--w=] [--h=] [--wait=]")
  process.exit(1)
}

// protocolTimeout: puppeteer's default is 180s, and `Page.captureScreenshot` blows straight through it
// on a busy machine — this repo regularly has a dozen agents compiling at once (measured at load
// average 159, where a single 390×844 dsf-2 shot of a page with backdrop-blur could not rasterize in
// three minutes). The failure arrives as a bare ProtocolError that reads like a bug in the page.
const browser = await launchHeadless({
  colorScheme: flags.light ? "light" : "dark",
  mouse: Boolean(flags.hover || flags.mouse),
  protocolTimeout: 600_000,
})
try {
  const page = await browser.newPage()
  await page.setViewport({ width: W, height: H, deviceScaleFactor: Number(flags.dsf) || 2 })
  const errors = []
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 })
  await new Promise((r) => setTimeout(r, WAIT)) // let the SSE board render
  if (flags.before) {
    const expr = flags.before.startsWith("@") ? readFileSync(flags.before.slice(1), "utf8") : flags.before
    await page.evaluate(expr)
  }
  if (flags.hover) await page.hover(flags.hover)
  // A tip that opens on a hover DELAY (the rail row's status) needs the pointer to rest before the shot.
  if (flags.hover && flags["hover-wait"]) await new Promise((r) => setTimeout(r, Number(flags["hover-wait"])))
  if (out) {
    const clip = flags.clip
      ? await page.evaluate((sel, pad) => {
          const el = document.querySelector(sel)
          if (!el) return null
          const r = el.getBoundingClientRect()
          return { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + pad * 2, height: r.height + pad * 2 }
        }, flags.clip, Number(flags.pad) || 8)
      : null
    if (flags.clip && !clip) console.error(`clip selector matched nothing: ${flags.clip}`)
    await page.screenshot({ path: out, fullPage: false, ...(clip ? { clip } : {}) })
    console.error("shot ->", out)
  }
  if (evalArg) {
    const expr = evalArg.startsWith("@") ? readFileSync(evalArg.slice(1), "utf8") : evalArg
    const res = await page.evaluate(expr)
    console.log(JSON.stringify(res, null, 2))
  }
  if (errors.length) console.error("PAGE ERRORS:\n" + errors.join("\n"))
} finally {
  await browser.close()
}
