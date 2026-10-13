import { test } from "node:test"
import assert from "node:assert/strict"
import { runInNewContext } from "node:vm"
import { contentSecurityPolicy, frameDocument, HINT, HINT_OLD_NTWINE, messageDocument, scriptJson } from "./sidebar-html.ts"

const NTWINE = "http://127.0.0.1:9393"
const URL_ = `${NTWINE}/?embed=vscode&theme=dark&project=a%22b`
const WEBVIEW = "vscode-webview://0abc"

const cspOf = (html: string) => /http-equiv="Content-Security-Policy" content="([^"]*)"/u.exec(html)?.[1]

test("the frame document frames exactly Ntwine's origin and runs only its own nonce'd code", () => {
  const html = frameDocument({ nonce: "N0nce", url: URL_, origin: NTWINE })
  assert.equal(cspOf(html), `default-src 'none'; frame-src ${NTWINE}; style-src 'nonce-N0nce'; script-src 'nonce-N0nce'`)
  const frames = [...html.matchAll(/<iframe [^>]*>/gu)].map((match) => match[0])
  // No src in the markup: the relay sets it, with the editor's colours on its fragment (below).
  assert.deepEqual(frames, [`<iframe id="ntwine" title="Ntwine" allow="clipboard-read; clipboard-write; local-network-access">`])
  assert.deepEqual([...html.matchAll(/<script\b[^>]*>/gu)].map((match) => match[0]), ['<script nonce="N0nce">'])
  assert.deepEqual([...html.matchAll(/<style\b[^>]*>/gu)].map((match) => match[0]), ['<style nonce="N0nce">'])
  assert.doesNotMatch(html, /\son[a-z]+=/u, "no inline handlers, which the policy would block anyway")
})

test("the frame document refuses an origin that is not the URL's, or not a plain web origin", () => {
  assert.throws(() => frameDocument({ nonce: "n", url: "http://evil.example/", origin: NTWINE }))
  assert.throws(() => frameDocument({ nonce: "n", url: "http://a;b/", origin: "http://a;b" }))
})

test("a message document escapes its copy and frames nothing", () => {
  const html = messageDocument({ nonce: "n", text: `Ntwine said <img src=x onerror="alert(1)">`, actions: [{ action: "retry", label: "Try <again>" }] })
  assert.equal(cspOf(html), contentSecurityPolicy("n"))
  assert.doesNotMatch(cspOf(html)!, /frame-src/u)
  assert.match(html, /Ntwine said &lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/u)
  assert.match(html, /<button type="button" data-action="retry">Try &lt;again&gt;<\/button>/u)
  assert.doesNotMatch(html, /<iframe/u)
})

// ── the relay, run for real against stand-ins for the three windows ────────────────────────────────────

interface Relay {
  toHost: unknown[]
  /** What the relay kept as VS Code's webview state (`setState`), the last value it set. */
  state: unknown
  toPage: { data: unknown; targetOrigin: string }[]
  frameWindow: object
  /** VS Code's host frame, which is NOT `window.parent` in a webview document. */
  hostFrame: object
  hint: { hidden: boolean }
  hintText: { textContent: string }
  focused: number
  /** Times the PAGE's window was focused (`frame.contentWindow.focus()`). */
  pageFocused: number
  dispatch(event: { source: unknown; origin: string; data: unknown }): void
  /** The relay's window gains focus with `active` its focused element; the listener's timer has run when it resolves. */
  windowFocus(active: "body" | "frame"): Promise<void>
  /** What the relay set the frame's address to. */
  src(): string
  /** The frame finishes loading a document. */
  frameLoad(): void
  /** VS Code rewrites the theme on this document: its custom properties and its body's class. */
  restyle(vars: Record<string, string>, bodyClass: string): void
}

/** As VS Code 1.140 writes Default Dark Modern on a webview document (scripts/e2e-sidebar.ts c18). */
const DARK_MODERN = { "--vscode-sideBar-background": "#181818", "--vscode-foreground": "#cccccc", "--vscode-focusBorder": "#0078d4", "--vscode-not-ours": "#123456" }

