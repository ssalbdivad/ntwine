// SPIKE (branch vscode-sidebar-spike, never merged): does a VS Code sidebar WebviewView that iframes a
// live Frizz page actually work? Boots a disposable Frizz (scripts/adhoc-stack.mjs, sandbox HOME) seeded
// with four question cards, runs a real VS Code (@vscode/test-electron) under Xvfb with the extension,
// opens the Frizz sidebar, and then drives and photographs it:
//
//   · CDP into the editor (--remote-debugging-port) to find the Frizz frame nested inside the webview,
//     read its console/page errors, its resource timings, and its composer;
//   · `ss` for the server-side signal: which processes hold connections to the stack's port;
//   · REAL input: a mouse click at the composer's screen position on the WORKBENCH page and typed keys,
//     routed by Chromium through the webview frame into the Frizz frame;
//   · ffmpeg x11grab of the Xvfb display for every screenshot.
//
//   nub packages/vscode/scripts/sidebar-spike.ts --out=<dir for PNGs and report json>
//
// Never on the real display: re-executes itself under xvfb-run with DISPLAY/WAYLAND_DISPLAY removed.
// Everything it starts is torn down by exact pid / process group.

import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process"
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron"
import puppeteer, { type Browser, type Frame, type Page } from "puppeteer"

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repo = resolve(pkg, "..", "..")
const W = 1600
const H = 1000

if (process.platform === "linux" && process.env.FRIZZ_E2E_UNDER_XVFB !== "1") {
  const env: NodeJS.ProcessEnv = { ...process.env, FRIZZ_E2E_UNDER_XVFB: "1" }
  delete env.DISPLAY
  delete env.WAYLAND_DISPLAY
  const child = spawnSync("xvfb-run", ["-a", "-s", `-screen 0 ${W}x${H}x24`, "nub", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit", env })
  process.exit(child.status ?? 1)
}
if (!process.env.DISPLAY || process.env.DISPLAY === ":0" || process.env.WAYLAND_DISPLAY) {
  console.error(`refusing to run on DISPLAY=${process.env.DISPLAY}: that is a real screen`)
  process.exit(1)
}
const display = process.env.DISPLAY

const outArg = process.argv.find((arg) => arg.startsWith("--out="))?.slice(6)
if (!outArg) {
  console.error("usage: nub packages/vscode/scripts/sidebar-spike.ts --out=<dir>")
  process.exit(2)
}
const out = resolve(outArg)
mkdirSync(out, { recursive: true })

const log = (line: string) => console.log(`spike: ${line}`)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const findings: Record<string, unknown> = { display }

const build = spawnSync("nub", ["scripts/build.ts", "--e2e"], { cwd: pkg, stdio: "inherit" })
if (build.status !== 0) process.exit(build.status ?? 1)

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "frizz-sidebar-spike-")))

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as { port: number }
  await new Promise((resolve) => server.close(resolve))
  return port
}

function gitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=spike", "-c", "user.email=spike@frizz.invalid", ...args], { cwd: dir, stdio: "ignore" })
  git("init", "-q")
  writeFileSync(join(dir, "README.md"), "# spike\n")
  mkdirSync(join(dir, "src"))
  writeFileSync(join(dir, "src", "sample.ts"), "export const answer = 42\n")
  git("add", ".")
  git("commit", "-q", "-m", "init")
  return realpathSync(dir)
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function leftovers(home: string): number[] {
  const found = new Set<number>()
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) continue
    try {
      if (readFileSync(`/proc/${entry}/environ`, "utf8").split("\0").includes(`HOME=${home}`)) found.add(Number(entry))
    } catch {}
  }
  for (const line of execFileSync("ps", ["-Ao", "pid=,args="], { encoding: "utf8" }).split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line)
    if (match && match[2]!.includes(home)) found.add(Number(match[1]))
  }
  return [...found].filter((pid) => pid !== process.pid && pid !== process.ppid)
}

