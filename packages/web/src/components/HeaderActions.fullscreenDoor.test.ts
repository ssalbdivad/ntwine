import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ThreadView } from "@ntwine/shared"
import { HeaderActions } from "./HeaderActions.tsx"
import { TooltipProvider } from "./Tooltip.tsx"
import { clearFullscreenOrigin, rememberFullscreenOrigin } from "../lib/fullscreenHandoff.ts"

// THE FULLSCREEN DOOR, ONE SLOT, BOTH DIRECTIONS.
//
// The /full page's header carries the door CLOSING (CollapseThreadLink, ⤡) in the thread's action strip,
// and the drawer's strip carries the door OPENING (ExpandThreadLink, ⤢) in the same slot (maintainer
// 2026-09-02: a collapse icon "in the same place where the expand icon is"). The ⤢ left every surface for
// the drawer's ⋯ menu on 2026-09-28 and came back on 2026-09-29, restoring 7a20f425; the same day the
// menu's duplicate entry went, and the ⤢ took its `f` key.
//
// Before 2026-09-02, /full's way out was an ArrowLeft sitting BEFORE THE TITLE, at the header's far
// left: a second, unrelated place to look for a whole-thread verb, and a "previous page" glyph on a
// control whose job is to change how this thread is SHOWN.

// STALLED, so the strip's far-right verb (Retry) is on the other side of the door. Most of the strip
// gates itself away in a bare render — Restart worker wants a dev build and a live process, and simply
// returns null here — so a harness that does not deliberately put NEIGHBOURS on both sides of the door
// cannot tell a position apart from a presence. (It did not: moving the closing half to the head of
// the strip left every reading identical, and the first version of the slot test below passed the
// control that was meant to break it.)
const base = { kind: "session", backend: "claude", title: "A worker", status: "active", subAgents: [], runtime: "exited", crashed: true, needsYou: true } as unknown as ThreadView

// The strip's icons render eagerly and a couple of them read the query cache, so they need the client
// the app always provides — the same harness HeaderActions.retry.test.ts uses.
function strip(props: { expand?: boolean; collapse?: boolean }): string {
  const t = { ...base, id: "t" } as ThreadView
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(TooltipProvider, null, createElement(HeaderActions, { thread: t, onDone: () => {}, onCollapse: () => {}, ...props })),
    ),
  )
}

/** The strip read left→right, as the reader sees it: one entry per control, named by its label. */
function controls(html: string): string[] {
  return [...html.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1])
}

test("the drawer strip opens /full and the /full strip leaves it, from the same slot", () => {
  const closing = controls(strip({ collapse: true }))
  assert.ok(closing.includes("Exit fullscreen"), `the /full strip carries the door closing: ${closing.join(" · ")}`)
  // Retry stays the strip's last verb: the door stands among the thread's own verbs, not after them.
  assert.ok(closing.indexOf("Exit fullscreen") < closing.findIndex((l) => l.startsWith("Retry")), `the door precedes Retry: ${closing.join(" · ")}`)

  const opening = controls(strip({ expand: true }))
  assert.ok(opening.includes("Open fullscreen"), `the drawer strip carries the door opening: ${opening.join(" · ")}`)
  // THE SAME SLOT: each half sits at the same index among the same neighbours.
  assert.equal(opening.indexOf("Open fullscreen"), closing.indexOf("Exit fullscreen"), `one position, both directions: ${opening.join(" · ")} / ${closing.join(" · ")}`)
  // Negative control: a strip asked for neither carries neither.
  const plain = controls(strip({}))
  assert.ok(!plain.some((l) => l === "Open fullscreen" || l === "Exit fullscreen"), `a bare strip has no door: ${plain.join(" · ")}`)
})

/** Render with the address bar at `pathname` — the collapse link reads the page's own address. */
function stripAt(pathname: string, props: { collapse?: boolean }): string {
  const had = Object.getOwnPropertyDescriptor(globalThis, "location")
  Object.defineProperty(globalThis, "location", { value: { pathname }, configurable: true, writable: true })
  try {
    return strip(props)
  } finally {
    if (had) Object.defineProperty(globalThis, "location", had)
    else delete (globalThis as { location?: unknown }).location
  }
}

test("a COLD arrival at /full leaves to that thread's drawer", () => {
  clearFullscreenOrigin()
  // A deep link, a bookmark or a reload noted no door, so there is no surface to return to: leaving
  // fullscreen shows the same thread the ordinary way, in its drawer on the page.
  assert.match(stripAt("/all/acme/thread/t/full", { collapse: true }), /href="\/all\/acme\/thread\/t"/)
  // The launching project's unprefixed /full names no project to open a drawer in, so it goes home.
  assert.match(stripAt("/thread/t/full", { collapse: true }), /href="\/"/)
})

test("the collapse icon leads back to the surface the door was pressed in", () => {
  try {
    // The door was pressed at the drawer's own address, and that is where leaving /full has to land.
    // The page ROOT mounts no drawer, so going there both strands the reader and leaves the reverse view
    // transition with nothing named `thread-chat` to shrink into — measured as a hard cross-fade at every
    // width from 767 to 2560 before this existed.
    rememberFullscreenOrigin("t", "/all/acme/thread/t")
    assert.match(stripAt("/all/acme/thread/t/full", { collapse: true }), /href="\/all\/acme\/thread\/t"/, "leaving /full returns to the drawer it was opened from")

    // Keyed by slug, so a record left by another thread's door can never redirect this one.
    clearFullscreenOrigin()
    rememberFullscreenOrigin("someone-else", "/all/acme/thread/someone-else")
    assert.match(stripAt("/all/acme/thread/t/full", { collapse: true }), /href="\/all\/acme\/thread\/t"/, "another thread's origin is not this thread's way out")

    // A /full address is never remembered: the way out must not be a loop.
    clearFullscreenOrigin()
    rememberFullscreenOrigin("t", "/all/acme/thread/t/full")
    assert.doesNotMatch(stripAt("/all/acme/thread/t/full", { collapse: true }), /href="[^"]*\/full"/, "a /full origin is refused, so the fallback stands")
  } finally {
    clearFullscreenOrigin()
  }
})

test("nothing is left standing before the title in the /full header", () => {
  const chatView = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")
  // The arrow is gone from the header, and the file no longer imports the glyph at all — the surest
  // reading that no second exit crept back in beside the title. Matched on the JSX and the import
  // rather than the bare name, because the header's comment still tells the reader what used to stand
  // there and why it does not.
  assert.ok(!/<ArrowLeft\b/.test(chatView), "ThreadHeader must not render an ArrowLeft back button")
  assert.ok(!/^import .*\bArrowLeft\b.*from "lucide-react"/m.test(chatView), "and must not still import the glyph")
  assert.match(chatView, /collapse=\{showReturnToQueue\}/, "the /full page passes the closing half to HeaderActions instead")
})
