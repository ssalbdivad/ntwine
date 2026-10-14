// Geometry and rendering shared by the ntwine mark's build scripts.
//
// THE MODEL. Every candidate is N strands laid along one CENTRELINE C(u), u in [0, 1]. Strand i sits
// at a signed offset o_i(u) along the centreline's normal: P_i(u) = C(u) + o_i(u) N(u). Two strands
// cross exactly where their offsets are equal, so crossings are found in ONE dimension (a sign change
// of o_i - o_j), never by intersecting curves — which makes the count and placement exact.
//
// OVER/UNDER is a rule over the two offsets' derivatives at the crossing:
//   plait  the strand moving TOWARD the centreline goes over. The outer strand is laid over the middle,
//          which is how hair is plaited, and every strand alternates over, under, over along its length.
//   rope   the strand whose offset is increasing goes over. Every strand is in front while it travels
//          one way and behind on the way back: the projection of a helix, a twisted rope.
//
// GAPS are real cuts, not a background-coloured halo under the over strand. The under strand is split
// where it passes beneath, so the mark is plain stroked paths: it survives currentColor, a mask (VS
// Code's activity bar paints the icon as one), any background, and any gradient on the ink.

export type Vec = [number, number]

export type Centreline = {
  /** Point and unit normal at u. */
  at(u: number): { p: Vec; n: Vec }
  closed: boolean
}

export const line = (a: Vec, b: Vec): Centreline => {
  const d = [b[0] - a[0], b[1] - a[1]]
  const len = Math.hypot(d[0], d[1])
  const n: Vec = [-d[1] / len, d[0] / len]
  return { closed: false, at: (u) => ({ p: [a[0] + d[0] * u, a[1] + d[1] * u], n }) }
}

export const circle = (c: Vec, r: number, start = -Math.PI / 2): Centreline => ({
  closed: true,
  at: (u) => {
    const t = start + 2 * Math.PI * u
    const n: Vec = [Math.cos(t), Math.sin(t)]
    return { p: [c[0] + r * n[0], c[1] + r * n[1]], n }
  },
})

/** An arch: up the left stem, over a half circle, down the right stem (a lowercase n's skeleton). */
export const arch = (cx: number, top: number, bottom: number, halfWidth: number): Centreline => {
  const stem = bottom - (top + halfWidth)
  const curve = Math.PI * halfWidth
  const total = 2 * stem + curve
  const archCy = top + halfWidth
  return {
    closed: false,
    at: (u) => {
      const s = u * total
      if (s <= stem) return { p: [cx - halfWidth, bottom - s], n: [1, 0] } // heading up, normal points in
      if (s <= stem + curve) {
        const t = Math.PI - (s - stem) / halfWidth // from the left (pi) to the right (0), over the top
        return { p: [cx + halfWidth * Math.cos(t), archCy - halfWidth * Math.sin(t)], n: [-Math.cos(t), Math.sin(t)] }
      }
      return { p: [cx + halfWidth, archCy + (s - stem - curve)], n: [-1, 0] }
    },
  }
}

export type Rule = "plait" | "rope"

export type Spec = {
  centreline: Centreline
  strands: number
  /** Offset of strand i at u (and its arc length s along the centreline, in units). */
  offset: (i: number, u: number, s: number) => number
  rule: Rule
  /** Stroke width and the clear ink gap between an over strand's edge and the cut end's cap. */
  width: number
  clear: number
  samples?: number
}

export type Crossing = { u: number; over: number; under: number; p: Vec }

export type Built = {
  /** Per strand, the visible pieces as point lists. */
  pieces: Vec[][][]
  crossings: Crossing[]
  points: Vec[][]
}

