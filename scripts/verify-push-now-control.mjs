// THE ↑ ON A QUEUED BUBBLE — the control that replaced the composer's ⚡ "interrupt and send".
//
// The bolt asked for the preemption decision at the wrong moment (before the operator knew how long the
// worker would take) and pictured it as lightning, which meant nothing. The capability now lives on the
// queued bubble itself: hover it, and a ↑ appears to its LEFT, bottom-aligned with the bubble, which
// preempts the turn standing in front of the queue. Nothing is sent — the words are already queued.
//
// Everything here needs a REAL browser and cannot be reached any other way:
//  · the reveal is `group-hover`, so it needs a real pointer over a real element;
//  · the control is ABSOLUTE (`right-full bottom-0`), so its geometry relative to the bubble — bottom
//    edges flush, sitting fully clear to the left, costing the bubble no width — is a layout fact;
//  · the group is the reason the bubble stays lifted while the pointer is on the BUTTON. Keyed off the
//    bubble instead (what it used to be), the button vanishes as you reach for it;
//  · and the ⚡'s absence from the composer is only observable on a thread whose runtime can actually be
//    preempted, which is exactly what this fixture is.
//
// Run against queued-spacing-fixture.html on a plain Vite dev server (fixtures are NOT servable through
// the frizz stack — its Vite runs in middleware mode and falls back to index.html for every unknown path):
//   (cd packages/web && nubx vite --port 5412 --strictPort)
//   nub scripts/verify-push-now-control.mjs --url=http://localhost:5412/queued-spacing-fixture.html
import { mkdirSync } from "node:fs"
import { join } from "node:path"

const args = process.argv.slice(2)
const opt = (k, d) => { const hit = args.find((a) => a.startsWith(`--${k}=`)); return hit ? hit.slice(k.length + 3) : d }
const base = opt("url", "http://localhost:5412/queued-spacing-fixture.html")
const url = `${base}${base.includes("?") ? "&" : "?"}surface=drawer`
const shots = opt("shots")
if (shots) mkdirSync(shots, { recursive: true })

const { launchHeadless } = await import("./lib/headless-browser.mjs")
const browser = await launchHeadless()
let failures = 0
const fail = (msg) => { failures++; console.log(`FAIL  ${msg}`) }
const pass = (msg) => console.log(`PASS  ${msg}`)
const near = (a, b, tol) => Math.abs(a - b) <= tol

