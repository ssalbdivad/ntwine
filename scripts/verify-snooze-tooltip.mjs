// THE SNOOZE IS TOOLTIP-ONLY ON THE RAIL. No sidebar row may spend a subtitle line on a park
// ("SNOOZED · Today at 5:00 PM" / "BUMPS · …", removed 2026-08-03), and hovering the row's INDICATOR
// must be enough to read when the thread wakes — on a Snoozed row (the hourglass, which has said so for a
// while) AND on the rows a park does not quiet: one whose own turn is running, and one still waiting on
// a sub-agent it dispatched. Those two keep their live spinner and gain the park as a second tooltip
// line, which is the whole point of the change: the row says what the thread is DOING, the tooltip says
// when it goes away.
//
// Run against snoozed-rows-fixture.html on a plain Vite dev server (fixtures are NOT servable through the
// frizz stack — its Vite runs in middleware mode and falls back to index.html for every unknown path):
//   (cd packages/web && npx vite --port 5418 --strictPort)
//   nub scripts/verify-snooze-tooltip.mjs --url=http://localhost:5418/snoozed-rows-fixture.html
import { mkdirSync } from "node:fs"
import { join } from "node:path"

const args = process.argv.slice(2)
const opt = (k, d) => { const hit = args.find((a) => a.startsWith(`--${k}=`)); return hit ? hit.slice(k.length + 3) : d }
const url = opt("url", "http://localhost:5418/snoozed-rows-fixture.html")
const shots = opt("shots")

// slug → what its tooltip must prove. `state` is the live line the glyph already carried; `park` is the
// snooze sentence that now has to ride along with it.
const CASES = [
  { slug: "seed-the-buried-question-queue", glyph: "working", state: "Working", park: /^Snoozed until /m },
  // A snooze carrying a follow-up is an AUTO-snooze — frizz resumes the agent with that text — so it
  // names the bump instead of promising the card back.
  { slug: "watch-the-release-workflow", glyph: "working", state: "Working", park: /^Auto-snoozed until .* — then: Check whether the release job/m },
  { slug: "dependabot-nub-ecosystem", glyph: "held", state: null, park: /^Snoozed until /m },
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

  // 1. NO row carries an inline park label, on any band.
  const rows = await page.$$eval("[data-sidebar-item]", (els) => els.map((e) => ({
    slug: e.getAttribute("data-sidebar-item"),
    text: e.innerText.replace(/\s+/g, " ").trim(),
  })))
  if (rows.length < CASES.length) fail(`expected at least ${CASES.length} rows, saw ${rows.length}`)
  for (const row of rows) {
    if (/SNOOZED|BUMPS/.test(row.text)) fail(`${row.slug} still glosses its park inline: ${row.text}`)
  }
  if (!rows.some((r) => /SNOOZED|BUMPS/.test(r.text))) pass(`no row glosses a park inline (${rows.length} rows)`)

  // 2. Hovering the INDICATOR reveals it. Radix opens on pointerenter, so a real mouse move is required —
  //    dispatching a synthetic event would prove nothing about what a hover actually does.
  for (const c of CASES) {
    // A FRESH LOAD per case. Hovering several triggers in one page is not worth debugging: Radix leaves
    // the closing tooltip's wrapper behind for a beat and the next hover intermittently never opens, so
    // a sequential run reports "this row has no tooltip" for a row that demonstrably has one. One page
    // per assertion is slower and says exactly what it means.
    await page.reload({ waitUntil: "networkidle0" })
    await page.waitForSelector("[data-sidebar-item]")
    const sel = `[data-sidebar-item="${c.slug}"] [data-rail-glyph]`
    const handle = await page.$(sel)
    if (!handle) { fail(`${c.slug}: no rail glyph to hover`); continue }
    const glyph = await handle.evaluate((el) => el.getAttribute("data-rail-glyph"))
    if (glyph !== c.glyph) fail(`${c.slug}: glyph is ${glyph}, expected ${c.glyph} (the park must not steal the live mark)`)
    await handle.hover()
    let tip = ""
    try {
      // ANY wrapper with text, not the FIRST one. A tooltip that is closing leaves its (now empty)
      // wrapper in the DOM for a beat, so `querySelector` can lock onto the corpse of the previous
      // row's tooltip and poll it until timeout — which reads exactly like "this row has no tooltip".
      const READ = `[...document.querySelectorAll("[data-radix-popper-content-wrapper]")].map((el) => el.innerText.trim()).filter(Boolean)`
      await page.waitForFunction(`(${READ}).length > 0`, { timeout: 4000 })
      tip = (await page.evaluate(READ))[0] ?? ""
    } catch { /* left empty → reported below */ }
    if (!tip) { fail(`${c.slug}: hovering the indicator opened no tooltip`); continue }
    if (c.state && !tip.includes(c.state)) fail(`${c.slug}: tooltip lost its live state "${c.state}" — got ${JSON.stringify(tip)}`)
    if (!c.park.test(tip)) fail(`${c.slug}: tooltip does not state the park — got ${JSON.stringify(tip)}`)
    else pass(`${c.slug}: ${JSON.stringify(tip.replace(/\n/g, " ⏎ "))}`)
    if (shots) {
      mkdirSync(shots, { recursive: true })
      await page.screenshot({ path: join(shots, `tooltip-${c.slug}.png`) })
    }
  }
} finally {
  await browser.close()
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
