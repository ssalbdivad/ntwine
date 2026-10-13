import assert from "node:assert/strict"
import test from "node:test"

// Runtime coverage for "the references inside a question are live — a file path, a Markdown link, a
// #123 reference, a bare URL — and clicking one follows it without picking the option". Skipped unless a
// Vite URL serving the fixtures is provided (same pattern as the other *.e2e.test.ts here): start `vite`
// in packages/web and set NTWINE_QUESTION_CARD_LINKS_E2E_URL to its origin.
//
// EVERY CLICK HERE IS A REAL MOUSE CLICK AT COORDINATES, never `el.click()`. The chip is a row whose hit
// area is a stretched button laid over the text, and the references are positioned above it (styles.css
// `[data-question-option]`). A DOM query proves the link is in the markup; only a hit-test proves it is
// on TOP — a link that ends up under the button is present, styled, and picks the option when clicked.
const baseUrl = process.env.NTWINE_QUESTION_CARD_LINKS_E2E_URL

type Page = import("puppeteer").Page

async function launch() {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  await page.setViewport({ width: 900, height: 1200, deviceScaleFactor: 2 })
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  return { browser, page, errors }
}

// The n-th option row (0-based) of the card in `scope`.
const option = (scope: string, i: number) => `${scope} [data-question-option]:nth-of-type(${i + 1})`

