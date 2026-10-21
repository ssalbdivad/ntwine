// END-TO-END proof that the desktop window's dev board is a real terminal thread, through every way its
// server goes away. Electron itself is not driven (it cannot run headless here, and the window's part is
// one spawn): the harness runs the window's OWN command, `serverCommand()` from packages/desktop/src/
// launch.ts, exactly as `startServer()` spawns it, against a sandbox HOME. The one change is the dev
// command (`--command=`), which adds a port so the real `nub run dev` on 9393 is never touched.
//
// What it asserts, through the real RPC board, the real /term websocket and the process table:
//   1. the starter exits 0, a dev board answers and passes the window's ownership check (server.ts
//      ownedNtwine, what its search requires before it loads a port), and the board lists ONE top-level terminal thread
//      `@nub-run-dev` running the dev server, whose drawer shows its output and the R / L line (which
//      only a TTY prints);
//   2. a control-plane recycle (a source edit) with the daemon past the audit's 60s age guard: the
//      same thread, the same daemon pid, no second row. NEGATIVE CONTROL: an unclaimed daemon forked
//      into the same state dir beside it IS ended by that boot's audit — the audit was live;
//   3. a control-plane CRASH (SIGKILL): the supervisor brings one back, the same thread is adopted,
//      and its screen carries what the supervisor printed while no board was up;
//   4. the whole dev supervisor dying (SIGKILL): the starter run again (the window's "Start ntwine")
//      makes run 2 of the SAME thread, opening on run 1's last screen;
//   5. Ctrl-C typed into the drawer reaches the dev server, which stops: the port refuses.
//
//   nub scripts/verify-dev-terminal.ts [--port=N] [--keep]
//
// Everything it starts is ended by exact pid; the sandbox is deleted unless --keep.
import { execFileSync, spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"
import WebSocket from "ws"
import { createRpcClient } from "./lib/rpc-client.mjs"
import { serverCommand, type ServerLaunch } from "../packages/desktop/src/launch.ts"
import { ownedNtwine } from "../packages/desktop/src/server.ts"
import { createTerminalHost, readTerminalHostRecord } from "../packages/server/src/backend/terminal-host.ts"
import { ntwinePaths } from "../packages/server/src/ntwine-paths.ts"

const args = process.argv.slice(2)
const opt = (k: string): string | undefined => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3)
const REPO = resolve(import.meta.dirname, "..")
const PORT = Number(opt("port") ?? String(47_000 + Math.floor(Math.random() * 2_000)))
const KEEP = args.includes("--keep")
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const log = (...a: unknown[]) => console.log(`[verify ${new Date().toISOString().slice(11, 19)}]`, ...a)

let failures = 0
const check = (ok: boolean, label: string, detail = ""): boolean => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
  return ok
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
async function until<T>(read: () => T | undefined | Promise<T | undefined>, timeoutMs: number, everyMs = 250): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() > deadline) return undefined
    await sleep(everyMs)
  }
}

// ── the sandbox ─────────────────────────────────────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), "ntwine-verify-dev-terminal-"))
const home = join(root, "home")
const bin = join(root, "bin")
mkdirSync(home, { recursive: true })
mkdirSync(bin, { recursive: true })
const realNub = execFileSync("sh", ["-c", "command -v nub"], { encoding: "utf8" }).trim()
// `nub` on the sandbox PATH: the real one, with what scripts/adhoc-stack.mjs sets to keep a disposable
// ntwine off the machine's real processes. The terminal strips NTWINE_* from its environment (a
// terminal must not inherit the server's identity), so the dev server gets them here, from its PATH.
writeFileSync(join(bin, "nub"), `#!/bin/sh
export NTWINE_ORPHAN_REAPER_OFF=1 NTWINE_WAKERS_OFF=1 NTWINE_TENANT_PRIME_OFF=1
export NTWINE_RUNTIMES_DIR='${join(ntwinePaths().cache, "runtimes")}' NTWINE_VITE_CACHE_DIR=node_modules/.vite-scratch
exec '${realNub}' "$@"
`)
chmodSync(join(bin, "nub"), 0o755)
// As scripts/dev.ts records it: this terminal's PATH less what `nub run` put on it.
const path = [bin, ...(process.env.PATH ?? "").split(delimiter).filter((dir) => dir && !dir.includes("node_modules") && !dir.startsWith(tmpdir()))].join(delimiter)
const env: NodeJS.ProcessEnv = { HOME: home, PATH: path, SHELL: "/bin/bash", USER: process.env.USER, LANG: process.env.LANG ?? "C.UTF-8", TERM: "xterm-256color" }
const launch: ServerLaunch = { repo: REPO, nub: join(bin, "nub"), path, log: join(root, "desktop-server.log") }
const COMMAND = `nub run dev -- --port ${PORT}`
const paths = ntwinePaths({ home, env })

