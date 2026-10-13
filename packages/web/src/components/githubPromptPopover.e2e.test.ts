import assert from "node:assert/strict"
import test from "node:test"

// Runtime coverage for the GitHub picker's header: the repo slug as a right-justified link out, and
// the gear that opens the triage prompt in a modal popover. Drives github-picker-range-fixture, which
// records every settingsSet the popover makes. Skipped unless FRIZZ_GITHUB_PROMPT_POPOVER_E2E_URL names
// a vite serving the fixtures (scripts/e2e-web.mjs sets it).
const baseUrl = process.env.FRIZZ_GITHUB_PROMPT_POPOVER_E2E_URL

type Fixture = { settingsWrites: Record<string, unknown>[]; dispatched: unknown[] }
const GEAR = 'button[aria-label="Triage prompt settings"]'
const PANEL = "[data-github-prompt-menu]"

async function launch(query = "?rows=5") {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.goto(`${baseUrl}/github-picker-range-fixture.html${query}`, { waitUntil: "networkidle0" })
  await page.waitForSelector("[data-row-number]")
  return { browser, page, errors }
}

const writes = (page: import("puppeteer").Page) =>
  page.evaluate(() => (window as unknown as { githubPickerRangeFixture: Fixture }).githubPickerRangeFixture.settingsWrites.map((w) => ({ ...w })))

async function selectAllInTextarea(page: import("puppeteer").Page) {
  await page.focus(`${PANEL} textarea`)
  await page.evaluate((panel) => {
    const box = document.querySelector<HTMLTextAreaElement>(`${panel} textarea`)!
    box.setSelectionRange(0, box.value.length)
  }, PANEL)
}

