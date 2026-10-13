import assert from "node:assert/strict"
import test, { after, before } from "node:test"

// The composer's `@` MENTION TYPEAHEAD and the transcript's mention links, against the real <Composer>,
// ThreadRow and LinkifiedText on a stubbed board (thread-mentions-fixture.tsx). Pins the keyboard contract
// the skills menu set — ArrowDown/Enter and Tab complete, Escape dismisses without blurring — plus what
// is particular to mentions: the menu follows the CARET (a mention mid-draft), the thread being written
// into is offered last of all, and a sent `@handle` opens its thread.
//
// Skipped unless a Vite URL serving the fixtures is provided: start `vite` in packages/web and set
// FRIZZ_MENTIONS_E2E_URL to its origin.
const baseUrl = process.env.FRIZZ_MENTIONS_E2E_URL

const BOX = 'textarea[data-surface="chatComposer"]'
const MENU = "[data-mention-menu]"

type PuppeteerModule = typeof import("puppeteer")
type Browser = Awaited<ReturnType<PuppeteerModule["launch"]>>
type Page = Awaited<ReturnType<Browser["newPage"]>>

let browser: Browser | undefined
let page: Page | undefined
let errors: string[] = []

before(async () => {
  if (!baseUrl) return
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  browser = await launchHeadless()
  page = await browser.newPage()
  page.setDefaultTimeout(60_000)
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 })
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
})

after(async () => { await browser?.close() })

const menuRows = (): Promise<string[]> => page!.evaluate((sel) =>
  [...document.querySelectorAll(`${sel} button`)].map((row) => row.querySelector("span")!.textContent!), MENU)
const menuVisible = (): Promise<boolean> => page!.evaluate((sel) => Boolean(document.querySelector(sel)), MENU)
const boxValue = (): Promise<string> => page!.$eval(BOX, (el) => (el as HTMLTextAreaElement).value)
// Accepting restores the caret in a requestAnimationFrame; wait for it before typing on (see the skills
// typeahead test for the race this avoids).
const waitForCaretAt = (at: number): Promise<unknown> => page!.waitForFunction((sel, n) => {
  const el = document.querySelector(sel) as HTMLTextAreaElement | null
  return Boolean(el) && el!.selectionStart === n && el!.selectionEnd === n
}, {}, BOX, at)

async function open() {
  errors = []
  await page!.goto(`${baseUrl}/thread-mentions-fixture.html`, { waitUntil: "networkidle2" })
  await page!.waitForSelector(BOX)
  await page!.click(BOX)
}

test("the rail shows names as handles, and `@` offers them — open first, then done, this thread last", {
  skip: !baseUrl,
  timeout: 150_000,
}, async () => {
  await open()
  const rail = await page!.$$eval("[data-sidebar-rail] [data-xq-thread-row]", (rows) => rows.map((r) => r.textContent))
  assert.ok(rail.includes("shell-budgets") && rail.includes("arktype-perf"), `handles in the rail: ${rail.join(", ")}`)
  await page!.type(BOX, "ask @")
  await page!.waitForSelector(MENU)
  const rows = await menuRows()
  assert.equal(rows.at(-1), "@focus-mode", "the thread being written into is offered, after every other")
  assert.equal(rows.at(-2), "@billing-webhooks", "a done thread comes after every open one")
  assert.ok(!rows.some((r) => r.startsWith("@rework")), "a sentence-length title has no handle")
  await page!.type(BOX, "bud")
  assert.deepEqual(await menuRows(), ["@budget-report", "@shell-budgets"], "a handle prefix, then a word inside one")
  assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`)
})

test("ArrowDown+Enter completes mid-draft, Tab completes, and Escape closes without blurring", {
  skip: !baseUrl,
  timeout: 150_000,
}, async () => {
  await open()
  await page!.type(BOX, "ask @bud")
  await page!.waitForSelector(MENU)
  await page!.keyboard.press("ArrowDown")
  await page!.keyboard.press("Enter")
  assert.equal(await boxValue(), "ask @shell-budgets ", "the highlighted row, inserted as text — no newline, no send")
  await waitForCaretAt("ask @shell-budgets ".length)
  assert.equal(await menuVisible(), false)

  await page!.type(BOX, "and @ark")
  await page!.waitForSelector(MENU)
  await page!.keyboard.press("Tab")
  assert.equal(await boxValue(), "ask @shell-budgets and @arktype-perf ")
  await waitForCaretAt("ask @shell-budgets and @arktype-perf ".length)

  await page!.type(BOX, "@b")
  await page!.waitForSelector(MENU)
  await page!.keyboard.press("Escape")
  assert.equal(await menuVisible(), false, "Escape closes the menu")
  assert.equal(await page!.evaluate((sel) => document.activeElement === document.querySelector(sel), BOX), true, "…and keeps the caret in the box")
  assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`)
})

