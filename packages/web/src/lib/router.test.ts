import { test } from "node:test"
import assert from "node:assert/strict"
import type { BoardSnapshot } from "@ntwine/shared"
import { markDrawerClosing, noteStandaloneThreadRender, pushDrawer, registerRoutedLanding, resolveRoutedThread, store } from "../store.ts"
import { applyLocation, appPushedCurrentEntry, noteRouterTransition, primeReturnFromFullscreen, primeRoute, startRouter } from "./router.ts"

function resetStore(): void {
  store.drawers = []
  store.routeThreadSlug = null
  store.board = null
  store.pendingOpen = null
}

// A board carrying exactly the fields the routing decision reads.
function boardWith(threads: Array<{ id: string; needsYou?: boolean }>): void {
  store.board = { threads: threads.map((t) => ({ ...t, needsYou: t.needsYou ?? false })) } as unknown as BoardSnapshot
}

test("primeRoute parks a direct thread route until the board can settle it", () => {
  resetStore()
  primeRoute("/thread/cold-load")
  // No board yet, so no drawer — deciding blind cannot tell this project's thread from another's, or a
  // chat drawer from a doc drawer. The slug is held instead, and the address bar stays on it.
  assert.equal(store.routeThreadSlug, "cold-load")
  assert.equal(store.drawers.length, 0)
})

test("a parked route opens the chat drawer once the board has the thread", () => {
  resetStore()
  primeRoute("/thread/cold-load")
  boardWith([{ id: "cold-load" }])
  resolveRoutedThread()
  assert.deepEqual(
    store.drawers.map(({ kind, slug, routed }) => ({ kind, slug, routed })),
    [{ kind: "thread", slug: "cold-load", routed: true }],
  )
  assert.equal(store.routeThreadSlug, null)
})

test("a parked route for a QUEUED thread opens its drawer — a card on the page is a summary, not the panel", () => {
  resetStore()
  primeRoute("/thread/queued-thread")
  boardWith([{ id: "queued-thread", needsYou: true }])
  resolveRoutedThread()
  assert.equal(store.drawers.length, 1)
  assert.equal(store.drawers[0]?.slug, "queued-thread")
})

// A cross-project open from the queue: the click puts the drawer's FRAME up (store.pendingOpen) and moves
// the address with `inPlace` navigation state, which on its own makes the drawer slide in.
function withInPlaceHistory(body: () => void): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "history")
  Object.defineProperty(globalThis, "history", { configurable: true, writable: true, value: { state: { usr: { inPlace: true } } } })
  try {
    body()
  } finally {
    if (previous) Object.defineProperty(globalThis, "history", previous)
    else Reflect.deleteProperty(globalThis, "history")
  }
}

test("an in-place open whose frame is already up paints its drawer open and retires the frame", () => {
  withInPlaceHistory(() => {
    // Negative control: an in-place open with NO frame up slides its drawer in, as it always has.
    resetStore()
    primeRoute("/thread/other")
    store.board = { projectSlug: "home", threads: [{ id: "other", needsYou: false }] } as unknown as BoardSnapshot
    resolveRoutedThread()
    assert.equal(store.drawers[0]?.routed, false)

    resetStore()
    store.pendingOpen = { projectSlug: "home", projectName: "Home", slug: "wsl-cleanup", title: "WSL cleanup" }
    primeRoute("/thread/wsl-cleanup")
    assert.equal(store.pendingOpen?.slug, "wsl-cleanup", "its own address keeps the frame up")
    store.board = { projectSlug: "home", threads: [{ id: "wsl-cleanup", needsYou: true }] } as unknown as BoardSnapshot
    resolveRoutedThread()
    // `routed`: the drawer takes the frame's place already open — a second slide-in would replay the open.
    assert.deepEqual(store.drawers.map(({ slug, routed }) => ({ slug, routed })), [{ slug: "wsl-cleanup", routed: true }])
    assert.equal(store.pendingOpen, null)
  })
})

