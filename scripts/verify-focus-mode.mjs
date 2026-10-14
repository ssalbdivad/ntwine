#!/usr/bin/env node
// Drive a PROJECT'S BOARD (focus mode) — the page showing one project at `/project/<slug>`, chosen from the
// dock (web lib/pageView.ts, components/TierList.tsx) — on a real, seeded, multi-project stack, and
// check what it promised:
//   · `/project/<slug>` shows that project alone: its list, its cards, and a prompt box that dispatches into
//     it with no picker; the query-era `/?project=<slug>` (2026-09-29 to 2026-10-06) and an older
//     launcher's `?focus=<slug>` land there;
//   · the view lives in the ADDRESS, per tab: two tabs on two boards stay there across reloads; All
//     projects is `/all` (a retired `/?all` lands there), and a bare `/` goes back to the view this
//     browser showed LAST — All projects for a browser that never chose (a board from 2026-10-06 to
//     2026-10-14) — while a phone's `/` is its projects list;
//   · the dock changes the view by navigating, and Back undoes it; All projects is the
//     unified page, with the prompt box's picker carried over to the project just left;
//   · a thread drawer closes back to the tab's view, not to a guess;
//   · an unknown board says so;
//   · the board's list (TierList.tsx, the same list as All projects over one project) names its tiers in
//     order — Pinned, Ready and Working never fold, Done today lists its rows under a plain header, and
//     Snoozed (and Schedules, when there are any) fold, collapsed to start, each on its own — and the
//     project's cord strings each run's touching rows;
//   · the board's ⋯ menu offers every project back, and a dock square's right-click menu focuses one;
//   · at a phone's width nothing overflows sideways, in either view.
//
// Usage:
//   nub scripts/adhoc-stack.mjs --port=47711 --project=/tmp/x/acme-api --also-project=/tmp/x/marketing-site \
//     --also-project=/tmp/x/billing-worker --also-project=/tmp/x/docs-portal > /tmp/stack.log 2>&1   # background
//   nub scripts/seed-all-queues.mjs --stack=/tmp/stack.log && nub scripts/seed-focus-mode.mjs --stack=/tmp/stack.log
//   nub scripts/verify-focus-mode.mjs --stack=/tmp/stack.log [--shots=/abs/dir] [--only=<words in a step name>]
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { launchHeadless } from "./lib/headless-browser.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => { const s = a.slice(2); const i = s.indexOf("="); return i < 0 ? [s, true] : [s.slice(0, i), s.slice(i + 1)] }),
)
if (!flags.stack) {
  console.error("usage: nub scripts/verify-focus-mode.mjs --stack=/abs/stack.log [--shots=/abs/dir]")
  process.exit(1)
}
const line = readFileSync(flags.stack, "utf8").split("\n").find((l) => l.startsWith("{\"url\""))
if (!line) throw new Error(`no stack json line in ${flags.stack}`)
const stack = JSON.parse(line)
const origin = new URL(stack.url).origin
const projects = [stack.launcher, ...stack.tenants].map((p) => ({ id: p.id, slug: p.slug }))
const bySlug = Object.fromEntries(projects.map((p) => [p.slug, p]))
const shots = flags.shots ?? join(process.cwd(), ".adhoc-shots")
mkdirSync(shots, { recursive: true })
const [A, B] = [bySlug["acme-api"] ?? projects[0], bySlug["marketing-site"] ?? projects[1]]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
}
let failures = 0
let current
async function step(name, run) {
  if (typeof flags.only === "string" && !name.includes(flags.only)) return
  try {
    await run()
  } catch (error) {
    const shot = join(shots, `focus-mode-fail-${++failures}.png`)
    const where = await current?.evaluate(() => location.pathname + location.search).catch(() => "?")
    await current?.screenshot({ path: shot }).catch(() => {})
    check(name, false, `${error instanceof Error ? error.message : String(error)} (at ${where}; ${shot})`)
  }
}

