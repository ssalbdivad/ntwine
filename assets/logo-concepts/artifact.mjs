#!/usr/bin/env node
// Assembles a concept sheet into one self-contained HTML file. Every image is a
// real rsvg render inlined as a data URI, so a page can be opened, mailed or
// archived on its own — nothing here is a CSS approximation of a mark.
//
//   nub artifact.mjs                # every sheet
//   nub artifact.mjs signature-f    # just one

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))

const uri = (dir, name) => `data:image/png;base64,${readFileSync(join(here, dir, name)).toString("base64")}`
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const RANK_LABEL = { pick: "shortlist", maybe: "in play", weak: "weak", no: "ruled out" }

// The first sheet predates per-concept ranks; keep its verdicts alongside it
// rather than rewriting a build that is already committed and rendering.
const SHEET_ONE_VERDICTS = {
  curl: ["pick", "Survives smallest, says the name, and is the only mark there that is both distinctive and structurally safe."],
  converge: ["pick", "The one idea about the product rather than the word. Stable silhouette, no glyph collision."],
  looseend: ["pick", "The safety option. Nothing will ever break it; nothing about it is memorable either."],
  spark: ["maybe", "Most personality, most noise. Radial symmetry is a real asset for an icon."],
  tuft: ["maybe", "Distinctive and friendly, but it is the Aries glyph and you will not un-see that."],
  flick: ["maybe", "The only drawn-not-stroked mark. Elegant, and the most work to maintain."],
  fan: ["maybe", "Reads clearly; reads like everyone else's logo too."],
  plume: ["maybe", "Charming, but botanical — a different brand's mark."],
  monogram: ["maybe", "Safe, and welds the identity to the current name."],
  serpentine: ["maybe", "Best idea-per-pixel of the queue concepts, but the idea is invisible small."],
  twist: ["weak", "Degrades to a knobbly column."],
  lanes: ["weak", "The story disappears at 16px; only three tallies remain."],
  stack: ["weak", "A hamburger menu with extra steps."],
  knot: ["no", "Collapses to a capital A, and its meaning is the opposite of the product's."],
  coil: ["no", "Cannot clear the counter floor at any pitch above one turn. Arithmetically excluded."],
}

