import { test } from "node:test"
import assert from "node:assert/strict"
import { addRoute, chordCommand, composeInSidebar, type ComposeSidebar, embedTheme, embedUrl, frameTarget, isSlug, parsePageMessage, promptRoute, safeOrigin, threadEmbedUrl, threadOfHref, webUrl, type KeyChord } from "./embed.ts"

test("VS Code's four theme kinds fold to the page's two", () => {
  // ColorThemeKind: Light 1, Dark 2, HighContrast 3, HighContrastLight 4.
  assert.deepEqual([1, 2, 3, 4].map(embedTheme), ["light", "dark", "dark", "light"])
})

test("the frame's URL is this window's project's board, carrying the embed switch and the theme", () => {
  assert.equal(embedUrl("http://127.0.0.1:9393", "dark", "ntwine"), "http://127.0.0.1:9393/project/ntwine?embed=vscode&theme=dark")
  assert.equal(embedUrl("http://127.0.0.1:9393", "light", undefined), "http://127.0.0.1:9393/all?embed=vscode&theme=light", "All projects when no folder maps to one")
  const odd = new URL(embedUrl("http://127.0.0.1:9393", "dark", "a b&theme=light#x"))
  assert.equal(odd.pathname, "/project/a%20b%26theme%3Dlight%23x", "a slug is one path segment")
  assert.equal(odd.searchParams.getAll("theme").join(), "dark", "a slug cannot add or override a param")
  assert.equal(odd.hash, "")
})

test("a host the window reaches Ntwine by is framed as such; a different port is refused, never framed", () => {
  assert.deepEqual(frameTarget("http://127.0.0.1:9393/?embed=vscode", "http://127.0.0.1:9393/?embed=vscode"), {
    kind: "frame",
    url: "http://127.0.0.1:9393/?embed=vscode",
    origin: "http://127.0.0.1:9393",
  })
  // Cursor's Remote-WSL tunnel hands back localhost on the same port, which Ntwine accepts.
  assert.deepEqual(frameTarget("http://127.0.0.1:9393/?embed=vscode", "http://localhost:9393/?embed=vscode"), {
    kind: "frame",
    url: "http://localhost:9393/?embed=vscode",
    origin: "http://localhost:9393",
  })
  assert.deepEqual(frameTarget("http://127.0.0.1:9393/", "http://127.0.0.1:49152/"), { kind: "remapped", port: 9393, external: 49152 })
  // A default port is a port: an https tunnel on 443 is not Ntwine's 9393, and an explicit :80 is http's 80.
  assert.deepEqual(frameTarget("http://127.0.0.1:9393/", "https://abc.tunnel.example/"), { kind: "remapped", port: 9393, external: 443 })
  assert.equal(frameTarget("http://ntwine.local/", "http://ntwine.local:80/").kind, "frame")
})

test("only a plain http(s) origin may go into the policy and the relay", () => {
  assert.equal(safeOrigin("http://127.0.0.1:9393"), true)
  assert.equal(safeOrigin("http://[::1]:9393"), true)
  assert.equal(safeOrigin("https://localhost"), true)
  for (const bad of ["http://127.0.0.1:9393/", "http://a;script-src *", "http://a\" onload=\"x", "javascript:alert(1)", "file:///etc", "http://a b"]) {
    assert.equal(safeOrigin(bad), false, bad)
  }
})

