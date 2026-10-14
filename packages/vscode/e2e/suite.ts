// THE END-TO-END SUITE — runs INSIDE a real VS Code (scripts/e2e.ts launches it as
// `--extensionTestsPath`), against the extension under development, and drives both directions:
// ntwine → editor (an `open` landing at its line, the status bar's count) and editor → ntwine (ask, send
// to thread, add to prompt), plus a dropped connection coming back. Then the ntwine sidebar (fake mode
// only): its frame of a fake page that speaks the embed contract (fake-ntwine.ts), the same three
// commands landing in that page instead, and what the page can ask of the editor.
//
// FAKE mode (default) talks to e2e/fake-ntwine.ts through its /__e2e control surface and asserts on the
// exact frames and RPC calls it received. REAL mode points the extension at a real ntwine
// (NTWINE_E2E_ORIGIN, with NTWINE_E2E_PROJECT_DIR as the opened folder, which must be a registered
// project) and asserts through the server's own RPCs instead; the steps that would start a real agent
// run only with NTWINE_E2E_DISPATCH=1; Send to thread follows up NTWINE_E2E_THREAD, or else the thread
// Ask just started.

import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import * as vscode from "vscode"
import { EDITOR_FEATURES, type EditorClientMessage, type EditorComposed, type EditorProject, type EditorSnapshot } from "@ntwine/shared/editor-protocol"
import type { EmbedContextPicksMessage, EmbedEditorContextMessage, EmbedPickedFile } from "@ntwine/shared/embed-protocol"
import { parseSentContext } from "../../web/src/lib/composerContext.ts"
import type { NtwineExtensionApi } from "../src/app.ts"
import { HINT_OLD_NTWINE } from "../src/sidebar-html.ts"
import { projectForPath } from "../src/projects.ts"
import { workerTool } from "./worker-tool.ts"
import type { ReviewSnapshot } from "../src/review-view.ts"
import { NtwineRpc } from "../src/rpc.ts"
import { seedReviewRepo, type ReviewRepo } from "./review-repo.ts"
import type { SeededReview } from "./review-seed.ts"

const mode = process.env.NTWINE_E2E_MODE === "real" ? "real" : "fake"
const workspace = realpathSync(process.env.NTWINE_E2E_WORKSPACE ?? "")
const sample = join(workspace, "src", "sample.ts")
const control = process.env.NTWINE_E2E_CONTROL ?? ""
const elsewhere = process.env.NTWINE_E2E_CONTROL_ELSEWHERE ?? ""

interface FakeLog {
  frames: EditorClientMessage[]
  refused: string[]
  rpc: { projectId: string; procedure: string; input: Record<string, unknown> }[]
  origins: string[]
  page: { loads: string[]; received: { origin: string; page?: string; data: { type?: string } & Record<string, unknown> }[] }
}

async function fake<T = unknown>(path: string, body?: unknown, at = control): Promise<T> {
  const response = await fetch(`${at}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  return (await response.json()) as T
}

const fakeLog = (at = control) => fake<FakeLog>("/__e2e/log", undefined, at)

/** What the fake page received from the sidebar after `from` messages, by type. */
async function pageReceived(type: string, from = 0, at = control) {
  return (await fakeLog(at)).page.received.slice(from).map((entry) => entry.data).filter((data) => data.type === type)
}

/**
 * A command that should land in the sidebar, bounded: when it does not, Ask and Send fall back to an
 * input box that would wait for a human forever. Dismissed, so the next step starts clean.
 */
async function landsInSidebar<T>(command: Thenable<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} did not land in the sidebar within 30s`)), 30_000)))
  try {
    return await Promise.race([command, late])
  } catch (error) {
    await vscode.commands.executeCommand("workbench.action.closeQuickOpen")
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** Have the fake page post `message` to the sidebar, as the real page would. */
const pagePosts = (message: unknown) => fake("/__e2e/page-post", { message })

/** Every `ntwine:editor-context` the page was told, after `from` messages. */
const contexts = async (from = 0) => (await pageReceived("ntwine:editor-context", from)) as unknown as EmbedEditorContextMessage[]
const received = async () => (await fakeLog()).page.received.length
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The workbench itself, over the harness's debugging port: an expression's value, a trusted key, a trusted click. */
async function workbench<T>(expression: string): Promise<T> {
  const answer = await fake<{ value?: T; error?: string }>("/__e2e/workbench", { expression })
  if (answer.error) throw new Error(answer.error)
  return answer.value as T
}
async function press(chord: string): Promise<void> {
  const answer = await fake<{ error?: string }>("/__e2e/press", { chord })
  if (answer.error) throw new Error(answer.error)
}
const click = async (selector: string) => (await fake<{ clicked?: boolean; error?: string }>("/__e2e/click", { selector })).clicked === true

/** What VS Code's title row above the sidebar shows: its heading and the buttons in it, by their labels. */
const titleRow = () => workbench<{ heading: string; buttons: string[] }>(`(() => {
  const title = document.querySelector(".part.sidebar .composite.title")
  return {
    heading: title?.querySelector(".title-label")?.textContent ?? "",
    buttons: [...(title?.querySelectorAll(".title-actions .action-label") ?? [])].filter((a) => a.offsetWidth > 0).map((a) => a.getAttribute("aria-label") ?? ""),
  }
})()`)

/**
 * Where the keyboard is in the workbench. A webview view's iframe is not in the side bar's DOM — VS Code
 * lays it over the view from a container of its own — so the sidebar is a webview iframe with a box.
 */
const focusIn = () => workbench<"editor" | "sidebar" | "elsewhere">(`(() => {
  const active = document.activeElement
  if (active?.closest(".part.editor")) return "editor"
  const r = active?.getBoundingClientRect()
  if (active?.tagName === "IFRAME" && active.classList.contains("webview") && r && r.width > 0) return "sidebar"
  return "elsewhere"
})()`)

/** The extension's own manifest, as the editor loaded it. */
const manifest = () => vscode.extensions.getExtension("ssalbdivad.ntwine-vscode")!.packageJSON as {
  contributes: { keybindings: unknown[]; menus: Record<string, { command?: string; when?: string; group?: string }[]> }
}

/** A `.env` with a key in it: a file whose name says it holds secrets. */
const SECRET = "sk-e2e-not-a-key"
function envFile(): string {
  const path = join(workspace, ".env")
  writeFileSync(path, `API_KEY=${SECRET}\n`)
  return path
}

/** A second file in the workspace for the steps that need more than one open. */
function workspaceFile(name: string): string {
  const path = join(workspace, "src", name)
  writeFileSync(path, `export const ${name.replace(/\W/gu, "_")} = 1\n`)
  return path
}

/** The query the sidebar's frame carries for this window. */
function embedQuery(project: EditorProject): string {
  const light = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light || vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight
  return `?embed=vscode&theme=${light ? "light" : "dark"}&project=${project.slug}`
}

async function until(what: string, condition: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function openSample(selection?: [number, number, number, number?]): Promise<vscode.TextEditor> {
  await vscode.commands.executeCommand("workbench.action.closeAllEditors")
  const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(sample))
  if (selection) {
    const [startLine, startCharacter, endLine, endCharacter] = selection
    editor.selection = new vscode.Selection(startLine, startCharacter, endLine, endCharacter ?? editor.document.lineAt(endLine).text.length)
  }
  return editor
}

/** Revert every document a step left with unsaved changes, each in front in turn (revert acts on the active editor). */
async function revertDirty(): Promise<void> {
  for (const document of vscode.workspace.textDocuments.filter((candidate) => candidate.isDirty && candidate.uri.scheme === "file")) {
    await vscode.window.showTextDocument(document, { preview: false })
    await vscode.commands.executeCommand("workbench.action.files.revert")
  }
}

/** The sample's 1-based lines `from`..`to`, as the extension quotes them. */
function sampleLines(document: vscode.TextDocument, from: number, to: number): string {
  return document.getText(new vscode.Range(from - 1, 0, to - 1, document.lineAt(to - 1).text.length))
}

/**
 * The window as an agent will read it: the sample in front with lines 2-4 selected, another file open in
 * a tab, and a problem on line 4 published through a real diagnostic collection (the API a language server
 * uses), so `languages.onDidChangeDiagnostics` really fires. Returns the collection, to dispose.
 */
async function agentScene(): Promise<{ editor: vscode.TextEditor; other: string; problems: vscode.DiagnosticCollection }> {
  await vscode.commands.executeCommand("workbench.action.closeAllEditors")
  const other = workspaceFile("other.ts")
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(other), { preview: false })
  const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(sample), { preview: false })
  editor.selection = new vscode.Selection(1, 0, 3, editor.document.lineAt(3).text.length)
  const problems = vscode.languages.createDiagnosticCollection("ntwine-e2e")
  const problem = new vscode.Diagnostic(new vscode.Range(3, 4, 3, 9), "Cannot find name 'totals'.", vscode.DiagnosticSeverity.Error)
  problem.source = "e2e"
  problem.code = 2304
  problems.set(editor.document.uri, [problem])
  problems.set(vscode.Uri.file(other), [new vscode.Diagnostic(new vscode.Range(0, 0, 0, 6), "Unused export.", vscode.DiagnosticSeverity.Warning)])
  return { editor, other, problems }
}

/** Every `editor` frame the fake received, newest last. */
const editorFrames = async () => (await fakeLog()).frames.filter((frame): frame is EditorSnapshot => frame.t === "editor")

/** One `tools/call editor` on the REAL ntwine-mcp.mjs, run as a worker of `projectId` would run it, finding the stack by its lock. */
const workerReadsEditor = (projectId: string) =>
  workerTool({ node: process.env.NTWINE_E2E_NODE!, mcp: process.env.NTWINE_E2E_MCP!, serverLock: process.env.NTWINE_E2E_SERVER_LOCK!, projectId })

// ── Review changes ────────────────────────────────────────────────────────────────────────────────────

/** The worktree the fake-mode review steps show, built once (e2e/review-repo.ts) inside the workspace. */
let fakeReviewRepo: ReviewRepo | undefined
const reviewRepo = () => (fakeReviewRepo ??= seedReviewRepo(join(workspace, "review-repo")))

/**
 * The review in front is the repository's whole branch — every file in git's order, each side what it must
 * be — read three ways: the tab VS Code shows (its label, and its diffs where the API exposes a multi-diff
 * tab's input), what the extension handed `vscode.changes`, and each side's text as the editor loads it
 * (the base side through the extension's `ntwine-base:` provider, the file side from disk).
 */
async function assertReviewInFront(api: NtwineExtensionApi, repo: ReviewRepo, title: string): Promise<void> {
  const label = `Changes in ${title}`
  const tabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs.map((tab) => `${group.isActive ? "*" : ""}${tab.isActive ? ">" : ""}${tab.label} [${(tab.input as object | undefined)?.constructor?.name ?? typeof tab.input}]`))
  // VS Code names the tab by the title, and later versions add the count: "Changes in x (5 files)".
  const named = (tab: string | undefined) => tab === label || tab === `${label} (${repo.expected.length} files)`
  await until(`"${label}" in front`, () => named(vscode.window.tabGroups.activeTabGroup.activeTab?.label), 20_000).catch((error: unknown) => {
    throw new Error(`${(error as Error).message}; the tabs: ${JSON.stringify(tabs())}`)
  })
  const shown = api.review()
  assert.ok(shown, "the extension handed the diff editor a review")
  const review: ReviewSnapshot = shown
  assert.equal(review.title, label)
  const relative = (uri: string) => vscode.Uri.parse(uri).fsPath.slice(repo.worktree.length + 1)
  assert.deepEqual(review.resources.map((resource) => relative(resource.label)), repo.expected.map((entry) => entry.path), "every change, in git's order; nothing ignored, binary or main's")
  for (const [i, entry] of repo.expected.entries()) {
    const resource = review.resources[i]!
    const text = repo.text[entry.path]!
    if (entry.status === "deleted") assert.equal(resource.modified, undefined, `${entry.path} has no file side`)
    else {
      const file = vscode.Uri.parse(resource.modified!)
      assert.equal(file.scheme, "file", `${entry.path}'s right side is the real file, to edit in place`)
      assert.equal((await vscode.workspace.openTextDocument(file)).getText(), text.now, `${entry.path} as it is on disk`)
    }
    if (entry.basePath === undefined) assert.equal(resource.original, undefined, `${entry.path} is new: no base side`)
    else {
      const base = vscode.Uri.parse(resource.original!)
      assert.equal(base.scheme, "ntwine-base")
      assert.equal(base.fsPath, join(repo.worktree, ...entry.basePath.split("/")), `${entry.path}'s base side is named for where it was`)
      assert.equal((await vscode.workspace.openTextDocument(base)).getText(), text.base, `${entry.path} as the base had it`)
    }
  }
  assert.deepEqual(review.checkouts.map(({ top, base }) => ({ top, base })), [{ top: repo.worktree, base: repo.base }], "the base is where the branch started, not main's tip")
  assert.deepEqual(review.checkouts[0]!.binary, [join(repo.worktree, "logo.png")])
  // The tab itself, where this VS Code exposes a multi-diff tab's input to extensions.
  const Multi = (vscode as unknown as { TabInputTextMultiDiff?: new (...args: never[]) => { textDiffs: { original: vscode.Uri; modified: vscode.Uri }[] } }).TabInputTextMultiDiff
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input
  if (Multi && input instanceof Multi) {
    // The API lists only the entries with BOTH sides (a TabInputTextDiff needs two): here the modified
    // and the renamed file. The added and deleted ones are in the editor all the same — its label counts
    // them, and the drawn entries below show them.
    const twoSided = repo.expected.filter((entry) => entry.basePath !== undefined && entry.status !== "deleted")
    console.log(`  · the tab's own input lists the ${input.textDiffs.length} two-sided diffs: ${input.textDiffs.map((diff) => `${diff.original.scheme}→${diff.modified.scheme}`).join(", ")}`)
    assert.deepEqual(
      input.textDiffs.map((diff) => [diff.original.scheme, diff.modified.fsPath.slice(repo.worktree.length + 1)]),
      twoSided.map((entry) => ["ntwine-base", entry.path]),
    )
  } else console.log(`  · this VS Code (${vscode.version}) does not expose a multi-diff tab's input; its label and the documents stand in`)
}