test("a frame for one project's thread is not taken by another project's same-named thread", () => {
  withInPlaceHistory(() => {
    resetStore()
    store.pendingOpen = { projectSlug: "home", projectName: "Home", slug: "fix-auth", title: "Fix auth" }
    primeRoute("/thread/fix-auth")
    store.board = { projectSlug: "ntwine", threads: [{ id: "fix-auth", needsYou: false }] } as unknown as BoardSnapshot
    resolveRoutedThread()
    assert.equal(store.drawers[0]?.routed, false)
    assert.equal(store.pendingOpen?.projectSlug, "home")
  })
})

test("an address other than the pending thread abandons its frame", () => {
  resetStore()
  store.pendingOpen = { projectSlug: "home", projectName: "Home", slug: "wsl-cleanup", title: "WSL cleanup" }
  primeRoute("/thread/another")
  assert.equal(store.pendingOpen, null, "another thread")
  store.pendingOpen = { projectSlug: "home", projectName: "Home", slug: "wsl-cleanup", title: "WSL cleanup" }
  primeRoute("/")
  assert.equal(store.pendingOpen, null, "Back to the page")
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
  resolveRoutedThread()
  assert.equal(store.drawers.length, 1)

  primeRoute("/")
  assert.equal(store.drawers.length, 0)
  assert.equal(store.routeThreadSlug, null)
})

test("a direct route reopens the closing layer instead of appending a duplicate", () => {
  resetStore()
  boardWith([{ id: "rapid-forward" }])
  primeRoute("/thread/rapid-forward")
  resolveRoutedThread()
  const closingId = store.drawers[0]?.id
  assert.ok(closingId)
  markDrawerClosing(closingId)

  primeRoute("/thread/rapid-forward")
  resolveRoutedThread()

  assert.equal(store.drawers.length, 1)
  assert.deepEqual(
    Object.fromEntries(Object.entries(store.drawers[0] ?? {}).filter(([key]) => ["kind", "slug", "routed", "closing"].includes(key))),
    { kind: "thread", slug: "rapid-forward", routed: true },
  )
})