/** The window's start: its own command, spawned as startServer() spawns it. Resolves with the exit code. */
function runStarter(): Promise<number | null> {
  const [command, argv] = serverCommand(launch)
  const child = spawn(command, [...argv, `--command=${COMMAND}`], { cwd: launch.repo, detached: true, stdio: "ignore", env })
  return new Promise((r) => child.on("exit", (code) => r(code)))
}

interface Health { ok: boolean; bootId: string; projectId: string }
async function health(): Promise<Health | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/_ntwine/health`, { signal: AbortSignal.timeout(1_500) })
    const body = (await res.json()) as Health
    return body.ok === true ? body : undefined
  } catch {
    return undefined
  }
}
const api = () => createRpcClient(`http://127.0.0.1:${PORT}/`)

interface TerminalRow { id: string; kind?: string; title?: string; state?: string; terminal?: { id: string; command: string; state: string; runId: number; parent?: string; handle?: string; startedBy?: string } }
async function terminalThreads(): Promise<TerminalRow[]> {
  const board = (await api().query("board")) as { threads: TerminalRow[] }
  return board.threads.filter((t) => t.kind === "terminal")
}

/** The real /term websocket: the replay, then whatever arrives within `forMs` (or until `untilText`). With
 *  `send`, `untilText` is matched only against what arrives AFTER the keystroke went out: a carried screen
 *  can already hold the very line being waited for. */
function attachTerm(id: string, opts: { forMs: number; send?: string; untilText?: RegExp }): Promise<string> {
  return new Promise((resolveText) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/_ntwine/term/${id}`, { headers: { Origin: `http://127.0.0.1:${PORT}` } })
    let text = ""
    let from = opts.send ? Infinity : 0
    const finish = () => { try { ws.close() } catch {} resolveText(text) }
    const timer = setTimeout(finish, opts.forMs)
    ws.on("message", (data) => {
      text += String(data)
      if (opts.untilText?.test(text.slice(from))) { clearTimeout(timer); finish() }
    })
    ws.on("open", () => { if (opts.send) setTimeout(() => { from = text.length; ws.send(JSON.stringify({ t: "input", d: opts.send })) }, 300) })
    ws.on("error", () => { clearTimeout(timer); finish() })
    ws.on("close", () => { clearTimeout(timer); resolveText(text) })
  })
}
const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")

/** Every process running with this sandbox HOME, with what it runs and whether it is a control plane. */
function sandboxProcesses(): { pid: number; cmd: string; child: boolean }[] {
  const out: { pid: number; cmd: string; child: boolean }[] = []
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue
    try {
      const environ = readFileSync(`/proc/${name}/environ`, "utf8").split("\0")
      if (!environ.includes(`HOME=${home}`)) continue
      out.push({ pid: Number(name), cmd: readFileSync(`/proc/${name}/cmdline`, "utf8").replaceAll("\0", " ").trim(), child: environ.includes("NTWINE_DEV_CHILD=1") })
    } catch {}
  }
  return out
}

let stateDir = ""
const owned = new Set<number>()
const touchFile = join(REPO, "packages/server/src/zz-verify-dev-terminal-touch.ts")

