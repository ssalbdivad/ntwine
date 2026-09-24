import { test } from "node:test"
import assert from "node:assert/strict"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import { markDrawerClosing, resolveRoutedThread, store } from "../store.ts"
import { applyLocation, primeRoute, queueDestination, startRouter } from "./router.ts"

function resetStore(): void {
  store.drawers = []
  store.view = "todos"
  store.routeThreadSlug = null
  store.board = null
}

// A board carrying exactly the fields the routing decision reads.
function boardWith(threads: Array<{ id: string; needsYou?: boolean }>): void {
  store.board = { threads: threads.map((t) => ({ ...t, needsYou: t.needsYou ?? false })) } as unknown as BoardSnapshot
}

// The queue card the URL should land on when the thread is already queued. `null` = no card mounted,
// which is how a non-queued (or not-yet-rendered) thread falls through to the drawer.
function mountQueueCard(slug: string | null): () => void {
  const globals = globalThis as typeof globalThis & { window?: Window; document?: Document; CSS?: typeof CSS }
  const previous = { window: globals.window, document: globals.document, CSS: globals.CSS }
  const card = {
    getBoundingClientRect: () => ({ top: 300 }),
    querySelector: () => null,
    setAttribute: () => {},
    removeAttribute: () => {},
    offsetWidth: 0,
  }
  globals.CSS = { escape: (value: string) => value } as typeof CSS
  globals.document = {
    querySelector: (selector: string) => (slug !== null && selector.includes(slug) ? card : null),
  } as unknown as Document
  globals.window = {
    scrollY: 0,
    scrollTo: () => {},
    clearTimeout: () => {},
    setTimeout: () => 0,
  } as unknown as Window
  return () => Object.assign(globals, previous)
}

test("primeRoute parks a direct thread route until the board can settle it", () => {
  resetStore()
  primeRoute("/thread/cold-load")
  // No board yet, so no drawer — deciding blind is what stacked a second panel over a queued
  // thread's card. The slug is held instead, and the address bar stays on it.
  assert.equal(store.routeThreadSlug, "cold-load")
  assert.equal(store.drawers.length, 0)
  assert.equal(store.view, "todos")
})

test("a parked route opens the chat drawer once the board says the thread is not queued", () => {
  resetStore()
  primeRoute("/thread/cold-load")
  boardWith([{ id: "cold-load" }])
  const restore = mountQueueCard(null)
  try {
    resolveRoutedThread()
  } finally {
    restore()
  }
  assert.deepEqual(
    store.drawers.map(({ kind, slug, routed }) => ({ kind, slug, routed })),
    [{ kind: "thread", slug: "cold-load", routed: true }],
  )
  assert.equal(store.routeThreadSlug, null)
})

test("a parked route for a QUEUED thread lands on its card instead of a second panel", () => {
  resetStore()
  primeRoute("/thread/queued-thread")
  boardWith([{ id: "queued-thread", needsYou: true }])
  const restore = mountQueueCard("queued-thread")
  try {
    resolveRoutedThread()
  } finally {
    restore()
  }
  // The queue card IS the thread's panel. A drawer over it renders the identical thing twice.
  assert.equal(store.drawers.length, 0)
  assert.equal(store.routeThreadSlug, null)
})

test("a queued thread with no card mounted still falls through to the drawer", () => {
  resetStore()
  primeRoute("/thread/queued-thread")
  boardWith([{ id: "queued-thread", needsYou: true }])
  const restore = mountQueueCard(null)
  try {
    resolveRoutedThread()
  } finally {
    restore()
  }
  assert.equal(store.drawers.length, 1)
  assert.equal(store.drawers[0]?.slug, "queued-thread")
})

test("resolveRoutedThread is inert without a board or a parked slug", () => {
  resetStore()
  resolveRoutedThread()
  assert.equal(store.drawers.length, 0)

  primeRoute("/thread/no-board")
  resolveRoutedThread()
  assert.equal(store.routeThreadSlug, "no-board", "a board-less resolve must not consume the parked slug")
  assert.equal(store.drawers.length, 0)
})

