#!/usr/bin/env node
// Drive the cross-project page ("Everything", `/all/<slug>`) in a real headless browser against a seeded
// multi-project stack, and check that every action taken on a card lands on the card's OWN project — and
// that the page works as a MODE: threads open in place, and new ones start in any project from it.
//
// Its one hard problem: the page shows every project but is FOCUSED on one (the page project), so the
// page-level client (`rpc`) means the focus there, and a slug is unique only within a project — an action
// wired to the wrong client either fails against the focus or, worse, succeeds on the focus's namesake.
// So the page is focused on the launcher, every write is taken on a TENANT's card (where the page client
// would be wrong), and the same-slug pair the seed plants (`fix-flaky-login-test`, in the launcher AND a
// tenant) is checked from both sides — from the cards, and from a tenant's drawer opened in place.
//
// Usage: node scripts/verify-all-queues.mjs --stack=/abs/stack.log [--shots=/abs/dir]
//   against a stack booted by adhoc-stack.mjs (with --also-project for marketing-site, billing-worker and
//   docs-portal) and seeded by scripts/seed-all-queues.mjs. It MUTATES that state, and a reseed does not
//   undo all of it (snoozes and completions outlive the seed's rows): run it on a freshly booted stack.
//   Exits non-zero when any check fails.
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import puppeteer from "puppeteer"
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

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--force-color-profile=srgb"] })
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 })
  const errors = []
  page.on("pageerror", (error) => errors.push(`pageerror: ${error}`))
  // "Failed to load resource" is the console's echo of a failed response, which the listener below
  // already records WITH its URL — kept once, where it says what failed.
  page.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(`console: ${message.text()}`) })
  page.on("response", (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
  // Every WRITE the page makes, by path — `/_frizz/<project id>/rpc/<procedure>` names who it went to.
  const writes = []
  page.on("request", (request) => { if (request.method() === "POST" && request.url().includes("/rpc/")) writes.push(new URL(request.url()).pathname) })
  const wrote = (project, procedure) => writes.includes(`/_frizz/${ids[project]}/rpc/${procedure}`)
  const buttonIn = async (scope, text) => {
    const handle = await page.evaluateHandle((scope, text) => [...document.querySelectorAll(`${scope} button`)].find((b) => b.textContent?.trim().includes(text)) ?? null, scope, text)
    const element = handle.asElement()
    if (!element) throw new Error(`no button "${text}" in ${scope}`)
    return element
  }

  // The launcher's own landing URL (src/index.ts slugPath): `/` focused on the project it was run in.
  await page.goto(`${origin}/?focus=acme-api`, { waitUntil: "networkidle2" })
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark" })
  await page.waitForSelector("[data-xq-card]")
  await sleep(800)
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
  // What the page SHOWS: the status row's right end names the narrowed project, or "Everything".
  const pageTitle = () => page.$eval("[data-status-row-page]", (el) => el.textContent?.trim() ?? "").catch(() => "")
  const lanes = () => page.$$eval("[data-xq-lane]", (els) => els.map((el) => el.getAttribute("data-xq-lane")))
  const statusTop = () => page.$eval("[data-status-row]", (el) => Math.round(el.getBoundingClientRect().top))
  // A project's board, from Everything: its row's "…" (shown on hover; the menu opens on pointerdown,
  // so these are real clicks) → Open board.
  const openBoardFromMenu = async (slug) => {
    const row = `[data-xq-project-row="${ids[slug]}"]`
    await page.hover(`${row} a`)
    await page.click(`${row} button[aria-label^="More actions"]`)
    await page.waitForSelector(`[role="menu"] a[href="/project/${slug}"]`, { timeout: 5000 })
    await page.click(`[role="menu"] a[href="/project/${slug}"]`)
  }

  await step("/ lands on the page focused on the named project, with its prompt box", async () => {
    await page.waitForSelector('[data-surface="newComposer"]', { timeout: 10_000 })
    const path = await page.evaluate(() => location.pathname)
    check("/ lands on the page focused on the named project, with its prompt box", path === "/all/acme-api" && (await pickerSays("acme-api")), `${path}, picker "${await picker()}"`)
  })

  await step("lanes follow the rail order, one per project with a queue", async () => {
    // The seed queues work in these three; docs-portal (only archived threads) and any other project on
    // the stack (nothing seeded) have nothing queued, so no lane. Named rather than excluded, so a fifth
    // quiet project — whatever it is called — does not read as a missing lane.
    const queued = new Set(["acme-api", "marketing-site", "billing-worker"])
    const order = (await api("acme-api").query("projectsList")).map((p) => p.slug).filter((slug) => queued.has(slug))
    const lanes = await page.$$eval("[data-xq-lane]", (els) => els.map((el) => el.getAttribute("data-xq-lane")))
    check("lanes follow the rail order, one per project with a queue", JSON.stringify(lanes) === JSON.stringify(order.map((slug) => ids[slug])), `${lanes.length} lanes`)
    const cards = await page.$$eval("[data-xq-card]", (els) => els.length)
    // Eight agent threads, plus a finished terminal command in billing-worker and in the launcher.
    check("every queued thread has a card", cards === 10, `${cards} cards`)
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
    const row = await buttonIn(`[data-xq-rail-project="${ids["marketing-site"]}"]`, "Fix the flaky login test")
    await row.click()
    await sleep(900)
    const at = await page.$eval(card("marketing-site", "fix-flaky-login-test"), (el) => ({
      top: Math.round(el.getBoundingClientRect().top),
      // A card in the page's last screenful cannot reach the top; the page scrolling to its end is the
      // most it can do, and the card is then in view.
      atEnd: Math.ceil(window.scrollY + window.innerHeight) >= document.documentElement.scrollHeight - 1 && el.getBoundingClientRect().bottom <= window.innerHeight,
      flash: el.querySelector("[data-xq-card-root]")?.hasAttribute("data-queue-flash"),
    }))
    check("a queue row in the rail brings its card up and rings it", ((at.top >= 0 && at.top < 160) || at.atEnd) && at.flash === true, `card top ${at.top}px${at.atEnd ? " (page end)" : ""}, ring ${at.flash}`)
  })

  await step("Snooze on a tenant's card snoozes ITS thread, not the launcher's namesake", async () => {
    const scope = card("marketing-site", "fix-flaky-login-test")
    const snooze = await page.$(`${scope} [data-thread-lifecycle-footer] button:not([aria-label="Snooze options"])`) ?? await page.$(`${scope} footer button`)
    if (!snooze) throw new Error("no snooze button")
    await snooze.click()
    const tenant = await waitFor("the tenant thread to snooze", async () => { const t = await threadOf("marketing-site", "fix-flaky-login-test"); return t?.snoozedUntil ? t : null })
    const namesake = await threadOf("acme-api", "fix-flaky-login-test")
    check("Snooze on a tenant's card snoozes ITS thread, not the launcher's namesake", Boolean(tenant.snoozedUntil) && !namesake?.snoozedUntil && wrote("marketing-site", "setThreadSnooze"), `tenant until ${tenant.snoozedUntil}, namesake ${namesake?.snoozedUntil ?? "untouched"}`)
    await sleep(600)
    check("the snoozed card leaves the page", (await page.$(scope)) === null)
  })

  await step("Mark as done on a tenant's card finishes ITS thread", async () => {
    const scope = card("billing-worker", "dunning-retry-schedule")
    await (await buttonIn(scope, "Mark as done")).click()
    const done = await waitFor("the tenant thread to archive", async () => { const t = await threadOf("billing-worker", "dunning-retry-schedule"); return t && (t.archived || t.state === "archived") ? t : null })
    check("Mark as done on a tenant's card finishes ITS thread", Boolean(done) && wrote("billing-worker", "completeThread") && !wrote("acme-api", "completeThread"))
  })

  await step("Mark as done on the launcher's same-slug card leaves the tenant's alone", async () => {
    const scope = card("acme-api", "fix-flaky-login-test")
    await (await buttonIn(scope, "Mark as done")).click()
    await waitFor("the launcher thread to archive", async () => { const t = await threadOf("acme-api", "fix-flaky-login-test"); return t && (t.archived || t.state === "archived") ? t : null })
    const tenant = await threadOf("marketing-site", "fix-flaky-login-test")
    check("Mark as done on the launcher's same-slug card leaves the tenant's alone", tenant && !tenant.archived && tenant.state !== "archived", `tenant state ${tenant?.state}`)
  })

  // The seed ran a real command in billing-worker and in the launcher; each finished run queues.
  const commandOf = async (project) => (await api(project).query("board")).threads.find((t) => t.kind === "command")

  await step("a tenant's finished command shows its own run, in its lane and its rail", async () => {
    const command = await commandOf("billing-worker")
    const scope = card("billing-worker", command.id)
    await page.$eval(scope, (el) => el.scrollIntoView({ block: "center" }))
    // The screen is the pty's replay over `/term/<slug>` — which, addressed through the page, would ask the
    // launcher's terminal server for a slug it never minted.
    const screen = await waitFor("the command's screen", () => page.$eval(scope, (el) => el.querySelector(".xterm-rows")?.textContent?.includes("billing-worker ran") ?? false), 8_000).catch(() => false)
    const text = await page.$eval(scope, (el) => el.textContent ?? "")
    const rail = await page.$eval(`[data-xq-rail-project="${ids["billing-worker"]}"]`, (el) => el.textContent ?? "")
    check("a tenant's finished command shows its own run, in its lane and its rail", screen && text.includes("exit 3") && rail.includes("exit 3") && rail.includes("billing-worker ran"), `screen ${screen ? "replayed" : "blank"}, card ${text.includes("exit 3") ? "says exit 3" : "no state"}`)
    await page.screenshot({ path: join(shots, "aq-verify-command.png") })
  })

  await step("Mark as done on a tenant's command finishes ITS command", async () => {
    const command = await commandOf("billing-worker")
    await (await buttonIn(card("billing-worker", command.id), "Mark as done")).click()
    const done = await waitFor("the tenant command to archive", async () => { const t = await threadOf("billing-worker", command.id); return t?.state === "archived" ? t : null }).catch(() => null)
    const launcher = await commandOf("acme-api")
    check("Mark as done on a tenant's command finishes ITS command", Boolean(done) && wrote("billing-worker", "setThreadState") && !wrote("acme-api", "setThreadState") && launcher?.state !== "archived", `tenant ${done ? "archived" : "still open"}, launcher's ${launcher?.state}`)
  })

  await step("answering a tenant's registered question answers it there", async () => {
    const scope = card("marketing-site", "hero-copy-variants")
    // An option is a row whose button carries no text of its own (it is labelled by the row).
    const option = (await page.evaluateHandle((scope) => [...document.querySelectorAll(`${scope} [data-question-option]`)].find((row) => row.textContent?.includes("Every agent, one board"))?.querySelector("button") ?? null, scope)).asElement()
    if (!option) throw new Error("no option \"Every agent, one board\"")
    await option.click()
    await page.click(`${scope} [data-send-answers]`)
    await waitFor("the tenant question to settle", async () => { const t = await threadOf("marketing-site", "hero-copy-variants"); return t && (t.questions ?? []).length === 0 ? t : null })
    const other = await threadOf("acme-api", "rate-limit-headers")
    // A thread's `questions` lists only its OPEN rows, so the launcher's must still carry one.
    check("answering a tenant's registered question answers it there", wrote("marketing-site", "answerQuestions") && (other?.questions ?? []).length > 0, `launcher's own question ${(other?.questions ?? []).length > 0 ? "still open" : "gone"}`)
  })

  await step("a reply on a tenant's card goes to ITS thread", async () => {
    const scope = card("marketing-site", "pricing-page-tiers")
    await page.click(`${scope} textarea[data-surface="queueComposer"]`)
    await page.keyboard.type("Please also check the 1024px breakpoint.")
    await page.keyboard.press("Enter")
    await sleep(3000)
    const alert = await page.$eval(scope, (el) => el.querySelector("[role=alert]")?.textContent ?? null).catch(() => null)
    const present = (await page.$(scope)) !== null
    const draft = present ? await page.$eval(`${scope} textarea`, (el) => el.value) : ""
    check("a reply on a tenant's card goes to ITS thread", wrote("marketing-site", "followUp") && !wrote("acme-api", "followUp"), present ? `card back with ${alert ? `error "${alert.slice(0, 80)}"` : "no error"}, draft ${draft ? "restored" : "empty"}` : "card left the queue")
  })

  await step("↗ opens the thread on its own board, and Back returns here", async () => {
    const scope = card("acme-api", "upgrade-postgres-driver")
    await page.click(`${scope} a[aria-label="Open on acme-api's board"]`)
    await page.waitForFunction(() => location.pathname === "/project/acme-api/thread/upgrade-postgres-driver", { timeout: 5000 })
    await sleep(1500)
    const shows = await page.evaluate(() => document.body.innerText.includes("Upgrade the Postgres driver to v9"))
    await page.screenshot({ path: join(shots, "aq-verify-drilldown.png") })
    await page.goBack()
    await page.waitForFunction(() => location.pathname === "/all/acme-api", { timeout: 5000 })
    await page.waitForSelector("[data-xq-card]")
    check("↗ opens the thread on its own board, and Back returns here", shows)
  })

  await step("fullscreen's way out leads back to the page", async () => {
    const scope = card("acme-api", "upgrade-postgres-driver")
    await page.click(`${scope} a[aria-label="Open fullscreen"]`)
    await page.waitForFunction(() => location.pathname.endsWith("/upgrade-postgres-driver/full"), { timeout: 5000 })
    await page.waitForSelector("[data-standalone-return]", { timeout: 8000 })
    const href = await page.$eval("[data-standalone-return]", (el) => el.getAttribute("href"))
    await page.click("[data-standalone-return]")
    await page.waitForFunction(() => location.pathname === "/all/acme-api", { timeout: 5000 })
    check("fullscreen's way out leads back to the page", href === "/all/acme-api", `exit href ${href}`)
  })

  await step("a board left for the page and returned to shows what was done there", async () => {
    // The board's Everything door focuses the page on the board's own project, and whatever is finished
    // there must not paint again on the way back.
    await page.goto(`${origin}/project/acme-api`, { waitUntil: "networkidle2" })
    await page.waitForSelector('[data-queue-card="fix-pagination-cursor"]', { timeout: 10_000 })
    await page.click('[data-status-row] a[aria-label="Everything"]')
    await page.waitForFunction(() => location.pathname === "/all/acme-api", { timeout: 5000 })
    const scope = card("acme-api", "fix-pagination-cursor")
    await page.waitForSelector(scope)
    await (await buttonIn(scope, "Mark as done")).click()
    await waitFor("the thread to archive", async () => { const t = await threadOf("acme-api", "fix-pagination-cursor"); return t && (t.archived || t.state === "archived") ? t : null })
    await sleep(1500) // the board's delta is out, and dropped, while this page is still up
    await openBoardFromMenu("acme-api")
    await page.waitForFunction(() => location.pathname === "/project/acme-api", { timeout: 5000 })
    // Judged at the board's FIRST paint of its queue — the moment another, still-queued card appears. A
    // stale board paints the finished card at once; any later delta on the project would resync it a
    // moment after, and waiting for that is how a check of this passes on the bug (it did, here: the
    // seeded stack's busy threads resynced it within a second).
    await page.waitForSelector('[data-queue-card="upgrade-postgres-driver"]', { timeout: 10_000 })
    const stale = (await page.$('[data-queue-card="fix-pagination-cursor"]')) !== null
    check("a board left for the page and returned to shows what was done there", !stale, stale ? "the finished card painted on return" : "")
  })

  // ---- The page as a MODE: nothing here leaves it -------------------------------------------------------
  // The last step ended on the launcher's board; its Everything door is the way back, focused on it.
  await page.click('[data-status-row] a[aria-label="Everything"]').catch(() => {})
  await page.waitForFunction(() => location.pathname === "/all/acme-api", { timeout: 8000 }).catch(() => {})

  await step("a tenant's thread opens in place, in its drawer", async () => {
    await page.waitForSelector("[data-xq-card]")
    const scope = card("acme-api", "upgrade-postgres-driver")
    // A marketing-site thread, by its card's title if one is still queued, else by its rail row: the seed's
    // in-flight rows rest on their own, so which of the two is on the page depends on how long this took.
    const title = await page.$(`[data-xq-lane="${ids["marketing-site"]}"] article h3 a`)
    if (title) await title.click()
    else await (await buttonIn(`[data-xq-rail-project="${ids["marketing-site"]}"]`, "Generate OG images at build time")).click()
    await page.waitForFunction(() => location.pathname.startsWith("/all/marketing-site/thread/"), { timeout: 8000 })
    await page.waitForSelector("[role=dialog]", { timeout: 8000 })
    await sleep(1500)
    const slug = await page.evaluate(() => location.pathname.split("/").pop())
    const expected = (await threadOf("marketing-site", slug))?.title ?? "?"
    const drawer = await page.$eval("[role=dialog]", (el) => el.textContent ?? "")
    const lanes = await page.$$eval("[data-xq-lane]", (els) => els.length)
    const stillHere = (await page.$(scope)) !== null
    await page.screenshot({ path: join(shots, "xp-verify-drawer.png") })
    check("a tenant's thread opens in place, in its drawer", drawer.includes(expected) && lanes > 0 && stillHere && (await pickerSays("marketing-site")), `${slug}: ${lanes} lanes behind it, picker "${await picker()}"`)
  })

  await step("closing it hands the prompt box back to the project that was chosen", async () => {
    await closeDrawer()
    await page.waitForFunction(() => location.pathname === "/all/acme-api", { timeout: 8000 })
    const back = await pickerSays("acme-api")
    check("closing it hands the prompt box back to the project that was chosen", back, `picker "${await picker()}"`)
  })

  await step("a follow-up typed in a tenant's drawer goes to the tenant, not the focus's namesake", async () => {
    // marketing-site's `fix-flaky-login-test` shares its slug with the launcher's, which the page was
    // focused on a moment ago. It was snoozed above, and the page lists no snoozed work, so it is woken
    // here (the board's Wake now) and opened from its card like any queued thread.
    const sleeping = await threadOf("marketing-site", "fix-flaky-login-test")
    if (sleeping?.snoozedUntil) await api("marketing-site").mutate("setThreadSnooze", { slug: "fix-flaky-login-test", sessionId: sleeping.sessionId, until: null })
    const title = `${card("marketing-site", "fix-flaky-login-test")} h3 a`
    await page.waitForSelector(title, { timeout: 10_000 })
    await page.click(title)
    await page.waitForFunction(() => location.pathname === "/all/marketing-site/thread/fix-flaky-login-test", { timeout: 8000 })
    await page.waitForSelector('[role=dialog] textarea[data-surface="chatComposer"]', { timeout: 10_000 })
    await sleep(800)
    const before = writes.length
    await page.click('[role=dialog] textarea[data-surface="chatComposer"]')
    await page.keyboard.type("Is the flake the same on CI?")
    await page.keyboard.press("Enter")
    await waitFor("the follow-up to go out", async () => writes.slice(before).some((w) => w.endsWith("/rpc/followUp")) || null, 8000)
    const sent = writes.slice(before).filter((w) => w.endsWith("/rpc/followUp"))
    // The drawer is the PAGE's, so it addresses the tenant by the page's own prefix — its slug.
    check("a follow-up typed in a tenant's drawer goes to the tenant, not the focus's namesake", sent.length === 1 && sent[0] === "/_frizz/marketing-site/rpc/followUp", sent.join(", ") || "none")
    await closeDrawer()
    await page.waitForFunction(() => location.pathname === "/all/acme-api", { timeout: 8000 })
  })

  await step("a terminal command started from the page runs in the project chosen for it", async () => {
    await pickerSays("acme-api")
    await page.click("[data-xq-project-picker]")
    // Found and clicked in one go: a handle held across the page's next render can be detached.
    await page.waitForSelector("[role=menuitem]", { timeout: 5000 })
    for (let attempt = 0; attempt < 5; attempt++) {
      const item = (await page.evaluateHandle(() => [...document.querySelectorAll("[role=menuitem]")].find((el) => el.textContent?.includes("billing-worker")) ?? null)).asElement()
      if (item && (await item.click().then(() => true, () => false))) break
      await sleep(200)
    }
    await page.waitForFunction(() => location.pathname === "/all/billing-worker", { timeout: 8000 })
    // The PREVIOUS project's form stays up for the render after the address bar moves; wait for this
    // project's own form (the picker names it, and the stand-in is gone) before typing into it.
    await pickerSays("billing-worker")
    await page.waitForFunction(() => !document.querySelector("[data-xq-composer-pending]") && document.querySelector("[data-dispatch-form]"), { timeout: 10_000 })
    await page.click("[data-dispatch-tab=terminal]")
    await page.waitForSelector('[data-surface="commandComposer"]')
    await page.type('[data-surface="commandComposer"]', "echo started-from-everything")
    await page.keyboard.press("Enter")
    const started = await waitFor("the command thread", async () => (await api("billing-worker").query("board")).threads.find((t) => t.command?.command === "echo started-from-everything") ?? null)
    const elsewhere = (await api("acme-api").query("board")).threads.some((t) => t.command?.command === "echo started-from-everything")
    check("a terminal command started from the page runs in the project chosen for it", Boolean(started) && !elsewhere, started ? `billing-worker/${started.id}` : "")

    // Its toast opens its TERMINAL, in place — a routed terminal layer that stays open.
    // Clicked in the page, in the same task that finds it: the toast re-renders as it rises, and a
    // handle held across that is detached.
    await waitFor("the toast's link", () => page.evaluate(() => {
      const button = [...document.querySelectorAll("[data-toast] button")].find((b) => b.textContent?.trim() === "Open thread")
      button?.click()
      return Boolean(button)
    }), 8000)
    await page.waitForFunction((slug) => location.pathname === `/all/billing-worker/thread/${slug}`, { timeout: 8000 }, started.id)
    await sleep(1500)
    const terminal = await page.evaluate(() => Boolean(document.querySelector(".xterm")) && location.pathname.includes("/thread/"))
    await page.screenshot({ path: join(shots, "xp-verify-terminal.png") })
    check("its toast opens its terminal in place, and it stays open", terminal, await page.evaluate(() => location.pathname))
    await closeDrawer()
    // The picker CHOSE billing-worker, so that is where the page settles.
    await page.waitForFunction(() => location.pathname === "/all/billing-worker", { timeout: 8000 })
  })

  await step("Back to a project the operator was focused on stays there", async () => {
    // Through the rail's squares, which PUSH an entry per project (the prompt box's picker replaces
    // one). Going Back to an entry is choosing it again; the page used to bounce off it to the pick.
    const settings = await api("acme-api").query("settingsGet")
    await api("acme-api").mutate("settingsSet", { ...settings, projectRail: true })
    try {
      await page.goto(`${origin}/all/acme-api`, { waitUntil: "networkidle2" })
      const square = 'nav[aria-label="Projects"] a[href="/all/marketing-site"]'
      await page.waitForSelector(square, { timeout: 10_000 })
      await page.click(square)
      await page.waitForFunction(() => location.pathname === "/all/marketing-site", { timeout: 8000 })
      await sleep(1000)
      await page.goBack()
      await sleep(2000)
      const says = await pickerSays("acme-api")
      const path = await page.evaluate(() => location.pathname)
      check("Back to a project the operator was focused on stays there", path === "/all/acme-api" && says, `${path}, picker "${await picker()}"`)
      // The square NARROWED to marketing-site as well; Back to another project's entry leaves that too,
      // or the lanes would show marketing-site under a prompt box aimed at acme-api.
      const shows = await pageTitle()
      check("…and leaves the narrowing the square made", shows === "Everything", `the page shows "${shows}"`)
    } finally {
      await api("acme-api").mutate("settingsSet", settings)
    }
  })

  await step("choosing a project narrows the page to it, in place", async () => {
    // From a document load (nothing narrowed) focused elsewhere, so the choice moves the pick too.
    await page.goto(`${origin}/all/billing-worker`, { waitUntil: "networkidle2" })
    await page.waitForSelector("[data-xq-project-row]")
    await sleep(800)
    const everything = await lanes()
    const top = await statusTop()
    await page.click(`[data-xq-project-row="${ids["acme-api"]}"] a`)
    await page.waitForFunction(() => location.pathname === "/all/acme-api", { timeout: 8000 })
    const says = await pickerSays("acme-api")
    const narrowed = await lanes()
    const others = await page.$$eval("[data-xq-rail-project]", (groups, id) => groups
      .filter((group) => group.getAttribute("data-xq-rail-project") !== id)
      .reduce((sum, group) => sum + group.querySelectorAll('button:not([aria-label^="More actions"])').length, 0), ids["acme-api"])
    await page.screenshot({ path: join(shots, "xp-verify-narrowed.png") })
    check(
      "choosing a project narrows the page to it, in place",
      says && JSON.stringify(narrowed) === JSON.stringify([ids["acme-api"]]) && (await pageTitle()) === "acme-api" && others === 0 && (await statusTop()) === top,
      `lanes ${narrowed.length}/${everything.length}, title "${await pageTitle()}", ${others} rows of other projects, status row ${top} → ${await statusTop()}px`,
    )

    // Its name again is the way back, and so is the ∞ door; a lane's header narrows like its row.
    await page.click(`[data-xq-project-row="${ids["acme-api"]}"] a`)
    await page.waitForFunction(() => document.querySelector("[data-status-row-page]")?.textContent === "Everything", { timeout: 5000 }).catch(() => {})
    const widened = await lanes()
    await page.click(`[data-xq-lane="${ids["acme-api"]}"] header a`)
    await page.waitForFunction(() => document.querySelector("[data-status-row-page]")?.textContent === "acme-api", { timeout: 5000 }).catch(() => {})
    const byHeader = await lanes()
    await page.click('[data-status-row] a[aria-label="Everything"]')
    await page.waitForFunction(() => document.querySelector("[data-status-row-page]")?.textContent === "Everything", { timeout: 5000 }).catch(() => {})
    const byDoor = await lanes()
    check(
      "the name again, and the ∞ door, widen it back; a lane's header narrows too",
      JSON.stringify(widened) === JSON.stringify(everything) && JSON.stringify(byHeader) === JSON.stringify([ids["acme-api"]]) && JSON.stringify(byDoor) === JSON.stringify(everything) && (await page.evaluate(() => location.pathname)) === "/all/acme-api",
      `${widened.length} → ${byHeader.length} → ${byDoor.length} lanes of ${everything.length}`,
    )
  })

  await step("the page raised no errors", async () => {
    // Two 404s that are answers, not faults, and happen on every page that draws them: the board's
    // supervisor probe on a stack with no supervisor, and a project square's icon request, which is
    // what triggers the lazy icon scan and 404s for a project that has none (ProjectSquare).
    const real = errors.filter((e) => !/\/_frizz\/control\/status|\/_frizz\/project-icon\?/.test(e))
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
