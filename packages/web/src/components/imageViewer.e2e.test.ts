import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import type { Page } from "puppeteer"

// The picture viewer and the file reader, driven by real clicks on the real components and the real
// drawer stack (image-viewer-fixture.tsx). The pictures are REAL screenshots of an ntwine surface, taken
// first and served back through request interception — an <img> load is not a fetch the fixture could
// stub — so the fit/actual-size geometry is measured on the shape of picture a worker actually sends.
//
//   NTWINE_IMAGE_VIEWER_E2E_URL=http://127.0.0.1:<vite port> nub --test <this file>
//   NTWINE_IMAGE_VIEWER_SHOTS=<dir> also writes the review screenshots there.
const baseUrl = process.env.NTWINE_IMAGE_VIEWER_E2E_URL
const shots = process.env.NTWINE_IMAGE_VIEWER_SHOTS

type Viewer = { paths: string[]; index: number } | null
type Drawer = { kind: string; path?: string; closing: boolean }

const viewer = (page: Page) => page.evaluate(() => (window as unknown as { __imageViewerFixture: { viewer: () => Viewer } }).__imageViewerFixture.viewer())
const drawers = (page: Page) => page.evaluate(() => (window as unknown as { __imageViewerFixture: { drawers: () => Drawer[] } }).__imageViewerFixture.drawers())
const opened = (page: Page) => page.evaluate(() => (window as unknown as { __imageViewerFixture: { opened: unknown[] } }).__imageViewerFixture.opened)
const headerText = (page: Page) => page.$eval("[data-image-viewer] header", (el) => el.textContent ?? "")

// The picture on show, once it has loaded and been sized — and once a zoom has finished easing in: the
// zoom is a transform with a 180ms transition (lib/viewerGestures.ts), and a rect read mid-ease is neither
// the fit nor the zoom.
async function shown(page: Page) {
  await page.waitForFunction(() => {
    const img = document.querySelector<HTMLImageElement>("[data-image-viewer] img")
    return !!img && img.complete && img.naturalWidth > 0 && getComputedStyle(img).opacity === "1" && img.getAnimations().length === 0
  })
  return page.$eval("[data-image-viewer] img", (img) => {
    const r = img.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height, cursor: getComputedStyle(img).cursor, src: img.getAttribute("src") ?? "", className: img.className }
  })
}

async function closed(page: Page) {
  await page.waitForFunction(() => !document.querySelector("[data-image-viewer]"))
  assert.equal(await viewer(page), null)
}

async function shot(page: Page, name: string) {
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  // Past the 120ms fade, so the capture is the settled viewer rather than a frame of its entrance.
  await new Promise((resolve) => setTimeout(resolve, 250))
  writeFileSync(join(shots, name), await page.screenshot({ type: "png" }))
}