function relay(html: string, theme: { vars: Record<string, string>; bodyClass: string } = { vars: DARK_MODERN, bodyClass: "vscode-dark" }): Relay {
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/u.exec(html)![1]!
  const toHost: unknown[] = []
  const toPage: { data: unknown; targetOrigin: string }[] = []
  const frameWindow = { postMessage: (data: unknown, targetOrigin: string) => toPage.push({ data: structuredClone(data), targetOrigin }), focus: () => state.pageFocused++ }
  const hostFrame = {}
  const hint = { hidden: true }
  const hintText = { textContent: "" }
  const listeners: ((event: unknown) => void)[] = []
  const focusListeners: (() => void)[] = []
  const state = { focused: 0, pageFocused: 0, kept: undefined as unknown }
  const frameLoads: (() => void)[] = []
  const frame = {
    contentWindow: frameWindow,
    focus: () => state.focused++,
    src: "",
    addEventListener: (type: string, listener: () => void) => {
      if (type === "load") frameLoads.push(listener)
    },
  }
  const look = { vars: { ...theme.vars }, bodyClass: theme.bodyClass }
  const observers: (() => void)[] = []
  const body = { classList: { contains: (name: string) => look.bodyClass.split(" ").includes(name) } }
  const documentElement = {}
  const window = {
    origin: WEBVIEW,
    // As VS Code's injected API script leaves it in a webview document.
    get parent() {
      return window
    },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      if (type === "message") listeners.push(listener)
      if (type === "focus") focusListeners.push(listener as () => void)
    },
  }
  const document = { getElementById: (id: string) => (id === "ntwine" ? frame : id === "hint" ? hint : id === "hint-text" ? hintText : null), addEventListener() {}, body, documentElement, activeElement: null as unknown }
  runInNewContext(script, {
    // A clone, as postMessage makes one — and out of the script's realm, so deepEqual compares values.
    acquireVsCodeApi: () => ({ postMessage: (message: unknown) => toHost.push(structuredClone(message)), setState: (value: unknown) => (state.kept = structuredClone(value)) }),
    window,
    document,
    navigator: { platform: "Linux x86_64" },
    Element: class {},
    setTimeout,
    getComputedStyle: (element: unknown) => {
      assert.equal(element, documentElement, "the colours are read off the document's root, where VS Code writes them")
      return { getPropertyValue: (name: string) => look.vars[name] ?? "" }
    },
    MutationObserver: class {
      constructor(callback: () => void) {
        observers.push(callback)
      }
      observe() {}
    },
    encodeURIComponent,
    JSON,
  })
  return {
    toHost,
    get state() {
      return state.kept
    },
    toPage,
    frameWindow,
    hostFrame,
    hint,
    hintText,
    get focused() {
      return state.focused
    },
    get pageFocused() {
      return state.pageFocused
    },
    dispatch: (event) => listeners.forEach((listener) => listener(event)),
    src: () => frame.src,
    frameLoad: () => frameLoads.forEach((listener) => listener()),
    restyle(vars, bodyClass) {
      look.vars = { ...vars }
      look.bodyClass = bodyClass
      // One batch for the whole rewrite, as VS Code makes it; each observer (the root's, the body's) hears it.
      observers.forEach((callback) => callback())
    },
    async windowFocus(active) {
      document.activeElement = active === "body" ? document.body : frame
      focusListeners.forEach((listener) => listener())
      await new Promise((resolve) => setTimeout(resolve, 5))
    },
  }
}

test("the relay hands the host only what its own frame sent from Ntwine's origin", () => {
  const r = relay(frameDocument({ nonce: "n", url: URL_, origin: NTWINE }))
  assert.deepEqual(r.toHost, [{ view: "platform", mac: false }], "it says which platform the UI is on")
  r.toHost.length = 0
  const ready = { type: "ntwine:ready", v: 1 }
  r.dispatch({ source: r.frameWindow, origin: NTWINE, data: ready })
  assert.deepEqual(r.toHost, [{ page: ready }], "passed on unchanged, in the page envelope")
  r.dispatch({ source: r.frameWindow, origin: "http://evil.example", data: ready })
  r.dispatch({ source: r.frameWindow, origin: "http://127.0.0.1:9394", data: ready })
  r.dispatch({ source: {}, origin: NTWINE, data: ready })
  assert.equal(r.toHost.length, 1, "another origin in the frame, or another window at Ntwine's origin, is dropped")
  // Nothing from the page reaches the page back, or passes for one of the view's own messages.
  r.dispatch({ source: r.frameWindow, origin: NTWINE, data: { view: "reload" } })
  assert.deepEqual(r.toHost[1], { page: { view: "reload" } })
  assert.deepEqual(r.toPage, [])
})

