// End-to-end check of the desktop WINDOW: launches the real app (the dev build, or a packaged binary
// with --app) on a private virtual display, drives it over the DevTools protocol, and asserts what a
// BrowserWindow does not give a web page for free.
//
//   nub packages/desktop/scripts/verify-window.ts --home=<sandbox> [--app=<packaged binary>] [--shots=<dir>]
//       Joins the server a sandbox HOME's owner record names — run verify-start.ts --keep first. Asserts:
//       the board loads from the record (never a well-known port); http(s) links and navigations go to
//       the OS opener and open no window; worker links of other schemes go nowhere; a same-origin
//       window.open opens an app window; the preload bridge is present; the last path survives a quit.
//
//   unshare -rn sh -c 'ip link set lo up && exec nub packages/desktop/scripts/verify-window.ts --fake-start'
//       The START path, in a private network namespace so this machine's own board on 9393 cannot
//       answer: nothing is running, so the app must run `npx`, which here is a stand-in whose launcher
//       serves a fake board on 9393 — and the window must end up on it.
//
// Nothing appears on the real display: the app runs under xvfb-run with DISPLAY and WAYLAND_DISPLAY
// replaced, and every process it starts is in one group that is killed on exit.
import { spawn, type ChildProcess } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import puppeteer, { type Browser, type Page } from "puppeteer"

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const fakeStart = process.argv.includes("--fake-start")
const shots = arg("shots")
const appBinary = arg("app")
const home = fakeStart ? mkdtempSync(join(tmpdir(), "frizz-desktop-fake-")) : arg("home")
if (!home) throw new Error("--home=<sandbox> is required (run verify-start.ts --keep first), or pass --fake-start")

const results: Array<{ check: string; ok: boolean; detail?: string }> = []
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ check: name, ok, ...(detail ? { detail } : {}) })
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`)
}

// The OS opener, replaced: shell.openExternal on Linux runs xdg-open, and this one only records.
const bin = join(home, "fake-bin")
mkdirSync(bin, { recursive: true })
const opened = join(home, "opened.log")
writeFileSync(join(bin, "xdg-open"), `#!/bin/sh\necho "$@" >> "${opened}"\n`)
chmodSync(join(bin, "xdg-open"), 0o755)
const openedUrls = () => (existsSync(opened) ? readFileSync(opened, "utf8").trim().split("\n").filter(Boolean) : [])

let fakeOrigin: string | undefined
if (fakeStart) {
  // A launcher stand-in: npx answers --_frizz-print-launcher with it, and it serves a "board" on the
  // default port the way the real supervisor does once it listens.
  const launcher = join(home, "fake-launcher.mjs")
  writeFileSync(launcher, `
import { createServer } from "node:http"
import { writeFileSync } from "node:fs"
writeFileSync(${JSON.stringify(join(home, "launcher-argv.json"))}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), path: process.env.PATH }))
console.log("frizz: ··· server — starting on 9393")
setTimeout(() => createServer((req, res) => {
  if (req.url === "/_frizz/health") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, bootId: "fake", projectId: "p", projectDir: "/" })); return }
  res.setHeader("content-type", "text/html"); res.end('<!doctype html><title>fake board</title><div id="root">fake board</div>')
}).listen(9393, "127.0.0.1", () => console.log("frizz: local: http://127.0.0.1:9393/")), 1500)
`)
  symlinkSync(process.execPath, join(bin, "node"))
  writeFileSync(join(bin, "npx"), `#!/bin/sh\n[ "$3" = "--_frizz-print-launcher" ] && echo "${launcher}"\n`)
  chmodSync(join(bin, "npx"), 0o755)
  fakeOrigin = "http://127.0.0.1:9393"
}

async function freePort(): Promise<number> {
  return new Promise((ok) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number }
      server.close(() => ok(port))
    })
  })
}

function appEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("FRIZZ_") || key.startsWith("XDG_") || key === "WAYLAND_DISPLAY" || key === "DISPLAY") continue
    env[key] = value
  }
  env.HOME = home!
  env.PATH = `${bin}:${fakeStart ? "/usr/bin:/bin" : process.env.PATH}`
  // Where the lazily downloaded Electron binary already lives, so a sandbox HOME does not refetch it.
  env.electron_config_cache = join(process.env.HOME ?? "", ".cache", "electron")
  return env
}

