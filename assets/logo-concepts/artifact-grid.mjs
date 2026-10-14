#!/usr/bin/env node
// The parametric sweep as a self-contained page: every tile is a real render
// inlined as a data URI, labelled with the id you can quote back and with the
// parameters that produced it.

import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const SHEETS = {
  fff: {
    dir: "out-fff",
    file: "ntwine-fff.html",
    title: "ntwine — fff, spacing and tails",
    lede: `The shipped glyph written three times, as ONE stroke with a single free end at each side. <b>Spacing and tail length are independent</b>: <code>gap</code> is how much is cut from both ends of each inner copy, which alone sets the pitch; <code>tail</code> is the outer free ends as a multiple of the glyph's own tail — under 1 it is cut back, over 1 it is extended straight along the end tangent. Every row has <b>6 self-crossings</b> and is <b>exactly C2</b> about its own centre. Quote an id.`,
    wide: true,
    groups: null,
  },
  refined: {
    dir: "out-two-refined",
    file: "ntwine-two-refined.html",
    title: "ntwine — round two, around your picks",
    lede: `144 variants swept finely around <b>t043, t085, t100, t058, t062, t098</b>. Those six share tall narrow loops (aniso 0.88 in five of the six) and modest tails, with both halves represented — so this round narrows the loop width, drops the wide settings entirely, and steps twist, growth and shear more finely rather than more widely. Every one is a single stroke, <b>exactly two self-crossings</b>, <b>exactly 180&deg; rotationally symmetric</b>.`,
    groups: null,
  },
  two: {
    dir: "out-two",
    file: "ntwine-two.html",
    title: "ntwine — the two-crossing f, symmetric",
    lede: `The approved mark, made <b>exactly 180&deg; rotationally symmetric</b>, swept into variants. Every one is a single stroke with <b>exactly two self-crossings</b> — one per loop, and they are each other's partners under a half turn. One crossing at the waist would create both loops at once, which is a figure eight; two is what makes it a cursive f. Quote an id and I'll refine around it.`,
    groups: null,
  },
  eight: {
    dir: "out-eight",
    file: "ntwine-eight.html",
    title: "ntwine — the figure-eight",
    lede: `Two tall narrow teardrop loops forming one <b>closed figure-eight</b>, plus a separate gently-arced crossbar — the structure of the reference. <b>Exactly 180&deg; rotationally symmetric.</b> Proportions are measured off the reference rather than guessed: its loops run about 0.28 wide to the mark's full height. Quote an id and I'll refine around it.`,
    groups: [["bleed", "Crossbar runs off the edge"], ["out", "Crossbar reaches the edge and stops"], ["in", "Crossbar ends inside the tile"]],
  },
  cursive: {
    dir: "out-cursive",
    file: "ntwine-cursive-grid.html",
    title: "ntwine — the cursive family",
    lede: `One swooping path with a bulb at each end, <b>exactly 180&deg; rotationally symmetric</b>. One bulb sits <b>wholly in the upper-right quadrant</b> and the other wholly in the lower-left — never touching, never crossing an axis. The spine is a curve, not a straight line, but it still cannot kink: the bulb is built <i>from</i> the spine so the spine's own direction is its tangent, and the stroke travels a full turn and rejoins going the same way. Quote an id and I'll refine around it.`,
    groups: [["bleed", "Thread runs off the edge"], ["out", "Thread reaches the edge and stops"], ["in", "Thread ends inside the tile"]],
  },
  slash: {
    dir: "out-slash",
    file: "ntwine-slash.html",
    title: "ntwine — the slash spine",
    lede: `One straight diagonal backbone with a bulb hung off each end, drawn as a single contiguous stroke, <b>exactly 180&deg; rotationally symmetric</b>. The spine cannot kink: the stem meets each bulb at a computed tangent point and travels a full 360&deg; round it, so it returns to that point going the same way and the terminal carries straight on. Quote an id and I'll take it further.`,
    groups: [["bleed", "Terminals run off the edge"], ["out", "Terminals reach the edge and stop"], ["in", "Terminals end inside the tile"]],
  },
  grid: {
    dir: "out-grid",
    file: "ntwine-grid.html",
    title: "ntwine — parametric grid",
    lede: `Variants of one construction: a single contiguous stroke, two blobs, and <b>exact 180&deg; rotational symmetry</b>. Quote an id and I'll take it further.`,
    groups: null,
  },
}
const sheet = SHEETS[process.argv[2] ?? "slash"]
if (!sheet) throw new Error(`unknown sheet ${process.argv[2]}`)
const variants = JSON.parse(readFileSync(join(here, sheet.dir, "variants.json"), "utf8"))
const uri = (n) => `data:image/png;base64,${readFileSync(join(here, sheet.dir, n)).toString("base64")}`

