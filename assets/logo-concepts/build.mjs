#!/usr/bin/env node
// Fifteen directions for the mark after the fray -> ntwine rename, drawn as real
// geometry and rendered at 512/128/64/32/16 so each is judged at the size it has
// to survive. Shared geometry and rendering live in ./lib.mjs.

import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { CASING, bowedRay, buildAll, corkscrew, fit, sineY, smooth, braid } from "./lib.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, "out")

// ------------------------------------------------------------------- concepts
// `mark` is the inner SVG for the glyph. Stroked paths inherit the gradient and
// round caps from the wrapping <g>.

const concepts = [
  {
    id: "fan",
    name: "Fan",
    tagline: "One prompt becomes many agents",
    idea: "The product's core motion read bottom-up — a single trunk splitting into three that sweep out and away.",
    small: "Holds. Tips sit 136 units apart on a 54 stroke, so the gaps stay above 2px.",
    risk: "The most expected shape in the set. A Y-with-branches is close to a rune and to a dozen other dev-tool marks.",
    mark: `
      <path d="M256 428 V292" stroke-width="54"/>
      <path d="M256 302 C256 216 208 178 120 148" stroke-width="54"/>
      <path d="M256 302 V116" stroke-width="54"/>
      <path d="M256 302 C256 216 304 178 392 148" stroke-width="54"/>`,
  },
  {
    id: "converge",
    name: "Converge",
    tagline: "Many agents come back to one queue",
    idea: "The truer half of ntwine. Work fans out, but the whole point of the app is that it all returns to one place you read top to bottom. Three strands run parallel, then merge low into a single root.",
    small: "Holds, and better than the fan — three parallel bars merging is a stable silhouette.",
    risk: "Splaying the arms straight makes it an aeroplane; the merge has to stay low and the bend has to stay soft.",
    mark: `
      <path d="M120 108 V208 C120 296 256 268 256 348" stroke-width="54"/>
      <path d="M256 108 V428" stroke-width="54"/>
      <path d="M392 108 V208 C392 296 256 268 256 348" stroke-width="54"/>`,
  },
  {
    id: "curl",
    name: "Curl",
    tagline: "ntwine, literally — one strand curling",
    idea: "A closed loop and one tail sweeping the other way — a tendril, not a numeral.",
    small: "Holds. The counter is 132 units across, so the hole stays open — though at exactly 16px it reads as a notch rather than a clean round hole.",
    risk: "Drawn with the tail on the loop's left it is unmistakably a 6, and no amount of tilt fixes that. The tail has to leave from the right and sweep back across, which is the whole design.",
    mark: `
      <g transform="rotate(18 256 256)">
        <circle cx="256" cy="326" r="94" stroke-width="56" fill="none"/>
        <path d="M350 320 C360 212 306 142 178 112" stroke-width="56"/>
      </g>`,
  },
  {
    id: "knot",
    name: "Knot",
    tagline: "Two strands, tied",
    idea: "A single overhand loop with two tails crossing below it. The one mark here with genuine craft in it at hero size.",
    small: "Fails. The crossings merge and the two tails close up into a capital A. Measured, not predicted — the 16px render is below.",
    risk: "Meaning fights the product: a knot says tangled and stuck, which is the state ntwine exists to prevent.",
    mark: `
      <path d="M166 426 V308 C166 214 268 186 302 250 C328 300 264 344 232 300" stroke-width="54"/>
      <path d="M346 426 V308 C346 214 244 186 210 250 C184 300 248 344 280 300" stroke="${CASING}" stroke-width="76"/>
      <path d="M346 426 V308 C346 214 244 186 210 250 C184 300 248 344 280 300" stroke-width="54"/>`,
  },
  {
    id: "twist",
    name: "Twist",
    tagline: "Parallel work, one cord",
    idea: "Two strands running in parallel and staying wound together — a real over-under weave, not two mirrored waves.",
    small: "Marginal. The casings close up as intended, but what is left is a knobbly column closer to a dollar sign than a cord.",
    risk: "Antiphase strands of equal weight make lens shapes that read as a stack of 8s; the alternating weave is what stops that.",
    mark: braid({ y0: 116, y1: 400, cx: 256, amp: 62, period: 184, width: 52 }),
  },
  {
    id: "spark",
    name: "Spark",
    tagline: "ntwine as static — everything going at once",
    idea: "Six bowed fibres from a common origin. Bowed, not straight, so it reads as hair with a charge in it rather than a sparkle or an asterisk.",
    small: "Holds. Radial symmetry is the friendliest thing you can hand a 16px box — there is no wrong orientation and no dead corner.",
    risk: "Busiest mark here. Too much bow and it turns into an octopus.",
    mark: [90, 150, 210, 270, 330, 30]
      .map((a, i) => `<path d="${bowedRay({ cx: 256, cy: 256, angleDeg: a, length: i % 2 ? 142 : 174, bow: 22 })}" stroke-width="52"/>`)
      .join("\n      "),
  },
  {
    id: "lanes",
    name: "Lanes",
    tagline: "Three threads running; one needs you",
    idea: "The queue insight as a picture — most threads run clean, one has gone wild and wants your attention. The only concept that encodes the app's job rather than its subject matter.",
    small: "Holds, but the story does not: at 16px the curl is a bump on a bar and the mark reads as three tallies.",
    risk: "Needs the curl to be extreme to survive, and extreme unbalances the mark at hero size.",
    mark: `
      <path d="M140 400 V136" stroke-width="52"/>
      <path d="M250 400 V136" stroke-width="52"/>
      <path d="M360 400 V266 C360 176 434 168 434 232" stroke-width="52"/>`,
  },
  {
    id: "looseend",
    name: "Loose end",
    tagline: "A single strand, curling free",
    idea: "Maximum legibility: one element, a 74 stroke, a 74-unit counter under the hook, tilted so the return leg falls at an angle.",
    small: "The most robust mark here by a distance — one element, nothing that can fuse, one counter and it is 74 units wide.",
    risk: "Upright it is a candy cane. Even tilted it is quiet — there is very little idea in it.",
    mark: `
      <g transform="rotate(-18 256 256)">
        <path d="M202 424 V226 A74 74 0 0 1 350 226 V304" stroke-width="74"/>
      </g>`,
  },
  {
    id: "monogram",
    name: "Monogram",
    tagline: "F, drawn in fibre",
    idea: "A wordmark-adjacent option: the arms end in curls rather than square cuts, so the letter carries the texture of the name.",
    small: "Holds as an F, though it drifts toward a P at the smallest size.",
    risk: "Safest identity play, least idea in it — and a letterform ties the mark to the name, so it cannot outlive a second rename.",
    mark: `
      <path d="M180 404 V128" stroke-width="56"/>
      <path d="M180 150 H318 C354 150 360 120 346 100" stroke-width="56"/>
      <path d="M180 270 H288 C312 270 316 250 310 236" stroke-width="56"/>`,
  },
  {
    id: "stack",
    name: "Stack",
    tagline: "The queue itself",
    idea: "Honest about what you actually look at all day — a stack of cards receding upward. Widths taper so it reads as depth, not as a menu.",
    small: "Very legible and completely generic. Three rows leave only 1.9px of gap, so it is also the concept the 16px rule punishes hardest.",
    risk: "One notch away from a hamburger icon, and it depicts the container rather than the brand.",
    mark: `
      <path d="M132 372 H380" stroke-width="54"/>
      <path d="M156 256 H356" stroke-width="54"/>
      <path d="M180 140 H332" stroke-width="54"/>`,
  },
  {
    id: "plume",
    name: "Plume",
    tagline: "One root, swept",
    idea: "The fan with weather in it. Asymmetry gives the mark a direction and some personality the symmetric options do not have.",
    small: "Holds. The sweep survives because all three strands share one side.",
    risk: "Reads botanical — a wheat sheaf or a sprout — which is a whole other brand.",
    mark: `
      <path d="M244 430 C244 336 214 262 188 210 C168 170 162 148 166 126" stroke-width="54"/>
      <path d="M244 430 C244 330 246 244 262 186 C274 142 282 118 288 100" stroke-width="54"/>
      <path d="M244 430 C246 334 268 258 306 202 C334 160 356 142 386 128" stroke-width="54"/>`,
  },
  {
    id: "coil",
    name: "Coil",
    tagline: "ntwine as a texture, not an object",
    idea: "A curly-cord corkscrew — two real loops, not a wave. The most literal picture of the word, and the least literal about the product.",
    small: "Fails, and it is the only outright failure in the set. Two loops inside 288 units leaves ~30 units of counter — under 1px — so at 16px the holes fill and it becomes a lump. Shown unfudged.",
    risk: "The arithmetic kills it: any coil with more than one turn cannot clear the 2px counter floor at favicon size. This direction is off the table unless the favicon is allowed to be a different, simpler mark than the logo.",
    mark: `<path d="${smooth(fit(corkscrew({ r: 76, c: 30, a: 92, turns: 2 }), { left: 132, top: 104, right: 380, bottom: 408 }))}" stroke-width="54"/>`,
  },
  {
    id: "serpentine",
    name: "Serpentine",
    tagline: "Many threads, one continuous line",
    idea: "The queue drawn honestly: not a stack of separate cards but one thread laid back and forth, because that is what working a queue top to bottom actually is. Same silhouette as Stack, with a reason behind it.",
    small: "Holds at 1.75px of gap, same as Stack — and unlike Stack the connected ends stop it reading as a menu icon.",
    risk: "The idea only lands at hero size. Small, it is a stack of bars with the ends joined, and nobody reads the join.",
    mark: `<path d="M148 148 H316 A56 56 0 0 1 316 260 H196 A56 56 0 0 0 196 372 H364" stroke-width="54"/>`,
  },
  {
    id: "tuft",
    name: "Tuft",
    tagline: "One thread, two curls",
    idea: "A stem that splits into two outward curls. Outward curls are the single most unmistakable signal of ntwine, and two of them make a face-like, friendly mark.",
    small: "Holds if the curl radius stays at 68 or above; below that the counters seal shut.",
    risk: "Symmetrical curls can tip into horns or a moustache depending on the weight.",
    mark: `
      <path d="M256 428 V310" stroke-width="52"/>
      <path d="M256 322 C256 236 214 168 156 180 C110 190 108 258 158 262" stroke-width="52"/>
      <path d="M256 322 C256 236 298 168 356 180 C402 190 404 258 354 262" stroke-width="52"/>`,
  },
  {
    id: "flick",
    name: "Flick",
    tagline: "A single strand with weight in it",
    idea: "The only tapered mark here — drawn as a filled shape, thick at the root and thinning as it curls. Tapering is what separates a drawn logo from a stroked one, and it is where the craft shows.",
    small: "Survives because the taper stops early: the tip stays 44 units wide, which is 1.4px, rather than running to a point.",
    risk: "A taper is the one thing that cannot be authored as a uniform stroke, so this mark is the most expensive to maintain and to redraw at other weights.",
    mark: `
      <path d="M206 428 C196 296 214 206 272 150 C310 112 358 100 396 114 C410 120 412 140 400 150 C368 160 330 170 300 200 C256 244 250 312 306 428 Z" fill="url(#ink)" stroke="none"/>`,
  },
]

const count = buildAll(concepts, outDir, [["current", join(here, "../../packages/web/public/favicon.svg")]])
console.log(concepts.map((c) => c.id).join(" "))
console.log(`generated ${count} concepts`)
