// Ten directions for an ntwine mark that spells a capital N, with lowercase n9 alongside for comparison.
// Eight lay the plait's threads along one N stroke (up, down the diagonal, up), its two corners rounded into
// hairpins so the threads can turn without folding over themselves. The last two draw the N's three
// strokes as three separate threads woven through each other.
//
//   nub assets/logo-ntwine/capital-n-concepts.ts           -> ntwine-capital-n.html (+ out/capital-n/)
//   nub assets/logo-ntwine/capital-n-concepts.ts --shoot   also screenshot the page to out/capital-n/sheet.png
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { GOLD, smoothPath, TRI, wovenTile, type Paint, type Vec, type Woven } from "./lib.ts"
import { candidates as lowercase, entryOf, writeSheet, type Candidate, type Entry, type Path } from "./n-concepts.ts"

const here = dirname(fileURLToPath(import.meta.url))
const DEG = Math.PI / 180

// ---------------------------------------------------------------------------------------------------
// ONE STROKE. A turtle in screen coordinates (y down); a positive turn is clockwise, a right turn when
// heading up.

class Turtle {
  pts: Path
  constructor(start: Vec, public a: number) {
    this.pts = [start]
  }
  get p(): Vec {
    return this.pts[this.pts.length - 1]
  }
  fd(d: number) {
    const [x, y] = this.p
    const n = Math.max(2, Math.ceil(d))
    for (let k = 1; k <= n; k++) this.pts.push([x + (Math.cos(this.a) * d * k) / n, y + (Math.sin(this.a) * d * k) / n])
    return this
  }
  turn(r: number, by: number) {
    const s = Math.sign(by)
    const right: Vec = [-Math.sin(this.a), Math.cos(this.a)]
    const [x, y] = this.p
    const c: Vec = [x + s * r * right[0], y + s * r * right[1]]
    const a0 = Math.atan2(y - c[1], x - c[0])
    const n = Math.max(8, Math.ceil(Math.abs(by) * r))
    for (let k = 1; k <= n; k++) this.pts.push([c[0] + r * Math.cos(a0 + (by * k) / n), c[1] + r * Math.sin(a0 + (by * k) / n)])
    this.a += by
    return this
  }
}

type NStroke = { S: number; r: number; theta: number; tail?: number; shear?: number }

/**
 * Up the left stem, a hairpin of radius r turning `theta` degrees into the diagonal, down it, the mirror
 * hairpin, and up the right stem. The diagonal's length is solved so the second hairpin's lowest point sits
 * on the left foot's baseline (y = 0); `tail` runs both stems that much further, past the baseline and the
 * cap line. 180-degree rotationally symmetric by construction.
 */
function nStroke(o: NStroke): Path {
  const tail = o.tail ?? 0
  const draw = (D: number) => {
    const t = new Turtle([0, tail], -Math.PI / 2)
    t.fd(o.S + tail).turn(o.r, o.theta * DEG)
    const mark = t.pts.length
    t.fd(D).turn(o.r, -o.theta * DEG)
    const low = Math.max(...t.pts.slice(mark).map((p) => p[1]))
    t.fd(o.S + tail)
    return { pts: t.pts, low }
  }
  let lo = 0, hi = 4 * o.S
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2
    if (draw(mid).low < 0) lo = mid
    else hi = mid
  }
  const k = o.shear ?? 0
  return draw(hi).pts.map(([x, y]) => [x - k * y, y])
}

const STD: NStroke = { S: 230, r: 52, theta: 154 }
/** The length of a stroke, for placing braid regions in units rather than fractions. */
const lengthOf = (p: Path) => p.slice(1).reduce((acc, q, k) => acc + Math.hypot(q[0] - p[k][0], q[1] - p[k][1]), 0)
const L_STD = lengthOf(nStroke(STD))
/** Fraction of the stroke at the middle of each stem (measured from that stem's free end). */
const stemMid = (o: NStroke) => ((o.S + (o.tail ?? 0)) / 2) / lengthOf(nStroke(o))

