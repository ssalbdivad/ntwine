import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router"
import type { BoardSnapshot } from "@ntwine/shared"
import { StatusRow } from "./StatusRow.tsx"
import { store, type ConnectionState } from "../store.ts"
import { SUPERVISOR_STATUS_KEY } from "../api/supervisorStatus.ts"

// The row's SHAPE is a spec, not an accident: settings → shortcuts → reload → quota, left to right and all
// of it left-justified — and on All projects nothing else: no door and no name (2026-09-28). A project's
// board adds the door home and its identity (below). It has been three separate pieces
// of chrome in three places (identity top-left, settings/reload top-right, quota floating over the
// sidebar composer), then one fixed corner chip, then the same row running the other way — so a
// regression here is a silent return to one of those rather than a visible break.
//
// The store's board is seeded because the row must NOT read it: it names the page, never a project, so a
// board carrying an owner/repo is exactly what would leak into it if it did.
function render(
  label: string | null = "colinhacks/frizz",
  options: { connection?: ConnectionState; quota?: boolean } = {},
): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // The quota chips and the gate in front of them read these two cache entries; seeding them is how a
  // static render reaches the shown state at all.
  if (options.quota !== false) {
    client.setQueryData(["quota"], {
      claude: { status: "ok", planType: "max", windows: [{ key: "5h", label: "5h", usedPercent: 17 }] },
      codex: { status: "ok", planType: "pro", windows: [{ key: "5h", label: "5h", usedPercent: 41 }] },
    })
    client.setQueryData(["authStatus"], { claude: "authed", codex: "authed", emails: {} })
  }
  store.board = (label === null
    ? null
    : { projectLabel: label, githubRepo: label, threads: [] }) as unknown as BoardSnapshot
  store.connection = options.connection ?? "open"
  store.socketBoardFallback = null
  // The home crumb is a router Link (it hard-loaded the document until 2026-09-04), and a Link outside a
  // router context throws on render — every case here failed at once when it changed. In the app the row
  // is always under RouterProvider; MemoryRouter is the same context without a DOM history.
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(MemoryRouter, null, createElement(StatusRow, null)),
    ),
  )
}

test("the buttons lead and the readouts follow", () => {
  const html = render()
  const settings = html.indexOf('aria-label="Settings"')
  const quota = html.indexOf("data-quota-bar")
  assert.ok(settings >= 0 && quota >= 0, "every segment renders")
  assert.ok(settings < quota, "the buttons precede the readouts")
})

// NO DOOR AND NO NAME (David 2026-09-28: "there should no longer be an everything or an infinity
// button on the threads view on the left"). The row led with ∞, the door to Everything, and ended on the
// page's name; before that, atop a project's board, on the project's owner/repo.
test("the row has no door and names nothing — not the page, not a project", () => {
  const html = render("colinhacks/frizz")
  assert.doesNotMatch(html, /lucide-infinity/, "no ∞")
  assert.doesNotMatch(html, /Everything/, "no page name")
  assert.doesNotMatch(html, /href=/, "no link at all")
  assert.doesNotMatch(html, /colinhacks|github\.com|data-project-identity-state/, "and not the board the store happens to hold")
})

// ON A PROJECT'S BOARD (2026-10-06) the row is upstream's again at its left end: the door home to All
// projects at `/all` (not `/`, which goes back to the last view — from a board, the board), a divider
// (home LEAVES the board; the rest act on what you are in), then the page's title and the board's identity
// beside it — its repo and menu (ProjectBoard.tsx BoardIdentity). All projects passes neither, above.
test("on a board the row leads with the door home, then a divider, then the title and the board's identity", () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        null,
        createElement(StatusRow, { title: createElement("span", { "data-title": "" }, "acme"), identity: createElement("span", { "data-identity": "" }, "acme/api"), crumb: true }),
      ),
    ),
  )
  const home = html.indexOf('data-status-home')
  const divider = html.indexOf('class="h-3 w-px shrink-0 bg-border"')
  const title = html.indexOf("data-title")
  const identity = html.indexOf("data-identity")
  const settings = html.indexOf('aria-label="Settings"')
  assert.ok(home >= 0 && home < divider && divider < title && title < identity && identity < settings, JSON.stringify({ home, divider, title, identity, settings }))
  assert.match(html, /<a data-status-home="true" title="All projects" aria-label="All projects" class="-mx-1\.5 inline-flex[^"]*-ml-px" href="\/all"/, "the door home goes to All projects, at /all (2026-10-06)")
})