test("landing on a thread already in the stack unwinds above it and parks nothing", () => {
  resetStore()
  boardWith([{ id: "below" }, { id: "above" }])
  primeRoute("/thread/below")
  resolveRoutedThread()
  primeRoute("/thread/above")
  resolveRoutedThread()
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

  // `/status/<s>` was a list view until 2026-09-28; it is an unknown path now, which is the page.
  assert.doesNotThrow(() => primeRoute("/status/%"))
  assert.equal(store.drawers.length, 0)
  assert.equal(store.routeThreadSlug, null)
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

// A drawer opened STORE-first — a row of the page's own project, every row in focus mode — has its
// address written by the store → URL writer, and the route applies it a beat later (react-router commits
// history first, the route's effects after, and TWO of them apply it: App re-registering the writer, and
// useRouteToStore). Closed inside that beat, the close was held back by the guard above and then UNDONE
// when the route applied the drawer's address: the drawer re-opened and Escape did nothing (6 of 6 tries
// on a loaded machine, 2026-09-29). An address the writer wrote that arrives while a write is held back
// is absorbed without being applied; an address from anywhere else, or the writer's own with nothing held
// back, still is.
test("a drawer closed before the route has applied its own address stays closed", async () => {
  resetStore()
  const globals = globalThis as typeof globalThis & { location?: Location }
  const previous = globals.location
  const navigated: string[] = []
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  try {
    globals.location = { pathname: "/all" } as unknown as Location
    // The router writes history at once, as react-router does; the route applies it only when told to.
    const stop = startRouter((path) => {
      navigated.push(path)
      globals.location = { pathname: new URL(path, "http://page").pathname } as unknown as Location
    })
    store.drawers = [{ id: 1, kind: "thread", slug: "t" } as never]
    await settle()
    assert.deepEqual(navigated, ["/thread/t"], "opening the drawer writes its address")

    // Escape, before the route has applied that address.
    store.drawers = []
    await settle()
    assert.deepEqual(navigated, ["/thread/t"], "the close waits for the route")

    // Both of the commit's applications, back to back as its effects run them.
    applyLocation("/thread/t")
    applyLocation("/thread/t")
    await settle()
    assert.equal(store.routeThreadSlug, null, "the drawer's own address did not park it again")
    assert.equal(store.drawers.length, 0, "…or re-open it")
    assert.deepEqual(navigated, ["/thread/t", "/all"], "and the held-back close is written")
    applyLocation("/all")

    // CONTROL: the same address arriving from outside — Back, a link, a reload — is applied.
    globals.location = { pathname: "/thread/t" } as unknown as Location
    applyLocation("/thread/t")
    assert.equal(store.routeThreadSlug, "t", "an address the store did not write is still applied")
    stop()
  } finally {
    globals.location = previous
    resetStore()
  }
})

// The writer's own address with NOTHING held back is applied like any other: it is what clears a slug
// left parked when the page comes back from /full to the drawer it left, and skipping it there left the
// address on a drawer the reader had since closed.
test("the writer's own address is applied when the store has not moved past it", async () => {
  resetStore()
  const globals = globalThis as typeof globalThis & { location?: Location }
  const previous = globals.location
  const navigated: string[] = []
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  try {
    globals.location = { pathname: "/all" } as unknown as Location
    const stop = startRouter((path) => {
      navigated.push(path)
      globals.location = { pathname: new URL(path, "http://page").pathname } as unknown as Location
    })
    store.drawers = [{ id: 1, kind: "thread", slug: "t" } as never]
    await settle()
    assert.deepEqual(navigated, ["/thread/t"])
    store.routeThreadSlug = "t" // a slug parked meanwhile, which applying the address settles
    applyLocation("/thread/t")
    assert.equal(store.routeThreadSlug, null, "applied: the drawer is in the stack, so nothing stays parked")
    stop()
  } finally {
    globals.location = previous
    resetStore()
  }
})

// THE WAY BACK FROM /full opens the drawer in the page's FIRST render (store.ts primeFullscreenReturn),
// and the page's route effects — its store → URL writer and useRouteToStore — run only after the return's
// view transition lets them, over a second later on a loaded machine. An Escape in that window closed the
// drawer with no writer to record it, and the route then applied the drawer's address: parked, settled by
// the board, re-opened (3 to 5 of 6 tries, 2026-09-29). The page opened on that address, so a close before
// the route caught up is the store moving past it, like a write held back.
test("a drawer the return from /full opened, closed before the route caught up, stays closed", async () => {
  const globals = globalThis as typeof globalThis & { location?: Location; window?: Window & typeof globalThis }
  const previous = { location: globals.location, window: globals.window }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  // The return leg, up to the page's first effects: /full rendered, then the page primed its drawer.
  const returnTo = () => {
    resetStore()
    globals.location = { pathname: "/thread/t" } as unknown as Location
    boardWith([{ id: "t" }])
    noteStandaloneThreadRender("t")
    primeReturnFromFullscreen("t")
  }
  const effects = (navigated: string[]) => {
    const stop = startRouter((path) => {
      navigated.push(path)
      globals.location = { pathname: new URL(path, "http://page").pathname } as unknown as Location
    })
    applyLocation(globals.location!.pathname)
    return stop
  }
  try {
    globals.window = { setTimeout: () => 0 } as unknown as Window & typeof globalThis
    returnTo()
    assert.deepEqual(store.drawers.map((d) => d.slug), ["t"], "the page opens on the drawer")
    store.drawers = [] // Escape, before any route effect has run
    const navigated: string[] = []
    const stop = effects(navigated)
    await settle()
    resolveRoutedThread() // the render the board is authoritative on
    assert.equal(store.routeThreadSlug, null, "the drawer's address did not park it again")
    assert.equal(store.drawers.length, 0, "…or re-open it")
    assert.deepEqual(navigated, ["/all"], "and the close is written")
    stop()

    // CONTROL: left open, the same return applies its address and writes nothing.
    returnTo()
    const untouched: string[] = []
    const stopUntouched = effects(untouched)
    await settle()
    resolveRoutedThread()
    assert.deepEqual(store.drawers.map((d) => d.slug), ["t"], "the drawer stays up")
    assert.deepEqual(untouched, [], "and the address stays on it")
    stopUntouched()
  } finally {
    globals.location = previous.location
    globals.window = previous.window
    resetStore()
  }
})

// Back after a LATERAL move — thread A, then a transcript link or a sidebar row to thread B. The
// one-drawer policy replaced A with B, so Back lands on A's entry with A gone and B still on top. The
// router used to park A and leave B up, and the store→URL sync then pushed B's URL over A's (and
// settling A pushed A's over that): every Back press grew the history by two and flipped between the
// threads, on the phone and the desktop alike. Back must be a pure pop: no write, and A on top.
test("Back onto a thread a lateral move replaced pops without writing history", async () => {
  resetStore()
  const globals = globalThis as typeof globalThis & { location?: Location }
  const previous = globals.location
  const writes: Array<{ path: string; replace: boolean }> = []
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  globals.location = { pathname: "/" } as unknown as Location
  const stop = startRouter((path, { replace }) => {
    writes.push({ path, replace })
    globals.location = { pathname: path } as unknown as Location
  })
  try {
    boardWith([{ id: "thread-a" }, { id: "thread-b" }])
    pushDrawer("thread", "thread-a")
    await settle()
    applyLocation("/thread/thread-a")
    pushDrawer("thread", "thread-b")
    await settle()
    applyLocation("/thread/thread-b")
    assert.deepEqual(writes, [{ path: "/thread/thread-a", replace: false }, { path: "/thread/thread-b", replace: false }])
    assert.deepEqual(store.drawers.filter((d) => !d.closing).map((d) => d.slug), ["thread-b"], "the lateral move replaced A")

    // Back: the browser is already on A's entry; the route tree applies it (routes.tsx useRouteToStore),
    // then App settles the parked slug once the board is there (resolveRoutedThread).
    writes.length = 0
    globals.location = { pathname: "/thread/thread-a" } as unknown as Location
    primeRoute("/thread/thread-a")
    await settle()
    resolveRoutedThread()
    await settle()
    assert.deepEqual(writes, [], "Back pushes nothing — it was a pop")
    assert.deepEqual(store.drawers.filter((d) => !d.closing).map((d) => d.slug), ["thread-a"])

    // And the next Back reaches the page, again without a write.
    globals.location = { pathname: "/" } as unknown as Location
    primeRoute("/")
    await settle()
    assert.deepEqual(writes, [])
    assert.equal(store.drawers.filter((d) => !d.closing).length, 0)
  } finally {
    stop()
    globals.location = previous
    resetStore()
  }
})

// A navigation issued while react-router's view transition is running — the way back from /full is one —
// moved history and the router but was not rendered, leaving the page on the address it was leaving
// (2026-09-29). The writer holds its write until the transition has finished.
test("the store → URL writer waits out react-router's view transition", async () => {
  resetStore()
  const globals = globalThis as typeof globalThis & { location?: Location }
  const previous = globals.location
  const navigated: string[] = []
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  try {
    globals.location = { pathname: "/" } as unknown as Location
    const stop = startRouter((path) => {
      navigated.push(path)
      globals.location = { pathname: new URL(path, "http://page").pathname } as unknown as Location
    })
    noteRouterTransition(true)
    store.drawers = [{ id: 1, kind: "thread", slug: "t" } as never]
    await settle()
    assert.deepEqual(navigated, [], "nothing is written while the transition runs")
    noteRouterTransition(false)
    await settle()
    assert.deepEqual(navigated, ["/thread/t"], "and the write lands as it finishes")
    stop()
  } finally {
    noteRouterTransition(false)
    globals.location = previous
    resetStore()
  }
})

// The phone thread header's ← pops history only when the entry under the thread is ours. react-router
// numbers its entries from 0 at document load, so 0 (or no router state at all) is a cold link.
test("appPushedCurrentEntry: only an entry the router pushed above the document's first counts", () => {
  assert.equal(appPushedCurrentEntry({ usr: null, key: "a", idx: 1 }), true)
  assert.equal(appPushedCurrentEntry({ usr: null, key: "b", idx: 4, ntwineLayer: 9 }), true)
  assert.equal(appPushedCurrentEntry({ idx: 0 }), false)
  assert.equal(appPushedCurrentEntry({ usr: null, key: "c" }), false)
  assert.equal(appPushedCurrentEntry(null), false)
  assert.equal(appPushedCurrentEntry("not-an-object"), false)
})

// The history entry the page is on, as react-router writes it: `idx` 0 is the entry a document loaded on.
function withHistoryState(state: unknown, body: () => void): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "history")
  Object.defineProperty(globalThis, "history", { configurable: true, writable: true, value: { state } })
  try {
    body()
  } finally {
    if (previous) Object.defineProperty(globalThis, "history", previous)
    else Reflect.deleteProperty(globalThis, "history")
  }
}

