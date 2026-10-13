// Every direction tried for the ntwine mark, round by round, with what each round taught.
// `nub assets/logo-ntwine/concepts.ts` renders them all into ntwine-concepts.html.
import { arch, circle, line, smoothstep, tailedPlait, TRI, type PlaitParams, type Spec } from "./lib.ts"

export type Candidate = { id: string; title: string; note: string; spec: Spec; paint?: { inks: string[] }; woven?: boolean }
export type Round = { title: string; finding: string; candidates: Candidate[] }

const TAU = 2 * Math.PI
/** Three strands, 120 degrees apart, along an open centreline measured in units of arc length. */
const sine = (A: number, L: number, n = 3, shift = 0) => (i: number, _u: number, s: number) => A * Math.sin((TAU * s) / L + (TAU * i) / n + shift)
const ringSine = (A: number, k: number) => (i: number, u: number) => A * Math.sin(TAU * k * u + (TAU * i) / 3)
/** The weave away from the ends; the ends settle into three parallel threads `spread` apart. */
const settle = (A: number, L: number, spread: number, a: number, b: number, shift = 0) => (i: number, u: number, s: number) => {
  const e = Math.max(1 - smoothstep(a, b, u), smoothstep(1 - b, 1 - a, u))
  return (1 - e) * A * Math.sin((TAU * s) / L + (TAU * i) / 3 + shift) + e * (i - 1) * spread
}
/** Exact circles of radius rho, centres d from the middle at 120 degrees, as offsets from a circle of radius R. */
const rings = (R: number, rho: number, d: number) => (i: number, u: number) => {
  const a = TAU * u - (TAU * i) / 3
  return d * Math.cos(a) + Math.sqrt(rho * rho - d * d * Math.sin(a) ** 2) - R
}
const V = line([256, 560], [256, -48])
const VV = line([256, 600], [256, -88])
const D = line([40, 472], [472, 40])
const plait = (id: string, title: string, note: string, o: PlaitParams, width: number, clear: number, tri = false): Candidate => {
  const p = tailedPlait(o)
  return { id, title, note, spec: { centreline: p.centreline, strands: 3, offset: p.offset, rule: "plait", width, clear }, woven: true, paint: tri ? TRI : undefined }
}

