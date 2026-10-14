import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { connect, type AddressInfo } from "node:net"
import { WebSocket, type ClientOptions } from "ws"
import {
  EDITOR_CLOSE,
  EDITOR_SOCKET_PATH,
  EDITOR_STATE_MAX_DIAGNOSTICS,
  type EditorHello,
  type EditorSnapshot,
  type EditorProject,
  type EditorServerMessage,
  type ServerEvent,
  type ThreadView,
} from "@ntwine/shared"
import { attentionNeeds, createEditorBridge, EDITOR_MAX_WINDOWS, listEditorProjects, type EditorBridgeDeps } from "./editor-bridge.ts"
import { HOME_WORKSPACE_ID } from "./home-workspace.ts"

// The bridge against a REAL http server and REAL `ws` clients standing in for editor windows: the
// origin gate, the handshake and the close codes are the ws library's and the kernel's, not a mock's.

const HOME = "/home/me"

async function harness(t: TestContext, overrides: Partial<EditorBridgeDeps> = {}) {
  const published: ServerEvent[] = []
  let clock = 1_000_000
  let projects: EditorProject[] = [{ id: "p1", slug: "alpha", name: "Alpha", dir: "/work/alpha", ready: 1, working: 0 }]
  const bridge = createEditorBridge({
    bootId: () => "boot-1",
    listProjects: () => projects,
    publish: (event) => published.push(event),
    now: () => clock,
    home: HOME,
    platform: "linux",
    requestTimeoutMs: 400,
    reviewTimeoutMs: 600,
    ...overrides,
  })
  const server = createServer()
  server.on("upgrade", (req, socket, head) => {
    if (!bridge.handleUpgrade(req, socket, head)) socket.destroy()
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const port = (server.address() as AddressInfo).port
  t.after(async () => {
    await bridge.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return {
    bridge,
    port,
    published,
    advance: (ms: number) => { clock += ms },
    setProjects: (next: EditorProject[]) => { projects = next },
  }
}

type Answer = "ok" | "fail" | "silent" | "hang-up"

/** A fake editor window: records every frame, and answers `open`/`focus` the way it is told to. */
async function editor(port: number, hello: Partial<EditorHello> = {}, answer: Answer = "ok", options: ClientOptions = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${EDITOR_SOCKET_PATH}`, { origin: `http://127.0.0.1:${port}`, ...options })
  const frames: EditorServerMessage[] = []
  const waiters: { match: (m: EditorServerMessage) => boolean; resolve: (m: EditorServerMessage) => void }[] = []
  const requests: EditorServerMessage[] = []
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString()) as EditorServerMessage
    frames.push(msg)
    if (msg.t === "open" || msg.t === "focus" || msg.t === "review") {
      requests.push(msg)
      if (answer === "ok") ws.send(JSON.stringify({ t: "result", id: msg.id, ok: true }))
      else if (answer === "fail") ws.send(JSON.stringify({ t: "result", id: msg.id, ok: false, error: "Could not open a.ts: it is a binary file" }))
      else if (answer === "hang-up") ws.close()
    }
    for (const waiter of [...waiters]) {
      if (waiter.match(msg)) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve(msg)
      }
    }
  })
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }))
  })
  ws.on("error", () => {})
  await once(ws, "open")
  const next = <T extends EditorServerMessage["t"]>(t: T, timeoutMs = 1_000) => {
    const seen = frames.find((m) => m.t === t)
    if (seen) {
      frames.splice(frames.indexOf(seen), 1)
      return Promise.resolve(seen as Extract<EditorServerMessage, { t: T }>)
    }
    return new Promise<Extract<EditorServerMessage, { t: T }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${t}`)), timeoutMs)
      waiters.push({
        match: (m) => m.t === t,
        resolve: (m) => {
          clearTimeout(timer)
          frames.splice(frames.indexOf(m), 1)
          resolve(m as Extract<EditorServerMessage, { t: T }>)
        },
      })
    })
  }
  const window = {
    ws,
    frames,
    requests,
    closed,
    next,
    send: (frame: unknown) => ws.send(typeof frame === "string" ? frame : JSON.stringify(frame)),
    state: (state: { folders?: string[]; focused?: boolean; acceptsOpens?: boolean }) =>
      ws.send(JSON.stringify({ t: "state", folders: fullHello.folders, focused: fullHello.focused, acceptsOpens: fullHello.acceptsOpens, ...state })),
  }
  const fullHello: EditorHello = {
    t: "hello",
    v: 1,
    windowId: randomUUID(),
    app: "Visual Studio Code",
    extensionVersion: "0.0.1",
    folders: [],
    focused: false,
    acceptsOpens: true,
    home: HOME,
    platform: "linux",
    ...hello,
  }
  window.send(fullHello)
  await next("welcome")
  await next("projects")
  return window
}

async function rejectedStatus(port: number, path: string, options: ClientOptions): Promise<number> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, options)
  return await new Promise<number>((resolve, reject) => {
    ws.once("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0)
      res.resume()
    })
    ws.once("open", () => {
      ws.close()
      reject(new Error("upgrade unexpectedly opened"))
    })
    ws.once("error", () => {})
  })
}

/**
 * A hand-written upgrade request, for the handshakes `ws` itself refuses (a missing key, a version it
 * does not speak, a POST) — no client library will send one. Resolves with the response's status code.
 */
async function malformedUpgradeStatus(port: number, path: string, headers: Record<string, string>, method = "GET"): Promise<number> {
  const socket = connect(port, "127.0.0.1")
  await once(socket, "connect")
  const lines = [`${method} ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, `Origin: http://127.0.0.1:${port}`, "Connection: Upgrade", "Upgrade: websocket"]
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`)
  socket.write(lines.join("\r\n") + "\r\n\r\n")
  let response = ""
  socket.on("data", (chunk) => { response += chunk.toString("latin1") })
  socket.on("error", () => {})
  await once(socket, "close")
  return Number(/^HTTP\/1\.1 (\d{3})/.exec(response)?.[1] ?? 0)
}

/** Open a socket and send `frames` raw, before (or instead of) a hello. */
async function rawSocket(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${EDITOR_SOCKET_PATH}`, { origin: `http://127.0.0.1:${port}` })
  ws.on("error", () => {})
  const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)))
  await once(ws, "open")
  return { ws, closed }
}