// The queued bubbles are the last three user bubbles in the transcript; each one's control is the
// `Send now` button inside its own hover group.
const GROUPS = `[data-frizz-msg] .group`

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 900, height: 800, deviceScaleFactor: 2 })
  const pageErrors = []
  page.on("pageerror", (e) => pageErrors.push(String(e)))
  await page.goto(url, { waitUntil: "networkidle0", timeout: 60000 })
  await page.waitForSelector(`button[aria-label="Send now"]`)

  // 1. AT REST the transcript grows no new chrome: three queued bubbles, three controls, all invisible.
  //    A permanently visible button on every queued send is the thing the opacity-only queued state was
  //    designed to avoid in the first place.
  const rest = await page.$$eval(`button[aria-label="Send now"]`, (els) =>
    els.map((e) => Number(getComputedStyle(e).opacity)))
  if (rest.length !== 3) fail(`expected one control per queued bubble, saw ${rest.length}`)
  else if (rest.some((o) => o !== 0)) fail(`a control is visible at rest: ${JSON.stringify(rest)}`)
  else pass("three queued bubbles, three controls, none visible until hovered")
  if (shots) await page.screenshot({ path: join(shots, "push-now-rest.png") })

  // 2. THE ⚡ IS GONE. This fixture's thread is `runtime: "running"` on a claude backend — precisely the
  //    state that used to grow a lightning-bolt button in the composer rail — so its absence here is a
  //    real control, not a vacuous one. ⌘⏎ still interrupt-sends; only the picture was dropped.
  const bolt = await page.$$eval("[data-thread-composer-box] button", (els) =>
    els.map((e) => e.getAttribute("aria-label")).filter(Boolean))
  if (bolt.some((l) => /interrupt/i.test(l))) fail(`the composer still carries an interrupt button: ${JSON.stringify(bolt)}`)
  else pass(`no interrupt button left in the composer rail (${JSON.stringify(bolt)})`)

  // 3. HOVER THE BUBBLE — its own control appears, and only its own. Each queued bubble owns a separate
  //    group, so a hover must not light up the whole tail.
  const groups = await page.$$(GROUPS)
  const last = groups[groups.length - 1]
  await last.hover()
  await new Promise((r) => setTimeout(r, 250))
  const hovered = await page.$$eval(`button[aria-label="Send now"]`, (els) =>
    els.map((e) => Number(getComputedStyle(e).opacity)))
  if (!near(hovered[2], 1, 0.01)) fail(`hovering the third bubble left its control at opacity ${hovered[2]}`)
  else if (hovered[0] !== 0 || hovered[1] !== 0) fail(`hovering one bubble revealed others: ${JSON.stringify(hovered)}`)
  else pass("hovering a queued bubble reveals its own control, and only its own")
  if (shots) await page.screenshot({ path: join(shots, "push-now-hover.png") })

  // 4. GEOMETRY. Bottom edges flush (the maintainer's call, and where the composer keeps its own send
  //    arrow); the button entirely clear to the LEFT with the app's 8px control gap; and — the reason it
  //    is absolutely positioned — costing the bubble no width, so a queued bubble wraps its text exactly
  //    as the landed one will.
  const geom = await page.evaluate((sel) => {
    const group = [...document.querySelectorAll(sel)].pop()
    const btn = group.querySelector(`button[aria-label="Send now"]`)
    const bubble = group.firstElementChild
    const b = btn.getBoundingClientRect(), u = bubble.getBoundingClientRect(), g = group.getBoundingClientRect()
    return {
      bottomDelta: b.bottom - u.bottom,
      gap: u.left - b.right,
      size: [Math.round(b.width), Math.round(b.height)],
      // The group's own box must be the BUBBLE's box: an absolute child adds no layout, so the button
      // hangs outside it. Equal widths is the proof the bubble gave up nothing.
      groupMatchesBubble: Math.round(g.width) === Math.round(u.width) && Math.round(g.left) === Math.round(u.left),
      overlaps: b.right > u.left,
    }
  }, GROUPS)
  if (!near(geom.bottomDelta, 0, 1)) fail(`control is ${geom.bottomDelta.toFixed(1)}px off the bubble's bottom edge`)
  else pass("control's bottom edge is flush with the bubble's")
  if (!near(geom.gap, 8, 1)) fail(`gap between control and bubble is ${geom.gap.toFixed(1)}px, expected 8`)
  else pass(`8px clear of the bubble (${geom.gap.toFixed(1)}px), no overlap: ${!geom.overlaps}`)
  if (!geom.groupMatchesBubble) fail("the control is taking layout — it must cost the bubble no width")
  else pass("absolutely positioned: the bubble is exactly as wide as it would be without the control")
  if (geom.size[0] !== 28 || geom.size[1] !== 28) fail(`control is ${geom.size.join("×")}, expected 28×28`)
  else pass("28×28, matching every other icon button in the app")

  // 5. THE GROUP IS THE POINT. With the pointer on the BUTTON — off the bubble entirely — the button
  //    must stay visible and the queued bubble must stay lifted to full opacity. Keyed off the bubble
  //    (`hover:` rather than `group-hover:`) both drop the instant you reach for the control.
  const btn = await last.$(`button[aria-label="Send now"]`)
  await btn.hover()
  await new Promise((r) => setTimeout(r, 250))
  const onButton = await page.evaluate((sel) => {
    const group = [...document.querySelectorAll(sel)].pop()
    return {
      button: Number(getComputedStyle(group.querySelector(`button[aria-label="Send now"]`)).opacity),
      bubble: Number(getComputedStyle(group.firstElementChild).opacity),
    }
  }, GROUPS)
  if (!near(onButton.button, 1, 0.01)) fail(`the control hides when the pointer is on it (opacity ${onButton.button})`)
  else if (!near(onButton.bubble, 1, 0.01)) fail(`the bubble drops back to ${onButton.bubble} with the pointer on its own control`)
  else pass("pointer on the control: it stays visible and the bubble stays lifted")

  // 6. OPTICAL: the arrow's INK centred in its 28px box. `items-center` centres the SVG's BOX, and an
  //    arrow's ink does not fill its viewBox evenly — so this measures the rendered ink, not the layout.
  const ink = await page.evaluate((sel) => {
    const btn = [...document.querySelectorAll(sel)].pop().querySelector(`button[aria-label="Send now"]`)
    const b = btn.getBoundingClientRect()
    const p = btn.querySelector("svg").getBBox
      ? btn.querySelector("svg").getBoundingClientRect()
      : null
    // The <path> union is the real ink; the <svg> box is padded by the viewBox.
    const paths = [...btn.querySelectorAll("svg path")].map((n) => n.getBoundingClientRect())
    const top = Math.min(...paths.map((r) => r.top)), bottom = Math.max(...paths.map((r) => r.bottom))
    const left = Math.min(...paths.map((r) => r.left)), right = Math.max(...paths.map((r) => r.right))
    return {
      dy: (top - b.top) - (b.bottom - bottom),
      dx: (left - b.left) - (b.right - right),
      svgBox: p ? Math.round(p.width) : null,
    }
  }, GROUPS)
  // Half a pixel is below what an eye can resolve at this size; the stroke's own round cap accounts for
  // more than that on its own.
  if (Math.abs(ink.dy) > 0.6) fail(`arrow ink sits ${ink.dy.toFixed(2)}px off vertical centre`)
  else pass(`arrow ink vertically centred (${ink.dy.toFixed(2)}px residual)`)
  if (Math.abs(ink.dx) > 0.6) fail(`arrow ink sits ${ink.dx.toFixed(2)}px off horizontal centre`)
  else pass(`arrow ink horizontally centred (${ink.dx.toFixed(2)}px residual)`)

  // 7. KEYBOARD. An `opacity-0` control is still in the tab order, so focusing it must REVEAL it —
  //    otherwise a keyboard user tabs onto a button they cannot see and cannot tell they have.
  await page.evaluate((sel) => {
    [...document.querySelectorAll(sel)].pop().querySelector(`button[aria-label="Send now"]`).focus()
  }, GROUPS)
  await new Promise((r) => setTimeout(r, 150))
  const focused = await page.evaluate((sel) =>
    Number(getComputedStyle([...document.querySelectorAll(sel)].pop().querySelector(`button[aria-label="Send now"]`)).opacity), GROUPS)
  if (!near(focused, 1, 0.01)) fail(`keyboard focus leaves the control invisible (opacity ${focused})`)
  else pass("keyboard focus reveals the control")

  // 8. THE CLICK asks the server to interrupt this thread's turn — and carries NO message, because the
  //    words are already in the provider's queue. A second copy of the text here would be the bug.
  await btn.click()
  await new Promise((r) => setTimeout(r, 400))
  const calls = await page.evaluate(() => window.__pushNowCalls ?? [])
  if (calls.length !== 1) fail(`expected exactly one deliverQueuedNow call, saw ${calls.length}`)
  else if (calls[0].slug !== "queued-spacing" || !calls[0].sessionId) fail(`bad payload: ${JSON.stringify(calls[0])}`)
  else if ("message" in calls[0] || "deliveryId" in calls[0]) fail(`the click re-sent content: ${JSON.stringify(calls[0])}`)
  else pass(`click → deliverQueuedNow(${JSON.stringify(calls[0])}) — no message, no deliveryId`)

  // 9. NARROW. The control hangs OUTSIDE the bubble to the left, so the width where the bubble is capped
  //    at 85% is where it would be pushed off the edge of the pane. Measured against the VIEWPORT: the
  //    drawer is full-bleed at this width, and there is no scroller element to address.
  await page.setViewport({ width: 420, height: 800, deviceScaleFactor: 2 })
  await page.reload({ waitUntil: "networkidle0" })
  await page.waitForSelector(`button[aria-label="Send now"]`)
  const narrowGroups = await page.$$(GROUPS)
  await narrowGroups[narrowGroups.length - 1].hover()
  await new Promise((r) => setTimeout(r, 250))
  const narrow = await page.evaluate((sel) => {
    const group = [...document.querySelectorAll(sel)].pop()
    const btn = group.querySelector(`button[aria-label="Send now"]`)
    const b = btn.getBoundingClientRect()
    return { left: b.left, opacity: Number(getComputedStyle(btn).opacity) }
  }, GROUPS)
  if (narrow.left < 0) fail(`at 420px the control is pushed ${(-narrow.left).toFixed(1)}px off the left edge`)
  else pass(`at 420px the control still clears the pane's left edge by ${narrow.left.toFixed(1)}px`)
  if (shots) await page.screenshot({ path: join(shots, "push-now-narrow.png") })

  if (pageErrors.length) fail(`page errors: ${JSON.stringify(pageErrors)}`)
  else pass("no page errors")
} finally {
  await browser.close()
}
console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS")
process.exit(failures ? 1 : 0)
