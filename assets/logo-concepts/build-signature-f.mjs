#!/usr/bin/env node
// The written cursive f: ONE contiguous stroke with exactly two free ends, and
// exactly 180-degree rotationally symmetric.
//
// The reference sketch has two loose ends and nothing else. Reading it as a
// closed figure-eight with a crossbar laid across it — which is what an earlier
// draft did — gets the topology wrong, and the result reads as an 8 with a line
// through it because that is literally what it is. The real path is:
//
//   left tail -> UP into the ascender -> apex -> down across the middle
//             -> round the descender -> out to the right tail
//
// The direction matters as much as the topology. Entering from the left the
// stroke must rise up-and-RIGHT into the ascender, so the first thing it does is
// swoop up. Running the loop the other way round hides that rise inside the
// crossing and the letter reads as swooping down first.
//
// The apparent "crossbar" is not a stroke at all. It is the long entry and exit
// diagonals, which leave the letter on opposite sides at mirrored heights and so
// line up into what looks like one bar crossing the middle.
//
// C2 then falls out of the same fact that makes the letter work: the descender
// half IS the ascender half rotated. So only one half is authored — from the
// centre of symmetry out to one tail tip — and c2() derives the rest. Nothing
// is drawn twice, so nothing can be slightly off.

import { writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { buildAll, c2, nibRibbon, render, smooth, svg, symmetryError } from "./lib.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, "out-sig")

const CX = 256
const CY = 256 // the symmetry centre must be the canvas centre, or the RENDER is not C2

/**
 * Half the stroke: from the centre of symmetry, up the ascender's left side,
 * over the apex, down its right side, and out along the diagonal to the LEFT
 * tail tip. c2() supplies the descender half and the right tail.
 *
 * The centre is the point the whole path maps onto itself through, and it sits
 * on the diagonal rather than at a pinch between the loops — that is the
 * difference between a flowing written letter and a mathematical figure-eight.
 *
 * `loop` widens the ascender about its own axis without stretching the tails, so
 * a heavier weight can open its counters without the terminals growing with it.
 */
function halfStroke({ loop = 1, tail = 1, shear = 0.16 } = {}) {
  // Up the ascender's left side, over the apex, and back down the right — and
  // crucially the descending branch keeps going PAST the centre before it peels
  // off into the tail. That overrun is what makes the two loops overlap into a
  // long narrow X instead of meeting at a pinch, and the pinch is what made
  // every earlier draft read as a figure-eight.
  const curl = [
    [250, 232], [242, 206], [232, 178], [225, 148], [222, 118], // up the LEFT side
    [226, 92], [236, 72], [252, 58], // over the apex
    [270, 64], [284, 84], [293, 110], [297, 142], [297, 174], [292, 204], // down the RIGHT side
    [282, 232], [268, 258], // past the centre: the overlap with the descender
  ]
  // The tail leaves the descending right-hand branch and runs down-LEFT across
  // the letter. Read the other way — which is how you read handwriting — the
  // stroke enters from the left and rises up-and-RIGHT into the ascender, so the
  // first thing it does is swoop up. Leaving the loop the other way round hides
  // that rise inside the crossing and the letter reads as swooping down first.
  //
  // This long diagonal and its C2 partner are also what looks like a crossbar.
  const tails = [[250, 282], [224, 300], [190, 310], [152, 314], [118, 316]]
  const points = [
    [CX, CY],
    ...curl.map(([x, y]) => [CX + (x - CX) * loop, y]),
    ...tails.map(([x, y]) => [CX + (x - CX) * tail, y]),
  ]
  // Shear last, about the centre. A shear is linear, and linear maps commute
  // with the point reflection, so slanting the letter like handwriting cannot
  // cost it any symmetry.
  return points.map(([x, y]) => [x + shear * (CY - y), y])
}

const spine = (opts) => c2(halfStroke(opts), CX, CY)
const body = (opts) => smooth(spine(opts))

const FINE = 16 // the sketch's line is about 2.5% of the letter's height

const concepts = [
  {
    id: "sig-c2",
    name: "Signature",
    rank: "pick",
    symmetric: true,
    tagline: "One stroke, two free ends, symmetric under a half turn",
    idea: "A single contiguous line. It enters from the left and swoops UP first, rising to the right into the ascender, over the apex, back down across the middle, round the descender, and out to the right. There is no crossbar — what looks like one is the long entry and exit diagonals, which leave on opposite sides at mirrored heights and line up. Every crossing is the stroke meeting itself.",
    small: "Fails, and not narrowly. A 16-unit line is 0.5px at 16px — the counters are fine at 60 units (1.9px), but the stroke drawing them is half a pixel wide. This weight is a logo, full stop.",
    risk: "Symmetry costs the letter some handwriting: a real hand makes the descender bigger than the ascender, and forbidding that makes the f a little more even than the sketch.",
    verdict: "The sketch's actual topology and its actual direction of travel. One path, two terminals, and the bar is an artefact of the diagonals rather than a part laid on top.",
    mark: `<path d="${body()}" stroke-width="${FINE}"/>`,
  },
  {
    id: "sig-c2-open",
    name: "Longer tails",
    rank: "pick",
    symmetric: true,
    tagline: "The same stroke, tails run further out",
    idea: "Identical letter with the terminals extended. The further the tails run, the more the pair reads as a deliberate crossbar and the less it reads as two loose ends — the sketch sits somewhere in this range, so it is worth seeing both limits.",
    small: "Fails at this weight like every fine variant. The tails survive longest, being the only near-horizontal ink.",
    risk: "Long tails need horizontal room, so this wants to be a wide lockup rather than a square tile.",
    verdict: "Use this if the mark will usually sit beside the word ntwine; the tails give the wordmark a line to sit on.",
    mark: `<path d="${body({ tail: 1.3 })}" stroke-width="${FINE}"/>`,
  },
  {
    id: "sig-c2-contrast",
    name: "Pen contrast",
    rank: "pick",
    symmetric: true,
    tagline: "Thick where the pen presses, and still one stroke",
    idea: "The same single path through a broad-nib model, so the weight swells on the outsides of the loops and thins through the crossings — the texture the sketch actually has. A nib is C2-safe: rotating a stroke reverses its tangent, and the nib width depends on the sine of tangent-minus-pen, which that reversal leaves unchanged.",
    small: "Fails at this weight, but fails last — the heavy outsides of the loops are the final thing to survive.",
    risk: "Contrast has to be redrawn for every weight; you cannot restroke your way to a bolder version.",
    verdict: "Closest to the sketch of anything here, and the same symmetry guarantee as the monoline versions.",
    mark: `<path d="${nibRibbon(spine(), { penAngle: -38, wMax: 40, wMin: 11, taper: 8 })}" fill="url(#ink)" fill-rule="evenodd" stroke="none"/>`,
  },
  {
    id: "sig-c2-medium",
    name: "Middleweight",
    rank: "pick",
    symmetric: true,
    tagline: "Heavier line, loops opened to match",
    idea: "A 30 stroke with the curls widened 1.3x so the counters keep pace. Included to locate the cliff by measurement rather than by assumption.",
    small: "Marginal, and this is where the cliff sits: 30 units is 0.94px of stroke, still under the floor, though the widened counters clear it at 69 units (2.2px).",
    risk: "Neither as fine as the signature nor as solid as the bold. Compromises tend to lose both arguments.",
    verdict: "The lightest weight with any chance in a tab, and the heaviest that still looks written.",
    mark: `<path d="${body({ loop: 1.3 })}" stroke-width="30"/>`,
  },
  {
    id: "sig-c2-bold",
    name: "Bold",
    rank: "maybe",
    symmetric: true,
    tagline: "The weight a 16px tab can hold",
    idea: "A 44 stroke with the curls widened 1.85x. Weight and loop width have to move together — a heavier line needs wider counters or the loops fill in.",
    small: "Holds. The 44 stroke is 1.4px and the widened counters reach 97 units — 3.0px, the only comfortable margin on this sheet.",
    risk: "Widening the curls this far rounds them out, and the letter drifts back toward the figure-eight look the fine weights avoid.",
    verdict: "Legible small, less like the sketch. If one drawing has to do everything, this is the cost.",
    mark: `<path d="${body({ loop: 1.85, tail: 0.9 })}" stroke-width="44"/>`,
  },
  {
    id: "sig-c2-knockout",
    name: "Knocked out",
    rank: "maybe",
    symmetric: true,
    invert: true,
    tagline: "The bold stroke reversed out of solid amber",
    idea: "Same single path as a hole in a filled tile. Treatment rather than form — the one variable here that changes how visible the icon is rather than what it says.",
    small: "Carries far more of the 16x16 than a thin line on near-black, so it holds its place in a tab strip instead of receding.",
    risk: "Loud on every tab, forever. Knocked-out counters read narrower than positive ones, so it is drawn a little heavier.",
    verdict: "Worth testing head to head with the positive version once the form is settled.",
    mark: `<path d="${body({ loop: 1.9, tail: 0.88 })}" stroke-width="48"/>`,
  },
  {
    id: "sig-c2-tight",
    name: "More slant",
    rank: "maybe",
    symmetric: true,
    tagline: "The same letter leaning harder",
    idea: "Shear pushed from 0.16 to 0.3. Slant is what makes handwriting look fast, and shearing is free of symmetry cost — this is the far end of that range so the sketch's own lean can be placed against it.",
    small: "Fails at this weight like every fine variant.",
    risk: "Past about 0.3 the ascender starts to overhang the tail and the letter looks like it is falling over.",
    verdict: "The most written of the set. Compare against the default lean and pick a point between them.",
    mark: `<path d="${body({ shear: 0.3 })}" stroke-width="16"/>`,
  },
  {
    id: "sig-c2-notails",
    name: "No tails (control)",
    rank: "no",
    symmetric: true,
    tagline: "The letter with its terminals cut off",
    idea: "The same stroke with the tails removed, to show how much of the letter they carry. This is the control for the previous draft's mistake.",
    small: "Irrelevant — it fails as a letter before it fails as a favicon.",
    risk: "None; it is a control, not a candidate.",
    verdict: "This is the shape the last draft was building, and it is exactly the thing that reads as a figure-eight. The tails are not decoration; they are what makes it an f.",
    mark: `<path d="${smooth(c2(halfStroke().slice(0, 18), CX, CY))}" stroke-width="${FINE}"/>`,
  },
]

const count = buildAll(concepts, outDir, [["current", join(here, "../../packages/web/public/favicon.svg")]])

// Controls for the symmetry metric. Without these the per-mark numbers mean
// nothing: you cannot tell a symmetric mark from a nearly-symmetric one until
// you know what the rasteriser's own floor is, and what a real, small
// asymmetry actually costs.
const CONTROLS = [
  ["a circle centred on the canvas — symmetric by definition", `<circle cx="256" cy="256" r="150" stroke-width="56"/>`],
  ["the empty tile, no mark at all", `<circle cx="256" cy="256" r="0" stroke-width="0"/>`],
  ["the same circle moved 4 units off centre", `<circle cx="260" cy="256" r="150" stroke-width="56"/>`],
]
const controls = CONTROLS.map(([label, mark], index) => {
  const id = `control-${index}`
  const source = join(outDir, `${id}.svg`)
  writeFileSync(source, svg({ mark, symmetric: true }))
  render(source, join(outDir, `${id}-512.png`), 512)
  return { label, error: symmetryError(join(outDir, `${id}-512.png`)) }
})
writeFileSync(join(outDir, "controls.json"), JSON.stringify(controls, null, 2))

// The proof image: the mark beside its own 180-degree rotation.
const proof = spawnSync("magick", [
  join(outDir, "sig-c2-512.png"), "-rotate", "180", join(outDir, "sig-c2-rotated-512.png"),
])
if (proof.status !== 0) throw new Error("could not build the rotation proof")

for (const c of concepts) console.log(`${c.id.padEnd(20)} symmetry error ${c.symmetryError.toExponential(2)}`)
for (const c of controls) console.log(`  control: ${c.label} — ${c.error.toExponential(2)}`)
console.log(`generated ${count} contiguous-stroke signature-f concepts`)
