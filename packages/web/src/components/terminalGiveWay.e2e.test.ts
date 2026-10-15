import assert from "node:assert/strict"
import test from "node:test"

const baseUrl = process.env.NTWINE_TERMINAL_GIVE_WAY_E2E_URL

// WHO GIVES WAY ON A TERMINAL ROW, measured in a real browser — the rule is about LAYOUT, and a markup test can
// only say which classes are there. The maintainer's rule (2026-09-29): a row's folder hint appears only where
// the row runs somewhere other than the header says, and the LABEL keeps priority — the hint truncates or drops
// first. Two rounds broke it in a browser while every string assertion stayed green:
//
//   · 390px, round 2: the hint could not shrink, and the label collapsed instead (`Test wat…`).
//   · 390px, round 3: the hint's WORD gave way but its glyph and `·` were kept, so `Running root tick l…` sat
//     beside a bare folder (20px that would have fitted the label), and the bare glyph named nothing; on the
//     1400px rail, 4 of 5 `root` hints were a bare glyph ~120px left of their row's status.
//   · round 4 (2026-09-30): the hint went WHOLE, and a row whose hint had gone claimed the header's checkout —
//     a `root` row read as running in the worktree (1400px rail, 390px strip). And a rail row without a hint
//     stopped its name where the grid's widest status began, ~50px short of a hinted row's.
//
// So, on the terminals fixture (terminals-unified-fixture.html — the agent in `probe`, rows left at the root),
// at a desktop, a narrow and a phone width, on every surface that draws a terminal row — the drawer's strip,
// the card's strip, the card's prompt caption:
//   1. a row with a hint ALWAYS shows its glyph — no row claims a checkout it is not in;
//   2. its WORD shows only beside a whole label: the label outranks the word;
//   3. the agent drawer's header never cuts a number, and its title keeps a real width;
//   4. your terminal's drawer header, waiting for input in a worktree, keeps `…/probe · worktree` whole.
//
// Run it against a plain vite over packages/web:
//   nubx vite --port 5391 --strictPort --host 127.0.0.1
//   NTWINE_TERMINAL_GIVE_WAY_E2E_URL=http://127.0.0.1:5391 nub --test packages/web/src/components/terminalGiveWay.e2e.test.ts
test("a terminal row's label outranks its folder hint's word, its glyph never leaves, and your drawer header keeps its folder, at every width", {
  skip: !baseUrl,
  timeout: 120_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const errors: string[] = []
  try {
    const page = await browser.newPage()
    page.on("pageerror", (e) => errors.push(String(e)))
    for (const width of [1400, 420, 390]) {
      await page.setViewport({ width, height: 1400, deviceScaleFactor: 1 })
      await page.goto(`${baseUrl}/terminals-unified-fixture.html?here=probe`, { waitUntil: "networkidle0" })
      await page.evaluate(() => document.fonts.ready)
      const rows = await page.$$eval("[data-fixture-strip] [data-process-row]", (nodes) => nodes.map((row) => {
        const shownIn = (el: Element | null, box: DOMRect | undefined) => {
          if (!el || !box) return false
          const b = el.getBoundingClientRect()
          return b.width > 0 && b.top < box.bottom - 1 && b.bottom > box.top + 1 && b.left >= box.left - 1 && b.right <= box.right + 1
        }
        // Half in the clipped box: a wrapped-away item whose top still shows under the row.
        const partial = (el: Element | null, box: DOMRect | undefined) => {
          if (!el || !box) return false
          const b = el.getBoundingClientRect()
          return b.width > 0 && b.top < box.bottom - 1 && b.bottom > box.bottom + 1
        }
        const label = (row.querySelector("[data-process-label]") ?? row.querySelector("button")) as HTMLElement
        const give = row.querySelector("[data-process-give]")?.getBoundingClientRect()
        const hint = row.querySelector("[data-process-checkout]")
        const word = row.querySelector("[data-process-checkout-word]")
        const wordShown = shownIn(word, give)
        return {
          surface: row.closest("[data-fixture-caption]") ? "caption" : row.closest("[data-fixture-strip]")!.getAttribute("data-fixture-strip"),
          text: (row as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
          cut: label.scrollWidth > label.clientWidth + 0.5,
          hasHint: Boolean(hint),
          glyph: shownIn(hint?.querySelector("svg") ?? null, give),
          word: wordShown,
          wordPartial: partial(word, give),
        }
      }))
      const at = (r: { surface: string | null; text: string }) => `${width}px ${r.surface}: ${r.text}`
      assert.ok(rows.length >= 25, `${width}px: every surface drew its rows (${rows.length})`)
      assert.ok(rows.some((r) => r.hasHint), `${width}px: the fixture has hinted rows`)
      for (const r of rows) {
        assert.equal(r.glyph, r.hasHint, `${at(r)} — a hinted row always shows its glyph, and an unhinted one none`)
        assert.ok(!(r.cut && r.word), `${at(r)} — the label is cut while the hint's word still shows`)
        assert.ok(!r.wordPartial, `${at(r)} — the hint's word shows half, clipped`)
      }
      // The widest desktop shows every hint's word the rows have room for: a row whose label fits whole and
      // whose word is still hidden would mean it gives way for nothing.
      if (width === 1400) {
        for (const r of rows.filter((x) => x.hasHint)) assert.ok(r.word, `${at(r)} — room enough, and no word`)
      }
    }

    // The agent drawer's header: the reading's numbers are whole or gone, each `·` stands a space clear of what
    // it follows (a part opens a flex item, where a leading space collapses: `running· 43m left· 16m`), and the
    // title keeps a real width.
    for (const width of [1400, 420, 390]) {
      await page.setViewport({ width, height: 700, deviceScaleFactor: 1 })
      await page.goto(`${baseUrl}/terminals-unified-fixture.html?mode=agent`, { waitUntil: "networkidle0" })
      await page.waitForSelector("header [data-sheet-meta] [data-reading-part]")
      const header = await page.$eval("header", (h) => {
        const title = h.querySelector("span[title]")!.getBoundingClientRect()
        const reading = h.querySelector("[data-sheet-meta]")!.firstElementChild!.getBoundingClientRect()
        const parts = [...h.querySelectorAll("[data-reading-part]")].map((p) => {
          const b = p.getBoundingClientRect()
          const sep = p.firstElementChild as HTMLElement
          const before = p.previousElementSibling as HTMLElement | null
          let dotGap: number | null = null
          if (sep.offsetWidth > 0 && before && before.offsetWidth > 0 && sep.firstChild) {
            const range = document.createRange()
            range.setStart(sep.firstChild, 1)
            range.setEnd(sep.firstChild, 2)
            dotGap = range.getBoundingClientRect().left - before.getBoundingClientRect().right
          }
          return { whole: b.right <= reading.right + 0.5, shown: b.top < reading.bottom - 1, dotGap }
        })
        return { titleW: title.width, parts }
      })
      assert.ok(header.titleW > 150, `${width}px: the title keeps ${header.titleW}px (it kept 39-51px on one line)`)
      for (const p of header.parts) {
        assert.ok(!p.shown || p.whole, `${width}px: a reading part is cut`)
        if (p.shown && p.dotGap !== null) assert.ok(p.dotGap >= 2, `${width}px: a \`·\` sits ${p.dotGap}px from what it follows`)
      }
      // At 1400 `running` stands before the age; narrower, beside the Stop, it goes with its `·`.
      if (width === 1400) assert.ok(header.parts.some((p) => p.shown && p.dotGap !== null), `${width}px: a separator was measured`)
    }
    // YOUR terminal's drawer header, waiting for input in a worktree: the folder's last segment and its kind stay
    // whole at every width (at 390px they were an orphaned, clipped `· workt`), the path's head shrinks to its
    // ellipsis and no further, and the reading's parts are whole or gone.
    for (const width of [1400, 420, 390]) {
      await page.setViewport({ width, height: 400, deviceScaleFactor: 1 })
      await page.goto(`${baseUrl}/terminals-unified-fixture.html?mode=header`, { waitUntil: "networkidle0" })
      await page.waitForSelector("[data-fixture-header] [data-terminal-subtitle-tail]")
      await page.evaluate(() => document.fonts.ready)
      const hdr = await page.$eval("[data-fixture-header] header", (h) => {
        const box = (sel: string) => h.querySelector(sel)?.getBoundingClientRect()
        const item = h.querySelector("[data-terminal-subtitle]")!.parentElement!.getBoundingClientRect()
        const tail = h.querySelector("[data-terminal-subtitle-tail]") as HTMLElement
        const reading = h.querySelector("[data-sheet-meta]")!.firstElementChild!.getBoundingClientRect()
        const parts = [...h.querySelectorAll("[data-reading-part]")].map((p) => {
          const b = p.getBoundingClientRect()
          return { whole: b.right <= reading.right + 0.5, shown: b.top < reading.bottom - 1 }
        })
        return {
          item: [item.left, item.right],
          head: box("[data-terminal-subtitle-head]")?.width ?? 0,
          tail: [tail.getBoundingClientRect().left, tail.getBoundingClientRect().right, tail.scrollWidth <= tail.clientWidth + 0.5],
          kind: [box("[data-terminal-subtitle-kind]")!.left, box("[data-terminal-subtitle-kind]")!.right],
          parts,
        }
      })
      const [l, r] = hdr.item
      assert.ok((hdr.tail[0] as number) >= l - 0.5 && (hdr.tail[1] as number) <= r + 0.5 && hdr.tail[2], `${width}px: the folder's last segment is whole (${JSON.stringify(hdr)})`)
      assert.ok(hdr.kind[0]! >= l - 0.5 && hdr.kind[1]! <= r + 0.5, `${width}px: \` · worktree\` is whole (${JSON.stringify(hdr)})`)
      assert.ok(hdr.head >= 14, `${width}px: the path's head keeps room for its \`…/\` (${hdr.head}px)`)
      for (const p of hdr.parts) assert.ok(!p.shown || p.whole, `${width}px: a reading part is cut`)
    }
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