interface Running { child: ChildProcess; browser: Browser }

async function launch(): Promise<Running> {
  const port = await freePort()
  const electron = appBinary ?? join(pkg, "node_modules", ".bin", "electron")
  const appArgs = appBinary ? [] : [pkg]
  // --disable-gpu only because capturePage/screenshots fail with a GPU process under Xvfb here; the
  // app itself renders with the GPU on (requestAnimationFrame measured at ~48fps under Xvfb).
  const flags = ["--disable-gpu", `--remote-debugging-port=${port}`, ...(fakeStart ? ["--no-sandbox"] : [])]
  const child = spawn("xvfb-run", ["-a", "-s", "-screen 0 1600x1000x24", electron, ...appArgs, ...flags], {
    env: appEnv(),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let log = ""
  child.stdout!.on("data", (d) => { log += d })
  child.stderr!.on("data", (d) => { log += d })
  for (let i = 0; i < 150; i++) {
    try {
      const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null })
      return { child, browser }
    } catch {
      if (child.exitCode !== null) break
      await delay(200)
    }
  }
  throw new Error(`the app never opened its DevTools port:\n${log.slice(-3000)}`)
}

function stop(running: Running): void {
  running.browser.disconnect().catch(() => {})
  try { process.kill(-running.child.pid!, "SIGKILL") } catch {}
}

/** The window's page once it has left this app's own loading screen for `origin`. */
async function boardPage(browser: Browser, origin: string | undefined, timeoutMs = 90_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const page of await browser.pages()) {
      const url = page.url()
      if (url.startsWith("http") && (!origin || url.startsWith(origin))) return page
    }
    await delay(250)
  }
  const urls = (await browser.pages()).map((p) => p.url().slice(0, 120))
  throw new Error(`no window reached the board; windows show: ${urls.join(", ")}`)
}

