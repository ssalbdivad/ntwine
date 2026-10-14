// The ntwine mark: a lowercase n of three threads, plaited three times down its right leg.
//
//   nub assets/logo-ntwine/final.ts             write assets/logo-ntwine/final/
//   nub assets/logo-ntwine/final.ts --install   also write every installed copy (see INSTALL below)
//
// Every PNG is rasterized by puppeteer's headless shell (render.ts). scripts/generate-icons.mjs makes
// the same six web PNGs with rsvg-convert where that exists; the art is identical, the bytes are not, so
// its --check reports them stale after a run of this script and the reverse.
import { mkdirSync, readFileSync, renameSync, existsSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { dirname, extname, join, normalize, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { assertAlphaWithinSafeCircle, buildMaskableSvg, decodePngAlpha } from "../../scripts/generate-icons.mjs"
import { launchHeadless } from "../../scripts/lib/headless-browser.mjs"
import { build, inkBox, woven, wovenTileSvg, GOLD } from "./lib.ts"
import { candidates, fitted, specOf } from "./n-concepts.ts"
import { withRenderer } from "./render.ts"

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, "../..")
const finalDir = join(here, "final")

// ---------------------------------------------------------------------------------------------------
// THE GEOMETRY is concept n9 in n-concepts.ts (chosen 2026-10-13 from ntwine-n.html): three threads rise
// parallel up the n's left stem, run together over the shoulder, and plait three times down the right
// stem — the previous mark's straight plait, bent into the letter. Its parameters live there so the
// concept sheet and the installed icon cannot drift; `fitted` scales it to 392 units tall (372 wide at
// most) inside the 480-unit tile.
const N9 = candidates.find((c) => c.id === "n9")!
const { spec, built: mark, k: K, d: D } = fitted(N9)
const box = inkBox(mark, spec.width)

const f1 = (x: number) => String(Math.round(x * 10) / 10)

const tileComment = `ntwine: a lowercase n of three threads, plaited three times down its right leg. Each
       thread is one path; its under-crossings are cut by a mask drawn along the thread on top. Rebuild
       with assets/logo-ntwine/final.ts; do not hand-edit.`

export const faviconSvg = wovenTileSvg(mark, spec, GOLD, tileComment)

/** The mark alone, in tile coordinates, cropped to its ink (the social card, the site's hero). */
export function markSvg(): string {
  const w = woven(mark, spec, GOLD, "s", "  ")
  const [x0, y0, x1, y1] = box.map((v, i) => (i < 2 ? v - 2 : v + 2))
  return `<svg width="${f1(x1 - x0)}" height="${f1(y1 - y0)}" viewBox="${f1(x0)} ${f1(y0)} ${f1(x1 - x0)} ${f1(y1 - y0)}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="ink" gradientUnits="userSpaceOnUse" cx="256" cy="256" r="250">
      <stop offset="0" stop-color="#87f1e0"/><stop offset="0.62" stop-color="#36d8c3"/><stop offset="1" stop-color="#11b29f"/>
    </radialGradient>
${w.defs}
  </defs>
${w.body}
</svg>
`
}

// The VS Code activity bar paints the icon as a mask at 16px (bar on top) and 24px (bar at the side).
// packages/vscode/src/package-contents.test.ts pins the pen at 0.7/16 of a square box and the ink at
// 15/16 of it, measured for the fff against VS Code's codicons; this keeps both rules, so the n is
// drawn as LINE ART there: same centrelines, a 0.7px pen, gaps opened to one device pixel at 24px.
// Not re-measured against the codicons for this mark.
export function monoSvg(): string {
  const [gx0, gy0, gx1, gy1] = inkBox(mark, 0)
  const geomH = Math.max(gy1 - gy0, gx1 - gx0)
  const B = geomH / (15 / 16 - 0.7 / 16)
  const pen = (0.7 / 16) * B
  const clear = B / 24
  const s = specOf({ ...N9, pen: pen / K, clear: clear / K }, K, D)
  const b = build(s)
  const w = woven(b, s, { inks: ["currentColor"] }, "m", "")
  const cx = (gx0 + gx1) / 2
  const cy = (gy0 + gy1) / 2
  const vb = [cx - B / 2, cy - B / 2, B, B].map((v) => v.toFixed(4)).join(" ")
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="${vb}"><!-- The app icon's plaited n (packages/web/public/favicon.svg) as one-colour line art for the activity bar, which paints it as a mask at 16px with the bar on top and 24px at the side. The box is square with the ink at 15/16 of its height and the pen at 0.7/16 of it, the rules package-contents.test.ts pins (measured for the previous mark against the codicons; not re-measured for this one). Gaps are B/24: one device pixel at 24px on a 1x screen. Rebuild with assets/logo-ntwine/final.ts. -->${w.body}<defs>${w.defs}</defs></svg>
`
}

/** The hero mark's data for site/components/mark.tsx, which draws each thread on load. */
export function sitePathModule(): string {
  const w = woven(mark, spec, GOLD, "s", "")
  const strands = [...w.body.matchAll(/<path d="([^"]+)"(?: mask="url\(#s(\d)\)")?/g)].map((m) => m[1])
  const cuts = mark.points.map((_, i) => {
    const m = new RegExp(`<mask id="s${i}"[^]*?<path d="([^"]+)"`).exec(w.defs)
    return m ? m[1] : ""
  })
  const [x0, y0, x1, y1] = box.map((v, i) => (i < 2 ? v - 2 : v + 2))
  return `// The ntwine mark's three threads, generated by assets/logo-ntwine/final.ts --install. Do not hand-edit.
// Each thread is one stroke; \`cuts[i]\` is the over-thread centreline its mask erases (pen + 2 * clear wide).
export const markViewBox = "${f1(x0)} ${f1(y0)} ${f1(x1 - x0)} ${f1(y1 - y0)}"
export const markPen = ${f1(spec.width)}
export const markCutWidth = ${f1(spec.width + 2 * spec.clear)}
export const markStrands: readonly string[] = ${JSON.stringify(strands, null, 2)}
export const markCuts: readonly string[] = ${JSON.stringify(cuts, null, 2)}
`
}

