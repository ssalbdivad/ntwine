import assert from "node:assert/strict"
import test, { after, before } from "node:test"

// A LONG QUEUE BUILDS AND LAYS OUT ONLY THE CARDS NEAR THE SCREEN (lib/cardVisibility.ts), against the
// real AllQueuesCard on queue-card-states-fixture.html?case=many — 60 cards, every third one long enough to
// clamp, only the network stubbed. What it pins:
//
//   1  before anything is idle, the cards on screen are built and drawn unclipped (`data-near`, so no
//      paint containment), and the cards far below are stand-ins — what took a 244-card load from one 7s
//      task to ~1.3s (2026-10-02);
//   2  left alone, every card gets built, and every far card is SKIPPED at exactly the height it really
//      has — a skipped card sized by a stale guess is a jump waiting for the reader to scroll to it;
//   3  a far card's clamp is measured once it is drawn, not at mount, and still clamps ("Show more");
//   4  a board delta re-renders NO card: every card's reply box and model strip used to read the board's
//      threads, so each delta re-rendered every card on the page;
//   5  a JUMP past the observer's margin (a scrollbar drag, End) paints real cards in its first frame, not
//      stand-ins — the observer reports a frame late, so the cards are built from the scroll event itself;
//   6  the card being read holds still when a card above it changes height in a frame that also scrolls —
//      the viewport lock re-took its anchor before undoing such a move, and cards building near the screen
//      made it common;
//   7  typing `@` into a card's reply box still offers the board's threads — the box subscribes to them only
//      once its draft holds an `@`, so this pins that the switch turns on;
//   8  after the column changes width, every skipped card is re-drawn at its new height — a width change
//      mutates nothing, and each skipped card kept the height it had at the old width — a few at a time;
//   9  cards moved on screen by a filter (no scroll, no mount) are real cards in the first frame, and cards
//      mounted again after it start at the height they were last drawn at, not the guess;
//  10  `k` landing on a card whose handoff is still loading presses its "Show more" once it appears;
//  11  a jump to the end before the page is built stays at the end — the cards it lands on and the cards
//      above them change height as they are built, and each change used to push the last card off screen;
//  12  so does the End KEY, a smooth scroll whose target the browser fixed before those cards were built, and
//      so does a jump made before the handoffs are fetched, whose cards grow when they land;
//  13  End takes the page's own glide while cards are unbuilt, having built the end of the page first — the
//      browser's End aims at the end the page had when it started, and in a headed browser it animates
//      past cards that build at their real height on the way (headless jumps at once, which test 12 cannot
//      tell apart, so this pins the handler itself).
//
// Skipped unless a Vite URL serving the fixtures is provided: `pnpm run test:e2e` sets it, or start
// `vite` in packages/web and set NTWINE_QUEUE_CARD_VISIBILITY_E2E_URL to its origin.
const baseUrl = process.env.NTWINE_QUEUE_CARD_VISIBILITY_E2E_URL

type PuppeteerModule = typeof import("puppeteer")
type Browser = Awaited<ReturnType<PuppeteerModule["launch"]>>
type Page = Awaited<ReturnType<Browser["newPage"]>>

let browser: Browser | undefined
let page: Page | undefined
const errors: string[] = []
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const URL_MANY = (extra = "", n = 60) => `${baseUrl}/queue-card-states-fixture.html?case=many&n=${n}${extra}`

before(async () => {
  if (!baseUrl) return
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  browser = await launchHeadless()
  page = await browser.newPage()
  page.setDefaultTimeout(60_000)
  await page.setViewport({ width: 900, height: 1000, deviceScaleFactor: 1 })
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  // EVERY TEST STARTS AT THE TOP. The `many` page holds the viewport lock, which writes down the card being
  // read as a page goes and puts the next load of the same address back on it (lib/viewportLock.ts, "A
  // RELOAD") — so one test's scroll would become the next test's starting point.
  await page.evaluateOnNewDocument(() => sessionStorage.removeItem("ntwine.queueReading.v1"))
  // WARM A COLD VITE before any timed step (its first load optimizes dependencies and reloads the page).
  await page.goto(URL_MANY(), { waitUntil: "networkidle0", timeout: 120_000 })
  await page.waitForSelector("[data-xq-card]", { timeout: 120_000 })
})

