#!/usr/bin/env node
// Drive the All queues page (`/queues`) in a real headless browser against a seeded multi-project stack,
// and check that every action taken on a card lands on the card's OWN project.
//
// That is the page's one hard problem. It names no project, so the page-level client (`rpc`) means the
// LAUNCHING project there, and a slug is unique only within a project — an action wired to the wrong
// client either fails against the launcher or, worse, succeeds on the launcher's namesake. So every write
// here is taken on a TENANT's card (where the page client would be wrong), and the same-slug pair the
// seed plants (`fix-flaky-login-test`, in the launcher AND a tenant) is checked from both sides.
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

  await page.goto(`${origin}/queues`, { waitUntil: "networkidle2" })
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark" })
  await page.waitForSelector("[data-xq-card]")
  await sleep(800)

  await step("lanes follow the rail order, one per project with a queue", async () => {
    const order = (await api("acme-api").query("projectsList")).map((p) => p.slug).filter((slug) => slug !== "docs-portal")
    const lanes = await page.$$eval("[data-xq-lane]", (els) => els.map((el) => el.getAttribute("data-xq-lane")))
    check("lanes follow the rail order, one per project with a queue", JSON.stringify(lanes) === JSON.stringify(order.map((slug) => ids[slug])), `${lanes.length} lanes`)
    const cards = await page.$$eval("[data-xq-card]", (els) => els.length)
    check("every queued thread has a card", cards === 8, `${cards} cards`)
    const both = await Promise.all([page.$(card("acme-api", "fix-flaky-login-test")), page.$(card("marketing-site", "fix-flaky-login-test"))])
    check("the same slug in two projects is two cards", both.every(Boolean))
  })

  await page.screenshot({ path: join(shots, "aq-verify-top.png") })

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
    await page.click(`${scope} a[aria-label="Open in acme-api"]`)
    await page.waitForFunction(() => location.pathname === "/project/acme-api/thread/upgrade-postgres-driver", { timeout: 5000 })
    await sleep(1500)
    const shows = await page.evaluate(() => document.body.innerText.includes("Upgrade the Postgres driver to v9"))
    await page.screenshot({ path: join(shots, "aq-verify-drilldown.png") })
    await page.goBack()
    await page.waitForFunction(() => location.pathname === "/queues", { timeout: 5000 })
    await page.waitForSelector("[data-xq-card]")
    check("↗ opens the thread on its own board, and Back returns here", shows)
  })

  await step("fullscreen's way out leads back to All queues", async () => {
    const scope = card("acme-api", "upgrade-postgres-driver")
    await page.click(`${scope} a[aria-label="Open fullscreen"]`)
    await page.waitForFunction(() => location.pathname.endsWith("/upgrade-postgres-driver/full"), { timeout: 5000 })
    await page.waitForSelector("[data-standalone-return]", { timeout: 8000 })
    const href = await page.$eval("[data-standalone-return]", (el) => el.getAttribute("href"))
    await page.click("[data-standalone-return]")
    await page.waitForFunction(() => location.pathname === "/queues", { timeout: 5000 })
    check("fullscreen's way out leads back to All queues", href === "/queues", `exit href ${href}`)
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
