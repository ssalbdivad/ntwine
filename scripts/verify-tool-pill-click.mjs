// A collapsible tool pill opens when you click ANYWHERE in its header — except on a link inside it.
//
// Read / Edit / Agent cards used to be openable only by their 12px chevron at the far right edge,
// while their Bash / Todo / Sent siblings — one big `<button>`, because they hold no link — opened
// anywhere in the row. Same card family, two different targets (maintainer 2026-07-31). The three
// link-bearing cards now toggle on the whole row, and hand the click back to whatever owns it: the
// file deep-link, the sub-agent drill-in, the chevron.
//
// Driven through the REAL pipeline — JSONL → tailer → transcript projection → ChatView → the real
// thread drawer (`/all/<project>/thread/<slug>`) — with real mouse clicks at real coordinates, because this is pointer
// behavior and nothing short of a browser can observe it. The fixture `.html` files in packages/web
// are NOT servable through the ntwine server (appType:"custom" sends every path to index.html).
//
// Every card carries its own in-frame control: a Bash card (already row-clickable before this change)
// proves the probe can see a toggle at all, so a Read/Edit/Agent failure is about the change and not
// about the instrument.
//
// Usage: nub scripts/verify-tool-pill-click.mjs --port=4931 --home=/abs/temp-home [--shots=/abs/dir]
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createRpcClient } from "./lib/rpc-client.mjs"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"
import { HARNESS_404 } from "./lib/page-errors.mjs"

const args = process.argv.slice(2)
const opt = (k, d) => { const hit = args.find((a) => a.startsWith(`--${k}=`)); return hit ? hit.slice(k.length + 3) : d }
const port = Number(opt("port", "4931"))
const home = opt("home")
const cwd = opt("project", process.cwd())
const shots = opt("shots")
if (!home) throw new Error("--home=<stack temp HOME> is required (the adhoc stack prints it as `home`)")

const SLUG = "tool-pill-click"
// A FRESH session id per run: the server caches the transcript projection PER SESSION, so a fixed id
// makes a re-run silently assert against the previous run's parse.
const SESSION_ID = randomUUID()
const now = new Date().toISOString()

const logDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(logDir, { recursive: true })
const base = { isSidechain: false, userType: "external", cwd, sessionId: SESSION_ID, version: "2.1.220", gitBranch: "main" }
const records = []
let n = 0
const push = (rec) => records.push({ ...base, ...rec, parentUuid: records.length ? records.at(-1).uuid : null, uuid: `0000000${++n}-0000-0000-0000-000000000000`.slice(-36), timestamp: now })
const user = (text) => push({ type: "user", message: { role: "user", content: text } })
const assistant = (text) => push({ type: "assistant", message: { role: "assistant", model: "claude-opus-5", stop_reason: "end_turn", content: [{ type: "text", text }] } })
const toolCall = (id, name, input) => push({ type: "assistant", message: { role: "assistant", model: "claude-opus-5", stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] } })
const toolResult = (id, content) => push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] } })

const TARGET = `${cwd}/packages/web/src/components/ToolDisclosureHeader.ts`

user("Make the whole tool pill clickable.")
assistant("Reading the disclosure header first.")
// READ — its header carries a `cursor://` PathLink to the file it read.
toolCall("t_read", "Read", { file_path: TARGET })
toolResult("t_read", "export function ToolDisclosureHeader({\n  children,\n  className,\n}: Props) {\n  return createElement(\"div\", …)\n}")
// EDIT — the diff card, same PathLink treatment in a different header class (.ntwine-diff-header).
toolCall("t_edit", "Edit", {
  file_path: TARGET,
  old_string: '{ className: `${className} w-full text-left`, "data-expanded": expanded }',
  new_string: '{ className: `${className} w-full cursor-pointer text-left`, "data-expanded": expanded, onClick: onHeaderClick }',
})
toolResult("t_edit", "The file has been updated.")
// BASH — the IN-FRAME CONTROL. Its header was already one big <button>, so it toggled on a row click
// before this change and must still. If the probe cannot see THIS toggle, the probe is broken.
toolCall("t_bash", "Bash", { command: "nub --test 'packages/web/src/components/ToolDisclosureHeader.test.ts'", description: "Running the disclosure header tests" })
toolResult("t_bash", "tests 5\npass 5\nfail 0")
assistant("Dispatching a reviewer over the diff.")
// AGENT — its header's title is a drill-in BUTTON (opens the sub-agent drawer), not an <a>. The other
// half of "unless there's some kind of link within it": a link by behavior, not by tag name.
toolCall("t_agent", "Agent", {
  prompt: "Read the diff on ToolDisclosureHeader.ts and attack the click guard: name every element in a tool header that owns its own click and would break if the row swallowed it.",
  subagent_type: "ntwine:opus-high",
  description: "Attack the click guard",
})
assistant("Waiting on the reviewer.")