after(async () => { await browser?.close() })

const allBuilt = () => page!.waitForFunction(() => document.querySelectorAll("[data-xq-card]").length === 60 && !document.querySelector("[data-xq-card-stand-in]"), { timeout: 60_000 })
// Every card the browser is skipping, asked the question test 2 asks: is that its real height?
const skippedOff = () => page!.evaluate(() => {
  const off: { index: number; skipped: number; real: number }[] = []
  let far = 0
  for (const [index, slot] of [...document.querySelectorAll<HTMLElement>("[data-xq-card]")].entries()) {
    if (slot.hasAttribute("data-near")) continue
    far++
    const skipped = slot.getBoundingClientRect().height
    slot.setAttribute("data-near", "")
    const real = slot.getBoundingClientRect().height
    slot.removeAttribute("data-near")
    if (Math.abs(real - skipped) > 1) off.push({ index, skipped, real })
  }
  return { far, off }
})
// SETTLED: every card built, and for a second and a half no card has committed and no slot has been drawn
// or let go (a `data-near` flip) — the idle steps re-draw a skipped card whose handoff landed after it was
// first drawn, and those run after the builds. A condition the page reaches by design, not a retry.
async function settled(): Promise<void> {
  await allBuilt()
  await page!.evaluate(() => {
    const w = window as unknown as { __flips?: number }
    w.__flips = 0
    new MutationObserver((records) => { w.__flips! += records.length }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-near"] })
  })
  await page!.waitForFunction(() => {
    const w = window as unknown as { __renders: Record<string, number>; __flips: number; __quiet?: { sig: string; at: number } }
    const sig = `${Object.values(w.__renders).reduce((a, b) => a + b, 0)}/${w.__flips}`
    if (!w.__quiet || w.__quiet.sig !== sig) w.__quiet = { sig, at: performance.now() }
    return performance.now() - w.__quiet.at > 1_500
  }, { polling: 100, timeout: 60_000 })
}

test("before the page is idle, only the cards near the screen are built, and those are drawn unclipped", { skip: !baseUrl, timeout: 120_000 }, async () => {
  // Read in the page on the first frame the cards exist: idle steps build the rest soon after.
  await page!.evaluateOnNewDocument(() => {
    const w = window as unknown as { __firstFrame?: unknown }
    const look = () => {
      const slots = [...document.querySelectorAll<HTMLElement>("[data-xq-card]")]
      if (slots.length === 0) return requestAnimationFrame(look)
      const onScreen = slots.filter((slot) => { const r = slot.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight })
      w.__firstFrame = {
        slots: slots.length,
        standIns: slots.filter((slot) => slot.querySelector("[data-xq-card-stand-in]")).length,
        onScreen: onScreen.length,
        onScreenBuilt: onScreen.filter((slot) => slot.querySelector("[data-xq-card-root]")).length,
        onScreenNear: onScreen.filter((slot) => slot.hasAttribute("data-near")).length,
        onScreenContentVisibility: [...new Set(onScreen.map((slot) => getComputedStyle(slot).contentVisibility))],
        lastContentVisibility: getComputedStyle(slots.at(-1)!).contentVisibility,
      }
    }
    requestAnimationFrame(look)
  })
  await page!.goto(URL_MANY(), { waitUntil: "load" })
  await page!.waitForFunction(() => (window as unknown as { __firstFrame?: unknown }).__firstFrame !== undefined)
  const first = await page!.evaluate(() => (window as unknown as { __firstFrame: Record<string, unknown> }).__firstFrame)
  assert.equal(first.slots, 60)
  assert.ok((first.onScreen as number) > 0)
  assert.equal(first.onScreenBuilt, first.onScreen, `every card on screen is built at the first frame: ${JSON.stringify(first)}`)
  assert.equal(first.onScreenNear, first.onScreen, `and near, so nothing it draws is clipped: ${JSON.stringify(first)}`)
  assert.deepEqual(first.onScreenContentVisibility, ["visible"])
  assert.ok((first.standIns as number) >= 40, `the cards far below are stand-ins, not built: ${JSON.stringify(first)}`)
  assert.equal(first.lastContentVisibility, "auto")
})

test("left alone, every card is built, and every skipped card is the height it really has", { skip: !baseUrl, timeout: 120_000 }, async () => {
  await page!.goto(URL_MANY(), { waitUntil: "load" })
  await settled()
  const heights = await page!.evaluate(() => {
    const out: { index: number; skipped: number; real: number }[] = []
    const slots = [...document.querySelectorAll<HTMLElement>("[data-xq-card]")]
    let far = 0
    let distant = 0
    let distantRendered = 0
    for (const [index, slot] of slots.entries()) {
      if (slot.hasAttribute("data-near")) continue
      far++
      // Skipped by the browser, not merely unmarked: its content is not rendered. Asked only of a card three
      // viewports down, past the browser's own margin for drawing `auto` content early.
      if (slot.getBoundingClientRect().top > 3 * innerHeight) {
        distant++
        if (slot.firstElementChild!.checkVisibility({ contentVisibilityAuto: true })) distantRendered++
      }
      const skipped = slot.getBoundingClientRect().height
      slot.setAttribute("data-near", "")
      const real = slot.getBoundingClientRect().height
      slot.removeAttribute("data-near")
      if (Math.abs(real - skipped) > 1) out.push({ index, skipped, real })
    }
    return { far, distant, distantRendered, off: out }
  })
  assert.ok(heights.far >= 40, `most cards are far: ${heights.far}`)
  assert.ok(heights.distant >= 40, `most are well past the screen: ${heights.distant}`)
  assert.equal(heights.distantRendered, 0, "a card three viewports down that the browser still renders")
  assert.deepEqual(heights.off, [], "a skipped card sized by anything but its real height")
})

test("a far card's clamp is measured once it is drawn, and it still clamps", { skip: !baseUrl, timeout: 120_000 }, async () => {
  await page!.goto(URL_MANY(), { waitUntil: "load" })
  await settled()
  const longCards = await page!.evaluate(() => {
    const slots = [...document.querySelectorAll<HTMLElement>("[data-xq-card]")]
    // Every third card carries the long handoff (the fixture's `many` case); check the far ones.
    return slots.filter((_, index) => index % 3 === 0).slice(5).map((slot) => ({
      key: slot.dataset.xqCard,
      showMore: Boolean(slot.querySelector("[data-xq-show-more]")),
      near: slot.hasAttribute("data-near"),
    }))
  })
  assert.ok(longCards.length >= 10)
  assert.ok(longCards.some((card) => !card.near), "some of them are far (skipped)")
  assert.deepEqual(longCards.filter((card) => !card.showMore), [], "a long handoff with no Show more")
})

test("a board delta re-renders no card", { skip: !baseUrl, timeout: 120_000 }, async () => {
  await page!.goto(URL_MANY(), { waitUntil: "load" })
  await settled()
  // CLEAR OF THE SHARED CLOCK: lib/liveClock.ts re-renders every card's "2m ago" on a 30s edge of the wall
  // clock, which a Profiler counts like any other commit — 60 cards "re-rendered" by no delta at all, about
  // one run in 30. So the deltas and the second after them sit between two edges.
  await page!.waitForFunction(() => { const into = Date.now() % 30_000; return into > 1_000 && into < 27_000 }, { polling: 100, timeout: 10_000 })
  const before = await page!.evaluate(() => ({ ...(window as unknown as { __renders: Record<string, number> }).__renders }))
  await page!.evaluate(() => {
    const w = window as unknown as { __boardDelta: () => void }
    w.__boardDelta()
    w.__boardDelta()
    w.__boardDelta()
  })
  await sleep(1_000)
  const after = await page!.evaluate(() => ({ ...(window as unknown as { __renders: Record<string, number> }).__renders }))
  const rerendered = Object.keys(after).filter((key) => after[key] !== before[key])
  assert.deepEqual(rerendered, [], `${rerendered.length} cards re-rendered on three board deltas`)
})

test("a jump to the bottom before the page is built paints real cards in its first frame", { skip: !baseUrl, timeout: 120_000 }, async () => {
  // Jump from a TASK, as input does (a scrollbar drag, End), on the first frame the cards exist — while every
  // card below the first screen is still a stand-in — and read the page in the NEXT animation frame. The
  // jump's scroll event is dispatched in that frame's rendering step before its animation frames; what the
  // frame holds at that point is what it lays out and paints, and the observer cannot change it: its
  // callbacks are delivered as tasks after the frame.
  const script = await page!.evaluateOnNewDocument(() => {
    const w = window as unknown as { __jump?: unknown }
    const look = () => {
      const slots = [...document.querySelectorAll<HTMLElement>("[data-xq-card]")]
      if (slots.length === 0) return requestAnimationFrame(look)
      setTimeout(() => {
        const standInsBefore = document.querySelectorAll("[data-xq-card-stand-in]").length
        scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" as ScrollBehavior })
        requestAnimationFrame(() => {
          const onScreen = slots.filter((slot) => { const r = slot.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight })
          w.__jump = {
            standInsBefore,
            scrollY: scrollY,
            onScreen: onScreen.length,
            standInsOnScreen: onScreen.filter((slot) => slot.querySelector("[data-xq-card-stand-in]")).length,
            nearOnScreen: onScreen.filter((slot) => slot.hasAttribute("data-near")).length,
          }
        })
      }, 0)
    }
    requestAnimationFrame(look)
  })
  await page!.goto(URL_MANY(), { waitUntil: "load" })
  await page!.waitForFunction(() => (window as unknown as { __jump?: unknown }).__jump !== undefined)
  const jump = await page!.evaluate(() => (window as unknown as { __jump: Record<string, number> }).__jump)
  await page!.removeScriptToEvaluateOnNewDocument(script.identifier)
  assert.ok(jump.standInsBefore >= 40, `the jump happened before the page was built: ${JSON.stringify(jump)}`)
  assert.ok(jump.scrollY > 10_000 && jump.onScreen > 0, `it landed far down the queue: ${JSON.stringify(jump)}`)
  assert.equal(jump.standInsOnScreen, 0, `a stand-in on screen in the jump's first frame: ${JSON.stringify(jump)}`)
  assert.equal(jump.nearOnScreen, jump.onScreen, `and every card on screen is drawn unclipped: ${JSON.stringify(jump)}`)
})

test("the card being read holds still when a card above it grows in a frame that scrolls", { skip: !baseUrl, timeout: 120_000 }, async () => {
  await page!.goto(URL_MANY(), { waitUntil: "load" })
  await settled()
  const result = await page!.evaluate(async () => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
    scrollTo({ top: Math.round((document.documentElement.scrollHeight - innerHeight) / 2), behavior: "instant" as ScrollBehavior })
    for (let i = 0; i < 5; i++) await frame()
    const slots = [...document.querySelectorAll<HTMLElement>("[data-xq-card]")]
    const line = innerHeight / 3
    const index = slots.findIndex((slot) => { const r = slot.getBoundingClientRect(); return r.top <= line && r.bottom >= line })
    const reading = slots[index]!
    const above = slots[index - 1]!
    const before = reading.getBoundingClientRect().top
    // In ONE task: a 1px scroll (its event, and the lock's re-take, land in the next frame) and a card above
    // the reader growing by 300px, as a card built or a handoff landing above the screen does.
    scrollBy({ top: 1, behavior: "instant" as ScrollBehavior })
    const grow = document.createElement("div")
    grow.style.height = "300px"
    above.querySelector("[data-xq-card-root]")!.appendChild(grow)
    for (let i = 0; i < 5; i++) await frame()
    return { index, before, after: reading.getBoundingClientRect().top }
  })
  assert.ok(result.index > 0, `a card is under the reading line, with one above it: ${JSON.stringify(result)}`)
  assert.ok(Math.abs(result.after - (result.before - 1)) <= 1, `the card being read moved: ${JSON.stringify(result)}`)
})