const SHEETS = {
  "signature-f": {
    dir: "out-sig",
    file: "ntwine-signature-f.html",
    title: "Ntwine — the cursive f, rotationally symmetric",
    lede: `The written f, built as real geometry from the reference below and <b>exactly symmetric under a half turn</b>. That is not an ornament bolted on: two loops crossing once at a waist already ARE point reflections of each other through that crossing, so the letterform wants C2 — the previous draft simply broke it. Every mark here is derived from one half and rotated, never drawn twice, and every render is <b>measured</b> against its own 180-degree rotation.`,
    reference: "reference-brief.png",
    symmetry: true,
    referenceCaption:
      "The brief. Two narrow loops crossing once at the waist, thrown right at the top and left at the bottom, with a long crossbar — and real weight variation, heavy on the outside of the loops and fine through the crossings. Everything below is built from that description rather than traced over it.",
    footer: [
      `<b>On symmetry.</b> Every mark on this page is exactly 180-degree symmetric, verified by measurement above rather than by eye. Four separate things had to be fixed to get there, and all four were wrong in the previous draft: an ascender/descender size difference, a crossbar whose halves were not exact rotations, a linear ink gradient (which reverses under rotation), and a background glow centred 28 units above the middle of the canvas. A mark can be perfect and still measure asymmetric if the tile under it is not.`,
      `<b>The size finding, unchanged.</b> A written f cannot be the favicon. The reference's line is about 22 units on a 512 canvas, which is <b>0.69px</b> at 16px, and its loops are narrow enough that their counters land at 1.4px. Both are under the floor. Bolding fixes the arithmetic and breaks the letter — the loops have to widen to keep their counters, and a widened figure-eight reads as an <b>8</b>. Every bold variant above shows that happening.`,
      `<b>The way out is two drawings, not one compromise.</b> A detailed logo plus a reduced icon is ordinary brand practice. The best reduction is not a bolder signature — it is the hooked ƒ from the companion sheet, which is structurally sound at 16px and still visibly the same letter in the same hand.`,
      `<b>One caveat on "16px", worth checking before you decide.</b> The renders above are true 16&nbsp;px. On a hi-dpi screen a browser fills the 16&nbsp;px tab slot from the <b>32&nbsp;px</b> asset instead — and the signature is legible at 32&nbsp;px, as its second evidence tile shows. So the verdict above is firm for a 1x display and may be too harsh for a 2x one. That is an assumption about favicon selection, not something measured here; test it in a real tab on a real Retina display before letting it change the decision.`,
      `<b>What is not decided here.</b> Colour is carried over from the existing mark (<code>#e8b923</code> on <code>#0d0e10</code>) so the variants compare on form alone. The dark rounded tile is a contrast guarantee, not part of any mark.`,
    ],
    pairing: {
      logo: ["out-sig", "sig-c2"],
      icon: ["out-f", "f-florin"],
      note: "Left: the signature, at the size it is meant for. Right: the hooked ƒ carrying the same letter at 16px, where the signature cannot go. Same hand, same amber, same tile — one is the logo, the other is the tab.",
    },
  },
  "cursive-f": {
    dir: "out-f",
    file: "ntwine-cursive-f.html",
    title: "Ntwine — the hooked f",
    lede: `Eight takes on a lowercase f built from hooks rather than loops. This is the favicon-viable family: an f whose terminals curl but never close, so there is no counter that can seal at 16px. <b>Judged against the real 16px render, not the hero.</b>`,
    footer: [
      `<b>The rule that shapes all of these.</b> A written ascender loop is about 52 units wide, so its counter is 2&times;52&minus;56 = 48 units — 1.5px, under the floor. That single number is why every workable f here is a <b>hooked</b> f rather than a looped one, and why the loop variants are marked ruled out.`,
      `<b>The crossbar is the other constraint.</b> A hook that curls back down drops its right-hand limb to exactly the height a crossbar wants. Trimming both hooks lifts it and buys the bar 79 units of clearance — which is why Florin's hooks are shallower than Integral's.`,
    ],
  },
  concepts: {
    dir: "out",
    file: "ntwine-logo-concepts.html",
    title: "Ntwine — icon concepts",
    lede: `Fifteen directions for the mark after the rename, each drawn as real geometry and rendered at 512, 128, 32 and 16&nbsp;px. <b>Every concept is judged at 16px, not at hero size</b> — the favicon is the constraint, so the small render is the evidence and the big one is the advert.`,
    before: true,
    footer: [
      `<b>How to read the verdicts.</b> They are a reading of the 16px renders on this page, not something the geometry decides. Two marks are ruled out by measurement rather than taste: <b>Coil</b> cannot clear the counter floor at any pitch above one turn, and <b>Knot</b> collapses to a capital A while also meaning the opposite of what the product does.`,
      `<b>What is not decided here.</b> Colour is carried over from the existing mark (<code>#e8b923</code> on <code>#0d0e10</code>) so the concepts compare on form alone. The dark rounded tile guarantees favicon contrast against any browser theme, but every mark would also work knocked out on a flat field.`,
    ],
  },
}

