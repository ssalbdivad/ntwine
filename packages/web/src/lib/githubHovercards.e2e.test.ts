import assert from "node:assert/strict"
import test from "node:test"

// Opt-in, like every other e2e here: start `vite` in packages/web and point this at its origin.
//   cd packages/web && nubx vite --port 5199 &
//   FRIZZ_GITHUB_HOVERCARD_E2E_URL=http://127.0.0.1:5199 nub --test src/lib/githubHovercards.e2e.test.ts
const baseUrl = process.env.FRIZZ_GITHUB_HOVERCARD_E2E_URL

// githubHovercards.test.ts drives the two pure seams (the URL → key rule, the harvest). This drives
// the SHIPPED PATH in a real browser: real markdown through useMarkdownHtml, the sanitizer's
// `data-gh-ref` stamp, the batched request lib/githubHovercards.ts builds, the store, the delegated
// pointer listener, and the anchored card. Only `fetch` is stubbed (in the fixture itself), so a
// regression anywhere between the markdown and the picture fails here.
//
// THE ASSERTION THAT MATTERS MOST IS THE BATCH ONE. The whole design is "one query, then no queries":
// a per-anchor fetch would still render a card and still pass every other check here, while costing
// the reader a network round trip on every hover — which is the thing this feature exists to avoid.

const FIXTURE = "github-hovercard-fixture.html"

async function openFixture(query = "") {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(String(error)))
  await page.setViewport({ width: 1200, height: 900 })
  await page.goto(`${baseUrl}/${FIXTURE}${query}`, { waitUntil: "networkidle0" })
  await page.waitForSelector("[data-live-prose] a[data-gh-ref]")
  return { browser, page, pageErrors }
}

async function hover(page: Awaited<ReturnType<typeof openFixture>>["page"], ref: string) {
  const anchor = await page.$(`[data-live-prose] a[data-gh-ref="${ref}"]`)
  assert.ok(anchor, `no anchor for ${ref}`)
  // The live prose sits below the gallery, so it starts off-screen: without this the pointer is moved
  // to a viewport coordinate the anchor does not occupy and nothing opens. Scrolling also CLOSES any
  // card still open (the anchor rect is captured in viewport coordinates), so it must happen first.
  // Scrolled through `page.evaluate` with the handle as an ARGUMENT rather than through the handle's
  // own `anchor.scrollIntoView()`. That convenience method resolves the element in puppeteer's isolated
  // world, and against this page it throws `Protocol error (Runtime.callFunctionOn): Argument should
  // belong to the same JavaScript world as target object` — the anchor comes back from a main-world
  // query, and puppeteer 25 stopped bridging the two for it. Passing the handle to an evaluate keeps
  // both sides in one world, and does exactly the same thing to the page.
  await page.evaluate((el) => { el.scrollIntoView() }, anchor)
  await new Promise((r) => setTimeout(r, 200))
  const box = await anchor.boundingBox()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.waitForSelector("[data-radix-popper-content-wrapper]", { timeout: 5000 })
  // Radix mounts the panel before its content settles; wait for the card (or the miss) to paint.
  await page.waitForFunction(
    () => (document.querySelector("[data-radix-popper-content-wrapper]") as HTMLElement)?.innerText.trim().length > 0,
    { timeout: 5000 },
  )
  return await page.evaluate(() => {
    const wrapper = document.querySelector("[data-radix-popper-content-wrapper]") as HTMLElement
    return { text: wrapper.innerText, rect: wrapper.firstElementChild!.getBoundingClientRect().toJSON() }
  })
}

async function away(page: Awaited<ReturnType<typeof openFixture>>["page"]) {
  await page.mouse.move(2, 2)
  await page.waitForFunction(() => !document.querySelector("[data-radix-popper-content-wrapper]"), { timeout: 5000 })
}

test("every reference on the page is fetched in ONE batch, before any hover", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { browser, page, pageErrors } = await openFixture()
  try {
    const requests = await page.evaluate(() => (window as unknown as { __ghRefRequests?: string[][] }).__ghRefRequests ?? [])
    assert.equal(requests.length, 1, `expected one batched request, got ${JSON.stringify(requests)}`)
    // Five distinct references in the prose; the one inside a code span is the author's literal bytes
    // and must never have become an anchor, so it must not be asked about either.
    assert.deepEqual(
      [...requests[0]].sort(),
      ["nubjs/nub#4242", "nubjs/nub#660", "nubjs/nub#690", "nubjs/nub#705", "nubjs/nub@92ed4cc"],
    )
    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
})

