# ntwine mark

Three threads come in, plait through three crossings, and leave as three: n threads, entwined. Teal (`#2dd4bf`, the dark-theme accent) on the same dark tile as the mark it replaces (the cursive `fff`, whose history is in [`../logo-concepts/`](../logo-concepts/)).

[`ntwine-concepts.html`](ntwine-concepts.html) is every direction tried — plaits, ropes, rings, an `n` built from strands — round by round, each with what it taught, rendered at 512, 180, 32 and 16. Self-contained; open it from disk.

## Files

| File | What it is |
| --- | --- |
| `lib.ts` | The geometry and the woven renderer. |
| `final.ts` | The chosen mark's parameters; writes `final/` and, with `--install`, every installed copy. |
| `candidates.ts` | Every round's candidates and findings. |
| `concepts.ts` | Renders `ntwine-concepts.html`. |
| `n-concepts.ts` | Ten marks that spell a lowercase n with the plait's threads; renders `ntwine-n.html`. |
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

**Locked values** (`final.ts`): `n 3 · spacing 78 · A 126 · tail 40 · ramp 96 · pen 56 · clear 22`, then scaled uniformly (×0.867) to a 404-unit ink height inside the 480-unit tile. Pen 48.5 and gap 19.1 at 512 are 1.5px and 0.6px at 16px. `favicon.svg` is 5.6 KB; the old one was a 58 KB path.

## What the sizes show

- **512, 180:** three distinct threads, two big crossings and a third under the middle; the loose ends read as thread.
- **32:** still a plait.
- **16:** three bars top and bottom with an X between. It reads as a woven glyph, not as three threads; nothing woven with three strands survives 16px as a weave. It is cleaner than the `fff`, which landed there as a mottled block.
- **VS Code:** line art with a 0.7px pen, per the rule `package-contents.test.ts` pins. Not re-measured against the codicons for this mark.

## Colour

The ink was gold until 2026-10-13; it is teal-400 (`#2dd4bf`) now, to match the app's new accent. The three radial stops keep the gold's oklch lightness steps about its accent (+0.105, +0.012, −0.100) and its chroma ratios, at hue 182: `#87f1e0` · `#36d8c3` · `#11b29f`, with the tile glow in `#2dd4bf`. The concept rounds render in teal too; their findings still say "gold" because that is what was judged.