test("primeRoute is idempotent for the current direct thread and decodes its slug", () => {
  resetStore()
  primeRoute("/thread/a%20thread")
  primeRoute("/thread/a%20thread")
  assert.equal(store.routeThreadSlug, "a thread")
  assert.equal(store.drawers.length, 0)
})

test("priming the queue unwinds a routed drawer without leaving a phantom", () => {
  resetStore()
  primeRoute("/thread/cold-load")
  boardWith([{ id: "cold-load" }])
  const restore = mountQueueCard(null)
  try {
    resolveRoutedThread()
  } finally {
    restore()
  }
  assert.equal(store.drawers.length, 1)

  primeRoute("/")
  assert.equal(store.drawers.length, 0)
  assert.equal(store.routeThreadSlug, null)
  assert.equal(store.view, "todos")
})

test("a direct route reopens the closing layer instead of appending a duplicate", () => {
  resetStore()
  boardWith([{ id: "rapid-forward" }])
  const restore = mountQueueCard(null)
  try {
    primeRoute("/thread/rapid-forward")
    resolveRoutedThread()
    const closingId = store.drawers[0]?.id
    assert.ok(closingId)
    markDrawerClosing(closingId)

    primeRoute("/thread/rapid-forward")
    resolveRoutedThread()
  } finally {
    restore()
  }

  assert.equal(store.drawers.length, 1)
  assert.deepEqual(
    Object.fromEntries(Object.entries(store.drawers[0] ?? {}).filter(([key]) => ["kind", "slug", "routed", "closing"].includes(key))),
    { kind: "thread", slug: "rapid-forward", routed: true },
  )
})

test("landing on a thread already in the stack unwinds above it and parks nothing", () => {
  resetStore()
  boardWith([{ id: "below" }, { id: "above" }])
  const restore = mountQueueCard(null)
  try {
    primeRoute("/thread/below")
    resolveRoutedThread()
    primeRoute("/thread/above")
    resolveRoutedThread()
  } finally {
    restore()
  }
  // The one-drawer policy replaced `below`, so re-landing on it is a fresh park, not an unwind.
  primeRoute("/thread/above")
  assert.equal(store.routeThreadSlug, null, "the surface it asks for is already up")
  assert.equal(store.drawers.filter((d) => !d.closing).length, 1)
})

test("malformed percent escapes fall back to Queue instead of throwing before mount", () => {
  resetStore()
  primeRoute("/thread/existing")
  assert.doesNotThrow(() => primeRoute("/thread/%"))
  assert.equal(store.drawers.length, 0)
  assert.equal(store.routeThreadSlug, null)
  assert.equal(store.view, "todos")

  assert.doesNotThrow(() => primeRoute("/status/%"))
  assert.equal(store.view, "todos")
})

// `/` is the ALL-PROJECTS GRID since the singleton landed, so the queue could not keep using it as a
// URL: closing the last drawer on the launching project navigated to the project picker.
test("the queue's URL is a board, never the all-projects grid", () => {
  assert.equal(queueDestination("/", "fray"), "/project/fray", "the launching project has a board URL too")
  assert.equal(queueDestination("/", undefined), "/", "no slug yet (pre-restart server / cold boot) — old behaviour")
  // A thread path is already a board on either shape and must pass through untouched.
  assert.equal(queueDestination("/thread/fix-auth", "fray"), "/thread/fix-auth")
  assert.equal(queueDestination("/status/active", "fray"), "/status/active")
})