try {
  log(`sandbox ${root}, dev board on ${PORT}`)

  // ── 1. the window starts the dev board ─────────────────────────────────────────────────────────────
  const t0 = Date.now()
  const code = await Promise.race([runStarter(), sleep(240_000).then(() => "timeout" as const)])
  const starterLog = existsSync(launch.log) ? readFileSync(launch.log, "utf8") : ""
  check(code === 0, "the window's starter exits 0 once a server made the thread", `exit ${code} after ${Math.round((Date.now() - t0) / 1000)}s`)
  const first = await until(health, 120_000)
  if (!check(first !== undefined, "a dev board answers on the port", `${PORT}`)) throw new Error(`no board:\n${starterLog}`)
  stateDir = join(paths.data, "projects", first!.projectId)
  // What the window's search requires before it loads a port: a board that proves it is ours.
  check(await ownedNtwine(PORT, paths), "the window's search would load it: the board proves it is ours")
  const id = /terminal (term-[0-9a-f]{12})/.exec(starterLog)?.[1] ?? ""
  const rows = await terminalThreads()
  check(rows.length === 1 && rows[0]!.id === id, "the board lists exactly one terminal thread, the one the starter made", JSON.stringify(rows.map((r) => r.id)))
  const t = rows[0]?.terminal
  check(t?.command === COMMAND && t.state === "running" && t.parent === undefined && t.handle === "nub-run-dev" && t.startedBy === "human",
    "it is a top-level, running `@nub-run-dev` the human started", JSON.stringify(t))
  const screen1 = plain(await attachTerm(id, { forMs: 15_000, untilText: /press R|reachable at/ }))
  check(/\[ntwine\] ready at http:\/\/127\.0\.0\.1:\d+/.test(screen1), "its drawer shows the dev server's own output", screen1.match(/\[ntwine\] ready at \S+/)?.[0] ?? screen1.slice(-300))
  check(/press R|reachable at/.test(screen1), "the dev server got a TTY: its R / L keys are wired", screen1.match(/\[ntwine\] (press R[^\r\n]*|reachable at[^\r\n]*)/)?.[0] ?? "")
  const record = readTerminalHostRecord(stateDir, id)
  const daemonPid = record?.daemonPid ?? 0
  owned.add(daemonPid)
  check(daemonPid > 0 && alive(daemonPid), "its daemon is alive", `pid ${daemonPid}`)

  // ── 2. a recycle past the audit's age guard, with a negative control ─────────────────────────────
  const stray = await createTerminalHost({ stateDir }).fork({ id: "term-0000000000ff", runId: 1, file: "/bin/sh", args: ["-c", "exec sleep 600"], cwd: root, env: { PATH: "/usr/bin:/bin" }, interactive: false, echoed: false, cols: 80, rows: 24 })
  const strayPid = "record" in stray ? stray.record.daemonPid : 0
  owned.add(strayPid)
  check(strayPid > 0 && alive(strayPid), "negative control: an unclaimed daemon runs beside it", `pid ${strayPid}`)
  const eligibleAt = Math.max(Date.parse(record?.createdAt ?? ""), Date.now()) + 62_000
  log(`waiting ${Math.round((eligibleAt - Date.now()) / 1000)}s for both daemons to pass the audit's 60s age guard`)
  await sleep(eligibleAt - Date.now())
  writeFileSync(touchFile, "// verify-dev-terminal: a source edit, to recycle the control plane. Deleted by the harness.\nexport {}\n")
  const second = await until(async () => { const h = await health(); return h && h.bootId !== first!.bootId ? h : undefined }, 120_000)
  check(second !== undefined, "a source edit recycled the control plane", second ? `boot ${first!.bootId.slice(0, 8)} → ${second.bootId.slice(0, 8)}` : "no new boot")
  const afterRecycle = await terminalThreads()
  check(afterRecycle.length === 1 && afterRecycle[0]!.id === id && afterRecycle[0]!.terminal?.state === "running" && afterRecycle[0]!.terminal?.runId === 1,
    "after the recycle: the same one thread, still run 1, still running", JSON.stringify(afterRecycle.map((r) => [r.id, r.terminal?.state, r.terminal?.runId])))
  check(alive(daemonPid) && readTerminalHostRecord(stateDir, id)?.daemonPid === daemonPid, "the same daemon, never reaped", `pid ${daemonPid}`)
  const strayEnded = await until(() => (alive(strayPid) ? undefined : true), 15_000)
  check(strayEnded === true, "negative control: that boot's audit ended the unclaimed daemon", `pid ${strayPid}`)

  // ── 3. a control-plane crash ───────────────────────────────────────────────────────────────────────
  const controlPlane = sandboxProcesses().find((p) => p.child && /^(\S*\/)?node\s/.test(p.cmd))
  check(controlPlane !== undefined, "found the running control plane", controlPlane ? `pid ${controlPlane.pid}` : JSON.stringify(sandboxProcesses()))
  if (controlPlane) process.kill(controlPlane.pid, "SIGKILL")
  const third = await until(async () => { const h = await health(); return h && h.bootId !== second?.bootId ? h : undefined }, 120_000)
  check(third !== undefined, "the supervisor brought a control plane back after the crash")
  const afterCrash = await terminalThreads()
  check(afterCrash.length === 1 && afterCrash[0]!.id === id && afterCrash[0]!.terminal?.state === "running", "after the crash: the same one thread, running", JSON.stringify(afterCrash.map((r) => [r.id, r.terminal?.state])))
  const screen3 = plain(await attachTerm(id, { forMs: 4_000 }))
  check(/control plane stopped|crash|exited|signal/i.test(screen3.slice(screen1.length - 200)), "its screen kept what the supervisor printed while no board was up",
    screen3.split(/\r?\n/).filter((l) => /control plane stopped|crash|exited|signal/i.test(l)).slice(-2).join(" | "))
  check(alive(daemonPid), "the same daemon throughout", `pid ${daemonPid}`)

  // ── 4. the dev supervisor itself dies; the window starts it again ────────────────────────────────
  // The node process itself, not the `nub` wrappers above it (whose path also says "node").
  const supervisor = sandboxProcesses().find((p) => !p.child && /^(\S*\/)?node\s.*src\/dev\.ts/.test(p.cmd))
  check(supervisor !== undefined, "found the dev supervisor", supervisor ? `pid ${supervisor.pid}` : "")
  for (const p of sandboxProcesses()) if (p.child) owned.add(p.pid)
  if (supervisor) process.kill(supervisor.pid, "SIGKILL")
  const daemonGone = await until(() => (alive(daemonPid) ? undefined : true), 30_000)
  check(daemonGone === true, "the run ended with its supervisor, and its daemon with it")
  // A control plane orphaned by the kill may still hold the port for a moment; the new supervisor needs it.
  for (const pid of owned) if (pid !== daemonPid && alive(pid)) { try { process.kill(pid, "SIGKILL") } catch {} }
  await until(async () => ((await health()) ? undefined : true), 30_000)
  const code2 = await Promise.race([runStarter(), sleep(240_000).then(() => "timeout" as const)])
  check(code2 === 0, "\"Start ntwine\": the starter exits 0 again", `exit ${code2}`)
  await until(health, 120_000)
  const afterRestart = await terminalThreads()
  check(afterRestart.length === 1 && afterRestart[0]!.id === id && afterRestart[0]!.terminal?.runId === 2 && afterRestart[0]!.terminal?.state === "running",
    "run 2 of the SAME thread, not a second one", JSON.stringify(afterRestart.map((r) => [r.id, r.terminal?.state, r.terminal?.runId, r.terminal?.handle])))
  const screen4 = plain(await attachTerm(id, { forMs: 15_000, untilText: /\$ nub run dev[\s\S]*ready at/ }))
  check(/ready at[\s\S]*\$ nub run dev -- --port \d+[\s\S]*ready at/.test(screen4), "it opens on run 1's last screen, then its own `$ nub run dev` line and output",
    `${(screen4.match(/ready at/g) ?? []).length} ready lines`)
  const daemon2 = readTerminalHostRecord(stateDir, id)?.daemonPid ?? 0
  owned.add(daemon2)

  // ── 5. Ctrl-C in the drawer ────────────────────────────────────────────────────────────────────────
  const watching = attachTerm(id, { forMs: 60_000, send: "\x03", untilText: /stopping/ })
  const stopped = await until(async () => ((await health()) ? undefined : true), 60_000)
  const screen5 = plain(await watching)
  check(stopped === true, "Ctrl-C typed into the drawer stopped the dev server: the port refuses", screen5.split(/\r?\n/).filter((l) => /stopping|\^C/.test(l)).slice(-2).join(" | ") || screen5.slice(-400))
  check((await until(() => (alive(daemon2) ? undefined : true), 30_000)) === true, "and its terminal's run ended", `daemon ${daemon2}`)
} catch (error) {
  failures++
  console.error("harness error:", error)
  if (existsSync(launch.log)) console.error(readFileSync(launch.log, "utf8").slice(-3000))
} finally {
  try { unlinkSync(touchFile) } catch {}
  for (const p of sandboxProcesses()) owned.add(p.pid)
  for (const pid of owned) if (pid > 0 && alive(pid)) { try { process.kill(pid, "SIGKILL") } catch {} }
  const left = await until(() => (sandboxProcesses().length ? undefined : true), 10_000)
  check(left === true, "cleanup: nothing runs under the sandbox HOME", JSON.stringify(sandboxProcesses().map((p) => p.pid)))
  if (KEEP) log(`kept ${root}`)
  else rmSync(root, { recursive: true, force: true })
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS")
process.exit(failures ? 1 : 0)
