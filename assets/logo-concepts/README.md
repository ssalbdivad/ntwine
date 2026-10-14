# ntwine icon concepts

Three sheets of directions for the mark after the rename from `fray`, each drawn as real geometry and judged at favicon size. Every page is self-contained — all renders are inlined as data URIs — so they need no server and no network.

| Sheet | Open | What it covers |
| --- | --- | --- |
| Figure-eight | [`ntwine-eight.html`](ntwine-eight.html) | 144 variants matching the reference in [`reference/`](reference/): a closed figure-eight of two tall teardrop loops plus a separate arced crossbar. **Current direction.** |
| fff variants | [`ntwine-fff.html`](ntwine-fff.html) | 75 rows varying spacing and outer tail length independently, at three weights. |
| Round two, refined | [`ntwine-two-refined.html`](ntwine-two-refined.html) | 144 variants swept finely around the six picked from the grid above. **Current direction.** |
| Two-crossing f, symmetric | [`ntwine-two.html`](ntwine-two.html) | 144 variants of the approved mark, made exactly 180° rotationally symmetric. Every one is a single stroke with exactly two self-crossings. **Current direction.** |
| Cursive family | [`ntwine-cursive-grid.html`](ntwine-cursive-grid.html) | 77 variants: one swooping path, a bulb at each end, a curved spine that cannot kink. One bulb wholly in the upper-right quadrant, the other wholly in the lower-left. Three terminal treatments. **Current direction.** |
| Slash spine | [`ntwine-slash.html`](ntwine-slash.html) | 144 variants with a **guaranteed-straight diagonal backbone** and a bulb hung off each end, in three terminal treatments: bleeding off the edge, stopping at the edge, and ending inside. |
| Parametric grid | [`ntwine-grid.html`](ntwine-grid.html) | 144 variants of one construction, swept across blob size, tilt, axis, distance, wrap, origin side and tail length. Every one is exactly 180° rotationally symmetric. |
| The cursive f | [`ntwine-signature-f.html`](ntwine-signature-f.html) | The written signature f from [`reference/reference-brief.png`](reference/reference-brief.png) — two loops crossing at a waist, with a crossbar. **Every mark is exactly 180° rotationally symmetric, and measured.** Eight weights and treatments. |
| The hooked f | [`ntwine-cursive-f.html`](ntwine-cursive-f.html) | Eight lowercase `f`s built from hooks rather than loops — the favicon-viable family. |
| Icon concepts | [`ntwine-logo-concepts.html`](ntwine-logo-concepts.html) | The original fifteen non-letterform directions: fan, curl, spark, lanes, knot and the rest. |

## The shipped mark

`final/favicon.svg` is the icon, installed at `packages/web/public/favicon.svg`. Rebuild it with `nub finalize.mjs [--install]`.

Only HALF the path is fitted; the other half is that half's anchors rotated 180° and reversed with the handles swapped, so the symmetry lives in the path data and cannot drift. **Editing one side without mirroring the other breaks it.** The centre anchor's `in` and `out` must stay equal — letting them differ cost 2.28 units of asymmetry.

`nub build-fff.mjs` chains the glyph into cursive `fff` ([`final/fff.svg`](final/fff.svg)) — one stroke, one free end each side, 6 self-crossings, the row C2 about its own centre. The connecting tails are trimmed so the glyphs sit close; the full tail is restored only at the far left and right. Trimming equal arc length from both ends keeps the glyph C2, so its ends still leave in the same direction and the copies chain by translation alone.

The locked settings are **f041**: `TRIM=0.11`, `TAIL=0.25` — tight spacing, short outer stubs, aspect 1.02 so it sits in a square tile without letterboxing.

**Trim first, then level.** Levelling the untrimmed glyph and then cutting its tails leaves the new ends at different heights — 7.3 units apart at trim 0.09 — so a horizontal translation puts a visible step at every join. `TRIM=` adjusts spacing (past about 0.12 the loops interleave and it reads as a thicket), `TAIL=` the outer stubs, `REPEATS=` the number of glyphs.

**The fff is the lockup, not the app icon.** At 16 px it puts *more* ink on the tile than the single glyph — 92 of 256 pixels against 34 — and reads worse: three glyphs in 16 px is a striped blob, not a letter. The app icon stays the single glyph. The fff earns its keep at 32 px and above.

## Fitting to a reference

Both fitters render a candidate, compare its ink mask with the reference's, and hill-climb on **intersection-over-union**. Judging shape by eye is what produced six rounds of near-misses on this brief; a number says whether a change helped.

```sh
nub fit-curve.mjs    # FINAL: 12 cubic segments, TWO crossings -> fit/curve-replica.svg
nub fit-bezier.mjs   # one-crossing replica of the reference -> fit/bezier-replica.svg
nub fit-spline.mjs   # 28-waypoint Catmull-Rom (its seed)   -> fit/spline-best.json
nub fit-eight.mjs    # closed 8 + separate bar (superseded) -> fit/best.json
```

