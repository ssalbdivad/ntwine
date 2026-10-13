// A HELD row that is waiting on a PR says so with GitHub's mark, not the generic hourglass.
//
// The rail's park mark is an hourglass — "parked on the clock". For a `pr-watch:` fence the clock is
// only a backstop: the scheduler polls the PR and clears the park the moment new activity lands
// (scheduler.ts, the clear-snooze-on-pr-watch-wake), so GitHub is what actually wakes the row. A watch
// never parks ITSELF (groups.ts parkedAwaitingHint keeps it a visible queue handoff), so the rows this
// covers are the two that get parked anyway: one the human snoozed off the "PR watcher armed" card,
// and one whose worker co-declared a `human:` gate beside the watch.
//
// Sidebar.snoozedWatch.test.ts pins the glyph on SSR markup; this pins it on the REAL rail, together with
// the tooltip — which SSR cannot see at all, because Radix mounts the content only once it opens.
//
// Run against snoozed-rows-fixture.html on a plain Vite dev server (fixtures are NOT servable through the
// frizz stack — its Vite runs in middleware mode and falls back to index.html for every unknown path):
//   (cd packages/web && nubx vite --port 5421 --strictPort)
//   nub scripts/verify-snoozed-watch-glyph.mjs --url=http://localhost:5421/snoozed-rows-fixture.html
import { mkdirSync } from "node:fs"
import { join } from "node:path"

const args = process.argv.slice(2)
const opt = (k, d) => { const hit = args.find((a) => a.startsWith(`--${k}=`)); return hit ? hit.slice(k.length + 3) : d }
const url = opt("url", "http://localhost:5421/snoozed-rows-fixture.html")
const shots = opt("shots")

// slug → the mark it must wear, and the fence clause its tooltip must carry. The popover is ONE
// sentence: the park state leads (that is what the glyph claims) and the generated wait clause finishes
// it — see Sidebar.tsx `popover`, which is the one place that shape is decided.
const CASES = [
  // The FIRST line only: frizz's own sentence. A fence's prose — its Markdown body, or a legacy
  // `reason:` — follows as its own paragraph, and this fixture's watch row carries one.
  { slug: "watch-the-resolver-pr", icon: "lucide-github", tip: /^Snoozed until .* — waiting on acme\/app#391\n/ },
  // The other three Snoozed rows are the control: a timer park, a plain user snooze, and a usage-limit
  // park. None of them is watching anything, so none may pick up the PR mark. The timer wears the
  // HOURGLASS — "parked on the clock" — the same mark a queued timer wait wears since 2026-09-07 (it
  // drew lucide's Clock here from 2026-08-15 until then; see Sidebar.tsx hourglassMark).
  { slug: "check-in-on-create-prs", icon: "lucide-hourglass", tip: null },
  { slug: "dependabot-nub-ecosystem", icon: "lucide-hourglass", tip: null },
  { slug: "refactor-usage-endpoint", icon: "lucide-hourglass", tip: null },
]

const { launchHeadless } = await import("./lib/headless-browser.mjs")
const browser = await launchHeadless()
let failures = 0
const fail = (msg) => { failures++; console.log(`FAIL  ${msg}`) }
const pass = (msg) => console.log(`PASS  ${msg}`)
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 760, height: 560, deviceScaleFactor: 2 })
  await page.goto(url, { waitUntil: "networkidle0", timeout: 60000 })
  await page.waitForSelector("[data-sidebar-item]")

  // 1. The mark. One pass over the rendered rail — lucide stamps its icon name onto the <svg>, which is
  //    the only thing separating two 9px glyphs in the same status box.
  const marks = await page.$$eval("[data-sidebar-item]", (els) => Object.fromEntries(els.map((e) => [
    e.getAttribute("data-sidebar-item"),
    e.querySelector("[data-rail-glyph] svg")?.getAttribute("class") ?? "",
  ])))
  for (const c of CASES) {
    const cls = marks[c.slug]
    if (cls === undefined) { fail(`${c.slug}: row not on the rail`); continue }
    if (!cls.includes(c.icon)) fail(`${c.slug}: expected ${c.icon}, saw "${cls}"`)
    else pass(`${c.slug} wears ${c.icon}`)
  }

  // 2. The tooltip. Radix opens on pointerenter, so a REAL mouse move is required — a synthetic event
  //    would prove nothing about what a hover does. A FRESH LOAD per case, for the reason
  //    verify-snooze-tooltip.mjs documents: Radix leaves a closing tooltip's wrapper behind for a beat
  //    and the next hover intermittently never opens, so a sequential run reports "no tooltip" for a row
  //    that demonstrably has one.
  for (const c of CASES.filter((x) => x.tip)) {
    await page.reload({ waitUntil: "networkidle0" })
    await page.waitForSelector("[data-sidebar-item]")
    const box = await page.$eval(
      `[data-sidebar-item="${c.slug}"] [data-rail-glyph]`,
      (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } },
    )
    await page.mouse.move(box.x, box.y)
    let text = ""
    try {
      await page.waitForSelector("[data-radix-popper-content-wrapper]", { timeout: 4000 })
      // The VISIBLE content div, not the `[role="tooltip"]` element — that one is Radix's 1x1
      // visually-hidden a11y mirror, and it is `white-space: nowrap`, so reading it collapses the
      // newline and makes a correctly two-line tooltip look like one run-on line.
      text = await page.$eval("[data-radix-popper-content-wrapper] > div", (el) => {
        const copy = el.cloneNode(true)
        for (const mirror of copy.querySelectorAll('[role="tooltip"]')) mirror.remove()
        return copy.textContent
      })
    } catch { /* left empty — the assertion below reports it */ }
    // ONE sentence: the park leads (it is what the glyph you pointed at is claiming) and the watched ref
    // finishes it. The watch replaces the glyph, not the story.
    if (!c.tip.test(text)) fail(`${c.slug}: tooltip must read "<park> — waiting on <ref>"; saw ${JSON.stringify(text)}`)
    else pass(`${c.slug} tooltip is one sentence, park first (${JSON.stringify(text)})`)
    await page.mouse.move(0, 0)
  }

  if (shots) {
    mkdirSync(shots, { recursive: true })
    await page.reload({ waitUntil: "networkidle0" })
    await page.waitForSelector("[data-sidebar-item]")
    await (await page.$("section:last-of-type")).screenshot({ path: join(shots, "held-watch-glyph.png") })
  }
} finally {
  await browser.close()
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