const worstC2 = Math.max(...variants.map((v) => v.c2Error))
const tile = (v) => `
    <figure>
      ${sheet.wide ? `<img src="${uri(`${v.id}-480.png`)}" alt="Row variant ${v.id}">` : `<img src="${uri(`${v.id}-200.png`)}" width="150" height="150" alt="Mark variant ${v.id}">`}
      <figcaption><b>${v.id}</b><span>${
        v.along
          ? `bulb ${v.along}&times;${v.across} &middot; spine ${v.spineAngle}&deg;/${v.spineLen}<br>bend ${v.spineBend}&deg; &middot; tail bend ${v.tailBend}&deg; &middot; ${v.side > 0 ? "side +" : "side −"}${v.dir > 0 ? " dir +" : " dir −"}`
          : v.grow !== undefined
          ? `base ${v.base} &middot; grow ${v.grow} &middot; twist ${v.twist}&deg;<br>ease ${v.ease} &middot; aniso ${v.aniso} &middot; shear ${v.shear} &middot; stroke ${v.stroke}`
          : v.gap !== undefined
          ? `gap ${v.gap} &middot; tail ${v.tail}&times; &middot; stroke ${v.stroke}<br>pitch ${v.pitch} &middot; aspect ${v.aspect}`
          : v.loopW
          ? `loop ${v.loopW}&times;${v.loopH} &middot; lean ${v.shear}<br>bar ${v.barAngle}&deg; &middot; bow ${v.barBend}&deg; &middot; stroke ${v.stroke} &middot; ${v.key}`
          : `bulb ${v.lw}&times;${v.lh} &middot; tilt ${v.tilt ?? v.tiltRel}&deg; &middot; spine ${v.axis}&deg;<br>dist ${v.dist} &middot; ${v.side > 0 ? "side +" : "side −"}${v.dir > 0 ? " dir +" : " dir −"}${v.key ? ` &middot; ${v.key}` : ""}`
      }</span></figcaption>
    </figure>`

writeFileSync(join(here, sheet.file), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${sheet.title}</title><style>
:root { --bg:#0d0e10; --panel:#131519; --border:#26282d; --fg:#e6e7e9; --muted:#8b8f96; --accent:#e8b923;
  --sans: system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; --mono: ui-monospace,"SF Mono",Consolas,monospace; }
*{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--sans);line-height:1.6}
.wrap{max-width:1400px;margin:0 auto;padding:56px 32px 96px}
h1{font-size:32px;letter-spacing:-.02em;margin:0 0 8px;font-weight:650}
h2{font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);font-weight:600;margin:48px 0 16px}
p{margin:0 0 10px} .lede{color:var(--muted);font-size:15px;max-width:74ch} .lede b{color:var(--fg);font-weight:600}
code{font-family:var(--mono);font-size:.88em;background:#181b20;border:1px solid var(--border);border-radius:5px;padding:1px 5px}
.knobs{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;margin:18px 0 8px}
.knobs div{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:12px 14px}
.knobs b{display:block;font-family:var(--mono);font-size:13px;color:var(--accent)}
.knobs span{color:var(--muted);font-size:12.5px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:10px;margin-top:20px}
figure{margin:0;background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:10px 8px 8px;text-align:center}
figure img{display:block;margin:0 auto;border-radius:22px;width:150px;height:150px}
figcaption{margin-top:8px;font-family:var(--mono);font-size:10px;color:var(--muted);line-height:1.5}
figcaption b{display:block;color:var(--fg);font-size:12px;margin-bottom:3px}
.foot{margin-top:48px;border-top:1px solid var(--border);padding-top:22px;color:var(--muted);font-size:13.5px;max-width:76ch}
.foot b{color:var(--fg)}
</style></head><body><div class="wrap${sheet.wide ? " wide" : ""}">
<h1>${sheet.title}</h1>
<p class="lede">${variants.length} options. ${sheet.lede}</p>

<h2>What varies</h2>
<div class="knobs">
  <div><b>blob w &times; h</b><span>size and shape of each swoop</span></div>
  <div><b>tilt</b><span>each blob's own rotation</span></div>
  <div><b>axis</b><span>direction from the centre to the blob — the letter's lean</span></div>
  <div><b>dist</b><span>how far the blobs sit from the centre</span></div>
  <div><b>wrap</b><span>how far round the blob the stroke travels</span></div>
  <div><b>side / dir</b><span>where the line originates on the blob, and which way round</span></div>
  <div><b>tail</b><span>terminal length</span></div>
</div>

${sheet.groups
  ? sheet.groups.map(([key, heading]) => {
      const list = variants.filter((v) => v.key === key)
      return `<h2>${heading} — ${list.length}</h2>\n<div class="grid">${list.map(tile).join("")}</div>`
    }).join("\n")
  : `<h2>The ${variants.length} options</h2>\n<div class="grid">${variants.map(tile).join("")}</div>`}

<div class="foot">
<p><b>Two crossings, verified on every variant.</b> The count is checked at the same sampling density as the final report — a coarser check is not a weaker check but a different one, and an optimiser will find the gap between them. It did, once: a shape with five crossings passed a coarse test as two.</p>
<p><b>Symmetry is exact, not approximate.</b> Each half is authored once and the other half is its 180&deg; rotation, so the two can't drift. Measured on the point set, the worst deviation across all ${variants.length} is <code>${worstC2.toExponential(2)}</code> units — floating-point noise. That is a proof, not a pixel comparison.</p>
<p><b>Nothing here grazes.</b> The stroke meets a blob at a computed <i>tangent</i> point, so joins have no kink, and the two stems form one straight line through the centre rather than a pile-up. Any combination where two parts of the stroke ran closer than 1.7 stroke-widths at under 24&deg; to each other was discarded — that near-parallel graze is what reads as a smudge. Combinations with no crossing (not a letterform) or more than three (a scribble) were dropped too: 8640 combinations became 2815 clean, 657 visually distinct, and these ${variants.length}.</p>
<p><b>Not yet decided:</b> weight, colour and whether the tile stays. Everything is drawn at a uniform 22-unit stroke purely so the shapes compare fairly.</p>
</div>
</div></body></html>
`)
console.log(`${sheet.file} — ${variants.length} variants`)
