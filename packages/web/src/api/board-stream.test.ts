import { test } from "node:test"
import assert from "node:assert/strict"
import type { ServerEvent } from "@ntwine/shared"
import { BoardStream, notify } from "./board-stream.ts"
import { setHomeFocus } from "../lib/base-path.ts"
import { store } from "../store.ts"

test("BoardStream forwards typed-interaction invalidations without treating them as board deltas", () => {
  const seen: ServerEvent[] = []
  let resyncs = 0
  const stream = new BoardStream(() => resyncs++, (event) => seen.push(event))
  const event = {
    type: "interactions-invalidated",
    slug: "owned-thread",
    sessionId: "session-1",
    interactionId: "interaction-1",
    lifecycle: "pending",
    recordRevision: 0,
  } as const satisfies ServerEvent

  stream.handle(event)

  assert.deepEqual(seen, [event])
  assert.equal(resyncs, 0)
})

// The editor bridge's events are machine-wide and ride every project's bus: the windows land in the store
// whole (replacing, never merging — a window that closed is gone), and a compose ping on a page nobody is
// looking at claims nothing (lib/editorBridge.ts) — neither is a board frame, so neither resyncs.
test("BoardStream takes the editor windows whole and leaves a compose ping to the page in front", () => {
  let resyncs = 0
  const stream = new BoardStream(() => resyncs++)
  const windows = [{ app: "Visual Studio Code", kind: "vscode", acceptsOpens: true }] as const
  stream.handle({ type: "editors", windows: [...windows, { app: "Cursor", kind: "cursor", acceptsOpens: false }] })
  stream.handle({ type: "editors", windows: [...windows] })
  assert.deepEqual(store.editorWindows, windows)
  stream.handle({ type: "compose-pending", id: "c1" })
  assert.equal(resyncs, 0)
  store.editorWindows = []
})

// The one event that is not about the stream's own board: another tab reordered the rail (or renamed a
// project, or added one), and this tab has to hear about it without a reload. It carries no seq, so it
// must neither be sequenced against the board nor disturb the board's own sequence.
test("BoardStream reports a changed project list without touching the board's sequence", () => {
  let resyncs = 0
  let changes = 0
  const stream = new BoardStream(() => resyncs++, () => {}, () => changes++)

  stream.handle({ type: "projects-changed" })
  stream.handle({ type: "projects-changed" })

  assert.equal(changes, 2)
  assert.equal(resyncs, 0, "with no keyframe adopted, a board delta would resync here — this is not one")
})

// A DESKTOP NOTIFICATION IS CLICKED LATER — often much later, since it is only ever raised while the
// window is hidden. By then the tab may be showing a different project, and `openThread` opens a slug
// in whatever project is showing. Slugs are unique only WITHIN a project, so the click did not fail
// and say so: it opened a DIFFERENT thread that happened to share the name. The last place in the
// client where "which project" was resolved at the moment of use rather than travelling with the work.
test("a notification click opens the thread in the project it was raised for, not the one on screen", () => {
  const globals = new Map<PropertyKey, PropertyDescriptor | undefined>()
  const install = (key: PropertyKey, value: unknown) => {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  const raised: { onclick: (() => void) | null }[] = []
  class FakeNotification {
    static permission = "granted"
    onclick: (() => void) | null = null
    constructor(readonly title: string, readonly opts: { body?: string; tag?: string }) { raised.push(this) }
    close(): void {}
  }
  // The page is Everything at `/`; which project it is showing is its FOCUS (lib/base-path.ts).
  const here = { pathname: "/", assign: (url: string) => { assigned.push(url) } }
  setHomeFocus("alpha")
  let assigned: string[] = []
  install("Notification", FakeNotification)
  install("document", { hidden: true })
  install("window", { focus: () => {} })
  install("location", here)

  const drawersBefore = store.drawers.length
  const notificationsBefore = store.notificationsEnabled
  store.notificationsEnabled = true

  try {
    const event = { type: "notify", slug: "fix-auth", title: "Done", body: "…" } as const satisfies ServerEvent

    // Raised on alpha, clicked on alpha: the in-app drawer, no navigation.
    notify(event)
    raised.at(-1)!.onclick!()
    assert.deepEqual(assigned, [], "the same project needs no document load")
    assert.equal(store.drawers.length, drawersBefore + 1, "it opens the thread in place")
    store.drawers = []

    // Raised on alpha, clicked after the tab moved to beta: beta must not open ITS `fix-auth`.
    assigned = []
    setHomeFocus("alpha")
    notify(event)
    setHomeFocus("beta")
    raised.at(-1)!.onclick!()
    assert.deepEqual(assigned, ["/all/alpha/thread/fix-auth"], "the click follows the notification's own project")
    assert.equal(store.drawers.length, 0, "and opens nothing on the project that happens to be showing")
  } finally {
    setHomeFocus(undefined)
    store.drawers = []
    store.notificationsEnabled = notificationsBefore
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