/**
 * What the multi-diff editor DRAWS (fake mode, over the workbench's debugging port): an entry per file, and
 * for the loop, the removed line on the base side and the added one on the file side.
 */
async function assertReviewDrawn(repo: ReviewRepo, shot: string): Promise<void> {
  type Entry = { header: string; original: string; modified: string }
  let entries: Entry[] = []
  await until("the loop's diff drawn on both sides", async () => {
    entries = await workbench<Entry[]>(`[...document.querySelectorAll(".multiDiffEntry")].map((entry) => ({
      header: (entry.querySelector(".header")?.textContent ?? "").replace(/\\s+/g, " ").trim(),
      // Every block of lines on each side: a narrow diff draws the REMOVED lines inside the file side, in a
      // zone of their own before its real lines, so the first block alone is not the file.
      original: [...entry.querySelectorAll(".editor.original .view-lines")].map((lines) => lines.textContent ?? "").join("\\n").replace(/\\u00a0/g, " "),
      modified: [...entry.querySelectorAll(".editor.modified .view-lines")].map((lines) => lines.textContent ?? "").join("\\n").replace(/\\u00a0/g, " "),
    }))`)
    const loop = entries.find((entry) => entry.header.includes("loop.ts"))
    return !!loop && loop.original.includes("let total = 0") && loop.modified.includes("xs.reduce")
  }, 20_000).catch((error: unknown) => {
    throw new Error(`${(error as Error).message}; the editor drew ${JSON.stringify(entries)}`)
  })
  for (const { path } of repo.expected.slice(0, 3)) assert.ok(entries.some((entry) => entry.header.includes(path.split("/").pop()!)), `an entry for ${path}: ${JSON.stringify(entries.map((entry) => entry.header))}`)
  await fake("/__e2e/shot", { path: shot })
  console.log(`  · ${entries.length} entries drawn; the window is in ${shot}`)
}

const reviewShot = (name: string) => join(process.env.NTWINE_E2E_SHOTS || workspace, `${vscode.version}-${name}.png`)

/** The thread the real-mode Ask step started, for Send to follow up when no NTWINE_E2E_THREAD is named. */
let askedThread: string | undefined

interface Step {
  name: string
  modes: ("fake" | "real")[]
  run: (context: { api: NtwineExtensionApi; project: EditorProject; rpc: NtwineRpc }) => Promise<void>
}

