import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EditorComposeItem, EditorKind, FilePosition, LocalFileOpener } from "@ntwine/shared"
import { createRouter } from "./router.ts"
import type { AppContext } from "./context.ts"
import type { EditorBridge } from "./editor-bridge.ts"

// The router's half of the editor bridge: which opener a click reaches. The fallback spawn is REAL — a
// stand-in `code` on disk that logs its argv — so "the bridge declined, the editor was spawned at the
// line" is the actual child process's argv, not a stub's say-so.

interface Calls {
  open: [string, FilePosition | undefined, readonly EditorKind[]][]
  focus: [string, readonly EditorKind[]][]
}

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-router-editor-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const project = join(root, "project")
  const bin = join(root, "bin")
  mkdirSync(project)
  mkdirSync(bin)
  const file = join(project, "a.ts")
  writeFileSync(file, "x")
  const log = join(root, "opener.log")
  const code = join(bin, "code")
  writeFileSync(code, `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\n`)
  chmodSync(code, 0o755)
  const saved = { VISUAL: process.env.VISUAL, EDITOR: process.env.EDITOR, PATH: process.env.PATH }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  // `$EDITOR` names the stand-in, so the Local file links value "editor" maps to the VS Code family and spawns it.
  process.env.VISUAL = code
  delete process.env.EDITOR
  const spawned = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : null)
  return { root, project, file, spawned }
}

function router(dir: string, opener: LocalFileOpener, editors?: Partial<EditorBridge>) {
  const ctx = {
    project: { dir, stateDir: dir, id: "p", name: "p", label: "p", cwdSlug: "p" },
    storage: {},
    board: {},
    tailer: {},
    getSettings: () => ({ localFileOpener: opener }),
    editors,
  } as unknown as AppContext
  return createRouter(ctx)
}

function bridge(answer: boolean | Error, calls: Calls): Partial<EditorBridge> {
  const settle = async () => {
    if (answer instanceof Error) throw answer
    return answer
  }
  return {
    openFile: (path, position, kinds) => {
      calls.open.push([path, position, kinds])
      return settle()
    },
    focusFolder: (dir, kinds) => {
      calls.focus.push([dir, kinds])
      return settle()
    },
  }
}

test("a connected editor gets the file at the asked position, and nothing is spawned", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t)
  const calls: Calls = { open: [], focus: [] }
  const r = router(f.project, "editor", bridge(true, calls))
  assert.deepEqual(await r.openLocalFile.handler({ input: { path: f.file, line: 12, column: 3, endLine: 20 } }), { action: "opened", path: f.file })
  // The page sent no position, but the path carries one: it is split off and handed over.
  assert.deepEqual(await r.openLocalFile.handler({ input: { path: `${f.file}:7` } }), { action: "opened", path: f.file })
  assert.deepEqual(calls.open, [
    [f.file, { line: 12, column: 3, endLine: 20 }, ["vscode"]],
    [f.file, { line: 7 }, ["vscode"]],
  ])
  assert.equal(f.spawned(), null)
})

test("no window takes it: the editor is spawned, at the position", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t)
  const calls: Calls = { open: [], focus: [] }
  const r = router(f.project, "editor", bridge(false, calls))
  assert.deepEqual(await r.openLocalFile.handler({ input: { path: f.file, line: 12, column: 3 } }), { action: "opened", path: f.file })
  assert.equal(calls.open.length, 1)
  assert.deepEqual(f.spawned(), ["-g", `${f.file}:12:3`])
  // No bridge at all (a context the server did not build) spawns the same way.
  rmSync(join(f.root, "opener.log"))
  await router(f.project, "editor").openLocalFile.handler({ input: { path: f.file, line: 5 } })
  assert.deepEqual(f.spawned(), ["-g", `${f.file}:5`])
})

test("a window that answers it could not is the error, and no second opener is spawned", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t)
  const r = router(f.project, "editor", bridge(new Error("Could not open a.ts"), { open: [], focus: [] }))
  await assert.rejects(r.openLocalFile.handler({ input: { path: f.file, line: 1 } }), /^Error: Could not open a\.ts$/)
  assert.equal(f.spawned(), null)
})

