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
  const text = () => frame.evaluate(() => document.body.innerText)
  await waitFor("the board in the frame", async () => (await text()).includes("plain-question") || undefined, 150_000)
  await sleep(2_000)

  // Where the workbench sits on the Xvfb screen, so a crop of the sidebar can be cut from a full shot.
  const sidebarRect = async () => workbench.evaluate(() => {
    const part = document.querySelector(".part.sidebar")!.getBoundingClientRect()
    return { x: Math.round(window.screenX + part.left), y: Math.round(window.screenY + part.top), w: Math.round(part.width), h: Math.round(part.height) }
  })
  const shot = async (name: string) => {
    const full = shoot(name)
    const r = await sidebarRect()
    const crop = join(out, `${name}.sidebar.png`)
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", full, "-vf", `crop=${r.w}:${r.h}:${r.x}:${r.y},scale=iw*2:ih*2:flags=neighbor`, crop])
  }

  const state = await frame.evaluate(() => ({
    title: document.title,
    width: window.innerWidth,
    height: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    bodyText: document.body.innerText.slice(0, 800),
    hasFocus: document.hasFocus(),
    prefersDark: matchMedia("(prefers-color-scheme: dark)").matches,
    htmlAttrs: Object.fromEntries([...document.documentElement.attributes].map((attr) => [attr.name, attr.value])),
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    storage: (() => {
      try {
        localStorage.setItem("spike", "1")
        return localStorage.getItem("spike") === "1" ? "localStorage works" : "localStorage read back wrong"
      } catch (error) {
        return String(error)
      }
    })(),
    serviceWorker: "serviceWorker" in navigator,
  }))
  findings.queueFrame = state
  log(`frame ${state.width}x${state.height}, scrollWidth ${state.scrollWidth}, focus ${state.hasFocus}`)
  findings.connectionsWithSidebar = connectionsTo(port)
  log(`connections with the sidebar open: ${JSON.stringify((findings.connectionsWithSidebar as { byProcess: unknown }).byProcess)}`)
  await shot("01-queue-default-width")

  // ── live sync: a change made OUTSIDE the sidebar must reach it with no navigation ─────────────────────
  {
    const started = Date.now()
    const response = await fetch(`${origin}/_frizz/${info.slug}/rpc/archiveThread`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ slug: "q-legacy-danger" }),
    })
    const urlBefore = frame.url()
    let gone: number | undefined
    try {
      await waitFor("the archived card to leave the sidebar's queue", async () => !(await text()).includes("legacy-approval-danger-gate") || undefined, 20_000)
      gone = Date.now() - started
    } catch {}
    findings.liveSync = { archiveStatus: response.status, removedFromSidebarAfterMs: gone ?? "NOT within 20s", navigated: frame.url() !== urlBefore }
    log(`live sync: ${JSON.stringify(findings.liveSync)}`)
    await shot("02-live-sync-archived-one")
  }

  // ── the new-thread composer: open it, click it, type into it — all REAL input on the workbench ───────
  const clickIn = async (handle: Awaited<ReturnType<Frame["$"]>>, what: string) => {
    const box = await handle?.boundingBox()
    if (!box) throw new Error(`${what}: no box`)
    await workbench.mouse.click(box.x + Math.min(30, box.width / 2), box.y + box.height / 2)
    return box
  }
  const byText = async (label: string) => (await frame.evaluateHandle((wanted) => [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === wanted) ?? null, label)).asElement() as Awaited<ReturnType<Frame["$"]>>
  try {
    if (!(await frame.$(composerSel))) {
      await clickIn(await byText("New thread"), "New thread")
      await frame.waitForSelector(composerSel, { timeout: 20_000 })
    }
    await sleep(800)
    await shot("03-new-thread-open")
    const box = await clickIn(await frame.$(composerSel), "composer")
    findings.composerBox = box
    await sleep(400)
    await workbench.keyboard.type("typed from the VS Code sidebar", { delay: 15 })
    await sleep(600)
    const readComposer = () => frame.evaluate((selector) => ({
      value: (document.querySelector(selector) as HTMLTextAreaElement | null)?.value ?? null,
      activeIsComposer: document.activeElement === document.querySelector(selector),
      hasFocus: document.hasFocus(),
    }), composerSel)
    findings.typing = await readComposer()
    log(`after typing: ${JSON.stringify(findings.typing)}`)
    await shot("04-composer-typed")

    // A workbench shortcut while focus is inside the Frizz frame.
    await workbench.keyboard.down("Control")
    await workbench.keyboard.down("Shift")
    await workbench.keyboard.press("KeyP")
    await workbench.keyboard.up("Shift")
    await workbench.keyboard.up("Control")
    await sleep(800)
    const paletteOpen = () => workbench.evaluate(() => {
      const widget = document.querySelector(".quick-input-widget") as HTMLElement | null
      return widget ? getComputedStyle(widget).display !== "none" : false
    })
    findings.ctrlShiftPFromFrame = { paletteOpened: await paletteOpen(), composer: await readComposer() }
    log(`Ctrl+Shift+P inside the frame: ${JSON.stringify(findings.ctrlShiftPFromFrame)}`)
    await shot("05-ctrl-shift-p-from-frame")
    await workbench.keyboard.press("Escape")
    await sleep(300)

    // "Add to Frizz prompt" from the editor while the sidebar shows the composer but does not have focus.
    await command("__openSample")
    await sleep(500)
    const added = await command("frizz.addToPrompt")
    await sleep(3_000)
    const unfocused = await readComposer()
    await shot("06-add-to-prompt-sidebar-unfocused")
    await clickIn(await frame.$(composerSel), "composer")
    await sleep(3_000)
    const focused = await readComposer()
    findings.addToPrompt = { result: added, composerWhileUnfocused: unfocused, composerAfterClickingIntoSidebar: focused }
    log(`add to prompt: ${JSON.stringify(findings.addToPrompt)}`)
    await shot("07-add-to-prompt-after-focus")

    // Submit: Enter dispatches. No credentials in this sandbox, so no worker can start — what matters is
    // that the POST from inside the frame passes the origin gate and the server acts on it.
    const mark = requests.length
    await workbench.keyboard.press("End")
    await workbench.keyboard.press("Enter")
    await sleep(8_000)
    findings.submitRequests = requests.slice(mark).filter((request) => request.method !== "GET")
    const board = await fetch(`${origin}/_frizz/${info.slug}/rpc/board`, { headers: { "sec-fetch-site": "same-origin" } }).then((response) => response.json()) as { result?: { threads?: { id?: string; title?: string; status?: string }[] } }
    findings.boardAfterSubmit = (board.result?.threads ?? []).map((thread) => `${thread.id}: ${thread.title ?? ""} [${thread.status ?? ""}]`)
    log(`submit: ${JSON.stringify(findings.submitRequests)}; board ${JSON.stringify(findings.boardAfterSubmit)}`)
    await shot("08-after-submit")
  } catch (error) {
    findings.composerError = String(error)
    log(`composer steps failed: ${error}`)
    await shot("08-composer-failure")
  }

  // ── a single thread's routes, and its follow-up box ──────────────────────────────────────────────────
  for (const [name, path] of [["09-thread-drawer", `/all/${info.slug}/thread/q-plain`], ["10-thread-full", `/all/${info.slug}/thread/q-plain/full`]] as const) {
    await command("frizz.sidebar.navigate", `${origin}${path}`)
    frame = await waitFor(`the frame on ${path}`, async () => workbench.frames().find((candidate) => candidate.url().startsWith(`${origin}${path}`)), 60_000)
    await waitFor("the thread's question", async () => (await text()).includes("settings store") || undefined, 60_000).catch(() => undefined)
    await sleep(2_000)
    const followUp = await frame.$('textarea[placeholder^="Follow up"]')
    let reply: unknown = "no follow-up box"
    if (followUp) {
      await clickIn(followUp, "follow-up box")
      await sleep(300)
      await workbench.keyboard.type("a reply typed in the sidebar", { delay: 15 })
      await sleep(400)
      reply = await followUp.evaluate((element) => (element as HTMLTextAreaElement).value)
    }
    findings[name] = await frame.evaluate(() => ({ url: location.pathname, width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, text: document.body.innerText.slice(0, 600) }))
    ;(findings[name] as Record<string, unknown>).followUpTyped = reply
    await shot(name)
  }

  // ── wider: drag the sidebar's sash with the mouse ────────────────────────────────────────────────────
  {
    const part = await workbench.evaluate(() => {
      const rect = document.querySelector(".part.sidebar")!.getBoundingClientRect()
      return { right: rect.right, top: rect.top, height: rect.height }
    })
    const y = part.top + part.height / 2
    await workbench.mouse.move(part.right + 1, y)
    await workbench.mouse.down()
    for (let step = 1; step <= 10; step++) await workbench.mouse.move(part.right + 1 + step * 30, y)
    await workbench.mouse.up()
    await sleep(2_000)
    frame = (await frizzFrame()) ?? frame
    findings.widerThreadFull = await frame.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }))
    await shot("11-thread-full-wider")
    await command("frizz.sidebar.navigate", queueUrl)
    frame = await waitFor("the frame back on the queue", async () => workbench.frames().find((candidate) => candidate.url() === queueUrl), 60_000)
    await waitFor("the board in the frame", async () => (await text()).includes("plain-question") || undefined, 60_000).catch(() => undefined)
    await sleep(2_000)
    findings.widerQueue = await frame.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }))
    await shot("12-queue-wider")
  }

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
