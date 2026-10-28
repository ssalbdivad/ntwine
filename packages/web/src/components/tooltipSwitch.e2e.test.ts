import assert from "node:assert/strict"
import test from "node:test"

const baseUrl = process.env.NTWINE_TOOLTIP_SWITCH_E2E_URL

// Icon verbs sit shoulder to shoulder, and the tooltip has to name the one you are actually pointing
// at. It did not, first reported on the maintenance pair (Restart worker, Reload plugins): hovering
// Restart and then sliding onto the plug left the RESTART label up while the pointer sat squarely on
// Reload plugins (maintainer 2026-08-06: "the popover associated with the restart button continued to
// show up. It didn't switch over"). They were in the lifecycle footer then and the thread header's
// action strip later (2026-08-26); Restart worker has been in the drawer's ⋯ menu since 2026-09-29, and
// Reload plugins is gone. The gesture and the bug are properties of any adjacent pair, not of those
// two, so this drives the strip's snooze clock and Mark as done, the two lifecycle verbs at its right end.
//
// The cause was NOT the thing it looks like. In the footer the two marks wore negative ink trims
// that overlapped their 24px hover squares by 3px, which was the obvious suspect and the wrong one —
// the bug was gone with the overlap still there, and it is gone now with no overlap at all (the header
// strip is untrimmed 28px squares). Instrumenting the triggers showed the DOM doing everything right:
// `pointerleave` on one and `pointerenter` on its neighbour both fired, at the same x. Radix was
// declining to switch, because `Tooltip.Provider` defaults to
// HOVERABLE CONTENT and holds a tooltip open while the pointer is inside the grace polygon between
// the trigger and its content — and this content is a wide box sitting directly above BOTH icons, so
// the neighbour is inside the polygon. `disableHoverableContent` on the provider is the fix; nothing
// in ntwine needs to hover INTO a tooltip, and the ones that must stay reachable on touch use the
// clickable branch, which is not Radix at all.
//
// Driven with real pointer movement rather than dispatched events, because that distinction is the
// whole bug: synthetic `mouseover` would have "passed" against the broken build.
//
// Opt-in like this repo's other e2e tests — point it at a vite server for packages/web:
//   npx vite --port 5799 --strictPort   (in packages/web)
//   NTWINE_TOOLTIP_SWITCH_E2E_URL=http://localhost:5799 node --test --test-force-exit \
//     'packages/web/src/components/tooltipSwitch.e2e.test.ts'
test("the tooltip names whichever icon verb the pointer is on, including the neighbour it slid from", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  const errors: string[] = []
  // A bare `vite` over packages/web serves no favicon, and the 404 it logs says nothing about the
  // app — this test is opt-in against whatever server the runner points it at, so it ignores exactly
  // that one line and still fails on any real console error. The URL is on the message's LOCATION,
  // not in its text: the text is the generic "Failed to load resource…", so matching on the text
  // silently ignores nothing at all.
  const noise = (message: { text(): string; location(): { url?: string } }) =>
    message.location().url?.endsWith("/favicon.ico") ?? false
  page.on("console", (message) => { if (message.type() === "error" && !noise(message)) errors.push(message.text()) })
  page.on("pageerror", (error) => errors.push(String(error)))

  try {
    await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/icon-rhythm-fixture.html`, { waitUntil: "networkidle0" })

    const centres = await page.evaluate(() => {
      const centre = (selector: string) => {
        const el = document.querySelector(selector)
        if (!el) throw new Error(`the icon-rhythm fixture is missing ${selector}`)
        const box = el.getBoundingClientRect()
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      }
      return { snooze: centre('[data-thread-lifecycle] button[aria-label^="Snoozed until"]'), done: centre('[data-thread-lifecycle] [aria-label="Mark as done"]') }
    })

    // Whichever verb the pointer is over, and what the one open tooltip says — asserted together, so
    // a tooltip that is merely *absent* cannot pass as a tooltip that switched.
    const pointing = () =>
      page.evaluate(() => {
        const tooltip = document.querySelector('[role="tooltip"]')
        return {
          label: (tooltip?.textContent ?? "").trim().split("—")[0]?.trim() ?? null,
          open: document.querySelectorAll('[role="tooltip"]').length,
        }
      })

    const moveTo = async (point: { x: number; y: number }) => {
      await page.mouse.move(point.x, point.y, { steps: 10 })
      await new Promise((resolve) => setTimeout(resolve, 300))
    }

    await moveTo({ x: 20, y: 20 })
    assert.equal((await pointing()).open, 0, "nothing is open before the pointer reaches the strip")

    // The fixture's snooze is a week out, so its label carries a date: only its lead is asserted.
    const snoozeLabel = async () => {
      const { label, open } = await pointing()
      return { label: label?.startsWith("Snoozed until ") ? "Snoozed until …" : label, open }
    }

    await moveTo(centres.snooze)
    assert.deepEqual(await snoozeLabel(), { label: "Snoozed until …", open: 1 })

    // The reported gesture: onto the neighbour without leaving the strip.
    await moveTo(centres.done)
    assert.deepEqual(await pointing(), { label: "Mark as done (D)", open: 1 })

    // And back the other way, so the fix is not direction-dependent.
    await moveTo(centres.snooze)
    assert.deepEqual(await snoozeLabel(), { label: "Snoozed until …", open: 1 })

    // Leaving the strip closes it rather than leaving a label stranded over the row. Straight up, out of
    // the header: a diagonal to the corner crosses Collapse on its first step.
    await moveTo({ x: centres.snooze.x, y: 20 })
    assert.equal((await pointing()).open, 0, "the tooltip closes when the pointer leaves the strip")

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