test("ONE divider, between the buttons and the readouts", () => {
  assert.equal(render().split('class="h-3 w-px shrink-0 bg-border"').length - 1, 1)
})

test("the row is LOOSE on the page — no fill, no border, no shadow, nothing fixed", () => {
  const html = render()

  assert.match(html, /data-status-row/)
  // It was a fixed, opaque, shadowed chip in the page's top-left corner until 2026-08-19, because a
  // full sidebar or a scrolling narrow rail would paint through it. In the column there is nothing to
  // pass behind it, and a surface here would read as a second box stacked on the prompt box.
  assert.match(html, /class="mb-2\.5 flex min-w-0 items-center gap-3 text-\[12px\]"/)
  for (const gone of [/\bfixed\b/, /\bz-20\b/, /bg-panel/, /shadow-sm/, /rounded-lg border border-border/]) {
    assert.doesNotMatch(html, gone)
  }
})

test("the connection dot is gone, in every state", () => {
  // It had been the connection's last remnant since 2026-08-19, and went with the maintainer's
  // 2026-08-28 "then maybe we should just drop the status indicator".
  for (const connection of ["open", "connecting", "closed"] as const) {
    const state = render("colinhacks/frizz", { connection })
    assert.doesNotMatch(state, /role="img" aria-label="connected"/)
    assert.doesNotMatch(state, /aria-label="disconnected"|aria-label="connecting…"/)
    assert.doesNotMatch(state, /bg-live|bg-danger-fill|data-board-sync-fallback/)
  }
})

test("the controls do not wait on a board — they are reachable from the first paint", () => {
  assert.match(render(null), /aria-label="Settings"/)
})