const card = (sheet, c) => {
  const rank = c.rank ?? SHEET_ONE_VERDICTS[c.id][0]
  const verdict = c.verdict ?? SHEET_ONE_VERDICTS[c.id][1]
  return `
  <article class="card ${rank}" id="${c.id}">
    <div class="hero"><img src="${uri(sheet.dir, `${c.id}-128.png`)}" width="128" height="128" alt="${esc(c.name)} at 128 pixels"></div>
    <div class="body">
      <h3>${esc(c.name)} <span class="rank ${rank}">${RANK_LABEL[rank]}</span></h3>
      <p class="tagline">${esc(c.tagline)}</p>
      <p>${esc(c.idea)}</p>
      <p class="line"><b>At 16px.</b> ${esc(c.small)}</p>
      <p class="line"><b>Risk.</b> ${esc(c.risk)}</p>
      <p class="line verdict"><b>Verdict.</b> ${esc(verdict)}</p>
      ${c.symmetryError === undefined ? "" : `<p class="line sym"><b>Rotational symmetry.</b> error <code>${c.symmetryError.toExponential(2)}</code> — ${c.symmetryError <= 1.3e-3 ? "at or below the rasteriser's own floor, i.e. exact" : "above the floor; not symmetric"}.</p>`}
    </div>
    <div class="evidence">
      <div class="row">
        <div class="ev"><img class="px" src="${uri(sheet.dir, `${c.id}-16.png`)}" width="96" height="96" alt="${esc(c.name)} rendered at 16 pixels, magnified"><span>16px &middot; 6&times;</span></div>
        <div class="ev"><img class="px" src="${uri(sheet.dir, `${c.id}-32.png`)}" width="96" height="96" alt="${esc(c.name)} rendered at 32 pixels, magnified"><span>32px &middot; 3&times;</span></div>
      </div>
      <div class="ev">
        <div class="tabstrip">
          <div class="tab"><img src="${uri(sheet.dir, `${c.id}-16.png`)}" width="16" height="16" alt=""><span>ntwine</span></div>
          <div class="tab dim"><img src="${uri(sheet.dir, `${c.id}-16.png`)}" width="16" height="16" alt=""><span>zod</span></div>
        </div>
        <span>actual size, in a tab</span>
      </div>
    </div>
  </article>`
}

