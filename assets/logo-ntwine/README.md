# ntwine mark

A lowercase n of three threads: they rise parallel up the left stem, run together over the shoulder, and plait three times down the right stem — n threads, entwined, spelling the n. It is concept n9 from [`ntwine-n.html`](ntwine-n.html), chosen 2026-10-13 over the straight plait it bends (the mark from 2026-10-12 to 2026-10-13) and over every capital N in [`ntwine-capital-n.html`](ntwine-capital-n.html). Teal (`#2dd4bf`, the dark-theme accent) on the same dark tile as the mark it replaces (the cursive `fff`, whose history is in [`../logo-concepts/`](../logo-concepts/)).

[`ntwine-concepts.html`](ntwine-concepts.html) is every direction tried — plaits, ropes, rings, an `n` built from strands — round by round, each with what it taught, rendered at 512, 180, 32 and 16. Self-contained; open it from disk.

## Files

| File | What it is |
| --- | --- |
| `lib.ts` | The geometry and the woven renderer. |
| `final.ts` | The chosen mark's parameters; writes `final/` and, with `--install`, every installed copy. |
| `candidates.ts` | Every round's candidates and findings. |
| `concepts.ts` | Renders `ntwine-concepts.html`. |
| `n-concepts.ts` | Ten marks that spell a lowercase n with the plait's threads; renders `ntwine-n.html`. |
| `capital-n-concepts.ts` | Ten that spell a capital N, beside n9; renders `ntwine-capital-n.html`. |
| `render.ts` | Rasterizes SVG in puppeteer's headless shell. |
| `final/` | `favicon.svg` (the app icon), `mark.svg` (teal, no tile), `mark-mono.svg` (line art, `currentColor`), `tile.png`, and the PNG set. |

## Rebuild and install

```sh
nub assets/logo-ntwine/final.ts             # write final/
nub assets/logo-ntwine/final.ts --install   # and install it
nub assets/logo-ntwine/concepts.ts          # regenerate the concepts page
```

`--install` writes:

- `packages/web/public/`: `favicon.svg`, `favicon-16.png`, `favicon-32.png`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`. Bump the `?v=` cache-buster in `packages/web/index.html`, `manifest.webmanifest`, `favicon-badge-fixture.html`/`.ts` and `faviconBadge.e2e.test.ts` whenever the art changes.
- `site/public/`: `favicon.svg`, `favicon-16.png`, `favicon-32.png`, `apple-touch-icon.png`, `img/og-mark.svg`, `img/tile.png` (the nav wordmark's icon), and `img/og.png`, shot from `site/og/og.html`.
- `site/components/mark-path.ts`: the hero's three threads and their cuts.
- `packages/vscode/media/ntwine.svg`: the activity-bar icon.

Every PNG comes from Chrome's rasterizer (this machine has no `rsvg-convert`). `scripts/generate-icons.mjs` makes the same web PNGs with `rsvg-convert`; the art matches, the bytes do not, so each tool's output reads as stale to the other's `--check`. The maskable icon is checked the same way in both: `buildMaskableSvg` scales the mark to 0.78 and every painted pixel must sit in the central 80% circle.

## How it is built

**Strands are offsets along one centreline.** Strand *i* sits at `C(u) + o_i(u) N(u)`, so two strands cross exactly where their offsets are equal. Crossings are found in one dimension, which makes their count and placement exact rather than the result of intersecting curves.

**Over/under is a rule.** The plait rule puts the strand moving toward the middle on top, which is how hair is plaited: every strand goes over, under, over along its length. (The rope rule — whichever strand is moving one way is in front — draws a helix. It reads as rope or DNA.)

**A gap is a mask along the strand on top**, `pen + 2 × clear` wide. Round one cut the under strand and capped the cut round; that turned every weave into a row of separate noodles, and at a shallow crossing the cut ate most of the strand. Drawing the gap along the over strand gives edges parallel to it, the way a woven ribbon is drawn. Masks live inside the SVG, so the mark renders through an `<img>`, `currentColor`, and a CSS `mask-image` (VS Code's activity bar).

**The tails.** The phase runs 0 → 180° over the three crossings. At every multiple of 60° the three strands sit evenly spread, so the tails leave from an even spread; the phase's rate eases in and out over 96 units so each thread straightens into its tail. A 40-unit ramp left a visible corner there.

**Locked values** live in n9's entry in `n-concepts.ts`, which `final.ts` imports so the sheet and the icon cannot drift: stems 192 apart, 180 of stem under a half-circle shoulder, `A 40 · 3 crossings over 200 units centred at 0.8 of the stroke · ramp 60 · pen 25 · clear 9`, scaled (×1.168) to 392 units tall inside the 480-unit tile. Pen 29.2 and gap 10.5 at 512 are 0.9px and 0.3px at 16px. (The straight plait before it: `n 3 · spacing 78 · A 126 · tail 40 · ramp 96 · pen 56 · clear 22`, ×0.867 to 404 units.)

## What the sizes show

- **512, 180:** an n of three distinct threads; the plait down the right leg reads as a braid.
- **32:** still three threads and a plait.
- **16:** a solid arch with a lighter, knotted right leg. It reads as an n; the threads merge, as nothing with three strands survives 16px as a weave.
- **VS Code:** line art with a 0.7px pen, per the rule `package-contents.test.ts` pins. Not re-measured against the codicons for this mark.

## Colour

The ink was gold until 2026-10-13; it is teal-400 (`#2dd4bf`) now, to match the app's new accent. The three radial stops keep the gold's oklch lightness steps about its accent (+0.105, +0.012, −0.100) and its chroma ratios, at hue 182: `#87f1e0` · `#36d8c3` · `#11b29f`, with the tile glow in `#2dd4bf`. The concept rounds render in teal too; their findings still say "gold" because that is what was judged.