// A COLD LINK to a queued thread lands on its card on a project's board (upstream's deep link, plans/
// upstream-superset.md §3); the board registers how (AllQueues.tsx useRoutedLanding).
test("a cold link to a thread the board has a card for lands on the card, and leaves the thread's address", () => {
  const asked: string[] = []
  const unregister = registerRoutedLanding((slug) => {
    asked.push(slug)
    return "landed"
  })
  try {
    withHistoryState({ usr: null, key: "a", idx: 0 }, () => {
      resetStore()
      primeRoute("/thread/q-1")
      boardWith([{ id: "q-1", needsYou: true }])
      resolveRoutedThread()
      assert.deepEqual(asked, ["q-1"])
      assert.equal(store.drawers.length, 0, "no drawer over the card")
      assert.equal(store.routeThreadSlug, null, "the address goes back to the board's")
    })
  } finally {
    unregister()
    resetStore()
  }
})

test("a thread with no card opens its drawer; a queue still loading keeps the slug parked until it can say", () => {
  let answer: "landed" | "absent" | "pending" = "pending"
  const unregister = registerRoutedLanding(() => answer)
  try {
    withHistoryState({ idx: 0 }, () => {
      resetStore()
      primeRoute("/thread/w-1")
      boardWith([{ id: "w-1" }])
      resolveRoutedThread()
      assert.equal(store.routeThreadSlug, "w-1", "parked while the board's queue is unknown")
      assert.equal(store.drawers.length, 0)
      answer = "absent"
      resolveRoutedThread()
      assert.deepEqual(store.drawers.map(({ slug, routed }) => ({ slug, routed })), [{ slug: "w-1", routed: true }])
      assert.equal(store.routeThreadSlug, null)
    })
  } finally {
    unregister()
    resetStore()
  }
})

test("an entry this tab pushed — a drawer it opened, reloaded or gone back to — reopens the drawer, never the card", () => {
  let asked = 0
  const unregister = registerRoutedLanding(() => {
    asked++
    return "landed"
  })
  try {
    for (const state of [{ usr: null, key: "b", idx: 3 }, { usr: { inPlace: true }, key: "c", idx: 0 }]) {
      withHistoryState(state, () => {
        resetStore()
        primeRoute("/thread/q-1")
        boardWith([{ id: "q-1", needsYou: true }])
        resolveRoutedThread()
        assert.equal(store.drawers[0]?.slug, "q-1", JSON.stringify(state))
      })
    }
    // A drawer already up is the reader's: an address that arrives over it opens a drawer too.
    withHistoryState({ idx: 0 }, () => {
      resetStore()
      primeRoute("/thread/q-1")
      boardWith([{ id: "q-1", needsYou: true }, { id: "open" }])
      store.drawers = [{ id: "d1", kind: "thread", slug: "open" }] as typeof store.drawers
      resolveRoutedThread()
      assert.equal(store.drawers.at(-1)?.slug, "q-1")
    })
    assert.equal(asked, 0)
  } finally {
    unregister()
    resetStore()
  }
})
