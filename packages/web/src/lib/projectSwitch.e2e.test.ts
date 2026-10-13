import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import test from "node:test"

// Opt-in like the other *.e2e.test.ts here. Needs a REAL Ntwine serving at least two projects, which
// `scripts/adhoc-stack.mjs` builds in one command:
//   nub scripts/adhoc-stack.mjs --port=45781 --project=/abs/a --also-project=/abs/b > /tmp/stack.log 2>&1 &
//   NTWINE_PROJECT_SWITCH_E2E_URL=http://127.0.0.1:45781 nub --test --test-force-exit \
//     packages/web/src/lib/projectSwitch.e2e.test.ts
// The stale-render test below also seeds threads, so it needs the sandbox HOME the stack printed:
//   NTWINE_PROJECT_SWITCH_E2E_HOME=<the "home" field of the stack's json line>
const baseUrl = process.env.NTWINE_PROJECT_SWITCH_E2E_URL
const sandboxHome = process.env.NTWINE_PROJECT_SWITCH_E2E_HOME

// WHICH PROJECT THE LIVE FEED IS POINTED AT, after a client-side switch — the one thing no unit test
// here can reach. The pieces are all individually fine and were when this broke: `apiBase()` derives
// the right base from the page's project, `wsUrl()` derives from `apiBase()`, and `rebindProject()`
// drops and re-opens correctly. The bug lived in the seam — routes.tsx guarded the rebind with a
// `useRef` seeded from the slug it was looking at, so a switch that mounted a FRESH component (the
// project grid's tiles into a board, when this broke) found a ref that already said "bound", skipped the
// rebind entirely, and left the socket on the previous project. Every board then rendered the launching
// project's threads under another project's URL, and nothing but a document load recovered it
// (reported 2026-08-11). The rebind now asks the feed itself (routes.tsx useProjectBinding).
//
// The page has TWO client-side switches, and both rebind: the page title's switcher moves the page to a
// project's board, `/project/<slug>` (a navigation within the one mounted page — routes.tsx PageRoute), and
// in All projects the prompt box's project picker re-binds the page to its pick without any navigation.
// Until 2026-09-28 the switch was a project row's ⋯ → Open board, a client-side navigation to
// `/project/<slug>`; from then until focus mode (2026-09-29) the picker was the only one, and from then
// until 2026-10-06 the switcher's board was the query `/?project=<slug>`.
//
// So this asserts the socket URL, not the render: it is the one artifact that says which project the
// page's live data is actually coming from, and it is recorded from `evaluateOnNewDocument` so the
// module-load connection is captured too.
test("switching the page to another project re-points the live feed at that project", {
  skip: !baseUrl,
  timeout: 90_000,
}, async () => {
  // Every registered project, opened: the server activates a tenant on its first request, and the page
  // only binds a project the server has open.
  const headers = { origin: baseUrl!, "content-type": "application/json" }
  const listed = (await (await fetch(`${baseUrl}/_ntwine/rpc/projectsList`, { headers })).json()) as { result: Array<{ slug: string; home?: boolean; stale?: boolean }> }
  const slugs = listed.result.filter((p) => !p.home && !p.stale).map((p) => p.slug)
  assert.ok(slugs.length >= 2, `needs a stack serving ≥2 projects, saw: ${slugs.join(", ") || "none"}`)
  for (const slug of slugs) await fetch(`${baseUrl}/_ntwine/${slug}/rpc/board`, { headers })

  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
    await page.evaluateOnNewDocument(() => {
      const w = window as unknown as { __wsUrls: string[]; WebSocket: typeof WebSocket }
      w.__wsUrls = []
      const Native = w.WebSocket
      w.WebSocket = new Proxy(Native, {
        construct(target, args: [string, ...unknown[]]) {
          w.__wsUrls.push(String(args[0]))
          return Reflect.construct(target, args)
        },
      })
    })
    // The page, focused on the LAST of them and bound to it, so every switch below moves the feed.
    await page.goto(`${baseUrl}/project/${slugs.at(-1)}`, { waitUntil: "networkidle2" })
    await page.waitForSelector('[data-status-row] [data-xq-switcher="project"]', { timeout: 15_000 })
    // A document load would rebind the feed and hide the bug, so the page must be this one throughout.
    await page.evaluate(() => { (window as unknown as { __sameDocument: boolean }).__sameDocument = true })

    // The BOARD socket for a project, ignoring any other socket the page opens. Matched
    // with a regex rather than `endsWith("…")`, which ntwineRouteUrls.test.ts reads as a hand-built
    // client URL — this only recognises one, it never constructs one.
    const isBoard = /\/ws$/
    const boardSocket = async () => (await page.evaluate(() =>
      (window as unknown as { __wsUrls: string[] }).__wsUrls))
      .filter((u) => isBoard.test(u)).at(-1)
    // Open a menu and choose from it. A Radix menu mounts its items before it positions them, so the item
    // is clicked once it holds still.
    const choose = async (trigger: string, value: string) => {
      // The last menu's close first (while a Radix menu is up the page under it takes no clicks), and the
      // trigger mounted: the picker is drawn only once All projects has rendered.
      await page.waitForFunction(() => !document.querySelector('[role="menu"]'), { timeout: 10_000 })
      await page.waitForSelector(trigger, { visible: true, timeout: 15_000 })
      await page.click(trigger)
      await page.waitForSelector(`[role="menuitem"][data-value="${value}"]`, { timeout: 10_000 })
      await page.waitForFunction((s) => new Promise((resolve) => {
        const at = document.querySelector(`[role="menuitem"][data-value="${s}"]`)?.getBoundingClientRect()
        if (!at || at.top < 0 || at.bottom > innerHeight) return resolve(false)
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(document.querySelector(`[role="menuitem"][data-value="${s}"]`)?.getBoundingClientRect().y === at.y)))
      }), { timeout: 10_000 }, value)
      await page.click(`[role="menuitem"][data-value="${value}"]`)
    }
    const feedFollows = async (slug: string, how: string) => {
      assert.equal(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument), true, `${how}: no document load`)
      // The rebind is an effect + a socket open, so give the new one a moment to be constructed.
      await page.waitForFunction((s) =>
        ((window as unknown as { __wsUrls: string[] }).__wsUrls
          .filter((u) => /\/ws$/.test(u)).at(-1) ?? "").includes(`/_ntwine/${s}/`), { timeout: 15_000 }, slug)
        .catch(() => {})
      assert.match(
        (await boardSocket()) ?? "",
        new RegExp(`/_ntwine/${slug}/ws$`),
        `${how}: the page's feed, switched to ${slug}, must address ${slug}, not whichever project it was last bound to`,
      )
      // …and the keyframe that feed delivers actually lands: the prompt box swaps its stand-in for the
      // project's real form once the project's board is in (AllQueues.tsx FocusedComposer), which is what
      // a page bound to nothing never does.
      await page.waitForFunction(() => !document.querySelector("[data-xq-composer-pending]") && document.querySelector("[data-dispatch-form]"), { timeout: 15_000 })
        .catch(() => assert.fail(`${how}: the prompt box never took ${slug}'s form`))
    }

    for (const slug of slugs.slice(0, 2)) {
      await choose("[data-status-row] [data-xq-switcher]", slug)
      await page.waitForFunction((s) => location.pathname === `/project/${s}`, { timeout: 15_000 }, slug)
      await feedFollows(slug, `the switcher, to ${slug}`)
    }

    // All projects keeps the project just left as the page's (the pick); the picker then moves it.
    await choose("[data-status-row] [data-xq-switcher]", "all-projects")
    await page.waitForFunction(() => location.pathname === "/all" && location.search === "", { timeout: 15_000 })
    const other = slugs[0]!
    await choose("[data-xq-project-picker]", other)
    await page.waitForFunction((s) => document.querySelector("[data-xq-picker-name]")?.textContent?.trim() === s, { timeout: 15_000 }, other)
    assert.equal(`${new URL(page.url()).pathname}${new URL(page.url()).search}`, "/all", "the picker's switch is not a navigation")
    await feedFollows(other, `the picker, to ${other}`)
  } finally {
    await browser.close()
  }
})