const strokes: Candidate[] = [
  {
    id: "N1", title: "Plaited diagonal",
    note: "Three threads up the left stem, plaited three times down the diagonal, and up the right as three. The capital counterpart of n9.",
    path: nStroke(STD), threads: { strands: 3, A: 34, regions: [{ at: 0.5, crossings: 3, span: 250 }], ramp: 60 }, pen: 22, clear: 8,
  },
  {
    id: "N2", title: "Plaited end to end",
    note: "The braid runs the whole stroke, five crossings, foot to cap.",
    path: nStroke(STD), threads: { strands: 3, A: 30, regions: [{ at: 0.5, crossings: 5, span: L_STD - 60 }], ramp: 80 }, pen: 21, clear: 8,
  },
  {
    id: "N3", title: "One crossing on the diagonal",
    note: "Two parallel threads that swap sides once, halfway down the diagonal.",
    path: nStroke(STD), threads: { strands: 2, A: 30, regions: [{ at: 0.5, crossings: 1, span: 170 }], ramp: 70 }, pen: 28, clear: 10,
  },
  {
    id: "N4", title: "Twisted pair",
    note: "Two threads, twisted like cord: one crossing on each stroke.",
    path: nStroke(STD),
    threads: { strands: 2, A: 26, regions: [{ at: stemMid(STD), crossings: 1, span: 150 }, { at: 0.5, crossings: 1, span: 150 }, { at: 1 - stemMid(STD), crossings: 1, span: 150 }], ramp: 60 },
    pen: 28, clear: 10,
  },
  {
    id: "N5", title: "Plaited stems, clean diagonal",
    note: "A plait up each stem; the threads run parallel round the hairpins and down the diagonal between them.",
    path: nStroke(STD),
    threads: { strands: 3, A: 34, regions: [{ at: stemMid(STD), crossings: 3, span: 200 }, { at: 1 - stemMid(STD), crossings: 3, span: 200 }], ramp: 50 },
    pen: 22, clear: 8,
  },
  {
    id: "N6", title: "Frayed feet",
    note: "The plaited diagonal, with the threads coming loose and spreading at both free ends.",
    path: nStroke(STD), threads: { strands: 3, A: 32, regions: [{ at: 0.5, crossings: 3, span: 250 }], ramp: 60, fray: 0.7, frayLen: 110 }, pen: 21, clear: 8,
  },
  {
    id: "N7", title: "Italic",
    note: "The plaited diagonal, slanted 12 degrees.",
    path: nStroke({ ...STD, shear: Math.tan(12 * DEG) }), threads: { strands: 3, A: 34, regions: [{ at: 0.5, crossings: 3, span: 250 }], ramp: 60 }, pen: 22, clear: 8,
  },
  {
    id: "N8", title: "Loose ends",
    note: "Both stems run on past the baseline and the cap line, so the threads come in and leave loose, as on today's plait.",
    path: nStroke({ ...STD, tail: 70 }), threads: { strands: 3, A: 34, regions: [{ at: 0.5, crossings: 3, span: 250 }], ramp: 60 }, pen: 22, clear: 8,
  },
]

// ---------------------------------------------------------------------------------------------------
// THREE THREADS. Each of the N's strokes is its own thread; where two cross, a mask along the one on top
// opens a gap in the one beneath, exactly as lib.ts's `woven` does for strands along a centreline.

type Loose = { id: string; title: string; note: string; threads: Path[]; over: (a: number, b: number) => number; pen: number; clear: number; paint?: Paint }

const segment = (a: Vec, b: Vec, n = 400): Path => Array.from({ length: n + 1 }, (_, k) => [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n])
const cubic = (p0: Vec, p1: Vec, p2: Vec, p3: Vec, n = 600): Path =>
  Array.from({ length: n + 1 }, (_, k) => {
    const t = k / n, u = 1 - t
    return [0, 1].map((d) => u * u * u * p0[d] + 3 * u * u * t * p1[d] + 3 * u * t * t * p2[d] + t * t * t * p3[d]) as Vec
  })

function hits(a: Path, b: Path) {
  const out: { ka: number; kb: number }[] = []
  for (let i = 0; i < a.length - 1; i++)
    for (let j = 0; j < b.length - 1; j++) {
      const [p, q, r, s] = [a[i], a[i + 1], b[j], b[j + 1]]
      const d = (q[0] - p[0]) * (s[1] - r[1]) - (q[1] - p[1]) * (s[0] - r[0])
      if (d === 0) continue
      const t = ((r[0] - p[0]) * (s[1] - r[1]) - (r[1] - p[1]) * (s[0] - r[0])) / d
      const v = ((r[0] - p[0]) * (q[1] - p[1]) - (r[1] - p[1]) * (q[0] - p[0])) / d
      if (t >= 0 && t < 1 && v >= 0 && v < 1) out.push({ ka: i, kb: j })
    }
  return out
}

const tangent = (p: Path, k: number): Vec => {
  const a = p[Math.max(0, k - 2)], b = p[Math.min(p.length - 1, k + 2)]
  const l = Math.hypot(b[0] - a[0], b[1] - a[1])
  return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]
}

/** The over thread's centreline around a crossing, long enough to clear the under thread at its angle. */
function span(over: Path, k0: number, half: number): Path {
  const walk = (dir: number) => {
    const seg: Path = [over[k0]]
    let acc = 0
    for (let k = k0 + dir; k >= 0 && k < over.length && acc < half; k += dir) {
      acc += Math.hypot(over[k][0] - seg[seg.length - 1][0], over[k][1] - seg[seg.length - 1][1])
      seg.push(over[k])
    }
    return seg
  }
  return [...walk(-1).reverse(), ...walk(1).slice(1)]
}

