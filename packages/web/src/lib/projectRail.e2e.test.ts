import assert from "node:assert/strict"
import test from "node:test"

// Opt-in like the other *.e2e.test.ts here. Needs a REAL Frizz serving at least two projects — the
// settings drawer only mounts inside a board, and the bug is in the seam between a client-side
// project switch and the per-project query cache — which `scripts/adhoc-stack.mjs` builds in one command:
//   nub scripts/adhoc-stack.mjs --port=45782 --project=/abs/a --also-project=/abs/b > /tmp/stack.log 2>&1 &
//   FRIZZ_PROJECT_RAIL_E2E_URL=http://127.0.0.1:45782 nub --test --test-force-exit \
//     packages/web/src/lib/projectRail.e2e.test.ts
const baseUrl = process.env.FRIZZ_PROJECT_RAIL_E2E_URL

// THE RAIL FOLLOWS THE SETTING WITHOUT A RELOAD, after a client-side project switch. `["settingsGet"]`
// hashes under the project the URL names at render time (lib/queryKeyScope.ts), and the layout that
// hosts the rail is mounted once and never re-rendered by a navigation — so the rail's query stayed
// bound to the project it was cold-loaded on (the project grid's "" scope, when this broke; Everything's
// focus project now), while the drawer wrote its save under the board's scope. The select flipped to "Always shown" and the rail did not appear until a
// reload happened to land on a board (maintainer 2026-08-24: "it literally only shows up when I'm in
// the home page"). Every piece is fine in isolation; only a real navigation followed by a real save
// reaches the seam, so this drives exactly that sequence.
test("flipping 'Project sidebar' on a board reached from Everything shows the rail without a reload", {
  skip: !baseUrl,
  timeout: 90_000,
}, async () => {
  // Start from HIDDEN, whatever the sandbox was left at. `projectRail` is a machine setting, so the
  // unprefixed (launching-project) write is the one every board reads.
  const rpc = `${baseUrl}/_frizz/rpc`
  const headers = { origin: baseUrl!, "content-type": "application/json" }
  const current = (await (await fetch(`${rpc}/settingsGet`, { headers })).json()) as { result: Record<string, unknown> }
  const reset = await fetch(`${rpc}/settingsSet`, { method: "POST", headers, body: JSON.stringify({ ...current.result, projectRail: false }) })
  assert.equal(reset.status, 200, `settingsSet must succeed: ${await reset.text()}`)

  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(String(error)))
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
    const rail = () => page.evaluate(() => document.querySelector('nav[aria-label="Projects"]') !== null)

    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle2" })
    await page.waitForSelector("[data-xq-project-row]", { timeout: 15_000 })
    assert.equal(await rail(), false, "the rail starts hidden on Everything")

    // Into a board CLIENT-SIDE, through a project's own "…" menu — a document load would rebind the
    // cache. A project OTHER than the page's focus, so the board's scope differs from the cold load's.
    const target = await page.evaluate(() => {
      const focus = location.pathname.split("/")[2]
      return [...document.querySelectorAll<HTMLElement>("[data-xq-project-row]")]
        .map((row) => ({ id: row.dataset.xqProjectRow!, slug: row.querySelector("a")!.getAttribute("href")!.split("/")[2]! }))
        .find((row) => row.slug !== focus)
    })
    assert.ok(target, "Everything lists a project besides its focus")
    const slug = target.slug
    await page.hover(`[data-xq-project-row="${target.id}"] a`)
    await page.click(`[data-xq-project-row="${target.id}"] button[aria-label^="More actions"]`)
    await page.waitForSelector(`[role="menu"] a[href="/project/${slug}"]`, { timeout: 10_000 })
    await page.click(`[role="menu"] a[href="/project/${slug}"]`)
    await page.waitForFunction((s) => location.pathname === `/project/${s}`, {}, slug)
    await page.waitForSelector('[aria-label="Settings"]', { timeout: 15_000 })
    assert.equal(await rail(), false, "still hidden after the switch")

    await page.click('[aria-label="Settings"]')
    // The setting is an Off/On pair under its label (SettingsDrawer.tsx OnOffToggle), with no name of
    // its own — so the field is found by its label and "On" pressed inside it.
    const flipped = await page.waitForFunction(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      let label: Node | null = null
      while (!label && walker.nextNode()) if (walker.currentNode.textContent === "Project sidebar") label = walker.currentNode
      const on = [...(label?.parentElement?.closest("div.flex-col")?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => b.textContent === "On")
      on?.click()
      return !!on
    }, { timeout: 10_000 }).then(() => true, () => false)
    assert.ok(flipped, "the settings drawer shows the Project sidebar setting")

    // The save is one round trip; the rail must follow it on THIS page, not on the next load.
    await page.waitForFunction(() => document.querySelector('nav[aria-label="Projects"]') !== null, { timeout: 10_000 })
      .catch(() => assert.fail("the rail never appeared after the setting flipped — the drawer's save landed in a cache entry the rail was not reading"))
    assert.equal(page.url(), `${baseUrl}/project/${slug}`, "no navigation happened along the way")
    assert.deepEqual(errors, [], "no page errors")
  } finally {
    await browser.close()
  }
})