**The two fits settled the mark's topology, which inspection had got wrong.** Fitting the reference as a closed figure-eight with a separate crossbar tops out at **IoU 0.75**. Fitting it as a *single open spline* — one path, two free ends, no bar — reaches **IoU 0.955**, with geometric agreement of **mean 0.03 px** and a worst case of 1.4 px.

The giveaway is the waist: three strands meet there in a triangle of crossings, which is what one path passing through the middle three times looks like. A closed eight plus a bar would put four strands through a single node. The apparent "crossbar" is just the path's two tails, which leave roughly collinear.

**The mark has exactly TWO self-crossings**, one per loop, and that is what makes it a cursive `f` rather than a figure eight. A single crossing at the waist creates *both* loops at once — that is an `8`, and it is what every earlier attempt produced, including the pixel-exact replica of the reference. Two crossings means each loop shuts on its own with a stem running between them.

`crossings.mjs` counts them, and `fit-curve.mjs` treats the count as a hard constraint. Two things had to be right for that constraint to mean anything:

- The counter skips neighbouring samples as a **fraction** of the path, not a fixed count. A fixed count silently changes meaning with sampling density, and an optimiser found the gap: it satisfied a coarsely-checked "two crossings" and handed back a shape with five.
- The shape is **constructed** with two crossings and only then curve-fitted. Fitting pixel overlap against the one-crossing reference while forcing two crossings can only tear a loop open, and it did — the descender unrolled into a hook.

**The final mark is 12 cubic Bézier segments**, not a polyline. The 28-waypoint fit matched the reference but every waypoint had chased pixels independently, so its curvature jittered — smooth to a glance, not a drawn curve. Refitting as a G1-continuous Bézier path with 11 anchors cut curvature roughness from **108.9 to 1.0 per 100 units, a 108× reduction**, while IoU went *up* slightly (0.9554 → 0.9575). The final two-crossing mark reaches **0.09 per 100 units**. Tangent continuity is structural there: each anchor carries one tangent shared by the segments either side, so no amount of fitting can introduce a corner.

## Regenerating

```sh
nub build-eight.mjs       # the figure-eight sweep      -> out-eight/
nub build-fff-grid.mjs    # fff rows: spacing x tail x weight -> out-fff/
nub build-two.mjs --refine  # refined sweep around the picks -> out-two-refined/
nub build-two.mjs         # the symmetric two-crossing sweep -> out-two/
nub build-cursive.mjs     # the cursive sweep           -> out-cursive/
nub build-slash.mjs       # the slash-spine sweep       -> out-slash/
nub build-grid.mjs        # the earlier parametric sweep -> out-grid/
nub artifact-grid.mjs eight   # out-eight/   -> ntwine-eight.html
nub artifact-grid.mjs fff     # out-fff/     -> ntwine-fff.html
nub artifact-grid.mjs refined # out-two-refined/ -> ntwine-two-refined.html
nub artifact-grid.mjs two     # out-two/     -> ntwine-two.html
nub artifact-grid.mjs cursive # out-cursive/ -> ntwine-cursive-grid.html
nub artifact-grid.mjs slash   # out-slash/ -> ntwine-slash.html
nub artifact-grid.mjs grid    # out-grid/  -> ntwine-grid.html
nub build.mjs             # the fifteen icon concepts  -> out/
nub build-cursive-f.mjs   # the hooked f family        -> out-f/
nub build-signature-f.mjs # the written signature f    -> out-sig/
nub artifact.mjs          # every out*/ -> its HTML sheet
nub artifact.mjs signature-f   # or just one
```

`build*.mjs` needs `rsvg-convert` (`brew install librsvg`). Shared geometry and rendering live in `lib.mjs`. The `out*/` directories are regenerated from scratch on every run and are not tracked.

## The constraint every sheet is judged against

A 512-unit canvas maps to 16 px, so **one pixel is 32 units**:

- **≥ 52u** minimum stroke — below this the mark dissolves.
- **≥ 64u** minimum ink gap or counter — below this two features fuse, or a hole fills.
- **3** elements across the width, and no more.

The outgoing fraying-rope mark draws its fibres at stroke-width 16–19, which is half a pixel at favicon size. They do not thin out; they disappear.

**Topology.** The letter is ONE contiguous stroke with exactly two free ends: in from the left, round the descender, up through the middle, round the ascender, out to the right. The apparent crossbar is not a stroke — it is the two tails leaving on opposite sides at mirrored heights. Reading it as a closed figure-eight plus a crossbar is what made earlier drafts look like an `8` with a line through it.

**Rotational symmetry.** The cursive f is C2 by nature — two loops crossing once at a waist are point reflections of each other. Every mark on that sheet is derived from one half and rotated, never drawn twice, then checked: render, rotate 180°, take the RMSE. Controls set the scale — a perfect centred circle scores `1.3e-3` (the rasteriser's floor) and a circle just 4 units off centre scores `9.3e-2`, 75x higher. All eight marks land at or under the floor.

**The size finding.** A genuinely written cursive `f` cannot also be the favicon — its line runs about 0.69 px and its loop counters about 1.4 px at 16 px, and bolding it until the arithmetic works widens the loops until the letter reads as an `8`. The resolution is two drawings: the signature as the logo, and the hooked `ƒ` as the icon.
