import assert from "node:assert/strict"
import test from "node:test"

// THE PAGE IN EMBED MODE, end to end through the real modules: this file boots them under a frame's
// globals — `?embed=vscode&theme=dark` on the address, a parent that records what it is posted — and
// then asks the questions a sidebar depends on. Embed mode is read once per page (lib/embed.ts), so it
// has a test file, and a process, of its own; everything is imported only after the globals are set.

const posted: unknown[] = []
const session = new Map<string, string>()
const local = new Map<string, string>([["ntwine-theme", "light"]])
const props = new Map<string, string>()
const root = {
  dataset: {} as Record<string, string>,
  style: { setProperty: (name: string, value: string) => void props.set(name, value), removeProperty: (name: string) => void props.delete(name) } as unknown as Record<string, string>,
}
const fetched: string[] = []

Object.assign(globalThis, {
  window: Object.assign(globalThis, {
    parent: { postMessage: (message: unknown) => posted.push(message) },
    // A sidebar dragged wide: the 700px phone query does NOT match.
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
  }),
  location: { search: "?embed=vscode&theme=dark&project=nub", pathname: "/", href: "http://127.0.0.1:9393/?embed=vscode&theme=dark&project=nub", origin: "http://127.0.0.1:9393" },
  sessionStorage: { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => void session.set(k, v), removeItem: (k: string) => void session.delete(k) },
  localStorage: { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => void local.set(k, v), removeItem: (k: string) => void local.delete(k) },
  document: { documentElement: root, querySelector: () => null, querySelectorAll: () => [], hasFocus: () => false, visibilityState: "visible", addEventListener() {} },
  fetch: async (url: string) => {
    fetched.push(String(url))
    throw new Error("no server in this test")
  },
})

const { embedded } = await import("./embed.ts")
const { phoneLayout } = await import("./mobile.ts")
const { openLocalPath } = await import("./local-file-links.ts")
const { openExternalUrl } = await import("./external-links.ts")
const { getThemeSnapshot, initTheme, setHostTheme } = await import("./theme.ts")
const { store } = await import("../store.ts")
const { composePending } = await import("./editorBridge.ts")
const { runHostCommand } = await import("./embedCommand.ts")
const { reportRoute, repostRoute } = await import("./embedRoute.ts")
const { hostKeyChord } = await import("./embed.ts")

test("the address's embed mode is kept for the frame's session", () => {
  assert.equal(embedded(), true)
  assert.deepEqual(JSON.parse(session.get("ntwine.embed")!), { host: "vscode", theme: "dark" })
})

