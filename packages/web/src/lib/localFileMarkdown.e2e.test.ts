import assert from "node:assert/strict"
import test from "node:test"

const baseUrl = process.env.FRIZZ_LOCAL_FILE_MARKDOWN_E2E_URL

// A REAL 1x1 PNG. This used to be the 8-byte PNG signature alone, which is not a decodable image —
// Chrome fired `error` on it, lib/local-file-links.ts's missing-image handler (correctly) swapped the
// dead <img> for the plain path, and every assertion below read `undefined` off an element that was no
// longer there. The test had gone red on main before anyone noticed, because what it asserts is the
// markup, and the markup was fine. The bytes have to decode for this fixture to measure anything.
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)

test("Markdown local image syntax uses the gated image proxy and local files remain app actions", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const pageErrors: string[] = []
  try {
    const page = await browser.newPage()
    page.on("pageerror", (error) => pageErrors.push(String(error)))
    await page.setRequestInterception(true)
    page.on("request", (request) => {
      // Both shots: the POSIX one and the Windows one. A proxy URL that 404s is swapped for the plain
      // path by the missing-image handler, so an un-served fixture image measures nothing.
      if (request.url().includes("/_frizz/local-image?path=%2Ffixture%2Fshot.png")
        || request.url().includes("/_frizz/local-image?path=D%3A%2Ffixture%2Fwin-shot.png")) {
        void request.respond({ status: 200, contentType: "image/png", body: PIXEL_PNG })
      } else {
        void request.continue()
      }
    })
    await page.goto(`${baseUrl}/local-file-opener-fixture.html`, { waitUntil: "domcontentloaded" })
    await page.waitForSelector('button[data-local-path="/fixture/report.md"]')
    const rendered = await page.$eval(".md-body", (node) => {
      const img = node.querySelector("img")
      return {
        buttons: [...node.querySelectorAll("button")].map((b) => b.getAttribute("data-local-path")),
        // The failure this whole page exists to catch is an anchor SURVIVING: a local path left as an
        // href is a same-origin URL, and one click leaves Frizz for a 404. Nothing here may be one.
        anchors: [...node.querySelectorAll("a")].map((a) => a.getAttribute("href")),
        imageSrc: img?.getAttribute("src"),
        imagePath: img?.getAttribute("data-local-path"),
        imageAlt: img?.getAttribute("alt"),
        // A Windows screenshot is proxied exactly like a POSIX one. With no path to proxy it was
        // REMOVED from the prose, so a Windows write-up rendered with its pictures silently missing.
        winImageSrc: node.querySelector('img[alt="windows alt"]')?.getAttribute("src"),
        // The picture is FRAMED, in the one frame every rendered image in the app sits in, and the
        // frame is built from spans so the paragraph marked wraps the image in survives the re-parse.
        framedIn: img?.closest(".md-image-frame")?.tagName,
        frameInsideParagraph: !!img?.closest("p"),
        // The same dot-directory path written in prose: every separator has to survive the render.
        winProse: [...node.querySelectorAll("p")].find((p) => p.textContent?.includes("in prose"))?.textContent,
      }
    })
    assert.deepEqual(rendered, {
      // The last two are the reported bug: a path a worker wrote the way it typed it — relative to the
      // project, and home-anchored — has to arrive here as an absolute local-file button. Before the
      // rebase both stayed relative anchors the browser resolved against the PAGE.
      buttons: [
        "/fixture/report.md",
        "/fixture/contract.pdf",
        "/fixture/.frizz/threads/6d56ea2f/HANDOFF.md",
        "/fixture/home/.claude/CLAUDE.md",
        // The editor deep links: a `cursor://file/…` anchor used to be handed to the OS, which opened
        // Cursor no matter what "Local file links" said. Both slash forms arrive as the path they name.
        "/fixture/plan.md",
        "/fixture/trace.json",
        // Windows destinations carry a path too. The file URL's leading slash stays until the
        // server normalizes it for its own filesystem.
        "D:/fixture/win-report.md",
        "D:\\fixture\\win-trace.json",
        "/D:/fixture/win-plan.md",
        // The `\.` in `fixture\.frizz` is a separator, not a CommonMark escape: the path the button
        // carries is the one the worker wrote, dot-directory and all.
        "D:\\fixture\\.frizz\\threads\\8e51437e\\build-gap.md",
      ],
      anchors: [],
      imageSrc: "/_frizz/local-image?path=%2Ffixture%2Fshot.png",
      imagePath: "/fixture/shot.png",
      imageAlt: "descriptive alt",
      winImageSrc: "/_frizz/local-image?path=D%3A%2Ffixture%2Fwin-shot.png",
      framedIn: "SPAN",
      frameInsideParagraph: true,
      winProse: "It also lives at D:\\fixture\\.frizz\\threads\\8e51437e\\build-gap.md in prose.",
    })

    // The ROUTING split, which the markup above deliberately cannot show: every link is the same
    // `data-local-path` button, and only the click decides where each one goes. A file Frizz can show —
    // the `.md` prose and the `.json` capture alike — must push the reader drawer and never reach the
    // desktop opener, while a format the page cannot draw (the PDF) must still be handed to the opener
    // and open no drawer.
    await page.click('button[data-local-path="/fixture/report.md"]')
    await page.click('button[data-local-path="/fixture/contract.pdf"]')
    // And the rebased one routes by the SAME rule — the click handler never learns which syntax the
    // author used, only the path it holds.
    await page.click('button[data-local-path="/fixture/.frizz/threads/6d56ea2f/HANDOFF.md"]')
    // And the editor-scheme pair routes by the same rule: the click handler never learns the author
    // wrote a `cursor://`/`vscode://` destination, only the path it named.
    await page.click('button[data-local-path="/fixture/plan.md"]')
    await page.click('button[data-local-path="/fixture/trace.json"]')
    // And the Windows set routes by the same rule, in both separators. The click handler reads an
    // extension, never a platform.
    await page.click('button[data-local-path="D:/fixture/win-report.md"]')
    await page.click('button[data-local-path="D:\\\\fixture\\\\win-trace.json"]')
    await page.click('button[data-local-path="/D:/fixture/win-plan.md"]')
    // And the dot-directory path reaches the reader with its separator intact.
    await page.click('button[data-local-path="D:\\\\fixture\\\\.frizz\\\\threads\\\\8e51437e\\\\build-gap.md"]')
    const routed = await page.evaluate(() => ({
      opened: (window as unknown as { __localFileFixtureOpened?: string[] }).__localFileFixtureOpened ?? [],
      drawers: (window as unknown as { __localFileFixtureDrawers: () => unknown[] }).__localFileFixtureDrawers(),
    }))
    assert.deepEqual(routed, {
      opened: ["/fixture/contract.pdf"],
      drawers: [
        { kind: "file", path: "/fixture/report.md" },
        { kind: "file", path: "/fixture/.frizz/threads/6d56ea2f/HANDOFF.md" },
        { kind: "file", path: "/fixture/plan.md" },
        { kind: "file", path: "/fixture/trace.json" },
        { kind: "file", path: "D:/fixture/win-report.md" },
        { kind: "file", path: "D:\\fixture\\win-trace.json" },
        { kind: "file", path: "/D:/fixture/win-plan.md" },
        { kind: "file", path: "D:\\fixture\\.frizz\\threads\\8e51437e\\build-gap.md" },
      ],
    })

    // A rendered picture opens in Frizz's picture viewer — never the desktop opener, which on a WSL box
    // meant a browser tab — among the pictures rendered beside it, in reading order.
    await page.click('img[data-local-path="D:/fixture/win-shot.png"]')
    assert.deepEqual(await page.evaluate(() => (window as unknown as { __localFileFixtureViewer: () => unknown }).__localFileFixtureViewer()), {
      paths: ["/fixture/shot.png", "D:/fixture/win-shot.png"],
      index: 1,
    })
    assert.deepEqual(await page.evaluate(() => (window as unknown as { __localFileFixtureOpened?: string[] }).__localFileFixtureOpened), ["/fixture/contract.pdf"])

    // A tool card's header path (PathLink) is the OTHER producer of a local-file link, and it used to
    // be an `<a href="cursor://file/…">` handed straight to the OS — which meant it opened Cursor no
    // matter what "Local file links" said. Nothing on this page may carry an editor-scheme href.
    assert.deepEqual(await page.$$eval('a[href]', (nodes) => nodes.map((n) => n.getAttribute("href"))), [])

    // It routes by the same rules as the markdown links, and — because the header it sits in is also
    // the disclosure control — the click must open the file and leave the block's state alone.
    const expandedBefore = await page.$eval(".frizz-diff-header", (n) => n.getAttribute("data-expanded"))
    await page.click('.frizz-diff-header button[title="/fixture/src/app.ts"]')
    await page.click('.frizz-diff-header button[title="/fixture/notes.md"]')
    const fromHeaders = await page.evaluate(() => ({
      opened: (window as unknown as { __localFileFixtureOpened?: string[] }).__localFileFixtureOpened ?? [],
      drawers: (window as unknown as { __localFileFixtureDrawers: () => unknown[] }).__localFileFixtureDrawers(),
      expanded: document.querySelector(".frizz-diff-header")?.getAttribute("data-expanded"),
    }))
    assert.deepEqual(fromHeaders.opened, ["/fixture/contract.pdf"])
    assert.deepEqual(fromHeaders.drawers, [
      { kind: "file", path: "/fixture/report.md" },
      { kind: "file", path: "/fixture/.frizz/threads/6d56ea2f/HANDOFF.md" },
      { kind: "file", path: "/fixture/plan.md" },
      { kind: "file", path: "/fixture/trace.json" },
      { kind: "file", path: "D:/fixture/win-report.md" },
      { kind: "file", path: "D:\\fixture\\win-trace.json" },
      { kind: "file", path: "/D:/fixture/win-plan.md" },
      { kind: "file", path: "D:\\fixture\\.frizz\\threads\\8e51437e\\build-gap.md" },
      { kind: "file", path: "/fixture/src/app.ts" },
      { kind: "file", path: "/fixture/notes.md" },
    ])
    assert.equal(fromHeaders.expanded, expandedBefore)

    // A PLACE IN A FILE. Every spelling — a `#L` fragment, an editor deep link's `:3:2`, a relative
    // `:12`, a file URL's fragment, inline code with a line (a bare `App.tsx:42` included), a raw-HTML
    // button and a Codex finding — leaves its path BARE on the element and its line beside it.
    await page.waitForSelector('[data-positioned] code[data-local-path="/fixture/App.tsx"]')
    const positioned = await page.$$eval("[data-positioned] [data-local-path], [data-codex-finding] [data-local-path]", (nodes) => nodes.map((n) => [
      n.getAttribute("data-local-path"),
      n.getAttribute("data-local-line"),
      n.getAttribute("data-local-col"),
      n.getAttribute("data-local-end-line"),
    ].join(" ").trim()))
    assert.deepEqual(positioned, [
      "/fixture/src/a.ts 5  9",
      "/fixture/src/a.ts 30",
      "/fixture/src/b.ts 3 2",
      "/fixture/src/c.ts 12",
      "/fixture/src/d.ts 7",
      "/fixture/src/e.ts 4",
      "/fixture/src/f.ts 21",
      "/fixture/App.tsx 42",
      "/fixture/src/g.ts 12  14",
      "/fixture/guide.md 8",
      // The sanitizer keeps an authored line (ALLOWED_ATTRS); the malformed column is left for the click
      // handler to refuse, and an unlisted data attribute is gone.
      "/fixture/src/raw.ts 8 nope",
      "/fixture/src/h.ts 30  34",
    ])
    assert.equal(await page.$eval('[data-positioned] button[data-local-path="/fixture/src/raw.ts"]', (n) => n.hasAttribute("data-bogus")), false)

    // With no editor connected, a code file with a line opens
    // the reader on the BARE path — the editor deep link `vscode://file/…:3:2` used to hand the reader
    // `b.ts:3:2`, which it reported not found.
    await page.click('[data-positioned] [data-local-path="/fixture/src/b.ts"]')
    await page.click('[data-positioned] [data-local-path="/fixture/guide.md"]')
    const readerPaths = await page.evaluate(() => (window as unknown as { __localFileFixtureDrawers: () => { path?: string }[] }).__localFileFixtureDrawers().map((d) => d.path))
    assert.deepEqual(readerPaths.slice(-2), ["/fixture/src/b.ts", "/fixture/guide.md"])

    // Code files to the editor (Local file links is VS Code, and a VS Code window is connected): each click
    // reaches `openLocalFile` with its line beside the path. The two links into a.ts at different lines are
    // clicked back to back, inside the opener's cooldown: the second is a new place to go, not a
    // double-click to swallow.
    await page.evaluate(() => (window as unknown as { __localFileFixtureEditor: (state: unknown) => void }).__localFileFixtureEditor({
      windows: [{ app: "Visual Studio Code", kind: "vscode", acceptsOpens: true }],
      opener: "vscode",
      remote: false,
    }))
    const opensBefore = await page.evaluate(() => ((window as unknown as { __localFileFixtureOpenBodies?: unknown[] }).__localFileFixtureOpenBodies ?? []).length)
    for (const selector of [
      '[data-positioned] button[data-local-path="/fixture/src/a.ts"][data-local-line="5"]',
      '[data-positioned] button[data-local-path="/fixture/src/a.ts"][data-local-line="30"]',
      '[data-positioned] [data-local-path="/fixture/src/b.ts"]',
      '[data-positioned] [data-local-path="/fixture/src/c.ts"]',
      '[data-positioned] [data-local-path="/fixture/src/d.ts"]',
      '[data-positioned] [data-local-path="/fixture/src/e.ts"]',
      '[data-positioned] [data-local-path="/fixture/src/f.ts"]',
      '[data-positioned] [data-local-path="/fixture/App.tsx"]',
      '[data-positioned] [data-local-path="/fixture/src/g.ts"]',
      // Markdown always opens in Frizz, line or no line — it never reaches the RPC.
      '[data-positioned] [data-local-path="/fixture/guide.md"]',
      '[data-positioned] [data-local-path="/fixture/src/raw.ts"]',
      '[data-codex-finding] [data-local-path="/fixture/src/h.ts"]',
    ]) await page.click(selector)
    // A code file's destination is settled asynchronously (a fresh settings read), so the last opens may
    // land a beat after the last click.
    await page.waitForFunction((n) => ((window as unknown as { __localFileFixtureOpenBodies?: unknown[] }).__localFileFixtureOpenBodies ?? []).length >= n, { timeout: 10_000 }, opensBefore + 11)
    const bodies = await page.evaluate(() => (window as unknown as { __localFileFixtureOpenBodies?: unknown[] }).__localFileFixtureOpenBodies ?? [])
    assert.deepEqual(bodies.slice(-11), [
      { path: "/fixture/src/a.ts", line: 5, endLine: 9 },
      { path: "/fixture/src/a.ts", line: 30 },
      { path: "/fixture/src/b.ts", line: 3, column: 2 },
      { path: "/fixture/src/c.ts", line: 12 },
      { path: "/fixture/src/d.ts", line: 7 },
      { path: "/fixture/src/e.ts", line: 4 },
      { path: "/fixture/src/f.ts", line: 21 },
      { path: "/fixture/App.tsx", line: 42 },
      { path: "/fixture/src/g.ts", line: 12, endLine: 14 },
      { path: "/fixture/src/raw.ts", line: 8 },
      { path: "/fixture/src/h.ts", line: 30, endLine: 34 },
    ])

    // WHERE A CODE FILE GOES (lib/editorWindows.ts codeFilesDestination). A click goes to the Local file
    // links app exactly while that app is an editor with a window connected that takes opens, and the
    // page is not a remote session; the reader otherwise. Each step clicks one link and reads back where
    // it went: an `openLocalFile` body, or a reader drawer — never both.
    type Fixture = {
      __localFileFixtureEditor: (state: unknown) => void
      __localFileFixtureResetOpens: () => void
      __localFileFixtureCloseDrawers: () => void
      __localFileFixtureOpenBodies?: unknown[]
      __localFileFixtureDrawers: () => { path?: string }[]
    }
    const vscodeWindow = { app: "Visual Studio Code", kind: "vscode", acceptsOpens: true }
    const where = () => page.evaluate(() => {
      const w = window as unknown as Fixture
      return { opens: (w.__localFileFixtureOpenBodies ?? []).length, drawers: w.__localFileFixtureDrawers().length }
    })
    const clickAuto = async (selector: string, state: Record<string, unknown>) => {
      await page.evaluate((s) => {
        const w = window as unknown as Fixture
        w.__localFileFixtureEditor(s)
        w.__localFileFixtureResetOpens()
        w.__localFileFixtureCloseDrawers()
      }, state)
      const before = await where()
      await page.click(selector)
      await page.waitForFunction((b) => {
        const w = window as unknown as Fixture
        return (w.__localFileFixtureOpenBodies ?? []).length !== b.opens || w.__localFileFixtureDrawers().length !== b.drawers
      }, { timeout: 10_000 }, before)
      // A beat for a second destination to show up, which would be the bug.
      await new Promise((resolve) => setTimeout(resolve, 150))
      const after = await where()
      const body = await page.evaluate(() => (window as unknown as Fixture).__localFileFixtureOpenBodies?.at(-1))
      const drawer = await page.evaluate(() => (window as unknown as Fixture).__localFileFixtureDrawers().at(-1)?.path)
      return after.opens > before.opens
        ? { to: "editor", body, alsoReader: after.drawers > before.drawers }
        : { to: "reader", path: drawer, alsoEditor: false }
    }
    const a5 = '[data-positioned] button[data-local-path="/fixture/src/a.ts"][data-local-line="5"]'
    assert.deepEqual(await clickAuto(a5, { windows: [vscodeWindow], opener: "vscode", remote: false }),
      { to: "editor", body: { path: "/fixture/src/a.ts", line: 5, endLine: 9 }, alsoReader: false })
    // Local file links is not the connected editor: the reader, as before any editor connected.
    assert.deepEqual(await clickAuto(a5, { opener: "system" }), { to: "reader", path: "/fixture/src/a.ts", alsoEditor: false })
    // The connected window turned file opens off.
    assert.deepEqual(await clickAuto(a5, { windows: [{ ...vscodeWindow, acceptsOpens: false }], opener: "vscode" }), { to: "reader", path: "/fixture/src/a.ts", alsoEditor: false })
    // A remote session: an open would land in a window on the desk nobody there can see.
    assert.deepEqual(await clickAuto(a5, { windows: [vscodeWindow], remote: true }), { to: "reader", path: "/fixture/src/a.ts", alsoEditor: false })
    // And Markdown always opens in Frizz, editor or not.
    assert.deepEqual(await clickAuto('[data-positioned] [data-local-path="/fixture/guide.md"]', {}), { to: "reader", path: "/fixture/guide.md", alsoEditor: false })

    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
})
