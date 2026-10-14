---
name: visual-review
description: >-
  Judge and dial in the VISUAL correctness of a UI change — vertical alignment of icons beside text,
  optical centering, spacing balance, occlusion and clipping — by MEASURING glyph ink in the running
  browser and by critically reading your own screenshots. Invoke (via the Skill tool) before declaring
  ANY new or changed UI correct, and specifically whenever you place an icon, glyph, emoji, badge,
  chip, or counter next to text. Pairs with `headless-browser`, which covers how to take
  the shot; this skill covers how to JUDGE what the shot shows and how to fix what is off. Carries the
  ink-measurement routine, the per-glyph offsets it produced, and the instrument bug that makes a
  naive baseline probe report ~3x the real error.
metadata:
  internal: true
---

# Visual review — measure the ink, then criticize your own screenshot

Two failures ship bad UI, and this skill exists because both happened repeatedly on this repo:

1. **Trusting the box model.** `items-center`, "padding is equal", `getBoundingClientRect` all agree —
   and the thing still looks broken, because none of them describe where the eye reads a mark.
2. **Taking a screenshot and not looking at it.** Capturing evidence is not reviewing evidence. Posting
   a shot the maintainer then has to tell you is ugly means you did the expensive half and skipped the
   cheap half.

Codified 2026-07-29, after one badge took three maintainer-prompted rounds to get right: the treatment
was invented where the real product should have been measured, and then the glyphs were left riding
~1.2px low because `items-center` was trusted to align them. The capability was never the problem —
doing it unprompted is.

---

## Rule 0 — you are the first reviewer of your own screenshot

Before any UI change leaves your hands, take the shot, **read it back, and try to find what is wrong
with it.** Not "does it render" — *is it good?* Ask, in order:

- Is every icon optically centered against the text beside it, or does one ride high/low?
- Do glyphs sitting in one cluster carry comparable visual weight, or is one obviously heavier?
- Does anything collide, clip, truncate oddly, or sit a pixel off a neighbour it should align with?
- At a NARROW width too: does it still hold, or does something overlap or escape its row?

If you would not ship it to a design-conscious colleague without a caveat, it is not done. Write the
caveat down and fix it instead. **Never hand over a screenshot you have not personally critiqued.**

A useful forcing function: capture at a viewport narrow enough that the component fills the frame
(`--w=780` for a 720px modal), so the detail is actually large enough to judge. A component that is
40px tall inside a 1400px shot cannot be reviewed, and glancing at it counts for nothing.

---

## Rule 1 — icon-beside-text alignment is an INK problem, and every glyph differs

`items-center` centers a glyph's **box** on the flex line. The eye aligns **ink**. These are never the
same thing:

- A **digit has no descender**, so its ink rides HIGH inside the line box.
- An **SVG's ink** sits wherever its path falls inside its viewBox — an octicon's ink is not centered
  in its 16-unit box, and a lucide stroke glyph's ink is smaller again.
- An **emoji** is a bitmap with its own metrics that ignore your font size entirely.

So centering the boxes leaves every glyph low or high **by a different amount**, and one shared nudge
cannot fix a cluster. Measure each glyph and correct each glyph.

Worked result from the GitHub picker's count badges (11.5px text, 12px icons; the picker was removed
on 2026-10-14, and the readings still stand as a worked example):

| glyph | ink height | offset from the digit's ink centre | correction |
| --- | --- | --- | --- |
| `octicon-git-pull-request` (filled) | 10.8px | 1.16px low | `translateY(-0.1em)` |
| lucide `MessageSquare` (stroke) | 9.0px | 1.29px low | `translateY(-0.112em)` |
| 👍 emoji | 16.0px | 0.26px — sub-pixel | none; a nudge only blurs the bitmap |

Residual after correcting: **0.01px** on both icons.

Two things that generalize:

- **Express the correction in `em`, not `px`,** so it tracks the font size instead of pinning to
  today's. Then PROVE it scales — double the cluster's font size and re-measure; the residual must
  stay near zero. (It did: 0.03px / 0.01px at 23px/24px.)
- **Leave sub-pixel offsets alone.** Below ~0.3px you are under the device grid, and transforming a
  bitmap emoji by a fraction of a pixel makes it blurrier, not straighter.

