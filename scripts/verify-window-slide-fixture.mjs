// Drive the saturated-window fixture in a real browser with NO frizz server.
//
// `verify-full-window-slide.mjs` is the full-stack version and is the one that first caught this bug, but
// a frizz server plus a 300-message first render is more than this machine can currently hold (three runs
// SIGKILLed at the render peak; a 15GB VM owned by something else is sitting on the RAM). This drives the
// same component, virtualizer and scroll code through the same client push pipeline on plain Vite, which
// fits — and it is the tighter instrument for the fix, since both halves of the fix are client-side.
//
// Reports the drift of a named row under the reader's eye across a series of appends, so it can be run
// against the pre-fix and post-fix source for a real differential.
//
//   node scripts/verify-window-slide-fixture.mjs [--port=5199] [--appends=12] [--park=900] [--label=post]
import { spawn } from "node:child_process"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { launchHeadless } from "./lib/headless-browser.mjs"

const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")))
const port = Number(flags.port ?? 5199)
const appends = Number(flags.appends ?? 12)
const parkTarget = Number(flags.park ?? 900)
const label = flags.label ?? "run"
const shotDir = flags.shots ?? join(tmpdir(), "frizz-slide-fixture")
mkdirSync(shotDir, { recursive: true })

let failures = 0
const check = (l, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${l}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

// Plain Vite over packages/web — the fixture stubs every /rpc call it needs, so no server is involved.
const vite = spawn("npx", ["vite", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
  cwd: new URL("../packages/web/", import.meta.url).pathname,
  stdio: ["ignore", "pipe", "pipe"],
})
const viteLog = []
vite.stdout.on("data", (d) => viteLog.push(String(d)))
vite.stderr.on("data", (d) => viteLog.push(String(d)))
const stopVite = () => { try { vite.kill("SIGTERM") } catch {} }
process.on("exit", stopVite)

const base = `http://127.0.0.1:${port}/`
const ready = async () => {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(base)).ok) return true } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}
if (!(await ready())) {
  console.error("vite never came up:\n" + viteLog.join(""))
  stopVite()
  process.exit(1)
}