test("a setting that is not an editor, or an image, never asks the bridge", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t)
  const calls: Calls = { open: [], focus: [] }
  assert.deepEqual(await router(f.project, "copy", bridge(true, calls)).openLocalFile.handler({ input: { path: f.file, line: 3 } }), { action: "copy", path: f.file })
  // An image goes to the system viewer. Nothing is on PATH, so the spawn fails — which proves it was tried.
  const empty = join(f.root, "empty")
  mkdirSync(empty)
  process.env.PATH = empty
  await assert.rejects(
    router(f.project, "editor", bridge(true, calls)).openLocalFile.handler({ input: { path: f.file, image: true } }),
    /xdg-open is not installed/,
  )
  assert.deepEqual(calls.open, [])
})

test("Open in editor raises the window that has the folder open, else spawns the editor on it", { skip: process.platform === "win32" }, async (t) => {
  const f = fixture(t)
  const calls: Calls = { open: [], focus: [] }
  // "system" is not an editor, so a folder goes to $EDITOR (folderEditor) — and the bridge is asked for
  // THAT family.
  assert.deepEqual(await router(f.project, "system", bridge(true, calls)).openProjectFolder.handler({ input: {} }), { path: f.project })
  assert.deepEqual(calls.focus, [[f.project, ["vscode"]]])
  assert.equal(f.spawned(), null)
  assert.deepEqual(await router(f.project, "editor", bridge(false, calls)).openProjectFolder.handler({ input: {} }), { path: f.project })
  assert.deepEqual(f.spawned(), [f.project])
  // No editor to open a folder in at all: the reason, and the bridge is never asked.
  process.env.VISUAL = "nvim"
  await assert.rejects(router(f.project, "system", bridge(true, calls)).openProjectFolder.handler({ input: {} }), /Set Local file links to an editor/)
  assert.equal(calls.focus.length, 2)
})

test("editorWindows and composeTake answer from the bridge, and from nothing without one", async () => {
  const item: EditorComposeItem = { id: "c1", app: "Cursor", at: "2026-10-01T00:00:00.000Z", path: "/p/a.ts", text: "x", startLine: 1 }
  const taken: (string | undefined)[] = []
  const r = router(tmpdir(), "vscode", {
    windows: () => [{ app: "Cursor", kind: "cursor", acceptsOpens: true }],
    takeCompose: (id) => {
      taken.push(id)
      return id === "c1" ? item : null
    },
  })
  assert.deepEqual(await r.editorWindows.handler({}), { windows: [{ app: "Cursor", kind: "cursor", acceptsOpens: true }] })
  assert.deepEqual(await r.composeTake.handler({ input: { id: "c1" } }), { item })
  assert.deepEqual(await r.composeTake.handler({ input: {} }), { item: null })
  assert.deepEqual(taken, ["c1", undefined])
  const bare = router(tmpdir(), "vscode")
  assert.deepEqual(await bare.editorWindows.handler({}), { windows: [] })
  assert.deepEqual(await bare.composeTake.handler({ input: {} }), { item: null })
})

test("editorState asks the bridge about the folder the project's agents work in, and answers nothing without one", async () => {
  const asked: string[] = []
  const answer = { windows: [], connected: 2 }
  const editors: Partial<EditorBridge> = { editorState: (dir) => (asked.push(dir), answer) }
  assert.deepEqual(await router("/work/alpha", "vscode", editors).editorState.handler({ input: {} }), answer)
  // Home keeps its board in a state directory and runs its agents in the home folder (project.ts
  // workDirOf): the editor that matters is the one on the folder the agents are in.
  const home = createRouter({
    project: { dir: "/state/home", workDir: "/home/me", stateDir: "/state/home", id: "h", name: "Home", label: "Home", cwdSlug: "h" },
    storage: {}, board: {}, tailer: {}, getSettings: () => ({}), editors,
  } as unknown as AppContext)
  await home.editorState.handler({ input: {} })
  assert.deepEqual(asked, ["/work/alpha", "/home/me"])
  assert.deepEqual(await router("/work/alpha", "vscode").editorState.handler({ input: {} }), { windows: [], connected: 0 })
})