writeFileSync(join(logDir, `${SESSION_ID}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
const threadName = `ntwine-${SLUG}`
execFileSync("sqlite3", [db, `DELETE FROM session WHERE slug = '${SLUG}';`])
execFileSync("sqlite3", [db, `INSERT OR REPLACE INTO session
  (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, unread, exited, archived, title_auto, runtime_generation, profile_revision)
  VALUES (${sessionVals}'${SLUG}', '${SESSION_ID}', '${threadName}', '${now}', 'Tool pill click', 'claude', 'opus', 'high', 'default', 0, 0, 0, 0, 0, 0);`])

const api = createRpcClient(`http://127.0.0.1:${port}/`)
await api.waitForHealth()

const { launchHeadless } = await import("./lib/headless-browser.mjs")
const browser = await launchHeadless()
const failures = []
const pageErrors = []
const check = (ok, label, detail) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ""}`) }

// Locate a card by its petite-caps label ("Read" / "Edit" / "Bash" / "Agent"), and report the geometry
// of its header, of the link inside it, and of the dead space between the two halves. Every subsequent
// click is aimed with these numbers rather than at a selector, so the assertion is about PIXELS the
// human can actually hit.
// Scoped to the THREAD's own drawer layer, never `document`: drilling into a sub-agent or opening a file
// mounts another layer OVER the thread with cards of its own, and the one page keeps its queue cards
// rendered BEHIND the drawer, so an unscoped lookup silently measures some other card than the one under
// test. The thread is the BOTTOM layer — the first one opened, so the lowest `data-drawer-layer` id.
// (This was `[data-transcript-column]`, which no longer exists; the `?? document` fallback had quietly
// made every probe page-wide.)
const CARD_GEOMETRY = (label) => {
  const column = [...document.querySelectorAll("[data-drawer-layer]")].sort((a, b) => Number(a.dataset.drawerLayer) - Number(b.dataset.drawerLayer))[0]
  if (!column) return null
  const cards = [...column.querySelectorAll(".ntwine-bash, .ntwine-diff")]
  const card = cards.find((c) => c.querySelector(".ntwine-bash-label")?.textContent?.trim() === label)
  if (!card) return null
  const header = card.querySelector(".ntwine-bash-header, .ntwine-diff-header")
  const left = header.children[0]
  const right = header.children[1]
  const disclosure = header.querySelector("[data-tool-disclosure]") ?? header
  // The header's own action: the sub-agent drill-in, or the file path. The path was
  // `<a href="cursor://…">` until 489b231f (2026-08-19) made it PathLink's <button title={path}>, which
  // opens the file IN Ntwine (a reader layer) through openLocalPath. A button in the LEFT group that is
  // not the disclosure chevron is exactly that.
  const link = header.querySelector('button[aria-label^="Open sub-agent transcript"]') ?? left.querySelector("button[title]:not([data-tool-disclosure])")
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, cx: r.x + r.width / 2, cy: r.y + r.height / 2 } }
  return {
    header: box(header),
    labelBox: box(header.querySelector(".ntwine-bash-label")),
    left: box(left),
    right: right ? box(right) : null,
    disclosure: box(disclosure),
    link: link ? { ...box(link), tag: link.tagName, text: link.textContent.trim(), title: link.getAttribute("title") } : null,
    // The disclosure state as the DOM reports it. Family 1 puts aria-expanded on the header <button>;
    // family 2 puts it on the chevron and mirrors it onto the row as data-expanded.
    expanded: (header.getAttribute("data-expanded") ?? header.getAttribute("aria-expanded") ?? disclosure.getAttribute("aria-expanded")) === "true",
    cursor: getComputedStyle(header).cursor,
    bodyVisible: !!card.querySelector(".ntwine-bash-body, .ntwine-diff-body .ntwine-diff-line"),
  }
}

let page
try {
  // THE INSTRUMENT TRAP, and why every protocol click is quarantined behind a FRESH TAB.
  // Clicking a real `cursor://` link makes headless Chrome attempt an external-protocol launch, and
  // from that moment the tab stops receiving SYNTHESIZED mouse clicks — page-wide, permanently, with
  // no error, and a `page.goto` reload does NOT clear it. Every assertion after one reads exactly like
  // "the fix doesn't work". It is not the fix: measured 2026-07-31, after one such click an untouched
  // pre-existing `<button>` (the "N tool calls" band toggle) also stopped responding to
  // `page.mouse.click`, while a JS `.click()` on the very chevron that "failed" still opened its card.
  // Only a new tab recovers, so a protocol click is always the LAST thing done on the tab it happens on.
  const openThread = async ({ fresh = false } = {}) => {
    if (fresh || !page) {
      const stale = page
      page = await browser.newPage()
      page.on("pageerror", (e) => pageErrors.push(String(e)))
      // A cursor:// navigation has no handler in headless Chrome — expected, not a page defect. The
      // console's "Failed to load resource" echo is dropped because the response listener below records
      // the same failure WITH its URL, minus the disposable stack's supervisor 404 (lib/page-errors.mjs).
      page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource") && !/cursor:\/\/|ERR_UNKNOWN_URL_SCHEME|Not allowed to launch/i.test(m.text())) pageErrors.push(m.text()) })
      page.on("response", (r) => { if (r.status() >= 400 && !HARNESS_404.test(r.url())) pageErrors.push(`${r.status()} ${r.url()}`) })
      await page.setViewport({ width: 1400, height: 1100, deviceScaleFactor: 2 })
      if (stale) await stale.close()
    }
    // The thread's drawer on the one page (rpc-client threadUrl); the bare `/thread/<slug>` it opened until
    // 2026-09-28 now lands on `/`.
    await page.goto(await api.threadUrl(SLUG), { waitUntil: "networkidle0" })
    await page.waitForSelector("[data-drawer-layer] .ntwine-bash, [data-drawer-layer] [data-tool-activity]", { timeout: 20_000 })
    // Ordinary calls fold behind an "N tool calls" band; open every one so all four cards mount.
    for (const toggle of await page.$$('[data-drawer-layer] [data-tool-activity] > button[aria-expanded="false"]')) await toggle.click()
    await page.waitForFunction(() => [...document.querySelectorAll("[data-drawer-layer] .ntwine-bash-label")].some((l) => l.textContent.trim() === "Agent"), { timeout: 10_000 })
  }
  await openThread()

  const geom = async (label) => page.evaluate(CARD_GEOMETRY, label)
  const clickAt = async (x, y) => { await page.mouse.click(x, y); await new Promise((r) => setTimeout(r, 160)) }

  const seen = await page.evaluate(() => [...document.querySelectorAll("[data-drawer-layer] .ntwine-bash-label")].map((l) => l.textContent.trim()))
  check(["Read", "Edit", "Bash", "Agent"].every((l) => seen.includes(l)), "the four card families render", JSON.stringify(seen))

  // ── 1. the row reads as clickable ────────────────────────────────────────────────────────────────
  for (const label of ["Read", "Edit", "Agent"]) {
    const g = await geom(label)
    check(g?.cursor === "pointer", `${label}: the header row shows a pointer cursor`, g?.cursor)
  }

  // ── 2. clicking DEAD SPACE in the header toggles ─────────────────────────────────────────────────
  // Aimed at the middle of the gap between the left group and the status/chevron cluster — the widest
  // part of the row, the part a human actually clicks, and the part that did nothing before.
  for (const label of ["Read", "Edit", "Agent", "Bash"]) {
    const before = await geom(label)
    const gapLeft = before.left.right
    const gapRight = before.right ? before.right.x : before.header.right
    check(gapRight - gapLeft > 20, `${label}: the header has real dead space to click`, `${Math.round(gapRight - gapLeft)}px`)
    await clickAt((gapLeft + gapRight) / 2, before.header.cy)
    const after = await geom(label)
    check(after.expanded !== before.expanded, `${label}: clicking the header's dead space toggles the card`,
      `expanded ${before.expanded} → ${after.expanded}`)
    check(after.bodyVisible, `${label}: and the body it opened is actually rendered`, JSON.stringify({ bodyVisible: after.bodyVisible }))
    // …and back, so the row toggles rather than only ever opening.
    await clickAt((gapLeft + gapRight) / 2, before.header.cy)
    check((await geom(label)).expanded === before.expanded, `${label}: clicking it again closes the card`)
  }

  // ── 3. clicking the petite-caps LABEL toggles too ────────────────────────────────────────────────
  for (const label of ["Read", "Edit", "Agent"]) {
    const before = await geom(label)
    await clickAt(before.labelBox.cx, before.labelBox.cy)
    check((await geom(label)).expanded !== before.expanded, `${label}: clicking the tool label toggles the card`)
    await clickAt(before.labelBox.cx, before.labelBox.cy)
  }

  // ── 4. the chevron toggles EXACTLY once ──────────────────────────────────────────────────────────
  // Its click bubbles through the new row handler; a guard that missed `button` would toggle twice and
  // the card would flicker back shut. Nothing in the DOM records "toggled twice", so the observable is
  // simply that one click lands OPEN.
  for (const label of ["Read", "Edit", "Agent"]) {
    const before = await geom(label)
    check(before.expanded === false, `${label}: starts collapsed for the chevron check`, String(before.expanded))
    await clickAt(before.disclosure.cx, before.disclosure.cy)
    check((await geom(label)).expanded === true, `${label}: one chevron click opens it (no double toggle)`)
  }

  // ── 5. clicking the BODY does not collapse ───────────────────────────────────────────────────────
  // All three are open from the chevron check. An expanded body holds code and diffs the reader needs
  // to select and scroll — the click target is the HEADER, deliberately, and never the whole card.
  for (const label of ["Read", "Edit", "Agent"]) {
    const body = await page.evaluate((l) => {
      const column = [...document.querySelectorAll("[data-drawer-layer]")].sort((a, b) => Number(a.dataset.drawerLayer) - Number(b.dataset.drawerLayer))[0]
      const card = [...column.querySelectorAll(".ntwine-bash, .ntwine-diff")].find((c) => c.querySelector(".ntwine-bash-label")?.textContent?.trim() === l)
      const el = card?.querySelector(".ntwine-bash-body, .ntwine-diff-line")
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, h: r.height }
    }, label)
    check(!!body && body.h > 0, `${label}: has a visible body to click into`, JSON.stringify(body))
    if (!body) continue
    await clickAt(body.cx, body.cy)
    check((await geom(label)).expanded === true, `${label}: clicking inside the open body does NOT collapse it`)
  }

  // ── 6. the Agent drill-in must not EAT the row ───────────────────────────────────────────────────
  // Its title button is `flex-1`, so if it stretches past its own text there is nothing left to click
  // for "anywhere else" on an Agent card — the one card where the exception could swallow the rule.
  const agentSpan = await page.evaluate(() => {
    const card = [...document.querySelectorAll("[data-drawer-layer] .ntwine-bash")].find((c) => c.querySelector(".ntwine-bash-label")?.textContent?.trim() === "Agent")
    const header = card.querySelector(".ntwine-bash-header")
    const btn = header.querySelector('button[aria-label^="Open sub-agent transcript"]')
    const range = document.createRange()
    range.selectNodeContents(btn)
    const ink = range.getBoundingClientRect()
    const b = btn.getBoundingClientRect()
    const h = header.getBoundingClientRect()
    return { overhang: Math.round(b.right - ink.right), buttonW: Math.round(b.width), inkW: Math.round(ink.width), headerW: Math.round(h.width) }
  })
  check(agentSpan.overhang <= 4, "the Agent drill-in hugs its title instead of eating the row",
    `${agentSpan.overhang}px of dead button past the text (button ${agentSpan.buttonW}px vs ink ${agentSpan.inkW}px, header ${agentSpan.headerW}px)`)

  if (shots) {
    mkdirSync(shots, { recursive: true })
    await page.screenshot({ path: join(shots, "tool-pill-click-expanded.png") })
    // The RESTING state — every pill collapsed, which is what a human is looking at when they click.
    await openThread()
    await page.screenshot({ path: join(shots, "tool-pill-click-desktop.png") })
    // A 26px pill inside a 1400px frame cannot be judged, so crop to the card stack at 2x and let the
    // row's own proportions be readable.
    const strip = await page.evaluate(() => {
      const cards = [...document.querySelectorAll("[data-drawer-layer] .ntwine-bash, [data-drawer-layer] .ntwine-diff")]
      const boxes = cards.map((c) => c.getBoundingClientRect())
      const x = Math.min(...boxes.map((b) => b.x)), right = Math.max(...boxes.map((b) => b.right))
      const y = Math.min(...boxes.map((b) => b.y)), bottom = Math.max(...boxes.map((b) => b.bottom))
      return { x: x - 8, y: y - 8, width: right - x + 16, height: bottom - y + 16 }
    })
    await page.screenshot({ path: join(shots, "tool-pill-click-strip.png"), clip: strip })
    await page.setViewport({ width: 460, height: 1000, deviceScaleFactor: 2 })
    await new Promise((r) => setTimeout(r, 500))
    await page.screenshot({ path: join(shots, "tool-pill-click-narrow.png") })
    await page.setViewport({ width: 1400, height: 1100, deviceScaleFactor: 2 })
    await new Promise((r) => setTimeout(r, 400))
    console.log(`shots → ${shots}`)
  }

  // ── 7. clicking a FILE PATH does NOT toggle ──────────────────────────────────────────────────────
  // Half the point of the exception: Read and Edit each carry the file's path in the header. It was an
  // <a href="cursor://…"> when this was written; since 489b231f (2026-08-19) it is PathLink's <button>,
  // which opens the file in Ntwine's own reader. That makes the click OBSERVABLE, so, like the sub-agent
  // name below, it gets a differential: a guard that swallowed the click would pass "does not toggle" by
  // doing nothing, and the reader layer mounting is what tells the two apart. Still one card per fresh
  // tab — a reader layer over the thread is state the next card's probe should not start from.
  const layers = () => page.evaluate(() => document.querySelectorAll("[data-drawer-layer]").length)
  for (const label of ["Read", "Edit"]) {
    await openThread({ fresh: true })
    const before = await geom(label)
    check(before.link?.tag === "BUTTON" && before.link?.title === TARGET, `${label}: its header carries a file-path link`, JSON.stringify(before.link))
    check(before.expanded === false, `${label}: starts collapsed for the file-path check`, String(before.expanded))
    if (!before.link) continue
    const layersBefore = await layers()
    await clickAt(before.link.cx, before.link.cy)
    const after = await geom(label)
    check(after.expanded === before.expanded, `${label}: clicking the file path does NOT toggle the card`,
      `expanded ${before.expanded} → ${after.expanded}`)
    await page.waitForFunction((n) => document.querySelectorAll("[data-drawer-layer]").length > n, { timeout: 10_000 }, layersBefore).catch(() => {})
    const layersAfter = await layers()
    check(layersAfter > layersBefore, `${label}: and the file path still opens the file`, `drawer layers ${layersBefore} → ${layersAfter}`)
  }

  // ── 8. the SUB-AGENT NAME: the other half of the exception, and it goes LAST ─────────────────────
  // Clicking it must not toggle the card AND must still open the drawer — a guard that simply
  // swallowed the click would satisfy the first half by doing nothing at all, so the drawer is the
  // differential. It mounts a second transcript column over the thread, which is why nothing else can
  // run after it: every geometry probe above is scoped to column 0 precisely because of this.
  {
    await openThread({ fresh: true })
    const before = await geom("Agent")
    check(before.link?.tag === "BUTTON", "Agent: its header title is the sub-agent drill-in", JSON.stringify(before.link))
    await clickAt(before.link.cx, before.link.cy)
    const after = await geom("Agent")
    check(after.expanded === before.expanded, "Agent: clicking the sub-agent name does NOT toggle the card",
      `expanded ${before.expanded} → ${after.expanded}`)
    // The differential is a SECOND drawer layer. `[role="dialog"]` used to be enough, when the thread
    // was a board page; it is itself a Radix dialog now, so that test would pass with nothing opened.
    await page.waitForFunction(() => document.querySelectorAll("[data-drawer-layer]").length > 1, { timeout: 10_000 }).catch(() => {})
    const drawer = await page.evaluate(() => ({ layers: document.querySelectorAll("[data-drawer-layer]").length }))
    check(drawer.layers > 1, "Agent: and the sub-agent name still opens its drawer", JSON.stringify(drawer))
    if (shots) await page.screenshot({ path: join(shots, "tool-pill-click-drilled.png") })
  }

  check(pageErrors.length === 0, "no page or console errors", pageErrors.join(" | "))
} finally {
  await browser.close()
}

console.log(failures.length ? `\n${failures.length} FAILURE(S):\n${failures.map((f) => `  • ${f}`).join("\n")}` : "\nall checks passed")
process.exit(failures.length ? 1 : 0)
