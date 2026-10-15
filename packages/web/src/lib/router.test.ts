import { test } from "node:test"
import assert from "node:assert/strict"
import type { BoardSnapshot } from "@ntwine/shared"
import { markDrawerClosing, pushDrawer, registerRoutedLanding, resolveRoutedThread, store } from "../store.ts"
import { applyLocation, appPushedCurrentEntry, primeRoute, startRouter } from "./router.ts"

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
test("a routed slug this board does not have opens in the project that has it", async () => {
  resetStore()
  const globals = globalThis as typeof globalThis & { location?: Location }
  const previous = { location: globals.location, fetch: globalThis.fetch }
  const replaced: string[] = []
  const asked: string[] = []
  globals.location = { pathname: "/", origin: "http://page", replace: (url: string) => replaced.push(url) } as unknown as Location
  let owners = [{ projectSlug: "elsewhere", projectName: "Elsewhere" }]
  globalThis.fetch = (async (input: unknown) => {
    asked.push(new URL(String(input)).pathname.split("/").pop()!)
    return new Response(JSON.stringify({ result: owners }), { headers: { "content-type": "application/json" } })
  }) as typeof fetch
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  try {
    boardWith([{ id: "present" }])
    primeRoute("/thread/lives-elsewhere")
    resolveRoutedThread()
    assert.equal(store.drawers.length, 0, "no empty drawer is opened over the board")
    for (let i = 0; i < 5 && replaced.length === 0; i++) await settle()
    assert.deepEqual(asked, ["threadLocate"])
    assert.deepEqual(replaced, ["/all/elsewhere/thread/lives-elsewhere"], "its drawer, in the project that has it")

    // Nobody has it: the page stays, and says so.
    replaced.length = 0
    owners = []
    primeRoute("/thread/nowhere")
    resolveRoutedThread()
    for (let i = 0; i < 5 && store.toast === null; i++) await settle()
    assert.deepEqual(replaced, [])
    assert.equal(store.toast?.text, "No thread named nowhere")

    // A thread this board DOES have is unaffected: it still opens in place, with no lookup.
    asked.length = 0
    primeRoute("/thread/present")
    resolveRoutedThread()
    assert.deepEqual(asked, [])
    assert.equal(store.drawers.length, 1)
    assert.equal(store.drawers[0].slug, "present")
  } finally {
    globals.location = previous.location
    globalThis.fetch = previous.fetch
    store.toast = null
  }
})

// The writer's own address with NOTHING held back is applied like any other: it is what clears a slug
// left parked while its drawer was already in the stack.
test("the writer's own address is applied when the store has not moved past it", async () => {
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