test("pointing at a reference opens its card, and pointing away closes it", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { browser, page, pageErrors } = await openFixture()
  try {
    const issue = await hover(page, "nubjs/nub#660")
    assert.match(issue.text, /A failing optionalDependency build fails/)
    assert.match(issue.text, /#660/)
    assert.match(issue.text, /\bOpen\b/)
    assert.match(issue.text, /\bbug\b/, "the label belongs on the card")
    await away(page)

    // A merged PR and a commit are different cards off the same machinery.
    const merged = await hover(page, "nubjs/nub#690")
    assert.match(merged.text, /\bMerged\b/)
    assert.match(merged.text, /\+76/)
    await away(page)

    const commit = await hover(page, "nubjs/nub@92ed4cc")
    assert.match(commit.text, /an optional dependency's build failure/)
    assert.match(commit.text, /\+254/)
    assert.match(commit.text, /committed/)
    await away(page)

    // A reference that resolves to nothing is a real answer, not a blank panel.
    const missing = await hover(page, "nubjs/nub#4242")
    assert.match(missing.text, /Not found on GitHub/)

    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
})

test("hovering a FRESH card costs no further request — the batch already answered", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { browser, page } = await openFixture()
  try {
    await hover(page, "nubjs/nub#660")
    await away(page)
    await hover(page, "nubjs/nub@92ed4cc")
    const requests = await page.evaluate(() => (window as unknown as { __ghRefRequests?: string[][] }).__ghRefRequests ?? [])
    assert.equal(requests.length, 1, `a hover on a fresh card must not fetch; got ${JSON.stringify(requests)}`)
  } finally {
    await browser.close()
  }
})

test("hovering a STALE card revalidates exactly that one reference, without blanking it", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  // `?stale` back-dates the stub's fetch stamp past the client TTL. The point of stale-while-
  // revalidate is that the reader never waits: the cached card must be on screen with its real
  // contents while the refresh is in flight, not replaced by a spinner.
  const { browser, page } = await openFixture("?stale=1")
  try {
    const shown = await hover(page, "nubjs/nub#660")
    assert.match(shown.text, /A failing optionalDependency build fails/, "the cached card must render immediately")
    await page.waitForFunction(
      () => ((window as unknown as { __ghRefRequests?: string[][] }).__ghRefRequests ?? []).length === 2,
      { timeout: 5000 },
    )
    const requests = await page.evaluate(() => (window as unknown as { __ghRefRequests?: string[][] }).__ghRefRequests ?? [])
    assert.deepEqual(requests[1], ["nubjs/nub#660"], "only the reference being read is revalidated")
    const after = await page.evaluate(
      () => (document.querySelector("[data-radix-popper-content-wrapper]") as HTMLElement).innerText,
    )
    assert.match(after, /A failing optionalDependency build fails/, "the card must survive its own refresh")
  } finally {
    await browser.close()
  }
})

test("the card never covers the link it describes, and never leaves the viewport", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { browser, page } = await openFixture()
  try {
    for (const ref of ["nubjs/nub#660", "nubjs/nub#690", "nubjs/nub@92ed4cc"]) {
      const { rect } = await hover(page, ref)
      const anchor = await page.evaluate(
        (sel) => document.querySelector(sel)!.getClientRects()[0].toJSON(),
        `[data-live-prose] a[data-gh-ref="${ref}"]`,
      )
      const overlaps = !(rect.right <= anchor.left || rect.left >= anchor.right || rect.bottom <= anchor.top || rect.top >= anchor.bottom)
      assert.equal(overlaps, false, `${ref}: the card sits on top of its own anchor, so the link is unclickable`)
      const view = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }))
      assert.ok(rect.left >= 0 && rect.top >= 0 && rect.right <= view.w && rect.bottom <= view.h, `${ref}: card escapes the viewport`)
      await away(page)
    }
  } finally {
    await browser.close()
  }
})