test("typing @ in a card's reply box offers the board's threads", { skip: !baseUrl, timeout: 120_000 }, async () => {
  await page!.goto(URL_MANY(), { waitUntil: "load" })
  const box = '[data-xq-card="fixture-card/card-1"] textarea'
  await page!.waitForSelector(box)
  await page!.click(box)
  assert.equal(await page!.$("[data-mention-menu]"), null, "no menu before the `@`")
  await page!.keyboard.type("@card-")
  await page!.waitForSelector("[data-mention-menu]", { timeout: 10_000 })
  const offered = await page!.$$eval("[data-mention-menu] [role=option]", (options) => options.map((o) => o.textContent ?? ""))
  assert.ok(offered.some((text) => text.includes("card-2")), `the menu offers the board's threads: ${JSON.stringify(offered.slice(0, 5))}`)
  assert.deepEqual(errors, [])
})

test("after the column changes width, every skipped card is re-drawn at its new height", { skip: !baseUrl, timeout: 120_000 }, async () => {
  // Short cards with a ~300-character handoff (`mid=1`), which re-wraps at the new width; the long ones clamp.
  await page!.goto(URL_MANY("&mid=1"), { waitUntil: "load" })
  await settled()
  assert.deepEqual((await skippedOff()).off, [], "the page was right before the width changed")
  // A FEW AT A TIME: every built card is due a re-draw at once, and a step that drew them all handed the next
  // frame the whole page to lay out (2.8s on the 243-card mirror). Counted on every frame of the re-draw.
  await page!.evaluate(() => {
    const w = window as unknown as { __mostNear: number }
    w.__mostNear = 0
    const t0 = performance.now()
    const count = () => {
      w.__mostNear = Math.max(w.__mostNear, document.querySelectorAll("[data-near]").length)
      if (performance.now() - t0 < 5_000) requestAnimationFrame(count)
    }
    document.querySelector<HTMLElement>("[data-fixture-queue]")!.style.width = "420px"
    requestAnimationFrame(count)
  })
  await settled()
  const mostNear = await page!.evaluate(() => (window as unknown as { __mostNear: number }).__mostNear)
  assert.ok(mostNear <= 20, `${mostNear} of 60 cards drawn at once while the page re-drew them`)
  const after = await skippedOff()
  assert.ok(after.far >= 40, `most cards are still skipped: ${after.far}`)
  assert.deepEqual(after.off, [], "a skipped card still the height it had at the old width")
})

