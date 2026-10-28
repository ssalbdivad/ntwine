// END-TO-END proof that a thread terminal survives a REAL control-plane replacement.
//
// Two thread terminals' worth of what matters to a human — a `sleep 600` and a TCP listener standing in
// for `npm run dev` — plus a run that reaches a prompt and one that exits while ntwine is down, all
// started through the real `terminalStart` RPC on a disposable ntwine (scripts/adhoc-stack.mjs, a sandbox
// HOME). Then the SERVER PROCESS IS REPLACED, twice: once by SIGTERM (Restart ntwine, an update) and once
// by SIGKILL (a crash), each followed by a fresh `adhoc-stack.mjs --home=<same>` on the same port. It
// asserts, through the real RPC board and the real /term websocket:
//   - the same pids are alive after each replacement, and the listener still answers on its port —
//     including while NO server is running;
//   - reattaching over /term replays the screen the run printed before the restart;
//   - a prompt the run reached while no server was up reads as waiting for input, and an answer typed
//     after the restart reaches the same process;
//   - a run that exited while no server was up is filed with its own exit code;
//   - Stop after a restart ends the whole process group: the listener the shell forked is gone and the
//     port refuses.
// NEGATIVE CONTROLS:
//   - in-run: one terminal's daemon AND pty are SIGKILLed while the server is down, so nothing could
//     have recorded its end. It must read as interrupted (no exit code) — the harness can tell a
//     survivor from a corpse;
//   - whole-run: `--repo=/path/to/an/older/checkout` runs the identical script against a build where
//     the pty is a server child. It must FAIL (every survival check goes red). Run it once when you
//     change this file; a harness that has never gone red is not evidence.
//
//   node scripts/verify-terminal-host-restart.ts [--repo=/abs/checkout] [--port=N]
//
// Everything it starts is ended by exact pid at the end; the sandbox HOME and project are deleted.
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { existsSync, globSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createConnection, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import WebSocket from "ws"
import { createRpcClient } from "./lib/rpc-client.mjs"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const args = process.argv.slice(2)
const opt = (k: string, d?: string): string | undefined => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const REPO = resolve(opt("repo", resolve(import.meta.dirname, ".."))!)
const PORT = Number(opt("port", String(47_000 + Math.floor(Math.random() * 2_000))))
const PARENT = "host-parent"
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const log = (...a: unknown[]) => console.log("[verify]", ...a)

let failures = 0
const check = (ok: boolean, label: string, detail = ""): boolean => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
  return ok
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
async function until<T>(read: () => T | undefined | Promise<T | undefined>, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() > deadline) return undefined
    await sleep(100)
  }
}

function freePort(): Promise<number> {
  return new Promise((resolvePort) => {
    const server = createServer()
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolvePort(port))
    })
  })
}

/** Whether something answers "pong" on the port. */
function answers(port: number): Promise<boolean> {
  return new Promise((resolveAnswer) => {
    const sock = createConnection({ port, host: "127.0.0.1" })
    let got = ""
    const done = (ok: boolean) => { sock.destroy(); resolveAnswer(ok) }
    sock.setTimeout(2_000, () => done(false))
    sock.on("data", (chunk) => { got += chunk.toString(); if (got.includes("pong")) done(true) })
    sock.on("error", () => done(false))
    sock.on("close", () => done(got.includes("pong")))
  })
}

// ── the stack ─────────────────────────────────────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), "ntwine-verify-term-host-"))
const home = join(root, "home")
const project = join(root, "project")
mkdirSync(project, { recursive: true })
execFileSync("git", ["init", "-q"], { cwd: project })
writeFileSync(join(project, "README.md"), "# verify fixture\n")
let stack: ChildProcess | undefined
let stackLog = ""

async function bootStack(n: number): Promise<void> {
  stackLog = join(root, `stack-${n}.log`)
  // The SAME sandbox HOME every time (--home implies --keep), so the database and terminal records carry over.
  stack = spawn(process.execPath, [join(REPO, "scripts/adhoc-stack.mjs"), `--port=${PORT}`, `--project=${project}`, `--home=${home}`], {
    cwd: REPO,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group: a crash has to take the stack and everything it started down together —
    // exactly as a real launcher's group goes. Terminal daemons sit in groups of their own.
    detached: true,
  })
  const out: string[] = []
  stack.stdout!.on("data", (c) => out.push(String(c)))
  stack.stderr!.on("data", (c) => out.push(String(c)))
  const line = await until(() => out.join("").split("\n").find((l) => l.startsWith("{") && l.includes('"url"')), 90_000)
  writeFileSync(stackLog, out.join(""))
  if (!line) throw new Error(`stack ${n} did not come up:\n${out.join("").slice(-3000)}`)
  log(`stack ${n} up (pid ${stack.pid}) on ${PORT}`)
}