test("the header links out to the repo, right-justified, with the gear beside it", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    const header = await page.$eval("h2", (h2) => {
      const link = h2.querySelector<HTMLAnchorElement>("a.github-repo-link")!
      const gear = h2.querySelector<HTMLButtonElement>('button[aria-label="Triage prompt settings"]')!
      const title = h2.querySelector("span")!
      return {
        href: link.href,
        target: link.target,
        text: link.textContent?.trim(),
        hasArrow: link.querySelector("svg") !== null,
        // INK, not boxes: the gear's hover square is trimmed onto its glyph with negative margins, so
        // its box deliberately overlaps the link's and overhangs the header. What the eye reads is
        // where the glyphs' own geometry sits.
        linkRight: link.querySelector("svg")!.getBoundingClientRect().right,
        gearLeft: Math.min(...[...gear.querySelectorAll("svg *")].map((g) => g.getBoundingClientRect().left)),
        gearRight: Math.max(...[...gear.querySelectorAll("svg *")].map((g) => g.getBoundingClientRect().right)),
        h2Right: h2.getBoundingClientRect().right,
        titleRight: title.getBoundingClientRect().right,
        dash: /—/.test(h2.textContent ?? ""),
      }
    })
    assert.equal(header.href, "https://github.com/fixture/repo")
    assert.equal(header.target, "_blank")
    assert.equal(header.text, "fixture/repo")
    assert.equal(header.hasArrow, true)
    assert.equal(header.dash, false, "the slug is no longer an em-dashed suffix of the title")
    assert.ok(header.linkRight < header.gearLeft, "the slug sits left of the gear")
    const inset = header.h2Right - header.gearRight
    assert.ok(inset >= 0 && inset < 3, `the gear's ink ends just inside the header's right edge, got ${inset}`)
    assert.ok(header.linkRight - header.titleRight > 100, "the slug is right-justified, well clear of the title")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("the prompt panel shows the effective prompt, survives the pointer leaving, and debounces typing to one write", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await page.click(GEAR)
    await page.waitForSelector(`${PANEL} textarea`)
    assert.match(await page.$eval(`${PANEL} textarea`, (el) => (el as HTMLTextAreaElement).value), /^Triage \{repo\}#\{n\}/, "prefilled with the shipped default")
    await page.mouse.move(8, 8, { steps: 10 })
    await new Promise((r) => setTimeout(r, 400))
    assert.ok(await page.$(PANEL), "the panel is still open after the pointer left it")

    await selectAllInTextarea(page)
    await page.keyboard.type("Custom prompt", { delay: 30 })
    assert.equal((await writes(page)).length, 0, "nothing written while typing continues")
    await page.waitForFunction(() => (window as unknown as { githubPickerRangeFixture: Fixture }).githubPickerRangeFixture.settingsWrites.length === 1, { timeout: 3000 })
    await new Promise((r) => setTimeout(r, 600))
    const sent = await writes(page)
    assert.equal(sent.length, 1, "one write for a burst of typing")
    assert.equal(sent[0]!.githubPrompt, "Custom prompt")
    assert.equal(sent[0]!.notifications, true, "the whole object goes over")
    assert.match(await page.$eval(PANEL, (el) => el.textContent ?? ""), /Reset to default/, "a customized prompt offers its reset")

    // Escape closes the panel and ONLY the panel — the picker's own Escape handler closes the whole
    // modal, and it must not see this press.
    await page.keyboard.press("Escape")
    await page.waitForFunction((panel) => !document.querySelector(panel), {}, PANEL)
    assert.ok(await page.$("h2"), "the picker is still open")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("closing the panel by clicking outside flushes a pending keystroke, closes nothing else, and holds dispatch until the write lands", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch("?rows=5&settingsDelay=1500")
  try {
    // A row is checked, so the dispatch button is live and its gating is observable.
    await page.click("[data-row-number]")
    const startButton = async () => page.evaluateHandle(() => [...document.querySelectorAll("button")].find((b) => /^Start investigation/.test(b.textContent ?? ""))!)
    assert.equal(await (await startButton()).evaluate((b) => (b as HTMLButtonElement).disabled), false)

    await page.click(GEAR)
    await page.waitForSelector(`${PANEL} textarea`)
    await selectAllInTextarea(page)
    await page.keyboard.type("Flushed", { delay: 10 })
    assert.equal((await writes(page)).length, 0, "still inside the debounce")
    // Outside click: the panel's own dismiss. The picker's backdrop would close the picker on a
    // mousedown that reached it — it must not, because the modal panel owns the pointer.
    await page.mouse.click(8, 8)
    await page.waitForFunction((panel) => !document.querySelector(panel), {}, PANEL)
    assert.ok(await page.$("h2"), "the picker survived the outside click")
    // The flushed write is in flight for 1.5s: the button waits on it.
    await page.waitForFunction(() => [...document.querySelectorAll("button")].find((b) => /^Start investigation/.test(b.textContent ?? ""))?.disabled === true, { timeout: 2000 })
    await page.waitForFunction(() => [...document.querySelectorAll("button")].find((b) => /^Start investigation/.test(b.textContent ?? ""))?.disabled === false, { timeout: 5000 })
    const sent = await writes(page)
    assert.equal(sent.length, 1)
    assert.equal(sent[0]!.githubPrompt, "Flushed", "the half-typed value survived the close")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// The picker's issue and PR prompts merged into ONE field on 2026-08-15. Two properties of the RENDERED
// panel: there is exactly one editor (a stray second one would mean a per-kind field survived the
// merge), and "Reset to default" clears the override to undefined — the wire value that means "use the
// server default", as opposed to a copy of the default text frozen into the user's settings.
test("one prompt editor, and Reset clears the override rather than freezing the default text", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await page.click(GEAR)
    await page.waitForSelector(`${PANEL} textarea`)
    assert.equal(await page.evaluate(() => document.querySelectorAll("textarea").length), 1, "one editor, not one per kind")
    const labels = () => page.evaluate((panel) => [...document.querySelectorAll(`${panel} button`)].map((b) => (b.textContent ?? "").trim()), PANEL)
    assert.ok(!(await labels()).includes("Reset to default"), "no Reset while the box shows the shipped default")

    await selectAllInTextarea(page)
    await page.keyboard.type("mine", { delay: 30 })
    await page.waitForFunction(() => (window as unknown as { githubPickerRangeFixture: Fixture }).githubPickerRangeFixture.settingsWrites.length === 1, { timeout: 5000 })
    assert.equal((await writes(page))[0]!.githubPrompt, "mine")

    await page.evaluate((panel) => {
      [...document.querySelectorAll<HTMLButtonElement>(`${panel} button`)].find((b) => b.textContent?.trim() === "Reset to default")!.click()
    }, PANEL)
    await page.waitForFunction(() => (window as unknown as { githubPickerRangeFixture: Fixture }).githubPickerRangeFixture.settingsWrites.length === 2, { timeout: 5000 })
    const sent = await writes(page)
    assert.equal(sent[1]!.githubPrompt, undefined, "cleared to unset, which is what the server reads as 'default'")
    assert.ok(!("githubIssuePrompt" in sent[1]!), "the merged-away key never reappears on the wire")
    assert.ok(!("githubPrPrompt" in sent[1]!))
    assert.match(await page.$eval(`${PANEL} textarea`, (el) => (el as HTMLTextAreaElement).value), /^Triage \{repo\}/, "the box shows the shipped default again")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