const CSS = `
  :root {
    --bg: #0d0e10; --panel: #131519; --panel2: #181b20; --border: #26282d;
    --fg: #e6e7e9; --muted: #8b8f96; --accent: #e8b923; --live: #4ac97e; --warn: #d98a3a; --dead: #6b7280;
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, "SF Mono", "JetBrains Mono", Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font-family: var(--sans); line-height: 1.6; -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 64px 32px 96px; }
  h1 { font-size: 34px; letter-spacing: -0.02em; margin: 0 0 8px; font-weight: 650; }
  h2 { font-size: 13px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); font-weight: 600; margin: 56px 0 18px; }
  h3 { font-size: 19px; margin: 0 0 2px; font-weight: 620; display: flex; align-items: center; gap: 10px; }
  p { margin: 0 0 10px; }
  .lede { color: var(--muted); font-size: 15px; max-width: 68ch; }
  .lede b { color: var(--fg); font-weight: 600; }
  code { font-family: var(--mono); font-size: 0.88em; background: var(--panel2); border: 1px solid var(--border); border-radius: 5px; padding: 1px 5px; }

  .rule { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 20px; }
  .rule div { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; }
  .rule b { display: block; font-family: var(--mono); font-size: 21px; color: var(--accent); font-weight: 600; }
  .rule span { color: var(--muted); font-size: 13px; }

  .refbox { background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 22px 26px; }
  .refbox img { width: 100%; max-width: 620px; display: block; border-radius: 10px; background: #f7f8fa; }
  .refbox p { margin: 16px 0 0; color: var(--muted); font-size: 14px; max-width: 70ch; }

  .before { display: flex; gap: 28px; align-items: center; background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 22px 26px; }
  .before img { border-radius: 12px; display: block; }
  .before .px { image-rendering: pixelated; }
  .before p { margin: 0; color: var(--muted); font-size: 14px; max-width: 48ch; }
  .before b { color: var(--fg); }

  .card { display: grid; grid-template-columns: 128px 1fr 208px; gap: 26px; align-items: start; background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 22px 24px; margin-bottom: 14px; }
  .card.no { opacity: 0.62; }
  .hero img { border-radius: 28px; display: block; }
  .tagline { color: var(--accent); font-size: 14px; margin-bottom: 10px; }
  .body p { font-size: 14px; color: #c9ccd1; }
  .line { color: var(--muted); font-size: 13.5px; }
  .line b { color: var(--fg); font-weight: 600; }
  .verdict b { color: var(--accent); }

  .rank { font-size: 10.5px; letter-spacing: 0.09em; text-transform: uppercase; font-weight: 650; padding: 3px 8px; border-radius: 999px; border: 1px solid; }
  .rank.pick { color: var(--live); border-color: color-mix(in srgb, var(--live) 45%, transparent); background: color-mix(in srgb, var(--live) 12%, transparent); }
  .rank.maybe { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 42%, transparent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
  .rank.weak { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 42%, transparent); background: color-mix(in srgb, var(--warn) 10%, transparent); }
  .rank.no { color: var(--dead); border-color: var(--border); }

  .evidence { display: flex; flex-direction: column; gap: 12px; }
  .evidence .row { display: flex; gap: 12px; }
  .ev { display: flex; flex-direction: column; gap: 5px; flex: 1; min-width: 0; }
  .ev span { font-size: 10.5px; color: var(--muted); font-family: var(--mono); }
  .ev .px { image-rendering: pixelated; border-radius: 9px; width: 100%; height: auto; display: block; }
  .tabstrip { display: flex; gap: 4px; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 5px; }
  .tab { display: flex; align-items: center; gap: 6px; background: var(--panel2); border-radius: 6px; padding: 5px 8px; font-size: 11px; color: #c9ccd1; white-space: nowrap; overflow: hidden; }
  .tab.dim { opacity: 0.5; }
  .tab img { flex: none; }

  .pair { display: flex; gap: 32px; align-items: center; background: var(--panel); border: 1px solid var(--border); border-radius: 14px; padding: 26px 28px; }
  .pair .side { display: flex; flex-direction: column; align-items: center; justify-content: flex-start; gap: 8px; flex: none; }
  .pair img { display: block; border-radius: 28px; }
  .pair .px { image-rendering: pixelated; border-radius: 12px; }
  .pair span { font-size: 10.5px; color: var(--muted); font-family: var(--mono); }
  .pair p { margin: 0; color: var(--muted); font-size: 14px; }

  .sym b { color: var(--live); }
  .ctrl { border-collapse: collapse; margin: 18px 0 22px; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  .ctrl td { padding: 10px 18px; border-bottom: 1px solid var(--border); font-size: 13.5px; color: var(--muted); }
  .ctrl tr:last-child td { border-bottom: none; }
  .ctrl td:last-child { font-family: var(--mono); color: var(--fg); text-align: right; white-space: nowrap; }

  .foot { margin-top: 56px; border-top: 1px solid var(--border); padding-top: 24px; color: var(--muted); font-size: 13.5px; max-width: 72ch; }
  .foot b { color: var(--fg); }
`