// What a worker's ntwine-mcp lists `editor` under (and what the contract's editor section is rendered
// under, dispatch.ts workerCapabilities): a window that has THIS project open — not merely one connected
// to Ntwine on another project, where the tool would only answer "none has this project open".
test("workerCapabilities reports an editor only while a window has this project open", async () => {
  const window = { app: "Visual Studio Code", kind: "vscode", focused: true, folders: ["/work/alpha"] }
  let answer: { windows: unknown[]; connected: number } = { windows: [], connected: 0 }
  const asked: string[] = []
  const editors = { editorState: (dir: string) => (asked.push(dir), answer) } as unknown as Partial<EditorBridge>
  const r = router("/work/alpha", "vscode", editors)
  assert.deepEqual(await r.workerCapabilities.handler({ input: {} }), { editor: false })
  answer = { windows: [], connected: 2 }
  assert.deepEqual(await r.workerCapabilities.handler({ input: {} }), { editor: false }, "windows on other projects only")
  answer = { windows: [window], connected: 2 }
  assert.deepEqual(await r.workerCapabilities.handler({ input: {} }), { editor: true })
  assert.deepEqual(asked, ["/work/alpha", "/work/alpha", "/work/alpha"])
  // A server with no bridge has no editor to offer.
  assert.deepEqual(await router("/work/alpha", "vscode").workerCapabilities.handler({ input: {} }), { editor: false })
})

// A worker in its own worktree asks for the editor: the answer says where that thread works, in the
// project folder's spelling, and a window opened on the worktree counts as this project's even when the
// worktree sits outside the project folder. A real repository and a real `git worktree add`, because the
// reading is the tailer's lift of a real folder (thread-cwd.ts), which checks `.git` on disk.
test("editorState names the calling thread's own checkout, and only when it is not the project root", { skip: process.platform === "win32" }, async (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-router-checkout-")))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const repo = join(base, "repo")
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" })
  execFileSync("git", ["init", "-q", "-b", "main", repo])
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init")
  const inside = join(repo, ".ntwine", "worktrees", "tidy")
  const sibling = join(base, "repo-perf")
  git("worktree", "add", "-q", inside, "-b", "tidy")
  git("worktree", "add", "-q", sibling, "-b", "perf")
  const working: Record<string, string> = { tidy: inside, perf: sibling, rooted: repo }
  const asked: [string, readonly string[] | undefined][] = []
  const editors: Partial<EditorBridge> = { editorState: (dir, also) => (asked.push([dir, also]), { windows: [], connected: 1 }) }
  const r = createRouter({
    project: { dir: repo, stateDir: repo, id: "p", name: "p", label: "p", cwdSlug: "p" },
    storage: { getSession: (slug: string) => (slug in working ? { slug } : undefined) },
    board: {},
    tailer: { get: (slug: string) => (slug in working ? { workingDir: working[slug] } : undefined) },
    getSettings: () => ({}),
    editors,
  } as unknown as AppContext)
  assert.deepEqual(await r.editorState.handler({ input: { slug: "tidy" } }), { windows: [], connected: 1, checkout: { dir: inside, root: repo, kind: "worktree" } })
  assert.deepEqual(await r.editorState.handler({ input: { slug: "perf" } }), { windows: [], connected: 1, checkout: { dir: sibling, root: repo, kind: "worktree" } })
  // At the root, unknown, or not named: no checkout, and the windows are matched by the project alone.
  for (const input of [{ slug: "rooted" }, { slug: "nobody" }, {}]) {
    assert.deepEqual(await r.editorState.handler({ input }), { windows: [], connected: 1 }, JSON.stringify(input))
  }
  assert.deepEqual(asked, [[repo, [inside]], [repo, [sibling]], [repo, []], [repo, []], [repo, []]])
  // An older MCP server sends `{}`; a newer one's `slug` must not be refused by this server's input.
  assert.equal(r.editorState.input.safeParse({ slug: "tidy", extra: 1 }).success, true)
})