// Click the centre of the first element `selector` matches, with the mouse.
async function mouseClick(page: Page, selector: string) {
  const box = await page.$eval(selector, (n) => {
    const r = n.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await page.mouse.click(box.x, box.y)
}

const chips = (page: Page) => page.evaluate(() => (window as Window & { __chips?: number[] }).__chips ?? [])
const drawers = (page: Page) =>
  page.evaluate(() => (window as Window & { __drawers?: () => { kind: string; path?: string }[] }).__drawers?.() ?? [])

test("references inside a question card are live, and clicking one does not pick the option", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await page.goto(`${baseUrl}/question-links-fixture.html`, { waitUntil: "networkidle0" })
    await page.waitForSelector("[data-case='live'] [data-question-option]")
    // Anchors open in a new tab; hold them on this page so the click's other consequence is observable.
    await page.evaluate(() => {
      const w = window as Window & { __anchors?: string[] }
      w.__anchors = []
      document.addEventListener("click", (e) => {
        const a = e.target instanceof Element ? e.target.closest("a[href]") : null
        if (!a) return
        e.preventDefault()
        w.__anchors!.push(a.getAttribute("href") ?? "")
      })
    })
    const live = "[data-case='live']"
    const A = option(live, 0)
    const B = option(live, 1)

    // ── The augmentations are all there, on the real render path ──
    // The bare filename in A resolves through the server (stubbed) and is tagged as an openable path…
    await page.waitForSelector(`${A} code.local-file-code[data-local-path='/fixture/cloudflare-ask.md']`)
    // …and so is the slash-bearing one in the context and the one in the footnote.
    await page.waitForSelector(`${live} .md-body code.local-file-code[data-local-path='/fixture/notes/cloudflare-ask.md']`)
    await page.waitForSelector(`${live} .md-body code.local-file-code[data-local-path='/fixture/logs/send.log']`)
    // A path the server does not know stays plain code.
    assert.equal(await page.$$eval(`${live} code`, (ns) => ns.filter((n) => n.textContent === "old-ask.md" && n.classList.contains("local-file-code")).length), 0)
    // The #482 reference in A links to the project's repo — which arrived AFTER the first render.
    await page.waitForSelector(`${A} a[href='https://github.com/ssalbdivad/ntwine/issues/482']`)
    // The Markdown link to a .md file in B is the reader button, and the bare URL is an anchor.
    await page.waitForSelector(`${B} button.local-file-action[data-local-path='/fixture/draft.md']`)
    const bare = await page.$eval(`${B} a[href='https://example.com/guide']`, (a) => ({ target: a.getAttribute("target"), rel: a.getAttribute("rel") }))
    assert.deepEqual(bare, { target: "_blank", rel: "noopener noreferrer" })

    // Every path in the card was asked about ONCE, in one batch, even though the context, the option
    // and the footnote each ran their own decoration pass.
    const calls = await page.evaluate(() => (window as Window & { __resolveCalls?: string[][] }).__resolveCalls ?? [])
    assert.deepEqual(calls.flat().sort(), ["cloudflare-ask.md", "logs/send.log", "notes/cloudflare-ask.md", "old-ask.md"])

    // ── Clicks: a reference follows, the row picks ──
    // The file path in A opens the reader and does NOT select A.
    await mouseClick(page, `${A} code.local-file-code`)
    await page.waitForFunction(() => (window as Window & { __drawers?: () => unknown[] }).__drawers!().length > 0)
    assert.deepEqual(await drawers(page), [{ kind: "file", path: "/fixture/cloudflare-ask.md" }])
    assert.deepEqual(await chips(page), [])
    await page.evaluate(() => { for (const el of document.querySelectorAll("[data-drawer-close], [aria-label='Close']")) (el as HTMLElement).click() })
    await page.keyboard.press("Escape")

    // The GitHub reference in A follows, and does not select A.
    await mouseClick(page, `${A} a[href='https://github.com/ssalbdivad/ntwine/issues/482']`)
    assert.deepEqual(await page.evaluate(() => (window as Window & { __anchors?: string[] }).__anchors), ["https://github.com/ssalbdivad/ntwine/issues/482"])
    assert.deepEqual(await chips(page), [])

    // The .md link in B opens the reader (a second drawer), and does not select B.
    await mouseClick(page, `${B} button.local-file-action`)
    await page.waitForFunction(() => (window as Window & { __drawers?: () => unknown[] }).__drawers!().some((d) => (d as { path?: string }).path === "/fixture/draft.md"))
    assert.deepEqual(await chips(page), [])

    // The bare URL in B follows, and does not select B.
    await mouseClick(page, `${B} a[href='https://example.com/guide']`)
    assert.deepEqual(await page.evaluate(() => (window as Window & { __anchors?: string[] }).__anchors), [
      "https://github.com/ssalbdivad/ntwine/issues/482",
      "https://example.com/guide",
    ])
    assert.deepEqual(await chips(page), [])

    // Plain text of the row — the "A." that opens it — picks A. Located by a Range on the option's
    // first text node, not by the row's left edge: the option wraps, and at the row's vertical centre
    // the left edge holds the SECOND line, which is where the #482 link starts.
    const a0 = await page.$eval(`${A} .md-inline`, (n) => {
      const range = document.createRange()
      range.selectNodeContents(n.firstChild!)
      const r = range.getClientRects()[0]!
      return { x: r.left + 6, y: r.top + r.height / 2 }
    })
    await page.mouse.click(a0.x, a0.y)
    assert.deepEqual(await chips(page), [0])
    assert.equal(await page.$eval(A, (n) => n.classList.contains("border-selection-border")), true)
    // And the "Recommended" badge is part of the row's hit area too.
    await mouseClick(page, `${A} .float-right`)
    assert.deepEqual(await chips(page), [0, 0])

    // The row's button is what a keyboard reaches, and it is named by the option's text.
    const named = await page.$eval(`${A} > button`, (b) => {
      const id = b.getAttribute("aria-labelledby") ?? ""
      return (document.getElementById(id)?.textContent ?? "").replace(/\s+/g, " ").trim()
    })
    assert.match(named, /^Recommended ?Yes — it's in cloudflare-ask\.md/)

    // ── A PAST question: the row is inert, its references are not ──
    const ro = "[data-case='readonly']"
    assert.equal(await page.$eval(`${option(ro, 0)} > button`, (b) => (b as HTMLButtonElement).disabled), true)
    // …and it must NOT wear the pointer the live rows carry (styles.css `[data-question-option]`), which
    // is why that rule is selected on the same `button:disabled` test the base cursor rule uses.
    assert.equal(await page.$eval(option(ro, 0), (n) => getComputedStyle(n).cursor), "auto")
    await page.waitForSelector(`${option(ro, 0)} code.local-file-code[data-local-path='/fixture/cloudflare-ask.md']`)
    await page.waitForSelector(`${option(ro, 0)} a[href='https://github.com/ssalbdivad/ntwine/issues/482']`)
    await mouseClick(page, `${option(ro, 0)} a[href='https://github.com/ssalbdivad/ntwine/issues/482']`)
    assert.equal((await page.evaluate(() => (window as Window & { __anchors?: string[] }).__anchors))?.length, 3)

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

test("the copy button on a code block inside an option copies, and does not pick the option", { skip: !baseUrl, timeout: 60_000 }, async () => {
  const { browser, page, errors } = await launch()
  try {
    await page.goto(`${baseUrl}/question-links-fixture.html`, { waitUntil: "networkidle0" })
    const A = option("[data-case='code']", 0)
    const copyButton = `${A} .md-code-copy`
    await page.waitForSelector(copyButton)
    // Record what reaches the clipboard rather than reading the real one, which headless Chrome gates.
    await page.evaluate(() => {
      const w = window as Window & { __copied?: string[] }
      w.__copied = []
      navigator.clipboard.writeText = async (text: string) => { w.__copied!.push(text) }
    })
    const codeChips = () => page.evaluate(() => (window as Window & { __codeChips?: number[] }).__codeChips ?? [])

    // The glyph only shows on hover, so hover the block first, exactly as a person reaching for it does.
    await page.hover(`${A} .md-code pre`)
    // A hit-test, not a DOM query: the button is always in the markup, and it is on top only if the
    // raised `pre` beside it did not paint over it.
    const onTop = await page.$eval(copyButton, (b) => {
      const r = b.getBoundingClientRect()
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === b
    })
    assert.equal(onTop, true)

    await mouseClick(page, copyButton)
    assert.deepEqual(await page.evaluate(() => (window as Window & { __copied?: string[] }).__copied), ["nub run build && nub run test"])
    assert.equal(await page.$eval(copyButton, (b) => b.classList.contains("is-copied")), true)
    assert.deepEqual(await codeChips(), [])

    // The code itself is still part of the row: a click on it picks the option.
    await page.mouse.click(...await page.$eval(`${A} .md-code pre`, (n) => {
      const r = n.getBoundingClientRect()
      return [r.left + 12, r.top + r.height / 2] as [number, number]
    }))
    assert.deepEqual(await codeChips(), [0])

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