// NOTHING FROM THE PROJECT YOU LEFT RENDERS UNDER THE ONE YOU OPENED. The switch resets the board store
// in an effect, so the first commit under the new URL used to render the remounted <App/> over the OLD
// project's board — and every per-thread hook in it asked the NEW project's API about the old project's
// slugs. Most of that was wasted reads; one was a write: a thread drawer open across the switch sent
// `threadSeen` for its slug to the new project, which marked the new project's same-slug thread read
// although nobody had opened it (2026-10-08). routes.tsx now renders nothing until the reset has run.
//
// Two shapes, one browser: the phone drawer (where the write happened) and the desktop queue (where the
// stale reads were). A slug that exists ONLY in the project left behind is the discriminator: any
// request for it against the other project came from a stale render. The positive control is the
// other side of the same switch — the new project's own threads still fetch their own data.
test("a project switch sends none of the old project's thread slugs to the new project", {
  skip: !baseUrl || !sandboxHome,
  timeout: 120_000,
}, async () => {
  const headers = { origin: baseUrl!, "content-type": "application/json" }
  const get = async (path: string) => ((await (await fetch(`${baseUrl}${path}`, { headers })).json()) as { result: unknown }).result
  const projects = (await get("/_ntwine/rpc/projectsList")) as Array<{ id: string; slug: string }>
  assert.ok(projects.length >= 2, "needs a stack serving two projects")
  const [a, b] = projects as [{ id: string; slug: string }, { id: string; slug: string }]

  // A bare session row is a thread at rest ("exited"), which is all a drawer or a queue card needs.
  const db = join(sandboxHome!, ".ntwine", "ui.db")
  const sql = (q: string) => execFileSync("sqlite3", [db, q], { encoding: "utf8" }).trim()
  const seed = (project: string, slug: string, n: number) => sql(
    `INSERT OR REPLACE INTO session (project_id, slug, session_id, thread_name, spawned_at, title, backend, claude_runtime, model, effort, permission_mode, rested_at)
     VALUES ('${project}', '${slug}', 'e2e5517c-0000-4000-9000-${String(n).padStart(12, "0")}', 'ntwine-${slug}', '2026-10-08T18:00:00.000Z', '${slug}', 'claude', 'broker', 'opus', 'high', 'default', '2026-10-08T18:02:00.000Z')`)
  seed(a.id, "switch-shared", 1)
  seed(a.id, "switch-only-a", 2)
  seed(b.id, "switch-shared", 3)
  seed(b.id, "switch-only-b", 4)
  const bSeen = () => sql(`SELECT coalesce(seen_at, '') || '|' || coalesce(last_read_at, '') FROM session WHERE project_id = '${b.id}' AND slug = 'switch-shared'`)
  sql(`UPDATE session SET seen_at = NULL, last_read_at = NULL WHERE project_id = '${b.id}' AND slug = 'switch-shared'`)
  for (const p of [a, b]) {
    const deadline = Date.now() + 15_000
    for (;;) {
      const board = (await get(`/_ntwine/${p.slug}/rpc/board`)) as { threads: Array<{ id: string }> }
      if (board.threads.some((t) => t.id === "switch-shared")) break
      assert.ok(Date.now() < deadline, `${p.slug}'s board never showed the seeded threads`)
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  const settings = await get("/_ntwine/rpc/settingsGet")
  await fetch(`${baseUrl}/_ntwine/rpc/settingsSet`, { method: "POST", headers, body: JSON.stringify({ ...(settings as object), projectRail: true }) })

  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(String(error)))
    let phase = "load"
    const sent: Array<{ phase: string; method: string; path: string; input: string }> = []
    page.on("request", (req) => {
      const url = new URL(req.url())
      if (!/\/rpc\//.test(url.pathname)) return
      sent.push({ phase, method: req.method(), path: url.pathname, input: url.searchParams.get("input") ?? req.postData() ?? "" })
    })

    const shapes = [
      { name: "phone drawer", width: 420, start: `/project/${a.slug}/thread/switch-shared`, mounted: '[role="dialog"]' },
      { name: "desktop queue", width: 1440, start: `/project/${a.slug}`, mounted: null },
    ]
    for (const shape of shapes) {
      phase = "load"
      await page.setViewport({ width: shape.width, height: 900, deviceScaleFactor: 1 })
      await page.goto(`${baseUrl}${shape.start}`, { waitUntil: "networkidle2" })
      await page.waitForSelector(`a[href="/project/${b.slug}"]`, { timeout: 15_000 })
      // The precondition: the old project's thread is mounted and talking to its own project.
      if (shape.mounted) await page.waitForSelector(shape.mounted, { timeout: 15_000 })
      await page.waitForFunction(() => document.body.innerText.includes("switch-only-a"), { timeout: 15_000 })
        .catch(() => assert.fail(`${shape.name}: ${a.slug}'s board never rendered its threads`))

      phase = shape.name
      // A script click on the rail's link: a real react-router navigation with no document load. The
      // rail is hidden at phone width, but the path a click takes through the router is the same.
      await page.evaluate((s) => document.querySelector<HTMLAnchorElement>(`a[href="/project/${s}"]`)!.click(), b.slug)
      await page.waitForFunction((s) => location.pathname === `/project/${s}`, {}, b.slug)
      await page.waitForFunction(() => document.body.innerText.includes("switch-only-b"), { timeout: 15_000 })
        .catch(() => assert.fail(`${shape.name}: ${b.slug}'s board never rendered after the switch`))
      await new Promise((r) => setTimeout(r, 1500))

      const toB = sent.filter((r) => r.phase === shape.name && r.path.startsWith(`/_ntwine/${b.slug}/rpc/`))
      const leaked = toB.filter((r) => r.input.includes("switch-only-a") || r.path.endsWith("/threadSeen"))
      assert.deepEqual(leaked, [], `${shape.name}: requests to ${b.slug} carrying ${a.slug}'s threads`)
      if (shape.width === 1440) {
        assert.ok(toB.some((r) => r.input.includes("switch-only-b")),
          `${shape.name}: ${b.slug}'s own threads must still fetch their data after the switch`)
      }
    }
    assert.equal(bSeen(), "|", `${b.slug}'s switch-shared was marked seen by a switch away from ${a.slug}'s`)
    assert.deepEqual(errors, [], "no page errors")
  } finally {
    await browser.close()
  }
})