// ---------------------------------------------------------------------------------------------------
// INSTALL

const WEB = join(repo, "packages/web/public")
const SITE = join(repo, "site/public")
const PNGS: [string, number][] = [
  ["favicon-16.png", 16],
  ["favicon-32.png", 32],
  ["apple-touch-icon.png", 180],
  ["icon-192.png", 192],
  ["icon-512.png", 512],
]

const MIME: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" }

/** site/og/og.html served from site/ (it names /og/… and /public/… from that root), shot at 1200x630. */
async function shootOg(out: string) {
  const root = join(repo, "site")
  const server = createServer((req, res) => {
    const path = normalize(join(root, decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)))
    if (!path.startsWith(root) || !existsSync(path)) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" }).end(readFileSync(path))
  })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  const port = (server.address() as { port: number }).port
  const browser = await launchHeadless({ protocolTimeout: 60_000 })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 })
    await page.goto(`http://127.0.0.1:${port}/og/og.html`, { waitUntil: "networkidle0" })
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: out as `${string}.png`, clip: { x: 0, y: 0, width: 1200, height: 630 } })
  } finally {
    await browser.close()
    server.close()
  }
}

async function main() {
  const install = process.argv.includes("--install")
  mkdirSync(finalDir, { recursive: true })
  const mk = markSvg()
  const mono = monoSvg()
  writeFileSync(join(finalDir, "favicon.svg"), faviconSvg)
  writeFileSync(join(finalDir, "mark.svg"), mk)
  writeFileSync(join(finalDir, "mark-mono.svg"), mono)
  console.log(`scale ${K.toFixed(4)} · pen ${spec.width.toFixed(2)} · clear ${spec.clear.toFixed(2)} · ${mark.crossings.length} crossings`)
  console.log(`ink box ${box.map((v) => v.toFixed(1)).join(" ")} · favicon.svg ${(Buffer.byteLength(faviconSvg) / 1024).toFixed(1)} KB`)

  const maskable = buildMaskableSvg(faviconSvg)
  await withRenderer(async (render) => {
    writeFileSync(join(finalDir, "tile.png"), await render(faviconSvg, 512))
    for (const [name, size] of PNGS) writeFileSync(join(finalDir, name), await render(faviconSvg, size))
    writeFileSync(join(finalDir, "icon-maskable-512.png"), await render(maskable.svg, 512, { opaque: true }))
    const markOnly = join(finalDir, "maskable-mark-512.png")
    writeFileSync(markOnly, await render(maskable.markOnlySvg, 512))
    const painted = assertAlphaWithinSafeCircle(decodePngAlpha(markOnly))
    console.log(`maskable: ${painted} painted pixels, all inside the central 80% safe circle`)
  })

  if (!install) return
  for (const [name] of [...PNGS, ["icon-maskable-512.png", 512] as [string, number]]) writeFileSync(join(WEB, name), readFileSync(join(finalDir, name)))
  writeFileSync(join(WEB, "favicon.svg"), faviconSvg)
  writeFileSync(join(SITE, "favicon.svg"), faviconSvg)
  for (const name of ["favicon-16.png", "favicon-32.png", "apple-touch-icon.png"]) writeFileSync(join(SITE, name), readFileSync(join(finalDir, name)))
  writeFileSync(join(SITE, "img/og-mark.svg"), mk)
  if (existsSync(join(SITE, "img/fff-tile.png"))) renameSync(join(SITE, "img/fff-tile.png"), join(SITE, "img/tile.png"))
  writeFileSync(join(SITE, "img/tile.png"), readFileSync(join(finalDir, "tile.png")))
  writeFileSync(join(repo, "packages/vscode/media/ntwine.svg"), mono)
  writeFileSync(join(repo, "site/components/mark-path.ts"), sitePathModule())
  await shootOg(join(SITE, "img/og.png"))
  console.log("installed")
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
