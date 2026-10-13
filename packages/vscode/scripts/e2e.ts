// THE EXTENSION, END TO END, IN A REAL VS CODE. Downloads VS Code (stable unless NTWINE_E2E_VSCODE names
// a version) into ~/.cache/ntwine-vscode-e2e with @vscode/test-electron, runs it with the extension under
// development and e2e/suite.ts as its test runner, and drives both directions of the editor bridge.
//
//   nub packages/vscode/scripts/e2e.ts
//       FAKE mode: an in-process fake Ntwine (e2e/fake-ntwine.ts) the suite asserts against frame by frame.
//       NTWINE_E2E_VSCODE=oldest runs it on the oldest VS Code the manifest's `engines.vscode` admits,
//       which is how an API newer than that floor gets caught (focusWindow, 1.128, was one).
//
//   nub packages/vscode/scripts/e2e.ts --stack
//       STACK mode: boots a disposable two-project Ntwine itself (scripts/adhoc-stack.mjs: a sandbox HOME,
//       a free port, two throwaway git repos), runs REAL mode against the TENANT project — the one the
//       server did not launch from — with a headless page open on it (e2e/page-claim.ts) that must
//       receive "Add to Ntwine prompt" as a chip in its new-thread box. Every file opener the server
//       could spawn is a stub on its PATH, and the run fails if one was spawned: the opens must all go
//       over the editor connection. A worker's `editor` tool (the real cc-worker/bin/ntwine-mcp.mjs, pointed
//       at the stack) must read this window's selection and a problem. Everything it started is torn
//       down by exact pid, pass or fail.
//       NTWINE_E2E_DISPATCH=1 adds `--creds` and runs the steps that start a real agent.
//
//   NTWINE_E2E_ORIGIN=http://127.0.0.1:<port> NTWINE_E2E_PROJECT_DIR=<a registered project's folder> \
//     nub packages/vscode/scripts/e2e.ts
//       REAL mode against an Ntwine you started — a disposable one, since it writes a sample file into the
//       project folder and, with NTWINE_E2E_SET_OPENER=1, sets Local file links to VS Code for the run.
//       NTWINE_E2E_DISPATCH=1 (+ NTWINE_E2E_THREAD=<slug>) also runs the steps that start or message a
//       real agent. NTWINE_E2E_PAGE_CLAIMS=1 leaves the prompt-box insert for a real page open on that
//       Ntwine to claim, instead of taking it itself.
//
//   nub packages/vscode/scripts/e2e.ts --sidebar [--out=<dir>] [--dev] [--only=c1,c4]
//       SIDEBAR mode: hands the run to scripts/e2e-sidebar.ts — the extension as its .vsix ships, the REAL
//       Ntwine page framed in the sidebar of a real VS Code, over a disposable two-project Ntwine with a
//       simulated worker, every seam crossed with trusted mouse and keyboard input, and screenshots of
//       each state. Its header lists the checks and its flags.
//
// NTWINE_E2E_KEEP=1 keeps the scratch folder (editor logs, the page's screenshot) even when the run passes.
//
// NEVER ON THE REAL DISPLAY. On Linux the run re-executes itself under `xvfb-run -a` with DISPLAY and
// WAYLAND_DISPLAY removed — on this machine DISPLAY=:0 is the maintainer's screen through WSLg, and a
// VS Code window popping up there is the most disruptive thing a test can do. The editor gets its own
// user-data and extensions directories and every other extension disabled; the page is headless.