test("the relay posts the host's ntwine: messages to the page at Ntwine's origin only, and keeps its own", () => {
  const r = relay(frameDocument({ nonce: "n", url: URL_, origin: NTWINE }))
  const compose = { type: "ntwine:compose", id: "1", item: { path: "/r/a.ts", app: "Code" }, target: "front", focus: false }
  r.dispatch({ source: r.hostFrame, origin: WEBVIEW, data: compose })
  assert.deepEqual(r.toPage, [{ data: compose, targetOrigin: NTWINE }])
  assert.equal(r.focused, 0, "focus false leaves focus alone")
  r.dispatch({ source: r.hostFrame, origin: WEBVIEW, data: { ...compose, id: "2", focus: true } })
  assert.equal(r.focused, 1, "focus true gives the frame the focus, so the page's caret shows")
  assert.equal(r.toPage.length, 2)

  r.dispatch({ source: r.hostFrame, origin: "http://evil.example", data: compose })
  r.dispatch({ source: r.hostFrame, origin: "vscode-webview://another-webview", data: compose })
  r.dispatch({ source: r.hostFrame, origin: WEBVIEW, data: { type: "other" } })
  r.dispatch({ source: r.hostFrame, origin: WEBVIEW, data: "ntwine:compose" })
  assert.equal(r.toPage.length, 2, "only a ntwine: object from the host frame")

  r.dispatch({ source: r.hostFrame, origin: WEBVIEW, data: { view: "hint", show: true } })
  assert.equal(r.hint.hidden, false)
  r.dispatch({ source: r.hostFrame, origin: WEBVIEW, data: { view: "hint", show: false } })
  assert.equal(r.hint.hidden, true)
  // A Ntwine from before the sidebar: the bar says so, in the extension's words.
  r.dispatch({ source: r.hostFrame, origin: WEBVIEW, data: { view: "hint", show: true, text: HINT_OLD_NTWINE } })
  assert.equal(r.hint.hidden, false)
  assert.equal(r.hintText.textContent, HINT_OLD_NTWINE)
  assert.equal(r.toPage.length, 2, "the view's own message never reaches the page")
})

test("the bar is drawn shut with the loading words, or open from the first paint with the words it is given", () => {
  const plain = frameDocument({ nonce: "n", url: URL_, origin: NTWINE })
  assert.match(plain, new RegExp(`<div class="hint" id="hint" role="status" hidden><p id="hint-text">${HINT.text.replace(/'/gu, "&#39;")}</p>`, "u"))
  const old = frameDocument({ nonce: "n", url: URL_, origin: NTWINE, hint: HINT_OLD_NTWINE })
  assert.match(old, /<div class="hint" id="hint" role="status"><p id="hint-text">This Ntwine is older than the sidebar\. Update Ntwine to use it here, or open it in your browser\.<\/p>/u)
})

test("focus landing on the relay goes on to the page — including when the frame is already its focused element", async () => {
  const r = relay(frameDocument({ nonce: "n", url: URL_, origin: NTWINE }))
  await r.windowFocus("body")
  assert.equal(r.focused, 1, "a view revealed, a click on its edge: the frame takes the focus")
  // VS Code's webview host focuses this WINDOW while it settles a view's focus. The relay's focused element is
  // still the frame, so nothing here moved — but the focused frame is now the relay's, and the page lost the
  // keyboard a beat after its caret landed (real VS Code e2e, c2: New thread after Back to queue, 1 run in 3).
  await r.windowFocus("frame")
  assert.equal(r.pageFocused, 1, "the page's window is focused, the frame element being focused already")
  assert.equal(r.focused, 1)
})

test("the relay tells the host when it takes the keyboard, so Ctrl+L knows which Ntwine was used last", async () => {
  const r = relay(frameDocument({ nonce: "n", url: URL_, origin: NTWINE }))
  r.toHost.length = 0
  await r.windowFocus("body")
  await r.windowFocus("frame")
  assert.deepEqual(r.toHost, [{ view: "focused" }, { view: "focused" }])
})

test("the relay tells the host each time the frame loads a document, so a page that reloaded itself is counted", () => {
  const r = relay(frameDocument({ nonce: "n", url: URL_, origin: NTWINE }))
  r.toHost.length = 0
  r.frameLoad()
  r.frameLoad()
  assert.deepEqual(r.toHost, [{ view: "loaded" }, { view: "loaded" }])
  assert.deepEqual(r.toPage, [], "the page hears nothing of it")
})