test("the row's gap is 12px of INK: one flex gap, and every icon square trimmed onto its glyph", () => {
  const html = render()

  // The pair is the whole point and neither half works alone. `gap-3` without the trims puts 20px of
  // ink between two icon squares and 8px beside the quota chips (measured 2026-08-14 with
  // scripts/ink-gaps.mjs); the trims without a matching gap pull the icons on top of each other. Every
  // button takes its trim from STATUS_ROW_ACTION, so a new row action inherits the rhythm instead of
  // re-deriving it — and a glyph that paints something other than 12px needs a fresh measurement.
  assert.match(html, /class="-mx-1\.5 inline-flex h-6 w-6/)
  // Every button takes the shared trim and NOTHING more: the row's first mark lands its ink on the
  // composer's border through the same `-mx-1.5` as the rest.
  assert.doesNotMatch(html, /-ml-px/)
  // The quota chips are IN this row, so they keep the row's distance rather than one of their own.
  assert.match(html, /data-quota-bar="true" class="flex shrink-0 items-center gap-3/)
})

test("the quota READING is small, but its provider mark is a full-sized, full-brightness icon", () => {
  const html = render()

  // "logos should be the same brightness and size as the other icons. The text should just be small"
  // (maintainer 2026-08-19). The size is per-mark because the two do not fill their viewBoxes alike.
  assert.match(html, /data-quota-bar="true" class="[^"]*text-\[9px\]/)
  assert.match(html, /text-fg\/75! size-\[14px\]!/)
  assert.match(html, /text-fg\/75! size-\[12\.75px\]!/)
  // ProviderMark's own `text-muted-65 size-[11px]` is still in the class list and MUST be — the `!`
  // is what outranks it, because Tailwind resolves a same-property collision by CSS source order and
  // not by class order. Asserting the default is absent would be asserting the wrong mechanism; the
  // browser-side check that these resolve to 14px/12.75px is in the handoff's measurements.
  assert.match(html, /text-muted-65 size-\[11px\][^"]*size-\[14px\]!/)
})

test("a provider with NO DATA renders nothing at all — and takes the divider with it", () => {
  // "if there's no data available for a given agent, then it should just be entirely hidden instead of
  // showing an em dash" (maintainer 2026-08-19). An em dash spent a readout's worth of space saying a
  // readout was missing.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(["quota"], {
    claude: { status: "ok", planType: "max", windows: [{ key: "5h", label: "5h", usedPercent: 17 }] },
    codex: { status: "unavailable", windows: [] },
  })
  client.setQueryData(["authStatus"], { claude: "authed", codex: "signed-out", emails: {} })
  store.board = { projectLabel: "colinhacks/frizz", threads: [] } as unknown as BoardSnapshot
  store.connection = "open"
  // Seeds its own client rather than going through `render`, so it needs the router context too.
  const one = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(MemoryRouter, null, createElement(StatusRow, null)),
    ),
  )
  assert.doesNotMatch(one, /—/, "no em dash anywhere")
  assert.equal(one.split("Claude Code").length - 1, 1, "the Claude chip is still there")
  assert.equal(one.split("OpenAI Codex").length - 1, 0, "the Codex chip is gone entirely")
  // One provider still reporting keeps the group, and therefore its divider.
  assert.equal(one.split('class="h-3 w-px shrink-0 bg-border"').length - 1, 1)

  // NEITHER reporting drops the whole group, and the divider that introduced it goes too — otherwise
  // the row ends on a hairline with nothing after it.
  const none = render("colinhacks/frizz", { quota: false })
  assert.doesNotMatch(none, /data-quota-bar/)
  assert.equal(none.split('class="h-3 w-px shrink-0 bg-border"').length - 1, 0)
})

// IN AN EDITOR'S SIDEBAR the row draws neither the gear nor the ⌨ — VS Code's title row carries Settings
// and, under its ⋯, Keyboard shortcuts — and is not drawn at all when nothing is left. The real-page run
// found the ⌨ alone on a 36px row above the prompt box (scripts/e2e-sidebar.ts, 2026-10-01): an Ntwine with
// no supervisor (run from source) and no quota to read.
test("the sidebar's row: no gear, no ⌨, and no row at all with nothing left in it", () => {
  const sidebarRow = (options: { quota: boolean; supervisor: boolean }) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    if (options.quota) {
      client.setQueryData(["quota"], { claude: { status: "ok", planType: "max", windows: [{ key: "5h", label: "5h", usedPercent: 17 }] }, codex: { status: "unavailable", windows: [] } })
      client.setQueryData(["authStatus"], { claude: "authed", codex: "signed-out", emails: {} })
    }
    if (options.supervisor) client.setQueryData(SUPERVISOR_STATUS_KEY, { protocol: 1, state: "ready", requestedAt: Date.now() })
    return renderToStaticMarkup(
      createElement(QueryClientProvider, { client }, createElement(MemoryRouter, null, createElement(StatusRow, { settings: false, shortcuts: false }))),
    )
  }
  assert.equal(sidebarRow({ quota: false, supervisor: false }), "", "nothing to show, no row")
  for (const [options, shows] of [
    [{ quota: true, supervisor: false }, /data-quota-bar/],
    [{ quota: false, supervisor: true }, /aria-label="Ntwine is up to date"/],
  ] as const) {
    const html = sidebarRow(options)
    assert.match(html, /data-status-row/, JSON.stringify(options))
    assert.match(html, shows)
    assert.doesNotMatch(html, /aria-label="Keyboard shortcuts"|aria-label="Settings"/)
  }
  // The browser's row keeps both (negative control for the props).
  assert.match(render(), /aria-label="Keyboard shortcuts"/)
})