// A deep link to a slug THIS project does not have. Since one server started serving every project
// that is usually a thread ANOTHER project has — every pre-singleton bookmark and every agent-written
// `/thread/<slug>` cross-reference has that shape — so it must not open an empty sheet over the board.
test("a routed slug this board does not have hands off to the /full page's recovery", () => {
  resetStore()
  const globals = globalThis as typeof globalThis & { location?: Location }
  const previous = globals.location
  const replaced: string[] = []
  globals.location = { pathname: "/", replace: (url: string) => replaced.push(url) } as unknown as Location
  try {
    boardWith([{ id: "present" }])
    primeRoute("/thread/lives-elsewhere")
    resolveRoutedThread()
    assert.deepEqual(replaced, ["/thread/lives-elsewhere/full"], "<MissingThread> + threadLocate relocate from there")
    assert.equal(store.drawers.length, 0, "no empty drawer is opened over the board")

    // A thread this board DOES have is unaffected: it still opens in place, with no navigation.
    replaced.length = 0
    primeRoute("/thread/present")
    resolveRoutedThread()
    assert.deepEqual(replaced, [])
    assert.equal(store.drawers.length, 1)
    assert.equal(store.drawers[0].slug, "present")
  } finally {
    globals.location = previous
  }
})

// The fullscreen door clears the drawer stack and navigates to `/thread/<slug>/full` in one tick;
// valtio delivers the store notification a microtask later, when the address bar already names the
// fullscreen page. The board's store→URL sync must leave that URL alone — it pulled the page straight
// back to the board before the guard (live, 2026-08-28).
test("the store→URL sync never writes over the fullscreen page", async () => {
  resetStore()
  const globals = globalThis as typeof globalThis & { location?: Location }
  const previous = globals.location
  const navigated: string[] = []
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  try {
    globals.location = { pathname: "/thread/focus/full" } as unknown as Location
    const stop = startRouter((path) => navigated.push(path))
    store.drawers = [{ id: 1, kind: "thread", slug: "focus" } as never]
    await settle()
    store.drawers = []
    await settle()
    stop()
    assert.deepEqual(navigated, [], "no write while the address bar names a /full page")

    // CONTROL — the same writes on the board DO drive the URL, so the guard is the only difference.
    globals.location = { pathname: "/" } as unknown as Location
    const stopBoard = startRouter((path) => navigated.push(path))
    store.drawers = [{ id: 2, kind: "thread", slug: "focus" } as never]
    await settle()
    stopBoard()
    assert.deepEqual(navigated, ["/thread/focus"])
  } finally {
    globals.location = previous
    resetStore()
  }
})

// The cross-project page opens another project's thread URL-FIRST: history already names
// `/all/c/thread/u` while the store still holds the previous focus's state (here: a thread parked for
// project b, whose board never landed). A notification in that window must not write the old state over
// the new URL — that put b's `t` under c's prefix. Once the route has applied the URL, the store agrees
// with it and nothing is written at all.
test("the store→URL sync waits until the route has applied a URL-first navigation", async () => {
  resetStore()
  const globals = globalThis as typeof globalThis & { location?: Location }
  const previous = globals.location
  const navigated: string[] = []
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  try {
    globals.location = { pathname: "/all/b/thread/t" } as unknown as Location
    const stop = startRouter((path) => navigated.push(path))
    // The operator clicks c's card before b's board lands: history moves first.
    globals.location = { pathname: "/all/c/thread/u" } as unknown as Location
    store.connection = "open" // an unrelated notification, in the window
    await settle()
    assert.deepEqual(navigated, [], "nothing written over the URL the store has not absorbed")

    // The route applies it (routes.tsx useRouteToStore) — the store now parks c's `u`, and the address
    // bar already says so.
    store.routeThreadSlug = null
    applyLocation("/all/c/thread/u")
    await settle()
    assert.equal(store.routeThreadSlug, "u")
    assert.deepEqual(navigated, [], "the store agrees with the URL")

    // CONTROL: a store-first change once absorbed IS written — the guard only holds a moving URL.
    store.routeThreadSlug = "v"
    await settle()
    stop()
    assert.deepEqual(navigated, ["/all/c/thread/v"])
  } finally {
    globals.location = previous
    store.connection = "connecting"
    resetStore()
  }
})
