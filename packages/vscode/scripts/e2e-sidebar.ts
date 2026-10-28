// THE SIDEBAR, END TO END, AS THE HUMAN USES IT — a real VS Code (under Xvfb), the extension as its .vsix
// ships, a real disposable two-project ntwine, and the REAL ntwine page framed in the sidebar. Every seam is
// exercised the way a person crosses it: keys and clicks are trusted input on the workbench (Chromium
// routes them through the webview into the page's frame), and what is asserted is read where it shows —
// the page's own DOM, VS Code's own title row and editor, the simulated worker's socket.
//
//   node packages/vscode/scripts/e2e-sidebar.ts [--out=<dir>] [--dev] [--only=c1,c4] [--icon-before=<png>] [--worktree]
//   (or: node packages/vscode/scripts/e2e.ts --sidebar [same flags])
//
//   --out    where the screenshots and results.json go (default: a `shots` dir in the run's scratch folder,
//            kept). Names are `<vscode version>-<what>.png`; `-window` is the whole window at 1x, the
//            rest are 2x renders of the sidebar (or of the part named).
//   --dev    run the extension from the source tree (dist/ as scripts/build.ts makes it) instead of the
//            packaged .vsix. The default is the .vsix, unpacked, because the maintainer's "the icon
//            doesn't display" was a package with no icon in it: the source tree had it all along.
//   --only   run only these checks (c1…c24); the boot, the seed and the view opening always run.
//   --icon-before=<png>   an earlier top-dark activity-bar strip (1x enlarged 6x, as c1 writes it) to set
//            beside this run's, for the eye.
//   --worktree  open the window on a thread's git worktree (`.ntwine/worktrees/<slug>` of the workspace)
//            instead of the workspace, for c12's positive half; runs c12 alone unless --only says more,
//            because every other check is written against a window on the workspace itself.
//   NTWINE_E2E_VSCODE=oldest|<version>   VS Code to run (default: stable). `oldest` is the manifest's floor.
//   NTWINE_E2E_KEEP=1                    keep the scratch folder (logs, the stack's log) even on a pass.
//
// THE CHECKS (each one PASS/FAIL with its evidence in results.json, and a screenshot where it is visible):
//   c1 the ntwine icon in the activity bar, side and top, dark and light: its mask file loads, and its ink
//      is a line drawing the weight of the codicons beside it (within the bar's own spread of their mean)
//      — not a blank, not a solid square
//   c2 the view frames the real page, which says ntwine:ready and draws no header and no lone ⌨ row; VS
//      Code's title row reads ntwine, its buttons follow the page's view, the badge's tooltip carries the
//      counts, and each button, clicked, does its thing in the page
//   c3 the context bar follows the editor: a selection, no selection, another editor, the open files
//   c4 Ctrl+L (Cursor's chord, the one the page names) in the editor: the sidebar revealed, the chip a pill
//      in the front composer, the caret after it, typing after it; sent to a thread with a simulated
//      worker, the context serialized and the transcript showing the chip; the context bar's click does the
//      same; Alt+K with only a caret adds the whole file; Ctrl+L pressed in the reply box goes back to the
//      editor, and Ctrl+L in the editor with nothing selected reveals the sidebar with the caret in the box
//   c5 "Ask ntwine to fix" on a real TypeScript error: chip + the problem as a note
//   c6 a code-file link opens in the editor at its range; a web link goes to openExternal (a stub
//      xdg-open, no browser); a Markdown link opens ntwine's reader
//   c7 a VS Code theme switch re-themes the page live
//   c8 keys with the frame focused: Ctrl+Shift+P is VS Code's palette, Ctrl+K ntwine's, `?` the shortcuts
//      sheet with its Editor group (Ctrl+L both ways first) and its VS Code group, the title row's ⋯
//      Keyboard shortcuts opening the same sheet, Ctrl+1 back to the editor
//   c9 the gallery: queue (dark, light), a thread with a selection and a chip, the open-files menu,
//      Settings, the shortcuts sheet — at ~300px and ~450px; Settings over a thread on top, with the
//      keyboard, its own Escape and its own clicks
//   c10 one switch: the bar's eye, clicked, turns `ntwine.shareEditorState` off — the worker's real `editor`
//      tool (ntwine-mcp.mjs) then reads nothing and a send carries no block; the setting turned back on in
//      VS Code turns the eye on, the tool reads the selection, a send quotes it, and the next send of the
//      same selection names it instead of quoting it again
//   c11 Claude Code: a stand-in extension with its id (anthropic.claude-code) and its Alt+K, installed
//      live — Alt+K is then its (its binding answers, nothing reaches ntwine) and the `?` sheet drops the
//      row; uninstalled, Alt+K is ntwine's again
//   c12 the window's own thread: a window opened on a thread's worktree opens the sidebar on that thread
//      (--worktree); a window on the project itself opens on the queue (every other run, the control)
//   c13 `@` in a prompt box offers the workspace's files as git and VS Code list them (a gitignored copy
//      left out); Enter writes the whole-file reference where the `@` was
//   c14 a file dragged from VS Code's explorer onto a prompt box, Shift held, lands as the same reference
//      (the ntwine view moved into the Explorer's side bar so both are in sight). The drag is VS Code's
//      own, started by a real press on the explorer's row and intercepted with its data; DevTools cannot
//      route the drop into the webview's out-of-process frame, so the drop is dispatched, trusted, to the
//      page's own frame. results.json's `explorerDrop` says which path landed it (synthesized is the
//      last resort)
//   c15 the context bar's chevron menu offers the file's problems (a real TypeScript error) and the
//      terminal's last command (run through shell integration), each adding one chip
//   c16 a thread that enters the queue needing the human while the sidebar is out of sight (snoozed, then
//      woken, through the REAL server's needs-you edge) is a VS Code notification, and its Open shows the
//      thread in the sidebar
//   c18 the editor's colours (ntwine.matchEditorTheme): through Dark Modern, Light Modern, Tomorrow Night
//      Blue, Solarized Dark, Abyss and both High Contrasts, the page follows live, its painted background
//      is the side bar's pixel for pixel (sampled from the screenshot, beside the side bar's title row),
//      and its text, secondary text and accent read; the setting off puts ntwine's palette back, on again
//      the theme's. Shots of the side bar beside the editor: the queue, a thread with the reply box
//      focused and a selection in the bar, the open-files menu. (Runs before c17, which ends the editor.)
//   c19 the selection hint: lines selected by keys get `Ctrl+L to add to ntwine` after their last line, in
//      the colour of VS Code's own inline blame, once the selection settles; gone when it empties, once Ctrl+L has
//      added it, and with `ntwine.selectionHint` off. A 6x crop of the line for the eye
//   c20 a thread in an editor tab: the title row's ⋯ (while the sidebar shows a thread) opens it beside the
//      code, on the thread at the editor's width, titled by the page; its reply box sends to the simulated
//      worker with the editor block; Ctrl+L in the editor then lands in the tab (the ntwine used last), and
//      Ctrl+L in the tab goes back to the code; asked again, the same tab
//   c21 the bar's × (pointed at, the reading's glyph): this selection left out of a send while the eye
//      stays on and the agents' tool still reads it; a new selection goes again and is quoted
//   c22 an image on the OS clipboard (xclip under the run's Xvfb, fetched with apt if missing), Ctrl+V in
//      the reply box: attached as in a browser tab, a tile with the picture, its path sent to the worker —
//      after a control where a TEXT clipboard pastes text and attaches nothing
//   c23 a file dropped from the OS: VS Code's routing of an external file drag measured on the workbench
//      (a plain drag turns the webview's pointer events off, Shift keeps them on; `osDropRouting` records
//      them), and the drop itself, trusted and carrying the file from disk, dispatched to the page's frame
//      (DevTools cannot route a drop into the out-of-process frame, as c14 says), attaches it
//   c24 a page that reloaded into an error page (a reload that landed while ntwine was down): the sidebar
//      stops calling it ready, the title row stops claiming its view, and the view frames the page again
//      on its own, ready, on the queue
//   c17 a restart and a window reload (last: the test runner's VS Code ends with a reload, so the same
//      profile is reopened by a VS Code of the harness's own): the framed page's localStorage survives
//      both, and so does the eye, which is the VS Code setting
//
// NEVER ON THE REAL DISPLAY. On Linux the run re-executes itself under `xvfb-run -a` with DISPLAY and
// WAYLAND_DISPLAY removed (DISPLAY=:0 here is the maintainer's screen through WSLg). The editor gets its
// own user-data and extensions directories; every opener anything could spawn — the server's and VS Code's
// own `xdg-open` — is a stub on PATH that only writes down what it was asked. No agent is ever started:
// the one thread a message is sent to has a simulated worker (e2e/fake-broker.ts). Everything is torn
// down by process group, exact pid, the sandbox HOME and the run's own user-data dir, pass or fail, and
// the run fails if anything survives.

import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { homedir, tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron"
import puppeteer, { type Browser, type CDPSession, type ElementHandle, type Frame, type Page } from "puppeteer"
import { parseSentContext, parseSentEditorContext } from "../../web/src/lib/composerContext.ts"
import type { AgentOp, AgentStatus, EditorState, SettingState } from "../e2e/sidebar-agent.ts"
import { decodePng, inkOf } from "../e2e/png.ts"
import { SAMPLE, seedSidebarStack, seedWorktreeThread, type Seeded } from "../e2e/sidebar-seed.ts"
import { bootStack, freePort, killAll, leftovers, stubbedPath, type Stack } from "../e2e/stack.ts"
import { workerTool } from "../e2e/worker-tool.ts"
import { hasShellExecutions } from "../src/extras-feed.ts"
import { NtwineRpc } from "../src/rpc.ts"

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repo = resolve(pkg, "..", "..")


if (process.platform === "linux" && process.env.NTWINE_E2E_UNDER_XVFB !== "1") {
  const env: NodeJS.ProcessEnv = { ...process.env, NTWINE_E2E_UNDER_XVFB: "1" }
  delete env.DISPLAY
  delete env.WAYLAND_DISPLAY
  const child = spawnSync("xvfb-run", ["-a", "-s", "-screen 0 1920x1200x24", process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit", env })
  if (child.error) {
    console.error(`xvfb-run could not start (${child.error.message}). Install it (apt install xvfb); this harness never uses the real display.`)
    process.exit(1)
  }
  process.exit(child.status ?? 1)
}
if (process.platform === "linux" && (!process.env.DISPLAY || process.env.DISPLAY === ":0" || process.env.WAYLAND_DISPLAY)) {
  console.error(`refusing to run on DISPLAY=${process.env.DISPLAY} / WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY}: that is a real screen`)
  process.exit(1)
}

const flag = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const devMode = process.argv.includes("--dev")
const worktreeWindow = process.argv.includes("--worktree")
const only = flag("only")?.split(",").map((id) => id.trim()) ?? (worktreeWindow ? ["c12"] : undefined)
const wanted = (id: string) => !only || only.includes(id)

function vscodeVersion(): string {
  const asked = process.env.NTWINE_E2E_VSCODE ?? "stable"
  if (asked !== "oldest") return asked
  const engines = (JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as { engines: { vscode: string } }).engines.vscode
  return engines.replace(/^[\^~>=]+/u, "")
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-vscode-sidebar-e2e-")))
const out = resolve(flag("out") ?? join(scratch, "shots"))
mkdirSync(out, { recursive: true })
const log = (line: string) => console.log(`ntwine sidebar e2e: ${line}`)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ── results ───────────────────────────────────────────────────────────────────────────────────────────

interface Result {
  check: string
  name: string
  ok: boolean
  detail?: unknown
}
const results: Result[] = []
/** Observations that are not pass/fail — timings, what a surface read, what looked off. */
const notes: Record<string, unknown> = {}
const shots: string[] = []

function expect(check: string, name: string, ok: boolean, detail?: unknown): boolean {
  results.push({ check, name, ok, ...(detail === undefined ? {} : { detail }) })
  console.log(`  ${ok ? "PASS" : "FAIL"} ${check} ${name}${detail === undefined ? "" : `  ${JSON.stringify(detail).slice(0, 400)}`}`)
  return ok
}

async function waitFor<T>(what: string, probe: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await Promise.resolve(probe()).catch(() => undefined)
    if (value !== undefined && value !== null && value !== false) return value as T
    if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms waiting for ${what}`)
    await sleep(100)
  }
}

/** True once `probe` holds, false at the deadline — for a step that records the miss rather than stopping. */
async function until(probe: () => boolean | Promise<boolean>, ms = 10_000): Promise<boolean> {
  return waitFor("", async () => (await probe()) || undefined, ms).then(() => true, () => false)
}

// ── teardown ──────────────────────────────────────────────────────────────────────────────────────────

let stack: Stack | undefined
let stackTeardown: (() => Promise<void>) | undefined
let seeded: Seeded | undefined
let browser: Browser | undefined
let warmBrowser: Browser | undefined
let suite: Promise<number> | undefined
let agentServer: ReturnType<typeof createServer> | undefined
let finishAgent: (() => void) | undefined
let tornDown = false
const userData = join(scratch, "user-data")

/** VS Code processes of this run: every one carries its user-data dir on its command line. */
const editors = () => leftovers(`/nonexistent-home-${process.pid}`, userData)

async function teardown(): Promise<string[]> {
  if (tornDown) return []
  tornDown = true
  const survivors: string[] = []
  await browser?.disconnect().catch(() => undefined)
  await warmBrowser?.close().catch(() => undefined)
  finishAgent?.()
  if (suite) await Promise.race([suite, sleep(30_000)])
  const editorsLeft = await killAll(editors)
  if (editorsLeft.length) survivors.push(`VS Code: ${editorsLeft.join(", ")}`)
  agentServer?.close()
  if (seeded && seeded.broker.exitCode === null && seeded.broker.signalCode === null) seeded.broker.kill("SIGTERM")
  const home = stack?.info.home
  await stackTeardown?.()
  if (home) {
    const strays = leftovers(home)
    if (strays.length) survivors.push(`sandbox HOME: ${strays.join(", ")}`)
  }
  log(survivors.length ? `STILL RUNNING after teardown: ${survivors.join("; ")}` : "torn down: no VS Code of this run, no stack, nothing with its HOME")
  return survivors
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log(`${signal}: tearing down`)
    void teardown().finally(() => process.exit(130))
  })
}

// ── the editor's half: an agent inside VS Code that runs what it is asked (e2e/sidebar-agent.ts) ─────────

let agentSeq = 0
const agentQueue: { seq: number; op: AgentOp }[] = []
const agentAnswers = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
let agentWaiting: { after: number; res: ServerResponse; timer: NodeJS.Timeout } | undefined
let agentSeen: () => void = () => undefined
const agentUp = new Promise<void>((resolve) => (agentSeen = resolve))

function flushAgent(): void {
  if (!agentWaiting) return
  const next = agentQueue.find((entry) => entry.seq > agentWaiting!.after)
  if (!next) return
  clearTimeout(agentWaiting.timer)
  agentWaiting.res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(next))
  agentWaiting = undefined
}

async function body(req: IncomingMessage): Promise<string> {
  let text = ""
  for await (const chunk of req) text += chunk
  return text
}

async function startAgentServer(): Promise<string> {
  agentServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (req.method === "GET" && url.pathname === "/next") {
      agentSeen()
      if (agentWaiting) agentWaiting.res.writeHead(204).end()
      agentWaiting = { after: Number(url.searchParams.get("after") ?? 0), res, timer: setTimeout(() => {
        if (agentWaiting?.res === res) agentWaiting = undefined
        res.writeHead(204).end()
      }, 20_000) }
      flushAgent()
      return
    }
    if (req.method === "POST" && url.pathname === "/answer") {
      void body(req).then((text) => {
        const answer = JSON.parse(text) as { seq: number; ok: boolean; value?: unknown; error?: string }
        const waiter = agentAnswers.get(answer.seq)
        agentAnswers.delete(answer.seq)
        if (answer.ok) waiter?.resolve(answer.value)
        else waiter?.reject(new Error(answer.error))
        res.writeHead(204).end()
      })
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => agentServer!.listen(0, "127.0.0.1", resolve))
  return `http://127.0.0.1:${(agentServer.address() as { port: number }).port}`
}

function agent<T = unknown>(op: AgentOp, ms = 60_000): Promise<T> {
  const seq = ++agentSeq
  agentQueue.push({ seq, op })
  flushAgent()
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      agentAnswers.delete(seq)
      reject(new Error(`the editor did not answer ${op.op} within ${ms / 1000}s`))
    }, ms)
    agentAnswers.set(seq, {
      resolve: (value) => {
        clearTimeout(timer)
        resolve(value as T)
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      },
    })
  })
}
const status = () => agent<AgentStatus>({ op: "status" })
const command = (id: string, ...args: unknown[]) => agent({ op: "command", id, args })
const editorState = () => agent<EditorState>({ op: "editor" })

// ── the workbench and the page in its sidebar ─────────────────────────────────────────────────────────

let page!: Page
let cdp!: CDPSession
let origin = ""
let version = ""
const pageErrors: string[] = []
/** VS Code's keybinding dispatch log (workbench.action.toggleKeybindingsLog), while it is on. */

/**
 * Frames of ntwine's page in a thread's editor tab (c20), never the sidebar's: the tab frames the same
 * thread's address the sidebar's page shows by then, so only the frame object tells the two apart.
 */
const tabFrames = new Set<Frame>()
const ntwineFrame = (): Frame | undefined => page.frames().find((frame) => frame.url().startsWith(`${origin}/`) && !tabFrames.has(frame) && !frame.detached)
const frame = () => waitFor("the ntwine frame in the sidebar", ntwineFrame, 30_000)

/** Evaluate in the ntwine page. */
async function inPage<T, A extends unknown[]>(fn: (...args: A) => T, ...args: A): Promise<Awaited<T>> {
  return (await frame()).evaluate(fn as never, ...(args as unknown as never[])) as Promise<Awaited<T>>
}

/** Evaluate in the workbench. */
const inWorkbench = <T>(fn: () => T) => page.evaluate(fn) as Promise<Awaited<T>>

/** A trusted click at an element's centre, in the frame or the workbench. */
async function clickHandle(handle: ElementHandle | null, what: string): Promise<void> {
  if (!handle) throw new Error(`${what}: not there`)
  await handle.evaluate((element) => (element as Element).scrollIntoView({ block: "nearest" }))
  const box = await handle.boundingBox()
  if (!box) throw new Error(`${what}: not visible`)
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  // What the WORKBENCH has under the point, for a click that never arrives where it was aimed: the webview's
  // iframe when it is in place, and what holds the workbench's focus as the click goes in.
  const under = await page.evaluate((px, py) => {
    const el = document.elementFromPoint(px, py) as HTMLElement | null
    return { hit: el ? `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 50)}` : null, pointerEvents: el ? getComputedStyle(el).pointerEvents : null, active: `${document.activeElement?.tagName.toLowerCase()}.${String((document.activeElement as HTMLElement | null)?.className ?? "").slice(0, 40)}` }
  }, x, y).catch(() => null)
  clicks.push({ at: Date.now(), what, x: Math.round(x), y: Math.round(y), ...under })
  if (clicks.length > 12) clicks.shift()
  // The pointer goes there first, as a human's does, and the press goes only once the browser routes the
  // pointer INTO the page there (see routeIntoWebview); one the workbench still gets is said as that, here,
  // rather than as a check's "nothing happened" three steps later.
  const overWebview = under?.hit?.startsWith("iframe.webview") === true
  if (overWebview) await routeIntoWebview(x, y, what)
  await page.mouse.click(x, y)
  if (!overWebview) return
  const misrouted = await misroutedSince()
  if (misrouted) {
    ;((notes.misroutedPresses ??= []) as unknown[]).push({ what, at: misrouted })
    throw new Error(`${what}: the press went to the workbench's webview element, not into the page — the browser's routing to the webview's frames is stale (see routeIntoWebview)`)
  }
}

/**
 * STALE ROUTING INTO THE WEBVIEW — a pointer event over the sidebar that the WORKBENCH receives, aimed at
 * the `iframe.webview` element itself, never reaches the page: the browser hit-tested the webview's nested
 * out-of-process frames from stale data and handed the event to their parent. The press's default action
 * then focuses the webview, so a click reads as "focus moved to the sidebar and nothing happened".
 *
 * DevTools screenshots cause it. A capture with a clip runs under a temporary device emulation, and
 * restoring it leaves that hit-testing stale. Driven in real VS Code 1.140 (2026-10-02, the thread's
 * first-click.md): c15's 6x capture of the open menu, then its item click, misrouted 6 runs of 6 — and
 * every later press with it (4 more over 5s, the webview focused by then); without that capture, or at
 * 1x, 3 of 3 passed. c10's click into the reply box right after a 2x shot misrouted once even with the
 * re-sync below. Before this was looked for, a misrouted click into a TEXT BOX still passed (the press
 * focused the webview, and the page puts its last focused box back), so it hid. Not a page bug and not
 * a human's: no human's mouse goes through DevTools emulation.
 *
 * So the pointer moves to the press's point, and the press waits until the workbench no longer gets the
 * move. Between tries, frames are re-sent their geometry: SETTING an empty device-metrics override and
 * clearing it (a bare clear is a no-op when none is set, and did not help, 1 run of 1; this did, 1 of 1).
 * Each settle that needed a retry is in results.json's `routeSettles`.
 */
async function routeIntoWebview(x: number, y: number, what: string): Promise<void> {
  const started = Date.now()
  let frames: Record<string, number> | undefined
  for (let attempt = 0; attempt < 16; attempt++) {
    await armMisrouteWatch()
    await page.mouse.move(x + (attempt % 2), y)
    await sleep(60)
    const misrouted = await misroutedSince()
    if (!misrouted) {
      if (attempt > 0) ((notes.routeSettles ??= []) as unknown[]).push({ what, tries: attempt + 1, ms: Date.now() - started, frames })
      return armMisrouteWatch()
    }
    if (attempt === 0) frames = await framesAlive()
    if (attempt % 2 === 1) await resyncFrames()
    await sleep(100)
  }
  ;((notes.routeSettles ??= []) as unknown[]).push({ what, tries: 16, ms: Date.now() - started, settled: false, frames, framesNow: await framesAlive() })
  throw new Error(`${what}: for ${Date.now() - started}ms the pointer over the sidebar went to the workbench's webview element, not into the page — the browser's routing to the webview's frames is stale (see routeIntoWebview)`)
}

/** Watch the workbench for pointer events aimed at a webview's iframe element (the stale routing above). */
const armMisrouteWatch = () =>
  page.evaluate(() => {
    const w = window as unknown as { __misrouted?: string | null; __misroutedWatch?: (event: Event) => void }
    w.__misrouted = null
    if (w.__misroutedWatch) return
    w.__misroutedWatch = (event) => {
      if ((event.target as Element | null)?.matches?.("iframe.webview")) w.__misrouted = `${event.type} ${(event as MouseEvent).clientX},${(event as MouseEvent).clientY}`
    }
    for (const type of ["pointermove", "pointerdown"]) document.addEventListener(type, w.__misroutedWatch, true)
  }).catch(() => undefined)

const misroutedSince = () => page.evaluate(() => (window as unknown as { __misrouted?: string | null }).__misrouted ?? null).catch(() => null)

/** Re-send every frame its geometry: an empty device-metrics override, set and cleared (see routeIntoWebview). */
async function resyncFrames(): Promise<void> {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 0, height: 0, deviceScaleFactor: 0, mobile: false }).catch(() => undefined)
  await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => undefined)
}
const clicks: Record<string, unknown>[] = []

async function clickInPage(selector: string, what = selector): Promise<void> {
  const handles = await (await frame()).$$(selector)
  for (const handle of handles) {
    if (await handle.boundingBox()) return clickHandle(handle, what)
  }
  throw new Error(`${what}: no visible ${selector} in the page`)
}

/** Click the first visible element in the page whose text includes `text`, among `selector`. */
async function clickTextInPage(selector: string, text: string): Promise<void> {
  const handle = (await (await frame()).evaluateHandle((s, t) => [...document.querySelectorAll(s)].find((element) => element.textContent?.includes(t) && element.getClientRects().length > 0) ?? null, selector, text)).asElement() as ElementHandle | null
  await clickHandle(handle, `${selector} with "${text}"`)
}

/**
 * Click `selector` inside the composer whose box is `surface`. The page keeps the queue's prompt box
 * mounted under an open drawer, so a bare selector can resolve to the one hidden behind it — and the
 * click then lands on whatever the drawer draws at that spot (once, the drawer's open-in-browser button).
 */
async function clickInComposer(surface: "chatComposer" | "newComposer", selector: string): Promise<void> {
  const handle = (await (await frame()).evaluateHandle((s, sel) => {
    const box = [...document.querySelectorAll(`textarea[data-surface="${s}"]`)].find((t) => t.getClientRects().length > 0)
    let scope: Element | null = box?.parentElement ?? null
    while (scope && !scope.querySelector(sel)) scope = scope.parentElement
    return scope?.querySelector(sel) ?? null
  }, surface, selector)).asElement() as ElementHandle | null
  await clickHandle(handle, `${selector} on the ${surface}`)
}

