// Ten directions for an ntwine mark that spells a lowercase n: the shipped plait's threads, laid along an
// n's skeleton instead of a straight column. Same renderer (lib.ts), same tile, same teal.
//
//   nub assets/logo-ntwine/n-concepts.ts           -> ntwine-n.html (+ out/n/ with every svg and png)
//   nub assets/logo-ntwine/n-concepts.ts --shoot   also screenshot the page to out/n/sheet.png
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { build, GOLD, inkBox, smoothstep, TRI, wovenTileSvg, type Centreline, type Paint, type Rule, type Spec, type Vec } from "./lib.ts"
import { shootPage, withRenderer } from "./render.ts"

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, "out", "n")
const page = join(here, "ntwine-n.html")

// ---------------------------------------------------------------------------------------------------
// SKELETONS. An n is drawn as one polyline, then arc-length parametrised; the normal is the tangent turned
// a quarter left, which matches lib.ts's `line` and `arch` (heading up, the normal points right).

export type Path = Vec[]

class Pen {
  pts: Path = []
  constructor(start: Vec) {
    this.pts.push(start)
  }
  get at(): Vec {
    return this.pts[this.pts.length - 1]
  }
  line(to: Vec) {
    const [x0, y0] = this.at
    const n = Math.max(2, Math.ceil(Math.hypot(to[0] - x0, to[1] - y0)))
    for (let k = 1; k <= n; k++) this.pts.push([x0 + ((to[0] - x0) * k) / n, y0 + ((to[1] - y0) * k) / n])
    return this
  }
  /** Arc about `c`, radius r, from angle a0 to a1 (screen angles: y down). */
  arc(c: Vec, r: number, a0: number, a1: number) {
    const n = Math.max(8, Math.ceil(Math.abs(a1 - a0) * r))
    for (let k = 1; k <= n; k++) {
      const a = a0 + ((a1 - a0) * k) / n
      this.pts.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)])
    }
    return this
  }
  /** A squarer shoulder: a superellipse half from the left stem's top to the right stem's top. */
  shoulder(cx: number, cy: number, R: number, rise: number, p: number) {
    const n = 600
    for (let k = 1; k <= n; k++) {
      const t = Math.PI - (Math.PI * k) / n
      const c = Math.cos(t), s = Math.sin(t)
      this.pts.push([cx + R * Math.sign(c) * Math.abs(c) ** (2 / p), cy - rise * Math.abs(s) ** (2 / p)])
    }
    return this
  }
}

export function centrelineOf(path: Path): Centreline & { length: number } {
  const arc = [0]
  for (let k = 1; k < path.length; k++) arc.push(arc[k - 1] + Math.hypot(path[k][0] - path[k - 1][0], path[k][1] - path[k - 1][1]))
  const L = arc[arc.length - 1]
  let j = 0
  const at = (u: number) => {
    const s = u * L
    if (s < arc[j]) j = 0
    while (j < arc.length - 2 && arc[j + 1] < s) j++
    const t = arc[j + 1] === arc[j] ? 0 : (s - arc[j]) / (arc[j + 1] - arc[j])
    const p: Vec = [path[j][0] + t * (path[j + 1][0] - path[j][0]), path[j][1] + t * (path[j + 1][1] - path[j][1])]
    // tangent over a few samples either side, so the polyline's facets do not jitter the normal
    const a = path[Math.max(0, j - 3)], b = path[Math.min(path.length - 1, j + 4)]
    const l = Math.hypot(b[0] - a[0], b[1] - a[1])
    return { p, n: [-(b[1] - a[1]) / l, (b[0] - a[0]) / l] as Vec }
  }
  return { closed: false, at, length: L }
}

type N = { R: number; H: number; entry?: number; exit?: number; p?: number; rise?: number; shear?: number; stub?: number }