function tree(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-editor-bridge-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const mono = join(root, "mono")
  const pkg = join(mono, "pkg")
  const other = join(root, "other")
  mkdirSync(pkg, { recursive: true })
  mkdirSync(other)
  const inPkg = join(pkg, "a.ts")
  const inMono = join(mono, "b.ts")
  const outside = join(other, "c.ts")
  for (const file of [inPkg, inMono, outside]) writeFileSync(file, "x")
  return { root, mono, pkg, other, inPkg, inMono, outside }
}

const until = async (check: () => boolean, what: string, timeoutMs = 1_000) => {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test("the upgrade needs this server's own Origin, and only the exact path is the bridge's", async (t) => {
  const h = await harness(t)
  assert.equal(await rejectedStatus(h.port, EDITOR_SOCKET_PATH, {}), 403, "no Origin")
  assert.equal(await rejectedStatus(h.port, EDITOR_SOCKET_PATH, { origin: "http://evil.example" }), 403, "a foreign Origin")
  assert.equal(await rejectedStatus(h.port, EDITOR_SOCKET_PATH, { origin: `http://localhost:${h.port}` }), 403, "another loopback name")
  // The query string is not part of the path; a project-prefixed spelling is not the bridge.
  const queried = new WebSocket(`ws://127.0.0.1:${h.port}${EDITOR_SOCKET_PATH}?v=1`, { origin: `http://127.0.0.1:${h.port}` })
  await once(queried, "open")
  queried.close()
  const prefixed = new WebSocket(`ws://127.0.0.1:${h.port}/_ntwine/alpha/editor`, { origin: `http://127.0.0.1:${h.port}` })
  prefixed.on("error", () => {})
  const [error] = await once(prefixed, "error") as [Error]
  assert.match(error.message, /socket hang up/, "not the bridge's: the harness destroys it")
})

test("the first frame must be a hello in this protocol version; any bad frame closes with its own code", async (t) => {
  const h = await harness(t, { helloTimeoutMs: 150 })
  const closeCode = async (frame: string | Buffer | null) => {
    const s = await rawSocket(h.port)
    if (frame !== null) s.ws.send(frame)
    return s.closed
  }
  assert.equal(await closeCode(JSON.stringify({ t: "state", folders: [], focused: true, acceptsOpens: true })), EDITOR_CLOSE.helloRequired)
  assert.equal(await closeCode(null), EDITOR_CLOSE.helloRequired, "silence past the hello deadline")
  assert.equal(await closeCode(JSON.stringify({ t: "hello", v: 2, windowId: "w" })), EDITOR_CLOSE.unsupportedVersion)
  assert.equal(await closeCode("{not json"), EDITOR_CLOSE.invalidMessage)
  assert.equal(await closeCode(Buffer.from([1, 2, 3])), EDITOR_CLOSE.invalidMessage, "binary")
  const strict = { t: "hello", v: 1, windowId: "w", app: "VS Code", extensionVersion: "1", folders: [], focused: true, acceptsOpens: true, home: HOME, platform: "linux", extra: 1 }
  assert.equal(await closeCode(JSON.stringify(strict)), EDITOR_CLOSE.invalidMessage, "a hello with an unknown key")
  // After a good hello: an unknown frame, a second hello, and an oversized non-compose frame.
  const win = await editor(h.port)
  win.send({ t: "bogus" })
  assert.equal((await win.closed).code, EDITOR_CLOSE.invalidMessage)
  const twice = await editor(h.port)
  twice.send({ ...strict, extra: undefined })
  assert.equal((await twice.closed).code, EDITOR_CLOSE.invalidMessage)
  const big = await editor(h.port)
  big.send({ t: "result", id: "x", ok: false, error: "e".repeat(70 * 1024) })
  assert.equal((await big.closed).code, EDITOR_CLOSE.invalidMessage)
})

test("a hello is answered with welcome then projects, and a projects change is re-pushed while windows are connected", async (t) => {
  const h = await harness(t, { projectsPollMs: 40 })
  const win = await editor(h.port)
  assert.equal(win.frames.length, 0, "the helper consumed exactly welcome and projects")
  // The order on the wire, from a raw socket.
  const s = await rawSocket(h.port)
  const got: EditorServerMessage[] = []
  s.ws.on("message", (raw) => got.push(JSON.parse(raw.toString())))
  s.ws.send(JSON.stringify({ t: "hello", v: 1, windowId: "raw", app: "Cursor", extensionVersion: "1", folders: [], focused: false, acceptsOpens: true, home: HOME, platform: "linux" }))
  await until(() => got.length >= 2, "welcome and projects")
  assert.deepEqual(got.slice(0, 2), [
    // `features`: what this server takes beyond v1, so a new extension sends the `editor` frame only here,
    // frames this server's page in its sidebar, and says whether it shows needs-you notifications.
    { t: "welcome", v: 1, bootId: "boot-1", features: ["editor-state", "editor-selection-withheld", "review", "sidebar", "attention"] },
    { t: "projects", projects: [{ id: "p1", slug: "alpha", name: "Alpha", dir: "/work/alpha", ready: 1, working: 0 }] },
  ])
  // Unchanged: nothing more across several polls.
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(win.frames.filter((m) => m.t === "projects").length, 0)
  h.setProjects([{ id: "p1", slug: "alpha", name: "Alpha", dir: "/work/alpha", ready: 2, working: 1 }])
  const pushed = await win.next("projects")
  assert.deepEqual(pushed.projects[0], { id: "p1", slug: "alpha", name: "Alpha", dir: "/work/alpha", ready: 2, working: 1 })
  s.ws.close()
})

test("an open goes to the window whose folder holds the file: deepest folder, then the one focused last", async (t) => {
  const h = await harness(t)
  const dirs = tree(t)
  const monoWin = await editor(h.port, { folders: [dirs.mono], focused: true })
  const pkgWin = await editor(h.port, { folders: [dirs.other, dirs.pkg] })
  assert.equal(await h.bridge.openFile(dirs.inPkg, { line: 12, column: 3, endLine: 20 }, ["vscode"]), true)
  assert.deepEqual(pkgWin.requests.map((r) => ({ ...r, id: undefined })), [{ t: "open", path: dirs.inPkg, line: 12, column: 3, endLine: 20, id: undefined }], "the package beats the monorepo, focused or not")
  assert.equal(monoWin.requests.length, 0)
  // Only the monorepo window holds b.ts.
  assert.equal(await h.bridge.openFile(dirs.inMono, undefined, ["vscode"]), true)
  assert.deepEqual(monoWin.requests.map((r) => r.t === "open" && [r.path, r.line]), [[dirs.inMono, undefined]])

  // Two windows on the same folder: the one focused last, and a focus moving moves the next open.
  const second = await editor(h.port, { folders: [dirs.mono] })
  h.advance(10)
  second.state({ focused: true })
  monoWin.state({ focused: false })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(await h.bridge.openFile(dirs.inMono, { line: 1 }, ["vscode"]), true)
  assert.equal(second.requests.length, 1, "the window the human is in now")
  h.advance(10)
  second.state({ focused: false })
  h.advance(10)
  monoWin.state({ focused: true })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(await h.bridge.openFile(dirs.inMono, { line: 2 }, ["vscode"]), true)
  assert.equal(monoWin.requests.length, 2, "focus moved back")
  // Neither focused now (the human is in the browser): the one they left LAST, not the one that said
  // `focused` first.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30))
  monoWin.state({ focused: false })
  await settle()
  h.advance(10)
  second.state({ focused: true })
  await settle()
  h.advance(10)
  second.state({ focused: false })
  await settle()
  assert.equal(await h.bridge.openFile(dirs.inMono, { line: 3 }, ["vscode"]), true)
  assert.equal(second.requests.length, 2, "the window left last")
})

test("focus recency survives a reconnect: the hello says how long ago the window last had focus", async (t) => {
  // After an ntwine restart every window redials while the human is in the browser, so none is focused.
  // Without the hello's focusedAgoMs they all ranked 0 and the window that redialled LAST took every
  // open no folder claims.
  const h = await harness(t)
  const dirs = tree(t)
  const usedLast = await editor(h.port, { focused: false, focusedAgoMs: 5_000 })
  const usedEarlier = await editor(h.port, { focused: false, focusedAgoMs: 60_000 })
  assert.equal(await h.bridge.openFile(dirs.outside, undefined, ["vscode"]), true)
  assert.equal(usedLast.requests.length, 1, "the window used most recently before the restart, though it redialled first")
  assert.equal(usedEarlier.requests.length, 0)
  // A window that never had focus (absent) ranks below both; a value past the epoch is clamped, not negative.
  const never = await editor(h.port, { focused: false })
  const ancient = await editor(h.port, { focused: false, focusedAgoMs: 10 ** 15 })
  assert.equal(await h.bridge.openFile(dirs.outside, undefined, ["vscode"]), true)
  assert.equal(usedLast.requests.length, 2)
  assert.equal(never.requests.length + ancient.requests.length, 0)
})

test("a symlinked workspace folder gets the file in its own spelling", async (t) => {
  const h = await harness(t)
  const dirs = tree(t)
  const link = join(dirs.root, "linked")
  symlinkSync(dirs.pkg, link)
  const win = await editor(h.port, { folders: [link] })
  assert.equal(await h.bridge.openFile(dirs.inPkg, { line: 4 }, ["vscode"]), true)
  assert.equal((win.requests[0] as { path: string }).path, join(link, "a.ts"))
})

test("never a window that turned opens off or is the wrong editor; with no folder match only a same-machine window", async (t) => {
  const h = await harness(t)
  const dirs = tree(t)
  const off = await editor(h.port, { folders: [dirs.pkg], focused: true, acceptsOpens: false })
  const cursor = await editor(h.port, { folders: [dirs.pkg], app: "Cursor" })
  assert.equal(await h.bridge.openFile(dirs.inPkg, { line: 1 }, ["vscode"]), false, "no eligible window: the caller spawns")
  assert.equal(off.requests.length + cursor.requests.length, 0)
  assert.equal(await h.bridge.openFile(dirs.inPkg, { line: 1 }, ["cursor"]), true)
  assert.equal(cursor.requests.length, 1)
  assert.equal(await h.bridge.openFile(dirs.inPkg, undefined, []), false, "no kinds: never the bridge")

  // No folder holds c.ts: a window on another platform or home is never handed it, a local one is.
  const windowsSide = await editor(h.port, { folders: ["C:\\work"], focused: true, home: "C:\\Users\\me", platform: "win32" })
  assert.equal(await h.bridge.openFile(dirs.outside, undefined, ["vscode"]), false)
  const local = await editor(h.port, { folders: [] })
  assert.equal(await h.bridge.openFile(dirs.outside, { line: 9 }, ["vscode"]), true)
  assert.equal(windowsSide.requests.length, 0)
  assert.deepEqual(local.requests.map((r) => r.t === "open" && [r.path, r.line]), [[dirs.outside, 9]])
  // A state frame that turns opens off takes effect on the next open.
  local.state({ acceptsOpens: false })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(await h.bridge.openFile(dirs.outside, undefined, ["vscode"]), false)
  assert.equal(await h.bridge.openFile(join(dirs.root, "missing.ts"), undefined, ["vscode"]), false, "a path that does not exist")
})

test("no answer in time, or a window that hangs up, is false; a window that says it could not is the error", async (t) => {
  const h = await harness(t, { requestTimeoutMs: 150 })
  const dirs = tree(t)
  const silent = await editor(h.port, { folders: [dirs.pkg] }, "silent")
  const started = Date.now()
  assert.equal(await h.bridge.openFile(dirs.inPkg, { line: 1 }, ["vscode"]), false)
  assert.ok(Date.now() - started >= 140, "it waited the timeout out")
  assert.equal(silent.requests.length, 1)
  silent.ws.close()
  await silent.closed

  const failing = await editor(h.port, { folders: [dirs.pkg] }, "fail")
  await assert.rejects(h.bridge.openFile(dirs.inPkg, { line: 1 }, ["vscode"]), /^Error: Could not open a\.ts: it is a binary file$/)
  failing.ws.close()
  await failing.closed

  const hangUp = await editor(h.port, { folders: [dirs.pkg] }, "hang-up")
  const quick = Date.now()
  assert.equal(await h.bridge.openFile(dirs.inPkg, { line: 1 }, ["vscode"]), false)
  assert.ok(Date.now() - quick < 140, "a dropped socket answers at once, not at the timeout")
})

test("focus goes only to a window whose folder IS the folder", async (t) => {
  const h = await harness(t)
  const dirs = tree(t)
  const link = join(dirs.root, "mono-link")
  symlinkSync(dirs.mono, link)
  const parent = await editor(h.port, { folders: [dirs.root] })
  const win = await editor(h.port, { folders: [dirs.other, link] })
  assert.equal(await h.bridge.focusFolder(dirs.mono, ["vscode"]), true)
  assert.deepEqual(win.requests.map((r) => [r.t, (r as { path: string }).path]), [["focus", link]], "the window's own spelling")
  assert.equal(parent.requests.length, 0, "a window on the PARENT folder does not have this one open")
  assert.equal(await h.bridge.focusFolder(dirs.pkg, ["vscode"]), false, "a subfolder of an open folder is not that folder")
  assert.equal(await h.bridge.focusFolder(dirs.mono, ["cursor"]), false)
})

test("a window that cannot raise itself makes focus false, not an error, so the caller spawns the editor instead", async (t) => {
  const h = await harness(t)
  const dirs = tree(t)
  const stuck = await editor(h.port, { folders: [dirs.mono] }, "fail")
  assert.equal(await h.bridge.focusFolder(dirs.mono, ["vscode"]), false)
  assert.equal(stuck.requests.length, 1, "it was asked")
  // The same answer to an open is still the window's error: a second opener would fail the same way.
  await assert.rejects(h.bridge.openFile(dirs.inMono, { line: 1 }, ["vscode"]), /binary file/)
})

test("compose: held, acknowledged, announced, claimed once, oldest first, expired after its time, capped", async (t) => {
  const h = await harness(t, { composeTtlMs: 60_000, maxComposeItems: 3 })
  const win = await editor(h.port, { app: "Cursor" })
  const send = (nonce: string, path: string) => win.send({ t: "compose", id: nonce, item: { path, text: "const a = 1", startLine: 3, endLine: 4, projectId: "p1" } })
  send("n1", "/work/a.ts")
  assert.deepEqual(await win.next("composed"), { t: "composed", id: "n1", ok: true })
  const pending = h.published.filter((e) => e.type === "compose-pending")
  assert.equal(pending.length, 1)
  const id = (pending[0] as { id: string }).id
  assert.notEqual(id, "n1", "the server mints its own id; the extension's nonce is only echoed back")
  const item = h.bridge.takeCompose(id)
  assert.deepEqual(item, { path: "/work/a.ts", text: "const a = 1", startLine: 3, endLine: 4, projectId: "p1", id, app: "Cursor", at: new Date(1_000_000).toISOString() })
  assert.equal(h.bridge.takeCompose(id), null, "first caller wins")

  send("n2", "/work/first.ts")
  await win.next("composed")
  h.advance(1)
  send("n3", "/work/second.ts")
  await win.next("composed")
  assert.equal(h.bridge.takeCompose()?.path, "/work/first.ts", "no id: the oldest")
  h.advance(60_000)
  assert.equal(h.bridge.takeCompose(), null, "expired")

  for (const n of ["a", "b", "c"]) {
    send(n, `/work/${n}.ts`)
    assert.equal((await win.next("composed")).ok, true)
  }
  const before = h.published.length
  send("d", "/work/d.ts")
  const refused = await win.next("composed")
  assert.equal(refused.ok, false)
  assert.match(refused.error ?? "", /already waiting/)
  assert.equal(h.published.length, before, "a refused item is not announced")
})

/** An `editor` frame: the file in front with a selection, one tab, one error. */
function snapshot(active: string, over: Partial<EditorSnapshot> = {}): EditorSnapshot {
  return {
    t: "editor",
    shared: true,
    active: { path: active, languageId: "typescript", dirty: false, lineCount: 9, cursorLine: 3, selection: { startLine: 2, endLine: 3, text: "let x = 1\nx++" }, visible: { startLine: 1, endLine: 9 } },
    open: [{ path: "/elsewhere/b.ts", dirty: true }],
    diagnostics: [{ path: active, line: 2, severity: "error", message: "Cannot find name 'y'.", source: "ts", code: "2304" }],
    problems: { errors: 1, warnings: 0 },
    ...over,
  }
}

test("editor state: kept per window, answered for the windows that have the project open, the one used last first, forgotten with the window", async (t) => {
  const h = await harness(t)
  const dirs = tree(t)
  // The project is `mono`. A window on the monorepo itself, used a minute ago:
  const onMono = await editor(h.port, { folders: [dirs.mono], focused: false, focusedAgoMs: 60_000 })
  // one on a package INSIDE it (a thread's worktree opened with "Open in editor" is the same shape), in front now:
  const onPkg = await editor(h.port, { folders: [dirs.pkg], focused: true })
  // one with no folder, showing a file of the project (`code a.ts`):
  const loose = await editor(h.port, { folders: [], focused: false })
  // and one on another project entirely.
  const other = await editor(h.port, { app: "Cursor", folders: [dirs.other], focused: false })
  onMono.send(snapshot(dirs.inMono))
  onPkg.send(snapshot(dirs.inPkg, { open: [] }))
  loose.send(snapshot(dirs.inPkg, { diagnostics: [], problems: { errors: 0, warnings: 0 } }))
  other.send(snapshot(dirs.outside))
  await until(() => h.bridge.editorState(dirs.mono).windows.filter((w) => w.editor).length === 3, "three windows' state")

  h.advance(4_000)
  const state = h.bridge.editorState(dirs.mono)
  assert.equal(state.connected, 4)
  // The window on another project is counted and nothing else: its folder is another project's business.
  assert.deepEqual(Object.keys(state).sort(), ["connected", "windows"])
  assert.ok(!JSON.stringify(state).includes(dirs.other), "no trace of the other project's folder")
  assert.deepEqual(state.windows.map((w) => [w.folders, w.focused, w.focusedAgoMs]), [
    [[dirs.pkg], true, undefined],
    [[dirs.mono], false, 60_000 + 4_000],
    [[], false, undefined],
  ], "the window in front, then the one used a minute ago, then the one never focused")
  const { t: _t, ...expected } = snapshot(dirs.inPkg, { open: [] })
  assert.deepEqual(state.windows[0]!.editor, { ...expected, reportedAgoMs: 4_000 }, "kept whole, with how long ago it came")

  // A new frame replaces the old one whole; turning sharing off leaves nothing but that it is off.
  onPkg.send({ t: "editor", shared: false, active: null, open: [], diagnostics: [], problems: { errors: 0, warnings: 0 } })
  await until(() => h.bridge.editorState(dirs.mono).windows[0]!.editor?.shared === false, "sharing off")
  assert.deepEqual(h.bridge.editorState(dirs.mono).windows[0]!.editor, { shared: false, active: null, open: [], diagnostics: [], problems: { errors: 0, warnings: 0 }, reportedAgoMs: 0 })

  // A window that has said nothing yet (an extension from before the frame) is listed without an editor.
  const silent = await editor(h.port, { folders: [dirs.mono] })
  assert.equal(h.bridge.editorState(dirs.mono).windows.filter((w) => !w.editor).length, 1)

  // Gone with the window. The loose window was matched only by its file in front: once it has none, it
  // does not have the project open.
  onPkg.ws.close()
  loose.send(snapshot(dirs.outside))
  silent.ws.close()
  await until(() => h.bridge.editorState(dirs.mono).windows.length === 1, "the closed windows gone, the loose one elsewhere")
  assert.deepEqual(h.bridge.editorState(dirs.mono).windows.map((w) => w.folders), [[dirs.mono]])
  assert.equal(h.bridge.editorState(dirs.mono).connected, 3)
  // A folder that does not exist has no window.
  assert.deepEqual(h.bridge.editorState(join(dirs.root, "gone")).windows, [])
})

// A thread's checkout outside the project folder (a sibling worktree, `~/repo-perf`): a window opened on it
// is that thread's window, so the worker asking from that thread reads it rather than "none has this
// project open". Only when the caller names the folder — to every other project's worker it is only counted.
test("editor state: a folder passed beside the project counts as the project's", async (t) => {
  const h = await harness(t)
  const dirs = tree(t)
  const onOther = await editor(h.port, { folders: [dirs.other], focused: true })
  onOther.send(snapshot(dirs.outside))
  await until(() => h.bridge.editorState(dirs.mono, [dirs.other]).windows.some((w) => w.editor), "the window's state")
  assert.deepEqual(h.bridge.editorState(dirs.mono, [dirs.other]).windows.map((w) => w.folders), [[dirs.other]])
  assert.deepEqual(h.bridge.editorState(dirs.mono).windows, [], "without it, the window is another project's")
  // …counted, never described (vscode-r4-context dropped `elsewhere`: another project's folders are not this worker's).
  assert.equal(h.bridge.editorState(dirs.mono).connected, 1)
  assert.deepEqual(h.bridge.editorState(dirs.mono, [join(dirs.root, "gone")]).windows, [], "a folder that does not exist adds nothing")
})

test("an editor frame ntwine cannot take closes the socket like any other bad frame", async (t) => {
  const h = await harness(t)
  const send = async (frame: unknown) => {
    const win = await editor(h.port)
    win.send(frame)
    return (await win.closed).code
  }
  const good = snapshot("/work/alpha/a.ts")
  assert.equal(await send({ ...good, extra: 1 }), EDITOR_CLOSE.invalidMessage, "an unknown key")
  const many = Array.from({ length: EDITOR_STATE_MAX_DIAGNOSTICS + 1 }, () => good.diagnostics[0]!)
  assert.equal(await send({ ...good, diagnostics: many }), EDITOR_CLOSE.invalidMessage, "past the diagnostics cap")
  assert.equal(await send({ ...good, active: { ...good.active!, selection: { startLine: 1, endLine: 2, text: "x".repeat(70 * 1024) } } }), EDITOR_CLOSE.invalidMessage, "past the frame ceiling")
  // And a good one does not: the window is still connected after it.
  const win = await editor(h.port, { folders: ["/work/alpha"] })
  win.send(good)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(win.ws.readyState, WebSocket.OPEN)
})

test("`editors` is published when a window comes, goes or changes what the page shows — never for focus", async (t) => {
  const h = await harness(t)
  const editorsEvents = () => h.published.filter((e): e is Extract<ServerEvent, { type: "editors" }> => e.type === "editors").map((e) => e.windows)
  const a = await editor(h.port, { app: "Visual Studio Code - Insiders" })
  // The extension's build rides along, so the page (and anyone asking `editorWindows`) can say which one a window runs.
  assert.deepEqual(editorsEvents(), [[{ app: "Visual Studio Code - Insiders", kind: "vscode", acceptsOpens: true, extensionVersion: "0.0.1" }]])
  const b = await editor(h.port, { app: "Windsurf" })
  assert.equal(editorsEvents().length, 2)
  b.state({ focused: true })
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(editorsEvents().length, 2, "focus is not something the page shows")
  b.state({ acceptsOpens: false })
  await until(() => editorsEvents().length === 3, "the acceptsOpens change")
  assert.deepEqual(h.bridge.windows(), [
    { app: "Visual Studio Code - Insiders", kind: "vscode", acceptsOpens: true, extensionVersion: "0.0.1" },
    { app: "Windsurf", kind: "windsurf", acceptsOpens: false, extensionVersion: "0.0.1" },
  ])
  a.ws.close()
  await until(() => editorsEvents().length === 4, "the disconnect")
  assert.deepEqual(editorsEvents().at(-1), [{ app: "Windsurf", kind: "windsurf", acceptsOpens: false, extensionVersion: "0.0.1" }])
})

// THE BROWSER TAB'S LINE (`editorFront`): what the agents' tool would read, named — never its text until a
// click asks — and an `editor-front` ping whenever the answer for some project could have changed.
test("front: the file and selection lines of the window the tool would read, only while it shares; the click's item quotes only whole text", async (t) => {
  const h = await harness(t, { frontCoalesceMs: 10 })
  const dirs = tree(t)
  assert.equal(h.bridge.front(dirs.mono), null, "no window")
  const used = await editor(h.port, { folders: [dirs.mono], focused: false, focusedAgoMs: 60_000 })
  const now = await editor(h.port, { app: "Cursor", folders: [dirs.pkg], focused: true })
  const other = await editor(h.port, { folders: [dirs.other], focused: false })
  assert.equal(h.bridge.front(dirs.mono), null, "windows that have said nothing of their editor")
  used.send(snapshot(dirs.inMono))
  now.send(snapshot(dirs.inPkg, { active: { ...snapshot(dirs.inPkg).active!, dirty: true } }))
  other.send(snapshot(dirs.outside))
  await until(() => h.bridge.front(dirs.mono)?.app === "Cursor", "the window in front's report")
  // The window in front, as the tool ranks them — and nothing of the selection but its lines.
  assert.deepEqual(h.bridge.front(dirs.mono), { app: "Cursor", kind: "cursor", path: dirs.inPkg, dirty: true, cursorLine: 3, selection: { startLine: 2, endLine: 3 } })
  assert.ok(!JSON.stringify(h.bridge.front(dirs.mono)).includes("let x"), "no text in the line")
  assert.deepEqual(h.bridge.frontItem(dirs.mono), { path: dirs.inPkg, startLine: 2, endLine: 3, text: "let x = 1\nx++" })
  assert.equal(h.bridge.front(dirs.other)?.path, dirs.outside, "each project its own window")

  // Cut short, or withheld: the lines alone.
  now.send(snapshot(dirs.inPkg, { active: { ...snapshot(dirs.inPkg).active!, selection: { startLine: 2, endLine: 90, text: "let x", truncated: true } } }))
  await until(() => h.bridge.front(dirs.mono)?.selection?.endLine === 90, "the long selection")
  assert.deepEqual(h.bridge.frontItem(dirs.mono), { path: dirs.inPkg, startLine: 2, endLine: 90 })
  now.send(snapshot(dirs.inPkg, { active: { ...snapshot(dirs.inPkg).active!, selection: { startLine: 4, endLine: 4, withheld: true } } }))
  await until(() => h.bridge.front(dirs.mono)?.withheld === true, "the withheld selection")
  assert.deepEqual(h.bridge.front(dirs.mono)?.selection, { startLine: 4, endLine: 4 })
  assert.deepEqual(h.bridge.frontItem(dirs.mono), { path: dirs.inPkg, startLine: 4, endLine: 4 })
  // Only a caret: the file.
  now.send(snapshot(dirs.inPkg, { active: { ...snapshot(dirs.inPkg).active!, selection: undefined, cursorLine: 7 } }))
  await until(() => h.bridge.front(dirs.mono)?.selection === undefined, "the caret alone")
  assert.equal(h.bridge.front(dirs.mono)?.cursorLine, 7)
  assert.deepEqual(h.bridge.frontItem(dirs.mono), { path: dirs.inPkg })
  // An untitled buffer is named, and cannot be added.
  now.send(snapshot("Untitled-1", { active: { ...snapshot("Untitled-1").active!, untitled: true } }))
  await until(() => h.bridge.front(dirs.mono)?.untitled === true, "the untitled buffer")
  assert.equal(h.bridge.front(dirs.mono)?.path, "Untitled-1")
  assert.equal(h.bridge.frontItem(dirs.mono), null)

  // The window in front stops sharing: the tool would read nothing from it, and neither does the line —
  // not the window behind it either, since that is not the one the tool reads.
  now.send({ t: "editor", shared: false, active: null, open: [], diagnostics: [], problems: { errors: 0, warnings: 0 } })
  await until(() => h.bridge.front(dirs.mono) === null, "sharing off")
  assert.equal(h.bridge.frontItem(dirs.mono), null)
  // It closes: the window used before it is the one now.
  now.ws.close()
  await until(() => h.bridge.front(dirs.mono)?.path === dirs.inMono, "the other window")
})

test("`editor-front` is published once per burst, only when what a page could show changed", async (t) => {
  const h = await harness(t, { frontCoalesceMs: 30 })
  const dirs = tree(t)
  const pings = () => h.published.filter((e) => e.type === "editor-front").length
  const win = await editor(h.port, { folders: [dirs.mono], focused: true })
  await until(() => pings() === 1, "the window's arrival")
  // A burst of frames — a drag over lines — is one ping.
  for (let end = 3; end <= 6; end++) win.send(snapshot(dirs.inMono, { active: { ...snapshot(dirs.inMono).active!, selection: { startLine: 2, endLine: end, text: "x" } } }))
  await until(() => pings() === 2, "the burst")
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(pings(), 2, "one ping for four frames")
  // What no page shows — a tab, a diagnostic, the lines on screen, the text itself — is no ping.
  win.send(snapshot(dirs.inMono, { active: { ...snapshot(dirs.inMono).active!, selection: { startLine: 2, endLine: 6, text: "something else" }, visible: { startLine: 3, endLine: 40 } }, open: [], diagnostics: [], problems: { errors: 0, warnings: 0 } }))
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(pings(), 2, "nothing the line shows changed")
  // A second window in front reorders who the tool reads: a ping, though neither window's editor moved.
  const second = await editor(h.port, { folders: [dirs.mono], focused: false })
  second.send(snapshot(dirs.inPkg))
  await until(() => pings() === 3, "the second window's report")
  second.state({ focused: true })
  await until(() => pings() === 4, "the focus moving")
  assert.equal(h.bridge.front(dirs.mono)?.path, dirs.inPkg)
  // Sharing off, and a window leaving: each a ping.
  second.send({ t: "editor", shared: false, active: null, open: [], diagnostics: [], problems: { errors: 0, warnings: 0 } })
  await until(() => pings() === 5, "sharing off")
  second.ws.close()
  await until(() => pings() === 6, "the window gone")
})

/** A project's bus as the bridge hears it, counting its listeners so a test can see a subscription end. */
function countingBus() {
  const listeners = new Set<(event: ServerEvent) => void>()
  return {
    listeners,
    subscribe(listener: (event: ServerEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    publish(event: ServerEvent) {
      for (const listener of listeners) listener(event)
    },
  }
}

const queuedView = (id: string, extra: Partial<ThreadView> = {}) =>
  ({ id, title: id, kind: "session", needsYou: true, state: "active", aiTitle: "Tidy the sample loop", titleNamed: true, ...extra }) as unknown as ThreadView

test("a thread that needs the human is told to ONE window: of those listening that have its project open, the one used last", async (t) => {
  const dirs = tree(t)
  const bus = countingBus()
  let threads: ThreadView[] = []
  const h = await harness(t, { projectsPollMs: 20, openProjects: () => [{ id: "p1", dir: dirs.mono, bus, board: { snapshot: async () => ({ threads }) } }] })
  const needsYou = (slug: string, body?: string) => bus.publish({ type: "notify", slug, kind: "needs-decision", title: slug, ...(body ? { body } : {}) })
  const attentions = (win: Awaited<ReturnType<typeof editor>>) => win.frames.filter((m) => m.t === "attention")
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60))

  // The project's folder, a package inside it (a window opened on a thread's worktree is the same case),
  // and a window on something else entirely.
  const whole = await editor(h.port, { folders: [dirs.mono] })
  const inside = await editor(h.port, { folders: [dirs.pkg] })
  const elsewhere = await editor(h.port, { folders: [dirs.other], focused: true })
  await settle()
  assert.equal(bus.listeners.size, 0, "nobody listens yet, so no bus is heard")

  for (const win of [whole, inside, elsewhere]) win.send({ t: "listen", attention: true })
  await until(() => bus.listeners.size === 1, "the open project's bus heard")
  inside.state({ folders: [dirs.pkg], focused: true })
  inside.state({ folders: [dirs.pkg], focused: false })
  h.advance(10)
  threads = [queuedView("tidy", { pendingQuestion: true })]
  needsYou("tidy", "Which branch should I merge into?")
  const told = await inside.next("attention")
  assert.deepEqual(told, {
    t: "attention",
    projectId: "p1",
    thread: { id: "tidy", title: "tidy", aiTitle: "Tidy the sample loop", titleNamed: true },
    needs: "question",
    body: "Which branch should I merge into?",
  })
  await settle()
  assert.equal(attentions(whole).length + attentions(elsewhere).length, 0, "one window: the one used last of those with the project, never one without it")

  // Answered before the board was read again: no longer news.
  threads = [queuedView("tidy", { needsYou: false })]
  needsYou("tidy")
  // Not the needs-you edge: a turn ending is what the page announces separately, and the queue entry follows.
  threads = [queuedView("other")]
  bus.publish({ type: "notify", slug: "other", kind: "turn-done", title: "other" })
  await settle()
  assert.equal(attentions(inside).length, 0)

  // The window used last stops listening (ntwine.notify off): the next one with the project open is told.
  inside.send({ t: "listen", attention: false })
  await settle()
  needsYou("other")
  assert.equal((await whole.next("attention")).thread.id, "other")
  assert.equal(attentions(elsewhere).length, 0)

  // The last listener with the project gone: the bus is let go.
  for (const win of [whole, inside, elsewhere]) win.ws.close()
  await until(() => bus.listeners.size === 0, "the bus let go with the last listening window")
})

test("what a queued thread needs, most pressing first, from the queue's own urgency reasons", () => {
  assert.equal(attentionNeeds(queuedView("a")), "ready", "a turn that finished")
  assert.equal(attentionNeeds(queuedView("a", { pendingQuestion: true })), "question")
  assert.equal(attentionNeeds(queuedView("a", { questions: [{ id: "q1" }] } as Partial<ThreadView>)), "question")
  assert.equal(attentionNeeds(queuedView("a", { actionableInteraction: true, pendingQuestion: true })), "approval")
  assert.equal(attentionNeeds(queuedView("a", { runtime: "perm-prompt" })), "approval")
  assert.equal(attentionNeeds(queuedView("a", { terminals: [{ awaitingInput: true }], actionableInteraction: true } as Partial<ThreadView>)), "terminal")
  assert.equal(attentionNeeds(queuedView("a", { crashed: true })), "stopped")
  assert.equal(attentionNeeds(queuedView("a", { limitPause: {} } as Partial<ThreadView>)), "limit")
})

test("review: only a window that said it can, the one holding the checkout first, then the project, then the one used last", async (t) => {
  const h = await harness(t)
  const dirs = tree(t)
  const target = (dir: string) => ({ title: "Tidy the loop", checkouts: [{ dir, scope: "branch" as const, files: [join(dir, "a.ts")] }] })
  const reviews = (window: { requests: EditorServerMessage[] }) => window.requests.filter((r) => r.t === "review")

  // An extension from before the feature never says it can: nothing is sent to it, and the page is not
  // offered the action (`reviews` absent from the summary).
  const old = await editor(h.port, { folders: [dirs.pkg], focused: true })
  assert.equal(await h.bridge.review(target(dirs.pkg), dirs.mono), false)
  assert.equal(reviews(old).length, 0)
  assert.deepEqual(h.bridge.windows(), [{ app: "Visual Studio Code", kind: "vscode", acceptsOpens: true, extensionVersion: "0.0.1" }])

  const monoWin = await editor(h.port, { folders: [dirs.mono], focused: true })
  monoWin.send({ t: "features", features: ["review", "something-newer"] })
  const pkgWin = await editor(h.port, { folders: [dirs.other, dirs.pkg] })
  pkgWin.send({ t: "features", features: ["review"] })
  await until(() => h.bridge.windows().filter((w) => w.reviews).length === 2, "both windows saying they can review")
  assert.ok(h.published.some((e) => e.type === "editors" && e.windows.some((w) => w.reviews)), "the page hears it")

  // The window holding the checkout — the deepest folder, focused or not — gets the whole target.
  assert.equal(await h.bridge.review(target(dirs.pkg), dirs.mono), true)
  assert.deepEqual(reviews(pkgWin).map((r) => ({ ...r, id: undefined })), [{ t: "review", id: undefined, ...target(dirs.pkg) }])
  assert.equal(reviews(monoWin).length, 0)
  assert.equal(reviews(old).length, 0)

  // No window holds the checkout: the one holding the project.
  const elsewhere = join(dirs.root, "elsewhere")
  mkdirSync(elsewhere)
  assert.equal(await h.bridge.review(target(elsewhere), dirs.mono), true)
  assert.equal(reviews(monoWin).length, 1)

  // Neither: the window used last on this machine; a window that turned opens off never.
  assert.equal(await h.bridge.review(target(elsewhere), elsewhere), true)
  assert.equal(reviews(monoWin).length, 2, "focused now")
  monoWin.state({ acceptsOpens: false })
  await until(() => h.bridge.windows().some((w) => !w.acceptsOpens), "opens off")
  assert.equal(await h.bridge.review(target(dirs.mono), dirs.mono), true)
  assert.equal(reviews(monoWin).length, 2)
  assert.equal(reviews(pkgWin).length, 2, "the only window left that takes things from ntwine")
})

test("review: a window that says it could not is the error, in its own words; silence is false", async (t) => {
  const h = await harness(t)
  const dirs = tree(t)
  const failing = await editor(h.port, { folders: [dirs.mono] }, "fail")
  failing.send({ t: "features", features: ["review"] })
  await until(() => h.bridge.windows().some((w) => w.reviews), "the feature")
  await assert.rejects(h.bridge.review({ title: "x", checkouts: [{ dir: dirs.mono, scope: "files", files: [dirs.inMono] }] }, dirs.mono), /binary file/)
  failing.ws.close()
  await until(() => h.bridge.windows().length === 0, "the window gone")
  const silent = await editor(h.port, { folders: [dirs.mono] }, "silent")
  silent.send({ t: "features", features: ["review"] })
  await until(() => h.bridge.windows().some((w) => w.reviews), "the feature")
  const started = Date.now()
  assert.equal(await h.bridge.review({ title: "x", checkouts: [] }, dirs.mono), false)
  assert.ok(Date.now() - started >= 600, "a review waits longer than an open for its answer")
})

test("a features frame from a window that is not the schema's closes it like any other bad frame", async (t) => {
  const h = await harness(t)
  const window = await editor(h.port)
  window.send({ t: "features", features: "review" })
  assert.equal((await window.closed).code, EDITOR_CLOSE.invalidMessage)
})

test("a window that reconnects supersedes its old socket, and a dead peer is reaped by protocol pings", async (t) => {
  const h = await harness(t, { heartbeatMs: 40 })
  const windowId = randomUUID()
  const old = await editor(h.port, { windowId })
  await editor(h.port, { windowId })
  assert.equal((await old.closed).code, 1000)
  assert.equal(h.bridge.windows().length, 1)
  const dead = await editor(h.port, {}, "ok", { autoPong: false })
  const alive = await editor(h.port)
  assert.equal(h.bridge.windows().length, 3)
  await dead.closed
  await until(() => h.bridge.windows().length === 2, "the silent peer to be dropped")
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(h.bridge.windows().length, 2, "the silent peer is gone; the answering one stays")
  assert.ok(alive.frames.some((m) => m.t === "hb"), "and windows hear the heartbeat frame")
  assert.equal(alive.ws.readyState, WebSocket.OPEN)
})

test("a handshake ws refuses itself gives its window slot back, so malformed upgrades cannot lock windows out", async (t) => {
  // ws answers a bad key, version or method with its own 400/405 and never calls back. A slot reserved
  // for it and never released was gone until restart: 32 of these refused every editor with 503.
  const maxWindows = 2
  const h = await harness(t, { maxWindows })
  const key = "dGhlIHNhbXBsZSBub25jZQ=="
  for (let i = 0; i < maxWindows; i++) {
    assert.equal(await malformedUpgradeStatus(h.port, EDITOR_SOCKET_PATH, { "Sec-WebSocket-Version": "13" }), 400, "no key")
    assert.equal(await malformedUpgradeStatus(h.port, EDITOR_SOCKET_PATH, { "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "7" }), 400, "a version ws does not speak")
    assert.equal(await malformedUpgradeStatus(h.port, EDITOR_SOCKET_PATH, { "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13" }, "POST"), 405, "not a GET")
  }
  const windows = [await editor(h.port), await editor(h.port)]
  assert.equal(h.bridge.windows().length, maxWindows, "every slot is still there for a real window")
  assert.equal(await rejectedStatus(h.port, EDITOR_SOCKET_PATH, { origin: `http://127.0.0.1:${h.port}` }), 503, "and the cap still holds")
  for (const w of windows) w.ws.close()
})

test(`at most ${EDITOR_MAX_WINDOWS} windows, then 503; after close, 503 and every waiting open is false`, async (t) => {
  const h = await harness(t, { requestTimeoutMs: 5_000 })
  const dirs = tree(t)
  const windows: Awaited<ReturnType<typeof editor>>[] = []
  for (let i = 0; i < EDITOR_MAX_WINDOWS; i++) windows.push(await editor(h.port, { folders: i === 0 ? [dirs.pkg] : [] }, i === 0 ? "silent" : "ok"))
  assert.equal(await rejectedStatus(h.port, EDITOR_SOCKET_PATH, { origin: `http://127.0.0.1:${h.port}` }), 503)
  windows.at(-1)!.ws.close()
  await windows.at(-1)!.closed
  await until(() => h.bridge.windows().length === EDITOR_MAX_WINDOWS - 1, "the slot to free")
  const back = new WebSocket(`ws://127.0.0.1:${h.port}${EDITOR_SOCKET_PATH}`, { origin: `http://127.0.0.1:${h.port}` })
  await once(back, "open")
  back.close()

  const waiting = h.bridge.openFile(dirs.inPkg, { line: 1 }, ["vscode"])
  await until(() => windows[0]!.requests.length === 1, "the open to arrive")
  const started = Date.now()
  await h.bridge.close()
  assert.equal(await waiting, false)
  assert.ok(Date.now() - started < 1_000)
  assert.equal(await rejectedStatus(h.port, EDITOR_SOCKET_PATH, { origin: `http://127.0.0.1:${h.port}` }), 503)
})

test("the projects frame: every live project and Home, counts only for the open ones, from the rail's predicates", async () => {
  const view = (extra: Partial<ThreadView>) => ({ kind: "session", state: "open", runtime: "turn-idle", ...extra }) as ThreadView
  const projects = await listEditorProjects(
    [
      { id: "a", slug: "alpha", name: "Alpha", path: "/work/alpha", stale: false },
      { id: "b", slug: "beta", path: "/work/beta-repo", stale: false },
      { id: "gone", slug: "gone", path: "/work/gone", stale: true },
      { id: HOME_WORKSPACE_ID, slug: "home", name: "Home", path: HOME, stale: false },
    ],
    [
      {
        project: { id: "a" },
        board: {
          snapshot: async () => ({
            threads: [
              view({ needsYou: true }),
              view({ needsYou: true }),
              view({ needsYou: true, foreign: true }),
              view({ runtime: "running" }),
              view({ state: "archived", needsYou: true }),
            ],
          }),
        },
      },
      { project: { id: HOME_WORKSPACE_ID }, board: { snapshot: async () => { throw new Error("stopping") } } },
    ],
  )
  assert.deepEqual(projects, [
    { id: "a", slug: "alpha", name: "Alpha", dir: "/work/alpha", ready: 2, working: 1 },
    { id: "b", slug: "beta", name: "beta-repo", dir: "/work/beta-repo" },
    { id: HOME_WORKSPACE_ID, slug: "home", name: "Home", dir: HOME, home: true },
  ])
})