test("cards a filter moves on screen are real in the first frame, and cards mounted again start at their drawn height", { skip: !baseUrl, timeout: 120_000 }, async () => {
  // FIRST FRAME: on the first frame the cards exist, every card from 40 on is a stand-in far below. A filter
  // (no scroll, no mount) brings them to the top; read the first animation frame after the commit that did.
  const script = await page!.evaluateOnNewDocument(() => {
    const w = window as unknown as { __filtered?: unknown; __filter: (pattern: string | null) => void }
    const look = () => {
      if (document.querySelectorAll("[data-xq-card]").length !== 60) return requestAnimationFrame(look)
      setTimeout(() => {
        const standInsBefore = document.querySelectorAll("[data-xq-card-stand-in]").length
        w.__filter("^card-[45]\\d$")
        const wait = () => {
          const slots = [...document.querySelectorAll<HTMLElement>("[data-xq-card]")]
          if (slots.length !== 20) return requestAnimationFrame(wait)
          const onScreen = slots.filter((slot) => { const r = slot.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight })
          w.__filtered = {
            standInsBefore,
            onScreen: onScreen.length,
            standInsOnScreen: onScreen.filter((slot) => slot.querySelector("[data-xq-card-stand-in]")).length,
          }
        }
        requestAnimationFrame(wait)
      }, 0)
    }
    requestAnimationFrame(look)
  })
  await page!.goto(URL_MANY(), { waitUntil: "load" })
  await page!.waitForFunction(() => (window as unknown as { __filtered?: unknown }).__filtered !== undefined)
  const filtered = await page!.evaluate(() => (window as unknown as { __filtered: Record<string, number> }).__filtered)
  await page!.removeScriptToEvaluateOnNewDocument(script.identifier)
  assert.ok(filtered.standInsBefore >= 40, `the filter ran before the page was built: ${JSON.stringify(filtered)}`)
  assert.ok(filtered.onScreen > 0, `the filtered cards came on screen: ${JSON.stringify(filtered)}`)
  assert.equal(filtered.standInsOnScreen, 0, `a stand-in on screen in the filter's first frame: ${JSON.stringify(filtered)}`)

  // MOUNTED AGAIN: a built page filtered down to its last ten and back. The forty cards that come back are
  // stand-ins again (building them all at once is the mount this module exists to avoid), but each at the
  // height it was last drawn at, so the page is as tall as it was the moment they mount.
  await page!.goto(URL_MANY(), { waitUntil: "load" })
  await settled()
  const roundTrip = await page!.evaluate(async () => {
    const w = window as unknown as { __filter: (pattern: string | null) => void }
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
    const height = document.documentElement.scrollHeight
    w.__filter("^card-5\\d$")
    while (document.querySelectorAll("[data-xq-card]").length !== 10) await frame()
    await frame()
    w.__filter(null)
    while (document.querySelectorAll("[data-xq-card]").length !== 60) await frame()
    return { height, again: document.documentElement.scrollHeight, standIns: document.querySelectorAll("[data-xq-card-stand-in]").length }
  })
  assert.ok(roundTrip.standIns >= 30, `the cards mounted again are stand-ins: ${JSON.stringify(roundTrip)}`)
  assert.ok(Math.abs(roundTrip.again - roundTrip.height) <= 2, `the page changed height when the cards came back: ${JSON.stringify(roundTrip)}`)
})