test("a sent @handle opens the thread it names; an unknown one stays text", {
  skip: !baseUrl,
  timeout: 150_000,
}, async () => {
  await open()
  const links = await page!.$$eval("[data-mention-bubble] a[data-thread-mention]", (as) => as.map((a) => [a.textContent, a.getAttribute("data-thread-mention")]))
  assert.deepEqual(links, [["@shell-budgets", "shell-budgets"], ["@focus-mode", "focus-mode"]])
  await page!.click('[data-mention-bubble] a[data-thread-mention="shell-budgets"]')
  const drawers = await page!.evaluate(() => (window as unknown as { __drawers: () => string[] }).__drawers())
  assert.deepEqual(drawers, ["thread:shell-budgets"], "a plain click opens the thread's drawer")
  assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`)
})

// ── SUB-AGENTS AFTER THE DOT (David 2026-09-30: "autocomplete should still work for subagents
// after .") — the fixture stubs `shell-budgets`'s subAgentDirectory.
const menuRowText = (): Promise<string[]> => page!.evaluate((sel) =>
  [...document.querySelectorAll(`${sel} button`)].map((row) => [...row.querySelectorAll("span")].map((s) => s.textContent).join(" | ")), MENU)
const directoryRequests = (): Promise<string[]> => page!.evaluate(() => [...(window as unknown as { __directoryRequests: string[] }).__directoryRequests])

test("`@thread.` offers that thread's sub-agents, live before returned, and narrows as you type", {
  skip: !baseUrl,
  timeout: 150_000,
}, async () => {
  await open()
  await page!.type(BOX, "ask @shell-budgets")
  await page!.waitForSelector(MENU)
  assert.deepEqual(await menuRows(), ["@shell-budgets"], "no dot: threads only, exactly as before")
  await page!.type(BOX, ".")
  await page!.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("aria-label") === "Sub-agents", {}, MENU)
  assert.deepEqual(await menuRows(), [
    "@shell-budgets.cache-keys",
    "@shell-budgets.wave-2",
    "@shell-budgets.wave-2.impl-w3",
    "@shell-budgets.cap-audit",
    "@shell-budgets.cache-sweep",
  ], "every addressed child, live first; the sentence-named one has no address and is not offered")
  const rows = await menuRowText()
  assert.match(rows[0]!, /^@shell-budgets\.cache-keys \| running 1[12]m$/)
  assert.match(rows[3]!, /^@shell-budgets\.cap-audit \| returned 3h ago \| done$/, "a returned child is tagged done")
  assert.match(rows[4]!, /^@shell-budgets\.cache-sweep \| failed 2d ago \| done$/)
  await page!.type(BOX, "ca")
  await page!.waitForFunction((sel) => document.querySelectorAll(`${sel} button`).length === 3, {}, MENU)
  assert.deepEqual(await menuRows(), ["@shell-budgets.cache-keys", "@shell-budgets.cap-audit", "@shell-budgets.cache-sweep"])
  await page!.type(BOX, "che")
  await page!.waitForFunction((sel) => document.querySelectorAll(`${sel} button`).length === 2, {}, MENU)
  assert.deepEqual(await directoryRequests(), ["shell-budgets"], "typing on reads the one answer the dot fetched")
  await page!.keyboard.press("Enter")
  assert.equal(await boxValue(), "ask @shell-budgets.cache-keys ", "completes to the whole address, then one space")
  await waitForCaretAt("ask @shell-budgets.cache-keys ".length)
  // A thread with no directory entries: the dot closes the menu rather than offering nothing.
  await page!.type(BOX, "and @arktype-perf.")
  await page!.waitForFunction(() => (window as unknown as { __directoryRequests: string[] }).__directoryRequests.includes("arktype-perf"))
  assert.equal(await menuVisible(), false)
  assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`)
})