const pageCount = async (browser: Browser) => (await browser.pages()).length
let exitCode = 0
let running: Running | undefined
try {
  running = await launch()
  const expected = fakeOrigin ?? (JSON.parse(readFileSync(join(home, ".local", "state", "frizz", "frizz-server", "address.json"), "utf8")).port
    ? `http://127.0.0.1:${JSON.parse(readFileSync(join(home, ".local", "state", "frizz", "frizz-server", "address.json"), "utf8")).port}`
    : undefined)
  const page = await boardPage(running.browser, expected)
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(String(error)))
  page.on("console", (message) => { if (message.type() === "error") errors.push(`${message.text()} ${message.location()?.url ?? ""}`) })
  page.on("response", (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
  const origin = new URL(page.url()).origin
  check("the window lands on the server this launch should find", origin === expected, `${origin} (expected ${expected})`)

  if (fakeStart) {
    const launched = JSON.parse(readFileSync(join(home, "launcher-argv.json"), "utf8"))
    check("the app started the launcher itself, with --no-app, from $HOME", launched.argv.join(" ") === "--no-app" && launched.cwd === home, JSON.stringify(launched.argv) + " in " + launched.cwd)
    await page.waitForFunction(() => document.getElementById("root")?.textContent === "fake board", { timeout: 10_000 })
    check("the started board is what the window shows", true)
  } else {
    await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0, { timeout: 60_000 })
    await delay(2_000)
    if (shots) {
      mkdirSync(shots, { recursive: true })
      await page.screenshot({ path: join(shots, "board.png") })
    }
    check("the board renders with no page errors", errors.length === 0, errors.slice(0, 3).join(" | "))

    const bridge = await page.evaluate(() => {
      const d = (window as unknown as { frizzDesktop?: Record<string, unknown> }).frizzDesktop
      return d ? Object.keys(d).sort().join(",") : "missing"
    })
    check("the preload bridge is on the page", bridge === "chooseProject,focusWindow,retry", bridge)

    const before = await pageCount(running.browser)
    await page.evaluate(() => {
      const a = document.createElement("a")
      a.href = "https://example.com/frizz-desktop-link"
      a.target = "_blank"
      document.body.append(a)
      a.click()
      a.remove()
    })
    await page.evaluate(() => { window.open("https://example.com/frizz-desktop-open", "_blank") })
    await delay(1_500)
    check("target=_blank links and window.open go to the OS browser",
      openedUrls().includes("https://example.com/frizz-desktop-link") && openedUrls().includes("https://example.com/frizz-desktop-open"),
      openedUrls().join(", "))
    check("…and open no window of their own", (await pageCount(running.browser)) === before, `${await pageCount(running.browser)} windows`)

    const here = page.url()
    await page.evaluate(() => { location.href = "https://example.com/frizz-desktop-navigate" })
    await delay(1_500)
    check("navigating the board away is refused and sent to the browser",
      page.url() === here && openedUrls().includes("https://example.com/frizz-desktop-navigate"), page.url())

    const openedBefore = openedUrls().length
    await page.evaluate(() => {
      window.open("file:///etc/passwd")
      window.open("vscode://file/etc/passwd")
      const a = document.createElement("a")
      a.href = "javascript:alert(1)"
      a.target = "_blank"
      document.body.append(a)
      a.click()
      a.remove()
    })
    await page.evaluate(() => { location.href = "file:///etc/passwd" }).catch(() => {})
    await delay(1_500)
    check("links of any other scheme open nothing anywhere",
      openedUrls().length === openedBefore && (await pageCount(running.browser)) === before && page.url() === here,
      `${openedUrls().length - openedBefore} opened, ${await pageCount(running.browser)} windows, at ${page.url()}`)

    // A path the board itself does not redirect (with one project, / and /queues both forward to it).
    const projects = await (await fetch(`${origin}/_frizz/rpc/projectsList`, { headers: { "sec-fetch-site": "same-origin" } })).json() as { result?: Array<{ slug: string }> }
    const projectPath = `/project/${projects.result?.[0]?.slug ?? "unknown"}`
    const popup = new Promise<Page | null>((ok) => running!.browser.once("targetcreated", async (t) => ok(await t.page())))
    await page.evaluate((u) => { window.open(u, "_blank") }, `${origin}${projectPath}`)
    const child = await Promise.race([popup, delay(10_000).then(() => null)])
    if (child) await child.waitForFunction((p) => location.pathname === p, { timeout: 10_000 }, projectPath).catch(() => {})
    check("a same-origin window.open opens a window of the app", child?.url() === `${origin}${projectPath}`, child?.url())
    const childBridge = child ? await child.evaluate(() => typeof (window as unknown as { frizzDesktop?: unknown }).frizzDesktop) : "none"
    check("…which carries the same preload", childBridge === "object", childBridge)
    await child?.close()

    // Remember-where-I-was: go somewhere, quit the way the OS would, relaunch.
    await page.goto(`${origin}${projectPath}`)
    await page.waitForFunction((p) => location.pathname === p, { timeout: 20_000 }, projectPath)
    await running.browser.close().catch(() => {})
    for (let i = 0; i < 50 && running.child.exitCode === null; i++) await delay(200)
    stop(running)
    const state = JSON.parse(readFileSync(join(home, ".config", "Frizz Desktop", "window-state.json"), "utf8"))
    check("quitting saves the window's place", state.path === projectPath && state.bounds?.width > 0, JSON.stringify(state))
    running = await launch()
    const again = await boardPage(running.browser, origin)
    await again.waitForFunction((p) => location.pathname === p, { timeout: 20_000 }, projectPath).catch(() => {})
    check("relaunching reopens it", again.url() === `${origin}${projectPath}`, again.url())
    await delay(2_000)
    if (shots) await again.screenshot({ path: join(shots, "project.png") })
  }
} catch (error) {
  check("harness", false, error instanceof Error ? error.message : String(error))
} finally {
  if (running) stop(running)
  if (fakeStart) rmSync(home, { recursive: true, force: true })
  exitCode = results.every((r) => r.ok) ? 0 : 1
  console.log(JSON.stringify({ ok: exitCode === 0, checks: results.length, failed: results.filter((r) => !r.ok).map((r) => r.check) }))
  process.exit(exitCode)
}
