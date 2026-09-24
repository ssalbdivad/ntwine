import assert from "node:assert/strict"
import test from "node:test"

// Opt-in like the other *.e2e.test.ts here. Needs a REAL Frizz serving at least two projects, which
// `scripts/adhoc-stack.mjs` builds in one command:
//   nub scripts/adhoc-stack.mjs --port=45781 --project=/abs/a --also-project=/abs/b > /tmp/stack.log 2>&1 &
//   FRIZZ_PROJECT_SWITCH_E2E_URL=http://127.0.0.1:45781 nub --test --test-force-exit \
//     packages/web/src/lib/projectSwitch.e2e.test.ts
const baseUrl = process.env.FRIZZ_PROJECT_SWITCH_E2E_URL

// WHICH PROJECT THE LIVE FEED IS POINTED AT, after a client-side switch — the one thing no unit test
// here can reach. The pieces are all individually fine and were when this broke: `apiBase()` derives
// the right base from the path, `wsUrl()` derives from `apiBase()`, `rebindProject()` drops and
// re-opens correctly, and `<App/>` is keyed by slug so it genuinely remounts. The bug lived in the
// seam — routes.tsx guarded the rebind with a `useRef` seeded from the slug it was looking at, so any
// switch that changed which ROUTE matched (the cross-project page to a board, which is what a
// project's "Open board" does; it was the project grid's tiles when this broke) mounted a FRESH component whose ref already said "bound", skipped the rebind entirely, and left the
// socket on the previous project. Every board then rendered the launching project's threads under
// another project's URL, and nothing but a document load recovered it (reported 2026-08-11).
//
// So this asserts the socket URL, not the render: it is the one artifact that says which project the
// board data is actually coming from, and it is recorded from `evaluateOnNewDocument` so the module-load
// connection is captured too.
test("opening a board from Everything re-points the live feed at the project the URL names", {
  skip: !baseUrl,
  timeout: 90_000,
}, async () => {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] })
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
    // Everything — the cross-project page `/` redirects to, focused on one project and bound to it.
    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle2" })
    await page.waitForSelector("[data-xq-project-row]", { timeout: 15_000 })

    const rows = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("[data-xq-project-row]")].map((row) => ({
        id: row.dataset.xqProjectRow!,
        slug: row.querySelector("a")!.getAttribute("href")!.split("/")[2]!,
      })))
    assert.ok(rows.length >= 2, `needs a stack serving ≥2 projects, saw: ${rows.map((r) => r.slug).join(", ") || "none"}`)

    // The BOARD socket for a project, ignoring the per-thread terminal sockets (/term/:slug). Matched
    // with a regex rather than `endsWith("…")`, which frizzRouteUrls.test.ts reads as a hand-built
    // client URL — this only recognises one, it never constructs one.
    const isBoard = /\/ws$/
    const boardSocket = async () => (await page.evaluate(() =>
      (window as unknown as { __wsUrls: string[] }).__wsUrls))
      .filter((u) => isBoard.test(u)).at(-1)

    for (const { id, slug } of rows.slice(0, 2)) {
      // CLIENT-SIDE, through the project's own menu — a document load would rebind the feed and hide
      // the bug. The "…" shows on hover; the menu opens on pointerdown, so these are real clicks.
      const row = `[data-xq-project-row="${id}"]`
      await page.hover(`${row} a`)
      await page.click(`${row} button[aria-label^="More actions"]`)
      await page.waitForSelector(`[role="menu"] a[href="/project/${slug}"]`, { timeout: 10_000 })
      await page.click(`[role="menu"] a[href="/project/${slug}"]`)
      await page.waitForFunction((s) => location.pathname === `/project/${s}`, {}, slug)
      // The rebind is an effect + a socket open, so give the new one a moment to be constructed.
      await page.waitForFunction((s) =>
        ((window as unknown as { __wsUrls: string[] }).__wsUrls
          .filter((u) => /\/ws$/.test(u)).at(-1) ?? "").includes(`/_frizz/${s}/`), { timeout: 15_000 }, slug)
        .catch(() => {})
      assert.match(
        (await boardSocket()) ?? "",
        new RegExp(`/_frizz/${slug}/ws$`),
        `the board feed on /project/${slug} must address ${slug}, not whichever project it was last bound to`,
      )
      // …and the keyframe that feed delivers actually renders: the header resolves an identity rather
      // than sitting on its neutral placeholder, which is what a board bound to nothing looks like.
      await page.waitForFunction(() =>
        document.querySelector("[data-project-identity-state]")
          ?.getAttribute("data-project-identity-state") !== "loading", { timeout: 15_000 })
        .catch(() => assert.fail(`the board for ${slug} never resolved an identity`))
      await page.goBack({ waitUntil: "networkidle2" })
      await page.waitForFunction(() => location.pathname.startsWith("/all/"))
      await page.waitForSelector("[data-xq-project-row]", { timeout: 15_000 })
    }
  } finally {
    await browser.close()
  }
})