async function clickInWorkbench(selector: string): Promise<void> {
  // A view's title-row buttons show only while the pointer is over the side bar or it has focus
  // (VS Code's `workbench.view.alwaysShowHeaderActions`, off by default): the hand goes there first.
  if (selector.includes(".title-actions")) {
    const title = await rectOf(".part.sidebar .composite.title")
    if (title) {
      await page.mouse.move(title.x + 12, title.y + title.height / 2)
      await until(async () => !!(await visibleIn(selector)), 2_000)
    }
  }
  // The first VISIBLE match: VS Code re-renders a view's toolbar when its context keys change (the page's
  // view going from a thread to the queue swaps Back to queue for New thread), and for a beat the old
  // toolbar's hidden copy of a button can come first in the DOM — the click then found "not visible".
  await clickHandle((await visibleIn(selector)) ?? (await page.$(selector)), selector)
}

/** The first match of `selector` in the workbench that has a box. */
async function visibleIn(selector: string): Promise<ElementHandle | null> {
  for (const handle of await page.$$(selector)) if (await handle.boundingBox()) return handle
  return null
}

/** A chord as a keyboard presses it: `Control+Shift+KeyP`. */
async function press(chord: string): Promise<void> {
  const parts = chord.split("+")
  const key = parts.pop()!
  for (const modifier of parts) await page.keyboard.down(modifier as never)
  await page.keyboard.press(key as never)
  for (const modifier of [...parts].reverse()) await page.keyboard.up(modifier as never)
}

/** A prompt box in the page: the visible textarea of that surface, and what its backdrop shows. */
interface BoxState {
  value: string
  active: boolean
  frameFocused: boolean
  caret: number
  /** The pills the box's backdrop draws over its chips: their token and painted background. */
  pills: { token: string; background: string; ring: string }[]
}
const box = (surface: "chatComposer" | "newComposer") =>
  inPage((s) => {
    const el = [...document.querySelectorAll<HTMLTextAreaElement>(`textarea[data-surface="${s}"]`)].find((t) => t.getClientRects().length > 0)
    if (!el) return null
    let scope: HTMLElement | null = el.parentElement
    while (scope && !scope.querySelector("[data-context-token]") && scope.parentElement && !scope.matches("[data-composer-root], form")) scope = scope.parentElement
    const pills = [...(scope?.querySelectorAll<HTMLElement>("[data-context-token]") ?? [])].map((pill) => ({ token: pill.dataset.contextToken ?? "", background: getComputedStyle(pill).backgroundColor, ring: getComputedStyle(pill).boxShadow }))
    return { value: el.value, active: document.activeElement === el, frameFocused: document.hasFocus(), caret: el.selectionStart, pills }
  }, surface) as Promise<BoxState | null>

/** The context bar on a prompt box: what it reads, and in which state. */
const contextBar = (surface: "chatComposer" | "newComposer") =>
  inPage((s) => {
    const el = [...document.querySelectorAll<HTMLTextAreaElement>(`textarea[data-surface="${s}"]`)].find((t) => t.getClientRects().length > 0)
    let scope: HTMLElement | null = el?.parentElement ?? null
    while (scope && !scope.querySelector("[data-editor-context-bar]")) scope = scope.parentElement
    const bar = scope?.querySelector<HTMLElement>("[data-editor-context-bar]")
    if (!bar) return null
    const reading = bar.querySelector<HTMLElement>("[data-editor-context]")
    return {
      kind: reading?.dataset.editorContext ?? null,
      text: reading?.innerText.replace(/\s+/gu, " ").trim() ?? null,
      label: reading?.getAttribute("aria-label") ?? null,
      hint: bar.querySelector<HTMLElement>("[data-editor-context-hint]")?.innerText ?? null,
      openFiles: bar.querySelector<HTMLElement>("[data-editor-open-files]")?.getAttribute("aria-label") ?? null,
      // The control the reading sits in wears its tone (the reading's own half carries only the hover).
      color: reading ? getComputedStyle(reading.closest("[data-editor-context-control]") ?? reading).color : null,
      background: reading ? getComputedStyle(reading.closest("[data-editor-context-control]") ?? reading).backgroundColor : null,
    }
  }, surface)

const drawerOpen = async () => (await box("chatComposer")) !== null

/** The page's viewport and each enclosing document's: where a frame's layout and its box disagree. */
async function frameGeometry() {
  const out: Record<string, unknown> = {}
  for (const { name, frame } of tracedFrames()) {
    out[name] = await frame.evaluate(() => {
      const child = document.querySelector("iframe")
      const r = child?.getBoundingClientRect()
      return {
        inner: [innerWidth, innerHeight],
        client: [document.documentElement.clientWidth, document.documentElement.scrollWidth],
        scroll: [scrollX, document.documentElement.scrollLeft, document.body?.scrollLeft ?? 0],
        visual: visualViewport ? [Math.round(visualViewport.offsetLeft), Math.round(visualViewport.width), visualViewport.scale] : null,
        child: r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null,
      }
    }).catch((error) => String(error).slice(0, 80))
  }
  out.workbench = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("iframe.webview")].map((f) => { const r = f.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height), f.parentElement?.style.cssText.slice(0, 160)] }))
  return out
}

/** Every drawer layer in the page's DOM: its id, where it is drawn, and its state. */
const drawerLayers = () =>
  inPage(() => [...document.querySelectorAll<HTMLElement>("[data-drawer-layer]")].map((el) => {
    const r = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    return { id: el.dataset.drawerLayer, x: Math.round(r.x), width: Math.round(r.width), state: el.dataset.state ?? null, shown: /translate-x-0/u.test(el.className), transform: style.transform, translate: style.translate, animations: el.getAnimations().map((a) => ({ kind: a.constructor.name, property: (a as CSSTransition).transitionProperty ?? null, playState: a.playState, currentTime: a.currentTime, pending: a.pending, startTime: a.startTime, timeline: document.timeline.currentTime })), visibility: document.visibilityState }
  }))

/**
 * Whether each document from the page up is RENDERING: rAF callbacks run only in a frame whose widget is
 * shown and producing frames. ms for five frames, or -1 when none came within 1s (a hidden or stalled
 * widget: its transitions stay pending, and the browser hit-tests it from stale data).
 */
async function framesAlive(): Promise<Record<string, number>> {
  const probe = () => new Promise<number>((resolve) => {
    const t0 = performance.now()
    let n = 0
    const tick = () => (++n < 5 ? requestAnimationFrame(tick) : resolve(Math.round(performance.now() - t0)))
    requestAnimationFrame(tick)
    setTimeout(() => resolve(-1), 1_000)
  })
  const out: Record<string, number> = {}
  await Promise.all([...tracedFrames(), { name: "workbench", frame: page.mainFrame() }].map(async ({ name, frame }) => {
    out[name] = await frame.evaluate(probe).catch(() => -2)
  }))
  return out
}

/** VS Code's title row over the sidebar: what it reads and the buttons it shows. */
const titleRow = () =>
  inWorkbench(() => {
    const title = document.querySelector(".part.sidebar .composite.title")
    const label = title?.querySelector(".title-label")
    const h2 = label?.querySelector("h2")
    return {
      text: (label as HTMLElement | null)?.innerText.replace(/\s+/gu, " ").trim() ?? "",
      words: h2?.textContent ?? "",
      transform: h2 ? getComputedStyle(h2).textTransform : "",
      sidebarText: (document.querySelector(".part.sidebar") as HTMLElement | null)?.innerText.replace(/\s+/gu, " ").slice(0, 200) ?? "",
      tooltip: label?.getAttribute("title") ?? label?.querySelector("h2")?.getAttribute("title") ?? "",
      html: label?.outerHTML.slice(0, 600) ?? "",
      buttons: [...(title?.querySelectorAll<HTMLElement>(".title-actions .action-label") ?? [])].filter((a) => a.offsetWidth > 0).map((a) => a.getAttribute("aria-label") ?? "").filter((label) => !/More Actions/u.test(label)),
    }
  })

const paletteOpen = () =>
  inWorkbench(() => {
    const widget = document.querySelector<HTMLElement>(".quick-input-widget")
    return !!widget && getComputedStyle(widget).display !== "none" && widget.offsetHeight > 0
  })

/**
 * Where focus is in the workbench: the editor, the sidebar's webview, something else. A webview view's
 * iframe is not in the side bar's DOM — VS Code lays it over the view from a container of its own — so
 * "in the sidebar" is a webview iframe drawn over `.part.sidebar`; one with no box is a HIDDEN webview
 * holding the keyboard (the view is closed, its page kept alive), which no human can see or type into.
 */
const workbenchFocus = () =>
  inWorkbench(() => {
    const active = document.activeElement as HTMLElement | null
    const part = document.querySelector(".part.sidebar")?.getBoundingClientRect()
    const r = active?.getBoundingClientRect()
    const webview = active?.tagName === "IFRAME" && active.classList.contains("webview")
    const shown = !!r && r.width > 0 && r.height > 0 && getComputedStyle(active!).visibility !== "hidden"
    const overSidebar = !!part && !!r && part.width > 0 && r.left + r.width / 2 > part.left && r.left + r.width / 2 < part.right && r.top + r.height / 2 > part.top && r.top + r.height / 2 < part.bottom
    return {
      editor: !!active?.closest(".editor-group-container .monaco-editor"),
      sidebar: !!active?.closest(".part.sidebar") || (webview && shown && overSidebar),
      hiddenWebview: webview && !(shown && overSidebar),
      box: r ? [Math.round(r.width), Math.round(r.height)] : null,
      tag: active?.tagName ?? null,
      cls: active?.className?.toString().slice(0, 80) ?? null,
    }
  })

/**
 * Type into a prompt box — only if the caret is in it. In the page a bare letter is a shortcut (`d` marks
 * the thread being read done, `t` opens a terminal), so text typed after the caret was lost acts on the
 * board: a run that types blind corrupts every check after it. A lost caret is the finding; this refuses.
 */
async function typeInto(surface: "chatComposer" | "newComposer", text: string): Promise<void> {
  const state = await box(surface)
  if (!state?.active || !state.frameFocused) throw new Error(`the caret is not in the ${surface} (${JSON.stringify(state && { active: state.active, frameFocused: state.frameFocused })}); not typing into the page's shortcuts`)
  await page.keyboard.type(text, { delay: 15 })
}

/** Where the caret is a human's pause after an action: a focus taken back a beat later shows here, not at once. */
async function caretAfterPause(surface: "chatComposer" | "newComposer", ms = 1_500) {
  await sleep(ms)
  return { box: await box(surface), focus: await workbenchFocus(), pageActive: await inPage(() => ({ tag: document.activeElement?.tagName ?? null, surface: (document.activeElement as HTMLElement | null)?.dataset?.surface ?? null })) }
}

/**
 * WHO MOVED THE CARET. A trace in each document between the workbench and the page — the page, the
 * extension's relay that frames it (src/sidebar-html.ts), and VS Code's webview host around that — of
 * focusin/focusout, the window's focus and blur, and every programmatic `focus()`/`blur()` with the stack
 * that called it (the call site a report can name), each with what holds focus in that document after
 * it. The workbench is polled every 50ms for what holds focus (the editor, the sidebar's webview,
 * something else). All stamp `Date.now()`, one clock, so a step's slice of each lines up.
 */
function traceInstaller() {
  const w = window as unknown as { __focusTrace?: unknown[] }
  if (w.__focusTrace) return
  const trace: unknown[] = (w.__focusTrace = [])
  const describe = (el: EventTarget | Element | null): string => {
    if (!(el instanceof Element)) return el === null ? "null" : String((el as { constructor?: { name?: string } }).constructor?.name)
    const h = el as HTMLElement
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${h.dataset?.surface ? `[${h.dataset.surface}]` : ""}${el.getAttribute("aria-label") ? ` "${el.getAttribute("aria-label")}"` : ""}`
  }
  const push = (kind: string, el: EventTarget | null, stack?: string) =>
    trace.push({ at: Date.now(), kind, el: describe(el), active: describe(document.activeElement), hasFocus: document.hasFocus(), ...(stack ? { stack } : {}) })
  const stackOf = () => (new Error().stack ?? "").split("\n").slice(2, 8).map((line) => line.trim().replace(/(https?|vscode-webview):\/\/[^/]+/u, "")).join(" | ")
  document.addEventListener("focusin", (event) => push("focusin", event.target), true)
  document.addEventListener("focusout", (event) => push("focusout", event.target), true)
  window.addEventListener("focus", () => push("window-focus", null))
  // The messages each document receives — VS Code's host channel or ntwine's type (not the context feed,
  // which is every selection): a focus that arrives with no focus() in the page came with one of these.
  window.addEventListener("message", (event) => {
    const data = event.data as { channel?: unknown; type?: unknown; focus?: unknown } | null
    const name = typeof data?.channel === "string" ? data.channel : typeof data?.type === "string" ? data.type : null
    if (name && name !== "ntwine:editor-context") trace.push({ at: Date.now(), kind: `message ${name}${data?.focus === true ? " focus" : ""}`, active: describe(document.activeElement), hasFocus: document.hasFocus() })
  }, true)
  window.addEventListener("blur", () => push("window-blur", null))
  // The press itself, in each document it crosses: where it went, and whether a handler prevented it (read
  // after the page's own handlers, on the way back up) — a click that "does nothing" shows here whether it
  // arrived, and as what.
  for (const type of ["pointerover", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    document.addEventListener(type, (event) => push(`${type}${event.isTrusted ? "" : " (synthetic)"}`, event.target), true)
    window.addEventListener(type, (event) => {
      if (event.defaultPrevented) push(`${type} prevented`, event.target)
    })
  }
  const focus = HTMLElement.prototype.focus
  HTMLElement.prototype.focus = function (this: HTMLElement, ...args: Parameters<HTMLElement["focus"]>) {
    const stack = stackOf()
    const result = focus.apply(this, args)
    push("focus()", this, stack)
    return result
  }
  const blur = HTMLElement.prototype.blur
  HTMLElement.prototype.blur = function (this: HTMLElement) {
    const stack = stackOf()
    const result = blur.apply(this)
    push("blur()", this, stack)
    return result
  }
}

/** The documents from the page up to (not including) the workbench, named. */
function tracedFrames(): { name: string; frame: Frame }[] {
  const pageFrame = ntwineFrame()
  if (!pageFrame) return []
  const names = ["page", "relay", "webview-host", "webview-outer"]
  const out: { name: string; frame: Frame }[] = []
  for (let frame: Frame | null = pageFrame, i = 0; frame && frame !== page.mainFrame(); frame = frame.parentFrame(), i++) out.push({ name: names[i] ?? `frame${i}`, frame })
  return out
}

async function installFocusTrace(): Promise<void> {
  for (const { frame } of tracedFrames()) await frame.evaluate(traceInstaller).catch(() => undefined)
  await page.evaluate(() => {
    const w = window as unknown as { __focusTrace?: unknown[] }
    if (w.__focusTrace) return
    const trace: unknown[] = (w.__focusTrace = [])
    let last = ""
    // Who in the workbench focuses a webview's iframe, with the stack that did it.
    const nativeFocus = HTMLElement.prototype.focus
    HTMLElement.prototype.focus = function (this: HTMLElement, ...args: Parameters<HTMLElement["focus"]>) {
      if (this.tagName === "IFRAME" || this.closest?.(".webview")) trace.push({ at: Date.now(), where: `focus() ${this.tagName}.${String(this.className).slice(0, 30)}`, stack: (new Error().stack ?? "").split("\n").slice(2, 14).map((l) => l.trim().replace(/vscode-file:\/\/vscode-app\/[^ ]*\/out\//u, "")).join(" | ") })
      return nativeFocus.apply(this, args)
    }
    // A press the WORKBENCH gets is one no webview document saw: what it hit, and what was there.
    for (const type of ["pointerover", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      document.addEventListener(type, (event) => {
        const target = event.target as HTMLElement | null
        const chain: string[] = []
        for (let el: HTMLElement | null = target, i = 0; el && i < 4; el = el.parentElement, i++) chain.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}`)
        const e = event as MouseEvent
        trace.push({ at: Date.now(), where: `${type} ${chain.join(" < ")}`, x: e.clientX, y: e.clientY, active: document.activeElement?.tagName, pe: target ? getComputedStyle(target).pointerEvents : null })
      }, true)
    }
    // What VS Code does to its webviews' frames and their overlay containers: a style or class that stops
    // the frame taking a press (VS Code blocks webview frames with `pointer-events: none` during a drag).
    new MutationObserver((records) => {
      for (const record of records) {
        const el = record.target as HTMLElement
        if (!(el.tagName === "IFRAME" || el.classList?.contains("webview-overlay-content") || el.querySelector?.(":scope > iframe.webview"))) continue
        trace.push({ at: Date.now(), where: `attr ${record.attributeName} ${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}`, value: el.getAttribute(record.attributeName!)?.slice(0, 160) })
      }
    }).observe(document.body, { attributes: true, attributeFilter: ["style", "class"], subtree: true })
    setInterval(() => {
      const active = document.activeElement
      const where = !active ? "none" : active.closest(".editor-group-container .monaco-editor") ? "editor" : active.closest(".part.sidebar") ? "sidebar" : active.tagName === "IFRAME" ? `iframe(${(active as HTMLElement).className}${(active as HTMLElement).getBoundingClientRect().width > 0 ? "" : ", no box"})` : `${active.tagName.toLowerCase()}.${(active as HTMLElement).className.toString().slice(0, 40)}`
      if (where !== last) trace.push({ at: Date.now(), where })
      last = where
    }, 50)
  })
}

/** Every trace from `since` on, times relative to it, merged into one timeline. */
async function focusTraceSince(since: number) {
  const read = (frame: Frame) => frame.evaluate(() => ((window as unknown as { __focusTrace?: { at: number }[] }).__focusTrace ?? [])).catch(() => [] as { at: number }[])
  const rows: Record<string, unknown>[] = []
  for (const { name, frame } of tracedFrames()) for (const entry of await read(frame)) if (entry.at >= since) rows.push({ ...entry, at: entry.at - since, in: name })
  for (const entry of await read(page.mainFrame())) if (entry.at >= since) rows.push({ ...entry, at: entry.at - since, in: "workbench" })
  return rows.sort((a, b) => (a.at as number) - (b.at as number))
}

/** The extension's output channel, as VS Code writes it to the run's logs. */
function ntwineLog(): string {
  try {
    const found = execFileSync("find", [join(userData, "logs"), "-name", "ntwine.log"], { encoding: "utf8" }).trim().split("\n").filter(Boolean)
    return found.map((file) => readFileSync(file, "utf8")).join("\n")
  } catch {
    return ""
  }
}

/** Back to a clean queue: the title row's own command, which closes every drawer and overlay (lib/embedCommand.ts). */
async function resetPage(): Promise<void> {
  await command("ntwine.sidebar.queue")
  await until(async () => !(await drawerOpen()) && !(await inPage(() => !!document.querySelector("[data-shortcut-list], [cmdk-root], [data-settings-editor]"))), 8_000)
}

/** Open the seeded thread from its row in the page's list, with the mouse. The list names a thread by its handle. */
async function openThreadRow(): Promise<void> {
  await clickTextInPage("[data-xq-thread-row] button", seeded!.thread.handle)
  await waitFor("the thread's drawer", drawerOpen, 15_000)
}

/** Empty a prompt box the way a human does: click into it, select all, delete. */
async function clearBox(surface: "chatComposer" | "newComposer"): Promise<void> {
  const state = await box(surface)
  if (!state?.value) return
  // Already in it (a menu's Enter leaves it there): a click could land on whatever the box draws over its
  // middle, and take the caret out.
  if (!state.active || !state.frameFocused) await clickInPage(`textarea[data-surface="${surface}"]`)
  if (!(await until(async () => (await box(surface))?.active === true, 3_000))) throw new Error(`could not put the caret in the ${surface} to clear it`)
  await press("Control+KeyA")
  await press("Backspace")
  await until(async () => (await box(surface))?.value === "", 3_000)
}

// ── screenshots ───────────────────────────────────────────────────────────────────────────────────────

/** A screenshot through DevTools; the frames' geometry re-sent after it (routeIntoWebview says why). */
async function capture(file: string, clip?: { x: number; y: number; width: number; height: number }, scale = 1): Promise<Buffer> {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale } } : {}), captureBeyondViewport: false })
  await resyncFrames()
  if (process.env.NTWINE_E2E_FRAMES_AFTER_CAPTURE) ((notes.framesAfterCapture ??= []) as unknown[]).push({ file: file.split("/").pop(), ...(await framesAlive()) })
  const png = Buffer.from(data, "base64")
  if (file) {
    writeFileSync(file, png)
    shots.push(file)
  }
  return png
}

const rectOf = (selector: string) =>
  page.evaluate((s) => {
    const r = document.querySelector(s)?.getBoundingClientRect()
    return r ? { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } : null
  }, selector)

/** The sidebar at 2x, and (with `window`) the whole window at 1x. */
async function shot(name: string, options: { window?: boolean } = {}): Promise<void> {
  const rect = await rectOf(".part.sidebar")
  // The pointer rests on the side bar's left edge: over the bar, so its title-row buttons stay shown, and
  // off every control, so no tooltip or hover state is in the picture.
  if (rect) await page.mouse.move(rect.x + 2, rect.y + rect.height / 2)
  await sleep(350)
  if (rect) await capture(join(out, `${version}-${name}.png`), rect, 2)
  if (options.window) await capture(join(out, `${version}-${name}-window.png`))
}

// ── c11's stand-in ────────────────────────────────────────────────────────────────────────────────────

/** A `.vsix` with Claude Code's id (anthropic.claude-code) and its Alt+K, bound to Select All so whose Alt+K answered shows. */
const claudeCodeStandIn = join(scratch, "claude-code-stub", "claude-code-stub.vsix")
function packClaudeCodeStandIn(): void {
  const dir = dirname(claudeCodeStandIn)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "claude-code", publisher: "anthropic", version: "0.0.1", displayName: "Claude Code (e2e stand-in)",
    description: "Claude Code's id and its Alt+K, for ntwine's end-to-end run.", engines: { vscode: "^1.90.0" },
    contributes: { keybindings: [{ command: "editor.action.selectAll", key: "alt+k", mac: "alt+k", when: "editorTextFocus" }] },
  }, null, 2))
  const packed = spawnSync("pnpm", ["dlx", "@vscode/vsce@3.9.2", "package", "--no-dependencies", "--allow-missing-repository", "--skip-license", "--out", claudeCodeStandIn], { cwd: dir, stdio: "inherit" })
  if (packed.status !== 0) throw new Error("packaging the Claude Code stand-in failed")
}

// ── the run ───────────────────────────────────────────────────────────────────────────────────────────