async function stopStack(signal: NodeJS.Signals): Promise<void> {
  const child = stack
  if (!child?.pid) return
  const exited = new Promise<void>((r) => child.once("exit", () => r()))
  try { process.kill(-child.pid, signal) } catch {}
  await Promise.race([exited, sleep(30_000)])
  stack = undefined
  log(`stack stopped by ${signal}`)
}

const api = () => createRpcClient(`http://127.0.0.1:${PORT}/`)

interface TermView { id: string; state: string; exitCode?: number; stopped?: boolean; awaitingInput?: boolean }
async function terminals(): Promise<Map<string, TermView>> {
  const board = await api().query("board") as { threads: Array<{ id: string; terminals?: TermView[] }> }
  return new Map((board.threads.find((t) => t.id === PARENT)?.terminals ?? []).map((t) => [t.id, t]))
}

/** Attach over the real /term websocket: the replay, then whatever arrives within `forMs`. */
function attachTerm(id: string, opts: { forMs: number; send?: string; untilText?: RegExp }): Promise<string> {
  return new Promise((resolveText) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/_ntwine/term/${id}`, { headers: { Origin: `http://127.0.0.1:${PORT}` } })
    let text = ""
    const finish = () => { try { ws.close() } catch {} resolveText(text) }
    const timer = setTimeout(finish, opts.forMs)
    ws.on("message", (data) => {
      text += String(data)
      if (opts.untilText?.test(text)) { clearTimeout(timer); finish() }
    })
    ws.on("open", () => { if (opts.send) setTimeout(() => ws.send(JSON.stringify({ t: "input", d: opts.send })), 300) })
    ws.on("error", () => { clearTimeout(timer); finish() })
    ws.on("close", () => { clearTimeout(timer); resolveText(text) })
  })
}

function hostRecord(id: string): { daemonPid: number; ptyPid: number } | undefined {
  const path = globSync(join(home, ".ntwine/projects/*/terminal-host", `${id}.json`))[0]
  if (!path || !existsSync(path)) return undefined
  try { return JSON.parse(readFileSync(path, "utf8")) } catch { return undefined }
}

const owned = new Set<number>() // every pid this harness may have to end at the end