test("every page message the contract names is taken, with only its own fields", () => {
  assert.deepEqual(parsePageMessage({ type: "ntwine:ready", v: 1, extra: true }), { type: "ntwine:ready", v: 1 })
  assert.deepEqual(parsePageMessage({ type: "ntwine:composed", id: "n", ok: false, error: "No box." }), { type: "ntwine:composed", id: "n", ok: false, error: "No box." })
  assert.deepEqual(parsePageMessage({ type: "ntwine:composed", id: "n", ok: true }), { type: "ntwine:composed", id: "n", ok: true })
  assert.deepEqual(parsePageMessage({ type: "ntwine:open-file", path: "/r/a.ts", line: 12, column: 3, endLine: 20, evil: 1 }), {
    type: "ntwine:open-file",
    path: "/r/a.ts",
    line: 12,
    column: 3,
    endLine: 20,
  })
  assert.deepEqual(parsePageMessage({ type: "ntwine:open-file", path: "C:\\r\\a.ts" }), { type: "ntwine:open-file", path: "C:\\r\\a.ts" })
  assert.deepEqual(parsePageMessage({ type: "ntwine:open-external", url: "https://github.com/x/y/pull/1" }), { type: "ntwine:open-external", url: "https://github.com/x/y/pull/1" })
  assert.deepEqual(parsePageMessage({ type: "ntwine:key", key: "P", code: "KeyP", ctrl: true, meta: false, shift: true, alt: false }), {
    type: "ntwine:key",
    key: "P",
    code: "KeyP",
    ctrl: true,
    meta: false,
    shift: true,
    alt: false,
  })
  assert.deepEqual(parsePageMessage({ type: "ntwine:add-context", what: "selection", text: "x" }), { type: "ntwine:add-context", what: "selection" })
  assert.deepEqual(parsePageMessage({ type: "ntwine:add-context", what: "file", path: "/r/a.ts" }), { type: "ntwine:add-context", what: "file", path: "/r/a.ts" })
  assert.deepEqual(parsePageMessage({ type: "ntwine:add-context", what: "problems" }), { type: "ntwine:add-context", what: "problems" })
  assert.deepEqual(parsePageMessage({ type: "ntwine:add-context", what: "terminal" }), { type: "ntwine:add-context", what: "terminal" })
  assert.deepEqual(parsePageMessage({ type: "ntwine:pick-context", id: "n1", query: "" }), { type: "ntwine:pick-context", id: "n1", query: "" })
  assert.deepEqual(parsePageMessage({ type: "ntwine:pick-context", id: "n1", query: "src/App", x: 1 }), { type: "ntwine:pick-context", id: "n1", query: "src/App" })
  assert.deepEqual(
    parsePageMessage({ type: "ntwine:pick-context", id: "n2", uris: ["file:///r/a.ts", "vscode-remote://wsl%2Bubuntu/r/b"] }),
    { type: "ntwine:pick-context", id: "n2", uris: ["file:///r/a.ts", "vscode-remote://wsl%2Bubuntu/r/b"] },
  )
  assert.deepEqual(parsePageMessage({ type: "ntwine:route", view: "thread", title: "hello-there", description: "Ready", x: 1 }), {
    type: "ntwine:route",
    view: "thread",
    title: "hello-there",
    description: "Ready",
  })
  assert.deepEqual(parsePageMessage({ type: "ntwine:route", view: "queue", title: "All projects", description: "" }), { type: "ntwine:route", view: "queue", title: "All projects" })
  // The eye: share the editor or stop — a boolean, nothing else.
  assert.deepEqual(parsePageMessage({ type: "ntwine:share-editor", on: false, extra: 1 }), { type: "ntwine:share-editor", on: false })
  assert.equal(parsePageMessage({ type: "ntwine:share-editor", on: "off" }), undefined)
  assert.equal(parsePageMessage({ type: "ntwine:share-editor" }), undefined)
  assert.deepEqual(parsePageMessage({ type: "ntwine:open-external", url: "mailto:someone@example.com?subject=Hi" }), { type: "ntwine:open-external", url: "mailto:someone@example.com?subject=Hi" })
  // A review names a thread and its project — and nothing the page could point at a folder with.
  assert.deepEqual(parsePageMessage({ type: "ntwine:review", thread: "tidy-the-loop", project: "acme-api", dir: "/etc" }), { type: "ntwine:review", thread: "tidy-the-loop", project: "acme-api" })
  assert.deepEqual(parsePageMessage({ type: "ntwine:review", thread: "tidy", project: "acme-api", title: "Tidy the loop" }), { type: "ntwine:review", thread: "tidy", project: "acme-api", title: "Tidy the loop" })
})

