// Every round of the ntwine mark on one self-contained page: the chosen mark first, then each round's
// candidates with what the round taught. Vector views are inlined as SVG data URIs (each <img> keeps its
// own mask ids); the 16 and 32px views are real rasterizations, inlined as PNG.
//
//   nub assets/logo-ntwine/concepts.ts           -> ntwine-concepts.html (+ out/ with every svg and png)
//   nub assets/logo-ntwine/concepts.ts --shoot   also screenshot the page to out/sheet.png
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { build, GOLD, tileSvg, wovenTileSvg } from "./lib.ts"
import { rounds, type Candidate } from "./candidates.ts"
import { faviconSvg, markSvg, monoSvg } from "./final.ts"
import { shootPage, withRenderer } from "./render.ts"

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, "out")
const page = join(here, "ntwine-concepts.html")

const svgUri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`
const pngUri = (png: Buffer) => `data:image/png;base64,${png.toString("base64")}`

type Render = (svg: string, size: number) => Promise<Buffer>

async function row(render: Render, id: string, title: string, note: string, svg: string, meta: string) {
  writeFileSync(join(out, `${id}.svg`), svg)
  const p16 = await render(svg, 16)
  const p32 = await render(svg, 32)
  writeFileSync(join(out, `${id}-16.png`), p16)
  writeFileSync(join(out, `${id}-32.png`), p32)
  return `<section>
  <h3>${id} · ${title}</h3>
  <p>${note} <span class="meta">${meta}</span></p>
  <div class="row">
    <img src="${svgUri(svg)}" width="256" height="256" alt="">
    <img src="${svgUri(svg)}" width="180" height="180" alt="">
    <figure><img class="px" src="${pngUri(p32)}" width="128" height="128"><figcaption>32 → 4x</figcaption></figure>
    <figure><img class="px" src="${pngUri(p16)}" width="128" height="128"><figcaption>16 → 8x</figcaption></figure>
    <div class="tabs">
      <div class="tab light"><img src="${pngUri(p16)}" width="16" height="16"><span>ntwine</span></div>
      <div class="tab dark"><img src="${pngUri(p16)}" width="16" height="16"><span>ntwine</span></div>
      <div class="tab light"><img src="${pngUri(p32)}" width="32" height="32"></div>
    </div>
  </div>
</section>`
}

function candidateSvg(c: Candidate) {
  const b = build(c.spec)
  const svg = c.woven ? wovenTileSvg(b, c.spec, c.paint ?? GOLD) : tileSvg(b, c.spec.width, c.paint ?? GOLD)
  return { svg, meta: `${b.crossings.length} crossings · pen ${c.spec.width} · ${(Buffer.byteLength(svg) / 1024).toFixed(1)} KB` }
}

async function main() {
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  const sections: string[] = []
  await withRenderer(async (render) => {
    const mono = monoSvg()
    const monoGrey = mono.replaceAll("currentColor", "#c5c5c5")
    const m16 = await render(monoGrey, 16)
    const m24 = await render(monoGrey, 24)
    sections.push(`<h2>The mark</h2>
<p>Three threads come in, plait through three crossings, and leave as three. Installed as the app icon, the site's icons and hero, the social card and the VS Code activity bar.</p>
${await row(render, "final", "App icon", "packages/web/public/favicon.svg", faviconSvg, `${(Buffer.byteLength(faviconSvg) / 1024).toFixed(1)} KB`)}
<section><h3>Alone and one-colour</h3>
  <p>The gold mark without its tile (social card, site hero), and the line-art version VS Code paints as a mask, at 16 and 24px.</p>
  <div class="row">
    <img src="${svgUri(markSvg())}" height="256" alt="">
    <div class="vsc"><img src="${svgUri(monoGrey)}" width="128" height="128"></div>
    <figure><img class="px" src="${pngUri(m16)}" width="128" height="128"><figcaption>16 → 8x</figcaption></figure>
    <figure><img class="px" src="${pngUri(m24)}" width="144" height="144"><figcaption>24 → 6x</figcaption></figure>
    <div class="vsc small"><img src="${pngUri(m16)}" width="16" height="16"><img src="${pngUri(m24)}" width="24" height="24"></div>
  </div>
</section>`)
    for (const r of rounds) {
      sections.push(`<h2>${r.title}</h2>\n<p class="finding">${r.finding}</p>`)
      for (const c of r.candidates) {
        const { svg, meta } = candidateSvg(c)
        sections.push(await row(render, c.id, c.title, c.note, svg, meta))
      }
    }
  })
  writeFileSync(
    page,
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>ntwine mark</title>
<style>
  body { margin: 0; padding: 32px; background: #15161a; color: #d8d8dc; font: 14px/1.45 system-ui, sans-serif; }
  h1 { font-size: 22px; margin: 0 0 6px; } h2 { font-size: 18px; margin: 40px 0 6px; color: #fff; } h3 { font-size: 15px; margin: 0 0 4px; color: #f0c64a; }
  p { margin: 0 0 12px; max-width: 900px; } .meta { color: #888; } .finding { color: #c9c9ce; }
  section { padding: 20px 0; border-top: 1px solid #2a2b31; }
  .row { display: flex; gap: 24px; align-items: center; flex-wrap: wrap; }
  figure { margin: 0; text-align: center; } figcaption { color: #888; font-size: 12px; }
  .px { image-rendering: pixelated; }
  .tabs { display: flex; flex-direction: column; gap: 8px; }
  .tab { display: flex; gap: 6px; align-items: center; padding: 6px 10px; border-radius: 8px; font-size: 12px; }
  .light { background: #f1f3f4; color: #222; } .dark { background: #35363a; color: #eee; }
  .vsc { background: #181818; padding: 12px; border-radius: 8px; display: flex; gap: 12px; align-items: center; }
</style></head><body>
<h1>ntwine mark</h1>
<p>Every candidate is three strands laid along one centreline, with exact crossings and a real over/under. Each row: the 512 art at 256 and 180, then 32 and 16 rasterized and upscaled with nearest-neighbour, then the 16 and 32 at true size on light and dark tab strips. Rebuild with <code>nub assets/logo-ntwine/concepts.ts</code>.</p>
${sections.join("\n")}
</body></html>
`,
  )
  console.log(page)
  if (process.argv.includes("--shoot")) {
    await shootPage(`file://${page}`, join(out, "sheet.png"))
    console.log(join(out, "sheet.png"))
  }
}

await main()