try {
  const listenPort = await freePort()
  await bootStack(1)

  // A parent thread: the one hand-written fixture row the ntwine-stack recipe sanctions.
  const sandbox = resolveSandboxDb(home)
  const { cols, vals } = sessionProjectColumns(sandbox)
  execFileSync("sqlite3", [sandbox.db, `INSERT INTO session (${cols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode)
    VALUES (${vals}'${PARENT}', '7e57a11e-0000-4000-9000-000000000001', 'ntwine-${PARENT}', '${new Date().toISOString()}', 'Terminal host', 'claude', 'opus', 'high', 'default')`])
  await until(async () => ((await api().query("board")) as { threads: Array<{ id: string }> }).threads.some((t) => t.id === PARENT) || undefined, 20_000)

  const listener = `require('net').createServer((s) => s.end('pong\\n')).listen(${listenPort}, '127.0.0.1', () => console.log('listening on ${listenPort}'))`
  const start = async (command: string) => ((await api().mutate("terminalStart", { slug: PARENT, command })) as { id: string }).id
  const sleeper = await start("echo pid=$$; exec sleep 600")
  const server = await start(`echo pid=$$; node -e "${listener}" & echo child=$!; wait`)
  const prompter = await start("echo pid=$$; sleep 4; printf 'Enter code: '; read x; echo \"got=$x\"; exec sleep 600")
  const quitter = await start("echo pid=$$; sleep 4; echo last-words; exit 7")
  const corpse = await start("echo pid=$$; exec sleep 600")
  const startedAt = Date.now()
  log("terminals", { sleeper, server, prompter, quitter, corpse })

  const pidOf = async (id: string): Promise<number> => Number(/pid=(\d+)/.exec(await attachTerm(id, { forMs: 3_000, untilText: /pid=\d+\r?\n/ }))?.[1] ?? 0)
  const sleeperPid = await pidOf(sleeper)
  const serverScreen = await attachTerm(server, { forMs: 5_000, untilText: /listening on/ })
  const serverPid = Number(/pid=(\d+)/.exec(serverScreen)?.[1] ?? 0)
  const listenerPid = Number(/child=(\d+)/.exec(serverScreen)?.[1] ?? 0)
  const prompterPid = await pidOf(prompter)
  const corpsePid = await pidOf(corpse)
  for (const pid of [sleeperPid, serverPid, listenerPid, prompterPid, corpsePid]) if (pid) owned.add(pid)
  check(sleeperPid > 0 && alive(sleeperPid), "the sleeper is running before the restart", `pid ${sleeperPid}`)
  check(/listening on/.test(serverScreen) && await answers(listenPort), "the dev-server stand-in answers before the restart", `listener pid ${listenerPid}`)

  // ── replacement 1: SIGTERM, the way Restart ntwine or an update replaces the control plane ────────
  await stopStack("SIGTERM")
  check(alive(sleeperPid), "with NO server running, the sleeper is still alive", `pid ${sleeperPid}`)
  check(await answers(listenPort), "with NO server running, the listener still answers on its port")
  // The negative control: end this run's daemon and pty outright, so nothing can record how it ended.
  const corpseRecord = hostRecord(corpse)
  for (const pid of [corpseRecord?.daemonPid, corpsePid]) if (pid) { try { process.kill(pid, "SIGKILL") } catch {} }
  // Long enough for the prompt (at +4s) to sit past its 3s quiet window and for the quitter to exit.
  await sleep(Math.max(0, startedAt + 9_000 - Date.now()))

  await bootStack(2)
  let views = await terminals()
  check(views.get(sleeper)?.state === "running" && alive(sleeperPid), "after the restart the sleeper reads as running, the same pid alive", JSON.stringify(views.get(sleeper)))
  const reattached = await attachTerm(sleeper, { forMs: 3_000, untilText: /pid=\d+/ })
  check(reattached.includes(`pid=${sleeperPid}`), "reattaching over /term replays the screen printed before the restart", JSON.stringify(reattached.slice(0, 80)))
  check(views.get(server)?.state === "running" && await answers(listenPort), "the listener's terminal reads as running and still answers", JSON.stringify(views.get(server)))
  views = (await until(async () => { const v = await terminals(); return v.get(prompter)?.awaitingInput ? v : undefined }, 8_000)) ?? views
  check(views.get(prompter)?.awaitingInput === true, "a prompt reached while no server was up reads as waiting for input", JSON.stringify(views.get(prompter)))
  const answered = await attachTerm(prompter, { forMs: 5_000, send: "42\r", untilText: /got=42/ })
  check(/got=42/.test(answered) && alive(prompterPid), "an answer typed after the restart reaches the same process", JSON.stringify(answered.slice(-60)))
  check(views.get(quitter)?.state === "exited" && views.get(quitter)?.exitCode === 7, "a run that exited while no server was up is filed with its own code", JSON.stringify(views.get(quitter)))
  check(/last-words/.test(await attachTerm(quitter, { forMs: 2_000 })), "and its last screen is still there to read")
  check(views.get(corpse)?.state === "exited" && views.get(corpse)?.exitCode === undefined, "NEGATIVE CONTROL: a run whose daemon was killed outright reads as interrupted", JSON.stringify(views.get(corpse)))

  // ── replacement 2: SIGKILL, a crash — no shutdown path runs at all ──────────────────────────────
  await stopStack("SIGKILL")
  check(alive(sleeperPid) && await answers(listenPort), "a crashed server takes neither terminal with it")
  await bootStack(3)
  views = await terminals()
  check(views.get(sleeper)?.state === "running" && views.get(server)?.state === "running", "after the crash both are adopted again", JSON.stringify([views.get(sleeper), views.get(server)]))

  // ── Stop after two restarts still ends the whole group ─────────────────────────────────────────
  await api().mutate("terminalStop", { id: server })
  const gone = await until(() => (!alive(listenerPid) && !alive(serverPid) ? true : undefined), 10_000)
  check(gone === true, "Stop ends the shell AND the listener it forked", `shell ${serverPid} alive=${alive(serverPid)}, listener ${listenerPid} alive=${alive(listenerPid)}`)
  check(!(await answers(listenPort)), "and the port refuses")
  views = await terminals()
  check(views.get(server)?.state === "exited" && views.get(server)?.stopped === true, "and the row reads as stopped", JSON.stringify(views.get(server)))

  for (const id of [sleeper, prompter]) { try { await api().mutate("terminalStop", { id }) } catch {} }
} catch (error) {
  check(false, "harness ran to the end", (error as Error).stack ?? String(error))
} finally {
  try { await stopStack("SIGTERM") } catch {}
  // Anything still alive that this run started, by exact pid: the pty processes and every daemon.
  for (const path of globSync(join(home, ".ntwine/projects/*/terminal-host/*.json"))) {
    if (path.endsWith(".exit.json")) continue
    try { owned.add((JSON.parse(readFileSync(path, "utf8")) as { daemonPid: number }).daemonPid) } catch {}
  }
  for (const pid of owned) if (alive(pid)) { try { process.kill(pid, "SIGKILL") } catch {} }
  rmSync(root, { recursive: true, force: true })
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