test("a route's address is kept only on the frame's own origin, and the route without it otherwise", () => {
  const origin = "http://127.0.0.1:9393"
  const route = { type: "ntwine:route", view: "thread", title: "Split the constants" }
  assert.deepEqual(parsePageMessage({ ...route, href: "http://127.0.0.1:9393/all/acme-api/thread/split-constants" }, origin), {
    ...route,
    href: "http://127.0.0.1:9393/all/acme-api/thread/split-constants",
  })
  for (const href of ["https://evil.example/x", "http://127.0.0.1:9394/", "http://localhost:9393/", "javascript:alert(1)", "/all/acme-api", 5]) {
    assert.deepEqual(parsePageMessage({ ...route, href }, origin), route, String(href))
  }
  // No origin to check it against: never kept.
  assert.deepEqual(parsePageMessage({ ...route, href: "http://127.0.0.1:9393/" }), route)
})

test("anything else from the page is nothing: unknown types, wrong shapes, other versions, non-web links", () => {
  const refused: unknown[] = [
    undefined,
    null,
    "ntwine:ready",
    [],
    { type: "ntwine:compose", id: "x" },
    { type: "ntwine:theme", theme: "dark" },
    { type: "ntwine:unknown" },
    { type: "ntwine:ready", v: 2 },
    { type: "ntwine:ready" },
    { type: "ntwine:composed", id: "n" },
    { type: "ntwine:composed", id: "", ok: true },
    { type: "ntwine:composed", id: "n", ok: "yes" },
    { type: "ntwine:composed", id: "n", ok: false, error: 5 },
    { type: "ntwine:open-file", path: "src/a.ts" },
    { type: "ntwine:open-file", path: "/r/a\0.ts" },
    { type: "ntwine:open-file", path: "/r/a.ts", line: 0 },
    { type: "ntwine:open-file", path: "/r/a.ts", line: 1.5 },
    { type: "ntwine:open-file", path: "/r/a.ts", line: "3" },
    { type: "ntwine:open-external", url: "javascript:alert(1)" },
    { type: "ntwine:open-external", url: "file:///etc/passwd" },
    { type: "ntwine:open-external", url: "command:workbench.action.terminal.new" },
    { type: "ntwine:open-external", url: "vscode://ssalbdivad.ntwine-vscode/x" },
    { type: "ntwine:open-external", url: "not a url" },
    { type: "ntwine:open-external", url: "mailto:" },
    { type: "ntwine:key", key: "p", code: "KeyP", ctrl: true },
    { type: "ntwine:key", key: "p", code: "KeyP", ctrl: 1, meta: false, shift: false, alt: false },
    { type: "ntwine:add-context" },
    { type: "ntwine:add-context", what: "selection", path: "/r/a.ts" },
    { type: "ntwine:add-context", what: "file" },
    { type: "ntwine:add-context", what: "file", path: "src/a.ts" },
    { type: "ntwine:add-context", what: "file", path: "/r/a\0.ts" },
    { type: "ntwine:add-context", what: "line", path: "/r/a.ts" },
    { type: "ntwine:add-context", what: "problems", path: "/r/a.ts" },
    { type: "ntwine:pick-context", query: "a" },
    { type: "ntwine:pick-context", id: "", query: "a" },
    { type: "ntwine:pick-context", id: "n", query: 3 },
    { type: "ntwine:pick-context", id: "n", query: "x".repeat(201) },
    { type: "ntwine:pick-context", id: "n", query: "a", uris: ["file:///r/a.ts"] },
    { type: "ntwine:pick-context", id: "n" },
    { type: "ntwine:pick-context", id: "n", uris: [] },
    { type: "ntwine:pick-context", id: "n", uris: ["file:///r/a\0.ts"] },
    { type: "ntwine:pick-context", id: "n", uris: [7] },
    { type: "ntwine:pick-context", id: "n", uris: Array.from({ length: 51 }, (_, i) => `file:///r/${i}`) },
    { type: "ntwine:route", view: "drawer", title: "x" },
    { type: "ntwine:route", view: "thread" },
    { type: "ntwine:route", view: "thread", title: "x".repeat(501) },
    { type: "ntwine:route", view: "queue", title: "All projects", description: 3 },
    { type: "ntwine:review", thread: "tidy" },
    { type: "ntwine:review", thread: "../../etc", project: "acme" },
    { type: "ntwine:review", thread: "tidy", project: "acme/api" },
    { type: "ntwine:review", thread: "", project: "acme" },
    { type: "ntwine:review", thread: 3, project: "acme" },
    { type: "ntwine:review", thread: "tidy", project: "acme", title: 3 },
  ]
  for (const message of refused) assert.equal(parsePageMessage(message), undefined, JSON.stringify(message))
  assert.equal(webUrl("http://"), undefined)
})