test("a thread's tab keeps its thread as the webview's state, and nothing at all without one", () => {
  assert.equal(relay(frameDocument({ nonce: "n", url: URL_, origin: NTWINE })).state, undefined)
  const tab = relay(frameDocument({ nonce: "n", url: URL_, origin: NTWINE, state: { project: "acme", thread: "fix-it" } }))
  assert.deepEqual(tab.state, { project: "acme", thread: "fix-it" })
  // Whatever a state holds cannot close the script it is written into.
  const html = frameDocument({ nonce: "n", url: URL_, origin: NTWINE, state: { project: "</script><script>alert(1)</script>", thread: "x" } })
  assert.equal((html.match(/<\/script>/gu) ?? []).length, 1)
  assert.equal(scriptJson({ a: "</script>\u2028" }), '{"a":"\\u003c/script>\\u2028"}')
})

test("the relay hands the page the editor's colours: on the first address, with each theme message, and on every theme switch", () => {
  const r = relay(frameDocument({ nonce: "n", url: URL_, origin: NTWINE }))
  const darkModern = { type: "ntwine:theme", theme: "dark", colors: { "sideBar-background": "#181818", foreground: "#cccccc", focusBorder: "#0078d4" }, surface: "sideBar" }
  // The first paint: the address carries the theme as a fragment, which the page's pre-paint guard reads.
  const [address, fragment] = r.src().split("#ntwine-theme=")
  assert.equal(address, URL_)
  assert.deepEqual(JSON.parse(decodeURIComponent(fragment!)), darkModern, "only the contract's names, read off the root")
  // The extension's theme message (sent once the page is ready) goes on with the colours added.
  r.dispatch({ source: r.hostFrame, origin: WEBVIEW, data: { type: "ntwine:theme", theme: "dark" } })
  assert.deepEqual(r.toPage, [{ data: darkModern, targetOrigin: NTWINE }])
  // VS Code switches theme: it rewrites the properties and the body's class, and the page hears it once.
  r.restyle({ "--vscode-sideBar-background": "#000000", "--vscode-foreground": "#ffffff", "--vscode-focusBorder": "#f38518" }, "vscode-high-contrast")
  assert.equal(r.toPage.length, 2, "two observers, one message: a rewrite that changes nothing more posts nothing more")
  assert.deepEqual(r.toPage[1]!.data, { type: "ntwine:theme", theme: "dark", colors: { "sideBar-background": "#000000", foreground: "#ffffff", focusBorder: "#f38518" }, surface: "sideBar", contrast: true })
  r.restyle({ "--vscode-sideBar-background": "#ffffff" }, "vscode-high-contrast vscode-high-contrast-light")
  assert.deepEqual(r.toPage[2]!.data, { type: "ntwine:theme", theme: "light", colors: { "sideBar-background": "#ffffff" }, surface: "sideBar", contrast: true }, "the body's class is the kind, light high contrast included")

  // ntwine.matchEditorTheme turned off: a theme message with no colours, now and from then on.
  r.dispatch({ source: r.hostFrame, origin: WEBVIEW, data: { view: "match-theme", on: false } })
  assert.deepEqual(r.toPage[3], { data: { type: "ntwine:theme", theme: "light" }, targetOrigin: NTWINE })
  r.dispatch({ source: r.hostFrame, origin: WEBVIEW, data: { type: "ntwine:theme", theme: "light" } })
  assert.deepEqual(r.toPage[4]!.data, { type: "ntwine:theme", theme: "light" })
  r.dispatch({ source: r.hostFrame, origin: WEBVIEW, data: { view: "match-theme", on: true } })
  assert.deepEqual(r.toPage[5]!.data, { type: "ntwine:theme", theme: "light", colors: { "sideBar-background": "#ffffff" }, surface: "sideBar", contrast: true })
})

test("with matching off from the start, the frame's address is the page's plain one; an editor tab's frame names its surface", () => {
  assert.equal(relay(frameDocument({ nonce: "n", url: URL_, origin: NTWINE, match: false })).src(), URL_)
  const tab = relay(frameDocument({ nonce: "n", url: URL_, origin: NTWINE, surface: "editor" }), { vars: { "--vscode-editor-background": "#1f1f1f" }, bodyClass: "vscode-dark" })
  assert.deepEqual(JSON.parse(decodeURIComponent(tab.src().split("#ntwine-theme=")[1]!)), { type: "ntwine:theme", theme: "dark", colors: { "editor-background": "#1f1f1f" }, surface: "editor" })
})

test("no address can close the relay's script", () => {
  const html = frameDocument({ nonce: "n", url: `${NTWINE}/?q=</script><script>alert(1)</script>`, origin: NTWINE })
  assert.equal([...html.matchAll(/<\/script>/gu)].length, 1)
})