export const rounds: Round[] = [
  {
    title: "Round one: twelve directions, gaps as round-capped cuts",
    finding:
      "Plaits, ropes, rings and an n. Cutting the under strand and capping the cut round turned every weave into a row of separate noodles, " +
      "and at a shallow crossing the cut ran so long that little of a strand was left. The rope ring is too close to OpenAI's mark. " +
      "Nothing here reads as entwined threads at 16px.",
    candidates: [
      { id: "1a", title: "Plait, bleeding off", note: "Outer strand laid over the middle; runs off the tile.", spec: { centreline: V, strands: 3, offset: sine(118, 430), rule: "plait", width: 52, clear: 24 } },
      { id: "1b", title: "Plait, contained", note: "", spec: { centreline: line([256, 420], [256, 92]), strands: 3, offset: sine(104, 400, 3, 0.5), rule: "plait", width: 50, clear: 24 } },
      { id: "1c", title: "Plait, diagonal", note: "", spec: { centreline: D, strands: 3, offset: sine(92, 380), rule: "plait", width: 46, clear: 22 } },
      { id: "1d", title: "Rope, diagonal", note: "Each strand in front while it travels one way: a helix.", spec: { centreline: D, strands: 3, offset: sine(92, 380), rule: "rope", width: 46, clear: 22 } },
      { id: "1e", title: "Rope, vertical", note: "", spec: { centreline: V, strands: 3, offset: sine(118, 430), rule: "rope", width: 52, clear: 24 } },
      { id: "1f", title: "Lanes into a braid", note: "", spec: { centreline: line([256, 540], [256, -28]), strands: 3, offset: settle(104, 330, 118, 0.12, 0.34), rule: "plait", width: 46, clear: 22 } },
      { id: "1g", title: "Braided ring", note: "Closed plait, two periods.", spec: { centreline: circle([256, 256], 150), strands: 3, offset: ringSine(62, 2), rule: "plait", width: 40, clear: 20 } },
      { id: "1h", title: "Ring, one period", note: "", spec: { centreline: circle([256, 256], 70), strands: 3, offset: ringSine(110, 1), rule: "plait", width: 46, clear: 24 } },
      { id: "1i", title: "Rope ring", note: "", spec: { centreline: circle([256, 256], 150), strands: 3, offset: ringSine(62, 2), rule: "rope", width: 40, clear: 20 } },
      { id: "1j", title: "Entwined n", note: "", spec: { centreline: arch(256, 112, 540, 112), strands: 3, offset: sine(42, 250), rule: "plait", width: 32, clear: 16 } },
      { id: "1k", title: "Braided ring, three periods", note: "", spec: { centreline: circle([256, 256], 152), strands: 3, offset: ringSine(52, 3), rule: "plait", width: 34, clear: 16 } },
      { id: "1l", title: "Plait, broad", note: "", spec: { centreline: VV, strands: 3, offset: sine(132, 560, 3, 0.3), rule: "plait", width: 64, clear: 30 } },
    ],
  },
  {
    title: "Round two: woven gaps",
    finding:
      "The gap is now a mask drawn along the strand on TOP, so its edges run parallel to that strand, the way a woven ribbon is drawn. " +
      "Every weave became legible at 180 and above. The plait reads as a braid; the rope as rope or DNA; three exact circles as Borromean rings, " +
      "which are entwined but are rings, not threads. The n built from strands is a good arch at 16px and a tangle at 512.",
    candidates: [
      { id: "2a", title: "Plait, contained", note: "", spec: { centreline: line([256, 432], [256, 80]), strands: 3, offset: sine(116, 360, 3, 0.5), rule: "plait", width: 42, clear: 12 }, woven: true },
      { id: "2b", title: "Plait, contained, three golds", note: "", spec: { centreline: line([256, 432], [256, 80]), strands: 3, offset: sine(116, 360, 3, 0.5), rule: "plait", width: 42, clear: 12 }, woven: true, paint: TRI },
      { id: "2c", title: "Plait, bleeding", note: "", spec: { centreline: V, strands: 3, offset: sine(120, 330), rule: "plait", width: 42, clear: 12 }, woven: true },
      { id: "2d", title: "Rope", note: "", spec: { centreline: V, strands: 3, offset: sine(112, 420), rule: "rope", width: 46, clear: 12 }, woven: true },
      { id: "2e", title: "Borromean rings", note: "", spec: { centreline: circle([256, 256], 120), strands: 3, offset: rings(120, 116, 74), rule: "plait", width: 44, clear: 12 }, woven: true },
      { id: "2f", title: "n, rope, one slow twist", note: "", spec: { centreline: arch(256, 118, 420, 102), strands: 3, offset: sine(44, 560, 3, 0.9), rule: "rope", width: 40, clear: 11 }, woven: true },
      { id: "2g", title: "n, rope, three threads at the feet", note: "", spec: { centreline: arch(256, 112, 424, 108), strands: 3, offset: settle(46, 520, 34, 0.02, 0.2, 0.9), rule: "rope", width: 32, clear: 10 }, woven: true },
      { id: "2h", title: "n, plait, three threads at the feet", note: "", spec: { centreline: arch(256, 112, 424, 108), strands: 3, offset: settle(48, 380, 34, 0.02, 0.2, 0.9), rule: "plait", width: 32, clear: 10 }, woven: true },
    ],
  },
  {
    title: "Round three: the plait, tuned for 16px",
    finding:
      "Fewer, larger crossings keep a zigzag at 16px. A bleeding plait is the strongest picture inside the tile, but the mark also has to stand " +
      "alone — the VS Code activity bar, the site's hero, the social card — and a plait that runs off the edge has nothing to end on there. " +
      "It also puts ink outside the maskable icon's safe circle.",
    candidates: [
      { id: "3a", title: "Broad chevrons", note: "", spec: { centreline: VV, strands: 3, offset: sine(138, 470, 3, 0.3), rule: "plait", width: 56, clear: 14 }, woven: true },
      { id: "3b", title: "Medium", note: "", spec: { centreline: VV, strands: 3, offset: sine(128, 410, 3, 0.3), rule: "plait", width: 50, clear: 13 }, woven: true },
      { id: "3c", title: "Medium, three golds", note: "", spec: { centreline: VV, strands: 3, offset: sine(128, 410, 3, 0.3), rule: "plait", width: 50, clear: 13 }, woven: true, paint: TRI },
      { id: "3d", title: "Diagonal", note: "", spec: { centreline: line([20, 492], [492, 20]), strands: 3, offset: sine(118, 420, 3, 0.3), rule: "plait", width: 50, clear: 13 }, woven: true },
    ],
  },
  {
    title: "Round four: a contained plait, and how it ends",
    finding:
      "Loose threads at both ends: three threads come in, plait, and leave as three — the brief's n threads, entwined. Three crossings is the " +
      "fewest that still reads as a plait and the only count whose two big X's survive 16px. A spindle (gathered to points) reads as a leaf or a flame.",
    candidates: [
      plait("4a", "Four crossings, tails", "", { n: 4, spacing: 80, A: 132, tail: 30, ramp: 56 }, 54, 16),
      plait("4b", "Four crossings, tails, three golds", "", { n: 4, spacing: 80, A: 132, tail: 30, ramp: 56 }, 54, 16, true),
      plait("4c", "Five crossings, tails", "", { n: 5, spacing: 66, A: 126, tail: 26, ramp: 48 }, 48, 14),
      plait("4d", "Three crossings, tails", "", { n: 3, spacing: 96, A: 140, tail: 28, ramp: 64 }, 60, 18),
      plait("4e", "Six crossings, no tails", "", { n: 6, spacing: 58, A: 122, tail: 6, ramp: 40 }, 46, 14),
      plait("4f", "Spindle", "", { n: 6, spacing: 62, A: 150, tail: 0, ramp: 1, envelope: 0.7 }, 46, 13),
    ],
  },
  {
    title: "Round five: three crossings, pen, gap and ramp",
    finding:
      "Wider gaps (about 0.7px at 16px) beat a heavier pen. A short ramp (40) leaves a visible corner where a tail meets the weave; a long one " +
      "(96) does not. Easing the amplitude into the tails merges the threads into a blob. Three golds read beautifully at 512 and add noise at 16; " +
      "one gold matches the shipped tile. The final mark is 5a's geometry, scaled to a 404-unit ink height.",
    candidates: [
      plait("5a", "Long ramp, long tails", "Chosen.", { n: 3, spacing: 78, A: 126, tail: 40, ramp: 96 }, 56, 22),
      plait("5b", "Short ramp, long tails", "", { n: 3, spacing: 78, A: 126, tail: 40, ramp: 40 }, 56, 22),
      plait("5c", "Three crossings, wider gaps", "", { n: 3, spacing: 84, A: 136, tail: 22, ramp: 56 }, 58, 23),
      plait("5d", "Three crossings, heavy", "", { n: 3, spacing: 86, A: 134, tail: 20, ramp: 56 }, 66, 22),
      plait("5e", "Three crossings, three golds", "", { n: 3, spacing: 84, A: 136, tail: 22, ramp: 56 }, 58, 20, true),
      plait("5f", "Four crossings, long ramp", "", { n: 4, spacing: 64, A: 122, tail: 34, ramp: 80 }, 50, 20),
      plait("5g", "Amplitude eased into the tails", "", { n: 3, spacing: 78, A: 134, tail: 36, ramp: 70, envelope: 0.35 }, 56, 22),
    ],
  },
]
