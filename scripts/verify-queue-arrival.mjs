#!/usr/bin/env node
// Check, against a REAL running Frizz, that a thread entering the queue joins the BACK of it — the
// maintainer's 2026-09-24 report was that a newly ready thread went to the top "of the *stack*".
//
// Seeded by scripts/seed-queue-arrival.mjs: two threads queued since they rested (30m and 20m ago), and
// `snoozed-oldest`, which rested 60m ago but is snoozed until shortly after the seed. The check runs the
// real tailer → board → wire → web ordering (the web's own `orderQueue`, imported, so this cannot drift
// from what the rail and the cards draw), and then the rendered rail.
//
//   --phase=arrival  (default) wait for the snooze to end, then check the order, the stamps, the DB
//                    column and the rendered rail. Leaves the stack as it found it, bar the snooze. A
//                    snooze seeded with a prompt (--snooze-prompt) is a hold with a wake behind it, so
//                    its entry must also be WITHHELD for the clock's settle window and then go in on
//                    time — on the board's armed refresh, not its 15s reconcile.
//   --phase=restart  run against the SAME sandbox after a restart (adhoc-stack --home=<that home>):
//                    every stamp must survive, including through the boot window where the tailer has
//                    not primed a row yet and it reads as running. Pass --expect=<json> from the
//                    arrival phase's last line.
//
// Usage: node scripts/verify-queue-arrival.mjs --stack=/abs/stack.log [--phase=arrival|restart]
//          [--expect='{"…":"…"}'] [--shots=/abs/dir]
// Exits non-zero when any check fails.
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import puppeteer from "puppeteer"
import { createRpcClient } from "./lib/rpc-client.mjs"
import { resolveSandboxDb } from "./lib/sandbox-db.mjs"
import { orderQueue, queued } from "../packages/web/src/groups.ts"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => { const s = a.slice(2); const i = s.indexOf("="); return i < 0 ? [s, true] : [s.slice(0, i), s.slice(i + 1)] }),
)
if (!flags.stack) {
  console.error("usage: node scripts/verify-queue-arrival.mjs --stack=/abs/stack.log [--phase=arrival|restart] [--expect=json] [--shots=/abs/dir]")
  process.exit(1)
}
const phase = flags.phase ?? "arrival"
const line = readFileSync(flags.stack, "utf8").split("\n").find((l) => l.startsWith("{\"url\""))
if (!line) throw new Error(`no stack json line in ${flags.stack}`)
const stack = JSON.parse(line)
const api = createRpcClient(`${new URL(stack.url).origin}/`)
const { db } = resolveSandboxDb(stack.home)
const SLUGS = ["rested-first", "rested-second", "snoozed-oldest"]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(what, predicate, ms = 20_000) {
  const deadline = Date.now() + ms
  let last
  while (Date.now() < deadline) {
    last = await predicate()
    if (last) return last
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${what}`)
}
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
}
const storedStamps = () => Object.fromEntries(
  execFileSync("sqlite3", [db, `SELECT slug, IFNULL(queued_at, 'NULL') FROM session WHERE slug IN (${SLUGS.map((s) => `'${s}'`).join(",")})`], { encoding: "utf8" })
    .trim().split("\n").filter(Boolean).map((row) => row.split("|")),
)
const seeded = (board) => SLUGS.map((slug) => board.threads.find((t) => t.id === slug)).filter(Boolean)
// Primed = the tailer has folded the transcript, so the row carries its rest time.
const primed = (threads) => threads.length === SLUGS.length && threads.every((t) => t.lastAssistantAt)

await api.waitForHealth()

if (phase === "arrival") {
  const before = await waitFor("the seeded rows to prime", async () => { const t = seeded(await api.query("board")); return primed(t) && t })
  const held = before.find((t) => t.id === "snoozed-oldest")
  check("the snoozed thread starts OUT of the queue", held.needsYou !== true, `needsYou=${held.needsYou}`)
  check("the two plain rests are queued at their rest time",
    before.filter((t) => t.id !== "snoozed-oldest").every((t) => t.needsYou === true && t.queuedAt === t.lastAssistantAt),
    before.map((t) => `${t.id}: queuedAt=${t.queuedAt} rest=${t.lastAssistantAt}`).join("; "))

  const snoozedUntil = Date.parse(held.snoozedUntil)
  const settles = held.snoozePrompt !== undefined
  console.log(`…waiting ${Math.max(0, Math.round((snoozedUntil - Date.now()) / 1000))}s for the snooze to end${settles ? " (it carries a prompt: expect a 12s settle)" : ""}`)
  // Every reading from here on, so the settle window can be read off what the wire actually said.
  const readings = []
  const after = await waitFor("the snooze to end", async () => {
    const t = seeded(await api.query("board"))
    const x = t.find((y) => y.id === "snoozed-oldest")
    readings.push({ at: Date.now(), needsYou: x?.needsYou === true, snoozed: x?.snoozedUntil !== undefined })
    return x?.needsYou === true && t
  }, snoozedUntil - Date.now() + 45_000)
  const arrival = after.find((t) => t.id === "snoozed-oldest")
  if (settles) {
    const released = readings.find((r) => !r.snoozed)?.at
    const entered = readings.at(-1).at
    const unsnoozedOut = readings.filter((r) => !r.snoozed && !r.needsYou).length
    check("the prompted snooze's entry was WITHHELD after it ended, not flashed in",
      released !== undefined && unsnoozedOut > 0 && entered - snoozedUntil >= 11_000,
      `snooze ended ${held.snoozedUntil}; ${unsnoozedOut} readings unsnoozed but held out; entered +${((entered - snoozedUntil) / 1000).toFixed(1)}s`)
    check("…and went in when the window closed, on the armed refresh rather than the 15s reconcile",
      Date.parse(arrival.queuedAt) - snoozedUntil >= 12_000 && Date.parse(arrival.queuedAt) - snoozedUntil < 14_000,
      `queuedAt=${arrival.queuedAt} (+${((Date.parse(arrival.queuedAt) - snoozedUntil) / 1000).toFixed(1)}s)`)
  }
  const order = orderQueue(after.filter(queued)).map((t) => t.id)
  check("the arrival joins the BACK of the queue (FIFO)", order.join() === "rested-first,rested-second,snoozed-oldest", order.join(" → "))
  // The negative control: the key the queue used to sort by, on the same live rows.
  const byRest = [...after.filter(queued)].sort((a, b) => Date.parse(a.lastAssistantAt) - Date.parse(b.lastAssistantAt)).map((t) => t.id)
  check("…where keyed on its rest time it would have jumped to the FRONT", byRest[0] === "snoozed-oldest", byRest.join(" → "))
  check("its stamp is when it entered, not when it rested",
    Date.parse(arrival.queuedAt) >= snoozedUntil && Date.parse(arrival.queuedAt) <= Date.now(),
    `queuedAt=${arrival.queuedAt} snoozedUntil=${held.snoozedUntil} rest=${arrival.lastAssistantAt}`)
  const stored = storedStamps()
  check("every stamp is persisted on its session row", after.every((t) => stored[t.id] === t.queuedAt), JSON.stringify(stored))

  // THE RENDERED RAIL: the cue's rows, top to bottom, and the rest-time column beside each.
  const shots = flags.shots ?? join(process.cwd(), ".adhoc-shots")
  mkdirSync(shots, { recursive: true })
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--force-color-profile=srgb"] })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 2 })
    const errors = []
    page.on("pageerror", (error) => errors.push(`pageerror: ${error}`))
    await page.goto(stack.url, { waitUntil: "networkidle2" })
    await page.waitForSelector("[data-rail-rested-age]", { timeout: 20_000 })
    const rail = await page.$$eval("[data-rail-rested-age]", (els) => els.map((el) => ({
      title: el.closest("a,button,li,div[role],div")?.textContent?.replace(el.textContent ?? "", "").trim().slice(0, 60),
      age: el.textContent,
      aria: el.getAttribute("aria-label"),
      top: el.getBoundingClientRect().top,
    })))
    rail.sort((a, b) => a.top - b.top)
    console.log(rail.map((r) => `  ${r.age.padStart(4)}  ${r.title}`).join("\n"))
    const titles = rail.map((r) => r.title ?? "")
    const idx = (text) => titles.findIndex((t) => t.includes(text))
    check("the rail draws the arrival LAST in the cue",
      idx("Fix the flaky login test") < idx("Tidy the settings drawer") && idx("Tidy the settings drawer") < idx("Bump the release pin"),
      titles.join(" → "))
    // The house duration grammar (`40m`, `2h 35m`, `3d`), summed to seconds so `6s` never compares to `20m`.
    const UNIT = { s: 1, m: 60, h: 3600, d: 86_400, w: 604_800, mo: 2_592_000, y: 31_536_000 }
    const seconds = (span) => (span === "just now" ? 0 : [...span.matchAll(/(\d+)(mo|[smhdwy])/g)].reduce((sum, [, n, unit]) => sum + Number(n) * UNIT[unit], 0))
    const ages = rail.map((r) => seconds(r.age))
    check("the rest-time column reads monotonically down the cue", ages.every((age, i) => i === 0 || age <= ages[i - 1]), rail.map((r) => r.age).join(", "))
    check("no page errors", errors.length === 0, errors.join("; "))
    await page.screenshot({ path: join(shots, "queue-arrival-rail.png"), clip: { x: 0, y: 0, width: 620, height: 900 } })
    console.log(`shot: ${join(shots, "queue-arrival-rail.png")}`)
  } finally {
    await browser.close()
  }
  console.log(`EXPECT ${JSON.stringify(Object.fromEntries(after.map((t) => [t.id, t.queuedAt])))}`)
} else if (phase === "restart") {
  const expect = JSON.parse(flags.expect ?? "{}")
  // The boot window: sample the column as fast as possible until the rows prime. A reading taken before
  // the tailer reaches a row sees it RUNNING — the clock must not take that as a departure.
  const samples = []
  const threads = await waitFor("the seeded rows to prime after the restart", async () => {
    samples.push(storedStamps())
    const t = seeded(await api.query("board"))
    return primed(t) && t
  })
  samples.push(storedStamps())
  check("no stored stamp was cleared or rewritten through the boot window",
    samples.every((s) => SLUGS.every((slug) => s[slug] === expect[slug])), `${samples.length} samples`)
  check("every thread keeps its place in line across the restart",
    threads.every((t) => t.queuedAt === expect[t.id]), threads.map((t) => `${t.id}=${t.queuedAt}`).join("; "))
  const order = orderQueue(threads.filter(queued)).map((t) => t.id)
  check("the order after the restart is unchanged", order.join() === "rested-first,rested-second,snoozed-oldest", order.join(" → "))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