const chord = (code: string, mods: Partial<Omit<KeyChord, "code">> = {}): KeyChord => ({ code, ctrl: false, meta: false, shift: false, alt: false, ...mods })

test("a forwarded chord runs the command VS Code binds it to by default — Ctrl off a Mac, Cmd on one", () => {
  assert.equal(chordCommand(chord("KeyP", { ctrl: true, shift: true }), false), "workbench.action.showCommands")
  assert.equal(chordCommand(chord("KeyP", { meta: true, shift: true }), true), "workbench.action.showCommands")
  assert.equal(chordCommand(chord("KeyP", { ctrl: true }), false), "workbench.action.quickOpen")
  assert.equal(chordCommand(chord("KeyB", { meta: true }), true), "workbench.action.toggleSidebarVisibility")
  assert.equal(chordCommand(chord("KeyJ", { ctrl: true }), false), "workbench.action.togglePanel")
  // Cursor's ⌘L, pressed in the page: back to the editor the human came from.
  assert.equal(chordCommand(chord("KeyL", { ctrl: true }), false), "workbench.action.focusActiveEditorGroup")
  assert.equal(chordCommand(chord("KeyL", { meta: true }), true), "workbench.action.focusActiveEditorGroup")
  assert.equal(chordCommand(chord("KeyL", { ctrl: true, shift: true }), false), undefined)
  assert.equal(chordCommand(chord("Digit1", { ctrl: true }), false), "workbench.action.focusFirstEditorGroup")
  assert.equal(chordCommand(chord("KeyE", { ctrl: true, shift: true }), false), "workbench.view.explorer")
  // VS Code binds the terminal and source control to Ctrl on a Mac too.
  assert.equal(chordCommand(chord("Backquote", { ctrl: true }), true), "workbench.action.terminal.toggleTerminal")
  assert.equal(chordCommand(chord("KeyG", { ctrl: true, shift: true }), true), "workbench.view.scm")
})

test("a chord the allowlist does not name, or with one modifier more or less, runs nothing", () => {
  const none = [
    [chord("KeyP", { ctrl: true, shift: true }), true], // Ctrl on a Mac is not Cmd
    [chord("KeyP", { meta: true, shift: true }), false], // the Windows key off a Mac is not Ctrl
    [chord("KeyP", { ctrl: true, shift: true, alt: true }), false],
    [chord("KeyP", { ctrl: true, meta: true }), false],
    [chord("KeyP"), false],
    [chord("KeyW", { ctrl: true }), false], // closing an editor is not getting around
    [chord("KeyC", { ctrl: true }), false],
    [chord("Backquote", { meta: true }), true],
  ] as const
  for (const [key, mac] of none) assert.equal(chordCommand(key, mac), undefined, JSON.stringify({ key, mac }))
})

test("Add to Ntwine prompt goes to the sidebar whenever it is on and there is a Ntwine to frame, opened or not", () => {
  assert.equal(addRoute({ enabled: true, ntwine: true }), "sidebar", "a window that never opened the sidebar opens it")
  assert.equal(addRoute({ enabled: false, ntwine: true }), "server", "the setting keeps the browser flow")
  assert.equal(addRoute({ enabled: true, ntwine: false }), "server", "no Ntwine: the server path, which says why")
})

test("Ask and Send write in the sidebar unless it is off or the caller passed the text to send", () => {
  assert.equal(promptRoute(true, undefined), "sidebar")
  assert.equal(promptRoute(false, undefined), "server")
  assert.equal(promptRoute(true, "why does this loop?"), "server")
  assert.equal(promptRoute(true, ""), "server", "an empty argument is still an argument")
})

function fakeSidebar(behaviour: { ready: boolean; answer?: { ok: boolean; error?: string } }) {
  const calls: string[] = []
  const sidebar: ComposeSidebar = {
    async reveal(preserveFocus) {
      calls.push(`reveal ${preserveFocus}`)
    },
    async waitReady(ms) {
      calls.push(`wait ${ms}`)
      return behaviour.ready
    },
    async compose(input, ms) {
      calls.push(`compose ${JSON.stringify(input.target)} ${input.focus} ${ms}`)
      return behaviour.answer && { type: "ntwine:composed", id: "c1", ...behaviour.answer }
    },
  }
  return { sidebar, calls }
}

