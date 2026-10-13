#!/usr/bin/env node
// Eight takes on a stylized lowercase cursive f, rendered at 512/128/64/32/16.
//
// A cursive f is a lucky letterform for this brand: it is already a curl, it is
// already one continuous thread, and it is already the first letter of the name.
// What it is not is favicon-friendly — a written f wants two loops, a crossbar
// and thin hairlines, and the 16px budget affords roughly one of the three.

import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { arcPts, buildAll, chain, ellipsePts, linePts, nibRibbon, resample, smooth } from "./lib.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, "out-f")

// The f's skeleton, terminal to terminal: over the top hook, down the stem,
// round the bottom hook. Hook radii are 64 because a 56 stroke needs 2*64-56 =
// 72 units of counter to stay open at 16px, and 64 is the smallest radius that
// clears that.
const HOOK = 64
const deepTop = (a1 = 386) => arcPts(336, 176, HOOK, a1, 180)
const shallowTop = () => arcPts(336, 176, HOOK, 340, 180)
const deepBottom = (a1 = 218) => arcPts(172, 336, HOOK, 0, a1)
const shallowBottom = () => arcPts(172, 336, HOOK, 0, 190)

const integralSpine = chain(deepTop(), linePts([272, 176], [236, 336]), deepBottom())
const florinSpine = chain(shallowTop(), linePts([272, 176], [236, 336]), shallowBottom())

// The two-loop written f. Hand-picked waypoints rather than arcs: the ascender
// loop, the stem and the descender loop have to cross each other, and a chain of
// tangent arcs cannot be made to cross without fighting it.
const writtenSpine = [
  [352, 148], [326, 112], [278, 106], [246, 140], [248, 190],
  [268, 244], [274, 300], [262, 356], [232, 402], [190, 414],
  [156, 392], [162, 352], [206, 338], [268, 330], [316, 306],
]

// A true cursive ascender loop: tall and narrow, which is what a hand actually
// writes. rx has to stay near 52 or the loop stops looking written and starts
// looking like a ring on a stick — and 2*52-56 = 48 units of counter is 1.5px,
// under the floor. This variant exists to show that arithmetic, not to win.
const ascenderLoop = ellipsePts(296, 180, 52, 80, 100, -240)
const ascenderSpine = chain(deepBottom(218).slice().reverse(), linePts([236, 336], ascenderLoop[0]), ascenderLoop)

const uprightSpine = chain(
  arcPts(316, 176, HOOK, 336, 180),
  linePts([252, 176], [252, 336]),
  arcPts(196, 336, 56, 0, 100),
)