function weave(threads: Path[], over: Loose["over"], pen: number, clear: number, paint: Paint): Woven {
  const cuts: Path[][] = threads.map(() => [])
  for (let a = 0; a < threads.length; a++)
    for (let b = a + 1; b < threads.length; b++)
      for (const h of hits(threads[a], threads[b])) {
        const top = over(a, b)
        const [o, ko, ku, u] = top === a ? [threads[a], h.ka, h.kb, b] : [threads[b], h.kb, h.ka, a]
        const to = tangent(o, ko), tu = tangent(threads[u], ku)
        const sin = Math.max(0.25, Math.abs(to[0] * tu[1] - to[1] * tu[0]))
        cuts[u].push(span(o, ko, (pen / 2 + clear) / sin + pen * 0.6))
      }
  const defs: string[] = []
  const body: string[] = []
  threads.forEach((t, i) => {
    const ink = paint.inks[i % paint.inks.length]
    const d = smoothPath(t, 22)
    if (!cuts[i].length) {
      body.push(`    <path d="${d}" fill="none" stroke="${ink}" stroke-width="${pen}" stroke-linecap="round"/>`)
      return
    }
    defs.push(
      `    <mask id="t${i}" maskUnits="userSpaceOnUse" x="-64" y="-64" width="640" height="640"><rect x="-64" y="-64" width="640" height="640" fill="#fff"/>` +
        `<path d="${cuts[i].map((c) => smoothPath(c, 18)).join("")}" fill="none" stroke="#000" stroke-width="${pen + 2 * clear}" stroke-linecap="butt"/></mask>`,
    )
    body.push(`    <path d="${d}" mask="url(#t${i})" fill="none" stroke="${ink}" stroke-width="${pen}" stroke-linecap="round"/>`)
  })
  return { defs: defs.join("\n"), body: body.join("\n") }
}

function looseEntry(c: Loose): Entry {
  const all = c.threads.flat()
  const x0 = Math.min(...all.map((p) => p[0])) - c.pen / 2, x1 = Math.max(...all.map((p) => p[0])) + c.pen / 2
  const y0 = Math.min(...all.map((p) => p[1])) - c.pen / 2, y1 = Math.max(...all.map((p) => p[1])) + c.pen / 2
  const k = Math.min(392 / (y1 - y0), 372 / (x1 - x0))
  const fit = c.threads.map((t) => t.map(([x, y]) => [256 + k * (x - (x0 + x1) / 2), 256 + k * (y - (y0 + y1) / 2)] as Vec))
  const w = weave(fit, c.over, c.pen * k, c.clear * k, c.paint ?? GOLD)
  const svg = wovenTile(w, `ntwine capital N concept ${c.id}: ${c.title}. Rebuild with assets/logo-ntwine/capital-n-concepts.ts.`)
  const crossings = (w.defs.match(/<mask/g) ?? []).length
  return { id: c.id, title: c.title, note: c.note, svg, meta: `${crossings} threads cut · pen ${(c.pen * k).toFixed(1)} · ${(Buffer.byteLength(svg) / 1024).toFixed(1)} KB` }
}

// Threads 0 and 2 are the stems, 1 the diagonal: the diagonal goes over the left stem and under the right.
const diagonalWeave = (a: number, b: number) => (a === 0 && b === 1 ? 1 : a === 1 && b === 2 ? 2 : a)

const loose: Loose[] = [
  {
    id: "N9", title: "Three threads, woven",
    note: "Each stroke is its own thread, running past the others: the diagonal over the left stem and under the right.",
    threads: [segment([-100, 195], [-100, -195]), segment([-160, -192], [160, 192]), segment([100, 195], [100, -195])],
    over: diagonalWeave, pen: 34, clear: 12,
  },
  {
    id: "N10", title: "Three threads, swung",
    note: "The same weave with the diagonal swung into a soft S and the stems bowed, in three teals so each thread can be followed.",
    threads: [
      cubic([-92, 205], [-112, 60], [-112, -60], [-92, -205]),
      cubic([-150, -200], [-70, -60], [70, 60], [150, 200]),
      cubic([92, -205], [112, -60], [112, 60], [92, 205]),
    ],
    over: diagonalWeave, pen: 34, clear: 12, paint: TRI,
  },
]

await writeSheet(
  {
    page: join(here, "ntwine-capital-n.html"),
    out: join(here, "out", "capital-n"),
    title: "ntwine mark: the plait as a capital N",
    heading: "Ten N's",
    intro:
      "N1 to N8 lay the plait's threads along one N stroke, its corners rounded into hairpins so the threads turn without folding; N9 and N10 draw the three strokes as three separate threads woven through each other. Rebuild with <code>nub assets/logo-ntwine/capital-n-concepts.ts</code>.",
    reference: [entryOf(lowercase.find((c) => c.id === "n9")!, "ntwine n concept. Rebuild with assets/logo-ntwine/n-concepts.ts;")],
  },
  [...strokes.map((c) => entryOf(c, "ntwine capital N concept. Rebuild with assets/logo-ntwine/capital-n-concepts.ts;")), ...loose.map(looseEntry)],
)