test("a sidebar is never the phone, at any width", () => {
  // Wide: the 700px query does not match.
  assert.equal(phoneLayout(), false)
  // Phone-narrow: still not the phone — a sidebar has a pointer and a keyboard, and takes the desktop's
  // inline question cards, type scale and Settings rather than the phone's sheets and big targets.
  const wide = window.matchMedia
  window.matchMedia = (() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  try {
    assert.equal(phoneLayout(), false)
  } finally {
    window.matchMedia = wide
  }
})

test("the title row's buttons are the app's own doors", () => {
  const reset = () => Object.assign(store, { showSettings: false, showPalette: false, showShortcuts: false, showNewThread: false, drawers: [] })
  reset()
  runHostCommand("jump")
  assert.equal(store.showPalette, true, "⌘K's palette")
  store.showShortcuts = true
  runHostCommand("settings")
  assert.deepEqual([store.showSettings, store.showPalette, store.showShortcuts], [true, false, false], "⌘,'s Settings, over whatever was up")
  // Back to the queue: every drawer goes, and Settings with them.
  store.drawers = [{ id: 1, kind: "thread", slug: "a", closing: false, openedAt: 1 }, { id: 2, kind: "doc", slug: "a", closing: false, openedAt: 2 }] as typeof store.drawers
  runHostCommand("queue")
  assert.equal(store.showSettings, false)
  assert.deepEqual(store.drawers.filter((drawer) => !drawer.closing), [], "every drawer closed")
  // New thread with no page box in this test's document: `c`'s door falls back to the new-thread dialog.
  reset()
  runHostCommand("new-thread")
  assert.equal(store.showNewThread, true)
  // Keyboard shortcuts, from the row's ⋯: `?`'s sheet over the page as it is — an open thread stays,
  // the palette goes as for any button, and so does Settings, which a browser's `?` waits on.
  reset()
  store.drawers = [{ id: 3, kind: "thread", slug: "a", closing: false, openedAt: 3 }] as typeof store.drawers
  store.showPalette = true
  runHostCommand("shortcuts")
  assert.deepEqual([store.showShortcuts, store.showPalette, store.drawers.length], [true, false, 1])
  store.showShortcuts = false
  store.showSettings = true
  runHostCommand("shortcuts")
  assert.deepEqual([store.showShortcuts, store.showSettings], [true, false])
  reset()
})

test("⌘L in the page goes back to the editor: forwarded to VS Code like its own chords, never taken here", () => {
  const key = (over: Partial<KeyboardEvent>) =>
    ({ key: "l", code: "KeyL", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, defaultPrevented: false, repeat: false, isComposing: false, ...over }) as KeyboardEvent
  // The page forwards it (the extension maps it to "focus the editor": packages/vscode embed.ts CHORDS)…
  assert.deepEqual(hostKeyChord(key({})), { type: "ntwine:key", key: "l", code: "KeyL", ctrl: true, meta: false, shift: false, alt: false })
  assert.deepEqual(hostKeyChord(key({ ctrlKey: false, metaKey: true })), { type: "ntwine:key", key: "l", code: "KeyL", ctrl: false, meta: true, shift: false, alt: false })
  // …unless a box here took it first.
  assert.equal(hostKeyChord(key({ defaultPrevented: true })), null)
})

test("the editor's Ctrl+L with nothing selected puts the caret in the prompt box in front", () => {
  const reset = () => Object.assign(store, { showSettings: false, showPalette: false, showShortcuts: false, showNewThread: false, drawers: [] })
  reset()
  // No box rendered in this test's document: the chord still ends in a prompt box — `c`'s door, the dialog.
  runHostCommand("prompt")
  assert.equal(store.showNewThread, true)
  // Over an open thread with no reply box to take it, the same; the drawer stays where it was.
  reset()
  store.drawers = [{ id: 4, kind: "thread", slug: "a", closing: false, openedAt: 4 }] as typeof store.drawers
  store.showPalette = true
  runHostCommand("prompt")
  assert.deepEqual([store.showNewThread, store.showPalette, store.drawers.length], [true, false, 1])
  reset()
})

test("the title row hears the view only when it changes, and again after ready", () => {
  posted.length = 0
  reportRoute({ view: "queue", title: "acme-api", description: "1 needs you · 4 ready" })
  reportRoute({ view: "queue", title: "acme-api", description: "1 needs you · 4 ready" })
  reportRoute({ view: "thread", title: "Split the constants" })
  assert.deepEqual(posted, [
    { type: "ntwine:route", view: "queue", title: "acme-api", description: "1 needs you · 4 ready" },
    { type: "ntwine:route", view: "thread", title: "Split the constants" },
  ])
  posted.length = 0
  repostRoute()
  assert.deepEqual(posted, [{ type: "ntwine:route", view: "thread", title: "Split the constants" }])
})

test("a code file goes to the editor with its place, never to the reader or the server", async () => {
  posted.length = 0
  openLocalPath("/repo/src/a.ts", null, null, { line: 12, column: 3, endLine: 20 })
  assert.deepEqual(posted, [{ type: "ntwine:open-file", path: "/repo/src/a.ts", line: 12, column: 3, endLine: 20 }])
  posted.length = 0
  openLocalPath("/repo/Makefile")
  assert.deepEqual(posted, [{ type: "ntwine:open-file", path: "/repo/Makefile" }])
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(store.drawers.length, 0, "no reader opened")
  assert.deepEqual(fetched, [], "nothing asked of the server")
})

test("Markdown still opens in Ntwine's reader", () => {
  posted.length = 0
  openLocalPath("/repo/README.md")
  assert.deepEqual(posted, [])
  assert.deepEqual(store.drawers.map((drawer) => drawer.kind === "file" && drawer.path), ["/repo/README.md"])
})

test("a web page opened from code goes to the editor, and only http(s) does", () => {
  posted.length = 0
  openExternalUrl("https://github.com/acme/app/pull/12")
  openExternalUrl("javascript:alert(1)")
  assert.deepEqual(posted, [{ type: "ntwine:open-external", url: "https://github.com/acme/app/pull/12" }])
})

test("the editor's theme wins for the session and never touches the stored preference", () => {
  initTheme()
  assert.deepEqual(getThemeSnapshot(), { preference: "light", resolved: "dark" })
  assert.equal(root.dataset.theme, "dark")
  setHostTheme("light")
  assert.deepEqual(getThemeSnapshot(), { preference: "light", resolved: "light" })
  setHostTheme("dark")
  assert.equal(root.dataset.theme, "dark")
  assert.equal(local.get("ntwine-theme"), "light", "the preference is the human's, untouched")
  assert.equal(JSON.parse(session.get("ntwine.embed")!).theme, "dark", "a reload of this frame keeps the editor's latest")
})

test("the editor's colours: worn on the root under VS Code's names while it sends them, gone when it stops", () => {
  // Default Dark Modern, as a real VS Code 1.140 writes it on the webview (scripts/e2e-sidebar.ts c18).
  const colors = { "sideBar-background": "#181818", foreground: "#cccccc", descriptionForeground: "#9d9d9d", focusBorder: "#0078d4", "panel-border": "#2b2b2b" }
  setHostTheme("dark", { colors })
  assert.equal(root.dataset.hostColors, "sideBar")
  assert.equal(props.get("--vscode-sideBar-background"), "#181818")
  assert.equal(props.get("--vscode-focusBorder"), "#0078d4")
  // The focus blue is 3.9:1 on that side bar; as text it is lifted toward the foreground to 4.5.
  assert.ok(props.get("--host-accent") && props.get("--host-accent") !== "#0078d4", props.get("--host-accent"))
  assert.ok(props.get("--host-muted"))
  assert.deepEqual(JSON.parse(session.get("ntwine.embed")!).palette, { colors }, "a reload of this frame paints them first")
  // An editor tab's frame takes the editor's background instead; high contrast is marked.
  setHostTheme("dark", { colors: { "editor-background": "#000000", foreground: "#ffffff" }, surface: "editor", contrast: true })
  assert.equal(root.dataset.hostColors, "editor")
  assert.equal(root.dataset.hostContrast, "")
  assert.equal(props.has("--vscode-sideBar-background"), false, "a colour the new theme lacks is not left over from the old")
  // ntwine.matchEditorTheme turned off: the next theme message has no colours.
  setHostTheme("dark")
  assert.equal(root.dataset.hostColors, undefined)
  assert.equal(root.dataset.hostContrast, undefined)
  assert.deepEqual([...props.keys()], [])
  assert.equal(JSON.parse(session.get("ntwine.embed")!).palette, undefined)
})

test("a sidebar never claims an item the server holds for a browser tab", async () => {
  // Focused, with a board in: everything a browser tab needs to claim on `compose-pending`. The extension
  // posts its own selections into the sidebar (ntwine:compose); a held item is a window WITHOUT a sidebar's.
  const document = globalThis.document as unknown as { hasFocus(): boolean }
  const hasFocus = document.hasFocus
  document.hasFocus = () => true
  store.board = { threads: [], projectDir: "/repo" } as unknown as typeof store.board
  fetched.length = 0
  try {
    composePending()
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(fetched.filter((url) => url.includes("composeTake")), [])
  } finally {
    document.hasFocus = hasFocus
    store.board = null
  }
})
