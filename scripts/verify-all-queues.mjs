#!/usr/bin/env node
// Drive the page's ALL PROJECTS view (`/all`, web lib/pageView.ts — "Everything" until focus mode, `/?all`
// from 2026-09-29 to 2026-09-30, and bare `/` until the project board became the default view on
// 2026-10-06) in a real headless browser against a seeded
// multi-project stack, and check that every action taken on a card lands on the card's OWN project — and
// that the view works as a MODE: threads open in place, and new ones start in any project from it.
//
// Its one hard problem: All projects shows every project but is BOUND to one (the page project — the
// prompt box's pick), so the page-level client (`rpc`) means that project there, and a slug is unique only
// within a project — an action wired to the wrong client either fails against the page's project or,
// worse, succeeds on its namesake. So the page is bound to the launcher (reached the way a person reaches
// it: the project's board, `/project/<slug>`, then the dock's All, which carries the project
// over as the pick), every write is taken on a TENANT's card (where the page client would be wrong), and
// the same-slug pair the seed plants (`fix-flaky-login-test`, in the launcher AND a tenant) is checked from
// both sides — from the cards, and from a tenant's drawer opened in place.
//
// Usage: node scripts/verify-all-queues.mjs --stack=/abs/stack.log [--shots=/abs/dir]
//   against a stack booted by adhoc-stack.mjs (with --also-project for marketing-site, billing-worker and
//   docs-portal) and seeded by scripts/seed-all-queues.mjs. It MUTATES that state, and a reseed does not
//   undo all of it (snoozes and completions outlive the seed's rows): run it on a freshly booted stack.
//   Exits non-zero when any check fails.
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { launchHeadless } from "./lib/headless-browser.mjs"
import { createRpcClient } from "./lib/rpc-client.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => { const s = a.slice(2); const i = s.indexOf("="); return i < 0 ? [s, true] : [s.slice(0, i), s.slice(i + 1)] }),
)
if (!flags.stack) {
  console.error("usage: node scripts/verify-all-queues.mjs --stack=/abs/stack.log [--shots=/abs/dir]")
  process.exit(1)
}
const line = readFileSync(flags.stack, "utf8").split("\n").find((l) => l.startsWith("{\"url\""))
if (!line) throw new Error(`no stack json line in ${flags.stack}`)
const stack = JSON.parse(line)
const origin = new URL(stack.url).origin
const ids = Object.fromEntries([[stack.launcher.slug, stack.launcher.id], ...stack.tenants.map((t) => [t.slug, t.id])])
const shots = flags.shots ?? join(process.cwd(), ".adhoc-shots")
mkdirSync(shots, { recursive: true })