export const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export function build(spec: Spec): Built {
  const M = spec.samples ?? 2400
  const N = spec.strands
  const us = Array.from({ length: M + 1 }, (_, k) => k / M)
  const frames = us.map((u) => spec.centreline.at(u))
  const arc: number[] = [0]
  for (let k = 1; k <= M; k++) arc.push(arc[k - 1] + Math.hypot(frames[k].p[0] - frames[k - 1].p[0], frames[k].p[1] - frames[k - 1].p[1]))
  const off = Array.from({ length: N }, (_, i) => us.map((u, k) => spec.offset(i, u, arc[k])))
  const points: Vec[][] = off.map((o) => frames.map((f, k) => [f.p[0] + o[k] * f.n[0], f.p[1] + o[k] * f.n[1]] as Vec))

  const crossings: Crossing[] = []
  for (let i = 0; i < N; i++)
    for (let j = i + 1; j < N; j++)
      for (let k = 0; k < M; k++) {
        const d0 = off[i][k] - off[j][k]
        const d1 = off[i][k + 1] - off[j][k + 1]
        // A crossing that lands exactly on a sample is counted once, on the segment that ends at it.
        if (d0 === 0 || (d0 < 0 ? d1 < 0 : d1 > 0)) continue
        const t = d0 / (d0 - d1)
        const di = off[i][k + 1] - off[i][k]
        const dj = off[j][k + 1] - off[j][k]
        const oi = off[i][k] + t * di
        let over: number
        if (spec.rule === "rope") over = di > dj ? i : j
        else {
          // toward the centreline: |o| shrinking. The strand whose |o| falls faster is laid over.
          const ri = Math.sign(oi) * di
          const rj = Math.sign(oi) * dj
          over = ri < rj ? i : j
        }
        const under = over === i ? j : i
        const p: Vec = [points[i][k][0] + t * (points[i][k + 1][0] - points[i][k][0]), points[i][k][1] + t * (points[i][k + 1][1] - points[i][k][1])]
        crossings.push({ u: (k + t) / M, over, under, p })
      }

  // Cut the under strand wherever it passes beneath: march out from the crossing until the strand's
  // centre is (width + clear) from the over strand's centre — half a pen for the over strand's edge,
  // half a pen for the cut end's round cap, and the clear gap between them.
  const need = spec.width + spec.clear
  const cut: boolean[][] = Array.from({ length: N }, () => Array(M + 1).fill(false))
  const wrap = (k: number) => (spec.centreline.closed ? ((k % M) + M) % M : k)
  for (const c of crossings) {
    const k0 = Math.round(c.u * M)
    const over = points[c.over]
    const distToOver = (k: number) => {
      const q = points[c.under][wrap(k)]
      let best = Infinity
      for (let w = -M / 6; w <= M / 6; w++) {
        const kk = wrap(k0 + w)
        if (kk < 0 || kk > M) continue
        const d = Math.hypot(over[kk][0] - q[0], over[kk][1] - q[1])
        if (d < best) best = d
      }
      return best
    }
    for (const dir of [-1, 1]) {
      for (let k = k0; ; k += dir) {
        const kk = wrap(k)
        if (kk < 0 || kk > M) break
        if (distToOver(k) >= need) break
        cut[c.under][kk] = true
      }
    }
  }

  const pieces: Vec[][][] = points.map((pts, i) => {
    const out: Vec[][] = []
    let cur: Vec[] = []
    const last = spec.centreline.closed ? M - 1 : M
    // For a closed strand, start the walk at a cut so no piece is split across u = 0.
    let start = 0
    if (spec.centreline.closed) {
      const firstCut = cut[i].findIndex((x) => x)
      start = firstCut < 0 ? 0 : firstCut
    }
    for (let n = 0; n <= last; n++) {
      const k = spec.centreline.closed ? (start + n) % M : n
      if (cut[i][k]) {
        if (cur.length > 1) out.push(cur)
        cur = []
      } else cur.push(pts[k])
    }
    if (cur.length > 1) out.push(cur)
    if (spec.centreline.closed && out.length === 0) out.push([...pts.slice(0, M), pts[0]])
    return out
  })
  return { pieces, crossings, points }
}

