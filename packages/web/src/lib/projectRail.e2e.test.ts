import assert from "node:assert/strict"
import test from "node:test"

// Opt-in like the other *.e2e.test.ts here. Needs a REAL Ntwine serving at least two projects — the bug
// is in the seam between a client-side project switch and the per-project query cache — which
// `scripts/adhoc-stack.mjs` builds in one command:
//   nub scripts/adhoc-stack.mjs --port=45782 --project=/abs/a --also-project=/abs/b > /tmp/stack.log 2>&1 &
//   NTWINE_PROJECT_RAIL_E2E_URL=http://127.0.0.1:45782 nub --test --test-force-exit \
//     packages/web/src/lib/projectRail.e2e.test.ts
const baseUrl = process.env.NTWINE_PROJECT_RAIL_E2E_URL

// THE RAIL FOLLOWS THE SETTING WITHOUT A RELOAD, after a client-side project switch. `["settingsGet"]`
// hashes under the page's project at render time (lib/queryKeyScope.ts), and the layout that hosts the
// rail is mounted once and never re-rendered by a switch — so the rail's query stayed bound to the
// project it was cold-loaded on (the project grid's "" scope, when this broke), while the drawer wrote
// its save under the new project's scope. The select flipped to "Always shown" and the rail did not
// appear until a reload (maintainer 2026-08-24: "it literally only shows up when I'm in the home page").
// Every piece is fine in isolation; only a real switch followed by a real save reaches the seam, so
// this drives exactly that sequence.
//
// The switch is the status row's project switcher, a navigation WITHIN the one mounted page, from
// `/project/<a>` to `/project/<b>`: the page binds the new project, and page-relative scopes follow it
// (routes.tsx CrossProjectPage). Until 2026-09-28 it was a client-side navigation from Everything to the
// other project's board; from then until focus mode (2026-09-29), the prompt box's picker re-focusing `/`;
// then `/?project=<a>` to `/?project=<b>` until the board took its path back (2026-10-06). The rail went
// with the fork's on 2026-09-30 and came back as upstream's on 2026-10-06, and this test with it.
test("flipping 'Project sidebar' after switching the page to another project shows the rail without a reload", {
  skip: !baseUrl,
  timeout: 90_000,
}, async () => {
  // Start from HIDDEN, whatever the sandbox was left at. `projectRail` is a machine setting, so the
  // unprefixed (launching-project) write is the one every project reads.
  const rpc = `${baseUrl}/_ntwine/rpc`
  const headers = { origin: baseUrl!, "content-type": "application/json" }
  const current = (await (await fetch(`${rpc}/settingsGet`, { headers })).json()) as { result: Record<string, unknown> }
  const reset = await fetch(`${rpc}/settingsSet`, { method: "POST", headers, body: JSON.stringify({ ...current.result, projectRail: false }) })
  assert.equal(reset.status, 200, `settingsSet must succeed: ${await reset.text()}`)
  // Every registered project, opened: the server activates a tenant on its first request, and the page
  // only binds a project the server has open.
  const listed = (await (await fetch(`${rpc}/projectsList`, { headers })).json()) as { result: Array<{ slug: string; home?: boolean; stale?: boolean }> }
  const slugs = listed.result.filter((p) => !p.home && !p.stale).map((p) => p.slug)
  assert.ok(slugs.length >= 2, `needs a stack serving ≥2 projects, saw: ${slugs.join(", ") || "none"}`)
  for (const slug of slugs) await fetch(`${baseUrl}/_ntwine/${slug}/rpc/board`, { headers })

  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(String(error)))
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
    const rail = () => page.evaluate(() => document.querySelector('nav[aria-label="Projects"]') !== null)
    const focused = () => page.evaluate(() => decodeURIComponent(/^\/project\/([^/]+)/.exec(location.pathname)?.[1] ?? ""))

    await page.goto(`${baseUrl}/project/${slugs[0]}`, { waitUntil: "networkidle2" })
    await page.waitForSelector('[data-status-row] [data-xq-switcher="project"]', { timeout: 15_000 })
    assert.equal(await rail(), false, "the rail starts hidden")
    // A document load would rebind the cache and hide the bug, so the page must be this one throughout.
    await page.evaluate(() => { (window as unknown as { __sameDocument: boolean }).__sameDocument = true })

    // CLIENT-SIDE, through the switcher. A project OTHER than the cold load's, so the page's scope differs
    // from the one the rail was read under.
    const slug = slugs[1]!
    await page.click("[data-status-row] [data-xq-switcher]")
    await page.waitForSelector(`[role="menuitem"][data-value="${slug}"]`, { timeout: 10_000 })
    // A Radix menu mounts its items before it positions them; click once the item holds still on screen.
    await page.waitForFunction((s) => new Promise((resolve) => {
      const at = document.querySelector(`[role="menuitem"][data-value="${s}"]`)?.getBoundingClientRect()
      if (!at || at.top < 0 || at.bottom > innerHeight) return resolve(false)
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(document.querySelector(`[role="menuitem"][data-value="${s}"]`)?.getBoundingClientRect().y === at.y)))
    }), { timeout: 10_000 }, slug)
    await page.click(`[role="menuitem"][data-value="${slug}"]`)
    // Until the switcher NAMES the new project, not merely until it exists: it is the page's title and never
    // unmounts, so its presence says nothing, and a click on Settings before the page has rebound is closed
    // again by the rebind (store.ts resetProjectState).
    await page.waitForFunction((s) => location.pathname === `/project/${s}` && document.querySelector('[data-status-row] [data-xq-switcher-label]')?.textContent?.trim() === s, { timeout: 15_000 }, slug)
      .catch(async () => assert.fail(`the switcher never moved to ${slug}; the page is on "${await focused()}"`))
    assert.equal(await rail(), false, "still hidden after the switch")

    // The menu's own close first: while a Radix menu is up, the page under it takes no clicks.
    await page.waitForFunction(() => !document.querySelector('[role="menu"]'), { timeout: 10_000 })
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
    assert.equal(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument), true, "no document load along the way")
    assert.equal(await focused(), slug, "the page is still on the project it was switched to")
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
  const rpc = `${baseUrl}/_ntwine/rpc`
  const headers = { origin: baseUrl!, "content-type": "application/json" }
  const current = (await (await fetch(`${rpc}/settingsGet`, { headers })).json()) as { result: Record<string, unknown> }
  const set = async (projectRail: boolean) => {
    const r = await fetch(`${rpc}/settingsSet`, { method: "POST", headers, body: JSON.stringify({ ...current.result, projectRail }) })
    assert.equal(r.status, 200, `settingsSet must succeed: ${await r.text()}`)
  }
  await set(true)

  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(String(error)))
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
    const rail = () => page.evaluate(() => document.querySelector('nav[aria-label="Projects"]') !== null)

    // One ordinary load with the rail on: the server answers, the hook writes the mirror. All projects,
    // the other view the rail shows on.
    await page.goto(`${baseUrl}/all`, { waitUntil: "networkidle2" })
    assert.equal(await rail(), true, "the rail shows once settings have loaded")
    assert.equal(await page.evaluate(() => localStorage.getItem("ntwine-project-rail")), "shown", "the mirror recorded the answer")

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
    await page.evaluate(() => localStorage.removeItem("ntwine-project-rail"))
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