test("a sent @thread.child opens that sub-agent's drawer; an unknown child opens its thread", {
  skip: !baseUrl,
  timeout: 150_000,
}, async () => {
  await open()
  const links = await page!.$$eval("[data-mention-bubble-sub] a[data-thread-mention]", (as) => as.map((a) => [a.textContent, a.getAttribute("data-subagent-mention")]))
  assert.deepEqual(links, [
    ["@shell-budgets.cache-keys", "shell-budgets.cache-keys"],
    ["@ShellBudget.capAudit", "ShellBudget.capAudit"],
    ["@shell-budgets.nothing", "shell-budgets.nothing"],
  ], "the sentence's full stop after cap-audit is not part of the link")
  // The fixture mounts no drawer stack, so each open replaces the top layer; read the top one.
  const openedBy = async (mention: string): Promise<string | undefined> => {
    // The click fetches the directory before it opens anything, so wait for the stack to move — read
    // BEFORE the click, since a cached answer can open the drawer before the next line runs.
    const before = await page!.evaluate(() => JSON.stringify((window as unknown as { __drawers: () => string[] }).__drawers()))
    await page!.click(`[data-mention-bubble-sub] a[data-subagent-mention="${mention}"]`)
    await page!.waitForFunction((was) => JSON.stringify((window as unknown as { __drawers: () => string[] }).__drawers()) !== was, {}, before)
    return page!.evaluate(() => (window as unknown as { __drawers: () => string[] }).__drawers().at(-1))
  }
  assert.equal(await openedBy("shell-budgets.cache-keys"), "subagent:shell-budgets:toolu_keys")
  assert.equal(await openedBy("ShellBudget.capAudit"), "subagent:shell-budgets:toolu_audit", "a returned child, found by its folded address")
  assert.equal(await openedBy("shell-budgets.nothing"), "thread:shell-budgets", "no such child: its thread opens instead")
  assert.deepEqual(await directoryRequests(), ["shell-budgets"], "three clicks, one fetch")
  assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`)
})

// AGENT PROSE (David 2026-09-30: agents referring to each other name "the fully qualified name so
// you can easily click to view that agent"): the real markdown pipeline, the real sanitizer, and the
// app's own delegated `/thread/` listener.
test("an agent's @thread and @thread.child in rendered markdown are links that open what they name", {
  skip: !baseUrl,
  timeout: 150_000,
}, async () => {
  await open()
  const links = await page!.$$eval("[data-agent-prose] a", (as) => as.map((a) => [a.textContent, a.getAttribute("href"), a.getAttribute("target")]))
  assert.deepEqual(links, [
    ["@shell-budgets", "/thread/shell-budgets", "_blank"],
    ["@shell-budgets.cache-keys", "/thread/shell-budgets#shell-budgets.cache-keys", "_blank"],
    ["@ShellBudget.capAudit", "/thread/shell-budgets#ShellBudget.capAudit", "_blank"],
    ["#arktype", "/project/arktype", "_blank"],
    ["#home", "/project/home", "_blank"],
    ["@shell-budgets", "https://example.com", "_blank"],
  ], "code, a package, an author's own link, an unknown thread and an unknown project are untouched")
  const code = await page!.$$eval("[data-agent-prose] code", (cs) => cs.map((c) => c.textContent))
  assert.deepEqual(code, ["@shell-budgets"])
  const top = () => page!.evaluate(() => (window as unknown as { __drawers: () => string[] }).__drawers().at(-1))
  const click = async (selector: string) => {
    const before = await page!.evaluate(() => JSON.stringify((window as unknown as { __drawers: () => string[] }).__drawers()))
    await page!.click(selector)
    await page!.waitForFunction((was) => JSON.stringify((window as unknown as { __drawers: () => string[] }).__drawers()) !== was, {}, before)
    return top()
  }
  assert.equal(await click('[data-agent-prose] a[href="/thread/shell-budgets#shell-budgets.cache-keys"]'), "subagent:shell-budgets:toolu_keys")
  assert.equal(await click('[data-agent-prose] a[href="/thread/shell-budgets#ShellBudget.capAudit"]'), "subagent:shell-budgets:toolu_audit")
  assert.equal(await click('[data-agent-prose] a[href="/thread/shell-budgets"]'), "thread:shell-budgets")
  assert.equal(page!.url().endsWith("/thread-mentions-fixture.html"), true, "a plain click never navigated")
  assert.equal((await browser!.pages()).length, 2, "…nor opened a tab")
  assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`)
})