async function waitFor<T>(what: string, probe: () => T | undefined | Promise<T | undefined>, ms: number): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await probe()
    if (value !== undefined && value !== false) return value as T
    if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms waiting for ${what}`)
    await sleep(200)
  }
}

function shoot(name: string): string {
  const file = join(out, `${name}.png`)
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "x11grab", "-video_size", `${W}x${H}`, "-i", display, "-frames:v", "1", file])
  log(`screenshot ${file}`)
  return file
}

/** Who holds TCP connections to the stack's port, by process name (`ss -tnp`). */
function connectionsTo(port: number): { established: number; byProcess: Record<string, number>; raw: string[] } {
  const raw = execFileSync("ss", ["-Htnp", "state", "established", `( dport = :${port} )`], { encoding: "utf8" }).trim().split("\n").filter(Boolean)
  const byProcess: Record<string, number> = {}
  for (const line of raw) {
    const name = /users:\(\("([^"]+)",pid=(\d+)/u.exec(line)
    const key = name ? `${name[1]}(pid ${name[2]})` : "unknown"
    byProcess[key] = (byProcess[key] ?? 0) + 1
  }
  return { established: raw.length, byProcess, raw }
}

// ── the stack ────────────────────────────────────────────────────────────────────────────────────────

let stackPid: number | undefined
let stackHome: string | undefined
let browser: Browser | undefined

async function teardownStack(): Promise<void> {
  if (stackPid) {
    try {
      process.kill(-stackPid, "SIGTERM")
    } catch {}
    const deadline = Date.now() + 20_000
    while (alive(-stackPid) && Date.now() < deadline) await sleep(100)
    if (alive(-stackPid)) {
      log(`stack group ${stackPid} ignored SIGTERM; SIGKILL`)
      try {
        process.kill(-stackPid, "SIGKILL")
      } catch {}
    }
  }
  if (stackHome) {
    for (const stray of leftovers(stackHome)) try { process.kill(stray, "SIGTERM") } catch {}
    await sleep(1_000)
    const strays = leftovers(stackHome)
    findings.cleanup = strays.length ? `STILL RUNNING with the sandbox HOME: ${strays.join(", ")}` : `stack group ${stackPid} gone; nothing with HOME=${stackHome} survives`
    log(String(findings.cleanup))
    rmSync(stackHome, { recursive: true, force: true })
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void teardownStack().finally(() => process.exit(130)))
}

const port = await freePort()
const projectDir = gitRepo(join(scratch, "project"))
stackHome = realpathSync(mkdtempSync(join(tmpdir(), "frizz-sidebar-spike-home-")))
const stackLog = join(scratch, "stack.log")
{
  const fd = openSync(stackLog, "w")
  const env = { ...process.env }
  delete env.FRIZZ_E2E_UNDER_XVFB
  const child: ChildProcess = spawn("nub", ["scripts/adhoc-stack.mjs", `--port=${port}`, `--project=${projectDir}`, `--home=${stackHome}`], { cwd: repo, env, stdio: ["ignore", fd, fd], detached: true })
  closeSync(fd)
  stackPid = child.pid
}
log(`stack pid ${stackPid} (group), port ${port}, HOME ${stackHome}, log ${stackLog}`)

let exitCode = 1
let control = ""
let suite: Promise<number> | undefined
let sentDone = false
try {
  const info = await waitFor("the stack's json line", () => {
    const line = readFileSync(stackLog, "utf8").split("\n").find((candidate) => candidate.startsWith('{"url"'))
    return line ? (JSON.parse(line) as { slug: string; port: number }) : undefined
  }, 180_000)
  const origin = `http://127.0.0.1:${port}`
  log(`stack up: ${origin}, project ${info.slug}`)
  findings.origin = origin
  findings.slug = info.slug

  // Four question cards, through the REAL tailer (scripts/seed-question-cards.mjs).
  execFileSync("nub", ["scripts/seed-question-cards.mjs", `--home=${stackHome}`, `--cwd=${projectDir}`], { cwd: repo, stdio: "inherit" })

  control = join(scratch, "control")
  mkdirSync(control)
  let seq = 0
  const command = async (name: string, ...args: unknown[]): Promise<unknown> => {
    seq += 1
    writeFileSync(join(control, `cmd-${seq}.json`), JSON.stringify({ command: name, args }))
    if (name === "__done") {
      sentDone = true
      return undefined
    }
    const ack = await waitFor(`ack of ${name}`, () => {
      const file = join(control, `ack-${seq}.json`)
      return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { ok: boolean; result?: unknown; error?: string }) : undefined
    }, 60_000)
    if (!ack.ok) throw new Error(`${name} failed: ${ack.error}`)
    return ack.result
  }

  const userData = join(scratch, "user-data")
  mkdirSync(join(userData, "User"), { recursive: true })
  writeFileSync(join(userData, "User", "settings.json"), JSON.stringify({
    "frizz.serverUrl": origin,
    "workbench.startupEditor": "none",
    "window.restoreWindows": "none",
    "security.workspace.trust.enabled": false,
    "update.mode": "none",
    "extensions.autoCheckUpdates": false,
    "telemetry.telemetryLevel": "off",
    "git.enabled": false,
    "window.titleBarStyle": "custom",
  }, null, 2))

  const cdpPort = await freePort()
  const vscodeExecutablePath = await downloadAndUnzipVSCode({ version: process.env.FRIZZ_E2E_VSCODE ?? "1.140.0", cachePath: join(homedir(), ".cache", "frizz-vscode-e2e") })
  log(`VS Code ${vscodeExecutablePath}, CDP on ${cdpPort}, DISPLAY ${display}`)
  suite = runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: pkg,
    extensionTestsPath: join(pkg, "dist", "e2e", "sidebar-suite.cjs"),
    launchArgs: [
      projectDir,
      `--user-data-dir=${userData}`,
      `--extensions-dir=${join(scratch, "extensions")}`,
      "--disable-extensions",
      "--password-store=basic",
      "--disable-gpu",
      "--disable-telemetry",
      `--remote-debugging-port=${cdpPort}`,
    ],
    extensionTestsEnv: { FRIZZ_SPIKE_CONTROL: control },
  }).catch((error: unknown) => {
    log(`the suite did not run: ${(error as Error).message}`)
    return 1
  })

  const ready = await waitFor("the extension to connect", () => (existsSync(join(control, "ready.json")) ? readFileSync(join(control, "ready.json"), "utf8") : undefined), 120_000)
  log(`extension connected: ${ready.slice(0, 200)}`)

  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${cdpPort}`, defaultViewport: null, protocolTimeout: 120_000 })
  const workbench = await waitFor<Page>("the workbench page", async () => (await browser!.pages()).find((page) => page.url().includes("workbench")), 30_000)
  log(`workbench page: ${workbench.url()}`)
  const consoleLines: string[] = []
  const pageErrors: string[] = []
  const requests: { url: string; status: number; method: string }[] = []
  workbench.on("console", (message) => {
    const text = message.text()
    if (/frizz|refused|frame|Content Security|403|blocked/iu.test(text)) consoleLines.push(`[${message.type()}] ${text.slice(0, 400)}`)
  })
  workbench.on("pageerror", (error) => pageErrors.push(String(error)))
  workbench.on("requestfinished", (request) => {
    if (request.url().startsWith(origin)) requests.push({ url: request.url().slice(origin.length), status: request.response()?.status() ?? 0, method: request.method() })
  })
  workbench.on("requestfailed", (request) => {
    if (request.url().startsWith(origin)) requests.push({ url: request.url().slice(origin.length), status: -1, method: `${request.method()} FAILED ${request.failure()?.errorText}` })
  })

  const before = connectionsTo(port)
  findings.connectionsBeforeSidebar = before
  log(`connections before the sidebar opens: ${JSON.stringify(before.byProcess)}`)

  const queueUrl = `${origin}/?project=${encodeURIComponent(info.slug)}`
  const resolved = await command("frizz.sidebar.navigate", queueUrl)
  findings.asExternalUri = { asked: queueUrl, got: resolved }
  await command("workbench.view.extension.frizz")
  await command("frizz.sidebar.show")

  const frizzFrame = async (): Promise<Frame | undefined> => workbench.frames().find((frame) => frame.url().startsWith(origin))
  let frame = await waitFor("the Frizz frame inside the webview", frizzFrame, 60_000)
  log(`Frizz frame found: ${frame.url()}`)
  findings.frameChain = (() => {
    const chain: string[] = []
    for (let f: Frame | null = frame; f; f = f.parentFrame()) chain.push(f.url().slice(0, 140))
    return chain
  })()
  const composerSel = '[data-surface="newComposer"]'
  try {
    await frame.waitForSelector(composerSel, { timeout: 150_000 })
    findings.composerRendered = true
  } catch (error) {
    findings.composerRendered = `NO: ${(error as Error).message}`
  }
  await sleep(4_000)
  const state = await frame.evaluate(() => ({
    title: document.title,
    width: window.innerWidth,
    height: window.innerHeight,
    bodyText: document.body.innerText.slice(0, 1500),
    scrollWidth: document.documentElement.scrollWidth,
    resources: performance.getEntriesByType("resource").map((entry) => entry.name).filter((name) => name.includes("/_frizz/")).map((name) => new URL(name).pathname).slice(0, 40),
    hasFocusApi: document.hasFocus(),
    storageOk: (() => {
      try {
        localStorage.setItem("spike", "1")
        return localStorage.getItem("spike") === "1"
      } catch (error) {
        return String(error)
      }
    })(),
  }))
  findings.queueFrame = state
  log(`frame ${state.width}x${state.height}, scrollWidth ${state.scrollWidth}, ${state.resources.length} /_frizz resources`)
  const during = connectionsTo(port)
  findings.connectionsWithSidebar = during
  log(`connections with the sidebar open: ${JSON.stringify(during.byProcess)}`)
  shoot("01-queue-default-width")

  // ── typing: a real click on the workbench at the composer's screen position, then real keys ──────────
  const box = await (await frame.$(composerSel))?.boundingBox()
  findings.composerBox = box
  if (box) {
    await workbench.mouse.click(box.x + Math.min(40, box.width / 2), box.y + box.height / 2)
    await sleep(500)
    await workbench.keyboard.type("typed from the VS Code sidebar", { delay: 20 })
    await sleep(800)
    const typed = await frame.evaluate((selector) => ({
      value: (document.querySelector(selector) as HTMLTextAreaElement | null)?.value ?? null,
      active: document.activeElement?.getAttribute("data-surface") ?? document.activeElement?.tagName ?? null,
      hasFocus: document.hasFocus(),
    }), composerSel)
    findings.typing = typed
    log(`after typing: ${JSON.stringify(typed)}`)
    shoot("02-composer-typed")

    // Does a workbench shortcut still reach VS Code while focus is inside the Frizz frame?
    await workbench.keyboard.down("Control")
    await workbench.keyboard.down("Shift")
    await workbench.keyboard.press("KeyP")
    await workbench.keyboard.up("Shift")
    await workbench.keyboard.up("Control")
    await sleep(800)
    const palette = await workbench.evaluate(() => {
      const widget = document.querySelector(".quick-input-widget") as HTMLElement | null
      return widget ? getComputedStyle(widget).display !== "none" : false
    })
    const afterShortcut = await frame.evaluate((selector) => (document.querySelector(selector) as HTMLTextAreaElement | null)?.value ?? null, composerSel)
    findings.ctrlShiftPFromFrame = { paletteOpened: palette, composerValueAfter: afterShortcut }
    log(`Ctrl+Shift+P inside the frame: palette opened ${palette}`)
    shoot("03-ctrl-shift-p-from-frame")
    await workbench.keyboard.press("Escape")
    await sleep(300)

    // Submit: Enter in the new-thread box dispatches. No credentials in this sandbox, so a worker cannot
    // start — what matters is that the POST passes the origin gate and the server answers it.
    const mark = requests.length
    await workbench.mouse.click(box.x + Math.min(40, box.width / 2), box.y + box.height / 2)
    await workbench.keyboard.press("End")
    await workbench.keyboard.press("Enter")
    await sleep(6_000)
    findings.submitRequests = requests.slice(mark).filter((request) => request.method !== "GET" || /dispatch|board/u.test(request.url))
    const board = await fetch(`${origin}/_frizz/rpc/board`, { headers: { "sec-fetch-site": "same-origin" } }).then((response) => response.json()) as { result?: { threads?: { id?: string; slug?: string; title?: string }[] } }
    findings.boardAfterSubmit = (board.result?.threads ?? []).map((thread) => `${thread.id ?? thread.slug}: ${thread.title ?? ""}`)
    log(`board after submit: ${JSON.stringify(findings.boardAfterSubmit)}`)
    shoot("04-after-submit")
  }

  // ── a single thread's route ──────────────────────────────────────────────────────────────────────────
  for (const [name, path] of [["05-thread-drawer", `/all/${info.slug}/thread/q-plain`], ["06-thread-full", `/all/${info.slug}/thread/q-plain/full`]] as const) {
    await command("frizz.sidebar.navigate", `${origin}${path}`)
    frame = await waitFor(`the frame on ${path}`, async () => workbench.frames().find((candidate) => candidate.url().startsWith(`${origin}${path}`)), 60_000)
    await sleep(6_000)
    findings[name] = await frame.evaluate(() => ({
      url: location.pathname,
      width: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      text: document.body.innerText.slice(0, 1200),
    }))
    shoot(name)
  }

  // ── wider: three steps of View: Increase Current View Size with the sidebar focused ──────────────────
  await command("frizz.sidebar.show")
  for (let i = 0; i < 6; i++) await command("workbench.action.increaseViewWidth")
  await sleep(2_000)
  frame = (await frizzFrame()) ?? frame
  findings.widerWidth = await frame.evaluate(() => window.innerWidth)
  shoot("07-thread-full-wider")
  await command("frizz.sidebar.navigate", queueUrl)
  await sleep(6_000)
  frame = (await frizzFrame()) ?? frame
  findings.widerQueue = await frame.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }))
  shoot("08-queue-wider")

  findings.frameConsole = consoleLines
  findings.workbenchPageErrors = pageErrors
  findings.requestStatuses = requests.reduce<Record<string, number>>((acc, request) => {
    const key = `${request.method} ${request.status} ${request.url.split("?")[0]}`
    acc[key] = (acc[key] ?? 0) + 1
    return acc
  }, {})
  findings.forbidden = requests.filter((request) => request.status === 403 || request.status === -1)

  await browser.disconnect()
  browser = undefined
  await command("__done")
  const code = await suite
  findings.suiteExit = code
  exitCode = 0
} catch (error) {
  findings.error = String((error as Error).stack ?? error)
  log(`FAILED: ${findings.error}`)
  try {
    shoot("99-failure")
  } catch {}
} finally {
  await browser?.disconnect().catch(() => undefined)
  // The suite waits on its control directory; release it so VS Code exits on its own.
  if (control && suite && !sentDone) {
    const next = readdirSync(control).filter((file) => file.startsWith("cmd-")).length + 1
    writeFileSync(join(control, `cmd-${next}.json`), JSON.stringify({ command: "__done" }))
  }
  if (suite) await Promise.race([suite, sleep(30_000)])
  // Any editor process still holding this run's user-data dir is ours; nothing else names it.
  const editors = () => execFileSync("ps", ["-Ao", "pid=,args="], { encoding: "utf8" }).split("\n")
    .filter((line) => line.includes(join(scratch, "user-data"))).map((line) => Number(line.trim().split(/\s+/u)[0]))
  for (const pid of editors()) try { process.kill(pid, "SIGTERM") } catch {}
  await sleep(1_000)
  findings.editorCleanup = editors().length ? `STILL RUNNING: ${editors().join(", ")}` : "no editor process holds this run's user-data dir"
  await teardownStack()
  findings.stackLogTail = readFileSync(stackLog, "utf8").split("\n").filter((line) => /error|refus|403|forbid|warn/iu.test(line)).slice(-40)
  writeFileSync(join(out, "findings.json"), JSON.stringify(findings, null, 2))
  log(`findings: ${join(out, "findings.json")}; scratch kept at ${scratch}`)
}
process.exit(exitCode)