---

## Rule 2 — the routine (copy this; it is the instrument)

Save as a file and pass it to `shot.mjs` with `@`:
`node scripts/shot.mjs "$URL" out.png @/tmp/ink-measure.js --w=780 --wait=2000`

```js
(() => {
  // Baseline: an empty zero-size inline-block's bottom margin edge IS the baseline of the INLINE
  // context it sits in. THE TRAP: a badge holder is usually inline-FLEX, so a probe appended there
  // becomes a FLEX ITEM and reports the flex line's centre instead — which inflated a real 1.2px
  // error to a plausible-looking 3.5px and would have shipped a 3px over-correction. Always wrap the
  // text node in its OWN inline span and probe INSIDE that.
  const baselineOfTextNode = (node) => {
    const span = document.createElement("span")
    node.parentNode.insertBefore(span, node)
    span.appendChild(node)
    const probe = document.createElement("span")
    probe.style.cssText = "display:inline-block;width:0;height:0;padding:0;margin:0;border:0"
    span.appendChild(probe)
    const baseline = probe.getBoundingClientRect().bottom
    const cs = getComputedStyle(span)
    const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} / ${cs.lineHeight} ${cs.fontFamily}`
    probe.remove()
    span.parentNode.insertBefore(node, span)
    span.remove()
    return { baseline, font }
  }

  // Text ink from canvas metrics, relative to that baseline.
  const inkOfText = (text, font, baseline) => {
    const c = document.createElement("canvas").getContext("2d")
    c.font = font
    const m = c.measureText(text)
    return { top: baseline - m.actualBoundingBoxAscent, bottom: baseline + m.actualBoundingBoxDescent }
  }

  // An SVG geometry element's getBoundingClientRect IS its ink box (stroke included). Union every
  // child — a multi-path icon's ink is all of it, not the first path.
  const inkOfSvg = (svg) => {
    const rects = [...svg.querySelectorAll("path,rect,circle,ellipse,polyline,polygon,line")].map((g) =>
      g.getBoundingClientRect(),
    )
    return { top: Math.min(...rects.map((r) => r.top)), bottom: Math.max(...rects.map((r) => r.bottom)) }
  }

  const analyze = (holder, name) => {
    const digitNode = [...holder.childNodes].reverse().find((n) => n.nodeType === 3 && /\S/.test(n.textContent))
    const { baseline, font } = baselineOfTextNode(digitNode)
    const textInk = inkOfText(digitNode.textContent.trim(), font, baseline)

    const svg = holder.querySelector("svg")
    let glyphInk
    if (svg) {
      glyphInk = inkOfSvg(svg)
    } else {
      const em = [...holder.childNodes].find((n) => n.nodeType === 1 && /\p{Extended_Pictographic}/u.test(n.textContent))
      const emNode = [...em.childNodes].find((n) => n.nodeType === 3)
      const eb = baselineOfTextNode(emNode)
      glyphInk = inkOfText(emNode.textContent.trim(), eb.font, eb.baseline)
    }

    const mid = (o) => (o.top + o.bottom) / 2
    return {
      glyph: name,
      glyphInkHeight: +(glyphInk.bottom - glyphInk.top).toFixed(2),
      // NEGATIVE = the glyph's ink sits BELOW the text's ink centre and must be lifted by this much.
      offsetPx: +(mid(textInk) - mid(glyphInk)).toFixed(2),
    }
  }

  // Point this at each badge/label holder in the cluster you are aligning.
  return [...document.querySelectorAll("SELECTOR")].map((el, i) => analyze(el, `glyph ${i}`))
})()
```

**Sign convention, stated once because getting it backwards doubles the error:** the routine returns
`textInkCentre - glyphInkCentre`. A NEGATIVE value means the glyph sits BELOW the text and must be
lifted (`translateY` negative). Re-run after correcting and confirm the residual is ~0 — never assume
your nudge landed.

### Beside PROSE, align to the cap band — not to the string's own ink

`inkOfText` measures the actual bounding box of *the specific string*. That is exact for a **digit**
(uniform, no descender), which is what this routine was written for — and unstable for a **sentence**,
because the reference then moves with whatever letters happen to be in that row. Measured on a to-do
checklist (2026-07-29): the SAME glyph at the SAME size read **3.06px** beside "…network **g**rant…"
and **1.88px** beside "…unconfined is fatal" — a 1.2px spread that is purely the descender. A per-row
nudge is meaningless, so swap the reference for the string-independent band the eye reads as "the line
of text", baseline → cap height:

```js
const capBand = (font, baseline) => {
  const c = document.createElement("canvas").getContext("2d")
  c.font = font
  return { top: baseline - c.measureText("H").actualBoundingBoxAscent, bottom: baseline }
}
```

Keep `inkOfText` alongside it and print both — the gap between them is the descender tell.

Three more ways this instrument lies, all found in one sitting and each producing a plausible number:

- **A px-sized icon makes an `em` correction a lie.** `<Icon size={12}/>` pins the glyph while the text
  around it scales, so the geometry the correction came from stops holding. Size the glyph `1em` and the
  scale check passes for the right reason.
- **`1em` resolves against the glyph's OWN inherited font-size.** If the icon's parent is the card
  (12.5px) while its text sibling is pinned `text-[11.5px]`, you are aligning a 12.5px glyph to 11.5px
  text and the correction encodes that accident. Put the font-size on the wrapper so the pair shares one.
- **A wrapped row breaks the baseline probe.** It reports the LAST line's baseline while the glyph
  aligns to the first — which read as a **42px** error. Force `white-space:nowrap` for the measurement.

And when a residual only appears at a scaled size, re-measure RAW (correction neutralized, one pass per
page load) before theorizing: chasing an "instrument damages what it measures" story cost a cycle, and
the raw numbers showed the real thing — an ~11.5px box centred on a flex line is genuinely not
scale-invariant (11.5px wanted -0.137em, 23px and 46px both wanted -0.094em). No single `em` zeroes
both, so correct for the size that SHIPS and say so in the comment.

### Rule 2b — geometry ink is BLIND to what a mark paints outside its box

Everything above measures ink from GEOMETRY — canvas text metrics for a glyph, the union of an SVG's
geometry children for an icon. Exact for those, and it cannot see a single pixel of `box-shadow`,
`outline`, glow or blur. So two marks with identical boxes, identical `getBoundingClientRect`, and
identical computed `width` can still read as **different-sized marks**, and no DOM measurement will
tell you which.

Measured 2026-07-30 on the queue card's liveness dots: the bright dot is a 6px circle plus a
`box-shadow: 0 0 0 1px` halo = **8.0px of painted ink**; the quiet "alive but idle" dot was a bare 6px
circle = **6.0px**. Every box reading said "both 6px, identical"; the maintainer said *"I don't
understand why the blue dot is so small."* The halo was a third of the mark's width.

When marks that should match still look mismatched and geometry says they agree, measure the PIXELS:

```bash
node scripts/ink-pixels.mjs "$URL" ".ntwine-live-dot" --dsf=4
# → per element: box [6,6] | INK [8,8] css | contrast 422
```

It screenshots each element with a padded clip, decodes it onto a canvas in-page, and scans for pixels
that differ from the surface behind them. Two habits it enforces, both load-bearing:

- **Freeze animated marks at a chosen phase** (`--phase`), or two runs sample different instants and
  are not comparable. A dot that breathes 0.4→0.9 opacity looks like a different mark each shot.
- **Read ink and contrast as different questions.** Ink answers *how big does this read*; peak contrast
  answers *how loud*. The fix for "the quiet dot looks small" is to match the INK and let tone/opacity
  carry the quietness — never to shrink or dim the geometry. Size says "same kind of mark"; tone says
  "quieter". Only tone may vary.

---

## Rule 3 — distrust a measurement that is suspiciously large

A 3.5px error on an 11.5px font is ~30% — that is not a subtle misalignment, it is a broken
instrument. The first run of the routine above reported exactly that, and the cause was the flex-item
baseline probe described in Rule 2. Before acting on any measurement, sanity-check the magnitude
against what you can SEE in the screenshot. If the number claims a gross error and the picture shows
a subtle one, the number is wrong — fix the instrument, not the UI.

This is the visual instance of the repo-wide rule that a confirming or dramatic result is the moment
to get suspicious, not relieved.

---

## Rule 4 — mirror the real product before inventing a treatment

If the thing you are drawing exists in a product the user knows (GitHub, Linear, the app's own
existing components), **go look at the real one and measure it** rather than designing from taste.
Drive the real site headless and read the computed values out of the DOM:

```bash
node scripts/shot.mjs "https://github.com/OWNER/REPO/issues" .adhoc-shots/real.png \
  "(() => { const s=document.querySelector('svg.octicon-git-pull-request'); const h=s.parentElement; \
     return { svg: s.outerHTML, fill: getComputedStyle(s).fill, color: getComputedStyle(h).color, \
              fontSize: getComputedStyle(h).fontSize, text: h.textContent.trim() } })()" --wait=4000