function build(key) {
  const sheet = SHEETS[key]
  const concepts = JSON.parse(readFileSync(join(here, sheet.dir, "concepts.json"), "utf8"))
  const order = ["pick", "maybe", "weak", "no"]
  const rankOf = (c) => c.rank ?? SHEET_ONE_VERDICTS[c.id][0]
  const sorted = [...concepts].sort((a, b) => order.indexOf(rankOf(a)) - order.indexOf(rankOf(b)))

  const referenceBlock =
    sheet.reference && existsSync(join(here, "reference", sheet.reference))
      ? `  <h2>The brief</h2>
  <div class="refbox">
    <img src="data:image/png;base64,${readFileSync(join(here, "reference", sheet.reference)).toString("base64")}" alt="Two hand-drawn cursive lowercase f letterforms: narrow crossing loops above and below a waist, each with a long crossbar.">
    <p>${sheet.referenceCaption}</p>
  </div>

`
      : ""

  const beforeBlock = sheet.before
    ? `  <h2>Why the current mark fails</h2>
  <div class="before">
    <img src="${uri(sheet.dir, "current-128.png")}" width="128" height="128" alt="The current fraying-rope icon at 128 pixels">
    <img class="px" src="${uri(sheet.dir, "current-16.png")}" width="128" height="128" alt="The current icon rendered at 16 pixels, magnified">
    <p>The fraying rope reads beautifully large and is <b>structurally impossible small</b>. Its five loose fibres are drawn at stroke-width 16&ndash;19 on a 512 canvas &mdash; <b>half a pixel</b> at favicon size. They do not thin out; they cease to exist, and what survives is an amber smear.</p>
  </div>

`
    : ""

  const controlsPath = join(here, sheet.dir, "controls.json")
  const symmetryBlock =
    sheet.symmetry && existsSync(controlsPath)
      ? (() => {
          const controls = JSON.parse(readFileSync(controlsPath, "utf8"))
          return `  <h2>Symmetry, measured</h2>
  <p class="lede">Claiming a mark is symmetric is worthless, so each one is checked: render it, rotate the render 180 degrees, and take the RMSE between the two. <b>Controls first</b>, because the number means nothing without them — a rasteriser never reproduces a rotated edge exactly, so even a perfect shape scores above zero.</p>
  <table class="ctrl">
    ${controls.map((c) => `<tr><td>${esc(c.label)}</td><td><code>${c.error.toExponential(2)}</code></td></tr>`).join("\n    ")}
  </table>
  <p class="lede">So <b>~1.3e-3 is the floor</b>, and moving a shape just <b>4 units</b> off centre — barely a tenth of a stroke width — costs 75&times; that. Every mark below lands at or under the floor. Here is the headline mark beside its own 180-degree rotation:</p>
  <div class="pair">
    <div class="side"><img src="${uri(sheet.dir, "sig-c2-512.png")}" width="200" height="200" alt="The symmetric signature f"><span>as drawn</span></div>
    <div class="side"><img src="${uri(sheet.dir, "sig-c2-rotated-512.png")}" width="200" height="200" alt="The same mark rotated 180 degrees"><span>rotated 180&deg;</span></div>
  </div>

`
        })()
      : ""

  const pairingBlock = sheet.pairing
    ? `  <h2>The pairing this points to</h2>
  <div class="pair">
    <div class="side">
      <img src="${uri(sheet.pairing.logo[0], `${sheet.pairing.logo[1]}-128.png`)}" width="128" height="128" alt="The signature f at 128 pixels">
      <span>logo &middot; 128px</span>
    </div>
    <div class="side">
      <img class="px" src="${uri(sheet.pairing.icon[0], `${sheet.pairing.icon[1]}-16.png`)}" width="128" height="128" alt="The hooked f rendered at 16 pixels, magnified">
      <span>favicon &middot; 16px</span>
    </div>
    <p>${sheet.pairing.note}</p>
  </div>

`
    : ""

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(sheet.title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
  <h1>${esc(sheet.title)}</h1>
  <p class="lede">${sheet.lede}</p>

  <h2>The 16px rule</h2>
  <p class="lede">A 512-unit canvas maps to 16&nbsp;px, so <b>one pixel is 32 units</b>. That single conversion decides what is drawable and rules out most of what a logo wants to be.</p>
  <div class="rule">
    <div><b>&ge; 52u</b><span>minimum stroke. Below this the mark dissolves into a smudge.</span></div>
    <div><b>&ge; 64u</b><span>minimum ink gap or counter. Below this two features fuse, or a hole fills.</span></div>
    <div><b>3</b><span>elements across the width. That is the whole budget — 288 usable units buys no more.</span></div>
  </div>

${referenceBlock}${symmetryBlock}${beforeBlock}  <h2>Concepts</h2>
${sorted.map((c) => card(sheet, c)).join("\n")}

${pairingBlock}  <div class="foot">
${sheet.footer.map((p) => `    <p>${p}</p>`).join("\n")}
  </div>
</div>
</body>
</html>
`
  const out = join(here, sheet.file)
  writeFileSync(out, html)
  console.log(`${sheet.file} — ${concepts.length} concepts, ${(html.length / 1024).toFixed(0)} KB`)
}

const requested = process.argv.slice(2)
const keys = requested.length ? requested : Object.keys(SHEETS)
for (const key of keys) {
  if (!SHEETS[key]) throw new Error(`unknown sheet ${key}; expected one of ${Object.keys(SHEETS).join(", ")}`)
  build(key)
}