/** An n: (optional entry hook) up the left stem, over the shoulder, down the right stem, (optional exit flick). */
function nPath(o: N): Path {
  const { R, H } = o
  const rise = o.rise ?? R
  const p = o.p ?? 2
  const e = o.entry ?? 0
  const x = o.exit ?? 0
  const pen = new Pen(e ? [-R - e, H] : [-R, H + (o.stub ?? 0)])
  if (e) pen.arc([-R - e, H - e], e, Math.PI / 2, 0)
  pen.line([-R, 0])
  if (p === 2 && rise === R) pen.arc([0, 0], R, Math.PI, 2 * Math.PI)
  else pen.shoulder(0, 0, R, rise, p)
  if (x) pen.line([R, H - x]).arc([R + x, H - x], x, Math.PI, Math.PI / 2)
  else pen.line([R, H + (o.stub ?? 0)])
  const k = o.shear ?? 0
  return pen.pts.map(([px, py]) => [px - k * py, py])
}

// ---------------------------------------------------------------------------------------------------
// THREADS. Offsets are the shipped mark's construction generalised: a phase that only advances inside
// braid REGIONS (60 degrees per crossing for three strands, 180 for two), its rate eased in and out over
// `ramp`, so outside every region the threads lie parallel at an even spread.

export type Region = { at: number; crossings: number; span: number }
export type Threads = { strands: 2 | 3; A: number; regions: Region[]; ramp: number; fray?: number; frayLen?: number }

function threadOffsets(t: Threads, L: number) {
  const K = 4000
  const per = t.strands === 3 ? Math.PI / 3 : Math.PI
  const tables = t.regions.map((r) => {
    const a = r.at * L - r.span / 2, b = r.at * L + r.span / 2
    const sm = (x: number) => (x >= t.ramp ? 1 : x <= 0 ? 0 : (x / t.ramp) ** 2 * (3 - 2 * (x / t.ramp)))
    const rate = (s: number) => sm(s - a) * sm(b - s)
    const tab = [0]
    for (let k = 1; k <= K; k++) tab.push(tab[k - 1] + rate(((k - 0.5) / K) * L))
    const total = tab[K] || 1
    return { tab, scale: (per * r.crossings) / total }
  })
  const phase = (s: number) => {
    const x = Math.min(K, Math.max(0, (s / L) * K))
    const k = Math.floor(x), f = x - k
    let sum = 0
    for (const { tab, scale } of tables) sum += (tab[k] + f * ((tab[Math.min(K, k + 1)]) - tab[k])) * scale
    return sum
  }
  return (i: number, _u: number, s: number) => {
    const g = t.fray ? 1 + t.fray * (1 - smoothstep(0, t.frayLen ?? 60, Math.min(s, L - s))) : 1
    const ph = phase(s)
    return g * (t.strands === 3 ? t.A * Math.sin(ph + (2 * Math.PI * i) / 3) : t.A * Math.cos(ph + Math.PI * i))
  }
}

// ---------------------------------------------------------------------------------------------------
// FIT. Each candidate is drawn in its own units, then scaled and centred so its ink fills the same box
// at most 392 units tall and 372 wide inside the 480-unit tile: an n is wider than the shipped column,
// and filling the tile's width puts its shoulders into the rounded corners.

/** A skeleton is either an n's proportions or any polyline. */
export type Candidate = { id: string; title: string; note: string; n?: N; path?: Path; threads: Threads; pen: number; clear: number; rule?: Rule; paint?: Paint }

export function specOf(c: Candidate, k = 1, d: Vec = [0, 0]): Spec {
  const raw = c.path ?? nPath(c.n!)
  const cl = centrelineOf(raw.map(([x, y]) => [k * x + d[0], k * y + d[1]]))
  const L0 = cl.length / k
  const off = threadOffsets(c.threads, L0)
  return {
    centreline: cl,
    strands: c.threads.strands,
    offset: (i, u, s) => k * off(i, u, s / k),
    rule: c.rule ?? (c.threads.strands === 2 ? "rope" : "plait"),
    width: c.pen * k,
    clear: c.clear * k,
  }
}

export function fitted(c: Candidate) {
  const [x0, y0, x1, y1] = inkBox(build(specOf(c)), c.pen)
  const k = Math.min(392 / (y1 - y0), 372 / (x1 - x0))
  const d: Vec = [256 - (k * (x0 + x1)) / 2, 256 - (k * (y0 + y1)) / 2]
  const spec = specOf(c, k, d)
  return { spec, built: build(spec), k, d }
}

// ---------------------------------------------------------------------------------------------------
// THE TEN. Shared proportions: stems 200 apart, the shoulder a half circle, 130 of stem below it.