```

That single call settled a badge that had been guessed wrong twice: GitHub renders a **filled
octicon** (not a lucide stroke glyph), **monochrome `rgb(145,152,161)`** matching the comment badge
beside it (not state-coloured green/purple), showing a **count** (not `#number`). The general lesson:
**colour belongs to an item's own state, not to its links** — and you learn that by reading the real
DOM, not by reasoning about it.

---

## Rule 4b — HORIZONTAL rhythm is the same problem, and it has its own skill

Everything above measures ink to place a mark VERTICALLY against text. The identical box-vs-ink gap
opens sideways the moment two marks sit next to each other: `gap` spaces boxes, and a bare glyph in a
hover square carries several px of dead space that a bordered or filled button does not. One uniform
`gap-1.5` drew ink distances from 5.78px to 20.50px on a single footer strip.

**Load `optical-spacing` whenever you set or judge the spacing of a ROW of controls** — an icon strip,
a button rail, a footer of mixed glyphs and pills, or any "the spacing looks inconsistent" report on a
strip whose CSS is provably uniform. It carries the ink-gap instrument (this file's `ink-pixels.mjs`
scans one centre row and cannot measure gaps — the repo's copy is `scripts/ink-gaps.mjs`), the
negative-margin fix, and the pen-width rule for matching perceived WEIGHT, which no colour token can
fix. It is a GLOBAL skill, so it is available outside this repo too.

---

## Rule 5 — geometry decides occlusion; the eye decides balance

Both passes, every time. Geometry catches what the eye cannot (z-index, `overflow: hidden`, clipping,
a box escaping its row at a narrow width). The eye catches what geometry cannot (a glyph that is
technically centered and visually heavy, a pill whose rounded cap eats its padding, ink that rides
high in the em). Neither substitutes for the other, and "the numbers are equal" is never the verdict
on whether something looks right.

Useful geometry assertions to run alongside the ink measurement:

```js
// does the badge overlap the title, or escape its row, at a narrow width?
(() => { const r=document.querySelector("ROW"), a=r.querySelector("BADGE"), t=r.querySelector("TITLE")
  const ab=a.getBoundingClientRect(), tb=t.getBoundingClientRect(), rb=r.getBoundingClientRect()
  return { overlapsTitle: ab.left < tb.right, insideRow: ab.right <= rb.right + 1 } })()

// does the new glyph tone-match the sibling it sits with?
(() => { const a=document.querySelector("NEW"), b=document.querySelector("SIBLING")
  return { toneMatches: getComputedStyle(a).color === getComputedStyle(b).color,
           sizeMatches: getComputedStyle(a).fontSize === getComputedStyle(b).fontSize } })()
```

---

## Checklist before you call UI done

- [ ] Screenshot captured at a scale where the detail is judgeable, and **read back and critiqued by you**
- [ ] Narrow-width shot too; no overlap, clipping, or escape
- [ ] Every icon-beside-text pair ink-measured, corrected per glyph, residual re-measured to ~0
- [ ] If the change is a ROW of marks, its horizontal rhythm measured too — `optical-spacing`
- [ ] Corrections in `em`, proven to scale by re-measuring at a different size
- [ ] New glyph tone/size compared against the sibling it sits beside (computed values, not eyeball)
- [ ] If the pattern exists in a real product, the real one was measured and mirrored
- [ ] Decisive screenshots shown in the handoff in a ```lightbox fence, each captioned; browser cleaned up