const concepts = [
  {
    id: "f-integral",
    name: "Integral",
    rank: "pick",
    tagline: "The f as one unbroken thread",
    idea: "The cursive f stripped to its spine — a hook over the top, a leaning stem, a hook under the bottom, and no crossbar. It is the integral sign, and it is also exactly the Curl mark from the last round, only now it spells the first letter of the name.",
    small: "Holds. Both hooks are open rather than closed, so there is no counter that can seal — the failure mode of every other f here.",
    risk: "Without the crossbar some people will read it as an integral or a long s rather than an f. That ambiguity is the price of the legibility.",
    verdict: "The one f that needs no compromise at 16px. Says the name, says the product, and degrades to a clean S-curve rather than to a blob.",
    mark: `<path d="${smooth(integralSpine)}" stroke-width="56"/>`,
  },
  {
    id: "f-florin",
    name: "Florin",
    rank: "pick",
    tagline: "An unmistakable f — crossbar and all",
    idea: "The classic ƒ. The crossbar is what makes the letter read as an f instead of an integral, so this is the version that actually carries the name.",
    small: "Holds, but only because both hooks were made shallow. A crossbar cannot coexist with a hook that curls back down — see the note below.",
    risk: "Three horizontal bands (hook, crossbar, hook) inside 320 units is the tightest arrangement in either sheet. There is no room left to adjust anything.",
    verdict: "The safest way to be legibly an f. Buy that legibility by keeping the hooks shallow, which costs some of the cursive flourish.",
    // The deep hook of the Integral drops its right-hand limb to y=240, exactly
    // where a crossbar has to sit. Trimming both hooks lifts that limb to y=142
    // and buys the crossbar 79 units of clearance.
    mark: `<path d="${smooth(florinSpine)}" stroke-width="56"/>
      <path d="M180 256 H300" stroke-width="52"/>`,
  },
  {
    id: "f-loop",
    name: "Written",
    rank: "maybe",
    tagline: "The f as handwriting",
    idea: "The descender closes into a real loop and crosses the stem, the way a hand actually writes an f. The most human mark in either sheet.",
    small: "The loop's counter survives at 76 units, but the crossing where the loop meets the stem fuses into a solid mass.",
    risk: "The charm is entirely in the crossing, and the crossing is the first thing to go.",
    verdict: "Beautiful large, muddy small. Worth it only if the favicon is allowed to be a simplified version of the logo.",
    mark: `<path d="${smooth(writtenSpine)}" stroke-width="56"/>`,
  },
  {
    id: "f-upright",
    name: "Upright",
    rank: "maybe",
    tagline: "A quieter f that never leans",
    idea: "A single-storey f with a straight stem, a shallow top hook and a descender that curls left. Barely cursive — this is the version that would sit comfortably next to body text in a wordmark.",
    small: "The most stable f here. Nothing crosses, nothing closes, and the crossbar has 84 units of clearance.",
    risk: "Loses the thread metaphor almost entirely. At this point it is a letter, not a mark.",
    verdict: "The conservative pick. Take it if the icon has to work as a lockup with the word Ntwine beside it.",
    mark: `<path d="${smooth(uprightSpine)}" stroke-width="56"/>
      <path d="M176 252 H332" stroke-width="52"/>`,
  },
  {
    id: "f-ascender",
    name: "Ascender",
    rank: "no",
    tagline: "The properly written f, and why you cannot have it",
    idea: "The tall narrow ascender loop a hand actually writes, rather than the wide circle that survives shrinking. This is the most genuinely cursive f on the page.",
    small: "Fails, and the arithmetic says so before the render does: a written ascender loop is about 52 units wide, so its counter is 2x52-56 = 48 units, which is 1.5px. It seals.",
    risk: "Widening the loop until the counter clears turns it into a ring on a stick — that is the shape this slot held for two drafts before the measurement explained why it kept looking wrong.",
    verdict: "Ruled out by measurement. Worth knowing: a real cursive loop and a favicon are mutually exclusive, so every workable f here is a hooked f, not a looped one.",
    mark: `<path d="${smooth(ascenderSpine)}" stroke-width="56"/>`,
  },
  {
    id: "f-calligraphic",
    name: "Calligraphic",
    rank: "maybe",
    tagline: "Drawn with a broad nib, not a pen of one width",
    idea: "The Integral spine run through a real broad-nib model: the stroke swells where it travels across the nib and thins where it travels along it. This is what actually separates a drawn logo from a stroked one.",
    small: "Survives only because the thins are floored at 54 units. A true nib would take them to nothing, and nothing is invisible well before 16px.",
    risk: "The floor flattens the contrast that makes calligraphy worth doing, so the small render is noticeably duller than the hero.",
    verdict: "The most crafted mark here and the most expensive to maintain — every future weight has to be redrawn, not restroked.",
    mark: `<path d="${nibRibbon(resample(integralSpine, 5), { penAngle: -35, wMax: 96, wMin: 54, taper: 14 })}" fill="url(#ink)" stroke="none"/>`,
  },
  {
    id: "f-reversed",
    name: "Reversed",
    rank: "pick",
    tagline: "The same f, knocked out of solid amber",
    idea: "Not a new drawing — the Integral f as a hole in a filled amber tile. Treatment rather than form, and the one variable on this page that changes how visible the icon is rather than what it says.",
    small: "The strongest thing here in an actual tab strip. A solid amber tile carries far more of the 16x16 than a thin amber line on near-black does, so it holds its place among other favicons instead of receding.",
    risk: "Loud. It will be the brightest tile in the tab strip, on every tab, forever — and knocked-out counters need to run wider than positive ones to read, so the letter has to be redrawn slightly heavier, not just recoloured.",
    verdict: "Worth testing against any form you pick. This is a question about contrast, and it is separable from the question of which f.",
    invert: true,
    mark: `<path d="${smooth(integralSpine)}" stroke-width="60"/>`,
  },
  {
    id: "f-ntwineed",
    name: "Ntwineed",
    rank: "no",
    tagline: "The f with the ntwine made literal",
    idea: "The Integral f with fibres springing off the top terminal — the old rope mark's idea grafted onto the new letter.",
    small: "Fails, and it fails for exactly the reason the outgoing icon does: the fibres are drawn light to stay subordinate to the letter, and light means gone.",
    risk: "None worth listing. This is the mistake the current icon already makes, repeated in a new shape.",
    verdict: "Included as the control. It is the proof that the ntwine cannot be depicted at favicon size — it has to be implied by the curl of the letter itself.",
    mark: `<path d="${smooth(integralSpine)}" stroke-width="56"/>
      <path d="M392 196 C424 168 436 138 430 110" stroke-width="34"/>
      <path d="M386 186 C404 148 400 116 384 96" stroke-width="34"/>`,
  },
]

const count = buildAll(concepts, outDir, [["current", join(here, "../../packages/web/public/favicon.svg")]])
console.log(concepts.map((c) => c.id).join(" "))
console.log(`generated ${count} cursive-f concepts`)