const STD: N = { R: 100, H: 130 }

export const candidates: Candidate[] = [
  {
    id: "n1", title: "Plaited shoulder",
    note: "Three threads rise up the left stem, plait three times over the shoulder, and come down the right as three.",
    n: STD, threads: { strands: 3, A: 40, regions: [{ at: 0.5, crossings: 3, span: 250 }], ramp: 70 }, pen: 25, clear: 9,
  },
  {
    id: "n2", title: "Plaited end to end",
    note: "The braid runs the whole stroke, five crossings, foot to foot.",
    n: { R: 104, H: 150 }, threads: { strands: 3, A: 34, regions: [{ at: 0.5, crossings: 5, span: 560 }], ramp: 70 }, pen: 23, clear: 9,
  },
  {
    id: "n3", title: "Twisted pair",
    note: "Two threads, twisted like cord: one crossing on each stem and one at the crown.",
    n: { R: 100, H: 150 }, threads: { strands: 2, A: 26, regions: [{ at: 0.5, crossings: 3, span: 480 }], ramp: 80 }, pen: 30, clear: 10,
  },
  {
    id: "n4", title: "One crossing at the crown",
    note: "Two parallel threads that swap sides once, at the top of the arch.",
    n: STD, threads: { strands: 2, A: 34, regions: [{ at: 0.5, crossings: 1, span: 170 }], ramp: 70 }, pen: 32, clear: 11,
  },
  {
    id: "n5", title: "Cursive n",
    note: "A written n: an entry hook in, an exit flick out, the plait over the shoulder.",
    n: { R: 92, H: 140, entry: 46, exit: 46 }, threads: { strands: 3, A: 32, regions: [{ at: 0.5, crossings: 3, span: 230 }], ramp: 70 }, pen: 21, clear: 8,
  },
  {
    id: "n6", title: "Frayed feet",
    note: "The plaited shoulder, with the threads coming loose and spreading at both feet.",
    n: STD, threads: { strands: 3, A: 36, regions: [{ at: 0.5, crossings: 3, span: 250 }], ramp: 70, fray: 0.7, frayLen: 110 }, pen: 23, clear: 9,
  },
  {
    id: "n7", title: "Italic",
    note: "The cursive n, slanted 12 degrees.",
    n: { R: 92, H: 140, entry: 46, exit: 46, shear: Math.tan((12 * Math.PI) / 180) }, threads: { strands: 3, A: 32, regions: [{ at: 0.5, crossings: 3, span: 230 }], ramp: 70 }, pen: 21, clear: 8,
  },
  {
    id: "n8", title: "Square shoulder",
    note: "A flatter, squarer arch; the plait sits on its straight top.",
    n: { R: 100, H: 150, p: 4, rise: 80 }, threads: { strands: 3, A: 38, regions: [{ at: 0.5, crossings: 3, span: 220 }], ramp: 60 }, pen: 24, clear: 9,
  },
  {
    id: "n9", title: "The plait as the right leg",
    note: "The shipped mark's column, bent: parallel threads up and over, the plait coming down the right stem.",
    n: { R: 96, H: 180 }, threads: { strands: 3, A: 40, regions: [{ at: 0.8, crossings: 3, span: 200 }], ramp: 60 }, pen: 25, clear: 9,
  },
  {
    id: "n10", title: "Both legs plaited, smooth crown",
    note: "A plait up each stem, the threads running clean over the arch between them. Three colours, so each thread can be followed.",
    n: { R: 96, H: 170 }, threads: { strands: 3, A: 38, regions: [{ at: 0.17, crossings: 2, span: 150 }, { at: 0.83, crossings: 2, span: 150 }], ramp: 50 }, pen: 24, clear: 9,
    paint: TRI,
  },
]

// ---------------------------------------------------------------------------------------------------
// THE PAGE