test("`k` landing on a card whose handoff is still loading opens its Show more once it appears", { skip: !baseUrl, timeout: 120_000 }, async () => {
  // Handoffs answer 800ms late, so the target's is still on its way when `k`, wrapping from the first card,
  // lands on the last — card-57 of 58, a long one (every third card clamps). The key goes through the real
  // keyboard runtime, onto the fixture's cursor, which lands a card as AllQueues' does.
  await page!.goto(URL_MANY("&handoffDelay=800", 58), { waitUntil: "load" })
  await page!.waitForSelector("[data-xq-card-root]")
  await page!.keyboard.press("k")
  const landings = await page!.evaluate(() => (window as unknown as { __landings: unknown[] }).__landings)
  assert.deepEqual(landings, [{ key: "fixture-card/card-57", hadShowMore: false }], "the key landed on the last card before it had a Show more")
  const toggle = '[data-xq-card="fixture-card/card-57"] [data-xq-show-more]'
  await page!.waitForSelector(toggle, { timeout: 10_000 })
  // Its arrival is pressed in the microtask after the commit that drew it; a frame is ample.
  await page!.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))))
  assert.equal(await page!.$eval(toggle, (button) => button.getAttribute("aria-expanded")), "true", "the landed card stayed shut")
})

test("a jump to the end before the page is built stays at the end", { skip: !baseUrl, timeout: 120_000 }, async () => {
  // Three things moved the end away from a jump to it, each below the card the viewport lock holds at its
  // reading line: the cards End lands on built at their real height instead of the 540px guess (put back at
  // the end in the jump's own scroll event); a card above built SHORTER, whose clamp of the offset the lock
  // undid a second time; and a handoff landing a round trip after its card was built (fetched ahead of the
  // build now; handoffs here answer 150ms late, and End waits for them to have been fetched). 120 cards, so the
  // handoffs are all fetched long before the cards are all built, however fast the box builds them.
  await page!.goto(URL_MANY("&handoffDelay=150", 120), { waitUntil: "load" })
  await page!.waitForSelector("[data-xq-card-root]")
  // The handoffs are fetched four at a time from the first idle moment: 120 × 150ms / 4 ≈ 4.5s. The end of the
  // page is still stand-ins by then (building is far slower), which is the case End has to get right.
  await page!.waitForFunction(() => (window as unknown as { __rpc: { calls: { path: string }[] } }).__rpc.calls.filter((call) => call.path.endsWith("/threadHandoff")).length >= 120, { polling: 100, timeout: 30_000 })
  // The last of them answers 150ms after it was asked.
  await sleep(400)
  const atEnd = await page!.evaluate(async () => {
    const standIns = document.querySelectorAll("[data-xq-card-stand-in]").length
    scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" as ScrollBehavior })
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    const last = [...document.querySelectorAll<HTMLElement>("[data-xq-card]")].at(-1)!.getBoundingClientRect()
    return { standIns, gapBelow: Math.round(document.documentElement.scrollHeight - innerHeight - scrollY), lastBottom: Math.round(last.bottom), viewport: innerHeight }
  })
  assert.ok(atEnd.standIns >= 10, `every handoff was fetched while most of the page was unbuilt (ahead of the build), and End came then: ${JSON.stringify(atEnd)}`)
  assert.ok(atEnd.gapBelow <= 2, `End no longer shows the end: ${JSON.stringify(atEnd)}`)
  assert.ok(atEnd.lastBottom <= atEnd.viewport + 2, `the last card is pushed off screen: ${JSON.stringify(atEnd)}`)
})