const clients = new Map()
const api = (project) => {
  if (!clients.has(project)) clients.set(project, createRpcClient(`${origin}/`, ids[project]))
  return clients.get(project)
}
const threadOf = async (project, slug) => (await api(project).query("board")).threads.find((t) => t.id === slug)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(what, predicate, ms = 10_000) {
  const deadline = Date.now() + ms
  let last
  while (Date.now() < deadline) {
    last = await predicate()
    if (last) return last
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${what}`)
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
}
async function step(name, run) {
  try {
    await run()
  } catch (error) {
    check(name, false, error instanceof Error ? error.message : String(error))
  }
}

const card = (project, slug) => `[data-xq-card="${ids[project]}/${slug}"]`
// ALL PROJECTS' ADDRESS. `/all` is its name from now on (David 2026-10-06: the project board becomes the
// default view, and `/` a redirect to the view the browser last showed), so nothing here asks for a bare
// `/`, and a desktop page never rests there: All projects resting at `/` is a regression.
const ALL_PATHS = ["/all"]

const browser = await launchHeadless()
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 })
  const errors = []
  page.on("pageerror", (error) => errors.push(`pageerror: ${error}`))
  // "Failed to load resource" is the console's echo of a failed response, which the listener below
  // already records WITH its URL — kept once, where it says what failed.
  page.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(`console: ${message.text()}`) })
  page.on("response", (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
  // Every WRITE the page makes, by path — `/_ntwine/<project id>/rpc/<procedure>` names who it went to.
  //
  // RECORDED TWICE, because neither record is complete alone. CDP's `request` event leaves the renderer
  // only once the task that made the fetch has finished, and a card's Mark as done runs the queue's whole
  // re-render in that task, after the fetch. Measured 2026-09-28 at a 6x CPU throttle
  // (scripts/verify-all-queues.mjs's own step, clicked on eight cards): the event trailed the fetch by
  // 600–1000ms, and on 3 of the 8 it arrived after the server had already archived the thread. So a check
  // that read CDP's record the moment the server showed the effect found no write at all. That was the
  // "completeThread went to nobody" failure, 1 run in 4 unthrottled on a loaded machine. The in-page log is
  // written by the fetch call itself, before the request can reach the server, but it lives only as long
  // as its document; CDP's covers every document before this one.
  const writes = []
  page.on("request", (request) => { if (request.method() === "POST" && request.url().includes("/rpc/")) writes.push(new URL(request.url()).pathname) })
  await page.evaluateOnNewDocument(() => {
    const send = window.fetch
    window.__ntwineWrites = []
    window.fetch = function (input, init) {
      const request = input instanceof Request ? input : null
      const path = new URL(request ? request.url : String(input), location.href).pathname
      if ((init?.method ?? request?.method ?? "GET").toUpperCase() === "POST" && path.includes("/rpc/")) window.__ntwineWrites.push(path)
      return send.apply(this, arguments)
    }
  })
  const pageWrites = () => page.evaluate(() => window.__ntwineWrites ?? [])
  const writesSoFar = async () => [...new Set([...writes, ...(await pageWrites())])]
  const wrote = async (project, procedure) => (await writesSoFar()).includes(`/_ntwine/${ids[project]}/rpc/${procedure}`)
  // A button by what it SAYS to a person: its text, or its accessible name when it is a glyph. The card's
  // lifecycle verbs became glyphs in its header on 2026-10-05 (ThreadLifecycle.tsx, upstream's move out of
  // the footer): Mark as done is a ✓ whose words live in `aria-label` now, and a text-only search found
  // no button at all.
  const buttonIn = async (scope, text) => {
    const handle = await page.evaluateHandle((scope, text) => [...document.querySelectorAll(`${scope} button`)].find((b) => b.textContent?.trim().includes(text) || b.getAttribute("aria-label") === text) ?? null, scope, text)
    const element = handle.asElement()
    if (!element) throw new Error(`no button "${text}" in ${scope}`)
    return element
  }
  // A thread's row in its project's group on the rail, by SLUG. A row shows the thread's name as its
  // `@` handle (web groups.ts displayTitle, since 2026-09-29: "Fix the flaky login test" reads
  // `fix-the-flaky-login-test`), and a title past five words shows as written, so the words a row shows
  // are not a stable handle on it; the slug is.
  const railRow = async (project, slug) => {
    const element = await page.$(`[data-xq-rail-project="${ids[project]}"] [data-sidebar-item="${slug}"] > button`)
    if (!element) throw new Error(`no row ${slug} in ${project}'s group`)
    return element
  }

  // Generous, because this machine is shared: at a load average of 30+ a cold page load alone has taken
  // 20s, and every wait below is for a condition, so a slow pass costs time and never a verdict.
  page.setDefaultNavigationTimeout(90_000)
  // Escape leaves a focused composer first and closes the drawer on the next press; a terminal keeps its
  // Escape (it belongs to the program in the pty), so that one is closed by a click outside the sheet.
  const closeDrawer = async () => {
    for (let i = 0; i < 3 && (await page.$("[data-drawer-layer]")); i++) {
      if (i === 2) await page.mouse.click(6, 6)
      else await page.keyboard.press("Escape")
      await sleep(450)
    }
  }
  const picker = () => page.$eval("[data-xq-picker-name]", (el) => el.textContent?.trim() ?? "").catch(() => "")
  // The page re-renders a beat after the address bar moves (history is written first), so a check of
  // what it SAYS waits for it to say it rather than reading once.
  const pickerSays = (name, timeout = 8000) =>
    page.waitForFunction((n) => document.querySelector("[data-xq-picker-name]")?.textContent?.trim() === n, { timeout }, name).then(() => true, () => false)
  // Which projects' cards the queue shows, in the order they first appear. The page's queue is ONE queue
  // (lib/allQueues.ts mergedQueue): the per-project lanes these steps read until 2026-09-28 are gone, and
  // a card's key, `<project id>/<slug>`, is what says whose it is.
  const cardProjects = () => page.$$eval("[data-xq-card]", (els) => [...new Set(els.map((el) => el.getAttribute("data-xq-card")?.split("/")[0]))])
  // Click only once the target is where the eye would find it: inside the viewport and holding still for
  // two frames. A Radix menu mounts its items BEFORE it has positioned them (off-screen, until measured),
  // and a drawer slides in over ~300ms, so a click issued the moment the node exists lands nowhere
  // (worked out in the since-deleted verify-one-view.mjs).
  const clickSettled = async (selector) => {
    const handle = await page.waitForFunction(
      (selector) => new Promise((resolve) => {
        const el = document.querySelector(selector)
        const at = el?.getBoundingClientRect()
        if (!el || !at || at.width === 0 || at.top < 0 || at.bottom > innerHeight || at.left < 0 || at.right > innerWidth) return resolve(null)
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const now = el.getBoundingClientRect()
          resolve(now.x === at.x && now.y === at.y ? el : null)
        }))
      }),
      { timeout: 8000 },
      selector,
    ).catch(() => { throw new Error(`${selector} never settled on screen`) })
    await handle.asElement().click()
  }
  // The same, for a target that may be off screen: brought to the middle of the viewport first. A bare
  // `page.click` scrolls it in and clicks where it WAS, and the queue moves under that — the viewport lock
  // re-seats the card being read, a card arriving or leaving above shifts the rest — so on 2026-10-06 a
  // card title clicked from below the fold missed its link and opened nothing, on main and this branch
  // alike.
  const clickOnScreen = async (selector) => {
    await page.$eval(selector, (el) => el.scrollIntoView({ block: "center" }))
    await clickSettled(selector)
  }
  // Put the keyboard in a text box, and PROVE it is there before a single key is typed. A key that misses
  // the box is a SHORTCUT on this page (lib/keybindings.ts: `s` snoozes the card being read, `e` opens its
  // folder, `o` its drawer, `c` is New thread), so a click that landed beside a box mid-layout once turned
  // "Please also check…" into a snooze of the card being replied to, a 500 from opening its folder on a
  // stack with no file manager, and the rest of the sentence typed into the NEW-thread box, which then
  // failed every ⌥↓ check after it (2026-10-06, 17 of 27 checks red on main and this branch alike).
  const focusBox = async (selector) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await clickOnScreen(selector)
      if (await page.$eval(selector, (el) => document.activeElement === el)) return
      await sleep(300)
    }
    throw new Error(`${selector} never took the keyboard`)
  }
  // All projects, reached the way a person reaches it: the project's board, `/project/<slug>` (the
  // launcher's own landing was `/?project=<slug>` from 2026-09-29, and `/` from 2026-09-30) — then the
  // dock's All, which keeps that project as the prompt box's pick (AllQueues.tsx
  // useChooseView).
  const allFrom = async (slug) => {
    await page.goto(`${origin}/project/${slug}`, { waitUntil: "networkidle2" })
    await page.waitForSelector('[data-xq-dock-square][aria-current="page"]', { timeout: 30_000 })
    await clickSettled("[data-xq-dock-all]")
    await page.waitForFunction((paths) => paths.includes(location.pathname) && location.search === "", { timeout: 15_000 }, ALL_PATHS)
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark" })
    await page.waitForSelector('[data-surface="newComposer"]', { timeout: 30_000 })
    await pickerSays(slug, 30_000)
    await sleep(800)
  }

  await allFrom("acme-api")

  await step("All projects keeps the project it was left from as the page's, with its prompt box", async () => {
    await page.waitForSelector('[data-surface="newComposer"]', { timeout: 10_000 })
    const path = await page.evaluate(() => location.pathname + location.search)
    check("All projects keeps the project it was left from as the page's, with its prompt box", ALL_PATHS.includes(path) && (await pickerSays("acme-api")), `${path}, picker "${await picker()}"`)
  })

  // Until 2026-09-28 this checked a lane per project in the rail's order; the queue is one queue now, in
  // the order the threads became ready (lib/allQueues.test.ts holds that order), so what is left to
  // check here is WHOSE cards it holds.
  await step("the queue holds the cards of every project with work queued, and only those", async () => {
    // The seed queues work in these three; docs-portal (only archived threads) and any other project on
    // the stack (nothing seeded) have nothing queued, so no card. Named rather than excluded, so a fifth
    // quiet project — whatever it is called — does not read as a missing one.
    const queued = ["acme-api", "marketing-site", "billing-worker"].map((slug) => ids[slug]).sort()
    const shown = (await cardProjects()).sort()
    check("the queue holds the cards of every project with work queued, and only those", JSON.stringify(shown) === JSON.stringify(queued), `${shown.length} projects' cards`)
    const cards = await page.$$eval("[data-xq-card]", (els) => els.length)
    // Nine agent threads. A terminal is not a thread: billing-worker's, at its OTP prompt, has no card of
    // its own — it rides the card of the thread it was opened on.
    check("every queued thread has a card", cards === 9, `${cards} cards`)
    const both = await Promise.all([page.$(card("acme-api", "fix-flaky-login-test")), page.$(card("marketing-site", "fix-flaky-login-test"))])
    check("the same slug in two projects is two cards", both.every(Boolean))
  })

  await page.screenshot({ path: join(shots, "aq-verify-top.png") })

  await step("a relative file path in a card links the card's own project's file", async () => {
    // billing-worker's handoff names `jobs/enqueue.ts`, which the seed plants in billing-worker AND the
    // launcher: resolved through the page's client it would link the launcher's.
    const scope = card("billing-worker", "dunning-retry-schedule")
    const linked = await waitFor("the path to resolve", () => page.$eval(scope, (el) => [...el.querySelectorAll("code[data-local-path]")].map((c) => c.getAttribute("data-local-path"))).then((paths) => (paths.length ? paths : null)))
    const billingDir = stack.tenants.find((t) => t.slug === "billing-worker").dir
    check("a relative file path in a card links the card's own project's file", linked.some((p) => p.startsWith(billingDir) && p.endsWith("jobs/enqueue.ts")) && !linked.some((p) => p.startsWith(stack.launcher.dir)), linked.join(", "))
  })

  await step("Show more opens a long handoff in place", async () => {
    const scope = card("acme-api", "fix-flaky-login-test")
    const before = await page.$eval(scope, (el) => el.getBoundingClientRect().height)
    await page.click(`${scope} [data-xq-show-more]`)
    await sleep(300)
    const after = await page.$eval(scope, (el) => el.getBoundingClientRect().height)
    check("Show more opens a long handoff in place", after > before + 40, `${Math.round(before)} → ${Math.round(after)}px`)
  })

  await step("a queue row in the rail brings its card up and rings it", async () => {
    await page.evaluate(() => window.scrollTo(0, 0))
    const row = await railRow("marketing-site", "fix-flaky-login-test")
    // The ring lasts 1100ms, so it is WATCHED for rather than sampled: at a load average of 30+ the read
    // below landed past it once, on a ring that had been set 5ms after the click.
    await page.$eval(`${card("marketing-site", "fix-flaky-login-test")} [data-xq-card-root]`, (root) => {
      window.__rang = false
      new MutationObserver(() => { if (root.hasAttribute("data-queue-flash")) window.__rang = true }).observe(root, { attributes: true })
    })
    await row.click()
    await sleep(900)
    const at = await page.$eval(card("marketing-site", "fix-flaky-login-test"), (el) => ({
      top: Math.round(el.getBoundingClientRect().top),
      // A card in the page's last screenful cannot reach the top; the page scrolling to its end is the
      // most it can do, and the card is then in view.
      atEnd: Math.ceil(window.scrollY + window.innerHeight) >= document.documentElement.scrollHeight - 1 && el.getBoundingClientRect().bottom <= window.innerHeight,
      flash: window.__rang === true,
    }))
    check("a queue row in the rail brings its card up and rings it", ((at.top >= 0 && at.top < 160) || at.atEnd) && at.flash === true, `card top ${at.top}px${at.atEnd ? " (page end)" : ""}, ring ${at.flash}`)
  })

  await step("Snooze on a tenant's card snoozes ITS thread, not the launcher's namesake", async () => {
    const scope = card("marketing-site", "fix-flaky-login-test")
    // The header's alarm clock (SnoozeMenu) opens every preset; pick one.
    const snooze = await page.$(`${scope} [data-snooze-menu]`)
    if (!snooze) throw new Error("no snooze button")
    await snooze.click()
    await page.waitForSelector(`[role="menu"] [data-value="tomorrow"]`, { timeout: 3000 })
    await page.click(`[role="menu"] [data-value="tomorrow"]`)
    const tenant = await waitFor("the tenant thread to snooze", async () => { const t = await threadOf("marketing-site", "fix-flaky-login-test"); return t?.snoozedUntil ? t : null })
    const namesake = await threadOf("acme-api", "fix-flaky-login-test")
    check("Snooze on a tenant's card snoozes ITS thread, not the launcher's namesake", Boolean(tenant.snoozedUntil) && !namesake?.snoozedUntil && (await wrote("marketing-site", "setThreadSnooze")), `tenant until ${tenant.snoozedUntil}, namesake ${namesake?.snoozedUntil ?? "untouched"}`)
    await sleep(600)
    check("the snoozed card leaves the page", (await page.$(scope)) === null)
  })

  await step("Mark as done on a tenant's card finishes ITS thread", async () => {
    const scope = card("billing-worker", "dunning-retry-schedule")
    // What the thread was, and what the page wrote, from the click on: a thread already archived before it
    // (or archived by some other write) passes the wait below without this button having done anything.
    const before = await threadOf("billing-worker", "dunning-retry-schedule")
    const from = (await pageWrites()).length
    await (await buttonIn(scope, "Mark as done")).click()
    const done = await waitFor("the tenant thread to archive", async () => { const t = await threadOf("billing-worker", "dunning-retry-schedule"); return t && (t.archived || t.state === "archived") ? t : null })
    const after = (await pageWrites()).slice(from)
    check("Mark as done on a tenant's card finishes ITS thread", Boolean(done) && (await wrote("billing-worker", "completeThread")) && !(await wrote("acme-api", "completeThread")), `completeThread went to ${(await writesSoFar()).filter((w) => w.endsWith("/completeThread")).join(", ") || "nobody"}; before the click it was ${before ? `${before.state}${before.archived ? ", archived" : ""}` : "not on the board"}; the page wrote ${after.map((w) => w.split("/rpc/")[1]).join(", ") || "nothing"} after it`)
  })

  await step("Mark as done on the launcher's same-slug card leaves the tenant's alone", async () => {
    const scope = card("acme-api", "fix-flaky-login-test")
    await (await buttonIn(scope, "Mark as done")).click()
    await waitFor("the launcher thread to archive", async () => { const t = await threadOf("acme-api", "fix-flaky-login-test"); return t && (t.archived || t.state === "archived") ? t : null })
    const tenant = await threadOf("marketing-site", "fix-flaky-login-test")
    check("Mark as done on the launcher's same-slug card leaves the tenant's alone", tenant && !tenant.archived && tenant.state !== "archived", `tenant state ${tenant?.state}`)
  })

  // The seed opened a real terminal on a thread in billing-worker (at an OTP prompt) and in the launcher
  // (finished). A terminal rides its thread: a line in the thread's strip, and a terminal of yours at a
  // prompt QUEUES the thread, so its rail row is a Queue row. It also drew its own mark after the row's
  // title until 79465725 (2026-09-30) dropped it as a repeat of exactly that: what the rail says about a
  // waiting prompt is now the row's band and its rest time, which is what this checks.
  const terminalOf = async (project, slug) => (await threadOf(project, slug))?.terminals?.[0]

  await step("a tenant's terminal at a prompt shows its own screen on its thread's card, and queues its row", async () => {
    const scope = card("billing-worker", "publish-billing-client")
    await page.$eval(scope, (el) => el.scrollIntoView({ block: "center" }))
    // The screen is the pty's replay over `/term/<id>` — which, addressed through the page, would ask the
    // launcher's terminal server for an id it never minted.
    const screen = await waitFor("the terminal's screen", () => page.$eval(scope, (el) => el.querySelector("[data-terminal-prompt-pane] .xterm-rows")?.textContent?.includes("Enter one-time password") ?? false), 8_000).catch(() => false)
    const line = await page.$eval(scope, (el) => el.querySelector("[data-terminal-row]")?.textContent ?? "")
    const row = await page.$eval(`[data-xq-rail-project="${ids["billing-worker"]}"] [data-sidebar-item="publish-billing-client"]`, (el) => ({ band: el.getAttribute("data-xq-band"), age: el.querySelector("[data-rail-rested-age]")?.textContent?.trim() ?? null })).catch(() => null)
    check("a tenant's terminal at a prompt shows its own screen on its thread's card, and queues its row", screen && line.includes("waiting for input") && row?.band === "ready" && Boolean(row.age), `screen ${screen ? "replayed" : "blank"}, line "${line}", rail row ${row ? `in ${row.band}${row.age ? `, rested ${row.age}` : ", no rest time"}` : "missing"}`)
    await page.screenshot({ path: join(shots, "aq-verify-terminal.png") })
  })

  await step("Mark as done on a tenant's thread stops ITS terminal, after asking", async () => {
    const before = await terminalOf("billing-worker", "publish-billing-client")
    await (await buttonIn(card("billing-worker", "publish-billing-client"), "Mark as done")).click()
    // A running terminal holds Done back: the dialog names it, and only the confirmation stops it.
    const named = await waitFor("the confirmation", () => page.evaluate(() => document.querySelector("[data-completion-hold]")?.textContent ?? null), 8_000).catch(() => null)
    await waitFor("the confirm button", () => page.evaluate(() => {
      const button = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "End session & mark done")
      button?.click()
      return Boolean(button)
    }), 8_000)
    const done = await waitFor("the tenant thread to archive", async () => { const t = await threadOf("billing-worker", "publish-billing-client"); return t?.state === "archived" ? t : null }).catch(() => null)
    const launcher = await terminalOf("acme-api", "rate-limit-headers")
    // Let the card finish leaving before the next step takes a handle on a card beneath it: the queue
    // re-lays out as it goes, and a handle taken mid-exit is detached by the time it is clicked.
    await waitFor("the done card to leave the page", async () => ((await page.$(card("billing-worker", "publish-billing-client"))) === null ? true : null), 8_000).catch(() => null)
    await sleep(600)
    check(
      "Mark as done on a tenant's thread stops ITS terminal, after asking",
      Boolean(named?.includes("1 terminal")) && Boolean(done) && (done.terminals ?? []).length === 0 && (await wrote("billing-worker", "completeThread")) && launcher !== undefined && launcher.id !== before?.id,
      `dialog ${named ? `"${named.slice(0, 60)}…"` : "missing"}, tenant ${done ? "archived" : "still open"}, launcher's terminal ${launcher ? "kept" : "gone"}`,
    )
  })

  await step("answering a tenant's registered question answers it there", async () => {
    const scope = card("marketing-site", "hero-copy-variants")
    // An option is a row whose button carries no text of its own (it is labelled by the row). Found again
    // on each try: the card re-renders on the 3s poll, and a handle held across that is detached.
    let chose = false
    for (let attempt = 0; attempt < 5 && !chose; attempt++) {
      const option = (await page.evaluateHandle((scope) => [...document.querySelectorAll(`${scope} [data-question-option]`)].find((row) => row.textContent?.includes("Every agent, one board"))?.querySelector("button") ?? null, scope)).asElement()
      chose = option !== null && (await option.click().then(() => true, () => false))
      if (!chose) await sleep(200)
    }
    if (!chose) throw new Error("no option \"Every agent, one board\" to click")
    // THE PICK IS THE SEND. Since 2c41b46f (2026-09-29) a single-choice pick that completes the ask is
    // sent on the spot, and since f515ee44 each question is sent the moment it is complete, with Send
    // answers drawn only while something is half-filled. This step clicked Send answers after the pick
    // until then, and found no button to click.
    await waitFor("the tenant question to settle", async () => { const t = await threadOf("marketing-site", "hero-copy-variants"); return t && (t.questions ?? []).length === 0 ? t : null })
    const other = await threadOf("acme-api", "rate-limit-headers")
    // A thread's `questions` lists only its OPEN rows, so the launcher's must still carry one.
    check("answering a tenant's registered question answers it there", (await wrote("marketing-site", "answerQuestions")) && (other?.questions ?? []).length > 0, `launcher's own question ${(other?.questions ?? []).length > 0 ? "still open" : "gone"}`)
  })

  await step("a reply on a tenant's card goes to ITS thread", async () => {
    const scope = card("marketing-site", "pricing-page-tiers")
    await focusBox(`${scope} textarea[data-surface="queueComposer"]`)
    await page.keyboard.type("Please also check the 1024px breakpoint.")
    await page.keyboard.press("Enter")
    await sleep(3000)
    const alert = await page.$eval(scope, (el) => el.querySelector("[role=alert]")?.textContent ?? null).catch(() => null)
    const present = (await page.$(scope)) !== null
    const draft = present ? await page.$eval(`${scope} textarea`, (el) => el.value) : ""
    check("a reply on a tenant's card goes to ITS thread", (await wrote("marketing-site", "followUp")) && !(await wrote("acme-api", "followUp")), present ? `card back with ${alert ? `error "${alert.slice(0, 80)}"` : "no error"}, draft ${draft ? "restored" : "empty"}` : "card left the queue")
  })

  // ---- The page as a MODE: nothing here leaves it -------------------------------------------------------
  await step("a tenant's thread opens in place, in its drawer", async () => {
    await page.waitForSelector("[data-xq-card]")
    const scope = card("acme-api", "upgrade-postgres-driver")
    // A marketing-site thread, by its card's title if one is still queued, else by its rail row: the seed's
    // in-flight rows rest on their own, so which of the two is on the page depends on how long this took.
    const queued = await page.$eval(`[data-xq-card^="${ids["marketing-site"]}/"]`, (el) => el.getAttribute("data-xq-card")).catch(() => null)
    if (queued) await clickOnScreen(`[data-xq-card="${queued}"] h3 a`)
    else await clickOnScreen(`[data-xq-rail-project="${ids["marketing-site"]}"] [data-sidebar-item="og-image-generator"] > button`)
    await page.waitForFunction(() => location.pathname.startsWith("/all/marketing-site/thread/"), { timeout: 8000 })
    await page.waitForSelector("[role=dialog]", { timeout: 8000 })
    await sleep(1500)
    const slug = await page.evaluate(() => location.pathname.split("/").pop())
    const expected = (await threadOf("marketing-site", slug))?.title ?? "?"
    const drawer = await page.$eval("[role=dialog]", (el) => el.textContent ?? "")
    const behind = (await cardProjects()).length
    const stillHere = (await page.$(scope)) !== null
    await page.screenshot({ path: join(shots, "xp-verify-drawer.png") })
    check("a tenant's thread opens in place, in its drawer", drawer.includes(expected) && behind > 0 && stillHere && (await pickerSays("marketing-site")), `${slug}: ${behind} projects' cards behind it, picker "${await picker()}"`)
  })

  await step("closing it hands the prompt box back to the project that was chosen", async () => {
    await closeDrawer()
    await page.waitForFunction((paths) => paths.includes(location.pathname), { timeout: 8000 }, ALL_PATHS)
    const back = await pickerSays("acme-api")
    check("closing it hands the prompt box back to the project that was chosen", back, `picker "${await picker()}"`)
  })

  await step("a follow-up typed in a tenant's drawer goes to the tenant, not the focus's namesake", async () => {
    // marketing-site's `fix-flaky-login-test` shares its slug with the launcher's, which the page was
    // focused on a moment ago. It was snoozed above, and the page lists no snoozed work, so it is woken
    // here (its Wake now) and opened from its card like any queued thread.
    const sleeping = await threadOf("marketing-site", "fix-flaky-login-test")
    if (sleeping?.snoozedUntil) await api("marketing-site").mutate("setThreadSnooze", { slug: "fix-flaky-login-test", sessionId: sleeping.sessionId, until: null })
    const title = `${card("marketing-site", "fix-flaky-login-test")} h3 a`
    await page.waitForSelector(title, { timeout: 10_000 }).catch(async () => {
      const now = await threadOf("marketing-site", "fix-flaky-login-test")
      const cards = await page.$$eval("[data-xq-card]", (els) => els.map((el) => el.getAttribute("data-xq-card")?.split("/")[1]))
      throw new Error(`its card never came back: thread ${JSON.stringify({ state: now?.state, needsYou: now?.needsYou, snoozedUntil: now?.snoozedUntil, queuedAt: now?.queuedAt, settling: now?.queueSettling })}, cards ${cards.join(" ")}, at ${await page.evaluate(() => location.pathname)}`)
    })
    await clickOnScreen(title)
    await page.waitForFunction(() => location.pathname === "/all/marketing-site/thread/fix-flaky-login-test", { timeout: 8000 })
    await page.waitForSelector('[role=dialog] textarea[data-surface="chatComposer"]', { timeout: 10_000 })
    await sleep(800)
    const before = writes.length
    await focusBox('[role=dialog] textarea[data-surface="chatComposer"]')
    await page.keyboard.type("Is the flake the same on CI?")
    await page.keyboard.press("Enter")
    await waitFor("the follow-up to go out", async () => writes.slice(before).some((w) => w.endsWith("/rpc/followUp")) || null, 8000)
    const sent = writes.slice(before).filter((w) => w.endsWith("/rpc/followUp"))
    // The drawer is the PAGE's, so it addresses the tenant by the page's own prefix — its slug.
    check("a follow-up typed in a tenant's drawer goes to the tenant, not the focus's namesake", sent.length === 1 && sent[0] === "/_ntwine/marketing-site/rpc/followUp", sent.join(", ") || "none")
    await closeDrawer()
    await page.waitForFunction((paths) => paths.includes(location.pathname), { timeout: 8000 }, ALL_PATHS)
  })

  // ⌥↓ / ⌥↑ in the prompt box step it down and up the picker's order (lib/crossProject.ts stepPick): the
  // draft goes with it, the caret stays put, and the box never blanks to its stand-in — it takes an open
  // project's box at once (AllQueues.tsx FocusedComposer), so a key typed straight after the switch lands
  // in the new box.
  const altKey = async (key) => {
    await page.keyboard.down("Alt")
    await page.keyboard.press(key)
    await page.keyboard.up("Alt")
  }
  const nextProject = () => altKey("ArrowDown")
  const previousProject = () => altKey("ArrowUp")
  const composerReady = () =>
    page.waitForFunction(() => !document.querySelector("[data-xq-composer-pending]") && document.querySelector("[data-dispatch-form]"), { timeout: 10_000 })
  // The picker's own menu, read once: its order is the order the keys walk, minus what it marks "Not open"
  // — the keys pass over a project with no box to show (lib/crossProject.ts stepPick). On this stack that
  // includes Home: nothing primes it (adhoc-stack), where a real server opens it at boot.
  const pickerOrder = async () => {
    await page.click("[data-xq-project-picker]")
    await page.waitForSelector("[role=menuitem]", { timeout: 5000 })
    // By slug, which is also each project's name on this stack — what the picker shows.
    const slugs = await page.$$eval("[role=menuitem]", (items) => items.filter((item) => !item.textContent?.includes("Not open")).map((item) => item.getAttribute("data-value") ?? ""))
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector("[role=menu]"), { timeout: 5000 })
    return slugs
  }
  const box = (surface) => page.evaluate((surface) => {
    const el = document.querySelector(`[data-surface="${surface}"]`)
    return el ? { value: el.value, start: el.selectionStart, end: el.selectionEnd, focused: document.activeElement === el } : null
  }, surface)

  await step("⌥↓ / ⌥↑ in the prompt box move it between projects, with the draft and the caret", async () => {
    await pickerSays("acme-api")
    await composerReady()
    const order = await pickerOrder()
    const at = order.indexOf("acme-api")
    const after = (n) => order[(at + n) % order.length]
    const draft = "Draft that follows the key"
    await focusBox('[data-surface="newComposer"]')
    await page.keyboard.type(draft)
    await page.evaluate(() => document.querySelector('[data-surface="newComposer"]').setSelectionRange(5, 5))
    // Counts every time the stand-in mounts from here on — a switch that blanks the box shows up as one.
    await page.evaluate(() => {
      window.__xqPending = 0
      new MutationObserver((records) => {
        for (const record of records) for (const node of record.addedNodes) if (node instanceof Element && node.matches("[data-xq-composer-pending], :has([data-xq-composer-pending])")) window.__xqPending++
      }).observe(document.body, { childList: true, subtree: true })
    })

    await nextProject()
    const moved = await pickerSays(after(1))
    const first = await box("newComposer")
    check(
      "⌥↓ moves the box to the next project in the picker's order, keeping the draft, the caret and the keyboard",
      moved && first?.value === draft && first.start === 5 && first.end === 5 && first.focused,
      `picker "${await picker()}" (expected "${after(1)}" of ${order.join(" → ")}), ${JSON.stringify(first)}`,
    )

    // A key typed straight after the press lands in the new box, at the caret.
    await nextProject()
    await page.keyboard.type("X")
    await pickerSays(after(2))
    const typed = await box("newComposer")
    check(
      "a key typed straight after ⌥↓ lands in the new project's box, at the caret",
      typed?.value === "DraftX that follows the key" && typed.start === 6 && typed.focused,
      `picker "${await picker()}", ${JSON.stringify(typed)}`,
    )

    await previousProject()
    const back = await pickerSays(after(1))
    const above = await box("newComposer")
    check(
      "⌥↑ moves it back up to the previous project, the draft and the caret with it",
      back && above?.value === "DraftX that follows the key" && above.start === 6 && above.focused,
      `picker "${await picker()}" (expected "${after(1)}"), ${JSON.stringify(above)}`,
    )

    // All the way round, as fast as the keys come, and back where it started.
    for (let n = 1; n < order.length; n++) await nextProject()
    const home = await pickerSays("acme-api")
    const round = await box("newComposer")
    const pending = await page.evaluate(() => window.__xqPending)
    // The draft is one draft, filed under the project the box ended on and nowhere else.
    const filed = await page.evaluate(() => Object.entries(JSON.parse(sessionStorage.getItem("ntwine-drafts:v1") ?? "{}").entries ?? {}).filter(([, entry]) => entry.value.includes("that follows the key")).map(([key]) => decodeURIComponent(key)))
    check(
      "⌥↓ wraps round to the first project, never blanking the box, with the draft filed only there",
      home && round?.value === "DraftX that follows the key" && round.focused && pending === 0 && filed.length === 1 && filed[0].includes(`${stack.launcher.dir}:new`),
      `picker "${await picker()}", stand-in mounted ${pending}x, draft filed under ${filed.join(", ") || "nothing"}`,
    )

    // Anywhere on the page that is not a text field the keys step the project TOO, and leave the keyboard
    // where it was, so `j` / `k` and the card keys go on working after a step (c160eb6a, 2026-10-01; on
    // All projects that re-aims the box, AllQueues.tsx's window listener). This checked the opposite —
    // the keys left alone outside the box — until then.
    await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined))
    await nextProject()
    const stepped = await pickerSays(after(1))
    await sleep(400)
    const keyboard = await page.evaluate(() => document.activeElement?.getAttribute("data-surface") ?? document.activeElement?.tagName ?? null)
    check("⌥↓ outside the box re-aims it too, leaving the keyboard where it was", stepped && keyboard === "BODY", `picker "${await picker()}" (expected "${after(1)}"), keyboard on ${keyboard}`)
    await previousProject()
    await pickerSays("acme-api")

    // A choice from the menu hands the keyboard to the re-aimed box as well, the caret after the draft.
    await page.click("[data-xq-project-picker]")
    await page.waitForSelector("[role=menuitem]", { timeout: 5000 })
    await page.click(`[role=menuitem][data-value="${after(1)}"]`)
    await pickerSays(after(1))
    await sleep(400)
    const picked = await box("newComposer")
    check("a choice from the picker's menu hands the keyboard to the re-aimed box", picked?.focused === true && picked.start === picked.value.length, JSON.stringify(picked))

    // Clear the draft, and put the box back on the launcher for the steps after this one.
    await focusBox('[data-surface="newComposer"]')
    await page.keyboard.down("Control")
    await page.keyboard.press("a")
    await page.keyboard.up("Control")
    await page.keyboard.press("Backspace")
    await previousProject()
    await pickerSays("acme-api")
  })

  // Leaving All projects for ONE project is a change of view, by address (lib/pageView.ts): the project's
  // board, `/project/<slug>` (`/?project=<slug>` from 2026-09-29 to 2026-10-06). It was a filter on the
  // queue column, held per tab at `/`, from 2026-09-28 until focus mode; before that, each of these doors
  // navigated to `/project/<slug>` too. The doors are a card's
  // project chip (All projects draws one on every card), the dock's square, and a project row's
  // ⋯. What each check reads is the address and whose cards the queue shows:
  // focused, exactly the one project's.
  const focusedTo = async (slug) => {
    await page.waitForFunction((slug) => location.pathname === `/project/${slug}`, { timeout: 15_000 }, slug).catch(() => {})
    await page.waitForFunction((id) => { const shown = new Set([...document.querySelectorAll("[data-xq-card]")].map((el) => el.getAttribute("data-xq-card")?.split("/")[0])); return shown.size === 1 && shown.has(id) }, { timeout: 30_000 }, ids[slug]).catch(() => {})
    return { projects: await cardProjects(), path: await page.evaluate(() => location.pathname + location.search) }
  }
  const only = (seen, slug) => JSON.stringify(seen.projects) === JSON.stringify([ids[slug]]) && seen.path === `/project/${slug}`
  const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
  // Back to All projects, and every project's cards in it.
  const backToAll = async (count) => {
    await page.waitForFunction((paths) => paths.includes(location.pathname) && location.search === "", { timeout: 15_000 }, ALL_PATHS).catch(() => {})
    await page.waitForFunction((count) => new Set([...document.querySelectorAll("[data-xq-card]")].map((el) => el.getAttribute("data-xq-card")?.split("/")[0])).size === count, { timeout: 30_000 }, count).catch(() => {})
    await sleep(400)
    return cardProjects()
  }
  const switchTo = (value) => clickSettled(value === "all-projects" ? "[data-xq-dock-all]" : `[data-xq-dock-square="${value}"]`)

  await step("a card's project chip and the dock each focus the page on it; Back and All projects come back", async () => {
    await allFrom("billing-worker")
    await page.waitForSelector("[data-xq-card]")
    const everything = await cardProjects()
    await page.click(`[data-xq-card^="${ids["acme-api"]}/"] button[data-xq-chip]`)
    const byChip = await focusedTo("acme-api")
    await page.screenshot({ path: join(shots, "xp-verify-focused.png") })
    await page.goBack()
    const widened = await backToAll(everything.length)
    await switchTo("marketing-site")
    const byMenu = await focusedTo("marketing-site")
    await switchTo("all-projects")
    const cleared = await backToAll(everything.length)
    check(
      "a card's project chip and the dock each focus the page on it; Back and All projects come back",
      only(byChip, "acme-api") && same(widened, everything) && only(byMenu, "marketing-site") && same(cleared, everything),
      `chip → ${byChip.projects.length} project(s) at ${byChip.path}, Back → ${widened.length}/${everything.length} projects, dock → ${byMenu.projects.length} project(s) at ${byMenu.path}, All → ${cleared.length} projects`,
    )
  })

  await step("the page raised no errors", async () => {
    // Two 404s that are answers, not faults, and happen on every page that draws them: the board's
    // supervisor probe on a stack with no supervisor, and a project square's icon request, which is
    // what triggers the lazy icon scan and 404s for a project that has none (ProjectSquare).
    const real = errors.filter((e) => !/\/_ntwine\/control\/status|\/_ntwine\/project-icon\?/.test(e))
    check("the page raised no errors", real.length === 0, real.slice(0, 5).join(" | "))
  })
} finally {
  await browser.close()
  reapResumedWorkers()
}

/**
 * The reply resumes a real worker: a follow-up to a rested thread is exactly what wakes one. It is a
 * DETACHED daemon (its broker forks into its own process group), so it outlives this script and the
 * stack alike. Kill every worker whose MCP config names this stack's sandbox HOME, and the broker that
 * forked it — by exact pid, never by name.
 */
function reapResumedWorkers() {
  const table = execFileSync("ps", ["-Ao", "pid=,ppid=,command="], { encoding: "utf8" })
  const rows = table.split("\n").map((row) => row.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
  const byPid = new Map(rows.map(([, pid, ppid, command]) => [pid, { ppid, command }]))
  const doomed = new Set()
  for (const [pid, { ppid, command }] of byPid) {
    if (!command.includes(stack.home) || !/\bclaude\b/.test(command)) continue
    doomed.add(pid)
    if (byPid.get(ppid)?.command.includes("claude-agent-broker")) doomed.add(ppid)
  }
  for (const pid of doomed) {
    try { process.kill(Number(pid), "SIGTERM") } catch {}
  }
  if (doomed.size) console.log(`reaped ${doomed.size} process(es) the reply resumed: ${[...doomed].join(", ")}`)
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