// A FINISHED mention is tinted in the box, so it reads as a reference once typed: the mirror behind the
// textarea colours each `@handle` that names a thread (and a `@thread.child` whose thread resolves),
// while a half-typed or unknown `@` stays plain. The textarea's own glyphs go transparent only while a
// mention is on screen — otherwise it draws its text as ever.
test("a typed @handle that names a thread is highlighted in the box; a partial or unknown one is not", {
  skip: !baseUrl,
  timeout: 150_000,
}, async () => {
  await open()
  const state = () => page!.evaluate((sel) => ({
    marks: [...document.querySelectorAll("[data-composer-mention]")].map((m) => m.textContent),
    textHidden: getComputedStyle(document.querySelector(sel)!).color === "rgba(0, 0, 0, 0)",
  }), BOX)
  await page!.keyboard.type("ask @she")
  assert.deepEqual(await state(), { marks: [], textHidden: false }, "a half-typed mention is plain text")
  await page!.keyboard.type("ll-budgets and @nobody and @shell-budgets.cache-keys ")
  assert.deepEqual(await state(), { marks: ["@shell-budgets", "@shell-budgets.cache-keys"], textHidden: true })
  await page!.keyboard.down("Control")
  await page!.keyboard.press("a")
  await page!.keyboard.up("Control")
  await page!.keyboard.type("plain again")
  assert.deepEqual(await state(), { marks: [], textHidden: false }, "the textarea draws its own text once no mention remains")
  assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`)
})

// `#` NAMES A PROJECT (David 2026-10-06: "add # syntax for referring to projects like #home and
// #arktype that autocompletes and is styled similarly to @thread-name"): the same menu, keyboard and tint
// as `@`, over the machine's projects (lib/projectMentions.ts), and the same link treatment once sent.
test("`#` offers the projects, completes one, and tints it like a thread mention", {
  skip: !baseUrl,
  timeout: 150_000,
}, async () => {
  await open()
  await page!.type(BOX, "port it to #")
  await page!.waitForSelector(MENU)
  assert.deepEqual(await menuRows(), ["#frizz", "#home", "#arktype", "#beanemachine"], "every project but the one whose folder is gone")
  assert.equal(await page!.$eval(MENU, (m) => m.getAttribute("aria-label")), "Projects")
  await page!.type(BOX, "bea")
  assert.deepEqual(await menuRows(), ["#beanemachine"])
  await page!.keyboard.press("Escape")
  assert.equal(await menuVisible(), false, "Escape closes it")
  for (let i = 0; i < 3; i++) await page!.keyboard.press("Backspace")
  await page!.keyboard.type("ark")
  await page!.waitForSelector(MENU)
  await page!.keyboard.press("Enter")
  await waitForCaretAt("port it to #arktype ".length)
  assert.equal(await boxValue(), "port it to #arktype ")
  assert.equal(await menuVisible(), false)
  await page!.keyboard.type("and @shell-budgets, not #nobody or #12")
  const marks = await page!.evaluate(() => ({
    projects: [...document.querySelectorAll("[data-composer-project-mention]")].map((m) => [m.textContent, m.className]),
    threads: [...document.querySelectorAll("[data-composer-mention]")].map((m) => m.className),
  }))
  assert.deepEqual(marks.projects.map(([text]) => text), ["#arktype"], "a finished project mention is tinted; an unknown one and a GitHub ref are not")
  assert.equal(marks.projects[0]![1], marks.threads[0], "in exactly the thread mention's treatment")
  await page!.keyboard.type(" #")
  await page!.waitForSelector(MENU)
  await page!.keyboard.type("1")
  assert.equal(await menuVisible(), false, "a digit after # is a GitHub ref being typed")
  assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`)
})

test("a sent #project links to its board", {
  skip: !baseUrl,
  timeout: 150_000,
}, async () => {
  await open()
  const links = await page!.$$eval("[data-project-bubble] a", (as) => as.map((a) => [a.textContent, a.getAttribute("href"), a.getAttribute("title")]))
  assert.deepEqual(links, [
    ["#arktype", "/project/arktype", "ArkType"],
    ["@focus-mode", "/thread/focus-mode", "Waiting on your call about the drawer"],
    ["#Home", "/project/home", "Home"],
  ], "an unknown project stays text")
  const look = await page!.evaluate(() => {
    const [project, thread] = ["[data-project-bubble] a[data-project-mention]", "[data-project-bubble] a[data-thread-mention]"].map((sel) => getComputedStyle(document.querySelector(sel)!))
    return [project!.color === thread!.color, project!.textDecorationLine === thread!.textDecorationLine, project!.textUnderlineOffset === thread!.textUnderlineOffset]
  })
  assert.deepEqual(look, [true, true, true], "styled as a thread mention is")
  await Promise.all([page!.waitForNavigation(), page!.click("[data-project-bubble] a[data-project-mention='arktype']")])
  assert.equal(new URL(page!.url()).pathname, "/project/arktype")
  assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`)
})