const composeInput = { item: { path: "/r/a.ts", startLine: 2, app: "Code" }, target: "new" as const, focus: true }
const timing = { preserveFocus: false, readyMs: 15_000, composeMs: 5_000 }

test("a selection the page takes is done: revealed, waited for, posted, answered", async () => {
  const { sidebar, calls } = fakeSidebar({ ready: true, answer: { ok: true } })
  assert.deepEqual(await composeInSidebar(sidebar, composeInput, timing), { ok: true, id: "c1" })
  assert.deepEqual(calls, ["reveal false", "wait 15000", 'compose "new" true 5000'])
})

test("a page that never gets ready, never answers or refuses leaves the selection to the command's old path", async () => {
  const notReady = fakeSidebar({ ready: false })
  assert.deepEqual(await composeInSidebar(notReady.sidebar, composeInput, timing), { ok: false, why: "The Ntwine sidebar didn't load in time." })
  assert.deepEqual(notReady.calls, ["reveal false", "wait 15000"], "nothing is posted to a page that is not listening")
  const silent = fakeSidebar({ ready: true })
  assert.deepEqual(await composeInSidebar(silent.sidebar, composeInput, timing), { ok: false, why: "The Ntwine sidebar didn't answer." })
  const refused = fakeSidebar({ ready: true, answer: { ok: false, error: "Its project isn't in Ntwine." } })
  assert.deepEqual(await composeInSidebar(refused.sidebar, composeInput, timing), { ok: false, why: "The Ntwine sidebar couldn't take it: Its project isn't in Ntwine." })
})

test("a thread's tab frames the thread's own address in embed mode, with its project and theme", () => {
  assert.equal(threadEmbedUrl("http://127.0.0.1:9393", "dark", "acme-api", "fix-login"), "http://127.0.0.1:9393/project/acme-api/thread/fix-login?embed=vscode&theme=dark")
  const odd = new URL(threadEmbedUrl("http://127.0.0.1:9393", "light", "a/b", "c?d#e"))
  assert.equal(odd.pathname, "/project/a%2Fb/thread/c%3Fd%23e", "a name cannot add a path segment, a query or a fragment")
  assert.equal(odd.searchParams.get("theme"), "light")
  assert.equal(odd.hash, "")
})

test("the thread a page address shows: a drawer or a fullscreen page, nothing for any other page", () => {
  assert.deepEqual(threadOfHref("http://127.0.0.1:9393/project/acme-api/thread/fix-login"), { project: "acme-api", thread: "fix-login" })
  assert.deepEqual(threadOfHref("http://127.0.0.1:9393/project/acme-api/thread/fix-login/full"), { project: "acme-api", thread: "fix-login" })
  assert.deepEqual(threadOfHref("http://127.0.0.1:9393/all/acme-api/thread/fix-login"), { project: "acme-api", thread: "fix-login" })
  assert.deepEqual(threadOfHref("http://127.0.0.1:9393/all/acme-api/thread/fix-login/full?x=1"), { project: "acme-api", thread: "fix-login" })
  assert.equal(threadOfHref("http://127.0.0.1:9393/project/acme-api"), undefined)
  assert.equal(threadOfHref("http://127.0.0.1:9393/project/acme-api/status/blocked"), undefined)
  assert.equal(threadOfHref("http://127.0.0.1:9393/all/acme-api"), undefined)
  assert.equal(threadOfHref("http://127.0.0.1:9393/all/acme-api/thread/fix-login/files"), undefined)
  assert.equal(threadOfHref("http://127.0.0.1:9393/all/acme%20api/thread/x"), undefined, "a name no slug could be")
  assert.equal(threadOfHref("not a url"), undefined)
  assert.equal(threadOfHref(undefined), undefined)
  assert.equal(isSlug("fix-login"), true)
  assert.equal(isSlug("../x"), false)
  assert.equal(isSlug(7), false)
})