const browser = await launchHeadless()
const errors = []
const boardReads = []
async function open(context, url, { width = 1440, height = 1000 } = {}) {
  const page = await context.newPage()
  current = page
  await page.setViewport({ width, height, deviceScaleFactor: 2 })
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }])
  page.on("pageerror", (error) => errors.push(`pageerror: ${error}`))
  page.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(`console: ${message.text()}`) })
  // A disposable stack runs no supervisor, so its control endpoint 404s on every page, and a project with no
  // icon answers its square's request with a 404 (the square falls back to its monogram); nothing else may.
  page.on("response", (response) => { if (response.status() >= 400 && !/\/_ntwine\/control\/status$|\/_ntwine\/project-icon\?/.test(response.url())) errors.push(`${response.status()} ${response.url()}`) })
  page.on("request", (request) => { const path = new URL(request.url()).pathname; if (path.endsWith("/rpc/board")) boardReads.push(path) })
  if (url) await page.goto(url, { waitUntil: "networkidle2" })
  return page
}
const address = (page) => page.evaluate(() => location.pathname + location.search)
const waitAddress = (page, want, ms = 10_000) =>
  page.waitForFunction((want) => location.pathname + location.search === want, { timeout: ms }, want).catch(async () => { throw new Error(`the address never became ${want}; it is ${await address(page)}`) })
// The projects the list draws: each tier's runs name their project (TierList.tsx), so one project is several
// runs, and a Working run the list had no room for is one rollup line (`data-xq-rollup`).
const listed = (page) => page.$$eval("[data-xq-rail-project], [data-xq-rollup]", (groups) => [...new Set(groups.map((g) => g.getAttribute("data-xq-rail-project") ?? g.getAttribute("data-xq-rollup")))])
const cardProjects = (page) => page.$$eval("[data-xq-card]", (cards) => [...new Set(cards.map((c) => c.getAttribute("data-xq-card")?.split("/")[0]))])
// The view has painted: a project's page is titled with its name (All projects has no title) and the list
// holds exactly its projects.
const showing = async (page, project) => {
  await page.waitForFunction((name) => (document.querySelector("[data-xq-page-title-name]")?.textContent?.trim() ?? "") === name, { timeout: 10_000 }, project ? project.slug : "")
  await page.waitForSelector("[data-xq-rail-project]")
  await sleep(500)
}
// Click only once the target is inside the viewport, unoccluded and holding still for two frames (a Radix
// menu mounts its items before positioning them; a drawer slides in).
const clickSettled = async (page, selector, { text } = {}) => {
  const handle = await page.waitForFunction(
    (selector, text) => new Promise((resolve) => {
      const el = [...document.querySelectorAll(selector)].find((candidate) => text === undefined || candidate.textContent?.trim() === text)
      const at = el?.getBoundingClientRect()
      if (!el || !at || at.width === 0) return resolve(null)
      const hit = document.elementFromPoint(at.x + at.width / 2, at.y + at.height / 2)
      if (at.top < 0 || at.bottom > innerHeight || at.left < 0 || at.right > innerWidth || !hit || !(el === hit || el.contains(hit))) {
        el.scrollIntoView({ block: "center", inline: "nearest" })
        return resolve(null)
      }
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const now = el.getBoundingClientRect()
        resolve(now.x === at.x && now.y === at.y ? el : null)
      }))
    }),
    { timeout: 8000 },
    selector,
    text,
  ).catch(async () => { throw new Error(`${selector}${text ? ` "${text}"` : ""} never settled on screen; at ${await address(page)}`) })
  await handle.asElement().click()
}
// The dock (ProjectDock.tsx) is the one place to choose a view: All leads it, then a square per project.
const choose = (page, value) => clickSettled(page, value === "all-projects" ? '[data-tour="dock-all"] [data-xq-lens="All"]' : `[data-xq-dock-square="${value}"]`)