const steps: Step[] = [
  {
    name: "the window says hello with its workspace folder, over the origin-gated socket",
    modes: ["fake", "real"],
    async run({ api, project, rpc }) {
      if (mode === "fake") {
        const log = await fakeLog()
        const hello = log.frames.find((frame) => frame.t === "hello")
        assert.ok(hello && hello.t === "hello")
        assert.deepEqual(hello.folders.map((folder) => realpathSync(folder)), [workspace])
        assert.equal(hello.app, vscode.env.appName)
        assert.equal(hello.v, 1)
        assert.equal(hello.acceptsOpens, true)
        assert.equal(hello.platform, process.platform)
        assert.equal(hello.windowId, api.windowId)
        assert.ok(log.origins.length > 0 && log.origins.every((origin) => origin === control))
        assert.deepEqual(log.refused, [], "every frame is one the server's own schema takes")
        assert.deepEqual(api.discovered(), { origin: control, port: Number(new URL(control).port), source: "setting" }, "the page opener knows where the address came from")
      } else {
        const { windows } = await rpc.query(project.id, "editorWindows")
        assert.ok(windows.some((window) => window.app === vscode.env.appName && window.acceptsOpens), JSON.stringify(windows))
      }
    },
  },
  {
    name: "a file link from ntwine opens at its line and column, and a range selects its whole lines",
    modes: ["fake", "real"],
    async run({ project, rpc }) {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors")
      if (mode === "fake") {
        const result = await fake<{ ok: boolean; error?: string }>("/__e2e/open", { path: sample, line: 5, column: 3 })
        assert.deepEqual({ ok: result.ok, error: result.error }, { ok: true, error: undefined })
      } else {
        const opened = await rpc.mutation(project.id, "openLocalFile", { path: sample, line: 5, column: 3 })
        assert.equal(opened.action, "opened")
      }
      await until("the sample in front", () => vscode.window.activeTextEditor?.document.uri.fsPath === sample)
      const editor = vscode.window.activeTextEditor!
      await until("the cursor at 5:3", () => editor.selection.isEmpty && editor.selection.active.line === 4 && editor.selection.active.character === 2)

      if (mode === "fake") {
        const range = await fake<{ ok: boolean }>("/__e2e/open", { path: sample, line: 2, endLine: 4 })
        assert.equal(range.ok, true)
      } else {
        await rpc.mutation(project.id, "openLocalFile", { path: sample, line: 2, endLine: 4 })
      }
      await until("lines 2-4 selected", () => {
        const s = vscode.window.activeTextEditor?.selection
        return !!s && s.start.line === 1 && s.start.character === 0 && s.end.line === 3 && s.end.character === editor.document.lineAt(3).text.length
      })

      if (mode === "fake") {
        const missing = await fake<{ ok: boolean; error?: string }>("/__e2e/open", { path: join(workspace, "nope.ts"), line: 1 })
        assert.equal(missing.ok, false)
        assert.match(missing.error ?? "", /doesn't exist/)
      }
    },
  },
  {
    name: "a focus request says whether the window came to the front; an open on a folder answers ok either way",
    modes: ["fake"],
    async run() {
      // `workbench.action.focusWindow` arrived in VS Code 1.128: on the oldest VS Code the manifest
      // admits (NTWINE_E2E_VSCODE=oldest), and in Cursor and Windsurf, raising the window throws. A focus
      // request is only the raise, so there it answers that it could not, and ntwine falls back to the
      // editor's command line; an open has already happened by then, so it is ok on every version.
      const canRaise = (await vscode.commands.getCommands(true)).includes("workbench.action.focusWindow")
      const focused = await fake<{ ok: boolean; error?: string }>("/__e2e/focus", { path: workspace })
      if (canRaise) assert.deepEqual({ ok: focused.ok, error: focused.error }, { ok: true, error: undefined })
      else {
        assert.equal(focused.ok, false)
        assert.match(focused.error ?? "", /can't bring its window to the front/)
      }
      const folder = await fake<{ ok: boolean; error?: string }>("/__e2e/open", { path: join(workspace, "src") })
      assert.deepEqual({ ok: folder.ok, error: folder.error }, { ok: true, error: undefined })
    },
  },
  {
    name: "the status bar shows this workspace's Ready count, and only when there is one",
    modes: ["fake", "real"],
    async run({ api, project }) {
      if (mode === "real") {
        assert.match(api.statusBar().text, /^ntwine/)
        return
      }
      await fake("/__e2e/projects", { projects: [{ ...project, ready: 3, working: 1 }] })
      await until("ntwine · 3 ready", () => api.statusBar().text === "ntwine · 3 ready")
      assert.match(api.statusBar().tooltip, /3 ready · 1 working/)
      assert.equal(api.statusBar().command, "ntwine.sidebar.focus", "a click shows the sidebar")
      await fake("/__e2e/projects", { projects: [{ ...project, ready: 0, working: 1 }] })
      await until("a bare ntwine", () => api.statusBar().text === "ntwine")
    },
  },
  {
    name: "ntwine's agents can read the editor: the file in front, the selection and its text, the tabs, the problems — nothing with sharing off",
    modes: ["fake"],
    async run() {
      const { editor, other, problems } = await agentScene()
      const ntwine = vscode.workspace.getConfiguration("ntwine")
      try {
        const expectedText = sampleLines(editor.document, 2, 4)
        let frame: EditorSnapshot | undefined
        await until("the selection and the problem in an editor frame", async () => {
          frame = (await editorFrames()).at(-1)
          return frame?.active?.selection?.text === expectedText && frame.diagnostics.some((d) => d.source === "e2e")
        })
        assert.equal(frame!.shared, true)
        const active = frame!.active!
        assert.deepEqual({ path: active.path, languageId: active.languageId, dirty: active.dirty, lineCount: active.lineCount, selection: active.selection, untitled: active.untitled }, {
          path: sample, languageId: "typescript", dirty: false, lineCount: editor.document.lineCount, selection: { startLine: 2, endLine: 4, text: expectedText }, untitled: undefined,
        })
        assert.equal(active.cursorLine, 4)
        assert.ok(active.visible.startLine <= 2 && active.visible.endLine >= 4, JSON.stringify(active.visible))
        assert.deepEqual(frame!.open.map((file) => file.path), [other], "the other tab, once, never the file in front")
        // Errors before warnings, the file in front first: ours leads, the other file's warning follows.
        const ours = frame!.diagnostics.filter((d) => d.source === "e2e" || d.message === "Unused export.")
        assert.deepEqual(ours, [
          { path: sample, line: 4, severity: "error", message: "Cannot find name 'totals'.", source: "e2e", code: "2304" },
          { path: other, line: 1, severity: "warning", message: "Unused export." },
        ])
        assert.ok(frame!.problems.errors >= 1 && frame!.problems.warnings >= 1)

        // A keystroke: the frame follows the text and the dirty flag.
        await editor.edit((edit) => edit.insert(new vscode.Position(1, 0), "  // edited\n"))
        await until("a dirty frame with the edited selection", async () => (await editorFrames()).at(-1)?.active?.dirty === true)

        // Sharing off: one frame that says so and carries nothing; back on, the picture again.
        await ntwine.update("shareEditorState", false, vscode.ConfigurationTarget.Global)
        await until("sharing off", async () => (await editorFrames()).at(-1)?.shared === false)
        assert.deepEqual((await editorFrames()).at(-1), { t: "editor", shared: false, active: null, open: [], diagnostics: [], problems: { errors: 0, warnings: 0 } })
        await ntwine.update("shareEditorState", undefined, vscode.ConfigurationTarget.Global)
        await until("sharing back on", async () => (await editorFrames()).at(-1)?.shared === true)

        // A file whose name says it holds secrets: its lines go to the agents, its text never. (The page's
        // half is the sidebar's context step below: no page is framed yet.)
        const secret = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(envFile()), { preview: false })
        secret.selection = new vscode.Selection(0, 0, 0, 24)
        await until("the .env selection, withheld", async () => (await editorFrames()).at(-1)?.active?.selection?.withheld === true)
        assert.deepEqual((await editorFrames()).at(-1)!.active!.selection, { startLine: 1, endLine: 1, withheld: true })
        assert.ok(!JSON.stringify(await fakeLog()).includes(SECRET), "the key never reached the agents' frames")
        assert.deepEqual((await fakeLog()).refused, [], "every editor frame is one the server's own schema takes")
      } finally {
        problems.dispose()
        await ntwine.update("shareEditorState", undefined, vscode.ConfigurationTarget.Global)
        // Revert the SAMPLE, which the keystroke above made dirty — not whatever is in front (the .env by
        // now). Reverting the active editor left the sample's "// edited" line in the buffer, and VS Code
        // 1.90 keeps a dirty buffer through closeAllEditors in a test window (1.140 discards it), so on the
        // floor every later step read the edited sample: the next step's lines 2-3 were the wrong lines.
        await revertDirty()
        await vscode.commands.executeCommand("workbench.action.closeAllEditors")
      }
    },
  },
  {
    name: "a worker's `editor` tool reads this window's selection and its problem through the real server",
    modes: ["real"],
    async run({ project }) {
      if (!process.env.NTWINE_E2E_MCP || !process.env.NTWINE_E2E_SERVER_LOCK || !process.env.NTWINE_E2E_NODE) return skip("needs the stack's lock; run with --stack")
      const { editor, other, problems } = await agentScene()
      try {
        const expectedText = sampleLines(editor.document, 2, 4)
        let text = ""
        await until("the worker reading the selection", async () => (text = await workerReadsEditor(project.id)).includes(expectedText), 20_000)
        console.log(`    the worker read:\n${text.replace(/^/gmu, "      ")}`)
        assert.ok(text.includes(`In front: ${sample} (typescript), lines 2-4 selected.`), text)
        assert.ok(text.includes(`\`\`\`typescript\n${expectedText}\n\`\`\``), "the selected text, verbatim, fenced")
        assert.ok(text.includes(`${sample}\n  4: error: Cannot find name 'totals'. [e2e 2304]`), "the problem")
        assert.ok(text.includes(`- ${other}`), "the other tab")
        assert.match(text, /^Visual Studio Code \(/u)
      } finally {
        problems.dispose()
        await vscode.commands.executeCommand("workbench.action.closeAllEditors")
      }
    },
  },
  {
    name: "Ask ntwine dispatches the selection as the page's chip, with the saved backend, model and effort",
    modes: ["fake", "real"],
    async run({ project, rpc }) {
      if (mode === "real" && process.env.NTWINE_E2E_DISPATCH !== "1") return skip("starts a real agent; set NTWINE_E2E_DISPATCH=1")
      const editor = await openSample([1, 0, 3])
      const asked = await vscode.commands.executeCommand<{ slug: string } | undefined>("ntwine.ask", { question: "why does this loop?" })
      assert.ok(asked?.slug, "the command returns the new thread")
      askedThread = asked.slug
      const expected = sampleLines(editor.document, 2, 4)
      let prompt: string
      if (mode === "fake") {
        assert.equal(asked.slug, "asked-thread")
        const log = await fakeLog()
        const dispatch = log.rpc.find((call) => call.procedure === "dispatch")
        assert.ok(dispatch)
        assert.equal(dispatch.projectId, project.id)
        assert.deepEqual({ backend: dispatch.input.backend, model: dispatch.input.model, effort: dispatch.input.effort }, { backend: "claude", model: "sonnet", effort: "low" })
        assert.ok(log.rpc.findIndex((call) => call.procedure === "dispatchPreferencesGet") < log.rpc.indexOf(dispatch))
        prompt = String(dispatch.input.prompt)
      } else {
        // The prompt's format is pinned in FAKE mode and by message.test.ts; here, that the thread exists.
        const board = await rpc.query(project.id, "board")
        assert.ok(board.threads.some((t) => t.id === asked.slug), `thread ${asked.slug} on the board`)
        return
      }
      const parsed = parseSentContext(prompt)
      assert.ok(parsed, `the page parses it as a chip: ${prompt}`)
      assert.equal(parsed.body, "@sample.ts:2-4 why does this loop?")
      assert.deepEqual(parsed.items, [{ token: "@sample.ts:2-4", display: "src/sample.ts", startLine: 2, endLine: 4, text: expected }])
    },
  },
  {
    name: "Send to ntwine thread follows up the named thread, once, with an idempotent delivery id",
    modes: ["fake", "real"],
    async run({ project }) {
      const realThread = process.env.NTWINE_E2E_THREAD || askedThread
      if (mode === "real" && (process.env.NTWINE_E2E_DISPATCH !== "1" || !realThread)) return skip("delivers to a real agent; set NTWINE_E2E_DISPATCH=1")
      const thread = mode === "fake" ? "@fake-thread" : realThread!
      const editor = await openSample([2, 0, 2])
      const sent = await vscode.commands.executeCommand<{ slug: string; deliveryId: string } | undefined>("ntwine.sendToThread", { thread, message: "look here" })
      assert.ok(sent, "the command returns the delivery")
      assert.match(sent.deliveryId, /^[0-9a-f-]{36}$/)
      if (mode === "real") return
      const followUps = (await fakeLog()).rpc.filter((call) => call.procedure === "followUp")
      assert.equal(followUps.length, 1)
      const input = followUps[0]!.input
      assert.equal(followUps[0]!.projectId, project.id)
      assert.deepEqual({ slug: input.slug, sessionId: input.sessionId, deliveryId: input.deliveryId }, { slug: "fake-thread", sessionId: "fake-session", deliveryId: sent.deliveryId })
      const parsed = parseSentContext(String(input.message))
      assert.ok(parsed)
      assert.equal(parsed.body, "@sample.ts:3 look here")
      assert.equal(parsed.items[0]?.text, sampleLines(editor.document, 3, 3))
    },
  },
  {
    name: "Send to ntwine thread refuses a selection in an untitled buffer rather than sending the message without it",
    modes: ["fake"],
    async run() {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors")
      const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: "a pasted log\nERROR the part that matters\n" }))
      editor.selection = new vscode.Selection(1, 0, 1, 26)
      const before = (await fakeLog()).rpc.length
      const sent = await vscode.commands.executeCommand<unknown>("ntwine.sendToThread", { thread: "@fake-thread", message: "why?" })
      assert.equal(sent, undefined, "nothing was sent")
      assert.deepEqual((await fakeLog()).rpc.slice(before).map((call) => call.procedure), [], "not even the thread list was asked for")
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor")
    },
  },
  {
    name: "with the sidebar off, Add to ntwine prompt hands the selection to ntwine for the page's prompt box",
    modes: ["fake", "real"],
    async run({ project, rpc }) {
      const editor = await openSample([1, 0, 2])
      // With the sidebar on, Add opens it (the sidebar steps below); off, it is the browser's path.
      const ntwine = vscode.workspace.getConfiguration("ntwine")
      await ntwine.update("useSidebar", false, vscode.ConfigurationTarget.Global)
      let composed: EditorComposed | undefined
      try {
        composed = await vscode.commands.executeCommand<EditorComposed | undefined>("ntwine.addToPrompt")
      } finally {
        await ntwine.update("useSidebar", undefined, vscode.ConfigurationTarget.Global)
      }
      assert.equal(composed?.ok, true, JSON.stringify(composed))
      const expected = { projectId: project.id, path: sample, text: sampleLines(editor.document, 2, 3), startLine: 2, endLine: 3 }
      if (mode === "fake") {
        const compose = (await fakeLog()).frames.find((frame) => frame.t === "compose")
        assert.ok(compose && compose.t === "compose")
        assert.equal(compose.id, composed!.id)
        assert.deepEqual(compose.item, expected)
      } else if (process.env.NTWINE_E2E_PAGE_CLAIMS === "1") {
        // A real page is open on this ntwine and claims it itself; the harness beside it asserts the chip.
        return
      } else {
        const { item } = await rpc.mutation(project.id, "composeTake", {})
        assert.ok(item, "the server holds it for a page to claim")
        assert.deepEqual({ projectId: item.projectId, path: item.path, text: item.text, startLine: item.startLine, endLine: item.endLine }, expected)
      }
    },
  },
  {
    name: "turning off Open file links tells ntwine at once",
    modes: ["fake", "real"],
    async run({ project, rpc }) {
      const config = vscode.workspace.getConfiguration("ntwine")
      await config.update("openFileLinks", false, vscode.ConfigurationTarget.Global)
      try {
        if (mode === "fake") {
          await until("a state frame with acceptsOpens false", async () => (await fakeLog()).frames.some((frame) => frame.t === "state" && !frame.acceptsOpens))
        } else {
          await until("the window listed as not taking opens", async () => (await rpc.query(project.id, "editorWindows")).windows.some((w) => w.app === vscode.env.appName && !w.acceptsOpens))
        }
      } finally {
        await config.update("openFileLinks", undefined, vscode.ConfigurationTarget.Global)
      }
    },
  },
  {
    name: "a dropped connection comes back on its own and says hello again",
    modes: ["fake"],
    async run({ api }) {
      const before = (await fakeLog()).frames.filter((frame) => frame.t === "hello").length
      await fake("/__e2e/drop", {})
      await until("a second hello", async () => (await fakeLog()).frames.filter((frame) => frame.t === "hello").length > before, 15_000)
      await until("connected again", () => api.status().kind === "connected")
    },
  },

  // ── the sidebar ────────────────────────────────────────────────────────────────────────────────────
  // Every step above ran with the sidebar never opened: Add to ntwine prompt with the setting off, and Ask
  // and Send passing their text, which is sent directly whatever the sidebar does.
  {
    name: "Add to ntwine prompt opens the sidebar in a window that never had it, framing ntwine's page with the embed params, and lands there with the caret",
    modes: ["fake"],
    async run({ api, project }) {
      assert.equal(api.sidebar().opened, false, "nothing has opened it yet")
      const editor = await openSample([1, 0, 1])
      const composed = await landsInSidebar(vscode.commands.executeCommand<EditorComposed | undefined>("ntwine.addToPrompt"), "Add")
      assert.equal(composed?.ok, true, JSON.stringify(composed))
      assert.equal(api.sidebar().opened, true)
      assert.equal(api.sidebar().ready, true)
      assert.deepEqual(await pageReceived("ntwine:compose"), [{
        type: "ntwine:compose",
        id: composed!.id,
        item: { projectId: project.id, path: sample, text: sampleLines(editor.document, 2, 2), startLine: 2, endLine: 2, app: vscode.env.appName },
        target: "front",
        focus: true,
      }])
      const query = embedQuery(project)
      assert.equal(api.sidebar().url, `${control}/${query}`)
      const log = await fakeLog()
      assert.deepEqual(log.page.loads, [`/${query}`], "ntwine served the page once, with those params")
      // Whatever the page reads from its URL, the theme follows once it is ready.
      await until("the theme posted", async () => (await pageReceived("ntwine:theme")).length > 0)
      assert.ok(log.page.received.every((entry) => entry.origin.startsWith("vscode-webview://")), "everything reached the page from the sidebar's own document")
    },
  },
  {
    name: "the sidebar's badge is the workspace's Ready count",
    modes: ["fake"],
    async run({ api, project }) {
      await fake("/__e2e/projects", { projects: [{ ...project, ready: 2, working: 0 }] })
      await until("a badge of 2", () => api.sidebar().badge === 2)
      await fake("/__e2e/projects", { projects: [{ ...project, ready: 0, working: 0 }] })
      await until("no badge", () => api.sidebar().badge === undefined)
    },
  },
  {
    name: "Add to ntwine prompt puts the selection into the prompt box the sidebar shows, with the caret, not through ntwine",
    modes: ["fake"],
    async run({ api, project }) {
      const editor = await openSample([1, 0, 2])
      const before = await fakeLog()
      const composed = await vscode.commands.executeCommand<EditorComposed | undefined>("ntwine.addToPrompt")
      assert.equal(composed?.ok, true, JSON.stringify(composed))
      const composes = await pageReceived("ntwine:compose", before.page.received.length)
      assert.deepEqual(composes, [{
        type: "ntwine:compose",
        id: composed!.id,
        // The very item the server path carries (the step above), so the page writes the same chip.
        item: { projectId: project.id, path: sample, text: sampleLines(editor.document, 2, 3), startLine: 2, endLine: 3, app: vscode.env.appName },
        target: "front",
        // The caret goes after the chip, as Cursor's Cmd+L and ntwine's own ⌘I put it.
        focus: true,
      }])
      assert.equal((await fakeLog()).frames.filter((frame) => frame.t === "compose").length, before.frames.filter((frame) => frame.t === "compose").length, "nothing went to ntwine to hold")
      assert.equal(api.sidebar().visible, true)
      // Focus is in the sidebar now; the editor in front is still the one the selection came from.
      assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, sample)
    },
  },
  {
    name: "Ask ntwine… opens the sidebar's new-thread box with the selection, and starts nothing itself",
    modes: ["fake"],
    async run({ project }) {
      const editor = await openSample([1, 0, 3])
      const before = await fakeLog()
      const asked = await landsInSidebar(vscode.commands.executeCommand<{ composed?: EditorComposed } | undefined>("ntwine.ask"), "Ask")
      assert.equal(asked?.composed?.ok, true, JSON.stringify(asked))
      assert.deepEqual(await pageReceived("ntwine:compose", before.page.received.length), [{
        type: "ntwine:compose",
        id: asked!.composed!.id,
        item: { projectId: project.id, path: sample, text: sampleLines(editor.document, 2, 4), startLine: 2, endLine: 4, app: vscode.env.appName },
        target: "new",
        focus: true,
      }])
      assert.deepEqual((await fakeLog()).rpc.slice(before.rpc.length).map((call) => call.procedure), [], "no dispatch: the human writes the question in the sidebar")
    },
  },
  {
    name: "Send to ntwine thread… opens the picked thread in the sidebar with the selection in its reply box",
    modes: ["fake"],
    async run({ project }) {
      const editor = await openSample([2, 0, 2])
      const before = await fakeLog()
      const sent = await landsInSidebar(vscode.commands.executeCommand<{ slug: string; composed?: EditorComposed } | undefined>("ntwine.sendToThread", { thread: "@fake-thread" }), "Send")
      assert.equal(sent?.composed?.ok, true, JSON.stringify(sent))
      assert.deepEqual(await pageReceived("ntwine:compose", before.page.received.length), [{
        type: "ntwine:compose",
        id: sent!.composed!.id,
        item: { projectId: project.id, path: sample, text: sampleLines(editor.document, 3, 3), startLine: 3, endLine: 3, app: vscode.env.appName },
        target: { thread: "fake-thread", project: project.slug },
        focus: true,
      }])
      assert.deepEqual((await fakeLog()).rpc.slice(before.rpc.length).map((call) => call.procedure), ["board"], "the picker's thread list, and no follow-up")
    },
  },
  {
    name: "a file the page links opens here at its position; a missing one is said, not opened",
    modes: ["fake"],
    async run({ api }) {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors")
      await pagePosts({ type: "ntwine:open-file", path: sample, line: 6, column: 3 })
      await until("the sample in front", () => vscode.window.activeTextEditor?.document.uri.fsPath === sample)
      const editor = vscode.window.activeTextEditor!
      await until("the cursor at 6:3", () => editor.selection.isEmpty && editor.selection.active.line === 5 && editor.selection.active.character === 2)
      await pagePosts({ type: "ntwine:open-file", path: join(workspace, "nope.ts"), line: 1 })
      await until("the missing file reported", () => api.sidebar().events.some((event) => event.type === "ntwine:open-file" && event.outcome === "missing"))
      assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, sample, "nothing else opened")
    },
  },
  {
    name: "a chord the page forwards runs its VS Code command; Ctrl+L there goes back to the editor",
    modes: ["fake"],
    async run({ api }) {
      assert.equal(api.sidebar().visible, true)
      const mac = process.platform === "darwin"
      // The keys' own records, read by type: an earlier step's open can record its outcome after these.
      const keys = () => api.sidebar().events.filter((event) => event.type === "ntwine:key").map((event) => event.outcome)
      let from = keys().length
      // Ctrl+Shift+E (⌘⇧E): the Explorer takes the side bar, so the ntwine view is no longer visible.
      await pagePosts({ type: "ntwine:key", key: "E", code: "KeyE", ctrl: !mac, meta: mac, shift: true, alt: false })
      await until("the explorer shown", () => !api.sidebar().visible)
      assert.deepEqual(keys().slice(from), ["workbench.view.explorer"])
      await vscode.commands.executeCommand("ntwine.sidebar.focus")
      await until("the sidebar back", () => api.sidebar().visible)

      // Ctrl+L (⌘L) in the page goes back to the editor — the other half of Ctrl+L with nothing selected.
      await until("the sidebar focused", async () => (await focusIn()) === "sidebar")
      from = keys().length
      await pagePosts({ type: "ntwine:key", key: "l", code: "KeyL", ctrl: !mac, meta: mac, shift: false, alt: false })
      await until("the editor focused", async () => (await focusIn()) === "editor")
      assert.deepEqual(keys().slice(from), ["workbench.action.focusActiveEditorGroup"])
      assert.equal(api.sidebar().visible, true, "the sidebar stays in sight")
    },
  },
  {
    name: "a message the sidebar does not know, a chord off its list, a link that is not a web page: nothing happens",
    modes: ["fake"],
    async run({ api }) {
      await openSample()
      const from = api.sidebar().events.length
      const mac = process.platform === "darwin"
      await pagePosts({ type: "ntwine:bogus", path: sample })
      // Ctrl+W would close the editor were it run.
      await pagePosts({ type: "ntwine:key", key: "w", code: "KeyW", ctrl: !mac, meta: mac, shift: false, alt: false })
      await pagePosts({ type: "ntwine:open-external", url: "javascript:alert(1)" })
      await until("three messages handled", () => api.sidebar().events.length >= from + 3)
      assert.deepEqual(api.sidebar().events.slice(from), [
        { type: "ntwine:bogus", outcome: "ignored" },
        { type: "ntwine:key", outcome: "ignored" },
        { type: "ntwine:open-external", outcome: "ignored" },
      ])
      assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, sample, "the editor is still open")
      assert.equal(api.sidebar().visible, true)
    },
  },
  {
    name: "a theme change reaches the page",
    modes: ["fake"],
    async run() {
      const workbench = vscode.workspace.getConfiguration("workbench")
      const from = (await fakeLog()).page.received.length
      const light = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light
      await workbench.update("colorTheme", light ? "Default Dark Modern" : "Default Light Modern", vscode.ConfigurationTarget.Global)
      try {
        const want = light ? "dark" : "light"
        await until(`ntwine:theme ${want}`, async () => (await pageReceived("ntwine:theme", from)).some((data) => data.theme === want))
      } finally {
        await workbench.update("colorTheme", undefined, vscode.ConfigurationTarget.Global)
      }
    },
  },
  // ── the editor in the sidebar ───────────────────────────────────────────────────────────────────────
  {
    name: "the page is told the editor's context: the file in front, its selection's lines, characters and text (or the caret's line), unsaved or untitled, the other open files most recent first",
    modes: ["fake"],
    async run({ api, project }) {
      const a = workspaceFile("a.ts")
      const b = workspaceFile("b.ts")
      await vscode.commands.executeCommand("workbench.action.closeAllEditors")
      // Not previews: each would take the last one's tab, and only one file would be open.
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(a), { preview: false })
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(b), { preview: false })
      const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(sample), { preview: false })
      // Lines 2-3 dragged whole: the caret ends at column 1 of line 4, which is not in the selection.
      editor.selection = new vscode.Selection(1, 0, 3, 0)
      const document = editor.document
      const chars = document.offsetAt(new vscode.Position(3, 0)) - document.offsetAt(new vscode.Position(1, 0))
      const file = (path: string, label: string) => ({ path, label, projectId: project.id })
      // The text a send from the sidebar would quote: lines 2-3 as the editor has them, with their newline.
      const text = document.getText(new vscode.Range(1, 0, 3, 0)).replace(/\r\n?/gu, "\n")
      assert.ok(text.includes("let total = 0") && text.includes("for (const x of xs)"), text)
      const want = { type: "ntwine:editor-context", active: { ...file(sample, "src/sample.ts"), selection: { startLine: 2, endLine: 3, chars, text } }, open: [file(b, "src/b.ts"), file(a, "src/a.ts")] }
      await until("lines 2-3 of the sample in front, with b.ts and a.ts open", async () => isDeepStrictEqual((await contexts()).at(-1), want)).catch(async (error: unknown) => {
        assert.deepEqual((await contexts()).at(-1), want)
        throw error
      })
      assert.deepEqual(api.editorContext(), want)

      // Multi-cursor: the primary selection's lines and text, every selection's characters.
      editor.selections = [new vscode.Selection(4, 2, 4, 7), new vscode.Selection(0, 0, 0, 6)]
      await until("line 5, 11 characters", async () => isDeepStrictEqual((await contexts()).at(-1)?.active?.selection, { startLine: 5, endLine: 5, chars: 11, text: "} // " }))

      // A caret: no selection, and the caret's line instead — then a line further down is a new message.
      editor.selection = new vscode.Selection(5, 3, 5, 3)
      await until("the caret on line 6", async () => {
        const last = (await contexts()).at(-1)?.active
        return last?.cursorLine === 6 && last.selection === undefined
      })
      editor.selection = new vscode.Selection(2, 0, 2, 0)
      await until("the caret on line 3", async () => (await contexts()).at(-1)?.active?.cursorLine === 3)

      // a.ts in a second group too: still listed once, and first, being the most recent.
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(a), { viewColumn: vscode.ViewColumn.Two, preview: false })
      await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false })
      await until("a.ts once, most recent first", async () => {
        const last = (await contexts()).at(-1)
        return last?.active?.path === sample && isDeepStrictEqual(last.open.map((entry) => entry.path), [a, b])
      })

      // An edit the human has not saved: the page is told, so the block can say the disk copy differs.
      await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), "// unsaved\n"))
      await until("the sample, unsaved", async () => (await contexts()).at(-1)?.active?.dirty === true)
      await vscode.commands.executeCommand("workbench.action.files.revert")
      await until("the sample, saved again", async () => {
        const last = (await contexts()).at(-1)?.active
        return last?.path === sample && last.dirty === undefined
      })

      // Focus in the Output panel makes ITS editor VS Code's active text editor; the file the human was
      // pointing at, still on screen, stays in front — no message blanks the bar.
      const channel = vscode.window.createOutputChannel("ntwine e2e")
      try {
        channel.appendLine("[info] built")
        const settled = await received()
        channel.show(false)
        await until("the output pane in focus", () => vscode.window.activeTextEditor?.document.uri.scheme === "output")
        await sleep(500)
        assert.ok((await contexts(settled)).every((message) => message.active?.path === sample), "the sample stayed in front")
        assert.deepEqual(api.editorContext()?.active?.path, sample)
      } finally {
        channel.dispose()
        await vscode.commands.executeCommand("workbench.action.closePanel")
      }

      // A file whose name says it holds secrets: the page is told its lines, never its text.
      const secret = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(envFile()), { viewColumn: vscode.ViewColumn.One, preview: false })
      secret.selection = new vscode.Selection(0, 0, 0, 24)
      await until("the page told the .env selection withheld", async () => (await contexts()).at(-1)?.active?.withheld === true)
      assert.deepEqual((await contexts()).at(-1)!.active!.selection, { startLine: 1, endLine: 1, chars: 24 })
      assert.ok(!JSON.stringify(await contexts()).includes(SECRET), "the key never reached the page")
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor")

      // An untitled buffer is in front in its own right, named by its label, its caret's line told.
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: "a scratch buffer\n" }), vscode.ViewColumn.One)
      await until("an untitled buffer in front", async () => (await contexts()).at(-1)?.active?.untitled === true)
      const scratch = (await contexts()).at(-1)!.active!
      assert.match(scratch.path, /^Untitled-\d+$/u)
      // Opened with text, it is unsaved from the start.
      assert.deepEqual(scratch, { path: scratch.path, label: scratch.path, cursorLine: 1, untitled: true, dirty: true })
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor")
      await vscode.window.showTextDocument(document, vscode.ViewColumn.One)
      await until("the sample back", async () => (await contexts()).at(-1)?.active?.path === sample)
      // A diff: its working-tree side is the file in front (a git revision on the left never is).
      await vscode.commands.executeCommand("vscode.diff", vscode.Uri.file(a), vscode.Uri.file(b), "a.ts ↔ b.ts")
      await until("a diff's modified side in front", async () => (await contexts()).at(-1)?.active?.path === b)

      // The text the page is told is the SELECTION's, never a file's: no message carried line 1 or line 7,
      // which no selection above took in.
      const told = JSON.stringify(await contexts())
      assert.ok(!told.includes("export function sample") && !told.includes("return total"), "no unselected text reached the page")
      await vscode.commands.executeCommand("workbench.action.closeAllEditors")
    },
  },
  {
    name: "a drag is one message, not one per line, and a context that ends where it started is not sent again",
    modes: ["fake"],
    async run() {
      const editor = await openSample()
      editor.selection = new vscode.Selection(0, 0, 0, 0)
      await until("the sample with a caret", async () => {
        const last = (await contexts()).at(-1)
        return last?.active?.path === sample && !last.active.selection
      })
      const from = await received()
      for (let line = 1; line <= 6; line++) {
        editor.selection = new vscode.Selection(0, 0, line, 0)
        await sleep(15)
      }
      await sleep(500)
      const sent = await contexts(from)
      assert.ok(sent.length >= 1 && sent.length <= 2, `${sent.length} messages for a six-step drag`)
      assert.deepEqual(sent.at(-1)?.active?.selection?.endLine, 6)
      const settled = await received()
      editor.selection = new vscode.Selection(0, 0, 2, 0)
      editor.selection = new vscode.Selection(0, 0, 6, 0)
      await sleep(500)
      assert.deepEqual(await contexts(settled), [], "the same context as last time")
    },
  },
  {
    name: "the page's context bar adds the selection, or a whole file, to the composer it shows; nothing when it is gone",
    modes: ["fake"],
    async run({ api, project }) {
      const b = join(workspace, "src", "b.ts")
      const editor = await openSample([1, 0, 3])
      await until("the selection told", async () => (await contexts()).at(-1)?.active?.selection?.endLine === 4)
      // What came of each add-context, as the sidebar recorded it (after the page answered the compose).
      const added = () => api.sidebar().events.filter((event) => event.type === "ntwine:add-context").map((event) => event.outcome)
      const first = added().length
      const from = await received()
      await pagePosts({ type: "ntwine:add-context", what: "selection" })
      await pagePosts({ type: "ntwine:add-context", what: "file", path: b })
      await until("two composes", async () => (await pageReceived("ntwine:compose", from)).length === 2)
      const [selection, file] = (await pageReceived("ntwine:compose", from)).map(({ id: _, ...rest }) => rest)
      await until("both recorded", () => added().length >= first + 2)
      assert.deepEqual(added().slice(first), ["composed", "composed"])
      assert.deepEqual(selection, {
        type: "ntwine:compose",
        item: { projectId: project.id, path: sample, text: sampleLines(editor.document, 2, 4), startLine: 2, endLine: 4, app: vscode.env.appName },
        target: "front",
        focus: true,
      })
      assert.deepEqual(file, { type: "ntwine:compose", item: { projectId: project.id, path: b, app: vscode.env.appName }, target: "front", focus: true })

      editor.selection = new vscode.Selection(2, 1, 2, 1)
      await sleep(300)
      const before = await received()
      const outcomes = added().length
      await pagePosts({ type: "ntwine:add-context", what: "selection" })
      await pagePosts({ type: "ntwine:add-context", what: "file", path: join(workspace, "src", "gone.ts") })
      await until("both answered", () => added().length >= outcomes + 2)
      assert.deepEqual(added().slice(outcomes), ["nothing selected", "missing"])
      assert.deepEqual(await pageReceived("ntwine:compose", before), [])
    },
  },
  {
    name: "one switch: the page's eye is ntwine.shareEditorState, and the agents' frame and the page's feed both follow it",
    modes: ["fake"],
    async run() {
      const ntwine = vscode.workspace.getConfiguration("ntwine")
      await openSample([1, 0, 2])
      await until("the selection's text told", async () => (await contexts()).at(-1)?.active?.selection?.text !== undefined)
      try {
        // The eye, off: its `ntwine:share-editor` writes the setting, and the agents' frame, the page's own
        // feed (the lines without their text) and the eye (`ntwine:host-state`) follow.
        const from = await received()
        await pagePosts({ type: "ntwine:share-editor", on: false })
        await until("the setting off", () => ntwine.inspect<boolean>("shareEditorState")?.globalValue === false)
        await until("the agents' frame off", async () => (await editorFrames()).at(-1)?.shared === false)
        await until("the eye told", async () => (await pageReceived("ntwine:host-state", from)).some((state) => state.shareEditor === false))
        await until("the page told the lines alone", async () => {
          const last = (await contexts(from)).at(-1)?.active?.selection
          return last?.startLine === 2 && last.text === undefined
        })
        // On again from VS Code's side — the setting, as Settings or another window writes it: the eye follows.
        const back = await received()
        await ntwine.update("shareEditorState", true, vscode.ConfigurationTarget.Global)
        await until("the eye told it is on", async () => (await pageReceived("ntwine:host-state", back)).some((state) => state.shareEditor === true))
        await until("the agents' frame on", async () => (await editorFrames()).at(-1)?.shared === true)
        await until("the page told the text again", async () => (await contexts(back)).at(-1)?.active?.selection?.text !== undefined)
        // A workspace that sets its own value: the eye writes THERE, since a user-level write under it would change nothing.
        await ntwine.update("shareEditorState", true, vscode.ConfigurationTarget.Workspace)
        await pagePosts({ type: "ntwine:share-editor", on: false })
        await until("the workspace's value off", () => ntwine.inspect<boolean>("shareEditorState")?.workspaceValue === false)
        assert.equal(ntwine.inspect<boolean>("shareEditorState")?.globalValue, true, "the user's value untouched")
        await until("the agents' frame off", async () => (await editorFrames()).at(-1)?.shared === false)
      } finally {
        await ntwine.update("shareEditorState", undefined, vscode.ConfigurationTarget.Workspace)
        await ntwine.update("shareEditorState", undefined, vscode.ConfigurationTarget.Global)
      }
    },
  },
  {
    name: "Ctrl+L (Cursor's) and Ctrl+I in the editor put the selection in the sidebar's prompt with the caret; with no selection Ctrl+L goes to the prompt box and Ctrl+I is VS Code's",
    modes: ["fake"],
    async run({ project }) {
      // Ctrl+L LAST: VS Code shows a command's last-contributed binding in its menus and the palette.
      assert.deepEqual(manifest().contributes.keybindings, [
        { command: "ntwine.addToPrompt", key: "ctrl+i", mac: "cmd+i", when: "editorTextFocus && editorHasSelection" },
        { command: "ntwine.addToPrompt", key: "ctrl+l", mac: "cmd+l", when: "editorTextFocus && editorHasSelection" },
        { command: "ntwine.focusPrompt", key: "ctrl+l", mac: "cmd+l", when: "editorTextFocus && !editorHasSelection && config.ntwine.useSidebar" },
        { command: "ntwine.addSelectionOrFile", key: "alt+k", mac: "alt+k", when: "editorTextFocus && !ntwine.claudeCodeInstalled" },
      ])
      const mod = process.platform === "darwin" ? "meta" : "ctrl"
      for (const chord of [`${mod}+l`, `${mod}+i`]) {
        const editor = await openSample([4, 0, 4])
        await sleep(500)
        const from = await received()
        await press(chord)
        await until(`${chord}'s chip in the page`, async () => (await pageReceived("ntwine:compose", from)).length > 0, 15_000)
        await sleep(300)
        const composes = await pageReceived("ntwine:compose", from)
        assert.equal(composes.length, 1, `${chord}: one press, one chip`)
        const [compose] = composes
        assert.deepEqual({ ...compose, id: undefined }, {
          type: "ntwine:compose",
          id: undefined,
          item: { projectId: project.id, path: sample, text: sampleLines(editor.document, 5, 5), startLine: 5, endLine: 5, app: vscode.env.appName },
          target: "front",
          focus: true,
        }, chord)
      }

      // A caret, no selection: nothing is added. Ctrl+L takes the human to the sidebar's prompt box (Cursor's
      // "open the chat"), leaving the caret where it was; Ctrl+I stays VS Code's own.
      // The selection crosses to the window's renderer, where `editorHasSelection` is kept, on its own
      // channel; the key must not overtake it — hence the waits.
      const caret = await openSample()
      caret.selection = new vscode.Selection(5, 2, 5, 2)
      await sleep(500)
      let before = await received()
      await press(`${mod}+l`)
      await until("the page asked for its prompt box", async () => (await pageReceived("ntwine:command", before)).some((message) => message.command === "prompt"), 15_000)
      await until("the sidebar focused", async () => (await focusIn()) === "sidebar")
      assert.deepEqual(await pageReceived("ntwine:compose", before), [], "Ctrl+L with a caret adds nothing")
      assert.deepEqual([caret.selection.active.line, caret.selection.active.character, caret.selection.isEmpty], [5, 2, true], "the caret untouched")

      await openSample().then((editor) => (editor.selection = new vscode.Selection(5, 2, 5, 2)))
      await sleep(500)
      before = await received()
      await press(`${mod}+i`)
      await sleep(1_500)
      assert.deepEqual(await pageReceived("ntwine:compose", before), [], "Ctrl+I with a caret")
      assert.deepEqual(await pageReceived("ntwine:command", before), [], "Ctrl+I with a caret")
      await press("escape")

      // With the sidebar off, Ctrl+L with a caret is VS Code's again: it selects the caret's line.
      const ntwine = vscode.workspace.getConfiguration("ntwine")
      await ntwine.update("useSidebar", false, vscode.ConfigurationTarget.Global)
      try {
        const line = await openSample()
        line.selection = new vscode.Selection(5, 2, 5, 2)
        await sleep(500)
        before = await received()
        await press(`${mod}+l`)
        await until("VS Code's Ctrl+L selected the line", () => {
          const { start, end } = line.selection
          return isDeepStrictEqual([start.line, start.character, end.line, end.character], [5, 0, 6, 0])
        })
        assert.deepEqual(await pageReceived("ntwine:command", before), [])
      } finally {
        await ntwine.update("useSidebar", undefined, vscode.ConfigurationTarget.Global)
      }
    },
  },
  {
    name: "Alt+K (Claude Code's) adds the selection, or with only a caret the whole file",
    modes: ["fake"],
    async run({ project }) {
      const editor = await openSample([1, 0, 2])
      await sleep(500)
      let from = await received()
      await press("alt+k")
      await until("the selection's chip", async () => (await pageReceived("ntwine:compose", from)).length > 0, 15_000)
      await sleep(300)
      assert.deepEqual((await pageReceived("ntwine:compose", from)).map(({ id: _, ...rest }) => rest), [{
        type: "ntwine:compose",
        item: { projectId: project.id, path: sample, text: sampleLines(editor.document, 2, 3), startLine: 2, endLine: 3, app: vscode.env.appName },
        target: "front",
        focus: true,
      }])

      // A caret only: the whole file, not the caret's line (which the palette's Add to ntwine prompt adds).
      const caret = await openSample()
      caret.selection = new vscode.Selection(3, 1, 3, 1)
      await sleep(500)
      from = await received()
      await press("alt+k")
      await until("the file's chip", async () => (await pageReceived("ntwine:compose", from)).length > 0, 15_000)
      await sleep(300)
      assert.deepEqual((await pageReceived("ntwine:compose", from)).map(({ id: _, ...rest }) => rest), [{
        type: "ntwine:compose",
        item: { projectId: project.id, path: sample, app: vscode.env.appName },
        target: "front",
        focus: true,
      }])
    },
  },
  {
    name: "a selection made by hand gets the hint `Ctrl+L to add to ntwine` once it settles; none when it empties, for one an extension set, a select-all, a diff, one just added, or with the setting off",
    modes: ["fake"],
    async run({ api }) {
      const mod = process.platform === "darwin" ? "meta" : "ctrl"
      const words = `${process.platform === "darwin" ? "⌘L" : "Ctrl+L"} to add to ntwine`
      // What the editor DRAWS: VS Code renders an `after` decoration as a CSS ::after on a span of the line.
      const drawn = () => workbench<string[]>(`[...document.querySelectorAll(".part.editor .view-lines span")]
        .map((span) => getComputedStyle(span, "::after").content).filter((content) => content.includes("add to ntwine"))`)
      const none = async (why: string) => {
        await sleep(800)
        assert.equal(api.selectionHint(), undefined, why)
        assert.deepEqual(await drawn(), [], `${why}: nothing drawn`)
      }

      // Shift+Down twice from the start of line 2: lines 2-3 by the chip's count (the caret ends at column
      // 1 of line 4, which is not in it), so the hint sits after line 3.
      const editor = await openSample()
      editor.selection = new vscode.Selection(1, 0, 1, 0)
      await sleep(400)
      const pressed = Date.now()
      await press("shift+down")
      await press("shift+down")
      await until("the hint", () => api.selectionHint() !== undefined)
      const after = Date.now() - pressed
      assert.deepEqual(api.selectionHint(), { path: sample, line: 3, text: words })
      assert.ok(after >= 250, `it waits for the selection to settle: shown ${after}ms after the first key`)
      await until("the hint drawn", async () => (await drawn()).length === 1)
      assert.deepEqual(await drawn(), [JSON.stringify(words)])
      // Drawn on the selection's last line, after its text.
      const onLine = await workbench<string | null>(`(() => {
        const span = [...document.querySelectorAll(".part.editor .view-lines span")].find((s) => getComputedStyle(s, "::after").content.includes("add to ntwine"))
        return span?.closest(".view-line")?.textContent?.replace(/\u00a0/g, " ") ?? null
      })()`)
      assert.equal(onLine?.trimEnd(), editor.document.lineAt(2).text.trimEnd(), "after line 3's own text")
      console.log(`  · shown ${after}ms after the first key, after line 3`)
      await fake("/__e2e/shot", { path: join(process.env.NTWINE_E2E_SHOTS || workspace, `${vscode.version}-selection-hint.png`) })

      // The selection empties: gone.
      await press("right")
      await until("the hint gone", () => api.selectionHint() === undefined)
      await until("nothing drawn", async () => (await drawn()).length === 0)

      // Made upward, it sits on the selection's first line, where the caret is.
      editor.selection = new vscode.Selection(4, 0, 4, 0)
      await sleep(400)
      await press("shift+up")
      await until("the hint, upward", () => api.selectionHint()?.line === 4)

      // A selection an extension set — as ntwine's own file links select their lines — gets none.
      editor.selection = new vscode.Selection(1, 0, 3, 4)
      await none("a selection an extension set")

      // A select-all gets none.
      editor.selection = new vscode.Selection(0, 0, 0, 0)
      await sleep(400)
      await press(`${mod}+a`)
      await until("the select-all", () => !editor.selection.isEmpty)
      await none("a select-all")

      // After Ctrl+L the selection is in the prompt: the hint has done its job, until the selection moves.
      editor.selection = new vscode.Selection(1, 0, 1, 0)
      await sleep(400)
      await press("shift+down")
      await until("the hint before Ctrl+L", () => api.selectionHint() !== undefined)
      const from = await received()
      await press(`${mod}+l`)
      await until("Ctrl+L's chip in the page", async () => (await pageReceived("ntwine:compose", from)).length > 0, 15_000)
      assert.equal(api.selectionHint(), undefined, "gone once added")
      // Back to the editor with its selection as it was (showing an open editor keeps its view state).
      await vscode.window.showTextDocument(editor.document, { preserveFocus: false })
      await none("the same selection, already added")
      await press("shift+down")
      await until("the hint on a new selection", () => api.selectionHint()?.line === 3)

      // A diff: the same file as a diff's modified side gets none; the chord still works there.
      const base = workspaceFile("hint-base.ts")
      await vscode.commands.executeCommand("vscode.diff", vscode.Uri.file(base), vscode.Uri.file(sample), "hint diff")
      await until("the diff in front", () => vscode.window.activeTextEditor?.document.uri.fsPath === sample && !(vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputText))
      const modified = vscode.window.activeTextEditor!
      modified.selection = new vscode.Selection(1, 0, 1, 0)
      await sleep(400)
      await press("shift+down")
      await until("the diff's selection", () => !modified.selection.isEmpty)
      await none("in a diff")

      // The setting off: none, and on again, it is back for the next selection.
      const ntwine = vscode.workspace.getConfiguration("ntwine")
      await ntwine.update("selectionHint", false, vscode.ConfigurationTarget.Global)
      try {
        const again = await openSample()
        again.selection = new vscode.Selection(1, 0, 1, 0)
        await sleep(400)
        await press("shift+down")
        await until("the selection", () => !again.selection.isEmpty)
        await none("with ntwine.selectionHint off")
      } finally {
        await ntwine.update("selectionHint", undefined, vscode.ConfigurationTarget.Global)
      }
      await until("the hint once the setting is back", () => api.selectionHint() !== undefined)
    },
  },
  {
    name: "a problem's quick fix asks ntwine to fix it: its lines in the prompt and the problem written after the chip",
    modes: ["fake"],
    async run({ project }) {
      const diagnostics = vscode.languages.createDiagnosticCollection("ntwine-e2e")
      const ntwine = vscode.workspace.getConfiguration("ntwine")
      try {
        const editor = await openSample()
        const uri = editor.document.uri
        const problem = new vscode.Diagnostic(new vscode.Range(3, 4, 3, 9), "Cannot find name 'total'.", vscode.DiagnosticSeverity.Error)
        problem.source = "ts"
        problem.code = 2304
        diagnostics.set(uri, [problem])
        const fixes = async () => {
          const actions = (await vscode.commands.executeCommand<vscode.CodeAction[]>("vscode.executeCodeActionProvider", uri, new vscode.Range(3, 6, 3, 6))) ?? []
          return actions.filter((action) => action.title.startsWith("Ask ntwine to fix"))
        }
        let offered: vscode.CodeAction[] = []
        await until("the fix offered", async () => (offered = await fixes()).length === 1)
        assert.equal(offered[0]!.title, "Ask ntwine to fix")
        assert.equal(offered[0]!.kind?.value, vscode.CodeActionKind.QuickFix.value)
        const from = await received()
        const command = offered[0]!.command!
        await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []))
        const [compose] = await pageReceived("ntwine:compose", from)
        assert.deepEqual({ ...compose, id: undefined }, {
          type: "ntwine:compose",
          id: undefined,
          item: { projectId: project.id, path: sample, text: sampleLines(editor.document, 4, 4), startLine: 4, endLine: 4, app: vscode.env.appName },
          target: "front",
          focus: true,
          note: "Fix: Cannot find name 'total'. ts(2304)",
        })

        // Two problems under the caret: one fix each, told apart by their messages.
        const lint = new vscode.Diagnostic(new vscode.Range(3, 2, 3, 12), "Assignment to a loop's sum.", vscode.DiagnosticSeverity.Warning)
        lint.source = "eslint"
        lint.code = { value: "no-sum", target: vscode.Uri.parse("https://eslint.org/docs/rules/no-sum") }
        diagnostics.set(uri, [problem, lint])
        await until("two fixes", async () => (offered = await fixes()).length === 2)
        assert.deepEqual(offered.map((action) => action.title).sort(), ["Ask ntwine to fix: Assignment to a loop's sum.", "Ask ntwine to fix: Cannot find name 'total'."])

        // The sidebar off: nowhere for the problem's words to go, so nothing is offered.
        await ntwine.update("useSidebar", false, vscode.ConfigurationTarget.Global)
        assert.deepEqual(await fixes(), [])
      } finally {
        diagnostics.dispose()
        await ntwine.update("useSidebar", undefined, vscode.ConfigurationTarget.Global)
      }
    },
  },
  {
    name: "a tab's menu and the explorer add whole files — every file selected, never a folder",
    modes: ["fake"],
    async run({ project }) {
      const menus = manifest().contributes.menus
      assert.deepEqual(menus["editor/title/context"], [{ command: "ntwine.addFileToPrompt", when: "resourceScheme == file", group: "ntwine@1" }])
      assert.ok(menus["explorer/context"]!.some((entry) => entry.command === "ntwine.addFileToPrompt" && entry.when === "!explorerResourceIsFolder"))
      const a = join(workspace, "src", "a.ts")
      const b = join(workspace, "src", "b.ts")
      const item = (path: string) => ({ type: "ntwine:compose", item: { projectId: project.id, path, app: vscode.env.appName }, target: "front", focus: true })
      const composes = async (from: number) => (await pageReceived("ntwine:compose", from)).map(({ id: _, ...rest }) => rest)

      // A tab's menu hands the command the tab's file and the group it is in.
      let from = await received()
      await vscode.commands.executeCommand("ntwine.addFileToPrompt", vscode.Uri.file(a), { groupId: 0 })
      assert.deepEqual(await composes(from), [item(a)])

      // The explorer hands it the file right-clicked and everything selected, a folder among them.
      from = await received()
      await vscode.commands.executeCommand("ntwine.addFileToPrompt", vscode.Uri.file(b), [vscode.Uri.file(a), vscode.Uri.file(b), vscode.Uri.file(join(workspace, "src"))])
      assert.deepEqual(await composes(from), [item(a), item(b)])
    },
  },
  {
    name: "the terminal's menu adds its selection as @terminal, and the clipboard is the human's again after",
    modes: ["fake"],
    async run({ project }) {
      assert.deepEqual(manifest().contributes.menus["terminal/context"], [
        { command: "ntwine.addTerminalSelection", when: "terminalTextSelected && config.ntwine.useSidebar", group: "ntwine@1" },
        { command: "ntwine.addTerminalOutput", when: "config.ntwine.useSidebar", group: "ntwine@2" },
      ])
      const clipboard = "the human's own clipboard"
      await vscode.env.clipboard.writeText(clipboard)
      const terminal = vscode.window.createTerminal({ name: "ntwine e2e", shellPath: "/bin/sh" })
      try {
        terminal.show()
        terminal.sendText("echo ntwine-from-the-terminal")
        // The echo's output, not a fixed beat: VS Code holds a new terminal until it has resolved the
        // user's shell environment, which took over 10s on a loaded machine ("ptyHost was unable to resolve
        // shell environment"), and 1.5s then selected an empty terminal. Read through the clipboard, which
        // is the human's again before the step's own reading starts.
        await terminal.processId
        await until("the echo in the terminal", async () => {
          await vscode.commands.executeCommand("workbench.action.terminal.selectAll")
          await vscode.commands.executeCommand("workbench.action.terminal.copySelection")
          return /ntwine-from-the-terminal\s*\n.*ntwine-from-the-terminal/su.test(await vscode.env.clipboard.readText())
        }, 30_000)
        await vscode.env.clipboard.writeText(clipboard)
        await vscode.commands.executeCommand("workbench.action.terminal.selectAll")
        const from = await received()
        const composed = await vscode.commands.executeCommand<EditorComposed | undefined>("ntwine.addTerminalSelection")
        assert.equal(composed?.ok, true, JSON.stringify(composed))
        const [compose] = await pageReceived("ntwine:compose", from)
        const item = compose!.item as { path: string; text: string; projectId?: string }
        assert.equal(item.path, "terminal")
        assert.equal(item.projectId, project.id)
        assert.match(item.text, /ntwine-from-the-terminal/u)
        assert.deepEqual({ target: compose!.target, focus: compose!.focus }, { target: "front", focus: true })
        assert.equal(await vscode.env.clipboard.readText(), clipboard, "the clipboard is as the human left it")

        // Nothing selected: nothing added, and the clipboard still kept.
        await vscode.commands.executeCommand("workbench.action.terminal.clearSelection")
        const before = await received()
        assert.equal(await vscode.commands.executeCommand("ntwine.addTerminalSelection"), undefined)
        assert.deepEqual(await pageReceived("ntwine:compose", before), [])
        assert.equal(await vscode.env.clipboard.readText(), clipboard)
      } finally {
        terminal.dispose()
      }
    },
  },
  {
    name: "where the page is picks the title row's buttons and its counts ride the badge; the row itself still reads ntwine",
    modes: ["fake"],
    async run({ api, project }) {
      await vscode.commands.executeCommand("ntwine.sidebar.focus")
      await fake("/__e2e/projects", { projects: [{ ...project, ready: 2, working: 0 }] })
      await until("a badge of 2", () => api.sidebar().badge === 2)
      await pagePosts({ type: "ntwine:route", view: "thread", title: "fake-thread", description: "Waiting on you" })
      await until("the thread's view and counts", () => api.sidebar().view === "thread" && api.sidebar().badgeTooltip === "Waiting on you")
      let row = await titleRow()
      await until("the thread's buttons", async () => (row = await titleRow()).buttons.includes("Back to queue"))
      // VS Code re-cases a view's title ("ntwine: Fake-Thread"), so the page's names stay in the page.
      assert.doesNotMatch(row.heading, /fake-thread/iu)
      assert.deepEqual(row.buttons.filter((label) => !/More Actions/u.test(label)), ["Back to queue", "Jump to a thread", "Settings"])

      await pagePosts({ type: "ntwine:route", view: "queue", title: "", description: "2 ready" })
      await until("the queue's view and counts", () => api.sidebar().view === "queue" && api.sidebar().badgeTooltip === "2 ready")
      await until("the queue's buttons", async () => (row = await titleRow()).buttons.includes("New thread"))
      assert.deepEqual(row.buttons.filter((label) => !/More Actions/u.test(label)), ["New thread", "Jump to a thread", "Settings"])
      await fake("/__e2e/projects", { projects: [{ ...project, ready: 0, working: 0 }] })
      await until("no badge", () => api.sidebar().badge === undefined)
    },
  },
  {
    name: "each title-row command opens its door in the page, bringing the sidebar back first when it was hidden",
    modes: ["fake"],
    async run({ api }) {
      await vscode.commands.executeCommand("workbench.view.explorer")
      await until("the sidebar hidden", () => !api.sidebar().visible)
      let from = await received()
      assert.equal(await vscode.commands.executeCommand("ntwine.sidebar.jump"), true)
      assert.equal(api.sidebar().visible, true)
      for (const command of ["ntwine.sidebar.newThread", "ntwine.sidebar.queue", "ntwine.sidebar.settings", "ntwine.sidebar.shortcuts"]) assert.equal(await vscode.commands.executeCommand(command), true, command)
      await until("five doors", async () => (await pageReceived("ntwine:command", from)).length === 5)
      assert.deepEqual((await pageReceived("ntwine:command", from)).map((data) => data.command), ["jump", "new-thread", "queue", "settings", "shortcuts"])
      // Keyboard shortcuts is under the row's ⋯ (the page's status row does not draw its ⌨ in the sidebar),
      // with the other overflow entries, and only while a page says where it is. Open thread in editor tab
      // leads it while a thread shows.
      const overflow = manifest().contributes.menus["view/title"]!.filter((item) => !item.group?.startsWith("navigation"))
      assert.deepEqual(overflow.map((item) => item.command), ["ntwine.openThreadInTab", "ntwine.sidebar.reload", "ntwine.open", "ntwine.sidebar.shortcuts"])
      assert.equal(overflow.at(-1)!.when, "view == ntwine.sidebar && ntwine.sidebarView")

      // The button itself, clicked with a mouse: the queue's row has New thread.
      await pagePosts({ type: "ntwine:route", view: "queue", title: "", description: "2 ready" })
      await until("the New thread button", async () => (await titleRow()).buttons.includes("New thread"))
      from = await received()
      assert.equal(await click('.part.sidebar .title-actions .action-label[aria-label="New thread"]'), true, "the New thread button is in the title row")
      await until("the click's door", async () => isDeepStrictEqual((await pageReceived("ntwine:command", from)).map((data) => data.command), ["new-thread"]))
    },
  },
  {
    name: "a page that loads again starts with no title-row view and is told the editor's context at once",
    modes: ["fake"],
    async run({ api }) {
      await openSample([2, 0, 2])
      await until("line 3 told", async () => (await contexts()).at(-1)?.active?.selection?.startLine === 3)
      const loads = (await fakeLog()).page.loads.length
      const from = await received()
      await vscode.commands.executeCommand("ntwine.sidebar.reload")
      await until("the new page ready", async () => (await fakeLog()).page.loads.length === loads + 1 && api.sidebar().ready, 30_000)
      assert.equal(api.sidebar().view, "", "no page has said where it is yet")
      await until("the context told to the new page", async () => (await contexts(from)).some((message) => message.active?.selection?.startLine === 3))
    },
  },
  {
    name: "a page that doesn't answer leaves Add to ntwine prompt to ntwine, and so does turning the setting off",
    modes: ["fake"],
    async run() {
      await openSample([1, 0, 1])
      const composes = async () => (await fakeLog()).frames.filter((frame) => frame.t === "compose").length
      await fake("/__e2e/page-answer", { answer: "silent" })
      try {
        const before = await composes()
        const composed = await vscode.commands.executeCommand<EditorComposed | undefined>("ntwine.addToPrompt")
        assert.equal(composed?.ok, true, JSON.stringify(composed))
        assert.equal(await composes(), before + 1, "after the page's silence, ntwine holds it for a page to claim")
      } finally {
        await fake("/__e2e/page-answer", { answer: "ok" })
      }

      const ntwine = vscode.workspace.getConfiguration("ntwine")
      await ntwine.update("useSidebar", false, vscode.ConfigurationTarget.Global)
      try {
        const before = await composes()
        const pageBefore = (await fakeLog()).page.received.length
        const composed = await vscode.commands.executeCommand<EditorComposed | undefined>("ntwine.addToPrompt")
        assert.equal(composed?.ok, true)
        assert.equal(await composes(), before + 1)
        assert.deepEqual(await pageReceived("ntwine:compose", pageBefore), [], "the open sidebar was left alone")
      } finally {
        await ntwine.update("useSidebar", undefined, vscode.ConfigurationTarget.Global)
      }
    },
  },
  {
    name: "review: ntwine's push (a browser's Review changes) opens a worktree's branch as one multi-file diff and says this window can",
    modes: ["fake"],
    async run({ api }) {
      const repo = reviewRepo()
      // The window told this ntwine it can review — only because its welcome named the feature.
      const features = (await fakeLog()).frames.filter((frame) => frame.t === "features")
      assert.deepEqual(features.at(-1), { t: "features", features: ["review"] })
      await vscode.commands.executeCommand("workbench.action.closeAllEditors")
      const result = await fake<{ t: string; ok: boolean; error?: string }>("/__e2e/review", { title: "Tidy the loop", checkouts: [{ dir: repo.worktree, scope: "branch", files: repo.edited }] })
      assert.deepEqual({ ok: result.ok, error: result.error }, { ok: true, error: undefined })
      await assertReviewInFront(api, repo, "Tidy the loop")
      await assertReviewDrawn(repo, reviewShot("review-pushed"))
    },
  },
  {
    name: "review: the sidebar's page names a thread (ntwine:review), and the extension asks ntwine what it changed",
    modes: ["fake"],
    async run({ api, project }) {
      const repo = reviewRepo()
      await fake("/__e2e/review-target", { target: { title: "Fake thread", checkouts: [{ dir: repo.worktree, scope: "branch", files: [] }] } })
      await vscode.commands.executeCommand("workbench.action.closeAllEditors")
      const asked = (await fakeLog()).rpc.length
      const events = api.sidebar().events.length
      await pagePosts({ type: "ntwine:review", thread: "fake-thread", project: project.slug, title: "Tidy the loop from the sidebar" })
      await until("the review opened", () => api.sidebar().events.slice(events).some((event) => event.type === "ntwine:review"), 20_000)
      assert.deepEqual(api.sidebar().events.slice(events).filter((event) => event.type === "ntwine:review"), [{ type: "ntwine:review", outcome: "opened" }])
      assert.deepEqual((await fakeLog()).rpc.slice(asked).filter((call) => call.procedure === "reviewTarget").map((call) => ({ projectId: call.projectId, input: call.input })), [
        { projectId: project.id, input: { slug: "fake-thread", title: "Tidy the loop from the sidebar" } },
      ], "the page named the thread, ntwine named the folder")
      await assertReviewInFront(api, repo, "Tidy the loop from the sidebar")
      // A page message naming a folder instead of a thread is not a review.
      const before = api.sidebar().events.length
      await pagePosts({ type: "ntwine:review", thread: "../../etc", project: project.slug })
      await until("the refusal recorded", () => api.sidebar().events.length > before)
      assert.equal(api.sidebar().events.at(-1)?.outcome, "ignored")
    },
  },
  {
    name: "review: from the palette by thread; nothing to compare is said, not opened",
    modes: ["fake"],
    async run({ api }) {
      const repo = reviewRepo()
      await fake("/__e2e/review-target", { target: { title: "Fake thread", checkouts: [{ dir: repo.worktree, scope: "branch", files: [] }] } })
      await vscode.commands.executeCommand("workbench.action.closeAllEditors")
      assert.equal(await vscode.commands.executeCommand("ntwine.reviewThread", { thread: "fake-thread" }), "opened")
      await assertReviewInFront(api, repo, "Fake thread")

      // The project folder's review is the thread's own files' UNCOMMITTED changes: loop.ts is committed there.
      const shown = api.review()
      const clean = await fake<{ ok: boolean; error?: string }>("/__e2e/review", { title: "Clean", checkouts: [{ dir: repo.dir, scope: "files", files: [join(repo.dir, "src", "loop.ts")] }] })
      assert.deepEqual({ ok: clean.ok, error: clean.error }, { ok: false, error: "The files this thread edited have no uncommitted changes." })
      const plain = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-e2e-not-a-repo-")))
      const notRepo = await fake<{ ok: boolean; error?: string }>("/__e2e/review", { title: "Plain", checkouts: [{ dir: plain, scope: "branch", files: [] }] })
      assert.equal(notRepo.ok, false)
      assert.match(notRepo.error ?? "", /isn't a git repository/)
      assert.equal(api.review(), shown, "neither opened anything")
      assert.match(vscode.window.tabGroups.activeTabGroup.activeTab?.label ?? "", /^Changes in Fake thread( \(5 files\))?$/u)
    },
  },
  {
    name: "review: a thread that worked in a worktree — ntwine reads its edits there, and Review changes opens them here",
    modes: ["real"],
    async run({ api, project, rpc }) {
      const raw = process.env.NTWINE_E2E_REVIEW
      if (!raw) return skip("needs the stack's seeded thread (scripts/e2e.ts --stack)")
      const seeded = JSON.parse(raw) as SeededReview
      // The server's own reading: the worktree is the checkout, its scope the whole branch, and the files
      // the agent wrote there are the edited files — before 11f327a0 the rail read every one as ignored.
      const target = await rpc.query(project.id, "reviewTarget", { slug: seeded.slug })
      assert.deepEqual(target.checkouts.map(({ dir, scope }) => ({ dir, scope })), [{ dir: seeded.repo.worktree, scope: "branch" }], JSON.stringify(target))
      assert.deepEqual(target.checkouts[0]!.files, seeded.repo.edited, "the worktree's edits, newest first")
      const windows = await rpc.query(project.id, "editorWindows")
      assert.ok(windows.windows.some((window) => window.reviews && window.app === vscode.env.appName), `this window says it can review: ${JSON.stringify(windows)}`)
      await vscode.commands.executeCommand("workbench.action.closeAllEditors")
      // What a browser tab's ⋯ Review changes calls.
      assert.deepEqual(await rpc.mutation(project.id, "reviewInEditor", { slug: seeded.slug, title: seeded.title }), { ok: true })
      await assertReviewInFront(api, seeded.repo, seeded.title)
    },
  },
  {
    name: "the hello names this build, the status bar's tooltip says it, and a new build on disk is offered as a reload",
    modes: ["fake"],
    async run({ api }) {
      // Built by scripts/build.ts, so it names its commit (and whether the tree was dirty).
      assert.match(api.build, /^\d+\.\d+\.\d+\+[0-9a-f]{8}(-dirty)?$/u)
      const hello = (await fakeLog()).frames.find((frame) => frame.t === "hello")
      assert.equal(hello?.t === "hello" ? hello.extensionVersion : undefined, api.build)
      assert.ok(api.statusBar().tooltip.includes(`ntwine extension ${api.build}`), api.statusBar().tooltip)
      // The same build reinstalled in place (`--install-extension --force`) is a new id under the folder
      // this window loaded from; the window offers to reload into it.
      const file = join(vscode.extensions.getExtension("ssalbdivad.ntwine-vscode")!.extensionPath, "dist", "build.json")
      const original = readFileSync(file, "utf8")
      try {
        const next = { ...(JSON.parse(original) as { version: string; dirty?: boolean }), id: randomUUID(), commit: "0badc0de" }
        writeFileSync(file, JSON.stringify(next))
        const label = `${next.version}+0badc0de${next.dirty ? "-dirty" : ""}`
        await until("the reload offer", () => api.reloadOffered() === label, 15_000)
        await until("its toast, with Reload window", () => workbench<boolean>(`[...document.querySelectorAll(".notification-toast")].some((toast) => toast.textContent.includes(${JSON.stringify(`updated to ${label}. Reload the window to use it.`)}) && toast.textContent.includes("Reload window"))`))
      } finally {
        writeFileSync(file, original)
        await vscode.commands.executeCommand("notifications.clearAll")
      }
    },
  },
  {
    name: "an ntwine from before the sidebar is named as the cause at once, not after the 20s wait",
    modes: ["fake"],
    async run({ api }) {
      const hellos = async () => (await fakeLog()).frames.filter((frame) => frame.t === "hello").length
      const reconnect = async () => {
        const count = await hellos()
        await fake("/__e2e/drop")
        await until("hello again", async () => (await hellos()) > count && api.status().kind === "connected", 30_000)
      }
      await vscode.commands.executeCommand("ntwine.sidebar.focus")
      try {
        await fake("/__e2e/features", { features: [], ready: false })
        await reconnect()
        const started = Date.now()
        await vscode.commands.executeCommand("ntwine.sidebar.reload")
        await until("the bar naming an old ntwine", () => api.sidebar().hint === HINT_OLD_NTWINE, 8_000)
        assert.ok(Date.now() - started < 8_000)
        assert.equal(api.sidebar().ready, false)
      } finally {
        await fake("/__e2e/features", { features: Object.values(EDITOR_FEATURES), ready: true })
        await reconnect()
        await vscode.commands.executeCommand("ntwine.sidebar.reload")
      }
      await until("the page ready again, no bar", () => api.sidebar().ready && !api.sidebar().hinted, 30_000)
    },
  },
  {
    name: "the page's `@` finds the workspace's files as the editor lists them, and a drop resolves to files and folders on disk",
    modes: ["fake"],
    async run({ api, project }) {
      const excluded = join(workspace, "src", "excluded")
      const built = join(workspace, "build")
      mkdirSync(excluded, { recursive: true })
      mkdirSync(built, { recursive: true })
      writeFileSync(join(excluded, "sample-copy.ts"), "export {}\n")
      writeFileSync(join(built, "sample-out.ts"), "export {}\n")
      const search = vscode.workspace.getConfiguration("search")
      const files = vscode.workspace.getConfiguration("files")
      await search.update("exclude", { "**/excluded": true }, vscode.ConfigurationTarget.Workspace)
      await files.update("exclude", { "**/build": true }, vscode.ConfigurationTarget.Workspace)
      const picks = async (id: string, request: { query: string } | { uris: string[] }): Promise<EmbedPickedFile[]> => {
        const from = await received()
        await pagePosts({ type: "ntwine:pick-context", id, ...request })
        let answer: EmbedContextPicksMessage | undefined
        await until(`the answer to ${id}`, async () => {
          answer = (await pageReceived("ntwine:context-picks", from)).find((message) => message.id === id) as EmbedContextPicksMessage | undefined
          return answer !== undefined
        })
        return answer!.files
      }
      try {
        await openSample()
        const own = { path: sample, label: "src/sample.ts", projectId: project.id }
        // search.exclude and files.exclude both hold: neither copy is offered.
        assert.deepEqual(await picks("q1", { query: "sample" }), [own])
        assert.deepEqual(await picks("q2", { query: "src/samp" }), [own])
        // An empty `@` offers the open tabs, the one in front first.
        assert.deepEqual((await picks("q3", { query: "" }))[0], own)
        // A drop: a file and a folder on disk, as VS Code's explorer carries them; an untitled buffer and a
        // file that is gone are not on disk, and are left out.
        const dropped = await picks("d1", { uris: [vscode.Uri.file(sample).toString(), vscode.Uri.file(join(workspace, "src")).toString(), "untitled:Untitled-1", vscode.Uri.file(join(workspace, "gone.ts")).toString()] })
        assert.deepEqual(dropped, [own, { path: join(workspace, "src"), label: "src", projectId: project.id, folder: true }])
        assert.deepEqual(api.sidebar().events.filter((event) => event.type === "ntwine:pick-context").slice(-1), [{ type: "ntwine:pick-context", outcome: "2 dropped" }])
      } finally {
        await search.update("exclude", undefined, vscode.ConfigurationTarget.Workspace)
        await files.update("exclude", undefined, vscode.ConfigurationTarget.Workspace)
        rmSync(excluded, { recursive: true, force: true })
        rmSync(built, { recursive: true, force: true })
      }
    },
  },
  {
    name: "the page is told the file's problems and the terminal's last command, and adding either puts one chip in the box",
    modes: ["fake"],
    async run({ api, project }) {
      const menus = manifest().contributes.menus
      assert.ok(menus["ntwine.editor"]!.some((entry) => entry.command === "ntwine.addProblems"))
      assert.ok(menus["terminal/context"]!.some((entry) => entry.command === "ntwine.addTerminalOutput"))
      const editor = await openSample()
      const problems = vscode.languages.createDiagnosticCollection("ntwine-e2e-extras")
      try {
        const error = new vscode.Diagnostic(new vscode.Range(3, 4, 3, 9), "Cannot find name 'totals'.", vscode.DiagnosticSeverity.Error)
        error.source = "ts"
        error.code = 2304
        const warning = new vscode.Diagnostic(new vscode.Range(1, 6, 1, 11), "'total' is never reassigned.", vscode.DiagnosticSeverity.Warning)
        problems.set(editor.document.uri, [warning, error])
        await until("the counts told", async () => {
          const told = (await pageReceived("ntwine:editor-extras")).at(-1) as { problems?: unknown } | undefined
          return isDeepStrictEqual(told?.problems, { label: "src/sample.ts", errors: 1, warnings: 1, infos: 0 })
        })
        const text = "Problems in src/sample.ts: 1 error, 1 warning\n4:5 error Cannot find name 'totals'. ts(2304)\n2:7 warning 'total' is never reassigned."
        const from = await received()
        await pagePosts({ type: "ntwine:add-context", what: "problems" })
        await until("the problems composed", async () => (await pageReceived("ntwine:compose", from)).length === 1)
        const [compose] = await pageReceived("ntwine:compose", from)
        assert.deepEqual(compose!.item, { path: "problems", text, projectId: project.id, app: vscode.env.appName })
        // The palette's command lands the same chip.
        const composed = await vscode.commands.executeCommand<EditorComposed | undefined>("ntwine.addProblems")
        assert.equal(composed?.ok, true)
      } finally {
        problems.dispose()
      }
      await until("no problems told", () => api.editorExtras()?.problems === undefined)

      const clipboard = "the human's own clipboard"
      await vscode.env.clipboard.writeText(clipboard)
      const terminal = vscode.window.createTerminal({ name: "ntwine e2e last command", shellPath: "/bin/bash" })
      // Not `in vscode.window`: before 1.93 the name is there, as a proposal whose getter throws.
      const [major, minor] = vscode.version.split(".").map(Number) as [number, number]
      const executions = major > 1 || minor >= 93
      try {
        terminal.show()
        await terminal.processId
        let item: { path: string; text: string } | undefined
        if (executions) {
          // VS Code 1.93+: shell integration hands each command over as it runs, with its output.
          const integrated = terminal as vscode.Terminal & { shellIntegration?: { executeCommand(command: string): unknown } }
          await until("shell integration", () => integrated.shellIntegration !== undefined, 30_000)
          integrated.shellIntegration!.executeCommand("echo ntwine-last-command")
          await until("the command told", () => api.editorExtras()?.terminal?.command === "echo ntwine-last-command" && api.editorExtras()?.terminal?.exitCode === 0, 30_000)
          const from = await received()
          await pagePosts({ type: "ntwine:add-context", what: "terminal" })
          await until("the command composed", async () => (await pageReceived("ntwine:compose", from)).length === 1)
          item = (await pageReceived("ntwine:compose", from))[0]!.item as { path: string; text: string }
          assert.deepEqual(item, { path: "terminal", text: "$ echo ntwine-last-command\nntwine-last-command\n(exit code 0)", projectId: project.id, app: vscode.env.appName })
        } else {
          // Before 1.93 there is no such API: the terminal's own Copy Last Command and Copy Last Command
          // Output, through a borrowed clipboard. The menu offers the entry while a terminal is open; adding
          // is retried until shell integration has seen the command.
          await until("the page told a terminal is open", async () => (await pageReceived("ntwine:editor-extras")).some((told) => "terminal" in told), 30_000)
          terminal.sendText("echo ntwine-last-command")
          let from = 0
          await until("the command added", async () => {
            from = await received()
            return (await vscode.commands.executeCommand<EditorComposed | undefined>("ntwine.addTerminalOutput"))?.ok === true
          }, 30_000)
          item = (await pageReceived("ntwine:compose", from))[0]!.item as { path: string; text: string }
          assert.equal(item.path, "terminal")
          assert.match(item.text, /^\$ echo ntwine-last-command\nntwine-last-command/u)
        }
        assert.equal(await vscode.env.clipboard.readText(), clipboard, "the clipboard is as the human left it")
      } finally {
        terminal.dispose()
        await vscode.commands.executeCommand("notifications.clearAll")
      }
    },
  },
  {
    name: "a thread opens in an editor tab beside the code, on its own address; asked again it comes forward; Ctrl+L goes to the ntwine used last and back",
    modes: ["fake"],
    async run({ api, project }) {
      // The title row's ⋯ offers it while the sidebar shows a thread, first in the menu.
      assert.deepEqual(manifest().contributes.menus["view/title"]!.find((entry) => entry.command === "ntwine.openThreadInTab"), {
        command: "ntwine.openThreadInTab", when: "view == ntwine.sidebar && ntwine.sidebarView == thread", group: "ntwine@0",
      })
      const path = `/all/${project.slug}/thread/fake-thread`
      const inTab = async (type: string, from = 0) => (await fakeLog()).page.received.slice(from).filter((entry) => entry.page === path && entry.data.type === type).map((entry) => entry.data)
      const editor = await openSample([1, 0, 2])
      const loadsBefore = (await fakeLog()).page.loads.length
      try {
        await vscode.commands.executeCommand("ntwine.openThreadInTab", { thread: "fake-thread", project: project.slug })
        await until("the tab's page ready", () => api.threadTabs()[0]?.ready === true, 30_000)
        const [tab] = api.threadTabs()
        assert.equal(api.threadTabs().length, 1)
        assert.equal(tab!.url, `${control}${path}${embedQuery(project)}`, "the thread's own address, in embed mode, on this window's project")
        assert.deepEqual((await fakeLog()).page.loads.slice(loadsBefore), [`${path}${embedQuery(project)}`])
        assert.equal(tab!.viewColumn, 2, "beside the code")
        assert.ok(vscode.window.visibleTextEditors.some((visible) => visible.document.uri.fsPath === sample), "the code still in sight")
        assert.equal(tab!.title, "fake-thread", "named by the thread until its page says its title")
        // The tab's page is told what the sidebar's is: the theme, the host's state, the editor's context.
        await until("the editor's context in the tab", async () => (await inTab("ntwine:editor-context")).some((told) => (told.active as { path?: string } | null)?.path === sample), 10_000)
        assert.ok((await inTab("ntwine:theme")).length > 0 && (await inTab("ntwine:host-state")).length > 0)

        // Its page names the thread: the tab takes its title, as the page wrote it (not re-cased).
        await fake("/__e2e/page-post", { page: path, message: { type: "ntwine:route", view: "thread", title: "Fake thread, wider", href: `${control}${path}` } })
        await until("the tab titled by its page", () => api.threadTabs()[0]?.title === "Fake thread, wider")

        // Asked again: the same tab, forward, no second load.
        await vscode.window.showTextDocument(editor.document, { viewColumn: vscode.ViewColumn.One })
        await vscode.commands.executeCommand("ntwine.openThreadInTab", { thread: "fake-thread", project: project.slug })
        await until("the tab forward", () => api.threadTabs()[0]?.active === true)
        assert.equal(api.threadTabs().length, 1, "one tab per thread")
        assert.equal((await fakeLog()).page.loads.length, loadsBefore + 1, "not framed again")

        // The tab was used last (its page took the keyboard): Ctrl+L in the editor puts the selection in IT.
        const mod = process.platform === "darwin" ? "meta" : "ctrl"
        await sleep(500)
        const shown = await vscode.window.showTextDocument(editor.document, { viewColumn: vscode.ViewColumn.One, preserveFocus: false })
        shown.selection = new vscode.Selection(1, 0, 2, shown.document.lineAt(2).text.length)
        await sleep(500)
        let from = (await fakeLog()).page.received.length
        await press(`${mod}+l`)
        await until("Ctrl+L's chip in the tab", async () => (await inTab("ntwine:compose", from)).length > 0, 15_000)
        const [compose] = await inTab("ntwine:compose", from)
        assert.deepEqual({ ...compose, id: undefined }, {
          type: "ntwine:compose", id: undefined, target: "front", focus: true,
          item: { projectId: project.id, path: sample, text: sampleLines(shown.document, 2, 3), startLine: 2, endLine: 3, app: vscode.env.appName },
        })
        assert.equal((await fakeLog()).page.received.slice(from).filter((entry) => entry.page === "/" && entry.data.type === "ntwine:compose").length, 0, "not the sidebar")
        await until("the tab in front with the keyboard", () => api.threadTabs()[0]?.active === true)

        // Ctrl+L pressed in the tab: back to the code, not the tab's own group.
        await fake("/__e2e/page-post", { page: path, message: { type: "ntwine:key", key: "l", code: "KeyL", ctrl: process.platform !== "darwin", meta: process.platform === "darwin", shift: false, alt: false } })
        await until("the code focused", async () => vscode.window.activeTextEditor?.document.uri.fsPath === sample && (await focusIn()) === "editor")

        // The sidebar used since: Ctrl+L goes there again.
        await vscode.commands.executeCommand("ntwine.sidebar.focus")
        await until("the sidebar focused", async () => (await focusIn()) === "sidebar")
        await sleep(300)
        await vscode.window.showTextDocument(editor.document, { viewColumn: vscode.ViewColumn.One, preserveFocus: false })
        await sleep(500)
        from = (await fakeLog()).page.received.length
        await press(`${mod}+l`)
        await until("Ctrl+L's chip in the sidebar", async () => (await fakeLog()).page.received.slice(from).some((entry) => entry.page === "/" && entry.data.type === "ntwine:compose"), 15_000)
        assert.deepEqual(await inTab("ntwine:compose", from), [], "not the tab")
        await fake("/__e2e/shot", { path: join(process.env.NTWINE_E2E_SHOTS || workspace, `${vscode.version}-thread-tab.png`) })
      } finally {
        await vscode.commands.executeCommand("workbench.action.closeAllEditors")
      }
      await until("the tab closed", () => api.threadTabs().length === 0)
    },
  },
  {
    name: "ntwine on a new port re-frames the sidebar there; a page that never loads offers Reload; no ntwine at all says so",
    modes: ["fake"],
    async run({ api, project }) {
      const ntwine = vscode.workspace.getConfiguration("ntwine")
      try {
        await ntwine.update("serverUrl", elsewhere, vscode.ConfigurationTarget.Global)
        await until("the frame on the new port, ready", () => api.sidebar().url === `${elsewhere}/${embedQuery(project)}` && api.sidebar().ready, 30_000)
        assert.deepEqual((await fakeLog(elsewhere)).page.loads, [`/${embedQuery(project)}`])
        assert.equal(api.sidebar().hinted, false)

        // The setting is taken at its word, so the frame goes to port 1, where nothing listens; its
        // page never says it is ready, and the view offers Reload and Open in browser over it.
        await ntwine.update("serverUrl", "http://127.0.0.1:1", vscode.ConfigurationTarget.Global)
        await until("the frame on port 1", () => api.sidebar().url === `http://127.0.0.1:1/${embedQuery(project)}`)
        assert.equal(api.sidebar().ready, false)
        // The view waits 20s for a page to say it is ready (src/sidebar.ts READY_HINT_MS; 10s until an ntwine
        // run from source took 13s and 42s to load on a busy machine), so the hint comes after that.
        await until("the hint", () => api.sidebar().hinted, 30_000)

        // No address at all: discovery finds nothing. The page that was showing stays until Reload, which
        // then says why there is nothing to show.
        await ntwine.update("serverUrl", "not an address", vscode.ConfigurationTarget.Global)
        await until("offline", () => api.status().kind === "offline")
        await new Promise((resolve) => setTimeout(resolve, 500))
        assert.equal(api.sidebar().url, `http://127.0.0.1:1/${embedQuery(project)}`)
        await vscode.commands.executeCommand("ntwine.sidebar.reload")
        // Reload looks again first ("Looking for ntwine…"), then says what it found.
        await until("a message instead of the page", () => api.sidebar().url === undefined && api.sidebar().message === "ntwine isn't running.")
      } finally {
        await ntwine.update("serverUrl", control, vscode.ConfigurationTarget.Global)
      }
      await until("the frame back on the first ntwine, ready", () => api.sidebar().url === `${control}/${embedQuery(project)}` && api.sidebar().ready, 30_000)
      assert.equal(api.sidebar().hinted, false)
    },
  },
]