// A thread in a worktree links its own copy; once the worktree is removed, the same link opens the main
// checkout's copy rather than "not found". A real repository, a real `git worktree add` and `remove`.
test("file links: a thread's worktree first, the main checkout after it is gone, and the page's spelling kept", { skip: process.platform === "win32" }, async (t) => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-router-links-")))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" })
  execFileSync("git", ["init", "-q", "-b", "main", repo])
  mkdirSync(join(repo, "src"))
  writeFileSync(join(repo, "src", "a.ts"), "main copy\n")
  git("add", ".")
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init")
  const tree = join(repo, ".ntwine", "worktrees", "tidy")
  git("worktree", "add", "-q", tree, "-b", "tidy")
  writeFileSync(join(tree, "src", "a.ts"), "worktree copy\n")
  writeFileSync(join(tree, "src", "new.ts"), "only in the worktree\n")
  mkdirSync(join(repo, ".ntwine", "threads", "x"), { recursive: true })
  writeFileSync(join(repo, ".ntwine", "threads", "x", "notes.md"), "# only in the main checkout\n")
  const r = router(repo, "copy")

  // Inline code from the worktree thread: its own copy first, then the project root.
  const { resolved } = await r.resolveLocalPaths.handler({ input: { paths: ["src/a.ts", "src/new.ts", ".ntwine/threads/x/notes.md", "src/nope.ts"], base: tree } })
  assert.deepEqual(resolved.map((each) => each.path), [join(tree, "src", "a.ts"), join(tree, "src", "new.ts"), join(repo, ".ntwine", "threads", "x", "notes.md"), null])
  // Without a base, the project root as always.
  assert.equal((await r.resolveLocalPaths.handler({ input: { paths: ["src/a.ts"] } })).resolved[0]!.path, join(repo, "src", "a.ts"))
  // A link resolved into the worktree for a file only the main checkout has (the page's base is the worktree).
  assert.equal((await r.settleLocalPath.handler({ input: { path: join(tree, ".ntwine", "threads", "x", "notes.md") } })).path, join(repo, ".ntwine", "threads", "x", "notes.md"))
  // While the worktree stands, its own files are what they are.
  assert.equal((await r.settleLocalPath.handler({ input: { path: join(tree, "src", "a.ts") } })).path, join(tree, "src", "a.ts"))
  assert.equal((await r.localFile.handler({ input: { path: join(tree, "src", "a.ts") } })).text, "worktree copy\n")

  // The worktree goes (merged and removed). Its links now open the main checkout's copy, in every opener.
  git("worktree", "remove", "--force", tree)
  assert.equal(existsSync(tree), false)
  assert.deepEqual(await r.settleLocalPath.handler({ input: { path: join(tree, "src", "a.ts") } }), { path: join(repo, "src", "a.ts") })
  assert.deepEqual(await r.localFile.handler({ input: { path: join(tree, "src", "a.ts") } }), { path: join(repo, "src", "a.ts"), text: "main copy\n", truncated: false })
  assert.equal((await r.localMarkdown.handler({ input: { path: join(tree, ".ntwine", "threads", "x", "notes.md") } })).markdown, "# only in the main checkout\n")
  assert.deepEqual(await r.openLocalFile.handler({ input: { path: join(tree, "src", "a.ts"), line: 1 } }), { action: "copy", path: join(repo, "src", "a.ts") })
  assert.equal((await r.resolveLocalPaths.handler({ input: { paths: [join(tree, "src", "a.ts")] } })).resolved[0]!.path, join(repo, "src", "a.ts"))
  // A file the main checkout never had stays missing, as asked — the error it gets is unchanged.
  assert.deepEqual(await r.settleLocalPath.handler({ input: { path: join(tree, "src", "new.ts") } }), { path: join(tree, "src", "new.ts") })
  await assert.rejects(r.localFile.handler({ input: { path: join(tree, "src", "new.ts") } }), /not found/i)
  // Outside the worktree folder nothing is rewritten, and the page's own spelling comes back (never a realpath).
  assert.deepEqual(await r.settleLocalPath.handler({ input: { path: join(repo, "src", "gone.ts") } }), { path: join(repo, "src", "gone.ts") })
  assert.deepEqual(await r.settleLocalPath.handler({ input: { path: "/etc/../etc/hosts" } }), { path: "/etc/../etc/hosts" })
})

test("openLocalFile takes a position only as positive whole numbers, and still nothing else", () => {
  const input = router(tmpdir(), "vscode").openLocalFile.input
  assert.equal(input.safeParse({ path: "/a", line: 1, column: 2, endLine: 3 }).success, true)
  for (const bad of [{ line: 0 }, { line: 1.5 }, { column: -1 }, { endLine: "3" }, { lineNumber: 3 }]) {
    assert.equal(input.safeParse({ path: "/a", ...bad }).success, false, JSON.stringify(bad))
  }
  assert.equal(router(tmpdir(), "vscode").composeTake.input.safeParse({ id: "x", extra: 1 }).success, false)
})
