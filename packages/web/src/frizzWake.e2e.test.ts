import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"

const baseUrl = process.env.FRIZZ_WAKE_MARKDOWN_E2E_URL

// TWO THINGS, through the real message component, because they are two halves of one rule: a wake frizz
// composed is a hairline — INCLUDING several of them held and sent as one delivery, which drew a bordered
// card of both agent-facing bodies until 2026-10-11 — and the card that remains for text no parser reads
// renders that text as safe Markdown.
test("a batch of held wakes draws one hairline per wake, and the fallback card renders safe Markdown", {
  skip: !baseUrl,
  timeout: 120_000,
}, async () => {
  const { launchHeadless } = await import("../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const errors: string[] = []
  const shots = process.env.FRIZZ_WAKE_SHOTS
  if (shots) mkdirSync(shots, { recursive: true })
  try {
    const page = await browser.newPage()
    page.on("pageerror", (error) => errors.push(String(error)))
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()) })
    for (const font of ["sans", "mono"]) {
      for (const width of [1000, 390]) {
        const url = `${baseUrl}/frizz-wake-fixture.html?font=${font}${width < 500 ? "&dense" : ""}`
        await page.setViewport({ width, height: 1000, deviceScaleFactor: 2 })
        await page.goto(url, { waitUntil: "networkidle0" })
        await page.waitForSelector('[data-frizz-msg="md"] .md-body h3')
        const result = await page.evaluate(() => {
          const card = document.querySelector('[data-frizz-msg="md"]')!
          const prose = card.querySelector(".md-body")!
          const pre = prose.querySelector("pre")!
          // One merged delivery: the element every part of it sits in, and what each part drew. Named by
          // its own marker, because a part can bring a `data-frizz-wake` wrapper of its own (a PR-watch
          // wake's verdict and review lines share one).
          const delivery = (id: string) => {
            const wrap = document.querySelector(`[data-frizz-msg="${id}"]`)?.closest('[data-frizz-wake="merged"]')
            const dividers = Array.from(wrap?.querySelectorAll("[data-wake-divider]") ?? [])
            return {
              lines: dividers.map((el) => el.textContent ?? ""),
              tops: dividers.map((el) => el.getBoundingClientRect().top),
              cards: Array.from(wrap?.querySelectorAll(".md-body") ?? []).map((el) => el.textContent ?? ""),
              text: wrap?.textContent ?? "",
            }
          }
          const top = (id: string) => document.querySelector(`[data-frizz-msg="${id}"]`)!.getBoundingClientRect().top
          return {
            headings: Array.from(prose.querySelectorAll("h3")).map((el) => el.textContent),
            codes: Array.from(prose.querySelectorAll("li code")).map((el) => el.textContent),
            bold: prose.querySelector("strong")?.textContent,
            link: prose.querySelector('a[href="https://example.com/report"]')?.textContent,
            text: prose.textContent,
            script: !!prose.querySelector("script"),
            pwned: (window as Window & { __wakePwned?: boolean }).__wakePwned ?? false,
            overflow: document.documentElement.scrollWidth > innerWidth,
            preWhiteSpace: getComputedStyle(pre).whiteSpace,
            shellIsDivider: !!document.querySelector('[data-frizz-msg="w9"][data-wake-divider]'),
            trailer: document.querySelector('[data-frizz-msg="w15b"]')?.textContent,
            batched: delivery("batched"),
            mixed: delivery("batched-mixed"),
            unread: delivery("batched-unread"),
            // Two wakes that arrived APART, one above the other: the pitch a merged pair must match.
            lonePitch: top("w3") - top("w2"),
            ownWatch: ["w19b", "w19c"].map((id) => document.querySelector(`[data-frizz-msg="${id}"][data-wake-divider]`)?.textContent ?? ""),
            // EVERY hairline on the page — a rule, the label, a rule — as it is drawn: how much rule
            // shows either side, and the label as the eye reads it (`innerText` leaves out what the
            // narrow reading hides, which `textContent` above does not).
            hairlines: Array.from(document.querySelectorAll("[data-wake-divider]")).map((el) => {
              const [left, label, right] = Array.from(el.children) as HTMLElement[]
              return {
                reads: label.innerText.replace(/\s+/g, " ").trim(),
                left: left.getBoundingClientRect().width,
                right: right.getBoundingClientRect().width,
                height: label.getBoundingClientRect().height,
                clipped: label.scrollWidth > label.clientWidth + 1,
              }
            }),
          }
        })
        // THE RULE IS NEVER SQUEEZED OUT: 50px of hairline either side of every label, on one line, with
        // nothing cut off at the label's own edge. A long shell description used to take the whole row
        // (maintainer 2026-10-11: "you can barely even see the hairline anymore").
        assert.ok(result.hairlines.length >= 30, `the fixture's hairlines, got ${result.hairlines.length}`)
        for (const line of result.hairlines) {
          assert.ok(line.left >= 49.5 && line.right >= 49.5, `${width}px ${font}: "${line.reads}" leaves ${line.left.toFixed(1)}px / ${line.right.toFixed(1)}px of rule`)
          assert.ok(line.height < 24, `${width}px ${font}: "${line.reads}" wrapped to ${line.height}px`)
          assert.equal(line.clipped, false, `${width}px ${font}: "${line.reads}" is cut at the label's edge`)
        }
        // …and the room comes from a narrow READING, written per line, not from an ellipsis: the words a
        // row can do without leave whole, and what stays is the news and the PR it is about.
        const reads = (start: string) => result.hairlines.some((line) => line.reads.startsWith(start))
        const readings = width < 500
          ? ["Wait over · expand ·", "« Running the update harness against the built shell and server » finished ·", "comment #756 ·", "review comment #587 ·", "CI passed #761 · 2h ago", "PR merged #756 ·", "Watcher expired #777 ·", "Watch expired ·", "Weekly limit reset — resuming ·", "Fable 5 → Opus ·", "1 question cancelled ·", "Timer · expand ·"]
          : ["Wait over — its work finished · Click to expand ·", "Agent terminal « Running the update harness against the built shell and server » finished ·", "New comment from @colinhacks on nubjs/nub#756 ·", "New review comment from @pullfrog on nubjs/nub#587 ·", "CI passed on nubjs/nub#761 · 7 checks green ·", "PR merged on nubjs/nub#756 ·", "Watcher expired on nubjs/nub#777 ·", "Watch expired on a background shell ·", "Weekly usage limit reset — resuming ·", "Fable 5 limit — switched to Opus ·", "1 question cancelled — the worker decides it itself ·", "Timer · Click to expand ·"]
        for (const reading of readings) assert.ok(reads(reading), `${width}px ${font}: no hairline reads "${reading}…", got ${result.hairlines.map((line) => line.reads).join(" | ")}`)
        // THE REPORTED DELIVERY: a park ending beside the shell that ended it. Two hairlines, in the
        // order they were queued, and none of the envelope — not its lead, not the scheduler's reason
        // headings, not either wake's instructions to the worker.
        assert.equal(result.batched.lines.length, 2)
        assert.match(result.batched.lines[0], /^Wait over — its work finished/)
        assert.match(result.batched.lines[1], /^Agent terminal «Running the update harness against the built shell and server» finished/)
        assert.deepEqual(result.batched.cards, [], "no part of it is a card")
        assert.doesNotMatch(result.batched.text, /Frizz held|###|awaiting park named|READ ITS OUTPUT|NOTHING running|frizzctl ask|Frizz sends this because/)
        // …at the pitch of two wakes that arrived a second apart, which is the whole claim: the
        // transcript must not say which delivery carried them.
        assert.ok(Math.abs(result.batched.tops[1] - result.batched.tops[0] - result.lonePitch) < 0.5, `merged pitch ${result.batched.tops[1] - result.batched.tops[0]} vs lone ${result.lonePitch}`)
        // Every route a lone wake takes, taken from inside one delivery — and the verdict two polls
        // reported is said once. The Goal's prompt is LAST, so the delivery ends in the trailer its
        // parser anchors on: read before the split, all of this was the one line "Goal · at rest".
        assert.equal(result.mixed.lines.length, 3)
        assert.match(result.mixed.lines[0], /^CI failed on nubjs\/nub#761: build \(windows-latest\), test \(macos-14\)/)
        assert.match(result.mixed.lines[1], /^Timer/)
        assert.match(result.mixed.lines[2], /^Goal · at rest/)
        assert.doesNotMatch(result.mixed.text, /Frizz held|###|identical events|KEEP GOING|STILL ARMED/)
        // A part no parser reads keeps the card for ITSELF; the wake beside it is still a hairline.
        assert.equal(result.unread.lines.length, 1)
        assert.match(result.unread.lines[0], /^Agent terminal «vite --port 5199 --strictPort» failed/)
        assert.equal(result.unread.cards.length, 1)
        assert.match(result.unread.cards[0], /Its text survives, in a card of its own\./)
        assert.doesNotMatch(result.unread.text, /Frizz held|###|Frizz sends this because/)
        assert.match(result.ownWatch[0], /^Watch expired on a background shell/)
        assert.match(result.ownWatch[1], /^Watch expired on a sub-agent/)
        assert.deepEqual(result.headings, ["What it carries"])
        assert.ok(result.codes.includes("shells: [bc3rwp1k7]"))
        assert.equal(result.bold, "finished")
        assert.equal(result.link, "report")
        assert.doesNotMatch(result.text!, /###|Registered PR watcher|STILL ARMED/)
        assert.equal(result.script, false)
        assert.equal(result.pwned, false)
        assert.equal(result.overflow, false)
        assert.equal(result.shellIsDivider, true)
        assert.doesNotMatch(result.trailer!, /Registered PR watcher|STILL ARMED/)
        if (width < 500) assert.equal(result.preWhiteSpace, "pre-wrap")
        if (shots) {
          const card = await page.$('[data-frizz-msg="md"]')
          await card!.screenshot({ path: join(shots, `wake-${font}-${width}.png`) })
          const ink = await page.evaluate(() => {
            const title = document.querySelector('[data-frizz-msg="md"] .tracking-tight')!
            const probe = document.createElement("span")
            probe.style.cssText = "display:inline-block;width:0;height:0;padding:0;margin:0;border:0"
            title.append(probe)
            const baseline = probe.getBoundingClientRect().bottom
            probe.remove()
            const cs = getComputedStyle(title)
            const canvas = document.createElement("canvas").getContext("2d")!
            canvas.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
            const metrics = canvas.measureText(title.textContent!)
            const rects = Array.from(document.querySelectorAll('[data-frizz-msg="md"] .lucide-bell path')).map((el) => el.getBoundingClientRect())
            const iconCenter = (Math.min(...rects.map((r) => r.top)) + Math.max(...rects.map((r) => r.bottom))) / 2
            return { residualPx: iconCenter - (baseline + (metrics.actualBoundingBoxDescent - metrics.actualBoundingBoxAscent) / 2) }
          })
          console.log({ font, width, headerInk: ink })
          if (width === 1000) {
            await page.setViewport({ width, height: 1000, deviceScaleFactor: 6 })
            const header = await page.$('[data-frizz-msg="md"] .items-start')
            await header!.screenshot({ path: join(shots, `header-${font}.png`) })
          }
        }
      }
      if (shots) {
        // Reuse the project's pixel instrument against the untouched shared card header.
        console.log(execFileSync("nub", ["scripts/ink-gaps.mjs", `${baseUrl}/frizz-wake-fixture.html?font=${font}`,
          '[data-frizz-msg="md"] .tracking-tight,[data-frizz-msg="md"] .lucide-bell', "--dsf=6", "--w=1000"], { encoding: "utf8" }))
      }
    }
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