const svgUri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`
const pngUri = (png: Buffer) => `data:image/png;base64,${png.toString("base64")}`

type Render = (svg: string, size: number) => Promise<Buffer>

async function row(render: Render, out: string, id: string, title: string, note: string, svg: string, meta: string) {
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
    <img src="${svgUri(svg)}" width="128" height="128" alt="">
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

export type Entry = { id: string; title: string; note: string; svg: string; meta: string }
export type Sheet = { page: string; out: string; title: string; intro: string; heading: string; reference?: Entry[] }

/** One self-contained page: the shipped mark (and any `reference` rows), a thumbnail grid, then a row per entry. */
export async function writeSheet(sheet: Sheet, entries: Entry[]) {
  rmSync(sheet.out, { recursive: true, force: true })
  mkdirSync(sheet.out, { recursive: true })
  const sections: string[] = []
  const thumbs = entries.map((e) => `<figure><img src="${svgUri(e.svg)}" width="160" height="160" alt=""><figcaption>${e.id} · ${e.title}</figcaption></figure>`)
  // the installed icon, read from disk: final.ts builds it from this file, so importing it here would be a cycle
  const faviconSvg = readFileSync(join(here, "../../packages/web/public/favicon.svg"), "utf8")
  await withRenderer(async (render) => {
    sections.push(`<h2>For reference</h2>\n${await row(render, sheet.out, "shipped", "The installed mark", "packages/web/public/favicon.svg", faviconSvg, "")}`)
    for (const e of sheet.reference ?? []) sections.push(await row(render, sheet.out, e.id, e.title, e.note, e.svg, e.meta))
    sections.push(`<h2>${sheet.heading}</h2>`)
    for (const e of entries) sections.push(await row(render, sheet.out, e.id, e.title, e.note, e.svg, e.meta))
  })
  writeFileSync(
    sheet.page,
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${sheet.title}</title>
<style>
  body { margin: 0; padding: 32px; background: #15161a; color: #d8d8dc; font: 14px/1.45 system-ui, sans-serif; }
  h1 { font-size: 22px; margin: 0 0 6px; } h2 { font-size: 18px; margin: 40px 0 6px; color: #fff; } h3 { font-size: 15px; margin: 0 0 4px; color: #5eead4; }
  p { margin: 0 0 12px; max-width: 900px; } .meta { color: #888; }
  section { padding: 20px 0; border-top: 1px solid #2a2b31; }
  .row { display: flex; gap: 24px; align-items: center; flex-wrap: wrap; }
  .grid { display: grid; grid-template-columns: repeat(5, 160px); gap: 20px; }
  figure { margin: 0; text-align: center; } figcaption { color: #888; font-size: 12px; }
  .px { image-rendering: pixelated; }
  .tabs { display: flex; flex-direction: column; gap: 8px; }
  .tab { display: flex; gap: 6px; align-items: center; padding: 6px 10px; border-radius: 8px; font-size: 12px; }
  .light { background: #f1f3f4; color: #222; } .dark { background: #35363a; color: #eee; }
</style></head><body>
<h1>${sheet.title}</h1>
<p>${sheet.intro} Each row: the 512 art at 256 and 128, then 32 and 16 rasterized and upscaled with nearest-neighbour, then the 16 and 32 at true size on light and dark tab strips.</p>
<div class="grid">${thumbs.join("")}</div>
${sections.join("\n")}
</body></html>
`,
  )
  console.log(sheet.page)
  if (process.argv.includes("--shoot")) {
    await shootPage(`file://${sheet.page}`, join(sheet.out, "sheet.png"))
    console.log(join(sheet.out, "sheet.png"))
  }
}

/** A candidate as a sheet entry: fitted to the tile and woven. */
export function entryOf(c: Candidate, comment: string): Entry {
  const { spec, built } = fitted(c)
  const svg = wovenTileSvg(built, spec, c.paint ?? GOLD, `${comment} ${c.id}: ${c.title}.`)
  return { id: c.id, title: c.title, note: c.note, svg, meta: `${built.crossings.length} crossings · pen ${spec.width.toFixed(1)} · ${(Buffer.byteLength(svg) / 1024).toFixed(1)} KB` }
}

async function main() {
  await writeSheet(
    {
      page,
      out,
      title: "ntwine mark: the plait as an n",
      heading: "Ten n's",
      intro: "The shipped mark's threads, laid along a lowercase n instead of a straight column. Rebuild with <code>nub assets/logo-ntwine/n-concepts.ts</code>.",
    },
    candidates.map((c) => entryOf(c, "ntwine n concept. Rebuild with assets/logo-ntwine/n-concepts.ts;")),
  )
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