class Skipped extends Error {}
function skip(why: string): never {
  throw new Skipped(why)
}

export async function run(): Promise<void> {
  console.log(`ntwine e2e: ${mode} mode, workspace ${workspace}, ${vscode.env.appName} ${vscode.version}`)
  const extension = vscode.extensions.getExtension<NtwineExtensionApi>("ssalbdivad.ntwine-vscode")
  assert.ok(extension, "the extension under development is installed")
  const api = await extension.activate()
  await until("the connection to ntwine", () => api.status().kind === "connected", 30_000)
  const origin = api.origin()!
  await until("the projects push", () => api.projects().length > 0)
  const project = projectForPath(workspace, api.projects())?.project
  assert.ok(project, `a project holds ${workspace}: ${JSON.stringify(api.projects())}`)
  const rpc = new NtwineRpc(origin)

  // REAL mode: file links reach an editor only when ntwine's Local file links setting is VS Code.
  let restoreSettings: (() => Promise<unknown>) | undefined
  if (mode === "real" && process.env.NTWINE_E2E_SET_OPENER === "1") {
    const settings = await rpc.query(project.id, "settingsGet")
    await rpc.mutation(project.id, "settingsSet", { ...settings, localFileOpener: "vscode" })
    restoreSettings = () => rpc.mutation(project.id, "settingsSet", settings)
  }

  const failures: string[] = []
  try {
    // NTWINE_E2E_ONLY=<part of a step's name>[|<another>…] runs just those steps; the sidebar steps lean on a sidebar the
    // earlier ones opened, so it is opened for them first.
    const only = process.env.NTWINE_E2E_ONLY
    if (only && mode === "fake") {
      await vscode.commands.executeCommand("ntwine.sidebar.focus")
      await until("the sidebar's page ready", () => api.sidebar().ready, 30_000)
    }
    for (const step of steps) {
      if (!step.modes.includes(mode)) continue
      if (only && !only.split("|").some((part) => step.name.includes(part))) continue
      try {
        await step.run({ api, project, rpc })
        console.log(`  ✔ ${step.name}`)
      } catch (error) {
        if (error instanceof Skipped) {
          console.log(`  - ${step.name} (skipped: ${error.message})`)
          continue
        }
        failures.push(step.name)
        console.log(`  ✖ ${step.name}\n${(error as Error).stack ?? error}`)
      }
    }
  } finally {
    await restoreSettings?.()
  }
  if (failures.length) throw new Error(`${failures.length} end-to-end step(s) failed: ${failures.join("; ")}`)
}