try {
  // ── the board's address ────────────────────────────────────────────────────────────────────────────
  const main = await browser.createBrowserContext()
  let page = await open(main, `${origin}/project/${A.slug}`)
  await step("/project/<slug> shows that project alone", async () => {
    await showing(page, A)
    check("…the address keeps naming it", (await address(page)) === `/project/${A.slug}`, await address(page))
    const groups = await listed(page)
    check("…the list is that project alone", groups.length === 1 && groups[0] === A.id, groups.join(", "))
    const cards = await cardProjects(page)
    check("…the queue is its cards alone", cards.length === 1 && cards[0] === A.id, cards.join(", "))
    check("…the prompt box has no project picker", (await page.$("[data-xq-project-picker]")) === null)
    check("…and no card wears a project chip", (await page.$("[data-xq-card] [data-xq-chip]")) === null)
    check("…and the list has no Add-a-project row", !(await page.$$eval("[data-xq-rail] button", (bs) => bs.some((b) => b.textContent?.trim() === "Add a project"))))
    await page.screenshot({ path: join(shots, "focus-mode-launch.png") })
  })
  await step("the page project is the focused one, so a new thread starts there", async () => {
    // The page project is whichever project the page's own client reads its board from — by slug; the
    // list reads other projects' boards by id (lib/projectBoards.ts).
    const boards = boardReads.filter((p) => !/\/_ntwine\/[0-9a-f]{8}-/.test(p))
    check("the page is bound to the focused project", boards.at(-1) === `/_ntwine/${A.slug}/rpc/board`, boards.join(", "))
  })

  // ── the board's tiers ──────────────────────────────────────────────────────────────────────────────
  // One list for every view since 2026-10-14 (TierList.tsx): a section per tier, `[data-xq-tier]`, each under a
  // SectionHeader (`data-band-header`). The three in flight are plain names; the quiet ones are folds.
  const TIERS = ["pinned", "ready", "working", "snoozed", "done", "schedules"]
  await step("the board names Pinned, Ready and Working, which never fold, and their rows are its own", async () => {
    const tiers = await page.$$eval("[data-xq-tiers] > [data-xq-tier]", (els) => els.map((el) => ({ tier: el.getAttribute("data-xq-tier"), count: Number(el.getAttribute("data-xq-tier-count")) })))
    const order = tiers.map((t) => TIERS.indexOf(t.tier))
    check("the tiers stand in their order", order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), tiers.map((t) => t.tier).join(", "))
    const loud = await page.$$eval("[data-xq-tier] [data-band-header]", (els) => els.map((el) => ({ band: el.getAttribute("data-band-header"), fold: el.tagName === "BUTTON" || el.hasAttribute("aria-expanded"), text: el.textContent?.trim() })).filter((h) => ["pinned", "ready", "working"].includes(h.band)))
    check("Pinned, Ready and Working are named, in that order", loud.map((h) => h.band).join() === "pinned,ready,working" && /^Pinned/.test(loud[0]?.text ?? "") && /^Ready/.test(loud[1]?.text ?? "") && /^Working/.test(loud[2]?.text ?? ""), JSON.stringify(loud))
    check("…and none of them folds", loud.every((h) => !h.fold))
    const strays = await page.$$eval('[data-xq-tier] [data-xq-thread-row]', (rows, id) => rows.filter((row) => row.closest("[data-xq-rail-project]")?.getAttribute("data-xq-rail-project") !== id).length, A.id)
    check("…and every row is the board's project's", strays === 0, `${strays} rows of another project`)
    const marked = await page.$$eval('[data-xq-tier="pinned"] [data-xq-band="pinned"]', (els) => els.length > 0 && els.every((el) => el.querySelector("[data-rail-pin-mark]")))
    check("…and every pinned row wears its pin", marked)
    check("…and no tier is drawn empty", tiers.every((t) => t.count > 0), JSON.stringify(tiers))
  })
  await step("Snoozed folds, collapsed to start, and Done today lists its rows", async () => {
    const header = (tier) => `[data-xq-tier="${tier}"] [data-band-header]`
    const opened = () => page.$$eval('[data-xq-tier] [data-band-header][aria-expanded="true"]', (els) => els.map((el) => el.getAttribute("data-band-header")))
    const rows = (tier) => page.$$eval(`[data-xq-tier="${tier}"] [data-sidebar-item]`, (els) => els.length)
    const tiers = await page.$$eval("[data-xq-tier]", (els) => els.map((el) => el.getAttribute("data-xq-tier")))
    if (!tiers.includes("done") || !tiers.includes("snoozed")) throw new Error(`the seed needs Snoozed and Done today here; tiers: ${tiers.join(", ")}`)
    const done = await page.$eval(header("done"), (el) => ({ fold: el.tagName === "BUTTON" || el.hasAttribute("aria-expanded"), text: el.textContent?.trim() }))
    check("Done today is a plain header over its rows, with History beside it", !done.fold && /^Done today/.test(done.text ?? "") && (await rows("done")) > 0 && (await page.$('[data-xq-tier="done"] [data-xq-open-history]')) !== null, `${JSON.stringify(done)}; ${await rows("done")} rows`)
    check("every fold starts collapsed", (await opened()).length === 0, (await opened()).join(", "))
    const before = await rows("snoozed")
    await clickSettled(page, header("snoozed"))
    await page.waitForFunction((n) => document.querySelectorAll('[data-xq-tier="snoozed"] [data-sidebar-item]').length > n, { timeout: 8000 }, before)
    check("Snoozed opens alone, and lists its rows", (await opened()).join() === "snoozed", `${(await opened()).join(", ")}; ${before} → ${await rows("snoozed")} rows`)
    if (tiers.includes("schedules")) {
      await clickSettled(page, header("schedules"))
      await sleep(300)
      check("Schedules opens beside it", (await opened()).join() === "snoozed,schedules", (await opened()).join(", "))
      await clickSettled(page, header("schedules"))
      await sleep(300)
    }
    await page.screenshot({ path: join(shots, "focus-mode-quiet-open.png") })
    await clickSettled(page, header("snoozed"))
    await sleep(300)
    check("…and its header closes it again", (await opened()).length === 0 && (await rows("snoozed")) === before, `${(await opened()).join(", ")}; ${await rows("snoozed")} rows`)
  })

  // ── the cord strings each run ──────────────────────────────────────────────────────────────────────
  await step("the project's cord runs through each run's touching rows", async () => {
    // ThreadConnector's own rule (readRail): within a run (`[data-xq-rail-project]`), rows are strung while
    // they TOUCH and each holds an icon; whatever sits between two — a thread's sub-agent rows — cuts it.
    // So every touching stretch of two or more rows is one strand, from its first icon to its last.
    const span = await page.evaluate(() => {
      const spans = []
      for (const run of document.querySelectorAll("[data-xq-rail] [data-xq-rail-project]")) {
        let bottom = NaN
        let centres = []
        const flush = () => { if (centres.length > 1) spans.push([centres[0], centres.at(-1)]); centres = [] }
        for (const row of run.querySelectorAll(":scope > [data-xq-thread-row]")) {
          const slot = row.querySelector("[data-xq-indicator]")
          const r = row.getBoundingClientRect()
          if (!slot || Math.abs(r.top - bottom) > 1) flush()
          bottom = r.bottom
          if (!slot) continue
          const icon = (slot.firstElementChild ?? slot).getBoundingClientRect()
          centres.push(icon.top + icon.height / 2)
        }
        flush()
      }
      const ys = [...document.querySelectorAll("[data-thread-cords] path")].flatMap((p) => [...(p.getAttribute("d") ?? "").matchAll(/(-?[\d.]+)[ ,](-?[\d.]+)/g)].map((m) => Number(m[2])))
      const near = (y) => ys.some((v) => Math.abs(v - y) < 2)
      return { spans: spans.length, missed: spans.filter(([a, b]) => !near(a) || !near(b)).map(([a, b]) => `${Math.round(a)}–${Math.round(b)}`) }
    })
    if (span.spans === 0) throw new Error("no run of two touching rows to string (reseed)")
    check("the connector draws a strand from the first icon to the last of every touching stretch", span.missed.length === 0, `${span.spans} stretches; missed ${span.missed.join(", ") || "none"}`)
  })

  // ── drawers go home to the tab's view ──────────────────────────────────────────────────────────────
  await step("a thread drawer closes back to the focused view", async () => {
    const row = `[data-xq-tier="working"] [data-xq-rail-project="${A.id}"] > [data-xq-band="working"] button`
    if (!(await page.$(row))) throw new Error("no Working row to open (reseed, or respin the seeded workers)")
    await clickSettled(page, row)
    await page.waitForFunction(() => /^\/project\/[^/]+\/thread\/[^/]+$/.test(location.pathname), { timeout: 8000 })
    await page.waitForSelector("[data-drawer-layer]", { timeout: 8000 })
    check("a Working row opens its drawer on the board", true, await address(page))
    // At once, not once it has settled: a focused project's row opens its drawer STORE-first, and a close
    // that landed before the route had committed the drawer's address was re-opened by that address
    // (lib/router.ts `stale`) — 6 of 6 tries stuck on a loaded machine before the fix. Escape leaves a
    // focused composer first and closes the drawer on a later press, so three, 150ms apart.
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Escape")
      await sleep(150)
    }
    await waitAddress(page, `/project/${A.slug}`)
    check("closing it comes back to /project/<slug>", true)
    await sleep(3000)
    const reopened = await page.evaluate(() => ({ drawer: Boolean(document.querySelector("[data-drawer-layer]")), at: location.pathname + location.search }))
    check("…and it stays closed, though Escape came before the route had caught up", !reopened.drawer && reopened.at === `/project/${A.slug}`, reopened.at)
  })

  // ── the dock ──────────────────────────────────────────────────────────────────────────────────────
  await step("the dock focuses another project, and Back returns", async () => {
    await choose(page, B.slug)
    await waitAddress(page, `/project/${B.slug}`)
    await showing(page, B)
    const groups = await listed(page)
    check("the dock focuses the page on the project chosen", groups.length === 1 && groups[0] === B.id, groups.join(", "))
    const cards = await cardProjects(page)
    check("…with its cards alone", cards.every((c) => c === B.id), cards.join(", "))
    await page.goBack()
    await waitAddress(page, `/project/${A.slug}`)
    await showing(page, A)
    check("Back returns to the project before", (await listed(page)).join() === A.id)
  })
  await step("All projects is the unified page, its picker carried over from the project left", async () => {
    await choose(page, "all-projects")
    await waitAddress(page, "/all")
    await showing(page, null)
    const groups = await listed(page)
    // The list is threads, not projects: a project with nothing open has no row, and its square in the dock
    // is where it is found (ProjectDock.tsx).
    check("All projects lists more than one project's threads", groups.length > 1, `${groups.length} projects listed`)
    const docked = await page.$$eval("[data-xq-dock-square][data-xq-dock-in-view]", (els) => els.map((el) => el.getAttribute("data-xq-dock-square")))
    check("…and the dock holds every project, all in view", projects.every((p) => docked.includes(p.slug)), docked.join(", "))
    const cards = await cardProjects(page)
    check("…and every project's cards", cards.length > 1, `${cards.length} projects' cards`)
    const picked = await page.$eval("[data-xq-picker-name]", (el) => el.textContent?.trim()).catch(() => null)
    check("…with the prompt box's picker, aimed where the operator just was", picked === A.slug, `picker "${picked}"`)
    check("…and each card wears its project's chip", (await page.$("[data-xq-card] [data-xq-chip]")) !== null)
    await page.screenshot({ path: join(shots, "focus-mode-all.png") })
  })
  await step("a card's chip focuses the page on its project", async () => {
    const chip = await page.$eval(`[data-xq-card] [data-xq-chip="${B.id}"]`, (el) => el.getAttribute("data-xq-chip")).catch(() => null)
    if (!chip) throw new Error(`no ${B.slug} card with a chip`)
    await clickSettled(page, `[data-xq-card] button[data-xq-chip="${B.id}"]`)
    await waitAddress(page, `/project/${B.slug}`)
    await showing(page, B)
    check("a card's chip focuses the page on its project", (await listed(page)).join() === B.id)
  })
  await step("the board's ⋯ menu offers every project back, and a dock square's focuses one", async () => {
    // On a board the ⋯ sits beside the repo in the status row (BoardIdentity.tsx); in All projects the same
    // menu is a right-click on the project's square in the dock (ProjectDock.tsx).
    await page.hover("[data-xq-board-identity]")
    await clickSettled(page, `[data-xq-board-identity] button[aria-label^="More actions for"]`)
    await clickSettled(page, '[role="menuitem"]', { text: "Show all projects" })
    await waitAddress(page, "/all")
    await showing(page, null)
    await page.click(`[data-xq-dock-square="${A.slug}"]`, { button: "right" })
    await clickSettled(page, '[role="menuitem"]', { text: "Focus on this project" })
    await waitAddress(page, `/project/${A.slug}`)
    await showing(page, A)
    check("the ⋯ menu moves between All projects and one", true)
  })

  // ── per tab, across reloads ────────────────────────────────────────────────────────────────────────
  await step("two tabs on two boards stay there across reloads", async () => {
    const first = page
    const second = await open(main, `${origin}/project/${B.slug}`)
    await showing(second, B)
    await first.bringToFront()
    await first.reload({ waitUntil: "networkidle2" })
    await showing(first, A)
    await second.reload({ waitUntil: "networkidle2" })
    await showing(second, B)
    check("each tab keeps its board across a reload", (await address(first)) === `/project/${A.slug}` && (await address(second)) === `/project/${B.slug}`, `${await address(first)} | ${await address(second)}`)
    // The memory is the BROWSER's, not the tab's: the second tab's reload was the last view shown.
    await first.goto(`${origin}/`, { waitUntil: "networkidle2" })
    await waitAddress(first, `/project/${B.slug}`)
    await showing(first, B)
    check("a bare / goes back to the view this browser showed last (the board reloaded last)", true)
    await second.close()
    current = first
  })
  await step("a bare / remembers All projects once chosen, and a board once chosen", async () => {
    await choose(page, "all-projects")
    await waitAddress(page, "/all")
    await showing(page, null)
    await page.goto(`${origin}/`, { waitUntil: "networkidle2" })
    await waitAddress(page, "/all")
    await showing(page, null)
    check("after choosing All projects, / opens All projects", true)
    await choose(page, A.slug)
    await waitAddress(page, `/project/${A.slug}`)
    await showing(page, A)
    await page.goto(`${origin}/`, { waitUntil: "networkidle2" })
    await waitAddress(page, `/project/${A.slug}`)
    await showing(page, A)
    check("after choosing a project, / opens its board", true)
  })
  await step("a fresh browser at / lands on All projects, and a retired ?all lands on /all", async () => {
    const empty = await browser.createBrowserContext()
    const blank = await open(empty, `${origin}/`)
    await waitAddress(blank, "/all")
    await showing(blank, null)
    check("a fresh browser at / opens All projects", true)
    await blank.goto(`${origin}/?all`, { waitUntil: "networkidle2" })
    await waitAddress(blank, "/all")
    await showing(blank, null)
    check("?all is rewritten to /all", true)
    await empty.close()
    current = page
  })
  await step("an older launcher's ?focus=<slug> focuses that project", async () => {
    await page.goto(`${origin}/?focus=${B.slug}`, { waitUntil: "networkidle2" })
    await waitAddress(page, `/project/${B.slug}`)
    await showing(page, B)
    check("?focus= lands on /project/<slug>", true)
  })
  await step("the query-era /?project=<slug> lands on its board", async () => {
    await page.goto(`${origin}/?project=${A.slug}`, { waitUntil: "networkidle2" })
    await waitAddress(page, `/project/${A.slug}`)
    await showing(page, A)
    check("/?project=<slug> lands on /project/<slug>", true)
  })
  await step("an unknown board says so and shows something real", async () => {
    await page.goto(`${origin}/project/no-such-project`, { waitUntil: "networkidle2" })
    const toast = await page.waitForFunction(() => [...document.querySelectorAll("[data-sonner-toast], [role='status'], [data-toast]")].map((t) => t.textContent).find((t) => t?.includes("No project named no-such-project")) ?? null, { timeout: 6000 }).then(() => true, () => false)
    const now = await address(page)
    check("an unknown board is reported and replaced", toast && now !== "/project/no-such-project", now)
  })

  // ── a phone's width ────────────────────────────────────────────────────────────────────────────────
  for (const [view, url] of [["focused", `/project/${A.slug}`], ["All projects", "/all"]]) {
    await step(`at 420px nothing overflows sideways (${view})`, async () => {
      await page.setViewport({ width: 420, height: 900, deviceScaleFactor: 2 })
      await page.goto(`${origin}${url}`, { waitUntil: "networkidle2" })
      // A phone's own layout of the page (PhonePage.tsx), focused or All projects.
      await page.waitForSelector(`[data-mobile-board="${view === "focused" ? "project" : "all"}"]`)
      await sleep(800)
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      check(`at 420px nothing overflows sideways (${view})`, overflow <= 0, `${overflow}px`)
      await page.screenshot({ path: join(shots, `focus-mode-narrow-${view === "focused" ? "focus" : "all"}.png`), fullPage: true })
    })
  }
  await step("a phone's / is its projects list, and choosing from it pushes", async () => {
    await page.setViewport({ width: 420, height: 900, deviceScaleFactor: 2 })
    await page.goto(`${origin}/`, { waitUntil: "networkidle2" })
    await page.waitForSelector("[data-mobile-projects-page]")
    check("a phone's / stays / and shows the projects list", (await address(page)) === "/", await address(page))
    check("…with nothing marked as the view showing", (await page.$('[data-mobile-project-row][aria-current="page"]')) === null)
    await clickSettled(page, `[data-mobile-project-row="${B.slug}"]`)
    await waitAddress(page, `/project/${B.slug}`)
    await page.waitForSelector('[data-mobile-board="project"]')
    await page.goBack()
    await waitAddress(page, "/")
    await page.waitForSelector("[data-mobile-projects-page]")
    check("…and Back from the board chosen returns to the list", true)
  })

  check("no page errors", errors.length === 0, errors.slice(0, 4).join(" | "))
} finally {
  await browser.close()
}
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