const f1 = (x: number) => {
  const r = Math.round(x * 10) / 10
  return Object.is(r, -0) ? "0" : String(r)
}

/** A point list as cubic Béziers (Catmull-Rom through points resampled every `step` units). */
export function smoothPath(pts: Vec[], step = 14): string {
  const lens = [0]
  for (let k = 1; k < pts.length; k++) lens.push(lens[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]))
  const total = lens[lens.length - 1]
  const n = Math.max(2, Math.ceil(total / step))
  const rs: Vec[] = []
  let j = 0
  for (let q = 0; q <= n; q++) {
    const target = (q / n) * total
    while (j < lens.length - 2 && lens[j + 1] < target) j++
    const t = lens[j + 1] === lens[j] ? 0 : (target - lens[j]) / (lens[j + 1] - lens[j])
    rs.push([pts[j][0] + t * (pts[j + 1][0] - pts[j][0]), pts[j][1] + t * (pts[j + 1][1] - pts[j][1])])
  }
  let d = `M${f1(rs[0][0])} ${f1(rs[0][1])}`
  for (let q = 0; q < rs.length - 1; q++) {
    const p0 = rs[Math.max(0, q - 1)]
    const p1 = rs[q]
    const p2 = rs[q + 1]
    const p3 = rs[Math.min(rs.length - 1, q + 2)]
    const c1: Vec = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2: Vec = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    d += `C${f1(c1[0])} ${f1(c1[1])} ${f1(c2[0])} ${f1(c2[1])} ${f1(p2[0])} ${f1(p2[1])}`
  }
  return d
}

export type Paint = {
  /** One ink for every strand, or one per strand. */
  inks: string[]
}

// The ink is teal-400 (#2dd4bf, oklch 0.785 0.133 182), the app's dark accent. Its three stops keep the
// lightness steps the gold had about its accent (+0.105, +0.012, -0.100 in oklch L) and the gold's chroma
// ratios, at hue 182 — so the radial highlight still lifts the crossings off the tile.
export const INK: Paint = { inks: ["url(#ink)"] }
/** @deprecated the mark is teal now; kept so the concept rounds' code reads as written. */
export const GOLD = INK

const TILE_DEFS = `<clipPath id="tile">
      <rect x="16" y="16" width="480" height="480" rx="116"/>
    </clipPath>
    <linearGradient id="background" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#191a20"/>
      <stop offset="1" stop-color="#0d0e10"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#2dd4bf" stop-opacity="0.14"/>
      <stop offset="1" stop-color="#2dd4bf" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="ink" gradientUnits="userSpaceOnUse" cx="256" cy="256" r="250">
      <stop offset="0" stop-color="#87f1e0"/>
      <stop offset="0.62" stop-color="#36d8c3"/>
      <stop offset="1" stop-color="#11b29f"/>
    </radialGradient>`

/** Strand paths, one `<path>` per strand (its pieces joined as subpaths). */
export function strandPaths(b: Built, width: number, paint: Paint, indent = "    "): string {
  return b.pieces
    .map((pieces, i) => {
      const d = pieces.map((p) => smoothPath(p)).join("")
      const ink = paint.inks[i % paint.inks.length]
      return `${indent}<path d="${d}" fill="none" stroke="${ink}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`
    })
    .join("\n")
}

/** The app icon: the favicon's tile, border and glow (ids generate-icons.mjs relies on) with the mark. */
export function tileSvg(b: Built, width: number, paint: Paint = GOLD, comment = ""): string {
  return `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    ${TILE_DEFS}
  </defs>

  <rect id="icon-background" x="16" y="16" width="480" height="480" rx="116" fill="url(#background)"/>
  <rect id="icon-border" x="16.5" y="16.5" width="479" height="479" rx="115.5" fill="none" stroke="#2b2e35"/>
  <circle id="icon-glow" cx="256" cy="256" r="205" fill="url(#glow)"/>
${comment ? `\n  <!-- ${comment} -->\n` : ""}  <g id="icon-mark" clip-path="url(#tile)">
${strandPaths(b, width, paint)}
  </g>
</svg>
`
}