test("a picture opens in ntwine's viewer: fit, actual size, its card's gallery, and Escape that leaves the drawer beneath", { skip: !baseUrl, timeout: 180_000 }, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    // Real pictures first: a 2x capture of a transcript surface in the dark palette (the common agent
    // screenshot — dark UI, the kind whose edges vanish against a dark page), a small crop, a tall one.
    const source = await browser.newPage()
    await source.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }])
    await source.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 })
    await source.goto(`${baseUrl}/fence-card-gallery-fixture.html`, { waitUntil: "networkidle0" })
    const wide = Buffer.from(await source.screenshot({ type: "png" }))
    await source.setViewport({ width: 480, height: 300, deviceScaleFactor: 1 })
    const small = Buffer.from(await source.screenshot({ type: "png" }))
    await source.setViewport({ width: 600, height: 1400, deviceScaleFactor: 1 })
    const tall = Buffer.from(await source.screenshot({ type: "png" }))
    await source.close()
    const pictures: Record<string, Buffer> = {
      "/fixture/shot-wide.png": wide,
      "/fixture/shot-small.png": small,
      "/fixture/md-shot.png": small,
      "/fixture/shot-tall.png": tall,
      "/fixture/other-card.png": small,
      "/fixture/in-doc.png": small,
      "/fixture/linked.png": small,
    }

    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(String(error)))
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()) })
    await page.setRequestInterception(true)
    page.on("request", (request) => {
      const url = new URL(request.url())
      if (url.pathname !== "/_ntwine/local-image") return void request.continue()
      const body = pictures[url.searchParams.get("path") ?? ""]
      void (body ? request.respond({ status: 200, contentType: "image/png", body }) : request.respond({ status: 404, body: "404" }))
    })
    await page.setViewport({ width: 1440, height: 900 })
    await page.goto(`${baseUrl}/image-viewer-fixture.html`, { waitUntil: "networkidle0" })
    const title = await page.title()

    // ── A bare-path picture opens in the viewer, among its card's pictures in reading order ──
    await page.click('img[data-local-path="/fixture/shot-small.png"]')
    const smallShown = await shown(page)
    assert.deepEqual(await viewer(page), {
      paths: ["/fixture/shot-wide.png", "/fixture/shot-small.png", "/fixture/md-shot.png", "/fixture/shot-tall.png"],
      index: 1,
    })
    assert.match(await headerText(page), /shot-small\.png/)
    assert.match(await headerText(page), /480 × 300 · 100%/)
    assert.match(await headerText(page), /2 \/ 4/)
    // Fitting did not shrink it, so it shows at its own size — and it still zooms, to at least 2×, as a
    // gallery's picture does (lib/viewerGestures.ts): a small crop is often the one worth magnifying.
    assert.deepEqual([Math.round(smallShown.width), Math.round(smallShown.height)], [480, 300])
    assert.equal(smallShown.cursor, "zoom-in")
    assert.deepEqual(await opened(page), [], "a picture click never reaches the desktop opener")
    // OVER the page, not instead of it: everything but the header lets the page through a scrim, which
    // is what says a click off the picture goes back to it. Dimmed, not hidden, and not left bare.
    const layers = await page.evaluate(() => {
      const alpha = (el: Element) => {
        const parts = getComputedStyle(el).backgroundColor.match(/\(([^)]*)\)/)?.[1]?.split(/[\s,/]+/).filter(Boolean) ?? []
        return parts.length === 4 ? Number(parts[3]) : parts.length === 3 ? 1 : 0
      }
      return {
        scrim: alpha(document.querySelector("[data-image-viewer-scrim]")!),
        content: alpha(document.querySelector("[data-image-viewer]")!),
        stage: alpha(document.querySelector("[data-image-viewer] [data-viewer-backdrop]")!),
      }
    })
    assert.ok(layers.scrim > 0.3 && layers.scrim < 0.9, `the scrim's alpha is ${layers.scrim}`)
    assert.deepEqual([layers.content, layers.stage], [0, 0], "nothing opaque sits between the scrim and the picture")

    // ── ←/→ step through the card's pictures, and stop at its ends ──
    await page.keyboard.press("ArrowRight")
    await page.keyboard.press("ArrowRight")
    await page.keyboard.press("ArrowRight")
    assert.equal((await viewer(page))?.index, 3)
    assert.match(await headerText(page), /shot-tall\.png/)
    for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowLeft")
    assert.equal((await viewer(page))?.index, 0)

    // ── A 2x capture fits the stage, and a click shows it at actual size under the pointer ──
    const fit = await shown(page)
    // 1440×900 viewport, a 48px header, 24px above and below, and 64px each side to clear the step
    // buttons: a 1312×804 box, which the 2880×1800 picture's height binds — 0.4467 of its pixels.
    assert.ok(Math.abs(fit.height - 804) < 1, `fitted height ${fit.height}`)
    assert.ok(Math.abs(fit.width - 1286.4) < 1, `fitted width ${fit.width}`)
    const clearance = await page.evaluate(() => {
      const img = document.querySelector("[data-image-viewer] img")!.getBoundingClientRect()
      const next = document.querySelector('[data-image-viewer] button[aria-label="Next picture"]')!.getBoundingClientRect()
      return next.left - img.right
    })
    assert.ok(clearance > 0, `the next button overlaps the picture by ${-clearance}px`)
    assert.equal(fit.cursor, "zoom-in")
    assert.match(await headerText(page), /2880 × 1800 · 45%/)
    await shot(page, "viewer-fit-dark.png")
    const at = { x: fit.left + fit.width * 0.3, y: fit.top + fit.height * 0.4 }
    await page.mouse.click(at.x, at.y)
    await page.waitForFunction(() => document.querySelector<HTMLImageElement>("[data-image-viewer] img")!.getBoundingClientRect().width > 2000)
    const actual = await shown(page)
    assert.equal(Math.round(actual.width), 2880)
    // Magnified, the picture offers the stage's drag; a click without one still zooms back out.
    assert.equal(actual.cursor, "grab")
    assert.match(await headerText(page), /2880 × 1800 · 100%/)
    // The clicked point of the picture is still under the pointer.
    assert.ok(Math.abs((at.x - actual.left) / actual.width - 0.3) < 0.002, "x anchor")
    assert.ok(Math.abs((at.y - actual.top) / actual.height - 0.4) < 0.002, "y anchor")
    await shot(page, "viewer-actual-dark.png")
    await page.mouse.click(at.x, at.y)
    await page.waitForFunction(() => document.querySelector<HTMLImageElement>("[data-image-viewer] img")!.getBoundingClientRect().width < 1300)

    // ── The step buttons, then a click on the empty stage, which closes it ──
    await page.click('[data-image-viewer] button[aria-label="Next picture"]')
    assert.equal((await viewer(page))?.index, 1)
    assert.equal(await page.$eval('[data-image-viewer] button[aria-label="Previous picture"]', (b) => (b as HTMLButtonElement).disabled), false)
    await page.mouse.click(720, 60)
    await closed(page)

    // ── Another card's picture opens alone: a gallery never crosses into another thread ──
    await page.click('img[data-local-path="/fixture/other-card.png"]')
    await shown(page)
    assert.deepEqual(await viewer(page), { paths: ["/fixture/other-card.png"], index: 0 })
    assert.doesNotMatch(await headerText(page), /\d \/ \d/)
    assert.equal(await page.$('[data-image-viewer] button[aria-label="Next picture"]'), null)
    await page.keyboard.press("Escape")
    await closed(page)

    // ── A Markdown LINK to a picture opens it too — on its own, since it is text, not a rendered one ──
    await page.click('a[data-local-path="/fixture/linked.png"]')
    await shown(page)
    assert.deepEqual(await viewer(page), { paths: ["/fixture/linked.png"], index: 0 })
    await page.keyboard.press("Escape")
    await closed(page)

    // ── Over a drawer: Escape closes the viewer and ONLY the viewer ──
    await page.click("[data-open-doc]")
    const docPicture = '[data-drawer-layer] .md-body img[data-local-path="/fixture/in-doc.png"]'
    await page.waitForSelector(docPicture)
    // Slid fully in, so the click lands on the picture rather than on the page it is passing over.
    const settled = () => page.waitForFunction(() => {
      const panel = document.querySelector("[data-drawer-layer]")
      return !!panel && panel.getAnimations().length === 0 && panel.getBoundingClientRect().right <= window.innerWidth + 1
    })
    await settled()
    await page.click(docPicture)
    await shown(page)
    assert.deepEqual(await viewer(page), { paths: ["/fixture/in-doc.png"], index: 0 }, "a drawer is its own gallery")
    await page.keyboard.press("Escape")
    await closed(page)
    assert.deepEqual(await drawers(page), [{ kind: "file", path: "/fixture/review.md", closing: false }])
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector("[data-drawer-layer]"))

    // ── An SVG: drawn from its text as a data: image, on the transparency grid, its script inert ──
    await page.click('button[data-local-path="/fixture/diagram.svg"]')
    const svg = await shown(page)
    assert.match(svg.src, /^data:image\/svg\+xml/)
    assert.match(svg.className, /ntwine-transparency-grid/)
    // At the size it declares, not blown up to the stage.
    assert.deepEqual([Math.round(svg.width), Math.round(svg.height)], [240, 120])
    assert.match(await headerText(page), /240 × 120 · 100%/)
    assert.equal(await page.title(), title, "the SVG's own script never ran")
    await shot(page, "viewer-svg-dark.png")
    await page.keyboard.press("Escape")
    await closed(page)
    // One with a viewBox and no size: the 64-unit square its viewBox draws, not Chrome's 300×150 stand-in.
    await page.click('button[data-local-path="/fixture/icon.svg"]')
    const icon = await shown(page)
    assert.deepEqual([Math.round(icon.width), Math.round(icon.height)], [64, 64])
    assert.match(await headerText(page), /64 × 64 · 100%/)
    await page.keyboard.press("Escape")
    await closed(page)

    // ── A text file opens in the reader as highlighted source ──
    await page.click('button[data-local-path="/fixture/run.log"]')
    await page.waitForFunction(() => document.querySelector("[data-drawer-layer] pre.hljs")?.textContent?.includes("listening on http://127.0.0.1:4321"))
    assert.deepEqual(await drawers(page), [{ kind: "file", path: "/fixture/run.log", closing: false }])
    await settled()
    // On a desktop the reader's footer offers the way out to the machine's own opener.
    assert.ok(await page.$("[data-drawer-layer] [data-file-reader-footer] button[aria-label='Open']"), "the desktop reader offers Open")
    await shot(page, "reader-log-dark.png")
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !document.querySelector("[data-drawer-layer]"))

    // ── A PDF is the one thing here ntwine cannot draw: it goes to the desktop opener ──
    await page.click('button[data-local-path="/fixture/contract.pdf"]')
    await page.waitForFunction(() => (window as unknown as { __imageViewerFixture: { opened: unknown[] } }).__imageViewerFixture.opened.length === 1)
    assert.deepEqual(await opened(page), [{ path: "/fixture/contract.pdf" }])
    assert.equal(await viewer(page), null)
    assert.deepEqual(await drawers(page), [])

    // ── "Open" hands a picture to the OS viewer and steps aside ──
    await page.click('img[data-local-path="/fixture/shot-small.png"]')
    await shown(page)
    await page.click('[data-image-viewer] button[aria-label="Open"]')
    await closed(page)
    await page.waitForFunction(() => (window as unknown as { __imageViewerFixture: { opened: unknown[] } }).__imageViewerFixture.opened.length === 2)
    assert.deepEqual((await opened(page))[1], { path: "/fixture/shot-small.png", image: true })

    // ── The same viewer in light mode and on a phone, for the review screenshots ──
    await page.goto(`${baseUrl}/image-viewer-fixture.html?theme=light`, { waitUntil: "networkidle0" })
    await page.click('img[data-local-path="/fixture/shot-wide.png"]')
    await shown(page)
    await shot(page, "viewer-fit-light.png")
    await page.keyboard.press("Escape")
    await closed(page)
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 })
    await page.goto(`${baseUrl}/image-viewer-fixture.html`, { waitUntil: "networkidle0" })
    await page.click('img[data-local-path="/fixture/shot-wide.png"]')
    const phone = await shown(page)
    // 390 wide, less the 24px inset each side: width binds.
    assert.ok(Math.abs(phone.width - 342) < 1, `phone width ${phone.width}`)
    await shot(page, "viewer-fit-phone.png")
    await page.keyboard.press("Escape")
    await closed(page)

    // ── On a phone a file opens in the reader with no Open: that would launch it on the computer ──
    await page.click('button[data-local-path="/fixture/run.log"]')
    await page.waitForFunction(() => document.querySelector("[data-drawer-layer] pre.hljs")?.textContent?.includes("listening on http://127.0.0.1:4321"))
    assert.equal(await page.$("[data-drawer-layer] [data-file-reader-footer]"), null, "no footer on a phone")
    assert.equal(await page.$("[data-drawer-layer] button[aria-label='Open']"), null, "no Open anywhere in the phone's reader")
    assert.deepEqual(await opened(page), [], "and nothing reached the opener")
    await shot(page, "reader-log-phone.png")

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
