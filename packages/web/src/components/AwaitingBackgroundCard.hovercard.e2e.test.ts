import assert from "node:assert/strict"
import test from "node:test"

// Opt-in, like every other e2e here: start `vite` in packages/web and point this at its origin.
//   cd packages/web && nubx vite --port 5199 &
//   FRIZZ_AWAITING_HOVERCARD_E2E_URL=http://127.0.0.1:5199 nub --test src/components/AwaitingBackgroundCard.hovercard.e2e.test.ts
const baseUrl = process.env.FRIZZ_AWAITING_HOVERCARD_E2E_URL

// THE PR ROWS OF AN AWAITING CARD OPEN THE SAME HOVERCARD A `#123` IN PROSE DOES (maintainer 2026-08-25:
// "add the PR hover popover to the PRs that are listed in the awaiting block"). The layer is one
// delegated listener over `a[data-gh-ref]` (GithubHovercards), so the whole feature is one attribute on
// the row's anchor plus a render-time `noteGithubRefs` — and both are invisible to a unit test, which is
// why this drives the shipped path: the fixture's real AwaitingBackgroundCard, the real store and batch,
// the real pointer listener, the real anchored card. Only the batch's ANSWER is stubbed, in the fixture.
//
// The row's anchor STRETCHES over the whole row (the row is the link), so the card must open from the
// status column too, not only from the ref's own text.

const FIXTURE = "awaiting-bg-fixture.html?watch=1"
const ROW = '[data-wait-row="acme/app#391"]'
const CARD = "[data-radix-popper-content-wrapper]"

async function openFixture() {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(String(error)))
  await page.setViewport({ width: 1100, height: 800 })
  await page.goto(`${baseUrl}/${FIXTURE}`, { waitUntil: "networkidle0" })
  await page.waitForSelector(`${ROW} a[data-gh-ref]`)
  return { browser, page, pageErrors }
}

type Page = Awaited<ReturnType<typeof openFixture>>["page"]

async function hoverCenterOf(page: Page, selector: string) {
  const el = await page.$(selector)
  assert.ok(el, `nothing matches ${selector}`)
  const box = await el.boundingBox()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.waitForSelector(CARD, { timeout: 5000 })
  await page.waitForFunction(
    (sel) => ((document.querySelector(sel) as HTMLElement)?.innerText ?? "").trim().length > 0,
    { timeout: 5000 },
    CARD,
  )
  return await page.evaluate((sel) => (document.querySelector(sel) as HTMLElement).innerText, CARD)
}

async function away(page: Page) {
  await page.mouse.move(2, 2)
  await page.waitForFunction((sel) => !document.querySelector(sel), { timeout: 5000 }, CARD)
}

test("every watched PR row carries the hovercard key, and the refs are asked for at render", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { browser, page, pageErrors } = await openFixture()
  try {
    const refs = await page.$$eval("[data-wait-kind=github] a[data-gh-ref]", (as) => as.map((a) => a.getAttribute("data-gh-ref")))
    assert.deepEqual(refs, ["acme/app#391", "acme/app#392", "acme/app#393", "acme/app#394"])
    // Pre-noted: the card is already in the store before any pointer arrives, so the FIRST hover paints
    // the PR rather than a blank panel. Proven by the hover below opening straight onto the title.
    assert.equal(await page.$(CARD), null, "no card may be open before a hover")
    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
})

test("pointing at a watched PR opens its card; the whole row is the target; pointing away closes it", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { browser, page, pageErrors } = await openFixture()
  try {
    const onRef = await hoverCenterOf(page, `${ROW} a[data-gh-ref]`)
    assert.match(onRef, /resolver: key the cache on the normalized id/)
    assert.match(onRef, /opened this pull request/)
    await away(page)
    // The status column sits under the anchor's stretched overlay, so it summons the card too.
    const onStatus = await hoverCenterOf(page, `${ROW} [data-wait-status]`)
    assert.match(onStatus, /normalized id/)
    await away(page)
    // A ref the stub does not know renders the miss, not a stale neighbour's card.
    const missing = await hoverCenterOf(page, '[data-wait-row="acme/app#392"] a[data-gh-ref]')
    assert.match(missing, /Not found on GitHub/)
    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
})
