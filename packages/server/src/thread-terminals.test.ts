import { after, test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { ThreadSlug } from "@ntwine/shared"
import { createStorage, type Storage } from "./storage.ts"
import { createTerminalHost, type TerminalHost } from "./backend/terminal-host.ts"
import { commandEnvironment, createTerminalRunner, endsOnPrompt, followUpScreen, type TerminalRunner, type TerminalRunnerDeps } from "./thread-terminals.ts"

// REAL ptys and a real SQLite file: the runner's whole job is the seam between a shell, its process
// group and the rows the board renders, and a fake pty would only prove the fake. The one injected seam
// is `loadPty`, for the case a real machine produces by NOT having the addon.

const posix = process.platform !== "win32"
const PARENT = "fix-auth"

// Every runner a test made, hung up once the file is done — so a failed assertion cannot leave a live
// pty holding the test process open (the runner's own shutdown SIGHUPs every process group it owns).
const runners: TerminalRunner[] = []
// A HOSTED run outlives its runner's shutdown by design, so a hosted test's daemons are ended here too.
const hosts: TerminalHost[] = []
after(() => {
  for (const runner of runners) runner.shutdown()
  for (const host of hosts) for (const record of host.live()) host.end(record.id)
})

// Every behaviour below runs twice: with the pty in this process (Windows, and the fallback) and with
// it in a REAL detached terminal daemon (production on POSIX). The board must not tell them apart.
type Mode = "in-process" | "hosted"
let mode: Mode = "in-process"
function both(name: string, fn: () => Promise<void>): void {
  for (const each of ["in-process", "hosted"] as const) {
    test(`${name} [${each}]`, { skip: !posix }, async () => {
      mode = each
      try { await fn() } finally { mode = "in-process" }
    })
  }
}

function harness(opts: { storage?: Storage; dir?: string; inputQuietMs?: number; loadPty?: TerminalRunnerDeps["loadPty"]; hosted?: boolean } = {}) {
  const dir = opts.dir ?? realpathSync(mkdtempSync(join(tmpdir(), "ntwine-term-")))
  const store = opts.storage ?? createStorage(join(dir, "ui.db"), "p")
  let changes = 0
  const hosted = opts.hosted ?? mode === "hosted"
  const host = hosted ? createTerminalHost({ stateDir: dir, stopGraceMs: 1_000, ...(opts.inputQuietMs === undefined ? {} : { inputQuietMs: opts.inputQuietMs }) }) : undefined
  if (host) hosts.push(host)
  const runner = createTerminalRunner({
    storage: store,
    onChange: () => { changes++ },
    // `sh`, not the operator's login shell: a test must not depend on what ~/.profile prints.
    env: { ...process.env, SHELL: "/bin/sh", NTWINE_LOG_FILE: "/must/not/leak" },
    stopGraceMs: 1_000,
    ...(opts.inputQuietMs === undefined ? {} : { inputQuietMs: opts.inputQuietMs }),
    ...(opts.loadPty ? { loadPty: opts.loadPty } : {}),
    // A hosted run that quietly fell back to an in-process pty would pass every test for the wrong reason.
    ...(host ? { host, log: (m: string) => { if (/did not start/.test(m)) throw new Error(m) } } : {}),
  })
  runners.push(runner)
  const start = (command: string | undefined, parent = PARENT, cwd = dir) => runner.start({ parent, command, cwd })
  return { runner, storage: store, dir, host, start, changes: () => changes }
}

async function until<T>(read: () => T | undefined, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** A terminal as its thread's row carries it. */
function term(runner: TerminalRunner, id: string, parent = PARENT) {
  return runner.byThread().get(parent)?.find((t) => t.id === id)
}

function exitedTerm(runner: TerminalRunner, id: string) {
  return until(() => (term(runner, id)?.state === "exited" ? term(runner, id) : undefined), `${id} to exit`)
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

both("a finished command keeps its output and exit code on its thread, and a late viewer still sees both", async () => {
  const { runner, dir, start } = harness()
  const { id } = await start("printf 'hello from %s\\n' \"$PWD\"; printf 'leak=%s\\n' \"${NTWINE_LOG_FILE:-none}\"; exit 3")
  assert.ok(ThreadSlug.safeParse(id).success)
  assert.match(id, /^term-[0-9a-f]{12}$/)
  const exited = await exitedTerm(runner, id)
  assert.equal(exited.exitCode, 3)
  assert.equal(exited.stopped, undefined)
  assert.equal(exited.cwd, dir)
  assert.equal(exited.shell, undefined)

  // A viewer attaching AFTER the exit gets the replay first and the exit (with its code) after it.
  const attachment = runner.attach(id)
  assert.ok(attachment)
  attachment.onData(() => {})
  const screen = attachment.replay()
  const code = await new Promise<number | undefined>((resolve) => attachment.onExit(resolve))
  assert.equal(code, 3)
  // It ran in the folder it was given — the thread's working folder, not the server's.
  assert.match(screen, new RegExp(`hello from ${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))
  // The server's own NTWINE_* identity never reaches the command.
  assert.match(screen, /leak=none/)
  runner.shutdown()
})

both("an empty command opens the human's shell there, named for it, and its own prompt never queues the thread", async () => {
  const { runner, dir, start } = harness({ inputQuietMs: 150 })
  const { id } = await start(undefined)
  const shell = term(runner, id)!
  assert.equal(shell.command, "sh")
  assert.equal(shell.shell, true)
  assert.equal(shell.state, "running")
  const attachment = runner.attach(id)!
  let output = ""
  attachment.onData((chunk) => { output += chunk })
  attachment.write("echo \"at=$(pwd)\"\r")
  await until(() => (output.includes(`at=${dir}`) ? true : undefined), "pwd in the shell")
  // Sitting at `$ ` well past the quiet window: a shell is interactive by design, not asking.
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.equal(term(runner, id)?.awaitingInput, undefined)
  // Idle at its own prompt, it is nothing Mark as done has to confirm; running a command, it is.
  assert.deepEqual(runner.live(PARENT), [], "an idle shell is not running anything")
  attachment.write("sleep 1\r")
  await until(() => (runner.live(PARENT).length === 1 ? true : undefined), "the shell's command to read as running")
  await until(() => (runner.live(PARENT).length === 0 ? true : undefined), "the shell to go idle again")
  attachment.write("exit 0\r")
  assert.equal((await exitedTerm(runner, id)).exitCode, 0)
  runner.shutdown()
})

both("stop ends the whole process group — the shell's children too — and records it as stopped", async () => {
  const { runner, start } = harness()
  // The shell forks a child and waits on it, the shape of `npm run dev` forking node.
  const { id } = await start("sleep 60 & echo child=$!; wait")
  const attachment = runner.attach(id)!
  let output = ""
  attachment.onData((chunk) => { output += chunk })
  const child = Number(await until(() => /child=(\d+)/.exec(output + attachment.replay())?.[1], "the child pid"))
  assert.ok(alive(child), "negative control: the child is running before Stop")
  assert.equal(term(runner, id)?.state, "running")
  assert.deepEqual(runner.live(PARENT).map((t) => t.id), [id])

  await runner.stop(id)
  const exited = term(runner, id)!
  assert.equal(exited.state, "exited")
  assert.equal(exited.stopped, true)
  assert.deepEqual(runner.live(PARENT), [])
  await until(() => (alive(child) ? undefined : true), "the child to die")
  runner.shutdown()
})

both("marking the thread done stops every terminal on it and files them away; another thread's are untouched", async () => {
  const { runner, start } = harness()
  const a = await start("sleep 60")
  const b = await start("sleep 60 & wait")
  const other = await start("sleep 60", "other-thread")
  assert.deepEqual(runner.live(PARENT).map((t) => t.id).sort(), [a.id, b.id].sort())

  await runner.closeThread(PARENT)
  assert.deepEqual(runner.live(PARENT), [], "nothing on the done thread is still running")
  assert.equal(runner.byThread().get(PARENT), undefined, "and its strip is empty")
  assert.equal(term(runner, other.id, "other-thread")?.state, "running", "the other thread's terminal is not its business")
  // Filed away, not forgotten: the rows remain, stopped, and a restart brings one back into the strip.
  await runner.restart(a.id)
  assert.equal(term(runner, a.id)?.state, "running")
  assert.equal(term(runner, a.id)?.runId, 2)

  await runner.forgetThread(PARENT)
  assert.equal(runner.has(a.id), false)
  assert.equal(runner.has(b.id), false)
  assert.equal(runner.attach(a.id), null)
  assert.equal(runner.has(other.id), true)
  runner.shutdown()
})

both("restart is a fresh run of the same command; remove forgets the terminal", async () => {
  const { runner, start } = harness()
  const { id } = await start("sleep 60")
  assert.equal(term(runner, id)!.runId, 1)
  await runner.restart(id)
  const second = term(runner, id)!
  assert.equal(second.runId, 2)
  assert.equal(second.state, "running")
  assert.equal(second.command, "sleep 60")

  await runner.remove(id)
  assert.equal(term(runner, id), undefined)
  assert.equal(runner.attach(id), null)
  runner.shutdown()
})

both("a follow-up run is the terminal's next command, on a screen that carries the last one's output", async () => {
  const { runner, start } = harness()
  const { id } = await start("printf 'first-out\\n'")
  await exitedTerm(runner, id)
  await runner.run(id, "printf 'second-out\\n'; exit 4")
  const next = term(runner, id)!
  assert.equal(next.command, "printf 'second-out\\n'; exit 4")
  assert.equal(next.runId, 2)

  const attachment = runner.attach(id)!
  attachment.onData(() => {})
  const code = await new Promise<number | undefined>((resolve) => attachment.onExit(resolve))
  assert.equal(code, 4)
  // One session, in order: the first command's line and output, then the second's.
  const screen = attachment.replay().replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
  const order = ["$ printf 'first-out\\n'", "first-out", "$ printf 'second-out\\n'; exit 4", "second-out"].map((part) => screen.indexOf(part))
  assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]!)), `out of order: ${JSON.stringify(screen)}`)

  // A third run does not repeat the lines the second already carries.
  await runner.run(id, "true")
  const third = runner.attach(id)!.replay()
  assert.equal(third.split("first-out\r\n").length - 1, 1)
  assert.equal(third.split("$\x1b[22m printf 'first-out").length - 1, 1)
  runner.shutdown()
})

test("a follow-up after the server lost the last run's screen opens on just its own line", () => {
  assert.equal(followUpScreen(undefined, "ls"), "\x1b[2m$\x1b[22m ls\r\n")
  // An unterminated last line (a prompt, `printf` without \n) is closed before the next command's.
  assert.match(followUpScreen({ command: "a", buffer: "no-newline", echoed: true }, "b"), /no-newline\x1b\[0m\x1b\[\?25h\r\n\x1b\[2m\$/)
  // …and a terminated one is not given a second, blank line.
  assert.equal(followUpScreen({ command: "a", buffer: "out\r\n", echoed: true }, "b"), "out\r\n\x1b[0m\x1b[?25h\x1b[2m$\x1b[22m b\r\n")
  // A shell drew its own prompts, so its screen is carried as it is, with no invented `$ sh` line.
  assert.equal(followUpScreen({ command: "sh", buffer: "$ ls\r\na\r\n", echoed: false, interactive: true }, "b"), "$ ls\r\na\r\n\x1b[0m\x1b[?25h\x1b[2m$\x1b[22m b\r\n")
})

test("a run the previous server never saw finish reads as interrupted after a restart, when its pty was the server's child", { skip: !posix }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-term-")))
  const storage = createStorage(join(dir, "ui.db"), "p")
  const before = harness({ storage, dir })
  const { id } = await before.start("sleep 60")
  // shutdown() hangs the process up WITHOUT recording an exit — exactly what a dying server leaves.
  before.runner.shutdown()
  const after = harness({ storage, dir })
  const interrupted = term(after.runner, id)!
  assert.equal(interrupted.state, "exited")
  assert.equal(interrupted.exitCode, undefined)
  assert.ok(interrupted.exitedAt)
  // Still attachable (the drawer opens), and it reports the run as over rather than hanging.
  const attachment = after.runner.attach(id)!
  await new Promise<void>((resolve) => attachment.onExit(() => resolve()))
  after.runner.shutdown()
})

test("a pre-2026-09-29 command thread, with no parent, is nobody's terminal", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-term-")))
  const storage = createStorage(join(dir, "ui.db"), "p")
  // The old top-level shape: no parent, no folder. The schema migration also archives it.
  storage.db.prepare("INSERT INTO thread_terminal (project_id, slug, command, created_at, started_at) VALUES ('p', 'term-legacy', 'npm run dev', 1, 1)").run()
  const { runner } = harness({ storage, dir })
  assert.equal(runner.has("term-legacy"), false)
  assert.equal(runner.attach("term-legacy"), null)
  assert.equal([...runner.byThread().values()].flat().length, 0)
  runner.shutdown()
})

test("the command environment drops every NTWINE_* variable and names a colour terminal", () => {
  const env = commandEnvironment({ PATH: "/bin", NTWINE_STATE_DIR: "/x", NTWINE_LAUNCH_PROJECT_ID: "p", HOME: "/h" })
  assert.deepEqual(Object.keys(env).filter((k) => k.startsWith("NTWINE_")), [])
  assert.equal(env.PATH, "/bin")
  assert.equal(env.TERM, "xterm-256color")
})

// LAZY node-pty (2026-09-29). The addon is loaded on the terminal start path and nowhere else, so a box
// where it will not load — no prebuild for the platform, a broken install — runs every other part of
// ntwine, and the terminal itself says why it cannot start instead of the server dying at boot (#42).
test("a terminal whose pty cannot load fails in its own pane, with the reason, and the runner carries on", async () => {
  const { runner, start, changes } = harness({
    loadPty: () => Promise.reject(new Error("Cannot find module 'node-pty'")),
  })
  const { id } = await start("npm run dev")
  const failed = term(runner, id)!
  assert.equal(failed.state, "exited")
  assert.equal(failed.exitCode, 127)
  assert.ok(changes() > 0, "the board is told")
  const attachment = runner.attach(id)!
  attachment.onData(() => {})
  const screen = attachment.replay()
  assert.match(screen, /node-pty native module did not load/)
  assert.match(screen, /Cannot find module 'node-pty'/)
  assert.match(screen, /Everything else in ntwine works without it/)
  assert.equal(await new Promise<number | undefined>((resolve) => attachment.onExit(resolve)), 127)
  // Nothing about the failure is sticky: the next start asks for the addon again.
  const second = await start(undefined)
  assert.equal(term(runner, second.id)?.exitCode, 127)
  runner.shutdown()
})

test("no server module imports node-pty at load — only the terminal start path, by dynamic import", () => {
  const src = dirname(fileURLToPath(import.meta.url))
  const offenders: string[] = []
  // The server's own modules AND the backend/, where the terminal daemon lives: a daemon that imported
  // the addon at load would die on a box without it instead of saying why on the terminal's screen.
  const files = [...readdirSync(src).map((name) => name), ...readdirSync(join(src, "backend")).map((name) => join("backend", name))]
  for (const name of files) {
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue
    const text = readFileSync(join(src, name), "utf8")
    // A value import (or a bare side-effect import) evaluates the addon at module load. `import type` is
    // erased. Each static import statement runs from `import` to its first `from "…"` (or is bare).
    const statements = [...text.matchAll(/^import\s[\s\S]*?from\s+["']([^"']+)["']|^import\s+["']([^"']+)["']/gm)]
    const loads = statements.some((m) => (m[1] ?? m[2]) === "node-pty" && !/^import\s+type\b/.test(m[0]))
    if (loads || /require\(\s*["']node-pty["']\s*\)/.test(text)) offenders.push(name)
  }
  assert.deepEqual(offenders, [])
  // And the one dynamic import is where the runner and the daemon both load it from.
  assert.match(readFileSync(join(src, "terminal-session.ts"), "utf8"), /await import\("node-pty"\)/)
  assert.equal(basename(fileURLToPath(import.meta.url)), "thread-terminals.test.ts")
})

// THE 2FA CASE (2026-09-24). `npm publish` stopping at its OTP prompt left a live process the board had
// no word for. It now marks the TERMINAL as waiting, which queues its thread (board.withThreadTerminals).
both("a run sitting at a prompt reads as waiting for input, and answering it clears that", async () => {
  const { runner, start, changes } = harness({ inputQuietMs: 300 })
  const { id } = await start("printf 'Enter one-time password: '; read otp; echo \"got $otp\"; sleep 30")
  const waiting = await until(() => (term(runner, id)?.awaitingInput ? term(runner, id) : undefined), "the prompt")
  assert.equal(waiting.state, "running")
  assert.ok(waiting.awaitingSince)
  const before = changes()
  const attachment = runner.attach(id)!

  // Typing the answer, one key at a time, is output too — the pty echoes each digit onto the prompt's
  // line — but it is the human answering, not the program moving on. The prompt stays up through it (the
  // card's screen is drawn only while it does, and unmounting it at the first key ate the rest).
  for (const key of "123") {
    attachment.write(key)
    await until(() => (attachment.replay().endsWith(`password: ${"123".slice(0, "123".indexOf(key) + 1)}`) ? true : undefined), `the echo of ${key}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(term(runner, id)?.awaitingInput, true, `still waiting after typing ${key}`)
  }
  assert.equal(changes(), before, "and the board was never told otherwise")

  // Enter ends the answer: a newline on the screen, and the run is live work again.
  attachment.write("456\r")
  const answered = await until(() => {
    const t = term(runner, id)
    return t && !t.awaitingInput && /got 123456/.test(runner.attach(id)!.replay()) ? t : undefined
  }, "the answer")
  assert.equal(answered.state, "running")
  assert.ok(changes() > before, "the board is told the prompt cleared")
  await runner.stop(id)
  runner.shutdown()
})

both("a quiet run that ended its last line — a dev server after its banner — is not waiting for input", async () => {
  const { runner, start } = harness({ inputQuietMs: 200 })
  const { id } = await start("printf 'ready on http://localhost:3000\\n'; sleep 30")
  await until(() => (/ready on/.test(runner.attach(id)!.replay()) ? true : undefined), "the banner")
  await new Promise((resolve) => setTimeout(resolve, 800))
  assert.equal(term(runner, id)?.awaitingInput, undefined)
  await runner.stop(id)
  runner.shutdown()
})

test("a prompt is text left on an unterminated line, past any escapes painted after it", () => {
  assert.equal(endsOnPrompt("Password: "), true)
  assert.equal(endsOnPrompt("building\r\nContinue? [y/N] \x1b[?25h"), true)
  assert.equal(endsOnPrompt("\x1b[32m?\x1b[39m Enter OTP: \x1b[0m"), true)
  assert.equal(endsOnPrompt("50%\rEnter code: "), true)
  // A finished line, however quiet the program is afterwards.
  assert.equal(endsOnPrompt("ready on :3000\r\n"), false)
  assert.equal(endsOnPrompt("ready\r\n\x1b[?25l"), false)
  // A cursor returned to column 0 is a spinner between frames, not a question.
  assert.equal(endsOnPrompt("⠹ fetching\r"), false)
  assert.equal(endsOnPrompt(""), false)
})

// ── A restart under a hosted run (2026-10-15) ─────────────────────────────────────────────────────────
// "Restart" here is the server side of one: the runner is shut down (which only detaches) and a new one
// is built on the same database and state dir, exactly what the next server's context does. The full
// control-plane replacement, with a real server process, is scripts/verify-terminal-host-restart.ts.

function daemonPidOf(dir: string, id: string): number {
  return (JSON.parse(readFileSync(join(dir, "terminal-host", `${id}.json`), "utf8")) as { daemonPid: number }).daemonPid
}

test("a hosted run outlives its server: the next one adopts the same process, its screen, and a prompt it reached unwatched", { skip: !posix }, async () => {
  const before = harness({ hosted: true, inputQuietMs: 200 })
  const { id } = await before.start("echo pid=$$; sleep 0.4; printf 'Enter code: '; read x; echo \"got $x\"; sleep 600")
  const pid = Number(await until(() => /pid=(\d+)/.exec(before.runner.attach(id)!.replay())?.[1], "the shell's pid"))
  before.runner.shutdown()
  // The prompt arrives, and goes quiet past the window, while no server is attached.
  await new Promise((resolve) => setTimeout(resolve, 900))
  assert.ok(alive(pid), "the run survived its server")

  const after = harness({ hosted: true, storage: before.storage, dir: before.dir, inputQuietMs: 200 })
  const adopted = await until(() => (term(after.runner, id)?.awaitingInput ? term(after.runner, id) : undefined), "the adopted prompt")
  assert.equal(adopted.state, "running")
  assert.equal(adopted.runId, 1)
  const attachment = after.runner.attach(id)!
  assert.match(attachment.replay(), new RegExp(`pid=${pid}[\\s\\S]*Enter code: $`))
  attachment.write("42\r")
  await until(() => (/got 42/.test(attachment.replay()) ? true : undefined), "the answer to reach the same process")
  await after.runner.stop(id)
  assert.equal(term(after.runner, id)?.stopped, true)
  await until(() => (alive(pid) ? undefined : true), "the shell to die")
})

test("a hosted run that ended while no server listened is filed with its own code and screen", { skip: !posix }, async () => {
  const before = harness({ hosted: true })
  const { id } = await before.start("echo last words; sleep 0.5; exit 7")
  before.runner.shutdown()
  await until(() => (existsSync(join(before.dir, "terminal-host", `${id}.exit.json`)) ? true : undefined), "the daemon's exit record")
  const after = harness({ hosted: true, storage: before.storage, dir: before.dir })
  const filed = term(after.runner, id)!
  assert.equal(filed.state, "exited")
  assert.equal(filed.exitCode, 7)
  assert.equal(filed.stopped, undefined)
  assert.match(after.runner.attach(id)!.replay(), /last words/)
  assert.equal(existsSync(join(before.dir, "terminal-host", `${id}.exit.json`)), false, "filed once, then dropped")
})

test("a hosted run whose daemon was killed outright, leaving no record of the end, reads as interrupted", { skip: !posix }, async () => {
  const before = harness({ hosted: true })
  const { id } = await before.start("sleep 600")
  const daemon = daemonPidOf(before.dir, id)
  before.runner.shutdown()
  process.kill(daemon, "SIGKILL")
  await until(() => (alive(daemon) ? undefined : true), "the daemon to die")
  const after = harness({ hosted: true, storage: before.storage, dir: before.dir })
  const interrupted = term(after.runner, id)!
  assert.equal(interrupted.state, "exited")
  assert.equal(interrupted.exitCode, undefined)
})

test("a daemon whose terminal the board forgot is ended at boot; one the board still has is adopted, untouched", { skip: !posix }, async () => {
  const before = harness({ hosted: true })
  const forgotten = await before.start("sleep 600 & wait")
  const kept = await before.start("sleep 600")
  const forgottenDaemon = daemonPidOf(before.dir, forgotten.id)
  const keptDaemon = daemonPidOf(before.dir, kept.id)
  before.runner.shutdown()
  before.storage.dropThreadTerminal(forgotten.id)
  // Past the audit's age guard, which covers a start between its row and its fork.
  const runner = createTerminalRunner({
    storage: before.storage, onChange: () => {}, env: { ...process.env, SHELL: "/bin/sh" }, stopGraceMs: 1_000,
    host: createTerminalHost({ stateDir: before.dir, stopGraceMs: 1_000 }), now: () => Date.now() + 120_000,
  })
  runners.push(runner)
  await until(() => (alive(forgottenDaemon) ? undefined : true), "the forgotten terminal's daemon to end")
  assert.ok(alive(keptDaemon), "the kept one is never touched")
  assert.equal(term(runner, kept.id)?.state, "running")
})