let exitCode = 1
let survivors: string[] = []
try {
  version = vscodeVersion()

  // The extension: as it ships (the .vsix, unpacked) unless --dev. The e2e build comes after the package,
  // because scripts/build.ts empties dist/ first.
  let extensionPath = pkg
  if (!devMode) {
    const packaged = spawnSync("pnpm", ["run", "package"], { cwd: pkg, stdio: "inherit" })
    if (packaged.status !== 0) throw new Error("packaging the .vsix failed")
    const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as { name: string; version: string }
    const vsix = join(pkg, "dist", `${manifest.name}-${manifest.version}.vsix`)
    execFileSync("unzip", ["-q", vsix, "-d", join(scratch, "vsix")])
    extensionPath = join(scratch, "vsix", "extension")
    notes.vsix = { file: vsix, contents: execFileSync("unzip", ["-Z1", vsix], { encoding: "utf8" }).trim().split("\n") }
  }
  const built = spawnSync(process.execPath, ["scripts/build.ts", "--e2e"], { cwd: pkg, stdio: "inherit" })
  if (built.status !== 0) throw new Error("building the e2e bundle failed")
  // c11's stand-in for Claude Code, packed NOW: a synchronous pack once the editor is up blocks this
  // process's event loop, the agent inside VS Code cannot reach the harness for that long, and it quits.
  if (wanted("c11")) packClaudeCodeStandIn()
  log(`extension under test: ${devMode ? "the source tree" : "the packaged .vsix"} at ${extensionPath}`)

  // ── the stack, seeded ──
  stack = await bootStack({ scratch, projects: ["acme-api", "marketing-site"], log, onSpawn: (teardown) => (stackTeardown = teardown) })
  origin = stack.origin
  const workspace = stack.info.tenants.find((tenant) => tenant.slug === "marketing-site")!
  seeded = await seedSidebarStack({ stack, workspace, scratch, log })
  const files = seeded.files
  // c12: a thread working in a worktree of the workspace, and (--worktree) the window opened on it.
  const worktreeThread = worktreeWindow ? await seedWorktreeThread({ stack, workspace, log }) : undefined
  const windowFolder = worktreeThread?.dir ?? workspace.dir
  log(`stack up at ${origin}; the window's folder is ${worktreeThread ? `the worktree of ${worktreeThread.slug}` : "the tenant"} ${workspace.slug} (${windowFolder})`)

  // A cold dev server optimizes its dependencies on the first page load, which can take a minute — a
  // stall no installed ntwine has (it serves a build). One headless load first, so the sidebar's first
  // page is the one a human would get.
  warmBrowser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"], userDataDir: join(scratch, "warm-profile") })
  {
    const warm = await warmBrowser.newPage()
    await warm.goto(`${origin}/project/${workspace.slug}`, { waitUntil: "domcontentloaded", timeout: 180_000 })
    await warm.waitForSelector('textarea[data-surface="newComposer"]', { timeout: 180_000 })
    await warmBrowser.close()
    warmBrowser = undefined
  }
  log("the page has been loaded once (the dev server is warm)")

  // ── the editor ──
  const agentOrigin = await startAgentServer()
  mkdirSync(join(userData, "User"), { recursive: true })
  writeFileSync(join(userData, "User", "settings.json"), JSON.stringify({
    "ntwine.serverUrl": origin,
    "workbench.colorTheme": "Default Dark Modern",
    "workbench.startupEditor": "none",
    "workbench.activityBar.location": "default",
    "workbench.secondarySideBar.defaultVisibility": "hidden",
    "workbench.tips.enabled": false,
    "chat.disableAIFeatures": true,
    "chat.commandCenter.enabled": false,
    "window.restoreWindows": "none",
    "window.titleBarStyle": "custom",
    "security.workspace.trust.enabled": false,
    "update.mode": "none",
    "extensions.autoUpdate": false,
    "extensions.autoCheckUpdates": false,
    "extensions.ignoreRecommendations": true,
    "telemetry.telemetryLevel": "off",
    "git.enabled": false,
    "typescript.tsserver.log": "off",
  }, null, 2))
  // VS Code's own openExternal ends in `xdg-open` on Linux: the stubs come first on its PATH too.
  process.env.PATH = stubbedPath(stack.stubs)
  delete process.env.BROWSER
  const debuggingPort = await freePort()
  const vscodeExecutablePath = await downloadAndUnzipVSCode({ version, cachePath: join(homedir(), ".cache", "ntwine-vscode-e2e") })
  log(`VS Code ${version} at ${vscodeExecutablePath}, debugging port ${debuggingPort}, DISPLAY=${process.env.DISPLAY}`)
  suite = runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: extensionPath,
    extensionTestsPath: join(pkg, "dist", "e2e", "sidebar-agent.cjs"),
    launchArgs: [
      windowFolder,
      `--user-data-dir=${userData}`,
      `--extensions-dir=${join(scratch, "extensions")}`,
      "--disable-extension=GitHub.copilot",
      "--disable-extension=GitHub.copilot-chat",
      "--password-store=basic",
      "--disable-gpu",
      "--disable-telemetry",
      "--skip-welcome",
      "--skip-release-notes",
      `--remote-debugging-port=${debuggingPort}`,
    ],
    extensionTestsEnv: { NTWINE_E2E_AGENT: agentOrigin },
  }).catch((error: unknown) => {
    log(`VS Code did not run the agent: ${(error as Error).message}`)
    return 1
  })
  finishAgent = () => {
    agentQueue.push({ seq: ++agentSeq, op: { op: "done" } })
    flushAgent()
  }
  await Promise.race([agentUp, suite.then(() => Promise.reject(new Error("VS Code exited before its agent asked for anything"))), sleep(180_000).then(() => Promise.reject(new Error("VS Code's agent never asked for anything within 180s")))])
  const first = await status()
  version = first.version
  log(`the editor is up: ${first.appName} ${first.version}; ntwine connection ${first.status.kind}`)

  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${debuggingPort}`, defaultViewport: null, protocolTimeout: 180_000 })
  page = await waitFor("the workbench page", async () => (await browser!.pages()).find((candidate) => /workbench(\.esm)?\.html/u.test(candidate.url())), 60_000)
  cdp = await page.createCDPSession()
  // No window manager under Xvfb gives the window focus, and a page that thinks it is unfocused routes no keys.
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true })
  notes.window = await inWorkbench(() => ({ inner: [innerWidth, innerHeight], dpr: devicePixelRatio }))
  page.on("console", (message) => {
    const url = message.location()?.url ?? ""
    if (message.type() === "error" && url.startsWith(origin) && !/control\/status/u.test(message.text())) pageErrors.push(`${message.text()} (${url})`)
  })
  page.on("pageerror", (error) => pageErrors.push(String(error)))
  await waitFor("the extension connected to ntwine", async () => (await status()).status.kind === "connected" || undefined, 60_000)

  const run = async (id: string, title: string, fn: () => Promise<void>) => {
    if (!wanted(id)) return
    log(`── ${id}: ${title}`)
    try {
      await fn()
    } catch (error) {
      expect(id, `${title} — ran to the end`, false, (error as Error).stack?.split("\n").slice(0, 4).join(" | "))
      await shot(`${id}-failure`, { window: true }).catch(() => undefined)
    }
  }

  // ── c1: the icon ──
  await run("c1", "the ntwine icon renders in the activity bar", async () => {
    const before = flag("icon-before")
    try {
      for (const layout of [
        { location: "default", theme: "Default Dark Modern", name: "side-dark" },
        { location: "top", theme: "Default Dark Modern", name: "top-dark" },
        { location: "top", theme: "Default Light Modern", name: "top-light" },
        { location: "default", theme: "Default Light Modern", name: "side-light" },
      ]) {
        await agent({ op: "config", section: "workbench", key: "activityBar.location", value: layout.location })
        await agent({ op: "config", section: "workbench", key: "colorTheme", value: layout.theme })
        const wantLight = layout.theme.includes("Light")
        const strip = await waitFor(`the activity bar ${layout.name}`, async () => {
          const state = await inWorkbench(() => {
            const bar = [...document.querySelectorAll(".composite-bar")].find((candidate) => candidate.querySelector('.action-label[aria-label^="ntwine"]'))
            const items = bar ? [...bar.querySelectorAll<HTMLElement>(".action-item")].map((item) => item.querySelector<HTMLElement>(".action-label")).filter((label): label is HTMLElement => !!label && label.getBoundingClientRect().width > 0) : []
            const rects = items.map((label) => {
              const r = label.getBoundingClientRect()
              const cs = getComputedStyle(label)
              // The active item wears VS Code's indicator bar beside its glyph, which is not glyph ink.
              return { label: label.getAttribute("aria-label") ?? "", x: r.x, y: r.y, w: r.width, h: r.height, mask: cs.webkitMaskImage || cs.maskImage || "", active: label.closest(".action-item")?.classList.contains("checked") ?? false }
            })
            return {
              top: !!bar?.closest(".part.sidebar, .part.auxiliarybar") || !bar?.closest(".part.activitybar"),
              light: document.querySelector(".monaco-workbench")?.classList.contains("vs") ?? false,
              items: rects,
            }
          })
          return state.items.some((item) => item.label.startsWith("ntwine")) && state.top === (layout.location === "top") && state.light === wantLight ? state : undefined
        }, 30_000)
        await sleep(600)
        const ntwine = strip.items.find((item) => item.label.startsWith("ntwine"))!
        // A codicon at rest beside it (Explorer is the active one, drawn brighter).
        const explorer = strip.items.find((item) => /^Search/u.test(item.label)) ?? strip.items[1]!
        // The mask is the icon file: it must load, and be the SVG the package carries.
        const mask = /url\("?([^")]+)"?\)/u.exec(ntwine.mask)?.[1] ?? ""
        const file = await page.evaluate(async (url) => {
          try {
            const response = await fetch(url)
            const text = await response.text()
            return { status: response.status, svg: text.trimStart().startsWith("<svg"), bytes: text.length }
          } catch (error) {
            return { status: 0, svg: false, bytes: 0, error: String(error) }
          }
        }, mask)
        expect("c1", `${layout.name}: the icon's mask file loads and is the SVG`, file.status === 200 && file.svg, { mask: mask.slice(-80), ...file })
        // The strip at 1x, enlarged 6x without smoothing: the BEFORE shot's own framing.
        const left = Math.min(...strip.items.map((item) => item.x))
        const top = Math.min(...strip.items.map((item) => item.y))
        const right = Math.max(...strip.items.map((item) => item.x + item.w))
        const bottom = Math.max(...strip.items.map((item) => item.y + item.h))
        const stripFile = join(out, `${version}-c1-icon-${layout.name}-1x.png`)
        await capture(stripFile, { x: left, y: top, width: right - left, height: bottom - top }, 1)
        const at6 = join(out, `${version}-c1-icon-${layout.name}-1x-at6.png`)
        execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", stripFile, "-vf", "scale=iw*6:ih*6:flags=neighbor", at6])
        rmSync(stripFile)
        shots.splice(shots.indexOf(stripFile), 1, at6)
        // The icon and its codicon neighbour at 8x, and their ink.
        const big = async (item: typeof ntwine, name: string) => {
          const file = join(out, `${version}-c1-icon-${layout.name}-${name}-8x.png`)
          return { file, ink: inkOf(decodePng(await capture(file, { x: item.x, y: item.y, width: item.w, height: item.h }, 8)), 8) }
        }
        // A count badge sits over the icon's corner once the board has one; it is not the icon's ink.
        const unbadge = await page.addStyleTag({ content: ".monaco-workbench .composite-bar .badge { visibility: hidden !important; }" })
        await sleep(100)
        const mine = await big(ntwine, "ntwine")
        const theirs = await big(explorer, "search")
        // Every codicon at rest in the bar (Search, Source Control, Run and Debug, Extensions; Explorer is
        // the active one), unsaved.
        const neighbours: Record<string, number> = {}
        for (const item of strip.items.filter((candidate) => !candidate.label.startsWith("ntwine") && !candidate.active)) {
          neighbours[item.label] = inkOf(decodePng(await capture("", { x: item.x, y: item.y, width: item.w, height: item.h }, 8)), 8).mass
        }
        await unbadge.evaluate((el) => el.remove())
        rmSync(theirs.file)
        shots.splice(shots.indexOf(theirs.file), 1)
        const masses = Object.values(neighbours)
        const mean = masses.reduce((sum, mass) => sum + mass, 0) / Math.max(1, masses.length)
        const ink = { ntwine: mine.ink, search: theirs.ink, box: [ntwine.w, ntwine.h], neighbours, ofMean: Math.round((mine.ink.mass / mean) * 100) / 100, ofSearch: Math.round((mine.ink.mass / theirs.ink.mass) * 100) / 100 }
        expect("c1", `${layout.name}: the icon draws a line mark — not blank, not a filled square`, mine.ink.peak >= 0.6 * theirs.ink.peak && mine.ink.fill < 0.5 && mine.ink.box[0] >= 10 && mine.ink.box[1] >= 10, ink)
        // The bound is the bar's own spread: against the mean of the four at rest, Explorer's glyph is
        // ~1.38x and Search's ~0.7x (headless Chrome over codicon.ttf, 2026-10-02). The mark at a codicon's
        // pen read ~1.9x that mean; at 0.7 of it, ~1.34x (media/ntwine.svg).
        expect("c1", `${layout.name}: its ink is the weight of the codicons beside it (mass within 0.5–1.5x the mean of those at rest)`, masses.length > 0 && mine.ink.mass >= 0.5 * mean && mine.ink.mass <= 1.5 * mean, ink)
        if (layout.name === "top-dark" && before && existsSync(before)) {
          // BEFORE over AFTER, the same framing, for the eye.
          const compare = join(out, `${version}-c1-icon-top-dark-BEFORE-vs-now-at6.png`)
          // hstack wants one height: both padded to the taller, never scaled (nearest-neighbour pixels stay pixels).
          const height = Math.max(decodePng(readFileSync(before)).height, decodePng(readFileSync(at6)).height)
          execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", before, "-i", at6, "-filter_complex", `[0]pad=iw+24:${height}:0:0:white[a];[1]pad=iw:${height}:0:0:white[b];[a][b]hstack`, compare])
          shots.push(compare)
        }
      }
    } finally {
      // Back to the side bar, dark, whatever happened: every check after this one starts there.
      await agent({ op: "config", section: "workbench", key: "activityBar.location", value: "default" })
      await agent({ op: "config", section: "workbench", key: "colorTheme", value: "Default Dark Modern" })
      await until(async () => !(await inWorkbench(() => document.querySelector(".monaco-workbench")?.classList.contains("vs") ?? false)))
    }
  })

  // ── c2: the view frames the real page ──
  const started = Date.now()
  log("opening the ntwine view from its activity-bar icon, with the mouse")
  await waitFor("the ntwine item in the activity bar", () => page.$('.part.activitybar .action-label[aria-label^="ntwine"]'), 30_000)
  await clickInWorkbench('.part.activitybar .action-label[aria-label^="ntwine"]')
  const framed = await waitFor("the ntwine frame", ntwineFrame, 60_000)
  await waitFor("ntwine:ready", async () => (await status()).sidebar.ready || undefined, 90_000)
  notes.readyAfterMs = Date.now() - started
  await waitFor("the queue in the page", async () => (await inPage(() => document.querySelectorAll("[data-xq-thread-row]").length)) > 0 || undefined, 60_000)
  await sleep(1_000)
  // Where the page went on its own, before anything here moved it (c12): a thread only for a window on
  // that thread's worktree. The extension asks the board once the page is ready, which a second covers.
  notes.firstRoute = (await status()).sidebar.href ?? null
  await installFocusTrace()
  // What the first load cost: a dev server serves the page as hundreds of unbundled modules, where an
  // installed ntwine serves a build — so a slow first ready here is a fact about the stack, and the
  // number says how slow.
  notes.firstLoad = {
    readyAfterMs: notes.readyAfterMs,
    hintShown: /didn't say it was ready/u.test(ntwineLog()),
    page: await inPage(() => {
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined
      const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[]
      return { domContentLoadedMs: Math.round(nav?.domContentLoadedEventEnd ?? 0), loadMs: Math.round(nav?.loadEventEnd ?? 0), requests: resources.length, scripts: resources.filter((r) => r.initiatorType === "script" || /\.(ts|tsx|js|mjs)(\?|$)/u.test(r.name)).length }
    }),
  }

  // The editor, driven as a human drives it.
  const selectLines23 = async () => {
    // Real keys in the editor: line 2's start, then down a line and to its end — lines 2-3.
    await press("Control+Home")
    await press("ArrowDown")
    await press("Home")
    await press("Home")
    await press("Shift+ArrowDown")
    await press("Shift+End")
  }
  const openInEditor = async (path: string, selection?: [number, number, number, number]) => {
    await agent({ op: "open", path, ...(selection ? { selection } : {}) })
    if (await until(async () => (await workbenchFocus()).editor, 5_000)) return
    // Shown but not focused (the sidebar's page took the keyboard, or a sash drag kept it): a human clicks in.
    notes.openInEditorClicks = ((notes.openInEditorClicks as number | undefined) ?? 0) + 1
    await clickInWorkbench(".editor-group-container .monaco-editor .view-lines")
    if (selection) await agent({ op: "select", selection })
    await waitFor(`${path} in front with the editor focused`, async () => (await workbenchFocus()).editor || undefined, 10_000)
  }
  await run("c2", "the view frames the real page, and VS Code's title row is its header", async () => {
    // The address the view framed (the page's router then drops the query, by design: lib/embed.ts).
    const snapshot = (await status()).sidebar
    const url = new URL(snapshot.url ?? "about:blank")
    expect("c2", "the frame is the real page, in embed mode, dark, on this window's project", url.origin === origin && new URL(framed.url()).origin === origin && url.searchParams.get("embed") === "vscode" && url.searchParams.get("theme") === "dark" && url.searchParams.get("project") === workspace.slug, { framed: snapshot.url, now: framed.url() })
    expect("c2", "the page said ntwine:ready", snapshot.ready && snapshot.events.some((event) => event.type === "ntwine:ready"), { readyAfterMs: notes.readyAfterMs, events: snapshot.events.slice(0, 6) })
    expect("c2", "no 'hasn't finished loading' bar over it", !snapshot.hinted)
    const boot = await inPage(() => ({
      embed: document.documentElement.dataset.embed,
      theme: document.documentElement.dataset.theme,
      font: document.documentElement.dataset.font,
      sidebarPage: !!document.querySelector("[data-sidebar-page]"),
      phone: document.querySelectorAll("[data-mobile-thread-row], [data-mobile-board-title]").length,
      statusTitle: !!document.querySelector("[data-status-title]"),
      gear: !!document.querySelector('[data-status-row] [aria-label="Settings"]'),
      // The ⌨ is in VS Code's title row (⋯ Keyboard shortcuts), and a status row with nothing left in it
      // is not drawn: it stood alone on a 36px row above the prompt box (2026-10-01).
      keyboard: !!document.querySelector('[data-status-row] [aria-label="Keyboard shortcuts"]'),
      emptyStatusRow: [...document.querySelectorAll<HTMLElement>("[data-status-row]")].some((row) => row.getClientRects().length > 0 && row.querySelectorAll("button, [data-quota-bar]").length === 0),
      header: [...document.querySelectorAll("header")].filter((h) => h.getClientRects().length > 0 && !h.closest("[role=dialog], .ntwine-sheet-panel")).length,
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      rowTitlePx: (() => {
        const title = [...document.querySelectorAll("[data-xq-thread-row] span")].find((s) => s.className.includes("break-words"))
        return title ? getComputedStyle(title).fontSize : null
      })(),
    }))
    expect("c2", "the page knows it is in VS Code, in VS Code's dark theme, in sans", boot.embed === "vscode" && boot.theme === "dark" && boot.font === "sans", boot)
    expect("c2", "the desktop page narrowed, not the phone page", boot.sidebarPage && boot.phone === 0 && boot.rowTitlePx === "13px", boot)
    expect("c2", "no ntwine header: no title, no gear, no header bar", !boot.statusTitle && !boot.gear && boot.header === 0, boot)
    expect("c2", "no ⌨ over the prompt box, and no empty status row", !boot.keyboard && !boot.emptyStatusRow, boot)
    expect("c2", "nothing overflows sideways", boot.scrollWidth <= boot.width, { width: boot.width, scrollWidth: boot.scrollWidth })

    // The row says ntwine and nothing the page names: VS Code re-cases a view's title ("ntwine: Marketing-Site"
    // on 1.140, all caps on 1.90) and drops its description in a one-view container, so the counts ride the
    // badge's tooltip and the names stay in the page (src/sidebar.ts applyRoute).
    const queueRow = await waitFor("the queue's buttons in the title row", async () => {
      const row = await titleRow()
      return row.buttons.includes("New thread") ? row : undefined
    }, 15_000).catch(async () => titleRow())
    const queueSnapshot = await waitFor("the queue's counts on the badge", async () => {
      const snapshot = (await status()).sidebar
      return snapshot.view === "queue" && /ready|need/iu.test(snapshot.badgeTooltip ?? "") ? snapshot : undefined
    }, 15_000).catch(async () => (await status()).sidebar)
    expect("c2", "queue: the page's counts ride the badge's tooltip", /ready|need/iu.test(queueSnapshot.badgeTooltip ?? ""), { badge: queueSnapshot.badge, badgeTooltip: queueSnapshot.badgeTooltip })
    expect("c2", "queue: the title row reads ntwine, with no page name in it to re-case", /ntwine/iu.test(queueRow.text) && !/marketing-site/iu.test(queueRow.text), { shown: queueRow.text, words: queueRow.words, transform: queueRow.transform })
    expect("c2", "queue: the buttons are New thread, Jump to a thread, Settings — no Back to queue", JSON.stringify(queueRow.buttons) === JSON.stringify(["New thread", "Jump to a thread", "Settings"]), queueRow.buttons)
    notes.titleRowQueue = queueRow
    await shot("c2-queue-dark-w300", { window: true })

    // A thread, opened with the mouse from its row.
    await openThreadRow()
    const threadRow = await waitFor("the thread's buttons in the title row", async () => {
      const row = await titleRow()
      return row.buttons.includes("Back to queue") ? row : undefined
    }, 10_000).catch(async () => titleRow())
    const named = await inPage((handle) => [...document.querySelectorAll<HTMLElement>(".ntwine-sheet-panel")].some((panel) => panel.getClientRects().length > 0 && panel.innerText.includes(handle)), seeded!.thread.handle)
    expect("c2", "thread: the drawer names the thread, and the title row still reads ntwine (no handle for VS Code to re-case)", named && !threadRow.text.toLowerCase().includes(seeded!.thread.handle.toLowerCase()), { named, shown: threadRow.text, words: threadRow.words, transform: threadRow.transform })
    expect("c2", "thread: the buttons are Back to queue, Jump to a thread, Settings — no New thread", JSON.stringify(threadRow.buttons) === JSON.stringify(["Back to queue", "Jump to a thread", "Settings"]), threadRow.buttons)
    notes.titleRowThread = threadRow
    await shot("c2-thread-dark-w300", { window: true })

    // Each button, clicked.
    await clickInWorkbench('.part.sidebar .title-actions .action-label[aria-label="Back to queue"]')
    expect("c2", "Back to queue closes the drawer and the title row is the queue's again", await until(async () => !(await drawerOpen()) && (await titleRow()).buttons.includes("New thread"), 8_000), await titleRow())

    // New thread, the way it is used: the human is in the editor and clicks the button. Five times —
    // where the keyboard lands is a race between VS Code's focus of the view and the page's focus of its
    // box, so one try proves little either way; the count is the finding.
    const tries: Record<string, unknown>[] = []
    for (let attempt = 1; attempt <= 5; attempt++) {
      await openInEditor(files.sample)
      const at = Date.now()
      await clickInWorkbench('.part.sidebar .title-actions .action-label[aria-label="New thread"]')
      const settled = await caretAfterPause("newComposer")
      const held = settled.box?.active === true && settled.box.frameFocused && settled.focus.sidebar
      tries.push({ attempt, held, ...(held ? {} : { after: settled, trace: await focusTraceSince(at) }) })
    }
    notes.newThreadTries = tries
    const heldCount = tries.filter((t) => t.held).length
    expect("c2", `New thread, clicked from the editor, puts the caret in the prompt box, still there 1.5s later (${heldCount}/5)`, heldCount === 5, tries.map((t) => ({ attempt: t.attempt, held: t.held, ...(t.after ? { after: t.after } : {}) })))
    // …and from a thread: Back to queue, then New thread at once — the order that lost the caret in
    // earlier runs, while the closing drawer hands focus back to its row.
    const afterBack: Record<string, unknown>[] = []
    for (let attempt = 1; attempt <= 3; attempt++) {
      await openThreadRow()
      await clickInWorkbench('.part.sidebar .title-actions .action-label[aria-label="Back to queue"]')
      await until(async () => (await titleRow()).buttons.includes("New thread"), 5_000)
      const at = Date.now()
      await clickInWorkbench('.part.sidebar .title-actions .action-label[aria-label="New thread"]')
      const settled = await caretAfterPause("newComposer")
      const held = settled.box?.active === true && settled.box.frameFocused && settled.focus.sidebar
      afterBack.push({ attempt, held, ...(held ? {} : { after: settled, trace: await focusTraceSince(at) }) })
    }
    notes.newThreadAfterBack = afterBack
    const heldAfterBack = afterBack.filter((t) => t.held).length
    expect("c2", `New thread, clicked just after Back to queue, puts the caret in the prompt box (${heldAfterBack}/3)`, heldAfterBack === 3, afterBack.map((t) => ({ attempt: t.attempt, held: t.held, ...(t.after ? { after: t.after } : {}) })))
    if (!(await box("newComposer"))?.active) {
      await shot("c2-new-thread-caret-lost", { window: true })
      await clickInPage('textarea[data-surface="newComposer"]')
    }
    await typeInto("newComposer", "typed after New thread")
    await sleep(300)
    const typed = await box("newComposer")
    expect("c2", "…and typing lands there", typed?.value.includes("typed after New thread") === true, typed?.value)
    await clearBox("newComposer")

    await clickInWorkbench('.part.sidebar .title-actions .action-label[aria-label="Jump to a thread"]')
    const palette = await until(async () => (await inPage(() => !!document.querySelector("[cmdk-root]"))), 5_000)
    expect("c2", "Jump to a thread opens ntwine's palette", palette)
    await shot("c2-jump-palette-w300")
    await press("Escape")
    await until(async () => !(await inPage(() => !!document.querySelector("[cmdk-root]"))), 3_000)

    const settingsAt = Date.now()
    await clickInWorkbench('.part.sidebar .title-actions .action-label[aria-label="Settings"]')
    const settings = await until(async () => (await inPage(() => !!document.querySelector('[data-settings-editor="appearance"]'))), 8_000)
    const settingsView = await until(async () => (await status()).sidebar.view === "settings", 3_000)
    expect("c2", "Settings opens Settings, and the page tells the title row so (its view is settings)", settings && settingsView, { settings, view: (await status()).sidebar.view, row: await titleRow() })
    await sleep(1_000)
    const settingsFocus = { workbench: await workbenchFocus(), page: await inPage(() => ({ hasFocus: document.hasFocus(), active: document.activeElement?.tagName ?? null, inDialog: !!document.activeElement?.closest("[role=dialog]") })) }
    await press("Escape")
    const closed = await until(async () => !(await inPage(() => !!document.querySelector('[data-settings-editor="appearance"]'))), 5_000)
    if (!closed) notes.settingsEscape = { focus: settingsFocus, trace: await focusTraceSince(settingsAt) }
    expect("c2", "…the keyboard is in it: Escape closes Settings", closed, settingsFocus)
    if (!closed) await resetPage()
  })

  // The side bar's width, read and set by dragging its sash with the mouse (c3 and c9).
  const sidebarWidth = async () => (await rectOf(".part.sidebar"))?.width ?? 0
  const dragSidebarTo = async (width: number) => {
    const sash = await inWorkbench(() => {
      const part = document.querySelector(".part.sidebar")!.getBoundingClientRect()
      const sashes = [...document.querySelectorAll<HTMLElement>(".monaco-sash.vertical")].map((s) => s.getBoundingClientRect()).filter((r) => r.height > 100 && Math.abs(r.left + r.width / 2 - part.right) < 6)
      const r = sashes[0]
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: part.right, y: part.top + part.height / 2 }
    })
    const delta = width - (await sidebarWidth())
    await page.mouse.move(sash.x, sash.y)
    await page.mouse.down()
    for (let step = 1; step <= 10; step++) await page.mouse.move(sash.x + (delta * step) / 10, sash.y)
    await page.mouse.up()
    await sleep(800)
  }

  // ── c3: the editor's context in the page ──
  /**
   * Lines 2-3 of sample.ts selected by keys and the add chord (Ctrl+L, the one the page names) pressed the
   * instant after — clicking back into the editor first when the keyboard is not there. `focused` says the
   * editor already has it (the first try then skips the click). Returns the try that put the chip in the
   * reply box, 0 for none.
   */
  const selectAndAdd = async (focused: boolean, chord = "Control+KeyL"): Promise<number> => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1 || !focused) {
        await clickInWorkbench(".editor-group-container .monaco-editor .view-lines")
        if (!(await until(async () => (await workbenchFocus()).editor, 3_000))) continue
      }
      await selectLines23()
      await press(chord)
      if (await until(async () => (await box("chatComposer").catch(() => null))?.value.includes("@sample.ts:2-3") === true, 6_000)) return attempt
    }
    return 0
  }
  await run("c3", "the context bar follows the editor", async () => {
    // At ~300px, the width the shots are named for, on every VS Code: 1.90's default side bar is 255px,
    // where the bar's hint has no variant short enough beside the file chip and the page drops it by
    // design (EditorContextBar.tsx Hint fits the longest that fits) — the check then failed on the floor
    // for the width, not for the bar. The width it found is in the notes.
    notes.c3SidebarWidthBefore = await sidebarWidth()
    if (Math.abs((await sidebarWidth()) - 300) > 12) await dragSidebarTo(300)
    await command("workbench.action.closeAllEditors")
    await agent({ op: "open", path: files.a })
    await agent({ op: "open", path: files.b })
    await openInEditor(files.sample)
    await selectLines23()
    const selectedAt = Date.now()
    const editor = await editorState()
    expect("c3", "the editor holds lines 2-3 selected, by real keys", editor.path === files.sample && editor.selection?.start[0] === 1 && editor.selection.start[1] === 0 && editor.selection.end[0] === 2, editor)
    const selection = await waitFor("the bar in its selection state", async () => {
      const bar = await contextBar("newComposer")
      return bar?.kind === "selection" && bar.label?.includes("sample.ts:2-3") ? bar : undefined
    }, 5_000).catch(async () => contextBar("newComposer"))
    const latency = Date.now() - selectedAt
    notes.contextBarLatencyMs = latency
    expect("c3", "selection: the bar reads `sample.ts:2-3  2 lines` in the selection style, within 1.5s", selection?.kind === "selection" && /sample\.ts:2-3, 2 lines/u.test(selection.label ?? "") && latency < 1_500, { latency, selection })
    await shot("c3-bar-selection-w300")

    await press("ArrowRight")
    const file = await waitFor("the bar in its file state", async () => {
      const bar = await contextBar("newComposer")
      return bar?.kind === "file" ? bar : undefined
    }, 5_000).catch(async () => contextBar("newComposer"))
    expect("c3", "no selection: the bar names the file alone, quietly, with the Ctrl+L hint", file?.kind === "file" && /sample\.ts/u.test(file.text ?? "") && !/lines?/u.test(file.text ?? "") && /Ctrl\+L/u.test(file.hint ?? ""), file)
    await shot("c3-bar-file-w300")

    // Another editor, by its tab.
    await clickInWorkbench('.tabs-container .tab[aria-label^="a.ts"]')
    const other = await waitFor("the bar on a.ts", async () => {
      const bar = await contextBar("newComposer")
      return bar?.text?.includes("a.ts") ? bar : undefined
    }, 5_000).catch(async () => contextBar("newComposer"))
    expect("c3", "switching editors: the bar follows to a.ts", /a\.ts/u.test(other?.text ?? ""), other)

    // The open files, behind the chevron.
    const tabs = await agent<{ label: string; path: string | null; active: boolean }[]>({ op: "tabs" })
    await clickInComposer("newComposer", "[data-editor-open-files]")
    const listed = await waitFor("the open-files menu", async () => {
      const labels = await inPage(() => [...document.querySelectorAll<HTMLElement>("[data-editor-open-file]")].filter((item) => item.getClientRects().length > 0).map((item) => item.dataset.editorOpenFile ?? ""))
      return labels.length ? labels : undefined
    }, 5_000).catch(() => [] as string[])
    const others = tabs.filter((tab) => !tab.active && tab.path).map((tab) => tab.label).sort()
    expect("c3", "the open-files menu lists the other open tabs", JSON.stringify(listed.map((label) => label.split("/").pop()).sort()) === JSON.stringify(others), { listed, tabs })
    await shot("c3-open-files-menu-w300")
    await press("Escape")
  })

  // ── c4: Ctrl+L, the chip, a send to a simulated worker ──
  await run("c4", "Ctrl+L puts the selection in the front composer as a pill, and it sends", async () => {
    // The thread in the drawer is the front composer; the Explorer takes the side bar, so Ctrl+L must reveal ntwine.
    await resetPage()
    await openThreadRow()
    await command("workbench.view.explorer")
    await waitFor("the ntwine view hidden", async () => !(await status()).sidebar.visible || undefined, 10_000)
    await installFocusTrace()
    const editorAt = Date.now()
    await openInEditor(files.sample)
    await selectLines23()
    // A human's beat with the selection made: the keyboard must still be the editor's.
    await sleep(1_500)
    const held = { focus: await workbenchFocus(), editor: await editorState() }
    notes.focusBeforeCtrlL = { ...held, trace: await focusTraceSince(editorAt) }
    expect("c4", "with a thread open in the (hidden) sidebar, the editor keeps the keyboard after a selection is made in it", held.focus.editor, held)
    // Ctrl+L. If the keyboard is gone by now (the check above failed and says where it went), Ctrl+L is
    // pressed the instant the selection is made, before the page can take it: what follows tests the rest
    // of the path, which is otherwise unreachable.
    const eventsBefore = (await status()).sidebar.events.length
    notes.ctrlLTries = await selectAndAdd(held.focus.editor)
    const landed = await waitFor("the chip in the thread's reply box", async () => {
      const state = await box("chatComposer").catch(() => null)
      return state?.value.includes("@sample.ts:2-3") ? state : undefined
    }, 15_000).catch(async () => box("chatComposer").catch(() => null))
    const view = (await status()).sidebar
    notes.ctrlLEvents = view.events.slice(eventsBefore)
    notes.focusCtrlL = await focusTraceSince(editorAt)
    expect("c4", "Ctrl+L reveals the sidebar", view.visible, { visible: view.visible, events: notes.ctrlLEvents })
    expect("c4", "the chip `@sample.ts:2-3` is in the thread's reply box", landed?.value.startsWith("@sample.ts:2-3") === true, landed)
    const pill = landed?.pills.find((p) => p.token === "@sample.ts:2-3")
    expect("c4", "…drawn as a pill (a filled, ringed token in the box's backdrop)", !!pill && pill.background !== "rgba(0, 0, 0, 0)" && pill.ring !== "none", pill)
    const afterPause = await caretAfterPause("chatComposer")
    expect("c4", "…with the caret after it, in the focused box, still there 1.5s later", !!afterPause.box && afterPause.box.active && afterPause.box.frameFocused && afterPause.box.caret >= "@sample.ts:2-3".length, afterPause)
    expect("c4", "…and the keyboard is in the sidebar", afterPause.focus.sidebar, afterPause.focus)
    await typeInto("chatComposer", "why does this loop?")
    await sleep(300)
    const typed = await box("chatComposer")
    expect("c4", "typing lands after the chip", typed?.value === "@sample.ts:2-3 why does this loop?", typed?.value)
    const bar = await contextBar("chatComposer")
    expect("c4", "the reply box's context bar shows the live selection", bar?.kind === "selection" && /sample\.ts:2-3/u.test(bar.label ?? ""), bar)
    await shot("c4-thread-selection-chip-w300", { window: true })

    // Send. The worker is simulated: it records what reached it and writes it into the transcript.
    const before = readFileSync(seeded!.inputs, "utf8").trim().split("\n").filter(Boolean).length
    await press("Enter")
    const input = await waitFor("the follow-up at the simulated worker", () => {
      const lines = readFileSync(seeded!.inputs, "utf8").trim().split("\n").filter(Boolean)
      return lines.length > before ? (JSON.parse(lines.at(-1)!) as { id: string; text: string }) : undefined
    }, 20_000)
    const parsed = parseSentContext(input.text)
    const lines = SAMPLE.split("\n").slice(1, 3).join("\n")
    expect("c4", "the message reached the worker with the context serialized: the chip in the prose, lines 2-3 defined", !!parsed && parsed.body.startsWith("@sample.ts:2-3 why does this loop?") && parsed.items.length === 1 && parsed.items[0]!.token === "@sample.ts:2-3" && parsed.items[0]!.startLine === 2 && parsed.items[0]!.endLine === 3 && parsed.items[0]!.text === lines, { text: input.text.slice(0, 600), parsed })
    const chip = await waitFor("the chip in the transcript", async () => {
      const chips = await inPage(() => [...document.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].filter((b) => b.getClientRects().length > 0 && /sample\.ts:2-3/u.test(b.textContent ?? "")).map((b) => ({ text: b.textContent, title: b.title })))
      return chips.length ? chips : undefined
    }, 20_000).catch(() => [])
    expect("c4", "the transcript shows the sent message with the chip", chip.length > 0, chip)
    await sleep(2_000)
    await shot("c4-transcript-chip-w300")
    // The chip unfolds its quote, as in the browser.
    notes.layersBeforeChip = await drawerLayers()
    notes.framesBeforeChip = await framesAlive()
    notes.geometryBeforeChip = await frameGeometry()
    await clickTextInPage("button[aria-expanded]", "sample.ts:2-3")
    const unfolded = await until(async () => (await inPage(() => document.body.innerText.includes("lines 2-3"))), 3_000)
    if (!unfolded) notes.chipClick = { clicks: [...clicks], focus: await workbenchFocus(), layers: await drawerLayers(), chips: await inPage(() => [...document.querySelectorAll<HTMLElement>("button[aria-expanded]")].filter((b) => /sample\.ts:2-3/u.test(b.textContent ?? "")).map((b) => { const r = b.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), layer: b.closest<HTMLElement>("[data-drawer-layer]")?.dataset.drawerLayer ?? null } })) }
    expect("c4", "the transcript's chip unfolds the lines it carried", unfolded)
    await shot("c4-transcript-chip-open-w300")

    // The context bar's own click does the same, into this box.
    // The selection set through the editor API: the keyboard is not what this step tests, and it would
    // not stay in the editor long enough to select by keys (see above).
    await openInEditor(files.sample)
    await agent({ op: "select", selection: [1, 0, 2, -1] })
    await waitFor("the reply box's bar on the selection", async () => (await contextBar("chatComposer"))?.kind === "selection" || undefined, 5_000)
    const barAt = Date.now()
    const barEventsAt = (await status()).sidebar.events.length
    await clickInComposer("chatComposer", "[data-editor-context=selection]")
    const viaBar = await waitFor("the chip from the bar's click", async () => {
      const state = await box("chatComposer")
      return state?.value.includes("@sample.ts:2-3") ? state : undefined
    }, 8_000).catch(async () => box("chatComposer"))
    // The caret follows the chip a beat later (the compose goes out to the extension and back).
    await until(async () => (await box("chatComposer"))?.active === true, 2_000)
    const barCaret = await caretAfterPause("chatComposer", 500)
    expect("c4", "clicking the context bar puts the same chip in the box", viaBar?.value.startsWith("@sample.ts:2-3") === true && !!viaBar.pills.some((pill) => pill.token === "@sample.ts:2-3"), viaBar)
    expect("c4", "…and leaves the caret after it, in the box", !!barCaret.box?.active && barCaret.box.frameFocused && barCaret.box.caret >= "@sample.ts:2-3".length, barCaret)
    if (!barCaret.box?.active) {
      notes.barClickFocus = { after: barCaret, trace: await focusTraceSince(barAt), clicks: [...clicks], events: (await status()).sidebar.events.slice(barEventsAt) }
      // The human clicks into the box to go on.
      await clickInPage('textarea[data-surface="chatComposer"]')
      await press("End")
    }
    await typeInto("chatComposer", "x")
    await sleep(200)
    expect("c4", "…and typing lands after it", (await box("chatComposer"))?.value.trimEnd().endsWith("x") === true, (await box("chatComposer"))?.value)
    await clearBox("chatComposer")

    // Alt+K, Claude Code's chord, with only a caret in the editor: the whole file.
    const altKAt = Date.now()
    await openInEditor(files.sample)
    await agent({ op: "select", selection: [1, 2, 1, 2] })
    await sleep(500)
    await press("Alt+KeyK")
    // A whole file goes in as a REFERENCE, `src/sample.ts` in code quotes — the item carries no text (the
    // extension's own suite pins that: e2e/suite.ts "Alt+K … the whole file"), and the page writes a text-less
    // item as a reference to it (lib/editorCompose.ts composeEdit), as Add file to ntwine prompt always has.
    const wholeFile = await waitFor("the file's reference from Alt+K", async () => {
      const state = await box("chatComposer")
      return state?.value.includes("`src/sample.ts`") ? state : undefined
    }, 8_000).catch(async () => box("chatComposer"))
    if (!wholeFile?.value.startsWith("`src/sample.ts`")) notes.altKFocus = await focusTraceSince(altKAt)
    expect("c4", "Alt+K with only a caret puts the whole file in the reply box, as a reference: `src/sample.ts`", wholeFile?.value.startsWith("`src/sample.ts`") === true, wholeFile)
    await clearBox("chatComposer")

    // CTRL+L BOTH WAYS, as Cursor's: pressed in the reply box it goes back to the editor — even with a
    // selection standing there, it adds nothing (that is the editor's Ctrl+L, and the bar's click).
    await openInEditor(files.sample)
    await agent({ op: "select", selection: [1, 0, 2, -1] })
    await waitFor("the reply box's bar on the selection", async () => (await contextBar("chatComposer"))?.kind === "selection" || undefined, 5_000)
    await clickInPage('textarea[data-surface="chatComposer"]')
    await until(async () => (await box("chatComposer"))?.active === true, 3_000)
    const keysBefore = (await status()).sidebar.events.filter((event) => event.type === "ntwine:key").length
    await press("Control+KeyL")
    const backToEditor = await until(async () => (await workbenchFocus()).editor, 5_000)
    await sleep(500)
    const forwarded = (await status()).sidebar.events.filter((event) => event.type === "ntwine:key").slice(keysBefore)
    const leftBox = await box("chatComposer")
    expect("c4", "Ctrl+L pressed in the reply box goes back to the editor, adding nothing", backToEditor && forwarded.some((event) => event.outcome === "workbench.action.focusActiveEditorGroup") && leftBox?.value === "", { focus: await workbenchFocus(), forwarded, box: leftBox?.value })

    // …and in the editor with NOTHING selected, to the prompt box — revealing the sidebar when the Explorer
    // has it — with the caret in the box and nothing added.
    await agent({ op: "select", selection: [1, 2, 1, 2] })
    await command("workbench.view.explorer")
    await waitFor("the ntwine view hidden", async () => !(await status()).sidebar.visible || undefined, 10_000)
    await openInEditor(files.sample)
    await agent({ op: "select", selection: [1, 2, 1, 2] })
    // The empty selection crosses to the renderer, where `editorHasSelection` is kept, on its own channel.
    await sleep(800)
    await press("Control+KeyL")
    const toPrompt = await until(async () => {
      const state = await box("chatComposer").catch(() => null)
      return !!state?.active && state.frameFocused && (await workbenchFocus()).sidebar
    }, 8_000)
    const there = { box: await box("chatComposer").catch(() => null), focus: await workbenchFocus(), editor: await editorState(), visible: (await status()).sidebar.visible }
    expect("c4", "Ctrl+L in the editor with nothing selected reveals the sidebar and puts the caret in the reply box, adding nothing", toPrompt && there.visible && there.box?.value === "" && there.editor.selection?.start[0] === 1 && there.editor.selection.start[1] === 2, there)
    await shot("c4-ctrl-l-to-prompt-w300")
  })

  // ── c5: Ask ntwine to fix ──
  await run("c5", "Ask ntwine to fix on a real TypeScript error", async () => {
    await resetPage()
    await openThreadRow()
    // A draft an earlier check left (the drawer keeps it) would ride along in front of the chip.
    await clearBox("chatComposer")
    const fixAt = Date.now()
    await openInEditor(files.broken)
    const diagnostics = await waitFor("TypeScript's error in broken.ts", async () => {
      const found = await agent<{ message: string; source: string | null; code: string | number | null; range: number[] }[]>({ op: "diagnostics", path: files.broken })
      return found.find((d) => d.source === "ts") ? found : undefined
    }, 90_000)
    const problem = diagnostics.find((d) => d.source === "ts")!
    notes.diagnostic = problem
    // The caret on the error, then the quick-fix chord, and the item clicked like a human picks it.
    await agent({ op: "select", selection: [problem.range[0]!, problem.range[1]!, problem.range[0]!, problem.range[1]!] })
    await sleep(1_000)
    const kept = await workbenchFocus()
    notes.focusBeforeQuickFix = { focus: kept, trace: await focusTraceSince(fixAt) }
    expect("c5", "the editor keeps the caret while the human reads the error (nothing pulls it into the sidebar)", kept.editor, notes.focusBeforeQuickFix)
    // The menu waits on every provider, tsserver's fixes included, which are slow on a first request. The
    // chord goes the instant the caret is set: a beat later the page may hold the keyboard (above).
    const menuShows = () => until(async () => (await inWorkbench(() => [...document.querySelectorAll(".action-widget")].some((w) => (w as HTMLElement).offsetHeight > 0 && /Ask ntwine to fix/u.test(w.textContent ?? "")))), 20_000)
    let menu = false
    for (let attempt = 1; attempt <= 3 && !menu; attempt++) {
      if (!(await workbenchFocus()).editor) {
        // Back into the editor the way a human would: a click.
        await clickInWorkbench(".editor-group-container .monaco-editor .view-lines")
        await until(async () => (await workbenchFocus()).editor, 3_000)
      }
      await agent({ op: "select", selection: [problem.range[0]!, problem.range[1]!, problem.range[0]!, problem.range[1]!] })
      await press("Control+Period")
      menu = await menuShows()
      if (!menu) {
        notes[`quickFixTry${attempt}`] = { focus: await workbenchFocus(), widget: await inWorkbench(() => (document.querySelector(".context-view") as HTMLElement | null)?.innerText.slice(0, 300) ?? "no context view") }
        if ((await workbenchFocus()).editor) await press("Escape")
      }
    }
    if (!menu) throw new Error(`no quick-fix menu with Ask ntwine to fix after Ctrl+. three times: ${JSON.stringify(notes.quickFixTry3)}`)
    const widget = await rectOf(".action-widget")
    if (widget) await capture(join(out, `${version}-c5-quick-fix-menu.png`), { x: widget.x - 8, y: widget.y - 8, width: widget.width + 16, height: widget.height + 16 }, 2)
    const item = (await page.evaluateHandle(() => [...document.querySelectorAll(".action-widget .monaco-list-row, .action-widget li")].find((row) => /Ask ntwine to fix/u.test(row.textContent ?? "")) ?? null)).asElement() as ElementHandle | null
    await clickHandle(item, "the Ask ntwine to fix item")
    const line = problem.range[0]! + 1
    const fixed = await waitFor("the chip and the note", async () => {
      const state = await box("chatComposer").catch(() => null)
      return state?.value.includes(`@broken.ts:${line}`) ? state : undefined
    }, 15_000).catch(async () => box("chatComposer").catch(() => null))
    const want = `@broken.ts:${line} Fix: ${problem.message} ts(${problem.code})`
    expect("c5", "the chip and the problem land in the thread's reply box", fixed?.value.trim() === want && fixed.pills.some((pill) => pill.token === `@broken.ts:${line}`), { want, got: fixed?.value })
    const afterFix = await caretAfterPause("chatComposer")
    expect("c5", "…with the caret after them, in the sidebar, 1.5s later", !!afterFix.box?.active && afterFix.box.frameFocused && afterFix.box.caret >= want.length && afterFix.focus.sidebar, afterFix)
    await shot("c5-ask-to-fix-w300", { window: true })
    await clearBox("chatComposer")
  })

  // ── c6: links out of the transcript ──
  await run("c6", "links in the real transcript", async () => {
    await resetPage()
    await openThreadRow()
    await command("workbench.action.closeAllEditors")
    await clickInPage(`[data-local-path="${files.a}"]`, "the a.ts link")
    const opened = await waitFor("a.ts in the editor at lines 2-3", async () => {
      const editor = await editorState()
      return editor.path === files.a && editor.selection?.start[0] === 1 && editor.selection.end[0] === 2 ? editor : undefined
    }, 10_000).catch(() => editorState())
    expect("c6", "a code-file link opens the file in the editor, lines 2-3 selected", opened.path === files.a && opened.selection?.start[0] === 1 && opened.selection.end[0] === 2, opened)
    expect("c6", "…in THIS window, over the sidebar's own wire, not through an opener", !/code|cursor/u.test(stack!.openers()), stack!.openers())
    await shot("c6-code-link-opened", { window: true })

    // The web link: VS Code's openExternal, which ends at the stub xdg-open.
    await clickInPage('a[href="https://example.com/spec"]', "the web link")
    let dialog: string | null = null
    await sleep(1_500)
    dialog = await inWorkbench(() => {
      const box = document.querySelector<HTMLElement>(".monaco-dialog-box")
      return box && box.offsetHeight > 0 ? box.innerText.replace(/\s+/gu, " ").slice(0, 300) : null
    })
    if (dialog) {
      notes.openExternalDialog = dialog
      await shot("c6-open-external-dialog", { window: true })
      const open = (await page.evaluateHandle(() => [...document.querySelectorAll(".monaco-dialog-box .monaco-button")].find((b) => /^Open$/u.test((b.textContent ?? "").trim())) ?? null)).asElement() as ElementHandle | null
      await clickHandle(open, "the dialog's Open")
    }
    // VS Code's link protection asks before an untrusted domain opens. The test runner refuses every dialog
    // (DialogService: "refused to show dialog in tests"), and the extension logs the refusal: that line is
    // the proof the link reached VS Code's opener. A trusted domain would go on to `xdg-open` (a stub).
    const reached = await until(() => /xdg-open https:\/\/example\.com\/spec/u.test(stack!.openers()) || /open the external website/u.test(ntwineLog()), 10_000)
    const outcome = (await status()).sidebar.events.filter((event) => event.type === "ntwine:open-external").at(-1)
    const line = ntwineLog().split("\n").find((entry) => /ntwine:open-external/u.test(entry)) ?? null
    notes.openExternal = { openers: stack!.openers(), outcome, dialog, log: line }
    expect("c6", "a web link goes to VS Code's openExternal — no window from the frame (VS Code's own 'open the external website?' prompt comes first)", reached, notes.openExternal)

    // A Markdown link: ntwine's own reader.
    await clickInPage(`[data-local-path="${files.readme}"]`, "the README link")
    const reader = await until(async () => (await inPage((path) => !!document.querySelector(`button[aria-label="Open"][title^="Open ${path}"]`), files.readme)), 8_000)
    const front = (await editorState()).path
    expect("c6", "a Markdown link opens ntwine's reader, and nothing in the editor", reader && front !== files.readme, { reader, front })
    await shot("c6-markdown-reader-w300")
    notes.titleRowReader = await titleRow()
    await press("Escape")
    await until(async () => !(await inPage((path) => !!document.querySelector(`button[aria-label="Open"][title^="Open ${path}"]`), files.readme)), 4_000)
  })

  // ── c8: keys with the frame focused ──
  const focusPageBody = async () => {
    // A click on the sidebar page's own background, not on a control or a box: the keyboard is the page's.
    const spot = await inPage(() => {
      const root = document.querySelector<HTMLElement>("[data-sidebar-page]")
      const r = root?.getBoundingClientRect()
      return r ? { x: r.left + 4, y: r.bottom - 6 } : null
    })
    const frameBox = await (await (await frame()).frameElement())?.boundingBox()
    if (!spot || !frameBox) throw new Error("no page background to click")
    await page.mouse.click(frameBox.x + spot.x, frameBox.y + Math.min(spot.y, frameBox.height - 6))
    await inPage(() => (document.activeElement as HTMLElement | null)?.blur?.())
  }
  await run("c8", "keys with the frame focused", async () => {
    await resetPage()
    await focusPageBody()
    const keysBefore = (await status()).sidebar.events.filter((event) => event.type === "ntwine:key").length
    await press("Control+Shift+KeyP")
    const vsPalette = await until(paletteOpen, 5_000)
    const keyEvents = (await status()).sidebar.events.filter((event) => event.type === "ntwine:key").slice(keysBefore)
    expect("c8", "Ctrl+Shift+P from the frame opens VS Code's command palette (forwarded)", vsPalette && keyEvents.some((event) => event.outcome === "workbench.action.showCommands"), keyEvents)
    await shot("c8-vscode-palette", { window: true })
    await press("Escape")
    await until(async () => !(await paletteOpen()), 3_000)

    await focusPageBody()
    const before = (await status()).sidebar.events.filter((event) => event.type === "ntwine:key").length
    await press("Control+KeyK")
    const ntwinePalette = await until(async () => (await inPage(() => !!document.querySelector("[cmdk-root]"))), 5_000)
    await sleep(500)
    const forwarded = (await status()).sidebar.events.filter((event) => event.type === "ntwine:key").slice(before)
    expect("c8", "Ctrl+K opens ntwine's palette and is not forwarded to VS Code", ntwinePalette && forwarded.length === 0 && !(await paletteOpen()), forwarded)
    await press("Escape")
    await until(async () => !(await inPage(() => !!document.querySelector("[cmdk-root]"))), 3_000)

    await focusPageBody()
    await page.keyboard.type("?")
    const sheet = await until(async () => (await inPage(() => !!document.querySelector("[data-shortcut-list]"))), 5_000)
    const sheetState = await inPage(() => ({
      note: document.querySelector("[data-shortcut-sidebar-note]")?.textContent ?? null,
      hints: [...document.querySelectorAll("[data-shortcut-hint]")].map((h) => h.textContent),
      editor: [...document.querySelectorAll<HTMLElement>("[data-shortcut-editor] li")].map((row) => ({ label: row.innerText.split("\n")[0], keys: row.querySelector("[aria-label]")?.getAttribute("aria-label") ?? "" })),
      // The Editor group leads: it is the first group after the notes.
      editorFirst: document.querySelector("[data-shortcut-list] section")?.matches("[data-shortcut-editor]") ?? false,
      host: document.querySelector<HTMLElement>("[data-shortcut-host]")?.innerText.replace(/\s+/gu, " ").slice(0, 400) ?? null,
    }))
    expect("c8", "? opens the shortcuts sheet, with its sidebar hints and its VS Code group", sheet && !!sheetState.note && sheetState.hints.length >= 3 && /VS Code/u.test(sheetState.host ?? "") && /Ctrl/u.test(sheetState.host ?? ""), sheetState)
    expect("c8", "…led by the Editor group: Ctrl+L adds the selection or with none goes to the prompt box, Alt+K the selection or the file", sheetState.editorFirst && JSON.stringify(sheetState.editor.map((row) => row.keys)) === JSON.stringify(["Ctrl+L", "Ctrl+L", "Alt+K"]) && /prompt box/u.test(sheetState.editor[1]?.label ?? ""), sheetState.editor)
    await shot("c8-shortcuts-w300")
    await press("Escape")
    await until(async () => !(await inPage(() => !!document.querySelector("[data-shortcut-list]"))), 3_000)

    // The same sheet from VS Code's title row: its ⋯, Keyboard shortcuts — clicked, as a human does.
    // "Views and More Actions..." on 1.140 (a container with one view), "More Actions..." in a view's own header.
    await clickInWorkbench('.part.sidebar .title-actions .action-label[aria-label*="More Actions"]')
    const menuItem = await waitFor("Keyboard shortcuts in the ⋯ menu", async () => {
      const items = await inWorkbench(() => [...document.querySelectorAll<HTMLElement>(".monaco-menu .action-item .action-label")].filter((label) => label.getClientRects().length > 0).map((label) => label.getAttribute("aria-label") ?? label.textContent ?? ""))
      return items.some((label) => /Keyboard shortcuts/u.test(label)) ? items : undefined
    }, 5_000).catch(() => null)
    if (menuItem) {
      const item = await page.evaluateHandle(() => [...document.querySelectorAll<HTMLElement>(".monaco-menu .action-item .action-label")].find((label) => /Keyboard shortcuts/u.test(label.getAttribute("aria-label") ?? label.textContent ?? "")) ?? null)
      // The pointer rests on the item first, as a hand does: VS Code's menu ignored a click that arrived
      // with no hover before it (the menu stayed up and nothing ran).
      const itemBox = await (item.asElement() as ElementHandle | null)?.boundingBox()
      if (itemBox) {
        await page.mouse.move(itemBox.x + itemBox.width / 2, itemBox.y + itemBox.height / 2, { steps: 4 })
        await sleep(250)
      }
      await clickHandle(item.asElement() as ElementHandle | null, "Keyboard shortcuts in the ⋯ menu")
    } else {
      // A native context menu (no DOM to click): the same command the item runs.
      notes.shortcutsMenu = "the ⋯ menu was not in the workbench's DOM; ran ntwine.sidebar.shortcuts"
      await press("Escape")
      await command("ntwine.sidebar.shortcuts")
    }
    const fromRow = await until(async () => (await inPage(() => !!document.querySelector("[data-shortcut-list]"))), 5_000)
    const sheetFocus = await inPage(() => ({ hasFocus: document.hasFocus(), inSheet: !!document.activeElement?.closest("[role=dialog]") }))
    expect("c8", "the title row's ⋯ Keyboard shortcuts opens the sheet, with the keyboard in it", fromRow && sheetFocus.inSheet, { menu: menuItem, ...sheetFocus })
    await shot("c8-shortcuts-from-title-row-w300")
    await press("Escape")
    await until(async () => !(await inPage(() => !!document.querySelector("[data-shortcut-list]"))), 3_000)

    await focusPageBody()
    await press("Control+Digit1")
    const back = await until(async () => (await workbenchFocus()).editor, 5_000)
    expect("c8", "Ctrl+1 from the frame returns to the editor", back, await workbenchFocus())
  })

  // ── c7: theme ──
  await run("c7", "a VS Code theme switch re-themes the page live", async () => {
    const urlBefore = (await frame()).url()
    const at = Date.now()
    await agent({ op: "config", section: "workbench", key: "colorTheme", value: "Default Light Modern" })
    const light = await until(async () => (await inPage(() => document.documentElement.dataset.theme)) === "light", 8_000)
    notes.themeSwitchMs = Date.now() - at
    const bg = await inPage(() => getComputedStyle(document.body).backgroundColor)
    expect("c7", "light: the page turns light, without reloading", light && (await frame()).url() === urlBefore && (await status()).sidebar.ready, { ms: notes.themeSwitchMs, bg })
    await shot("c7-queue-light-w300", { window: true })
    await agent({ op: "config", section: "workbench", key: "colorTheme", value: "Default Dark Modern" })
    const dark = await until(async () => (await inPage(() => document.documentElement.dataset.theme)) === "dark", 8_000)
    expect("c7", "dark again: the page follows back", dark)
  })

  // ── c9: the gallery, at ~300px and ~450px ──
  const gallery = async (tag: string) => {
    await command("workbench.view.extension.ntwine")
    await waitFor("the ntwine view", async () => (await status()).sidebar.visible || undefined, 10_000)
    await resetPage()
    await openInEditor(files.sample)
    await selectLines23()
    const frameWidth = await inPage(() => innerWidth)
    notes[`gallery-${tag}`] = { sidebar: await sidebarWidth(), frame: frameWidth, scrollWidth: await inPage(() => document.documentElement.scrollWidth) }
    await shot(`c9-queue-dark-${tag}`, { window: true })
    await agent({ op: "config", section: "workbench", key: "colorTheme", value: "Default Light Modern" })
    await until(async () => (await inPage(() => document.documentElement.dataset.theme)) === "light", 8_000)
    await shot(`c9-queue-light-${tag}`)
    await agent({ op: "config", section: "workbench", key: "colorTheme", value: "Default Dark Modern" })
    await until(async () => (await inPage(() => document.documentElement.dataset.theme)) === "dark", 8_000)

    await openThreadRow()
    await openInEditor(files.sample)
    notes[`ctrlLTries-${tag}`] = await selectAndAdd(true)
    await waitFor("the chip", async () => (await box("chatComposer"))?.value.includes("@sample.ts:2-3") || undefined, 15_000)
    await sleep(1_000)
    if (!(await box("chatComposer"))?.active) await clickInPage('textarea[data-surface="chatComposer"]')
    await press("End")
    await typeInto("chatComposer", "why does this loop?")
    await shot(`c9-thread-selection-chip-dark-${tag}`, { window: true })
    await agent({ op: "config", section: "workbench", key: "colorTheme", value: "Default Light Modern" })
    await until(async () => (await inPage(() => document.documentElement.dataset.theme)) === "light", 8_000)
    await shot(`c9-thread-selection-chip-light-${tag}`)
    await agent({ op: "config", section: "workbench", key: "colorTheme", value: "Default Dark Modern" })
    await until(async () => (await inPage(() => document.documentElement.dataset.theme)) === "dark", 8_000)

    await clickInComposer("chatComposer", "[data-editor-open-files]")
    const menuOpen = async () => (await inPage(() => [...document.querySelectorAll("[data-editor-open-file]")].some((item) => item.getClientRects().length > 0)))
    if (await until(menuOpen, 5_000)) {
      await shot(`c9-open-files-menu-${tag}`)
      // Escape only with the menu up: with nothing over the drawer it would close the drawer.
      await press("Escape")
      await until(async () => !(await menuOpen()), 3_000)
      await sleep(500)
      const stillOpen = await drawerOpen()
      expect("c9", `${tag}: Escape on the open-files menu closes the menu and leaves the thread open`, stillOpen, { drawerOpen: stillOpen })
      if (!stillOpen) await openThreadRow()
    }
    await sleep(300)
    await clearBox("chatComposer")

    await clickInWorkbench('.part.sidebar .title-actions .action-label[aria-label="Settings"]')
    await until(async () => (await inPage(() => !!document.querySelector('[data-settings-editor="appearance"]'))), 8_000)
    await sleep(800)
    // Opened from a thread: Settings must be what the human sees, not something under the drawer.
    const onTop = await inPage(() => {
      const settings = document.querySelector<HTMLElement>('[data-settings-editor="appearance"]')
      const r = settings?.getBoundingClientRect()
      if (!settings || !r) return { onTop: false, hit: null }
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 10))
      const panel = settings.closest<HTMLElement>("[class*='translate-x']") ?? settings.parentElement
      return { onTop: !!hit && (settings.contains(hit) || !!panel?.contains(hit)), hit: hit ? `${hit.tagName.toLowerCase()}.${String((hit as HTMLElement).className).slice(0, 60)}` : null }
    })
    expect("c9", `${tag}: Settings, opened from the title row over a thread, is drawn on top of the thread`, onTop.onTop, { ...onTop, titleRow: (await titleRow()).text })
    await shot(`c9-settings-${tag}`)
    // …and the keyboard is Settings', not the thread's under it: Escape closes Settings alone, and the thread
    // stays (the thread's dialog held both the trap and Radix's Escape, which closed the thread instead).
    const settingsKeys = await inPage(() => ({ hasFocus: document.hasFocus(), inSettings: !!document.activeElement?.closest("[data-over-drawers]") }))
    const escapeAt = Date.now()
    await press("Escape")
    const settingsGone = await until(async () => !(await inPage(() => !!document.querySelector('[data-settings-editor="appearance"]'))), 5_000)
    await sleep(400)
    const threadStays = await drawerOpen()
    expect("c9", `${tag}: over a thread, the keyboard is in Settings, and Escape closes Settings and leaves the thread`, settingsKeys.inSettings && settingsGone && threadStays, { settingsKeys, settingsGone, threadStays, ...(settingsGone ? {} : { trace: await focusTraceSince(escapeAt - 2_000) }) })
    if (!settingsGone) await resetPage()
    // …and the pointer: a click in Settings is Settings' (the thread's outside-click took it, and closed the
    // thread under Settings). On its title, text, so the click changes nothing but where the pointer went.
    // What the keyboard does after the click is not asserted: VS Code's webview host settles a click's focus
    // on its own schedule, and that dance is not this check's.
    if (settingsGone && threadStays) {
      await clickInWorkbench('.part.sidebar .title-actions .action-label[aria-label="Settings"]')
      await until(async () => (await inPage(() => !!document.querySelector('[data-settings-editor="appearance"]'))), 8_000)
      await sleep(600)
      const title = (await (await frame()).evaluateHandle(() => [...document.querySelectorAll("[data-over-drawers] *")].find((el) => el.children.length === 0 && el.textContent?.trim() === "Settings" && el.getClientRects().length > 0) ?? null)).asElement() as ElementHandle | null
      await clickHandle(title, "Settings' title")
      await sleep(600)
      const afterClick = { settings: await inPage(() => !!document.querySelector('[data-settings-editor="appearance"]')), thread: await drawerOpen() }
      expect("c9", `${tag}: over a thread, a click in Settings leaves Settings and the thread both open`, afterClick.settings && afterClick.thread, afterClick)
      await resetPage()
    }
    if (await drawerOpen()) await clickInWorkbench('.part.sidebar .title-actions .action-label[aria-label="Back to queue"]')
    await until(async () => !(await drawerOpen()), 5_000)
    await focusPageBody()
    await page.keyboard.type("?")
    await until(async () => (await inPage(() => !!document.querySelector("[data-shortcut-list]"))), 5_000)
    await shot(`c9-shortcuts-${tag}`)
    await press("Escape")
    const overflow = await inPage(() => document.documentElement.scrollWidth - innerWidth)
    expect("c9", `${tag}: the gallery was drawn, and nothing overflows sideways`, overflow <= 0, notes[`gallery-${tag}`])
  }
  await run("c9", "the gallery at ~300px and ~450px", async () => {
    const start = await sidebarWidth()
    if (Math.abs(start - 300) > 12) await dragSidebarTo(300)
    await gallery(`w${Math.round(await sidebarWidth())}`)
    await dragSidebarTo(450)
    await gallery(`w${Math.round(await sidebarWidth())}`)
  })

  // ── c10: one switch ──
  /** The worker's `editor` tool, run for real (ntwine-mcp.mjs, as a worker of this window's project runs it). */
  const toolReads = () => workerTool({ node: process.execPath, mcp: join(repo, "cc-worker", "bin", "ntwine-mcp.mjs"), serverLock: stack!.info.launcher.serverLock, projectId: workspace.id, home: stack!.info.home })
  const sharing = () => agent<SettingState>({ op: "inspect", section: "ntwine", key: "shareEditorState" })
  const eye = () => inPage(() => [...document.querySelectorAll<HTMLElement>("[data-editor-context-toggle]")].find((toggle) => toggle.getClientRects().length > 0)?.getAttribute("aria-pressed") ?? null)
  /** Type and send from the reply box; what reached the simulated worker. */
  const sendFromReply = async (text: string) => {
    const before = readFileSync(seeded!.inputs, "utf8").trim().split("\n").filter(Boolean).length
    await clickInPage('textarea[data-surface="chatComposer"]')
    await until(async () => (await box("chatComposer"))?.active === true, 3_000)
    await typeInto("chatComposer", text)
    await press("Enter")
    return waitFor(`"${text}" at the simulated worker`, () => {
      const lines = readFileSync(seeded!.inputs, "utf8").trim().split("\n").filter(Boolean)
      return lines.length > before ? (JSON.parse(lines.at(-1)!) as { id: string; text: string }) : undefined
    }, 20_000)
  }
  await run("c10", "one switch: the eye is ntwine.shareEditorState, for the block a send carries and for the agents' tool", async () => {
    await resetPage()
    await openThreadRow()
    await openInEditor(files.sample, [1, 0, 2, -1])
    await waitFor("the reply box's bar on the selection", async () => (await contextBar("chatComposer"))?.kind === "selection" || undefined, 5_000)
    const on = await waitFor("the tool reading lines 2-3", async () => {
      const text = await toolReads()
      return /lines 2-3 selected/u.test(text) ? text : undefined
    }, 20_000).catch(toolReads)
    expect("c10", "sharing on: the agents' tool reads the selection, lines 2-3 with their text", /lines 2-3 selected/u.test(on) && on.includes("let total = 0"), on.slice(0, 500))

    // The eye, clicked off: the setting, the tool, the bar and the next send all follow.
    await clickInComposer("chatComposer", "[data-editor-context-toggle]")
    const off = await waitFor("the setting off", async () => {
      const state = await sharing()
      return state.value === false ? state : undefined
    }, 8_000).catch(sharing)
    expect("c10", "the eye, clicked off, turns ntwine.shareEditorState off (the user's value, so every window)", off.value === false && off.globalValue === false, off)
    const offText = await waitFor("the tool reading nothing", async () => {
      const text = await toolReads()
      return /turned off sharing/u.test(text) ? text : undefined
    }, 10_000).catch(toolReads)
    expect("c10", "…the agents' tool reads nothing, and says the human turned sharing off", /turned off sharing/u.test(offText) && !offText.includes("let total = 0"), offText.slice(0, 400))
    expect("c10", "…the eye shows off", (await eye()) === "false", await contextBar("chatComposer"))
    await shot("c10-eye-off-w300")
    const unshared = await sendFromReply("what does this do?")
    expect("c10", "…and a send carries no editor context", unshared.text.startsWith("what does this do?") && parseSentEditorContext(unshared.text) === null && !unshared.text.includes("let total = 0"), unshared.text.slice(0, 400))

    // On again from VS Code's side (Settings, another window): the eye follows, and so does everything else.
    await agent({ op: "config", section: "ntwine", key: "shareEditorState", value: true })
    expect("c10", "the setting turned on in VS Code turns the eye on", await until(async () => (await eye()) === "true", 8_000), await contextBar("chatComposer"))
    const back = await waitFor("the tool reading lines 2-3 again", async () => {
      const text = await toolReads()
      return /lines 2-3 selected/u.test(text) ? text : undefined
    }, 20_000).catch(toolReads)
    expect("c10", "…the agents' tool reads the selection again", /lines 2-3 selected/u.test(back), back.slice(0, 300))
    const shared = await sendFromReply("and now?")
    const block = parseSentEditorContext(shared.text)
    const lines23 = SAMPLE.split("\n").slice(1, 3).join("\n")
    expect("c10", "…a send carries the block: lines 2-3 of sample.ts, quoted", block?.editor.kind === "selection" && block.editor.startLine === 2 && block.editor.endLine === 3 && block.editor.text === lines23 && block.body === "and now?", { text: shared.text.slice(0, 600), block })
    // The same selection again: named, not quoted a second time (the agent has it, one message up). The
    // page reads "one message up" from the thread's transcript, so the sent message must be in it first.
    await until(async () => (await inPage(() => document.body.innerText.includes("and now?"))), 15_000)
    await sleep(500)
    const again = await sendFromReply("and again?")
    const repeat = parseSentEditorContext(again.text)
    expect("c10", "…and the same selection on the next send is named, not quoted again", repeat?.editor.kind === "selection" && repeat.editor.repeat === true && repeat.editor.startLine === 2 && !again.text.includes("let total = 0"), { text: again.text.slice(0, 600), repeat })
    await agent({ op: "config", section: "ntwine", key: "shareEditorState", value: null })
  })

  // ── c11: Claude Code's Alt+K ──
  await run("c11", "with Claude Code's extension installed, Alt+K is its: ntwine steps aside, and takes it back when it goes", async () => {
    await resetPage()
    await openThreadRow()
    await clearBox("chatComposer")
    await agent({ op: "install", vsix: claudeCodeStandIn }, 120_000)
    const installed = await until(async () => await agent<boolean>({ op: "extension", id: "anthropic.claude-code" }), 20_000)
    expect("c11", "the stand-in with Claude Code's id installs live, with no reload", installed)
    await sleep(1_000)
    await openInEditor(files.sample, [3, 1, 3, 1])
    await sleep(800)
    await press("Alt+KeyK")
    await sleep(1_500)
    const theirs = { box: await box("chatComposer"), editor: await editorState() }
    const lastLine = SAMPLE.split("\n").length - 1
    expect("c11", "Alt+K adds nothing to ntwine's prompt box", !/sample\.ts/u.test(theirs.box?.value ?? ""), theirs.box)
    expect("c11", "…it is Claude Code's: the stand-in's binding answered (Select All)", theirs.editor.selection?.start.join() === "0,0" && theirs.editor.selection.end[0] === lastLine, theirs.editor)
    await focusPageBody()
    await page.keyboard.type("?")
    await until(async () => (await inPage(() => !!document.querySelector("[data-shortcut-list]"))), 5_000)
    const rows = await inPage(() => [...document.querySelectorAll<HTMLElement>("[data-shortcut-editor] li")].map((row) => row.querySelector("[aria-label]")?.getAttribute("aria-label") ?? ""))
    expect("c11", "…and the ? sheet no longer lists Alt+K", rows.length > 0 && !rows.includes("Alt+K"), rows)
    await shot("c11-shortcuts-with-claude-code-w300")
    await press("Escape")

    await command("workbench.extensions.uninstallExtension", "anthropic.claude-code")
    const gone = await until(async () => !(await agent<boolean>({ op: "extension", id: "anthropic.claude-code" })), 20_000)
    expect("c11", "the stand-in uninstalls, live", gone)
    if (!(await drawerOpen())) await openThreadRow()
    await openInEditor(files.sample, [3, 1, 3, 1])
    await sleep(800)
    await press("Alt+KeyK")
    // A whole file with no text lands as a reference to it (lib/editorCompose.ts), `src/sample.ts`.
    const ours = await waitFor("the file from Alt+K", async () => {
      const state = await box("chatComposer")
      return /sample\.ts/u.test(state?.value ?? "") ? state : undefined
    }, 8_000).catch(async () => box("chatComposer"))
    expect("c11", "…and Alt+K is ntwine's again: the whole file into the reply box", /sample\.ts(?!:)/u.test(ours?.value ?? ""), ours)
    await clearBox("chatComposer")
  })

  // ── c12: the window's own thread ──
  await run("c12", "a window opened on a thread's worktree opens the sidebar on that thread", async () => {
    const first = notes.firstRoute as string | null
    if (!worktreeThread) {
      expect("c12", "a window on the project itself opens on the queue, not on a thread", first !== null && !/\/thread\//u.test(first), { firstRoute: first })
      return
    }
    const onIt = (href: string | null | undefined) => !!href && new URL(href).pathname.endsWith(`/thread/${worktreeThread.slug}`)
    const href = await waitFor(`the sidebar on ${worktreeThread.slug}`, async () => {
      const now = (await status()).sidebar.href
      return onIt(now) ? now : undefined
    }, 20_000).catch(async () => (await status()).sidebar.href)
    expect("c12", "the sidebar's page is on the worktree's thread, with nothing here asking it to be", onIt(href), { firstRoute: first, href })
    const shown = await waitFor("the thread's drawer", async () => {
      const read = await inPage((title) => {
        const drawer = [...document.querySelectorAll<HTMLElement>("[data-drawer-layer]")].at(-1)
        return drawer && drawer.innerText.includes(title) ? { title, composer: !!drawer.querySelector('textarea[data-surface="chatComposer"]') } : undefined
      }, worktreeThread.title)
      return read
    }, 15_000).catch(() => undefined)
    expect("c12", "the page shows that thread, its title and its reply box", !!shown?.composer, shown)
    const said = ntwineLog().split("\n").find((line) => line.includes(`worktree of thread ${worktreeThread.slug}`))
    expect("c12", "the extension says why it opened there", !!said, said?.trim())
    await shot("c12-worktree-window-thread", { window: true })
    // A link the thread wrote into its worktree, to a file only the main checkout has (as every link is
    // once Done removed the worktree): clicked in the sidebar, the extension finds it missing, asks ntwine
    // (settleLocalPath) and opens the main checkout's copy at the linked line — not "doesn't exist".
    const { linked, main } = worktreeThread.onlyMain
    await clickTextInPage("[data-local-path]", "only-main.ts")
    const opened = await waitFor("the main checkout's copy in the editor", async () => {
      const now = await editorState()
      return now.path === main && now.selection?.start[0] === 1 ? now : undefined
    }, 15_000).catch(async () => editorState())
    const settledLine = ntwineLog().split("\n").find((line) => line.includes(`${linked} is gone`))
    expect("c12", "a link into the worktree to a file it doesn't have opens the main checkout's copy, at its line", opened.path === main && opened.selection?.start[0] === 1, { linked, opened, log: settledLine?.trim() })
    await shot("c12-settled-link", { window: true })
  })

  /**
   * The text gap between a row's two parts (its name and its dimmed tail), from the text's own boxes
   * (Range rects, so a span's padding does not count), and each part's baseline offset — for every row
   * `selector` matches whose first two element children both hold text. Equal gaps and baselines across
   * the rows of one menu is the claim: a file row and a thread row, an extras row and an open-file row,
   * read as one list.
   */
  const rowGaps = (selector: string) =>
    inPage((sel) => [...document.querySelectorAll<HTMLElement>(sel)].filter((row) => row.getClientRects().length > 0).map((row) => {
      const parts = [...row.querySelectorAll<HTMLElement>(":scope > span, :scope > span > span")].filter((part) => part.children.length === 0 && part.textContent?.trim())
      if (parts.length < 2) return null
      const box = (el: HTMLElement) => {
        const range = document.createRange()
        range.selectNodeContents(el)
        const r = range.getBoundingClientRect()
        return { left: r.left, right: r.right, bottom: r.bottom }
      }
      const [a, b] = [box(parts[0]!), box(parts[1]!)]
      return { row: row.innerText.replace(/\s+/gu, " ").trim().slice(0, 50), gap: Math.round((b.left - a.right) * 100) / 100, sizes: [getComputedStyle(parts[0]!).fontSize, getComputedStyle(parts[1]!).fontSize] }
    }).filter(Boolean), selector)

  // ── c13: `@` files ──
  await run("c13", "`@` in a prompt box offers the workspace's files", async () => {
    await command("workbench.view.extension.ntwine")
    await waitFor("the ntwine view", async () => (await status()).sidebar.visible || undefined, 10_000)
    await resetPage()
    // A gitignored copy, where an ntwine checkout keeps its threads' worktrees: never offered.
    mkdirSync(join(workspace.dir, "ignored-copy"), { recursive: true })
    writeFileSync(join(workspace.dir, "ignored-copy", "sample.ts"), SAMPLE)
    appendFileSync(join(workspace.dir, ".git", "info", "exclude"), "\nignored-copy/\n")
    const label = relative(workspace.dir, files.sample).split("\\").join("/")
    await clearBox("newComposer")
    await clickInPage('textarea[data-surface="newComposer"]')
    await until(async () => (await box("newComposer"))?.active === true, 3_000)
    await typeInto("newComposer", "look at @samp")
    const rows = await waitFor("file rows in the @ menu", async () => {
      const found = await inPage(() => [...document.querySelectorAll<HTMLElement>("[data-mention-file]")].map((row) => row.dataset.mentionFile ?? ""))
      return found.length ? found : undefined
    }, 15_000).catch(() => [] as string[])
    expect("c13", `the @ menu lists ${label}, and not the gitignored copy`, rows.includes(label) && !rows.some((row) => row.startsWith("ignored-copy")), rows)
    notes.atMenu = await inPage(() => [...document.querySelectorAll<HTMLElement>("[data-mention-menu] [role=option]")].map((row) => row.innerText.replace(/\s+/gu, " ").trim()))
    const gaps = (await rowGaps("[data-mention-menu] [role=option]")) as { row: string; gap: number }[]
    notes.atMenuGaps = gaps
    // The rows' classes are the thread rows' own (`gap-2`, the handle's and the status's sizes), and a thread
    // row with no status has nothing to measure: the file row's text gap is that gap.
    expect("c13", "a file row spaces its name and folder by the menu's own gap (8px of text, as a thread's handle and status)", gaps.length >= 1 && gaps.every((g) => Math.abs(g.gap - 8) < 0.5), gaps)
    await shot("c13-at-files-menu-w300")
    const menu = await rectOf(".part.sidebar")
    if (menu) await capture(join(out, `${version}-c13-at-files-menu-6x.png`), { x: menu.x, y: menu.y, width: menu.width, height: Math.min(menu.height, 420) }, 6).catch(() => undefined)
    const index = await inPage((l) => Number(document.querySelector<HTMLElement>(`[data-mention-file="${l}"]`)?.dataset.suggestIndex ?? -1), label)
    for (let i = 0; i < index; i++) await press("ArrowDown")
    await press("Enter")
    const written = await waitFor("the reference in the box", async () => {
      const state = await box("newComposer")
      return state?.value.includes("`") ? state : undefined
    }, 5_000).catch(async () => box("newComposer"))
    expect("c13", "Enter writes the whole-file reference where the @ was, the caret after it", written?.value === `look at \`${label}\` ` && written.caret === written.value.length && written.active, written)
    await clearBox("newComposer")
  })

  // ── c14: a drag from the explorer ──
  await run("c14", "a file dragged from the explorer lands in the prompt box", async () => {
    // Both in sight at once: the ntwine view moved in as a pane of the Explorer's side bar.
    await command("vscode.moveViews", { viewIds: ["ntwine.sidebar"], destinationId: "workbench.view.explorer" })
    try {
      await command("ntwine.sidebar.focus")
      await waitFor("the page ready in the Explorer", async () => (await status()).sidebar.ready || undefined, 60_000)
      await openInEditor(files.sample)
      await command("workbench.files.action.showActiveFileInExplorer")
      const name = files.sample.split(/[\\/]/u).pop()!
      const row = await waitFor("the file's row in the explorer", async () => {
        const handle = (await page.evaluateHandle((n) => [...document.querySelectorAll(".explorer-folders-view .monaco-list-row")].find((r) => r.querySelector(".label-name")?.textContent === n) ?? null, name)).asElement() as ElementHandle | null
        return handle && (await handle.boundingBox()) ? handle : undefined
      }, 10_000)
      const from = (await row.boundingBox())!
      const target = await waitFor("the prompt box", async () => {
        const handle = (await (await frame()).evaluateHandle(() => [...document.querySelectorAll('textarea[data-surface="newComposer"]')].find((t) => t.getClientRects().length > 0) ?? null)).asElement() as ElementHandle | null
        return handle && (await handle.boundingBox()) ? (await handle.boundingBox())! : undefined
      }, 10_000)
      await shot("c14-explorer-and-ntwine", { window: true })
      const to = { x: target.x + target.width / 2, y: target.y + target.height / 2 }
      // A real drag: a trusted press and move on the explorer's row, so VS Code's own dragstart fills the
      // drag (read back from the workbench as it bubbles out), intercepted by DevTools so it can be carried
      // to the drop; then trusted drag events at the prompt box, Shift held, which VS Code requires of a
      // drop into any webview (its WebviewWindowDragMonitor turns the webview's pointer events off for a
      // drag without it).
      type DragItem = { mimeType: string; data: string }
      type DragData = { items: DragItem[]; dragOperationsMask: number }
      await page.evaluate(() => {
        const w = window as unknown as { __ntwineDrag?: DragItem[] | null }
        w.__ntwineDrag = null
        window.addEventListener("dragstart", (event) => {
          w.__ntwineDrag = [...(event.dataTransfer?.types ?? [])].map((type) => ({ mimeType: type, data: event.dataTransfer!.getData(type) }))
        }, { once: true })
      })
      // Where the drop's events land: the workbench (with VS Code's pointer-events state on the webview) and
      // the page, so a trusted drop that does not arrive says where it stopped.
      await page.evaluate(() => {
        const w = window as unknown as { __ntwineDragEvents?: string[] }
        w.__ntwineDragEvents = []
        for (const type of ["dragenter", "dragover", "drop"]) {
          window.addEventListener(type, (event) => {
            const target = event.target as HTMLElement
            const webview = document.querySelector<HTMLElement>("iframe.webview")
            if (w.__ntwineDragEvents!.length < 40) w.__ntwineDragEvents!.push(`${type} on ${target.tagName}.${String(target.className).slice(0, 30)} shift=${(event as DragEvent).shiftKey} webview-pointer=${webview?.style.pointerEvents ?? "?"}`)
          }, true)
        }
      })
      await inPage(() => {
        const w = window as unknown as { __ntwineDragEvents?: string[] }
        w.__ntwineDragEvents = []
        for (const type of ["dragenter", "dragover", "drop"]) window.addEventListener(type, (event) => { if (w.__ntwineDragEvents!.length < 40) w.__ntwineDragEvents!.push(`${type} shift=${(event as DragEvent).shiftKey}`) }, true)
      })
      await cdp.send("Input.setInterceptDrags", { enabled: true })
      const intercepted = new Promise<DragData>((resolveDrag) => cdp.once("Input.dragIntercepted", (event: { data: DragData }) => resolveDrag(event.data)))
      const mouse = (type: "mousePressed" | "mouseMoved" | "mouseReleased", x: number, y: number) =>
        cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 })
      const sx = from.x + from.width / 3
      const sy = from.y + from.height / 2
      await mouse("mouseMoved", sx, sy)
      await mouse("mousePressed", sx, sy)
      for (let step = 1; step <= 6; step++) await mouse("mouseMoved", sx + step * 4, sy + step * 3)
      const caught = await Promise.race([intercepted, sleep(3_000).then(() => undefined)])
      const started = await page.evaluate(() => (window as unknown as { __ntwineDrag?: DragItem[] | null }).__ntwineDrag ?? null)
      const data: DragData | undefined = caught ?? (started?.length ? { items: started, dragOperationsMask: 1 } : undefined)
      notes.explorerDrag = { intercepted: !!caught, dragstart: started?.map((item) => item.mimeType) ?? null, items: data?.items.map((item) => ({ type: item.mimeType, data: item.data.slice(0, 200) })) }
      let how = "none"
      if (data) {
        for (const type of ["dragEnter", "dragOver", "dragOver", "dragOver", "drop"] as const) {
          await cdp.send("Input.dispatchDragEvent", { type, x: to.x, y: to.y, data, modifiers: 8 }).catch((error: unknown) => {
            notes.explorerDragError = String(error)
          })
          await sleep(150)
        }
        how = caught ? "trusted drag, intercepted" : "trusted drop events carrying VS Code's dragstart data"
      }
      await mouse("mouseReleased", to.x, to.y)
      await cdp.send("Input.setInterceptDrags", { enabled: false })
      notes.explorerDragEvents = {
        workbench: await page.evaluate(() => (window as unknown as { __ntwineDragEvents?: string[] }).__ntwineDragEvents ?? []),
        page: await inPage(() => (window as unknown as { __ntwineDragEvents?: string[] }).__ntwineDragEvents ?? []),
      }
      const label = relative(workspace.dir, files.sample).split("\\").join("/")
      let landed = await until(async () => (await box("newComposer"))?.value.includes(`\`${label}\``) === true, 6_000)
      if (!landed && data) {
        // DevTools' drag events go to the window's root frame, which hands nothing on to an out-of-process
        // frame: the workbench sees the dragenter that turns the webview's pointer events on, and the page
        // nested inside it never sees a drag event at all. The same intercepted drag, then, dispatched by
        // DevTools to the page's OWN frame: still trusted events, Shift held, carrying the data as Chromium
        // presents it to a page (not as a script would build it), though VS Code's routing is skipped.
        notes.explorerTrustedMiss = how
        // (A frame's DevTools session is puppeteer's internal `client`, not in its public types.)
        const sessionOf = (f: Frame) => (f as unknown as { client: CDPSession }).client
        const frameSession = sessionOf(await frame())
        if (frameSession.id() !== sessionOf(page.mainFrame()).id()) {
          const at = await inPage(() => {
            const rect = [...document.querySelectorAll<HTMLTextAreaElement>('textarea[data-surface="newComposer"]')].find((t) => t.getClientRects().length > 0)!.getBoundingClientRect()
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
          })
          for (const type of ["dragEnter", "dragOver", "dragOver", "drop"] as const) {
            await frameSession.send("Input.dispatchDragEvent", { type, x: at.x, y: at.y, data, modifiers: 8 }).catch((error: unknown) => {
              notes.explorerFrameDragError = String(error)
            })
            await sleep(150)
          }
          notes.explorerFrameDragEvents = await inPage(() => (window as unknown as { __ntwineDragEvents?: string[] }).__ntwineDragEvents ?? [])
          landed = await until(async () => (await box("newComposer"))?.value.includes(`\`${label}\``) === true, 6_000)
          if (landed) how = "trusted drop dispatched to the page's frame"
        } else notes.explorerFrameDragError = "the page shares the workbench's process"
      }
      if (!landed && data) {
        // Neither reached the page: the same data, dropped by script on the box.
        how = "synthesized"
        await inPage((items) => {
          const area = [...document.querySelectorAll<HTMLTextAreaElement>('textarea[data-surface="newComposer"]')].find((t) => t.getClientRects().length > 0)!
          const transfer = new DataTransfer()
          for (const item of items) transfer.setData(item.mimeType, item.data)
          area.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer, shiftKey: true }))
          area.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer, shiftKey: true }))
        }, data.items)
        landed = await until(async () => (await box("newComposer"))?.value.includes(`\`${label}\``) === true, 6_000)
      }
      notes.explorerDrop = how
      const state = await box("newComposer")
      expect("c14", `the dropped file is a whole-file reference in the box (${how})`, landed && how !== "none", { how, value: state?.value, drag: notes.explorerDrag })
      expect("c14", "the drag carried VS Code's own resource types", !!data?.items.some((item) => /resourceurls|vnd\.code\.uri-list/iu.test(item.mimeType)), notes.explorerDrag)
      await shot("c14-dropped-reference", { window: true })
      await clearBox("newComposer").catch(() => undefined)
    } finally {
      // The intercepted drag's drop went nowhere, so the workbench still thinks a drag is under way and
      // swallows every later mouse press on it (c16's toast button among them): cancelled, as a hand
      // letting go outside any target would.
      await cdp.send("Input.dispatchDragEvent", { type: "dragCancel", x: 0, y: 0, data: { items: [], dragOperationsMask: 1 } }).catch((error: unknown) => {
        notes.explorerDragCancel = String(error)
      })
      await cdp.send("Input.setInterceptDrags", { enabled: false }).catch(() => undefined)
      await command("vscode.moveViews", { viewIds: ["ntwine.sidebar"], destinationId: "workbench.view.extension.ntwine" })
      await command("workbench.view.extension.ntwine")
      await waitFor("the page ready back in its own view", async () => (await status()).sidebar.ready || undefined, 60_000).catch(() => undefined)
    }
  })

  // ── c15: the file's problems and the terminal's last command, from the bar's menu ──
  await run("c15", "the bar's menu adds the file's problems and the terminal's last command", async () => {
    await command("workbench.view.extension.ntwine")
    await waitFor("the ntwine view", async () => (await status()).sidebar.visible || undefined, 10_000)
    await resetPage()
    await clearBox("newComposer")
    await openInEditor(files.broken)
    await waitFor("TypeScript's error in broken.ts", async () => {
      const found = await agent<{ source: string | null }[]>({ op: "diagnostics", path: files.broken })
      return found.some((d) => d.source === "ts") || undefined
    }, 90_000)
    const ran = await agent<{ exitCode: unknown }>({ op: "terminal", command: "echo ntwine-from-the-terminal" })
    notes.terminalRun = ran
    await openInEditor(files.broken)
    const extra = (what: string) => inPage((w) => [...document.querySelectorAll<HTMLElement>(`[data-editor-extra="${w}"]`)].filter((row) => row.getClientRects().length > 0).map((row) => row.innerText.replace(/\s+/gu, " ").trim())[0] ?? null, what)
    const openMenu = async () => {
      await clickInComposer("newComposer", "[data-editor-open-files]")
      return until(async () => (await extra("problems")) !== null && (await extra("terminal")) !== null, 5_000)
    }
    await installFocusTrace()
    const menuAt = Date.now()
    const eventsAt = (await status()).sidebar.events.length
    const shown = await openMenu()
    const problemsRow = await extra("problems")
    const terminalRow = await extra("terminal")
    expect("c15", "the menu offers the file's problems with their counts", shown && /^Add problems in this file 1 error$/u.test(problemsRow ?? ""), problemsRow)
    // VS Code tells extensions each command line only from 1.93 (shell integration's executions). Before
    // that the menu offers the last command without naming it, and adding it borrows the terminal's own
    // Copy Last Command (extras-feed.ts) — the floor's graceful path, checked as that, not failed as the
    // other.
    if (hasShellExecutions(version)) expect("c15", "…and the terminal's last command, by its line", /^Add last terminal command echo ntwine-from-the-terminal$/u.test(terminalRow ?? ""), { terminalRow, ran })
    else expect("c15", `…and the terminal's last command, unnamed: VS Code ${version} tells extensions no command line before 1.93`, terminalRow === "Add last terminal command" && ran.exitCode === "not reported before 1.93", { terminalRow, ran })
    await shot("c15-bar-menu-extras-w300")
    const extraGaps = (await rowGaps("[data-editor-extra], [data-editor-open-file]")) as { row: string; gap: number }[]
    notes.barMenuGaps = extraGaps
    expect("c15", "the extras rows space their name and tail as the open-file rows do", extraGaps.length >= 2 && Math.max(...extraGaps.map((g) => g.gap)) - Math.min(...extraGaps.map((g) => g.gap)) < 0.5, extraGaps)
    const menuBox = await inPage(() => {
      const r = document.querySelector('[data-editor-extra="problems"]')?.closest("[role=menu]")?.getBoundingClientRect()
      return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null
    })
    const frameBox = await (await (await frame()).frameElement())?.boundingBox()
    if (menuBox && frameBox) await capture(join(out, `${version}-c15-bar-menu-extras-6x.png`), { x: frameBox.x + menuBox.x - 4, y: frameBox.y + menuBox.y - 4, width: menuBox.width + 8, height: menuBox.height + 8 }, 6).catch(() => undefined)
    await clickInPage('[data-editor-extra="problems"]')
    const withProblems = await waitFor("the @problems chip", async () => {
      const state = await box("newComposer")
      return state?.value.includes("@problems") ? state : undefined
    }, 8_000).catch(async () => box("newComposer"))
    if (!withProblems?.value.includes("@problems")) notes.extrasClick = {
      frames: await framesAlive(),
      clicks: [...clicks],
      focus: await workbenchFocus(),
      menuOpen: await inPage(() => document.querySelector('[data-editor-extra="problems"]')?.closest("[role=menu]") !== null),
      boxes: await inPage(() => [...document.querySelectorAll<HTMLTextAreaElement>("textarea[data-surface]")].map((t) => ({ surface: t.dataset.surface, shown: t.getClientRects().length > 0, value: t.value.slice(0, 60) }))),
      log: ntwineLog().split("\n").slice(-12),
      events: (await status()).sidebar.events.slice(eventsAt),
      trace: await focusTraceSince(menuAt),
    }
    expect("c15", "Add problems puts one @problems chip in the box, drawn as a pill", !!withProblems?.pills.some((pill) => pill.token === "@problems"), withProblems)
    await openMenu()
    await clickInPage('[data-editor-extra="terminal"]')
    const withTerminal = await waitFor("the @terminal chip", async () => {
      const state = await box("newComposer")
      return state?.value.includes("@terminal") ? state : undefined
    }, 8_000).catch(async () => box("newComposer"))
    expect("c15", "Add last terminal command puts one @terminal chip in the box", !!withTerminal?.pills.some((pill) => pill.token === "@terminal"), withTerminal)
    await shot("c15-chips-w300")
    await clearBox("newComposer")
    await command("workbench.action.closePanel")
  })

  // ── c16: a thread that needs you, while the sidebar is out of sight ──
  await run("c16", "a thread that needs you is a notification while the sidebar is hidden", async () => {
    await resetPage()
    await command("workbench.view.explorer")
    await waitFor("the ntwine view hidden", async () => !(await status()).sidebar.visible || undefined, 10_000)
    await command("notifications.clearAll")
    // The thread leaves the queue and comes back to it through the REAL server: snoozed, then woken
    // (the board's Wake now), so it enters the queue again needing the human — the server's own needs-you
    // edge (board.ts notifyNeedsYou), the one the page's notifications ride. (Not a follow-up: the
    // simulated worker answers one, but never clears the delivery the server holds the thread out of the
    // queue for, so its rest never reaches the queue.)
    const rpc = new NtwineRpc(origin)
    // At rest first. Earlier checks send the thread messages (c10's one-switch sends among them), and the
    // simulated worker answers each with a turn; a thread still mid-turn enters the queue only when that
    // turn ends, so the notification came 30s+ after the wake in a full run and the check timed out on a
    // notification that did arrive (integrated run, 2026-10-02: "Told you" logged, Open then worked).
    await waitFor("the thread at rest", async () => {
      const board = await rpc.query(workspace.id, "board")
      const thread = board.threads.find((t) => t.id === seeded!.thread.slug)
      return thread && thread.runtime !== "running" && thread.needsYou ? true : undefined
    }, 60_000).catch(() => undefined)
    await rpc.mutation(workspace.id, "setThreadSnooze", { slug: seeded!.thread.slug, sessionId: seeded!.thread.sessionId, until: new Date(Date.now() + 3_600_000).toISOString() })
    await sleep(3_000)
    await rpc.mutation(workspace.id, "setThreadSnooze", { slug: seeded!.thread.slug, sessionId: seeded!.thread.sessionId, until: null })
    const toast = await waitFor("the notification", async () => {
      const text = await inWorkbench(() => [...document.querySelectorAll<HTMLElement>(".notification-toast")].map((t) => t.innerText.replace(/\s+/gu, " ").trim()).find((t) => /Open/u.test(t)) ?? null)
      return text ?? undefined
    }, 30_000).catch(() => null)
    expect("c16", "a VS Code notification names the thread and what it needs, with Open", !!toast && toast.includes(seeded!.thread.handle), { toast, log: ntwineLog().split("\n").filter((line) => /needs|notif|attention/iu.test(line)).slice(-5) })
    await shot("c16-notification", { window: true })
    // The toast slides in: pressed where it comes to rest, as a hand would, and again if the first press
    // found it still moving. An info toast also hides itself after a while in a focused window (it is
    // still in the notification list then, where a hand would find it), so the list is the fallback.
    const findOpen = async () => (await page.evaluateHandle(() => [...document.querySelectorAll<HTMLElement>(".notification-toast .monaco-button, .notifications-center .monaco-button")].find((button) => button.textContent?.trim() === "Open" && button.getClientRects().length > 0) ?? null)).asElement() as ElementHandle | null
    const pressed: string[] = []
    let shown: boolean | undefined = false
    for (let attempt = 0; attempt < 3 && !shown; attempt++) {
      await sleep(800)
      let open = await findOpen()
      if (open) pressed.push("toast")
      else {
        await command("notifications.showList")
        await sleep(600)
        open = await findOpen()
        pressed.push(open ? "notification list" : "no Open in sight")
      }
      if (open) {
        const at = (await open.boundingBox())!
        const x = at.x + at.width / 2
        const y = at.y + at.height / 2
        pressed.push(await page.evaluate((px, py) => {
          const hit = document.elementFromPoint(px, py) as HTMLElement | null
          return `hit ${hit?.tagName}.${String(hit?.className).slice(0, 40)} "${hit?.textContent?.trim().slice(0, 20)}" at ${Math.round(px)},${Math.round(py)} of ${innerWidth}x${innerHeight}`
        }, x, y))
        await clickHandle(open, "the notification's Open")
        await sleep(300)
        pressed.push(`after: ${await page.evaluate(() => document.querySelectorAll(".notification-toast").length)} toasts`)
      }
      shown = await waitFor("the thread in the sidebar", async () => ((await status()).sidebar.visible && (await drawerOpen())) || undefined, 8_000).catch(() => false)
    }
    notes.attentionOpen = { pressed, log: ntwineLog().split("\n").filter((line) => /Told you|Opening/u.test(line)).slice(-3) }
    expect("c16", "Open brings the sidebar back on that thread", shown === true, (await status()).sidebar)
    await shot("c16-opened-thread-w300")
  })

  // ── c18: the editor's colours ──
  await run("c18", "the page wears the editor theme's colours, and ntwine's own with ntwine.matchEditorTheme off", async () => {
    // Where the page's background shows bare, in the WORKBENCH's pixels: a point whose element and every
    // ancestor paint no background but the page's own, in a 5x5 patch of one colour, in the frame's lower right (the list's
    // empty tail). The page's (0,0) is the sidebar webview element's corner: VS Code's host document and
    // the relay each frame the next full-bleed, and the relay's "hasn't loaded" bar is hidden.
    const pagePixels = async (shot: Buffer) => {
      const image = decodePng(shot)
      const webview = await page.evaluate(() => {
        const bar = document.querySelector(".part.sidebar")!.getBoundingClientRect()
        const frames = [...document.querySelectorAll<HTMLElement>("iframe.webview")].map((f) => f.getBoundingClientRect()).filter((r) => r.width > 0 && r.left >= bar.left - 1 && r.right <= bar.right + 1)
        const r = frames[0]
        return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null
      })
      if (!webview) throw new Error("no webview in the side bar")
      const candidates = await inPage(() => {
        // Bare: nothing between the point and the body paints anything but the page's own background
        // (the list's containers paint `bg-bg` themselves, which is the colour under test, so they count).
        const page = getComputedStyle(document.body).backgroundColor
        const bare = (element: Element | null) => {
          for (let e = element; e && e !== document.documentElement; e = e.parentElement) {
            if (e === document.body) return true
            const cs = getComputedStyle(e)
            if ((cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== page) || cs.backgroundImage !== "none") return false
          }
          return true
        }
        const out: [number, number][] = []
        for (let y = innerHeight - 8; y > innerHeight * 0.4 && out.length < 40; y -= 10) {
          for (let x = innerWidth - 12; x > innerWidth * 0.5 && out.length < 40; x -= 10) if (bare(document.elementFromPoint(x, y))) out.push([x, y])
        }
        return out
      })
      const same = (a: number[], b: number[], tolerance = 1) => a.every((v, k) => Math.abs(v - b[k]!) <= tolerance)
      for (const [x, y] of candidates) {
        const [wx, wy] = [Math.round(webview.x + x), Math.round(webview.y + y)]
        const centre = image.px(wx, wy)
        let flat = true
        for (let dx = -2; dx <= 2 && flat; dx++) for (let dy = -2; dy <= 2 && flat; dy++) flat = same(image.px(wx + dx, wy + dy), centre, 0)
        if (flat) return { at: [wx, wy], rgb: centre }
      }
      return null
    }
    // The side bar's own surface, beside the frame: its title row's left padding, before the label.
    const sideBarPixel = async (shot: Buffer) => {
      const title = await rectOf(".part.sidebar > .composite.title")
      if (!title) throw new Error("no side bar title row")
      const at = [title.x + 6, title.y + Math.round(title.height / 2)] as const
      return { at, rgb: decodePng(shot).px(at[0], at[1]) }
    }
    // The page's own reading of its tokens, painted over its background in its own canvas: contrast ratios.
    const legibility = async () => {
      const painted = await inPage(() => {
        const ctx = document.createElement("canvas").getContext("2d")!
        const probe = document.createElement("div")
        document.body.append(probe)
        const paint = (token: string, under?: number[]) => {
          probe.style.color = `var(--color-${token})`
          ctx.clearRect(0, 0, 1, 1)
          if (under) {
            ctx.fillStyle = `rgb(${under.join(",")})`
            ctx.fillRect(0, 0, 1, 1)
          }
          ctx.fillStyle = getComputedStyle(probe).color
          ctx.fillRect(0, 0, 1, 1)
          return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)]
        }
        const bg = paint("bg")
        const out = { bg, fg: paint("fg", bg), muted: paint("muted", bg), faint: paint("faint", bg), accent: paint("accent", bg), panel2: paint("panel-2", bg), border: paint("border", bg) }
        probe.remove()
        return out
      })
      const lum = (c: number[]) => {
        const [r, g, b] = c.map((v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 })
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
      }
      const ratio = (a: number[], b: number[]) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return Math.round(((hi! + 0.05) / (lo! + 0.05)) * 100) / 100 }
      return { fg: ratio(painted.fg, painted.bg), muted: ratio(painted.muted, painted.bg), faint: ratio(painted.faint, painted.bg), accent: ratio(painted.accent, painted.bg), mutedOnPanel2: ratio(painted.muted, painted.panel2), border: ratio(painted.border, painted.bg), bg: painted.bg }
    }
    // The side bar with the editor beside it, at 1x, then the side bar at 2x.
    const beside = async (name: string) => {
      const bar = await rectOf(".part.activitybar")
      const sidebar = await rectOf(".part.sidebar")
      if (!bar || !sidebar) return
      await page.mouse.move(sidebar.x + 2, sidebar.y + sidebar.height / 2)
      await sleep(350)
      await capture(join(out, `${version}-c18-${name}-beside.png`), { x: bar.x, y: sidebar.y - 36, width: sidebar.x + sidebar.width - bar.x + 420, height: Math.min(sidebar.height + 36, 760) }, 1)
      await capture(join(out, `${version}-c18-${name}-w300.png`), sidebar, 2)
    }
    const hostColors = () => inPage(() => document.documentElement.dataset.hostColors ?? null)
    const relayBackground = () => tracedFrames().find((f) => f.name === "relay")!.frame.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--vscode-sideBar-background").trim())
    const pageBackground = () => inPage(() => document.documentElement.style.getPropertyValue("--vscode-sideBar-background"))

    await command("workbench.view.extension.ntwine")
    await waitFor("the ntwine view", async () => (await status()).sidebar.visible || undefined, 10_000)
    await resetPage()
    await openInEditor(files.a)
    await openInEditor(files.sample)
    expect("c18", "the page's address carries no theme fragment once it has read it", !(await inPage(() => location.hash)), await inPage(() => location.href))
    const themes = [
      { name: "Default Dark Modern", slug: "dark-modern", light: false, gallery: true },
      { name: "Default Light Modern", slug: "light-modern", light: true, gallery: true },
      { name: "Tomorrow Night Blue", slug: "tomorrow-night-blue", light: false, gallery: true },
      { name: "Solarized Dark", slug: "solarized-dark", light: false, gallery: false },
      { name: "Abyss", slug: "abyss", light: false, gallery: false },
      { name: "Default High Contrast", slug: "hc-dark", light: false, gallery: true },
      { name: "Default High Contrast Light", slug: "hc-light", light: true, gallery: false },
    ]
    const readings: Record<string, unknown> = {}
    try {
      for (const theme of themes) {
        const at = Date.now()
        await agent({ op: "config", section: "workbench", key: "colorTheme", value: theme.name })
        // Followed when the page's own copy of the side bar's colour is the relay's, live, with no reload.
        const followed = await until(async () => (await hostColors()) === "sideBar" && (await inPage(() => document.documentElement.dataset.theme)) === (theme.light ? "light" : "dark") && (await pageBackground()) === (await relayBackground()), 8_000)
        const ms = Date.now() - at
        await resetPage()
        await sleep(500)
        const shot = await capture("")
        const pagePx = await pagePixels(shot)
        const barPx = await sideBarPixel(shot)
        const read = await legibility()
        readings[theme.slug] = { ms, sideBarVar: await relayBackground(), page: pagePx, sideBar: barPx, contrast: read }
        expect("c18", `${theme.name}: the page follows the theme live`, followed, { ms })
        expect("c18", `${theme.name}: the page's background is the side bar's, pixel for pixel`, !!pagePx && pagePx.rgb.every((v, k) => Math.abs(v - barPx.rgb[k]!) <= 1), readings[theme.slug])
        // Text at AA or better, the secondary text clearly below the primary, the accent readable as type.
        expect("c18", `${theme.name}: the text reads (text ≥ 7:1, secondary 4.5:1 and below the text, accent ≥ 4.5:1)`, read.fg >= 7 && read.muted >= 4.5 && read.muted < read.fg && read.accent >= 4.5, read)
        await beside(`${theme.slug}-queue`)
        if (theme.gallery) {
          await openThreadRow()
          await openInEditor(files.sample)
          await selectLines23()
          await sleep(400)
          await clickInPage('textarea[data-surface="chatComposer"]')
          await sleep(300)
          await beside(`${theme.slug}-thread-focused`)
          await clickInComposer("chatComposer", "[data-editor-open-files]")
          if (await until(async () => (await inPage(() => [...document.querySelectorAll("[data-editor-open-file]")].some((item) => item.getClientRects().length > 0))), 5_000)) {
            await capture(join(out, `${version}-c18-${theme.slug}-menu-w300.png`), (await rectOf(".part.sidebar"))!, 2)
            await press("Escape")
          }
          await resetPage()
          await openInEditor(files.sample)
        }
      }
      // ntwine.matchEditorTheme off, in the theme the user asked about's family (blue-black): ntwine's own
      // palette, its #0d0e10 canvas, against the theme's side bar; on again, the theme's.
      await agent({ op: "config", section: "workbench", key: "colorTheme", value: "Abyss" })
      await until(async () => (await pageBackground()) === (await relayBackground()), 8_000)
      await agent({ op: "config", section: "ntwine", key: "matchEditorTheme", value: false })
      const off = await until(async () => (await hostColors()) === null, 8_000)
      await sleep(400)
      const offShot = await capture("")
      const offPage = await pagePixels(offShot)
      const offBar = await sideBarPixel(offShot)
      expect("c18", "matchEditorTheme off: the page is back in ntwine's palette (#0d0e10), not the theme's", off && !!offPage && offPage.rgb.join() === "13,14,16" && offPage.rgb.join() !== offBar.rgb.join(), { page: offPage, sideBar: offBar })
      await beside("abyss-setting-off-queue")
      await agent({ op: "config", section: "ntwine", key: "matchEditorTheme", value: true })
      const on = await until(async () => (await hostColors()) === "sideBar", 8_000)
      await sleep(400)
      const onShot = await capture("")
      const onPage = await pagePixels(onShot)
      expect("c18", "…and on again, the theme's, without a reload", on && !!onPage && onPage.rgb.join() === (await sideBarPixel(onShot)).rgb.join() && (await status()).sidebar.ready, { page: onPage })
    } finally {
      notes.themeColours = readings
      await agent({ op: "config", section: "ntwine", key: "matchEditorTheme", value: null })
      await agent({ op: "config", section: "workbench", key: "colorTheme", value: "Default Dark Modern" })
      await until(async () => (await inPage(() => document.documentElement.dataset.theme)) === "dark", 8_000)
    }
  })

  // ── c19: the selection hint ──
  /** The hint as the editor DRAWS it: the decoration's ::after, its colour, its line, its box. */
  const hintDrawn = () => inWorkbench(() => {
    const span = [...document.querySelectorAll<HTMLElement>(".part.editor .view-lines span")].find((s) => getComputedStyle(s, "::after").content.includes("add to ntwine"))
    if (!span) return null
    const after = getComputedStyle(span, "::after")
    const line = span.closest<HTMLElement>(".view-line")
    // The colour VS Code's own end-of-line annotation (inline blame) is drawn in, resolved the way the
    // browser resolves the decoration's.
    const probe = document.createElement("span")
    probe.style.color = "var(--vscode-editorInlayHint-foreground)"
    document.querySelector(".part.editor")!.appendChild(probe)
    const annotation = getComputedStyle(probe).color
    probe.remove()
    const r = span.getBoundingClientRect()
    const l = line?.getBoundingClientRect()
    return {
      content: after.content,
      color: after.color,
      annotation,
      fontStyle: after.fontStyle,
      line: (line?.textContent ?? "").replace(/\u00a0|\u00b7/gu, " ").trimEnd(),
      span: { x: r.x, y: r.y, width: r.width, height: r.height },
      lineBox: l ? { x: l.x, y: l.y, width: l.width, height: l.height } : null,
    }
  })
  await run("c19", "the selection hint beside a fresh selection", async () => {
    await command("workbench.view.extension.ntwine")
    await waitFor("the ntwine view", async () => (await status()).sidebar.visible || undefined, 10_000)
    await resetPage()
    await openInEditor(files.sample)
    await press("ArrowRight")
    await waitFor("no hint before the selection", async () => (await hintDrawn()) === null || undefined, 3_000).catch(() => undefined)
    const pressedAt = Date.now()
    await selectLines23()
    const drawn = await waitFor("the hint drawn", hintDrawn, 5_000).catch(() => null)
    const latency = Date.now() - pressedAt
    const told = (await status()).selectionHint
    notes.selectionHint = { drawn, told, latency }
    expect("c19", "lines 2-3 selected by keys: `Ctrl+L to add to ntwine` after line 3's text, once the selection settled", drawn?.content === '"Ctrl+L to add to ntwine"' && /for \(const x of xs\) \{$/u.test(drawn.line) && told?.line === 3 && latency >= 250, { drawn, told, latency })
    expect("c19", "…in the colour VS Code draws its own inline blame in, not the code's", !!drawn && drawn.color === drawn.annotation, drawn && { color: drawn.color, annotation: drawn.annotation })
    if (drawn?.lineBox) {
      // The line from its start to past the hint, 6x: the gap and the weight are judged by eye on this.
      const right = drawn.span.x + drawn.span.width
      await capture(join(out, `${version}-c19-selection-hint-6x.png`), { x: drawn.lineBox.x - 4, y: drawn.lineBox.y - 6, width: right - drawn.lineBox.x + 12, height: drawn.lineBox.height + 12 }, 6)
      // The ink gap between where the selection ends (its highlight and the caret, which are what the eye
      // reads as its edge) and the hint's first glyph, at 2x: anything unlike the editor's own background,
      // column by column, the background sampled past the hint's end. Walked from the RIGHT: over the
      // hint's words (whose spaces are one character, ~17 columns at 2x) to the first run of background
      // wider than any of them, which is the margin. (Walked from the decoration's left edge, the caret
      // standing there read as the hint's first ink and the gap as 0.)
      const png = decodePng(await capture("", { x: drawn.lineBox.x, y: drawn.lineBox.y, width: right - drawn.lineBox.x + 4, height: drawn.lineBox.height }, 2))
      const background = png.px(png.width - 2, Math.floor(png.height / 2))
      const inked: boolean[] = []
      for (let x = 0; x < png.width; x++) {
        let ink = false
        for (let y = 0; y < png.height && !ink; y++) {
          const [r, g, b] = png.px(x, y)
          ink = Math.abs(r - background[0]) + Math.abs(g - background[1]) + Math.abs(b - background[2]) > 60
        }
        inked.push(ink)
      }
      let x = inked.length - 1
      while (x > 0 && !inked[x]) x--
      let hintInk = x
      for (let run = 0; x > 0; x--) {
        if (inked[x]) {
          hintInk = x
          run = 0
        } else if (++run > 40) break
      }
      let codeEnd = x
      while (codeEnd > 0 && !inked[codeEnd]) codeEnd--
      notes.selectionHintInkGapPx = (hintInk - codeEnd - 1) / 2
    }
    await shot("c19-selection-hint", { window: true })

    await press("ArrowRight")
    const gone = await waitFor("the hint gone", async () => ((await hintDrawn()) === null && (await status()).selectionHint === null) || undefined, 3_000).catch(() => false)
    expect("c19", "the selection emptied: the hint is gone at once", gone === true, await hintDrawn())

    // Ctrl+L adds it to the prompt box: the hint has done its job.
    await clearBox("newComposer")
    await openInEditor(files.sample)
    await selectLines23()
    await waitFor("the hint again", hintDrawn, 5_000).catch(() => null)
    await press("Control+KeyL")
    const added = await waitFor("the chip in the box", async () => ((await box("newComposer"))?.value.includes("@sample.ts:2-3") ? true : undefined), 8_000).catch(() => false)
    const afterAdd = await waitFor("the hint gone after Ctrl+L", async () => ((await hintDrawn()) === null) || undefined, 3_000).catch(() => false)
    expect("c19", "Ctrl+L adds the selection, and the hint goes with it", added === true && afterAdd === true, { box: await box("newComposer"), hint: await hintDrawn() })
    await clearBox("newComposer")

    // The setting off: a fresh selection gets none.
    await agent({ op: "config", section: "ntwine", key: "selectionHint", value: false })
    try {
      await openInEditor(files.sample)
      await press("ArrowRight")
      await selectLines23()
      await sleep(900)
      const off = await hintDrawn()
      expect("c19", "ntwine.selectionHint off: no hint", off === null && (await status()).selectionHint === null, off)
    } finally {
      await agent({ op: "config", section: "ntwine", key: "selectionHint", value: null })
    }
  })

  // ── c20: a thread in an editor tab ──
  await run("c20", "a thread in an editor tab, from the title row's ⋯: on the thread, at the editor's width, and its reply box sends", async () => {
    await command("workbench.view.extension.ntwine")
    await waitFor("the ntwine view", async () => (await status()).sidebar.visible || undefined, 10_000)
    await resetPage()
    await openThreadRow()
    await waitFor("the sidebar on the thread", async () => (await status()).sidebar.view === "thread" || undefined, 8_000)
    await clearBox("chatComposer")
    const sidebarFrame = await frame()
    await openInEditor(files.sample)

    // The title row's ⋯, Open thread in editor tab — clicked, as a human does (c8 says why the hover first).
    await clickInWorkbench('.part.sidebar .title-actions .action-label[aria-label*="More Actions"]')
    const label = /Open thread in editor tab/u
    const items = await waitFor("Open thread in editor tab in the ⋯ menu", async () => {
      const found = await inWorkbench(() => [...document.querySelectorAll<HTMLElement>(".monaco-menu .action-item .action-label")].filter((l) => l.getClientRects().length > 0).map((l) => l.getAttribute("aria-label") ?? l.textContent ?? ""))
      return found.some((item) => label.test(item)) ? found : undefined
    }, 5_000).catch(() => null)
    expect("c20", "the title row's ⋯ offers Open thread in editor tab while a thread shows, first", !!items && label.test(items[0] ?? ""), items)
    if (items) {
      const item = await page.evaluateHandle(() => [...document.querySelectorAll<HTMLElement>(".monaco-menu .action-item .action-label")].find((l) => /Open thread in editor tab/u.test(l.getAttribute("aria-label") ?? l.textContent ?? "")) ?? null)
      const itemBox = await (item.asElement() as ElementHandle | null)?.boundingBox()
      if (itemBox) {
        await page.mouse.move(itemBox.x + itemBox.width / 2, itemBox.y + itemBox.height / 2, { steps: 4 })
        await sleep(250)
      }
      await clickHandle(item.asElement() as ElementHandle | null, "Open thread in editor tab in the ⋯ menu")
    } else {
      await press("Escape")
      await command("ntwine.openThreadInTab")
    }
    type Tab = Awaited<ReturnType<typeof status>>["threadTabs"][number]
    const tab = await waitFor("the tab's page ready", async () => (await status()).threadTabs.find((candidate: Tab) => candidate.ready), 60_000).catch(async () => (await status()).threadTabs[0])
    const tabUrl = tab?.url ? new URL(tab.url) : undefined
    expect("c20", "a tab opens beside the code, framing the thread's own address in embed mode", tab?.thread === seeded!.thread.slug && tab.project === workspace.slug && tabUrl?.pathname === `/all/${workspace.slug}/thread/${seeded!.thread.slug}` && tabUrl.searchParams.get("embed") === "vscode" && tab.viewColumn === 2, tab)
    const tabFrame = await waitFor("the tab's ntwine frame", () => page.frames().find((candidate) => candidate !== sidebarFrame && !candidate.detached && candidate.url().startsWith(`${origin}/`)), 20_000)
    tabFrames.add(tabFrame)
    const inTab = <T>(fn: () => T) => tabFrame.evaluate(fn) as Promise<Awaited<T>>
    const shownInTab = await waitFor("the thread's drawer in the tab", async () => {
      const state = await inTab(() => {
        const reply = [...document.querySelectorAll<HTMLTextAreaElement>('textarea[data-surface="chatComposer"]')].find((t) => t.getClientRects().length > 0)
        return reply ? { width: innerWidth, title: document.querySelector("[role=dialog] h1, [role=dialog] h2")?.textContent ?? null, bar: !!document.querySelector("[data-editor-context-bar]") } : null
      })
      return state ?? undefined
    }, 20_000).catch(() => null)
    const sidebarWide = await inPage(() => innerWidth)
    // In the editor's colours on the EDITOR's surface (thread-panel.ts): the page marks its root so, and
    // its background — the full-width drawer's, which in those colours is the surface — is the editor's.
    const tabColours = await inTab(() => {
      const probe = document.createElement("div")
      probe.style.color = "var(--vscode-editor-background)"
      document.body.append(probe)
      const editor = getComputedStyle(probe).color
      probe.remove()
      const drawer = document.querySelector<HTMLElement>(".ntwine-sheet-panel")
      return { hostColors: document.documentElement.dataset.hostColors ?? null, editor, drawer: drawer ? getComputedStyle(drawer).backgroundColor : null, body: getComputedStyle(document.body).backgroundColor }
    })
    expect("c20", "…in the editor's colours, on the editor's surface: its drawer is the editor's background", tabColours.hostColors === "editor" && !!tabColours.editor && tabColours.drawer === tabColours.editor, tabColours)
    // The tab's own webview in the workbench: the visible one in the editor part (the sidebar's is in the
    // side bar). Its page fills it — the editor's width, whatever the side bar was left at by an earlier
    // check (c9 leaves it ~450px, so "wider than the sidebar" is no measure of anything).
    const tabWebview = await inWorkbench(() => {
      const part = document.querySelector(".part.editor")!.getBoundingClientRect()
      const r = [...document.querySelectorAll<HTMLElement>("iframe.webview")].map((f) => f.getBoundingClientRect()).find((b) => b.width > 0 && b.left >= part.left - 1 && b.right <= part.right + 1)
      return r ? { width: r.width, part: part.width } : null
    })
    // Whether the tab's page shares the sidebar's storage (drafts, the page's own settings): both frames
    // sit under the same workbench, which is what a partition is keyed by. Recorded, not judged.
    const probeKey = `ntwine-e2e-tab-probe-${Date.now()}`
    await inPage((key: string) => localStorage.setItem(key, "from the sidebar"), probeKey)
    notes.tabSharesSidebarStorage = await tabFrame.evaluate((key: string) => localStorage.getItem(key), probeKey)
    await inPage((key: string) => localStorage.removeItem(key), probeKey)
    expect("c20", "…its page shows the thread, with its reply box and the editor's context bar, filling its editor group", !!shownInTab && shownInTab.bar && !!tabWebview && Math.abs(shownInTab.width - tabWebview.width) <= 2 && tabWebview.width >= tabWebview.part / 2 - 8, { tab: shownInTab, webview: tabWebview, sidebar: sidebarWide })
    const titled = await waitFor("the tab titled by its page", async () => {
      const now = (await status()).threadTabs[0]
      return now && now.title !== seeded!.thread.slug ? now.title : undefined
    }, 8_000).catch(() => (status().then((s) => s.threadTabs[0]?.title)))
    const tabLabel = await inWorkbench(() => [...document.querySelectorAll<HTMLElement>(".part.editor .tab")].map((t) => t.getAttribute("aria-label") ?? t.textContent ?? ""))
    expect("c20", "…its editor tab reads the thread's title as the page names it, not re-cased", typeof titled === "string" && titled.length > 0 && tabLabel.some((text) => text.startsWith(titled)), { titled, tabLabel })
    await capture(join(out, `${version}-c20-thread-tab-window.png`))

    // Its reply box sends — to the thread's simulated worker, carrying the editor's block (the tab is fed).
    const before = readFileSync(seeded!.inputs, "utf8").trim().split("\n").filter(Boolean).length
    const reply = (await tabFrame.evaluateHandle(() => [...document.querySelectorAll<HTMLTextAreaElement>('textarea[data-surface="chatComposer"]')].find((t) => t.getClientRects().length > 0) ?? null)).asElement() as ElementHandle | null
    await clickHandle(reply, "the tab's reply box")
    await until(async () => await inTab(() => document.activeElement?.getAttribute("data-surface") === "chatComposer"), 3_000)
    await page.keyboard.type("from the tab: what is this?")
    await press("Enter")
    const sent = await waitFor("the tab's message at the simulated worker", () => {
      const lines = readFileSync(seeded!.inputs, "utf8").trim().split("\n").filter(Boolean)
      return lines.length > before ? (JSON.parse(lines.at(-1)!) as { id: string; text: string }) : undefined
    }, 20_000).catch(() => null)
    const block = sent ? parseSentEditorContext(sent.text) : null
    expect("c20", "…its reply box sends to the thread's worker, with the editor's block naming sample.ts", !!sent && sent.text.startsWith("from the tab: what is this?") && !!block && /sample\.ts/u.test(block.editor.display), { text: sent?.text.slice(0, 400), block })

    // The tab was used last: Ctrl+L in the editor lands the selection in the TAB's reply box. Back to the
    // code where it is, column 1: opening it in the ACTIVE group — the tab's, after the click into its reply
    // box — would put sample.ts over the tab, and a tab out of sight is rightly not where Ctrl+L goes.
    await agent({ op: "open", path: files.sample, column: 1 })
    await waitFor("sample.ts in column 1 with the editor focused", async () => ((await workbenchFocus()).editor && (await editorState()).path === files.sample) || undefined, 5_000).catch(() => undefined)
    expect("c20", "…and the tab is still on screen beside it", (await status()).threadTabs[0]?.visible === true, (await status()).threadTabs)
    await press("ArrowRight")
    await selectLines23()
    await press("Control+KeyL")
    const chip = await waitFor("the chip in the tab", async () => {
      const value = await inTab(() => [...document.querySelectorAll<HTMLTextAreaElement>('textarea[data-surface="chatComposer"]')].find((t) => t.getClientRects().length > 0)?.value ?? "")
      return value.includes("@sample.ts:2-3") ? value : undefined
    }, 8_000).catch(() => null)
    const sidebarBox = await box("chatComposer")
    expect("c20", "Ctrl+L in the editor puts the selection in the tab's reply box — the ntwine used last — not the sidebar's", !!chip && !sidebarBox?.value.includes("@sample.ts:2-3"), { tab: chip, sidebar: sidebarBox?.value })
    // Ctrl+L in the tab: back to the code.
    await press("Control+KeyL")
    const back = await until(async () => (await workbenchFocus()).editor && (await editorState()).path === files.sample, 5_000)
    expect("c20", "Ctrl+L pressed in the tab goes back to the code", back, await workbenchFocus())

    // Asked again: the same tab, forward.
    await command("ntwine.openThreadInTab", { thread: seeded!.thread.slug, project: workspace.slug })
    const again = await until(async () => {
      const tabs = (await status()).threadTabs
      return tabs.length === 1 && tabs[0]!.active
    }, 5_000)
    expect("c20", "asked again, the same tab comes forward: one tab per thread", again, (await status()).threadTabs)
    await capture(join(out, `${version}-c20-thread-tab-chip-window.png`))
    await command("workbench.action.closeAllEditors")
    await until(async () => (await status()).threadTabs.length === 0, 5_000)
    tabFrames.delete(tabFrame)
  })

  // ── c21: the bar's ×, one selection left out with the eye still on ──
  /** The bar's leave-out control on a box: its state, and which glyph it shows now. */
  const leaveOutState = (surface: "chatComposer" | "newComposer") =>
    inPage((s) => {
      const area = [...document.querySelectorAll<HTMLTextAreaElement>(`textarea[data-surface="${s}"]`)].find((t) => t.getClientRects().length > 0)
      let scope: HTMLElement | null = area?.parentElement ?? null
      while (scope && !scope.querySelector("[data-editor-context-bar]")) scope = scope.parentElement
      const bar = scope?.querySelector<HTMLElement>("[data-editor-context-bar]")
      const toggle = bar?.querySelector<HTMLElement>("[data-editor-context-leave-out]")
      if (!bar || !toggle) return null
      const glyph = [...toggle.querySelectorAll("svg")].find((svg) => getComputedStyle(svg).display !== "none")
      return {
        leftOut: bar.dataset.editorContextLeftOut ?? null,
        pressed: toggle.getAttribute("aria-pressed"),
        glyph: glyph?.getAttribute("class")?.match(/lucide-([a-z0-9-]+)/u)?.[1] ?? null,
        struck: getComputedStyle(bar.querySelector("[data-editor-context] span")!).textDecorationLine,
        hint: bar.querySelector<HTMLElement>("[data-editor-context-hint]")?.innerText ?? null,
        reading: bar.querySelector<HTMLElement>("[data-editor-context]")?.getAttribute("aria-label") ?? null,
      }
    }, surface)
  await run("c21", "the bar's × leaves this selection out of the message, the eye still on, until the selection changes", async () => {
    await resetPage()
    await openThreadRow()
    await openInEditor(files.sample, [1, 0, 2, -1])
    await waitFor("the reply box's bar on lines 2-3", async () => (await contextBar("chatComposer"))?.kind === "selection" || undefined, 5_000)
    const atRest = await leaveOutState("chatComposer")
    expect("c21", "at rest the reading wears the file glyph, nothing left out", atRest?.glyph === "file-code2" && atRest.leftOut === "false", atRest)
    // A human points at the reading: the glyph becomes the ×.
    const reading = await (await frame()).evaluateHandle(() => [...document.querySelectorAll<HTMLElement>('textarea[data-surface="chatComposer"]')].find((t) => t.getClientRects().length > 0)?.closest("[data-thread-composer-box]")?.querySelector("[data-editor-context] span") ?? null)
    const at = await (reading.asElement() as ElementHandle | null)?.boundingBox()
    if (at) await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2, { steps: 4 })
    const hovered = await waitFor("the × on the pointed-at reading", async () => { const s = await leaveOutState("chatComposer"); return s?.glyph === "x" ? s : undefined }, 3_000).catch(() => leaveOutState("chatComposer"))
    expect("c21", "pointing at the reading turns its glyph into the ×", hovered?.glyph === "x", hovered)
    // Not `shot`, which parks the pointer on the side bar's edge first: the × is there only while pointed at.
    { const rect = await rectOf(".part.sidebar"); if (rect) await capture(join(out, `${version}-c21-bar-x-hover-w300.png`), rect, 2) }
    await clickInComposer("chatComposer", "[data-editor-context-leave-out]")
    const leftOut = await waitFor("left out", async () => { const s = await leaveOutState("chatComposer"); return s?.leftOut === "true" ? s : undefined }, 3_000).catch(() => leaveOutState("chatComposer"))
    expect("c21", "clicked: left out — struck through, pressed, the hint says so", leftOut?.leftOut === "true" && leftOut.pressed === "true" && leftOut.struck === "line-through" && /^Left out/u.test(leftOut.hint ?? ""), leftOut)
    expect("c21", "…and the eye is still on, the setting untouched", (await eye()) === "true" && (await sharing()).value !== false, { eye: await eye(), setting: await sharing() })
    await page.mouse.move(2, 400)
    await shot("c21-bar-left-out-w300")
    const tool = await toolReads()
    expect("c21", "…so the agents' tool still reads the selection (only the message leaves it out)", /lines 2-3 selected/u.test(tool), tool.slice(0, 300))
    const withheld = await sendFromReply("leave that one out")
    expect("c21", "a send carries no editor context while it is left out", withheld.text.startsWith("leave that one out") && parseSentEditorContext(withheld.text) === null && !withheld.text.includes("let total = 0"), withheld.text.slice(0, 400))
    // A new selection in the editor: it goes again, on its own.
    await openInEditor(files.sample, [3, 0, 4, -1])
    const back = await waitFor("the new selection", async () => { const s = await leaveOutState("chatComposer"); return s?.leftOut === "false" && /:4-5/u.test(s.reading ?? "") ? s : undefined }, 5_000).catch(() => leaveOutState("chatComposer"))
    expect("c21", "a new selection brings it back: lit, not struck", back?.leftOut === "false" && back.struck !== "line-through", back)
    const sent = await sendFromReply("and this one?")
    const block = parseSentEditorContext(sent.text)
    expect("c21", "…and the next send quotes it", block?.editor.kind === "selection" && block.editor.startLine === 4 && block.editor.endLine === 5 && block.body === "and this one?", { text: sent.text.slice(0, 500), block })
  })

  // ── c22: a screenshot pasted from the OS clipboard ──
  /** `xclip`, for putting an image on the X clipboard the way a screenshot tool does — fetched into the run's scratch with apt when the machine lacks it (no root needed for either step). */
  const xclip = (): string => {
    const onPath = spawnSync("sh", ["-c", "command -v xclip"], { encoding: "utf8" }).stdout.trim()
    if (onPath) return onPath
    const dir = join(scratch, "xclip")
    const bin = join(dir, "usr", "bin", "xclip")
    if (existsSync(bin)) return bin
    mkdirSync(dir, { recursive: true })
    execFileSync("apt-get", ["download", "xclip"], { cwd: dir, stdio: "ignore", timeout: 60_000 })
    const deb = execFileSync("sh", ["-c", "ls xclip_*.deb"], { cwd: dir, encoding: "utf8" }).trim()
    execFileSync("dpkg", ["-x", join(dir, deb), dir])
    return bin
  }
  /** Own the X clipboard with `bytes` as `type` until the returned stop is called (xclip in the foreground, its pid ours). */
  const clipboard = (type: string, file: string): (() => void) => {
    const owner = spawn(xclip(), ["-quiet", "-selection", "clipboard", "-t", type, "-i", file], { stdio: "ignore", env: process.env })
    return () => { if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGTERM") }
  }
  /** The attachments a box holds: what its value carries after the prose, and whether each tile's image loaded. */
  const attachments = (surface: "chatComposer" | "newComposer") =>
    inPage((s) => {
      const area = [...document.querySelectorAll<HTMLTextAreaElement>(`textarea[data-surface="${s}"]`)].find((t) => t.getClientRects().length > 0)
      const root = area?.closest(".rounded-xl")
      return {
        value: area?.value ?? null,
        tiles: [...(root?.querySelectorAll<HTMLImageElement>(".group\\/att img") ?? [])].map((img) => ({ alt: img.alt, loaded: img.complete && img.naturalWidth > 0, width: img.naturalWidth })),
      }
    }, surface)
  await run("c22", "an image pasted from the clipboard into a sidebar prompt box attaches, as in a browser tab", async () => {
    await resetPage()
    await openThreadRow()
    // The picture: the sidebar as it is now, a screenshot like any other.
    const shotFile = join(scratch, "pasted-shot.png")
    const rect = (await rectOf(".part.sidebar"))!
    await capture(shotFile, { x: rect.x, y: rect.y, width: Math.min(rect.width, 240), height: 160 })
    const textFile = join(scratch, "pasted-text.txt")
    writeFileSync(textFile, "plain words from the clipboard")
    let stop = (): void => undefined
    try {
      // The negative control first: a clipboard holding TEXT pastes text, and nothing is attached.
      stop = clipboard("text/plain", textFile)
      await sleep(300)
      await clickInPage('textarea[data-surface="chatComposer"]')
      await until(async () => (await box("chatComposer"))?.active === true, 3_000)
      await press("Control+KeyV")
      const text = await waitFor("the pasted text", async () => { const a = await attachments("chatComposer"); return a.value?.includes("plain words from the clipboard") ? a : undefined }, 5_000).catch(() => attachments("chatComposer"))
      expect("c22", "control: a text clipboard pastes its text and attaches nothing", !!text.value?.includes("plain words from the clipboard") && text.tiles.length === 0, text)
      await clearBox("chatComposer")
      stop()
      // A screenshot on the clipboard, as a screenshot tool leaves it: Ctrl+V in the reply box.
      stop = clipboard("image/png", shotFile)
      await sleep(300)
      if (!(await box("chatComposer"))?.active) await clickInPage('textarea[data-surface="chatComposer"]')
      await until(async () => (await box("chatComposer"))?.active === true, 3_000)
      await press("Control+KeyV")
      const pasted = await waitFor("the attachment", async () => { const a = await attachments("chatComposer"); return a.tiles.some((tile) => tile.loaded) ? a : undefined }, 15_000).catch(() => attachments("chatComposer"))
      notes.pastedImage = pasted
      expect("c22", "Ctrl+V with an image on the clipboard attaches it: a tile with the picture, as in a browser tab", pasted.tiles.some((tile) => tile.loaded), pasted)
      await shot("c22-pasted-image-w300")
      // Sent, the agent gets the picture's path, and the file is there.
      const before = readFileSync(seeded!.inputs, "utf8").trim().split("\n").filter(Boolean).length
      await typeInto("chatComposer", "what is wrong in this screenshot?")
      await press("Enter")
      const sent = await waitFor("the message at the simulated worker", () => {
        const lines = readFileSync(seeded!.inputs, "utf8").trim().split("\n").filter(Boolean)
        return lines.length > before ? (JSON.parse(lines.at(-1)!) as { text: string }) : undefined
      }, 20_000)
      const path = sent.text.split("\n").map((line) => line.trim()).find((line) => /^\/.*\.png$/u.test(line))
      expect("c22", "…sent, the message carries the image's path, and the image is on disk", !!path && existsSync(path) && readFileSync(path).subarray(1, 4).toString() === "PNG", { text: sent.text.slice(0, 300), path })
    } finally {
      stop()
    }
  })

  // ── c23: a file dropped from the OS ──
  await run("c23", "a file dropped from the OS onto a sidebar prompt box attaches", async () => {
    await resetPage()
    await openThreadRow()
    const dropped = join(scratch, "dropped-from-the-os.png")
    writeFileSync(dropped, readFileSync(join(scratch, "pasted-shot.png")))
    await waitFor("the reply box", async () => (await box("chatComposer")) ?? undefined, 10_000)
    // An OS file drag as Chromium receives one from a file manager: files, no VS Code resource types.
    const data = { items: [] as { mimeType: string; data: string }[], files: [dropped], dragOperationsMask: 1 }
    // VS CODE'S ROUTING, measured in its own handler. A drag from a file manager enters the window over the
    // workbench (the activity bar, the editor) before it reaches the sidebar, and VS Code's
    // WebviewWindowDragMonitor answers every `dragover` on the workbench: without Shift it turns the
    // webview's pointer events OFF for the drag (so the editor can take file drops), with Shift it turns
    // them back on. DevTools' own drag events do not reach that listener reliably (c14 saw one dragenter of
    // five), so the workbench is sent the dragover a real drag delivers there, once plain and once with
    // Shift, and the sidebar's frame is read after each.
    const blocked = await page.evaluate(() => {
      const frameOf = () => [...document.querySelectorAll<HTMLElement>("iframe.webview")].find((f) => f.getBoundingClientRect().width > 0 && f.closest(".part.sidebar, .webview-container, body"))
      const read = () => frameOf()?.style.pointerEvents || "auto"
      const over = (shiftKey: boolean) => window.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, shiftKey, dataTransfer: new DataTransfer() }))
      const before = read()
      over(false)
      const plain = read()
      over(true)
      const shift = read()
      return { before, plain, shift }
    })
    notes.osDropRouting = blocked
    // The floor's monitor is older: 1.90.0's (read in its workbench.desktop.main.js) turns the webviews'
    // pointer events off only for a DRAG_START in the window — a tab or a file dragged inside VS Code —
    // and has no DRAG/DRAG_OVER handler and no Shift rule, so a drag from the OS reaches the sidebar
    // plain. 1.140.0's adds both. Releases between the two are not measured; they get 1.140's claim.
    const [, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10))
    if (minor < 91) expect("c23", `VS Code ${version} leaves an OS drag to the sidebar, Shift or not: its drag monitor knows only drags started in the window`, blocked.plain === "auto" && blocked.shift === "auto", blocked)
    else expect("c23", "VS Code takes an OS drag from the sidebar unless Shift is held: plain, the webview's pointer events go off; Shift, back on", blocked.plain === "none" && blocked.shift === "auto", blocked)
    // The page's half: the drop itself, trusted, carrying the file from disk, on the page's own frame.
    const sessionOf = (f: Frame) => (f as unknown as { client: CDPSession }).client
    const frameSession = sessionOf(await frame())
    const inner = await inPage(() => {
      const rect = [...document.querySelectorAll<HTMLTextAreaElement>('textarea[data-surface="chatComposer"]')].find((t) => t.getClientRects().length > 0)!.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    })
    const hint = { seen: "" }
    for (const type of ["dragEnter", "dragOver", "dragOver"] as const) {
      await frameSession.send("Input.dispatchDragEvent", { type, x: inner.x, y: inner.y, data, modifiers: 8 }).catch((error: unknown) => { notes.osDropError = String(error) })
      await sleep(150)
    }
    hint.seen = await inPage(() => [...document.querySelectorAll<HTMLElement>(".rounded-xl")].map((el) => el.innerText).find((t) => /Drop file to attach/u.test(t)) ? "Drop file to attach" : "")
    await shot("c23-dragging-over-w300")
    await frameSession.send("Input.dispatchDragEvent", { type: "drop", x: inner.x, y: inner.y, data, modifiers: 8 }).catch((error: unknown) => { notes.osDropError = String(error) })
    expect("c23", "over the box the page says it will attach the file", hint.seen === "Drop file to attach", hint)
    const landed = await waitFor("the dropped file attached", async () => { const a = await attachments("chatComposer"); return a.tiles.some((tile) => tile.loaded) ? a : undefined }, 15_000).catch(() => attachments("chatComposer"))
    notes.osDrop = landed
    // The box shows its attachments as tiles (the paths ride the draft after the prose, not the textarea).
    expect("c23", "dropped with Shift held: the file is attached, a tile with its picture", landed.tiles.some((tile) => tile.loaded && tile.alt.includes("dropped-from-the-os")), landed)
    await shot("c23-dropped-file-w300")
    await clearBox("chatComposer").catch(() => undefined)
  })

  // ── c24: a page that reloads into nothing is framed again ──
  await run("c24", "a page that reloaded into an error page is framed again, on its own", async () => {
    await resetPage()
    await openThreadRow()
    const lostFrame = await frame()
    const eventsBefore = (await status()).sidebar.events.length
    // The frame navigates itself somewhere the relay's CSP refuses (frame-src names ntwine's origin only):
    // the browser's error page, blank in VS Code — what a page's reload that lands while ntwine is down
    // leaves in the frame (2026-10-07). The extension is told nothing but that a document loaded.
    await lostFrame.evaluate(() => { location.href = "http://127.0.0.1:9/" }).catch(() => undefined)
    const lost = await until(async () => { const s = (await status()).sidebar; return !s.ready && s.view === "" }, 10_000)
    const lostSnapshot = (await status()).sidebar
    expect("c24", "the sidebar stops calling the page ready, and the title row stops claiming its thread", lost, { ready: lostSnapshot.ready, view: lostSnapshot.view, events: lostSnapshot.events.slice(eventsBefore) })
    await shot("c24-error-page-w300")
    const started = Date.now()
    const back = await until(async () => (await status()).sidebar.events.slice(eventsBefore).some((event) => event.type === "ntwine:ready"), 60_000)
    const backSnapshot = (await status()).sidebar
    expect("c24", "framed again, without a click, and the new page says it is ready", back, { afterMs: Date.now() - started, url: backSnapshot.url, events: backSnapshot.events.slice(eventsBefore) })
    const rows = await waitFor("the queue in the page", async () => (await inPage(() => document.querySelectorAll("[data-xq-thread-row]").length)) || undefined, 30_000).catch(() => 0)
    expect("c24", "…on the queue, with the title row's buttons back", rows > 0 && (await titleRow()).buttons.includes("New thread"), { rows, row: await titleRow() })
    await shot("c24-framed-again-w300")
  })

  // ── c17: a restart and a window reload (LAST: it ends the agent's VS Code) ──
  await run("c17", "a restart and a window reload keep what the page stored, and the eye", async () => {
    // A value in the framed page's own storage — where it keeps what the human set in it (its shortcuts,
    // drafts) — and the eye off, with a file in front so the bar (and its eye) is drawn.
    await openInEditor(files.sample)
    const probe = `reload-probe-${Date.now()}`
    await inPage((value) => localStorage.setItem("ntwine-e2e-reload-probe", value), probe)
    const keysBefore = await inPage(() => Object.keys(localStorage).sort())
    await agent({ op: "config", section: "ntwine", key: "shareEditorState", value: false })
    await until(async () => (await eye()) === "false", 8_000)
    // Under the test runner a window reload ENDS the run: VS Code exits with its extension host (seen:
    // "Test run failed with code 1" the moment Reload Window ran). So the agent is told it is done, that
    // VS Code closes, and the same profile — user data, extensions, settings — is opened again by a VS Code
    // of this harness's own, without the runner, where a reload is just a reload.
    finishAgent?.()
    await Promise.race([suite, sleep(60_000)])
    await killAll(editors)
    await browser?.disconnect().catch(() => undefined)
    const port = await freePort()
    spawn(vscodeExecutablePath, [
      workspace.dir, `--user-data-dir=${userData}`, `--extensions-dir=${join(scratch, "extensions")}`, `--extensionDevelopmentPath=${extensionPath}`,
      "--disable-extension=GitHub.copilot", "--disable-extension=GitHub.copilot-chat", "--password-store=basic", "--disable-gpu",
      "--disable-telemetry", "--skip-welcome", "--skip-release-notes", "--no-sandbox", "--disable-gpu-sandbox", "--disable-updates",
      "--disable-workspace-trust", `--remote-debugging-port=${port}`,
    ], { stdio: "ignore", env: process.env })
    browser = await waitFor("the relaunched VS Code's debugging port", () => puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null, protocolTimeout: 180_000 }), 60_000)
    page = await waitFor("the relaunched workbench", async () => (await browser!.pages()).find((candidate) => /workbench(\.esm)?\.html/u.test(candidate.url())), 60_000)
    cdp = await page.createCDPSession()
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true })
    page.on("pageerror", (error) => pageErrors.push(String(error)))
    // The side bar comes back on ntwine's view when the workspace remembers it; else, its icon, clicked.
    if (!(await until(async () => !!ntwineFrame(), 30_000))) {
      await waitFor("the ntwine item in the activity bar", () => page.$('.part.activitybar .action-label[aria-label^="ntwine"]'), 30_000)
      await clickInWorkbench('.part.activitybar .action-label[aria-label^="ntwine"]')
    }
    const pageUp = async (not?: Frame) => waitFor("the page framed and drawn", async () => {
      const framedNow = ntwineFrame()
      if (!framedNow || framedNow === not || framedNow.detached) return undefined
      return (await framedNow.evaluate(() => !!document.querySelector("[data-sidebar-page]")).catch(() => false)) ? framedNow : undefined
    }, 120_000)
    // No agent now: a file is opened as a human opens one, Quick Open typed — the eye is drawn only beside
    // a reading of what is in front. (A restart reopens no editors here; a reload keeps them.)
    const inFront = async () => {
      if (await until(async () => (await eye()) !== null, 3_000)) return
      await press("Control+KeyP")
      await until(paletteOpen, 5_000)
      await page.keyboard.type("sample.ts", { delay: 15 })
      await sleep(800)
      await press("Enter")
    }
    const restarted = await pageUp()
    await inFront()
    const afterRestart = await inPage(() => ({ probe: localStorage.getItem("ntwine-e2e-reload-probe"), keys: Object.keys(localStorage).sort() }))
    expect("c17", "a restart: the page's own storage is still there", afterRestart.probe === probe, { before: keysBefore, after: afterRestart.keys })
    const eyeRestart = await waitFor("the eye", async () => (await eye()) ?? undefined, 20_000).catch(() => null)
    expect("c17", "…and the eye is still off: it is the VS Code setting", eyeRestart === "false", { eye: eyeRestart })

    // A window reload, as a human does it: the palette's Developer: Reload Window, typed.
    await press("Control+Shift+KeyP")
    await until(paletteOpen, 5_000)
    await page.keyboard.type("Developer: Reload Window", { delay: 15 })
    await sleep(800)
    await press("Enter")
    // Puppeteer keeps the workbench's page across a reload; the frame inside it is a new one.
    await pageUp(restarted)
    await inFront()
    const afterReload = await inPage(() => ({ probe: localStorage.getItem("ntwine-e2e-reload-probe"), keys: Object.keys(localStorage).sort() }))
    expect("c17", "a window reload: the page's own storage is still there", afterReload.probe === probe, { before: keysBefore, after: afterReload.keys })
    const eyeReload = await waitFor("the eye", async () => (await eye()) ?? undefined, 20_000).catch(() => null)
    expect("c17", "…and the eye is still off", eyeReload === "false", { eye: eyeReload })
    await shot("c17-after-reload-w300", { window: true })
  })

  expect("all", "no page errors in the framed page", pageErrors.length === 0, pageErrors.slice(0, 10))
  expect("all", "no opener spawned but the web link's xdg-open", stack.openers().split("\n").filter(Boolean).every((line) => /^xdg-open https:\/\/example\.com\/spec$/u.test(line)), stack.openers())
  exitCode = results.every((result) => result.ok) ? 0 : 1
} catch (error) {
  log((error as Error).stack ?? String(error))
  expect("run", "the run reached its end", false, String(error))
  if (page) await capture(join(out, `${version || "unknown"}-run-failure-window.png`)).catch(() => undefined)
  exitCode = 1
} finally {
  survivors = await teardown()
  if (survivors.length) {
    expect("run", "nothing survives the teardown", false, survivors)
    exitCode = 1
  }
  const passed = results.filter((result) => result.ok).length
  const file = join(out, `${version || "unknown"}-results.json`)
  writeFileSync(file, JSON.stringify({ version, extension: devMode ? "source tree" : "packaged .vsix", passed, failed: results.length - passed, results, notes, shots: shots.map((s) => s.slice(out.length + 1)), pageErrors, survivors }, null, 2))
  log(`${passed}/${results.length} passed; results ${file}; screenshots in ${out}`)
  if (exitCode === 0 && process.env.NTWINE_E2E_KEEP !== "1" && !out.startsWith(scratch)) rmSync(scratch, { recursive: true, force: true })
  else log(`scratch kept: ${scratch}`)
}
process.exit(exitCode)