/** Bounding box of every visible piece, inflated by half the pen. */
export function inkBox(b: Built, width: number): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const strand of b.pieces) for (const piece of strand) for (const [x, y] of piece) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y)
  }
  const h = width / 2
  return [x0 - h, y0 - h, x1 + h, y1 + h]
}

/** Largest distance from the tile centre to any ink, for the maskable safe-circle check. */
export function inkRadius(b: Built, width: number): number {
  let r = 0
  for (const strand of b.pieces) for (const piece of strand) for (const [x, y] of piece) r = Math.max(r, Math.hypot(x - 256, y - 256))
  return r + width / 2
}

// ---------------------------------------------------------------------------------------------------
// WOVEN rendering. Each strand is ONE continuous path, and its under-crossings are erased by a mask:
// a black stroke along the OVER strand, (width + 2 * clear) wide, so the gap's edges run parallel to
// the strand on top — the way a woven ribbon is drawn — instead of being round caps square to the
// strand underneath (which reads as a row of separate noodles). Masks live inside the SVG, so the mark
// still renders through currentColor, an <img>, and a CSS mask-image (VS Code's activity bar).

/** The over strand's centreline through a crossing, long enough to clear the under strand at any angle. */
function overSpan(b: Built, c: Crossing, width: number, clear: number, closed: boolean): Vec[] {
  const pts = b.points[c.over]
  const M = pts.length - 1
  const k0 = Math.round(c.u * M)
  const under = b.points[c.under]
  // the crossing angle, from both strands' local tangents
  const t = (p: Vec[], k: number): Vec => {
    const a = p[Math.max(0, k - 2)], z = p[Math.min(M, k + 2)]
    const l = Math.hypot(z[0] - a[0], z[1] - a[1])
    return [(z[0] - a[0]) / l, (z[1] - a[1]) / l]
  }
  const to = t(pts, k0), tu = t(under, k0)
  const sin = Math.max(0.25, Math.abs(to[0] * tu[1] - to[1] * tu[0]))
  const half = (width / 2 + clear) / sin + width * 0.6
  const out: Vec[] = []
  // walk out along the over strand until `half` units of arc each way
  const walk = (dir: number) => {
    let acc = 0
    const seg: Vec[] = []
    for (let k = k0; ; k += dir) {
      const kk = closed ? ((k % M) + M) % M : k
      if (kk < 0 || kk > M) break
      const prev = seg[seg.length - 1]
      if (prev) acc += Math.hypot(pts[kk][0] - prev[0], pts[kk][1] - prev[1])
      seg.push(pts[kk])
      if (acc >= half) break
    }
    return seg
  }
  const back = walk(-1).reverse()
  const fwd = walk(1)
  out.push(...back, ...fwd.slice(1))
  return out
}

export type Woven = { defs: string; body: string }

export function woven(b: Built, spec: Pick<Spec, "width" | "clear" | "centreline">, paint: Paint, idPrefix = "s", indent = "    "): Woven {
  const closed = spec.centreline.closed
  const defs: string[] = []
  const body: string[] = []
  b.points.forEach((pts, i) => {
    const unders = b.crossings.filter((c) => c.under === i)
    const ink = paint.inks[i % paint.inks.length]
    const strand = closed ? `${smoothPath(pts.slice(0, -1).concat([pts[0]]), 22)}Z` : smoothPath(pts, 22)
    if (unders.length === 0) {
      body.push(`${indent}<path d="${strand}" fill="none" stroke="${ink}" stroke-width="${spec.width}" stroke-linecap="round"/>`)
      return
    }
    const cuts = unders.map((c) => smoothPath(overSpan(b, c, spec.width, spec.clear, closed), 18)).join("")
    defs.push(
      `${indent}<mask id="${idPrefix}${i}" maskUnits="userSpaceOnUse" x="-64" y="-64" width="640" height="640">` +
        `<rect x="-64" y="-64" width="640" height="640" fill="#fff"/>` +
        `<path d="${cuts}" fill="none" stroke="#000" stroke-width="${spec.width + 2 * spec.clear}" stroke-linecap="butt"/></mask>`,
    )
    body.push(`${indent}<path d="${strand}" mask="url(#${idPrefix}${i})" fill="none" stroke="${ink}" stroke-width="${spec.width}" stroke-linecap="round"/>`)
  })
  return { defs: defs.join("\n"), body: body.join("\n") }
}