// A generous protocolTimeout is diagnostic headroom, not a fix: an append that takes tens of seconds is
// itself the finding, and the per-append timing below is what makes it visible instead of a bare timeout.
const browser = await launchHeadless({ protocolTimeout: 300_000 })
const errors = []
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 })
  page.on("console", (m) => {
    if (m.type() !== "error") return
    if ((m.location()?.url ?? "").endsWith("/favicon.ico")) return
    errors.push(m.text())
  })
  page.on("pageerror", (e) => errors.push(String(e)))
  // Name the URL behind any failed request: a bare "404 (Not Found)" console line is unattributable, and
  // an unattributed error is indistinguishable from a real one.
  // /favicon.ico is exempt: the bare fixture HTML declares none, so Chrome's speculative request 404s on
  // every fixture in this repo. Nothing else is exempt.
  page.on("requestfailed", (r) => { if (!r.url().endsWith("/favicon.ico")) errors.push(`requestfailed ${r.url()}`) })
  page.on("response", (r) => { if (r.status() >= 400 && !r.url().endsWith("/favicon.ico")) errors.push(`HTTP ${r.status()} ${r.url()}`) })
  await page.goto(new URL("transcript-window-slide-fixture.html?messages=340", base).href, { waitUntil: "networkidle2", timeout: 60000 })
  await page.waitForFunction("window.__ws && document.querySelector('[data-virtualized-transcript] [data-transcript-row-key]')", { timeout: 40000 })

  const settle = (ms) => page.evaluate(async (wait) => {
    const raf = () => new Promise((r) => requestAnimationFrame(r))
    for (let i = 0; i < 10; i++) await raf()
    await new Promise((r) => setTimeout(r, wait))
    for (let i = 0; i < 10; i++) await raf()
  }, ms)
  const probe = (key) => page.evaluate((k) => window.__ws.probe(k), key ?? null)

  await settle(2500)
  const seeded = await page.evaluate(() => window.__ws.seeded())
  let m = await probe()
  check("the render window is SATURATED (the configuration under test)",
    seeded > 300 && m.held === 300 && m.hasEarlier,
    `seeded=${seeded} held=${m.held} hasEarlier=${m.hasEarlier} transcriptKey=${m.transcriptKey}`)

  const centre = await page.evaluate(() => {
    const r = document.querySelector("[data-drawer-transcript-scroll]").getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })
  await page.mouse.move(centre.x, centre.y)
  for (let i = 0; i < 60; i++) {
    if ((await probe()).distance >= parkTarget) break
    await page.mouse.wheel({ deltaY: -180 })
    await new Promise((r) => setTimeout(r, 30))
  }
  await settle(1600) // the 700ms reader-gesture window must fully expire

  m = await probe()
  check(`the reader is parked ${m.distance}px above the bottom, detached`, m.distance > 300 && m.jumpVisible, `distance=${m.distance} jump=${m.jumpVisible}`)
  const anchorKey = m.key
  let lastY = m.y
  console.log(`[${label}] parked: anchor=${anchorKey} y=${lastY} distance=${m.distance} scrollTop=${m.scrollTop} held=${m.held}`)
  await page.screenshot({ path: join(shotDir, `${label}-0-parked.png`) })

  const drifts = []
  let vanished = null
  for (let i = 0; i < appends; i++) {
    // Alternate the two shapes a live turn actually produces: a whole new message (which is what slides
    // the window) and a tool call merged into the message already at the tail (which only grows a row).
    const t0 = Date.now()
    if (i % 3 === 2) await page.evaluate(() => window.__ws.growTail())
    else await page.evaluate(() => window.__ws.appendMessage(3))
    const pushMs = Date.now() - t0
    await settle(420)
    if (pushMs > 1500) console.log(`  [${label}] slow push: append ${i} took ${pushMs}ms inside the page`)
    const after = await probe(anchorKey)
    if (!after.found) { vanished = i; break }
    const drift = after.y - lastY
    if (Math.abs(drift) > 2) {
      drifts.push({ i, drift })
      console.log(`  [${label}] DRIFT ${drift > 0 ? "+" : ""}${drift}px after append ${i} (${i % 3 === 2 ? "merged tool call" : "new message"}) — y ${lastY}→${after.y}, scrollTop ${after.scrollTop}, held ${after.held}, totalHeight ${after.totalHeight}`)
      lastY = after.y
    }
  }

  m = await probe(anchorKey)
  await page.screenshot({ path: join(shotDir, `${label}-1-final.png`) })
  check(`[${label}] ${appends} appends against a saturated window never moved the reader`,
    drifts.length === 0 && vanished === null,
    `${drifts.length} drifting appends, total ${drifts.reduce((s, d) => s + d.drift, 0)}px${vanished !== null ? `; anchor row left the window at append ${vanished}` : ""}`)
  check(`[${label}] the reader is still detached at the end`, m.jumpVisible, `jump=${m.jumpVisible} distance=${m.distance}`)
  check(`[${label}] the page envelope survived every push`,
    m.hasEarlier && m.transcriptKey === "fixture-key",
    `hasEarlier=${m.hasEarlier} transcriptKey=${m.transcriptKey} — a push carries messages only, so losing these means the reader can never pull back the trimmed history`)

  // A reader who scrolls WHILE the window is sliding must keep their NEW position — the restore must
  // track their live intent, not re-pin them to where they were before they moved.
  await page.mouse.wheel({ deltaY: -400 })
  await settle(900)
  const moved = await probe()
  const movedKey = moved.key
  const movedY = moved.y
  await page.evaluate(() => window.__ws.appendMessage(3))
  await settle(900)
  const held = await probe(movedKey)
  check(`[${label}] a reader who scrolls mid-slide keeps their new position`,
    held.found && Math.abs(held.y - movedY) <= 2,
    `anchor Y ${movedY} → ${held.found ? held.y : "row gone"}`)

  // THE BOTTOM RESIDUE — the only gap a reader cannot have chosen, and therefore the only thing the
  // attachment band has to cover. Printed so the band's size stays an observation rather than a guess.
  const gap = () => page.evaluate(() => {
    const el = document.querySelector("[data-drawer-transcript-scroll]")
    return el.scrollHeight - el.scrollTop - el.clientHeight
  })
  // Read it only once it has STOPPED changing. A single read right after a write measures a transient:
  // rows entering the viewport at the bottom measure taller than their estimate, so scrollHeight is still
  // growing and the gap reads as hundreds of px before the re-pin closes it. That number is not residue.
  const settledGap = async () => {
    let previous = await gap()
    for (let i = 0; i < 12; i++) {
      await settle(400)
      const next = await gap()
      if (Math.abs(next - previous) < 0.01) return next
      previous = next
    }
    return previous
  }
  // The timeline after a PROGRAMMATIC jump to the bottom, sampled rather than reasoned about: if the gap
  // settles above zero while the reader still reads as attached, the next append will haul them — the same
  // symptom as the reported bug, reached by a different route (Jump to latest, or the initial scroll-to-end).
  await page.evaluate(() => window.__ws.scrollToBottom())
  const timeline = []
  for (let i = 0; i < 10; i++) {
    await settle(250)
    const p = await probe()
    timeline.push(`${p.distance}px/${p.jumpVisible ? "detached" : "attached"}`)
  }
  console.log(`[${label}] after a programmatic scroll-to-bottom: ${timeline.join(" → ")}`)
  const written = await settledGap()
  for (let i = 0; i < 10; i++) { await page.mouse.wheel({ deltaY: 240 }); await new Promise((r) => setTimeout(r, 25)) }
  const flung = await settledGap()
  // Two DIFFERENT quantities, easy to conflate (and I did, once):
  //   `written` — how short a naive `scrollTop = scrollHeight` lands. It writes against the scrollHeight of
  //     the moment, which then GROWS as the rows entering the viewport measure taller than their estimate,
  //     so it settles a long way short. The reader is correctly classified DETACHED there: they never
  //     reached the bottom. Not residue, and not a number the band should be sized against.
  //   `flung`  — where a reader who wheels DOWN into the clamp actually lands. That is the residue, and it
  //     is what the attachment band has to cover.
  console.log(`[${label}] settled gap after a naive programmatic write: ${written.toFixed(3)}px (reader reads as detached, correctly)`)
  console.log(`[${label}] BOTTOM RESIDUE after a wheel fling into the clamp: ${flung.toFixed(3)}px — the attachment band is 4px`)
  check(`[${label}] a reader who wheels down to the genuine bottom reads as attached`,
    !(await probe()).jumpVisible && flung <= 4,
    `residue=${flung.toFixed(3)}px — if this fails the attachment band is now SMALLER than the layout residue`)

  // FIX C — a reader who nudges up barely a line must not be hauled back. 24px used to count as "at the
  // tail" (TAIL_FOLLOW_PX was 64), and one append dragged such a reader 346px down.
  for (let i = 0; i < 3; i++) { await page.mouse.wheel({ deltaY: -8 }); await new Promise((r) => setTimeout(r, 40)) }
  await settle(1600)
  const nudged = await probe()
  const nudgedKey = nudged.key
  const nudgedY = nudged.y
  check(`[${label}] a ${nudged.distance}px nudge above the bottom DETACHES the reader`,
    nudged.distance > 4 && nudged.jumpVisible,
    `distance=${nudged.distance} jump=${nudged.jumpVisible}`)
  await page.evaluate(() => window.__ws.appendMessage(4))
  await settle(1200)
  const afterNudge = await probe(nudgedKey)
  check(`[${label}] an append leaves that barely-nudged reader exactly where they are`,
    afterNudge.found && Math.abs(afterNudge.y - nudgedY) <= 2,
    `anchor Y ${nudgedY} → ${afterNudge.found ? afterNudge.y : "row gone"}, distance ${nudged.distance} → ${afterNudge.distance}`)
  await page.screenshot({ path: join(shotDir, `${label}-2-nudged.png`) })

  check(`[${label}] no console or page errors`, errors.length === 0, errors.slice(0, 3).join(" | "))
  console.log(`\nscreenshots → ${shotDir}/${label}-*.png`)
} finally {
  await browser.close()
  stopVite()
}
process.exit(failures ? 1 : 0)