import { spawnSync, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron"
import type { EditorProject } from "@ntwine/shared/editor-protocol"
import { Workbench } from "../e2e/cdp.ts"
import { FakeNtwine } from "../e2e/fake-ntwine.ts"
import { watchPageClaim, type PageClaimResult } from "../e2e/page-claim.ts"
import { seedReviewThread, type SeededReview } from "../e2e/review-seed.ts"
import { bootStack, freePort, type StackProject } from "../e2e/stack.ts"

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repo = resolve(pkg, "..", "..")

if (process.argv.includes("--sidebar")) {
  const args = process.argv.slice(2).filter((arg) => arg !== "--sidebar")
  const child = spawnSync("nub", [join(dirname(fileURLToPath(import.meta.url)), "e2e-sidebar.ts"), ...args], { stdio: "inherit" })
  process.exit(child.status ?? 1)
}

if (process.platform === "linux" && process.env.NTWINE_E2E_UNDER_XVFB !== "1") {
  const env: NodeJS.ProcessEnv = { ...process.env, NTWINE_E2E_UNDER_XVFB: "1" }
  delete env.DISPLAY
  delete env.WAYLAND_DISPLAY
  const child = spawnSync("xvfb-run", ["-a", "-s", "-screen 0 1600x1000x24", "nub", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit", env })
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

const stackMode = process.argv.includes("--stack")
if (stackMode && process.env.NTWINE_E2E_ORIGIN) {
  console.error("--stack boots its own Ntwine; unset NTWINE_E2E_ORIGIN.")
  process.exit(1)
}
const dispatch = process.env.NTWINE_E2E_DISPATCH === "1"

/** `oldest` is the manifest's floor: `engines.vscode` "^1.90.0" → "1.90.0". */
function vscodeVersion(): string {
  const wanted = process.env.NTWINE_E2E_VSCODE ?? "stable"
  if (wanted !== "oldest") return wanted
  const engines = (JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as { engines: { vscode: string } }).engines.vscode
  return engines.replace(/^[\^~>=]+/u, "")
}

const build = spawnSync("nub", ["scripts/build.ts", "--e2e"], { cwd: pkg, stdio: "inherit" })
if (build.status !== 0) process.exit(build.status ?? 1)

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-vscode-e2e-")))
const log = (line: string) => console.log(`ntwine e2e: ${line}`)

// ── STACK mode: a disposable two-project Ntwine (e2e/stack.ts), run against its TENANT ─────────────────

interface Stack {
  origin: string
  /** The sandbox HOME the server runs with: its database, and the transcripts its tailer reads. */
  home: string
  tenant: StackProject
  /** The server's lock file, which a worker's MCP server finds Ntwine by. */
  serverLock: string
  /** Every opener the server spawned; empty when every open went over the editor connection. */
  openers(): string
  teardown(): Promise<void>
}

async function bootE2eStack(): Promise<Stack> {
  const booted = await bootStack({ scratch, projects: ["launcher", "tenant"], creds: dispatch, log, onSpawn: (teardown) => (stackTeardown = teardown) })
  return { origin: booted.origin, home: booted.info.home, tenant: booted.info.tenants[0]!, serverLock: booted.info.launcher.serverLock, openers: booted.openers, teardown: booted.teardown }
}

// ── the run ───────────────────────────────────────────────────────────────────────────────────────────

let stack: Stack | undefined
/** The stack's teardown, set as soon as it is spawned; idempotent, so the boot's own failure path and the run's may both call it. */
let stackTeardown: (() => Promise<void>) | undefined
let fake: FakeNtwine | undefined
/** A second fake on another port, which the sidebar's suite moves the window to, as an Ntwine restarting elsewhere would. */
let fakeElsewhere: FakeNtwine | undefined
let exitCode = 1
let pageClaim: Promise<PageClaimResult> | undefined
const stopPage = new AbortController()
let pageBrowser: ChildProcess | undefined
let sample: string | undefined
let wroteSample = false
let tornDown = false
/** The editor's workbench over its debugging port, opened the first time the suite presses a key or reads the title row. */
let workbench: Promise<Workbench> | undefined

async function teardown(): Promise<void> {
  if (tornDown) return
  tornDown = true
  stopPage.abort()
  if (workbench) (await workbench.catch(() => undefined))?.close()
  if (pageClaim) await Promise.race([pageClaim, new Promise((resolve) => setTimeout(resolve, 15_000))])
  // The handle, not a bare pid: a browser the watcher already closed has an exit code, so its pid —
  // possibly someone else's process by now — is never signalled.
  if (pageBrowser && pageBrowser.exitCode === null && pageBrowser.signalCode === null) {
    log(`the page's browser (pid ${pageBrowser.pid}) outlived its watcher; killing it`)
    pageBrowser.kill("SIGKILL")
  }
  await fake?.close()
  await fakeElsewhere?.close()
  await stackTeardown?.()
  if (sample && wroteSample) rmSync(sample, { force: true })
}

// Interrupted (Ctrl-C, a timeout's SIGTERM): still tear down what this run started.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log(`${signal}: tearing down`)
    void teardown().finally(() => process.exit(130))
  })
}

try {
  if (stackMode) stack = await bootE2eStack()
  // A thread that worked in a worktree of the tenant, for Review changes to open (e2e/review-seed.ts).
  let review: SeededReview | undefined
  if (stack) review = seedReviewThread({ home: stack.home, project: stack.tenant, log })
  const realOrigin = stack?.origin ?? process.env.NTWINE_E2E_ORIGIN
  const mode = realOrigin ? "real" : "fake"
  const projectDir = stack?.tenant.dir ?? process.env.NTWINE_E2E_PROJECT_DIR
  if (mode === "real" && !projectDir) throw new Error("REAL mode needs NTWINE_E2E_PROJECT_DIR: a folder registered as a project in that Ntwine.")

  const workspace = mode === "real" ? realpathSync(projectDir!) : join(scratch, "workspace")
  sample = join(workspace, "src", "sample.ts")
  wroteSample = !existsSync(sample)
  mkdirSync(dirname(sample), { recursive: true })
  if (wroteSample) {
    writeFileSync(sample, [
      "export function sample(xs: number[]): number {",
      "  let total = 0",
      "  for (const x of xs) {",
      "    total += x",
      "  } // the loop's end, long enough for a column",
      "  return total",
      "}",
      "",
    ].join("\n"))
  }

  if (mode === "fake") {
    const projects: EditorProject[] = [
      { id: randomUUID(), slug: "e2e", name: "e2e", dir: workspace, ready: 0, working: 0 },
      { id: "686f6d65-0000-4000-8000-000000000000", slug: "home", name: "Home", dir: homedir(), home: true },
    ]
    fake = await new FakeNtwine(projects).listen()
    fakeElsewhere = await new FakeNtwine(structuredClone(projects)).listen()
  }
  const origin = realOrigin ?? fake!.origin

  const userData = join(scratch, "user-data")
  mkdirSync(join(userData, "User"), { recursive: true })
  writeFileSync(join(userData, "User", "settings.json"), JSON.stringify({
    "ntwine.serverUrl": origin,
    "workbench.startupEditor": "none",
    "window.restoreWindows": "none",
    "security.workspace.trust.enabled": false,
    "update.mode": "none",
    "extensions.autoUpdate": false,
    "extensions.autoCheckUpdates": false,
    "telemetry.telemetryLevel": "off",
    "git.enabled": false,
  }, null, 2))

  const pageClaims = stack ? true : process.env.NTWINE_E2E_PAGE_CLAIMS === "1"
  if (stack) {
    // "Add to Ntwine prompt" selects the sample's lines 2-3; the page must show that chip.
    pageClaim = watchPageClaim({
      origin,
      project: stack.tenant.slug,
      token: "@sample.ts:2-3",
      shot: join(scratch, "page-claim.png"),
      timeoutMs: 600_000,
      signal: stopPage.signal,
      onBrowser: (browser) => (pageBrowser = browser),
    }).catch((error: unknown): PageClaimResult => ({ ok: false, value: "", errors: [String(error)] }))
  }

  // Keys and the title row go through the workbench's debugging port (e2e/cdp.ts): a keybinding is only
  // proved by a key, and what the title row shows only by the title row. The port is a free one on
  // loopback, and the editor it belongs to is this run's own, under Xvfb.
  const debuggingPort = await freePort()
  if (fake) {
    const connect = () => (workbench ??= Workbench.connect(debuggingPort))
    fake.workbench = {
      press: async (chord) => (await connect()).press(chord),
      evaluate: async (expression) => (await connect()).evaluate(expression),
      click: async (selector) => (await connect()).click(selector),
      shot: async () => {
        const bench = await connect()
        const { width, height } = await bench.evaluate<{ width: number; height: number }>("({ width: window.innerWidth, height: window.innerHeight })")
        return bench.shot({ x: 0, y: 0, width, height })
      },
    }
  }

  const vscodeExecutablePath = await downloadAndUnzipVSCode({ version: vscodeVersion(), cachePath: join(homedir(), ".cache", "ntwine-vscode-e2e") })
  log(`${stack ? "stack" : mode} mode against ${origin}${stack ? ` (tenant ${stack.tenant.slug})` : ""}, VS Code ${vscodeExecutablePath}, DISPLAY=${process.env.DISPLAY ?? "(none)"}`)
  const suiteCode = await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: pkg,
    extensionTestsPath: join(pkg, "dist", "e2e", "suite.cjs"),
    launchArgs: [
      workspace,
      `--user-data-dir=${userData}`,
      `--extensions-dir=${join(scratch, "extensions")}`,
      "--disable-extensions",
      "--password-store=basic",
      "--disable-gpu",
      "--disable-telemetry",
      `--remote-debugging-port=${debuggingPort}`,
    ],
    extensionTestsEnv: {
      NTWINE_E2E_MODE: mode,
      NTWINE_E2E_WORKSPACE: workspace,
      NTWINE_E2E_CONTROL: fake?.origin,
      NTWINE_E2E_CONTROL_ELSEWHERE: fakeElsewhere?.origin,
      NTWINE_E2E_DISPATCH: process.env.NTWINE_E2E_DISPATCH,
      NTWINE_E2E_THREAD: process.env.NTWINE_E2E_THREAD,
      NTWINE_E2E_SET_OPENER: stack ? "1" : process.env.NTWINE_E2E_SET_OPENER,
      NTWINE_E2E_PAGE_CLAIMS: pageClaims ? "1" : undefined,
      NTWINE_E2E_ONLY: process.env.NTWINE_E2E_ONLY,
      NTWINE_E2E_REVIEW: review ? JSON.stringify(review) : undefined,
      NTWINE_E2E_SHOTS: scratch,
      // A worker's view of this window: the REAL ntwine-mcp.mjs, run by this node, finding the stack by its lock.
      NTWINE_E2E_MCP: stack ? join(repo, "cc-worker", "bin", "ntwine-mcp.mjs") : undefined,
      NTWINE_E2E_SERVER_LOCK: stack?.serverLock,
      NTWINE_E2E_NODE: stack ? process.execPath : undefined,
    },
  }).catch((error: unknown) => {
    log(`the suite did not run: ${(error as Error).message}`)
    return 1
  })
  exitCode = suiteCode

  if (pageClaim) {
    // The suite has sent its insert by now (or failed); the page gets a short grace to show it.
    const claimed = await Promise.race([pageClaim, new Promise<undefined>((resolve) => setTimeout(resolve, suiteCode === 0 ? 60_000 : 1_000))])
    if (!claimed) {
      stopPage.abort()
      log("the page never showed the chip")
      exitCode ||= 1
    } else if (!claimed.ok) {
      log(`the page never showed the chip (its new-thread box: ${JSON.stringify(claimed.value)})`)
      exitCode ||= 1
    } else {
      log(`the page claimed the insert: its new-thread box reads ${JSON.stringify(claimed.value)}`)
    }
  }
  if (stack) {
    const openers = stack.openers()
    if (openers) {
      log(`the server spawned a file opener instead of using the editor connection:\n${openers}`)
      exitCode ||= 1
    } else {
      log("no file opener was spawned: every open went over the editor connection")
    }
  }
} catch (error) {
  log((error as Error).message)
  exitCode ||= 1
} finally {
  await teardown()
  if (exitCode === 0 && process.env.NTWINE_E2E_KEEP !== "1") rmSync(scratch, { recursive: true, force: true })
  else log(`${exitCode === 0 ? "passed" : "failed"}; the editor's logs${stackMode ? ", the stack's log and the page's screenshot" : ""} are kept under ${scratch}`)
}
process.exit(exitCode)