// THE RAIL IS THERE ON THE FIRST RENDER OF A RELOAD, before the server has answered. `projectRail`
// arrives in `settingsGet`, one round trip after React mounts, and the hook used to answer HIDDEN
// until then — so with the rail on, every refresh painted the page flush left and then pushed it 57px
// right when the answer came (maintainer 2026-08-25: "This is layout shift"). The hook now mirrors
// the last answer into localStorage and reads it while the query is pending. Holding the RPC response
// is what turns "a beat late" into something an assertion can see; the control clears the mirror and
// holds the same response, and the rail must NOT be there — otherwise the check would pass on a
// page that simply rendered the rail unconditionally.
test("reloading with the rail on renders it before settingsGet answers, from the localStorage mirror", {
  skip: !baseUrl,
  timeout: 90_000,
}, async () => {
  const rpc = `${baseUrl}/_frizz/rpc`
  const headers = { origin: baseUrl!, "content-type": "application/json" }
  const current = (await (await fetch(`${rpc}/settingsGet`, { headers })).json()) as { result: Record<string, unknown> }
  const set = async (projectRail: boolean) => {
    const r = await fetch(`${rpc}/settingsSet`, { method: "POST", headers, body: JSON.stringify({ ...current.result, projectRail }) })
    assert.equal(r.status, 200, `settingsSet must succeed: ${await r.text()}`)
  }
  await set(true)

  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(String(error)))
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
    const rail = () => page.evaluate(() => document.querySelector('nav[aria-label="Projects"]') !== null)

    // One ordinary load with the rail on: the server answers, the hook writes the mirror.
    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle2" })
    assert.equal(await rail(), true, "the rail shows once settings have loaded")
    assert.equal(await page.evaluate(() => localStorage.getItem("frizz-project-rail")), "shown", "the mirror recorded the answer")

    // From here every settingsGet is HELD: the page renders, mounts, and never hears from the server.
    let held: Array<{ continue: () => Promise<void> }> = []
    let holding = false
    await page.setRequestInterception(true)
    page.on("request", (req) => {
      if (holding && /\/rpc\/settingsGet/.test(req.url())) held.push(req)
      else void req.continue()
    })
    const mounted = () => page.waitForSelector("#root > *", { timeout: 15_000 })

    holding = true
    await page.reload({ waitUntil: "domcontentloaded" })
    await mounted()
    // Give a wrong render every chance to happen: the request is in flight, nothing will answer it.
    await new Promise((r) => setTimeout(r, 500))
    assert.ok(held.length > 0, "the reload asked for settings (the hold is real)")
    assert.equal(await rail(), true, "the rail is on the first render, with settingsGet still unanswered")

    // CONTROL: no mirror, same hold — the rail must be absent, or the assertion above proved nothing.
    // The held requests are NOT released first: the answer would land in the old document and the
    // hook would write the mirror straight back, after this has cleared it. The reload cancels them.
    held = []
    await page.evaluate(() => localStorage.removeItem("frizz-project-rail"))
    await page.reload({ waitUntil: "domcontentloaded" })
    await mounted()
    await new Promise((r) => setTimeout(r, 500))
    assert.ok(held.length > 0, "the control reload asked for settings too")
    assert.equal(await rail(), false, "with no mirror and no answer the rail stays hidden (the server default)")

    for (const r of held) await r.continue()
    assert.deepEqual(errors, [], "no page errors")
  } finally {
    await browser.close()
    await set(false)
  }
})