test("the End key before the page is built, and before the handoffs are fetched, lands on the end and stays", { skip: !baseUrl, timeout: 120_000 }, async () => {
  // Handoffs answer 600ms late and End comes at once, so the cards at the end of the page are built with their
  // handoffs still on the way: each grows a round trip after it was drawn. And the key is the browser's End,
  // a smooth scroll aimed at the end the page had when it started.
  await page!.goto(URL_MANY("&handoffDelay=600"), { waitUntil: "load" })
  await page!.waitForSelector("[data-xq-card-root]")
  const standIns = await page!.evaluate(() => document.querySelectorAll("[data-xq-card-stand-in]").length)
  await page!.mouse.click(880, 500)
  await page!.keyboard.press("End")
  const read = () => page!.evaluate(() => {
    const last = document.querySelectorAll<HTMLElement>("[data-xq-card]")[59]!.getBoundingClientRect()
    return { gapBelow: Math.round(document.documentElement.scrollHeight - innerHeight - scrollY), lastBottom: Math.round(last.bottom) }
  })
  await sleep(2_500)
  const landed = await read()
  await sleep(2_000)
  const later = await read()
  const result = JSON.stringify({ standIns, landed, later })
  assert.ok(standIns >= 40, `End came before the page was built: ${result}`)
  for (const at of [landed, later]) {
    assert.ok(at.gapBelow <= 2, `End does not show the end: ${result}`)
    assert.ok(at.lastBottom <= 1_000 + 2, `the last card is off screen: ${result}`)
  }
})

