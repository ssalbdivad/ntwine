// Round-one directions for the ntwine mark: build each, rasterize it at the sizes it must survive
// (16, 32, 180, 512), and write a self-contained sheet with every render inlined.
//
//   nub assets/logo-ntwine/concepts.ts            -> out/ (svg + png) and ntwine-concepts.html
//   nub assets/logo-ntwine/concepts.ts --shoot    also screenshot the sheet to out/sheet.png
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { arch, build, circle, GOLD, line, smoothstep, tileSvg, wovenTileSvg, type Built, type Paint, type Spec } from "./lib.ts"
import { shootPage, withRenderer } from "./render.ts"
import { candidates as refined } from "./candidates.ts"

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, "out")

export type Candidate = { id: string; title: string; note: string; spec: Spec; paint?: Paint; woven?: boolean }

const TAU = 2 * Math.PI
const phase = (i: number, n: number) => (TAU * i) / n

/** Three strands, phase-shifted 120 degrees, along an open centreline measured in units of arc length. */
const sine = (A: number, L: number, n = 3, shift = 0) => (i: number, _u: number, s: number) => A * Math.sin((TAU * s) / L + phase(i, n) + shift)

const lanes = (A: number, L: number, spread: number, a: number, b: number) => (i: number, u: number, s: number) => {
  const e = Math.max(1 - smoothstep(a, b, u), smoothstep(1 - b, 1 - a, u))
  return (1 - e) * A * Math.sin((TAU * s) / L + phase(i, 3)) + e * (i - 1) * spread
}

const ringSine = (A: number, k: number, n = 3) => (i: number, u: number) => A * Math.sin(TAU * k * u + phase(i, n))

export const roundOne: Candidate[] = [
  {
    id: "a-plait-bleed",
    title: "Plait, bleeding off",
    note: "Vertical three-strand plait; outer strand laid over the middle. Runs off the tile top and bottom.",
    spec: { centreline: line([256, 560], [256, -48]), strands: 3, offset: sine(118, 430), rule: "plait", width: 52, clear: 24 },
  },
  {
    id: "b-plait-short",
    title: "Plait, contained",
    note: "The same plait, ending inside the tile with round caps.",
    spec: { centreline: line([256, 420], [256, 92]), strands: 3, offset: sine(104, 400, 3, 0.5), rule: "plait", width: 50, clear: 24 },
  },
  {
    id: "c-plait-diag",
    title: "Plait, diagonal",
    note: "The plait turned 45 degrees and run corner to corner.",
    spec: { centreline: line([40, 472], [472, 40]), strands: 3, offset: sine(92, 380), rule: "plait", width: 46, clear: 22 },
  },
  {
    id: "d-rope-diag",
    title: "Rope, diagonal",
    note: "Helix rule: each strand is in front while it travels one way. Reads as twisted rope.",
    spec: { centreline: line([40, 472], [472, 40]), strands: 3, offset: sine(92, 380), rule: "rope", width: 46, clear: 22 },
  },
  {
    id: "e-rope-v",
    title: "Rope, vertical",
    note: "The rope stood upright.",
    spec: { centreline: line([256, 560], [256, -48]), strands: 3, offset: sine(118, 430), rule: "rope", width: 52, clear: 24 },
  },
  {
    id: "f-converge",
    title: "Lanes into a braid",
    note: "Three parallel threads come in, plait in the middle, and leave as three again.",
    spec: { centreline: line([256, 540], [256, -28]), strands: 3, offset: lanes(104, 330, 118, 0.12, 0.34), rule: "plait", width: 46, clear: 22 },
  },
  {
    id: "g-ring-2",
    title: "Braided ring",
    note: "A closed plait around a circle, two periods: three loops, twelve crossings.",
    spec: { centreline: circle([256, 256], 150), strands: 3, offset: ringSine(62, 2), rule: "plait", width: 40, clear: 20 },
  },
  {
    id: "h-ring-1",
    title: "Borromean",
    note: "A closed plait, one period: three rings, six crossings, no two linked.",
    spec: { centreline: circle([256, 256], 70), strands: 3, offset: ringSine(110, 1), rule: "plait", width: 46, clear: 24 },
  },
  {
    id: "i-ring-rope",
    title: "Rope ring",
    note: "A closed rope around a circle, two periods.",
    spec: { centreline: circle([256, 256], 150), strands: 3, offset: ringSine(62, 2), rule: "rope", width: 40, clear: 20 },
  },
  {
    id: "j-arch",
    title: "Entwined n",
    note: "Three strands twisted along an arch: a lowercase n.",
    spec: { centreline: arch(256, 112, 540, 112), strands: 3, offset: sine(42, 250), rule: "plait", width: 32, clear: 16 },
  },
  {
    id: "k-ring-3",
    title: "Braided ring, three periods",
    note: "Tighter closed plait: eighteen crossings.",
    spec: { centreline: circle([256, 256], 152), strands: 3, offset: ringSine(52, 3), rule: "plait", width: 34, clear: 16 },
  },
  {
    id: "l-plait-wide",
    title: "Plait, broad",
    note: "Few crossings, heavy strands: built for 16px.",
    spec: { centreline: line([256, 600], [256, -88]), strands: 3, offset: sine(132, 560, 3, 0.3), rule: "plait", width: 64, clear: 30 },
  },
]