export function wovenTileSvg(b: Built, spec: Spec, paint: Paint = GOLD, comment = ""): string {
  const w = woven(b, spec, paint)
  return wovenTile(w, comment)
}

/** The favicon's tile, border and glow around already-woven paths and their masks. */
export function wovenTile(w: Woven, comment = ""): string {
  return `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    ${TILE_DEFS}
${w.defs}
  </defs>

  <rect id="icon-background" x="16" y="16" width="480" height="480" rx="116" fill="url(#background)"/>
  <rect id="icon-border" x="16.5" y="16.5" width="479" height="479" rx="115.5" fill="none" stroke="#2b2e35"/>
  <circle id="icon-glow" cx="256" cy="256" r="205" fill="url(#glow)"/>
${comment ? `\n  <!-- ${comment} -->\n` : ""}  <g id="icon-mark" clip-path="url(#tile)">
${w.body}
  </g>
</svg>
`
}

/** Three strands in three teals, light to deep, so each can be followed through the weave. */
export const TRI: Paint = { inks: ["#79eedc", "#32d2bd", "#07a897"] }

// ---------------------------------------------------------------------------------------------------
// THE MARK'S CONSTRUCTION

const DEG = Math.PI / 180

/**
 * A plait of `n` crossings `spacing` apart, with `tail` units of straight thread at each end.
 * The phase runs 0 -> 60n degrees; at every multiple of 60 the three strands sit evenly spread at
 * (-0.866A, 0, 0.866A), so the tails leave from an even spread. The phase's RATE eases in and out over
 * `ramp` units, so the strands straighten into their tails rather than kinking.
 */
export type PlaitParams = { n: number; spacing: number; A: number; tail: number; ramp: number; cy?: number; envelope?: number }

export function tailedPlait(o: PlaitParams) {
  const braid = o.n * o.spacing + o.ramp // the ramps lose about ramp/2 each, so add one ramp back
  const total = braid + 2 * o.tail
  const cy = o.cy ?? 256
  const centreline = line([256, cy + total / 2], [256, cy - total / 2])
  // phase table, integrated numerically and normalised to exactly 60n degrees
  const K = 4000
  const rate = (s: number) => {
    const a = s - o.tail, b = o.tail + braid - s
    if (a <= 0 || b <= 0) return 0
    const sm = (x: number) => (x >= o.ramp ? 1 : (x / o.ramp) ** 2 * (3 - 2 * (x / o.ramp)))
    return sm(a) * sm(b)
  }
  const table: number[] = [0]
  for (let k = 1; k <= K; k++) table.push(table[k - 1] + rate(((k - 0.5) / K) * total))
  const scale = (60 * o.n * DEG) / table[K]
  const phase = (s: number) => {
    const x = Math.min(K, Math.max(0, (s / total) * K))
    const k = Math.floor(x)
    const t = x - k
    return (table[k] + t * ((table[Math.min(K, k + 1)] ?? table[K]) - table[k])) * scale
  }
  const offset = (i: number, _u: number, s: number) => {
    const env = o.envelope ? Math.max(0, Math.sin((Math.PI * Math.min(total, Math.max(0, s))) / total)) ** o.envelope : 1
    return o.A * env * Math.sin(phase(s) + (2 * Math.PI * i) / 3)
  }
  return { centreline, offset, total }
}