test("End builds the end of the page and takes the page's glide while cards are unbuilt", { skip: !baseUrl, timeout: 120_000 }, async () => {
  await page!.goto(URL_MANY(), { waitUntil: "load" })
  await page!.waitForSelector("[data-xq-card-root]")
  const pressed = await page!.evaluate(() => {
    const slots = [...document.querySelectorAll<HTMLElement>("[data-xq-card]")]
    const lastStandInsBefore = slots.slice(-2).filter((slot) => slot.querySelector("[data-xq-card-stand-in]")).length
    // Dispatched, not typed: a synthetic key has no default action, so whatever moves the page is the handler.
    const event = new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })
    document.body.dispatchEvent(event)
    return { lastStandInsBefore, prevented: event.defaultPrevented, lastStandInsAfter: slots.slice(-2).filter((slot) => slot.querySelector("[data-xq-card-stand-in]")).length }
  })
  assert.deepEqual(pressed, { lastStandInsBefore: 2, prevented: true, lastStandInsAfter: 0 }, "End built the last cards and took the scroll over")
  await page!.waitForFunction(() => Math.abs(document.documentElement.scrollHeight - innerHeight - scrollY) <= 2, { polling: 100, timeout: 10_000 })
  await sleep(1_500)
  const gap = await page!.evaluate(() => Math.round(document.documentElement.scrollHeight - innerHeight - scrollY))
  assert.ok(gap <= 2, `the glide left the end: ${gap}px below`)
})