const SIZES = [512, 180, 32, 16] as const

export async function renderSheet(list: Candidate[], file: string, heading: string, intro: string) {
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  const rows: string[] = []
  await withRenderer(async (render) => {
    for (const c of list) {
      const b: Built = build(c.spec)
      const svg = c.woven ? wovenTileSvg(b, c.spec, c.paint ?? GOLD) : tileSvg(b, c.spec.width, c.paint ?? GOLD)
      writeFileSync(join(out, `${c.id}.svg`), svg)
      const png: Record<number, string> = {}
      for (const size of SIZES) {
        const buf = await render(svg, size)
        writeFileSync(join(out, `${c.id}-${size}.png`), buf)
        png[size] = `data:image/png;base64,${buf.toString("base64")}`
      }
      const bytes = Buffer.byteLength(svg)
      rows.push(`<section>
  <h2>${c.id} · ${c.title}</h2>
  <p>${c.note} <span class="meta">${b.crossings.length} crossings · pen ${c.spec.width} · ${(bytes / 1024).toFixed(1)} KB</span></p>
  <div class="row">
    <img src="${png[512]}" width="256" height="256" alt="512">
    <img src="${png[180]}" width="180" height="180" alt="180">
    <figure><img class="px" src="${png[32]}" width="128" height="128"><figcaption>32 → 4x</figcaption></figure>
    <figure><img class="px" src="${png[16]}" width="128" height="128"><figcaption>16 → 8x</figcaption></figure>
    <div class="tabs">
      <div class="tab light"><img src="${png[16]}" width="16" height="16"><span>ntwine</span></div>
      <div class="tab dark"><img src="${png[16]}" width="16" height="16"><span>ntwine</span></div>
      <div class="tab light"><img src="${png[32]}" width="32" height="32"></div>
    </div>
  </div>
</section>`)
    }
  })
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${heading}</title>
<style>
  body { margin: 0; padding: 32px; background: #15161a; color: #d8d8dc; font: 14px/1.45 system-ui, sans-serif; }
  h1 { font-size: 20px; margin: 0 0 6px; } h2 { font-size: 15px; margin: 0 0 4px; color: #f0c64a; }
  p { margin: 0 0 12px; max-width: 900px; } .meta { color: #888; }
  section { padding: 20px 0; border-top: 1px solid #2a2b31; }
  .row { display: flex; gap: 24px; align-items: center; flex-wrap: wrap; }
  figure { margin: 0; text-align: center; } figcaption { color: #888; font-size: 12px; }
  .px { image-rendering: pixelated; }
  .tabs { display: flex; flex-direction: column; gap: 8px; }
  .tab { display: flex; gap: 6px; align-items: center; padding: 6px 10px; border-radius: 8px; font-size: 12px; }
  .light { background: #f1f3f4; color: #222; } .dark { background: #35363a; color: #eee; }
</style></head><body>
<h1>${heading}</h1>
<p>${intro}</p>
${rows.join("\n")}
</body></html>
`
  writeFileSync(join(here, file), html)
  return join(here, file)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const which = process.argv.includes("--refined") ? "refined" : "one"
  const list = which === "refined" ? refined : roundOne
  const file = which === "refined" ? "ntwine-refined.html" : "ntwine-concepts.html"
  const page = await renderSheet(
    list,
    file,
    which === "refined" ? "ntwine mark — refinement" : "ntwine mark — round one",
    "Every candidate is N strands along one centreline with real over/under cuts. Each row: 512 (shown at 256), 180, 32 and 16 upscaled with nearest-neighbour, then the 16 and 32 at true size on light and dark tab strips.",
  )
  console.log(page)
  if (process.argv.includes("--shoot")) {
    await shootPage(`file://${page}`, join(out, "sheet.png"))
    console.log(join(out, "sheet.png"))
  }
}
