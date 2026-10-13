// Real-browser verification of the top-left status bar: order, geometry, both popovers (driven with a
// REAL mouse, because React's enter/leave can't be faked with dispatchEvent), the narrow viewport, and
// the degraded quota states. One browser launch, many shots.
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { launchHeadless } from "./lib/headless-browser.mjs"

const BASE = process.env.BASE ?? "http://localhost:4941/status-bar-fixture.html"
const OUT = join(tmpdir(), "frizz-statusbar")
mkdirSync(OUT, { recursive: true })

const results = []
const fail = (m) => { console.log("FAIL:", m); results.push(false) }
const pass = (m) => { console.log("pass:", m); results.push(true) }

const browser = await launchHeadless()
try {
  const page = await browser.newPage()

  // Open a quota chip's popover and only return once its content is actually mounted. A bare
  // click+waitForSelector is not enough: waitForSelector can match a wrapper Radix then discards when
  // the click landed mid-commit, and every measurement after it evaluates against null. Retry the
  // click instead of measuring a popover that isn't there.
  const openChip = async (label) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.click(`[aria-label^="${label}"]`)
      try {
        await page.waitForFunction(
          () => {
            const w = document.querySelector("[data-radix-popper-content-wrapper]")
            return !!w && w.getBoundingClientRect().height > 0
          },
          { timeout: 3000, polling: 100 },
        )
        await new Promise((r) => setTimeout(r, 350))
        if (await page.evaluate(() => !!document.querySelector("[data-radix-popper-content-wrapper]"))) return
      } catch {
        // fall through to the retry
      }
    }
    throw new Error(`the ${label} chip never opened its popover`)
  }
  const errors = []
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("favicon")) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.setViewport({ width: 1440, height: 420, deviceScaleFactor: 2 })

  // ---- 1. healthy: order + single-line geometry -------------------------------------------------
  // domcontentloaded, NOT networkidle: the fixture is served by a vite dev server whose HMR socket
  // never goes idle, so networkidle2 can hang forever.
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 20000 })
  await page.waitForSelector("[data-quota-bar] button", { timeout: 20000 })
  await new Promise((r) => setTimeout(r, 600))

  const geom = await page.evaluate(() => {
    const bar = document.querySelector("[data-status-bar]")
    const items = [
      ["identity", bar.querySelector("[data-project-identity-state]")],
      ["settings", bar.querySelector('[aria-label="Settings"]')],
      ["reload", bar.querySelector('[aria-label="Update Frizz"],[aria-label="Restart Frizz"]')],
      ["claude", bar.querySelector('[aria-label^="Claude"]')],
      ["codex", bar.querySelector('[aria-label^="Codex"]')],
    ]
    const barBox = bar.getBoundingClientRect()
    return {
      bar: { x: barBox.x, y: barBox.y, h: Math.round(barBox.height) },
      items: items.map(([name, el]) => {
        if (!el) return { name, missing: true }
        const r = el.getBoundingClientRect()
        return { name, left: Math.round(r.left), cy: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) }
      }),
    }
  })
  console.log(JSON.stringify(geom, null, 2))

  const missing = geom.items.filter((i) => i.missing).map((i) => i.name)
  if (missing.length) fail(`missing from the bar: ${missing.join(", ")}`)
  else pass("identity, settings, reload and both quota chips all render")

  const order = geom.items.map((i) => i.left)
  const ascending = order.every((v, i) => i === 0 || v > order[i - 1])
  if (ascending) pass(`left-to-right order is slug → connection → settings → reload → claude → codex (${order.join(" < ")})`)
  else fail(`items are not in ascending x order: ${JSON.stringify(geom.items)}`)

  const cys = geom.items.map((i) => i.cy)
  const sameLine = Math.max(...cys) - Math.min(...cys) <= 1
  if (sameLine) pass(`every item shares one baseline (centre y = ${cys.join(",")})`)
  else fail(`items are not on one line: centre y = ${cys.join(",")}`)

  const buttons = geom.items.filter((i) => i.name === "settings" || i.name === "reload")
  const evenButtons = buttons.every((b) => b.w === 24 && b.h === 24)
  if (evenButtons) pass("settings and reload are identical 24px targets (WCAG 2.2 minimum)")
  else fail(`icon buttons differ in size: ${JSON.stringify(buttons)}`)

  await page.screenshot({ path: join(OUT, "01-healthy.png") })

  // ---- 2. the reload popover, opened with a REAL hover ------------------------------------------
  const reload = await page.$('[aria-label="Update Frizz"],[aria-label="Restart Frizz"]')
  await reload.hover()
  await page.waitForSelector("#update-restart-popover", { timeout: 5000 })
  await new Promise((r) => setTimeout(r, 250))
  const pop = await page.$eval("#update-restart-popover", (p) => {
    const r = p.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), right: Math.round(r.right), w: Math.round(r.width) }
  })
  const popOnScreen = pop.x >= 0 && pop.right <= 1440 && pop.y >= 0
  if (popOnScreen) pass(`reload popover opens rightward and stays on-screen (x=${pop.x} right=${pop.right})`)
  else fail(`reload popover is off-screen: ${JSON.stringify(pop)} — the old right-0 anchor regressed`)
  await page.screenshot({ path: join(OUT, "02-reload-popover.png") })

  // Move the mouse away so the tooltip doesn't overlap the next shot.
  await page.mouse.move(1200, 300)
  await new Promise((r) => setTimeout(r, 250))

  // ---- 3. the quota popover, opened with a REAL click -------------------------------------------
  await openChip("Claude")
  const quotaPop = await page.$eval("[data-radix-popper-content-wrapper]", (p) => {
    const r = p.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), bottom: Math.round(r.bottom), right: Math.round(r.right) }
  })
  const barBottom = geom.bar.y + geom.bar.h
  if (quotaPop.y >= barBottom - 2 && quotaPop.right <= 1440 && quotaPop.x >= 0) {
    pass(`quota popover drops BELOW the bar and stays on-screen (y=${quotaPop.y} vs bar bottom ${barBottom})`)
  } else {
    fail(`quota popover is misplaced: ${JSON.stringify(quotaPop)} — expected it below the bar (side="bottom")`)
  }
  await page.screenshot({ path: join(OUT, "03-quota-popover.png") })

  // The account line: the popover names WHICH account the credential belongs to, on its own row under
  // the provider/plan header and above the per-window breakdown.
  const account = await page.evaluate(() => {
    const pop = document.querySelector("[data-radix-popper-content-wrapper]")
    const row = pop.querySelector("[data-quota-account]")
    if (!row) return { missing: true, text: pop.innerText }
    // The header is the account row's own previous sibling — an exact handle. Do NOT reach for a
    // structural selector like "div > div": the popper wrapper's first child is PopoverContent itself,
    // so that matches the whole card and every "is it below the header" check passes vacuously.
    const header = row.previousElementSibling
    const list = pop.querySelector("ul")
    const r = row.getBoundingClientRect()
    return {
      text: row.textContent,
      title: row.getAttribute("title"),
      clipped: row.scrollWidth > row.clientWidth + 1,
      insidePopover: r.right <= pop.getBoundingClientRect().right + 1,
      belowHeader: r.top >= header.getBoundingClientRect().bottom - 1,
      aboveWindows: r.bottom <= list.getBoundingClientRect().top + 1,
    }
  })
  console.log("account line:", JSON.stringify(account))
  if (account.missing) fail(`the popover shows no account email: ${account.text}`)
  else if (account.belowHeader && account.aboveWindows && account.insidePopover && !account.clipped) {
    pass(`the account line reads "${account.text}", sits under the header and above the windows, unclipped`)
  } else fail(`the account line is misplaced or clipped: ${JSON.stringify(account)}`)

  // A signed-out provider must NOT be labelled with a leftover account (the server omits it, and the
  // popover leads with Sign in instead). Codex is the signed-out one in ?state=signedout.
  await page.keyboard.press("Escape")
  await page.goto(`${BASE}?state=signedout`, { waitUntil: "domcontentloaded", timeout: 20000 })
  await page.waitForSelector("[data-quota-bar] button", { timeout: 20000 })
  await new Promise((r) => setTimeout(r, 600))
  await openChip("Codex")
  const signedOutText = await page.$eval("[data-radix-popper-content-wrapper]", (p) => p.innerText)
  if (!/@/.test(signedOutText)) pass(`a signed-out provider carries no account line ("${signedOutText.replace(/\n/g, " · ")}")`)
  else fail(`the signed-out popover still names an account: ${signedOutText.replace(/\n/g, " · ")}`)
  await page.screenshot({ path: join(OUT, "03b-signed-out-popover.png") })

  // A long address must truncate inside the popover rather than widen or overflow it.
  await page.keyboard.press("Escape")
  await page.goto(`${BASE}?state=longemail`, { waitUntil: "domcontentloaded", timeout: 20000 })
  await page.waitForSelector("[data-quota-bar] button", { timeout: 20000 })
  await new Promise((r) => setTimeout(r, 600))
  await openChip("Claude")
  const longEmail = await page.evaluate(() => {
    const pop = document.querySelector("[data-radix-popper-content-wrapper]")
    const row = pop.querySelector("[data-quota-account]")
    const popBox = pop.getBoundingClientRect()
    return {
      popWidth: Math.round(popBox.width),
      truncated: row.scrollWidth > row.clientWidth,
      title: row.getAttribute("title"),
      overflows: row.getBoundingClientRect().right > popBox.right + 1,
    }
  })
  console.log("long email:", JSON.stringify(longEmail))
  if (longEmail.popWidth <= 240 && longEmail.truncated && !longEmail.overflows && /@/.test(longEmail.title ?? "")) {
    pass(`a long address truncates at the 15rem cap (popover stays ${longEmail.popWidth}px) and keeps the full value in title`)
  } else fail(`a long address broke the popover: ${JSON.stringify(longEmail)}`)
  await page.screenshot({ path: join(OUT, "03c-long-email-popover.png") })

  // ---- 4. narrow viewport ------------------------------------------------------------------------
  await page.keyboard.press("Escape")
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 20000 })
  await page.waitForSelector("[data-quota-bar] button", { timeout: 20000 })
  await page.setViewport({ width: 420, height: 640, deviceScaleFactor: 2 })
  await new Promise((r) => setTimeout(r, 500))
  const narrow = await page.evaluate(() => {
    const bar = document.querySelector("[data-status-bar]")
    const r = bar.getBoundingClientRect()
    const codex = bar.querySelector('[aria-label^="Codex"]').getBoundingClientRect()
    return {
      barRight: Math.round(r.right),
      barHeight: Math.round(r.height),
      codexRight: Math.round(codex.right),
      viewport: window.innerWidth,
      bodyOverflows: document.documentElement.scrollWidth > window.innerWidth,
    }
  })
  console.log("narrow:", JSON.stringify(narrow))
  // 28px = the bar's documented h-7 (StatusBar.tsx: h-7 at top-2.5 holds the old h-6/top-3 optical
  // centre while giving the fill 2px around the 24px icon targets). This assertion still read 24 from
  // the h-6 era and had been failing on every run since.
  if (narrow.codexRight <= narrow.viewport && !narrow.bodyOverflows && narrow.barHeight === 28) {
    pass(`narrow (420px): the bar stays one 28px line, the last chip is reachable, no horizontal overflow`)
  } else {
    fail(`narrow viewport broke the bar: ${JSON.stringify(narrow)}`)
  }
  await page.screenshot({ path: join(OUT, "04-narrow.png") })

  // ---- 5. degraded states ------------------------------------------------------------------------
  await page.setViewport({ width: 1440, height: 300, deviceScaleFactor: 2 })
  for (const [name, query] of [
    ["05-low-quota", "?state=low"],
    ["06-signed-out", "?state=signedout"],
    ["07-disconnected", "?connection=closed"],
    ["08-identity-loading", "?identity=loading"],
  ]) {
    await page.goto(BASE + query, { waitUntil: "domcontentloaded", timeout: 20000 })
    await new Promise((r) => setTimeout(r, 900))
    await page.screenshot({ path: join(OUT, `${name}.png`) })
    const text = await page.$eval("[data-status-bar]", (b) => b.innerText.replace(/\n/g, " · "))
    console.log(`${name}: ${text}`)
  }

  if (errors.length) fail(`console/page errors: ${errors.join(" | ")}`)
  else pass("no console or page errors")
} finally {
  await browser.close()
}

console.log(`\nshots in ${OUT}`)
const failed = results.filter((r) => !r).length
console.log(failed ? `${failed} CHECK(S) FAILED` : "ALL CHECKS PASSED")
process.exit(failed ? 1 : 0)
