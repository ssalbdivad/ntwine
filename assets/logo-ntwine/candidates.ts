// Round five: a CONTAINED plait, because the mark also has to stand alone with no tile to crop it (the
// VS Code activity bar, the site's hero, the social card) and the maskable icon must keep its ink inside
// the safe circle. The question is how the plait ends.
import { line, TRI, type Vec } from "./lib.ts"
import type { Candidate } from "./concepts.ts"

const TAU = 2 * Math.PI
const DEG = Math.PI / 180

/**
 * A plait of `n` crossings `spacing` apart, with `tail` units of straight thread at each end.
 * The phase runs 0 -> 60n degrees; at every multiple of 60 the three strands sit evenly spread at
 * (-0.866A, 0, 0.866A), so the tails leave from an even spread. The phase's RATE eases in and out over
 * `ramp` units, so the strands straighten into their tails rather than kinking.
 */
export function tailedPlait(o: { n: number; spacing: number; A: number; tail: number; ramp: number; cy?: number; envelope?: number }) {
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
    return o.A * env * Math.sin(phase(s) + (TAU * i) / 3)
  }
  return { centreline, offset, total }
}

const mk = (id: string, title: string, note: string, o: Parameters<typeof tailedPlait>[0], width: number, clear: number, tri = false): Candidate => {
  const p = tailedPlait(o)
  return { id, title, note, spec: { centreline: p.centreline, strands: 3, offset: p.offset, rule: "plait", width, clear }, woven: true, paint: tri ? TRI : undefined }
}

export const candidates: Candidate[] = [
  mk("v1", "Long ramp, long tails", "", { n: 3, spacing: 78, A: 126, tail: 40, ramp: 96 }, 56, 22),
  mk("v2", "Short ramp, long tails", "", { n: 3, spacing: 78, A: 126, tail: 40, ramp: 40 }, 56, 22),
  mk("v3", "Four crossings, long ramp", "", { n: 4, spacing: 64, A: 122, tail: 34, ramp: 80 }, 50, 20),
  mk("v4", "Three crossings, envelope", "Amplitude eases toward the tails so the outer strands do not bulge.", { n: 3, spacing: 78, A: 134, tail: 36, ramp: 70, envelope: 0.35 }, 56, 22),
]
