import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ThreadSlug } from "@frizz/shared"
import { createStorage, type Storage } from "./storage.ts"
import { commandEnvironment, createCommandRunner, endsOnPrompt, followUpScreen, type CommandRunner } from "./command-threads.ts"

// REAL ptys and a real SQLite file: the runner's whole job is the seam between a shell, its process
// group and the rows the board renders, and a fake pty would only prove the fake.

const posix = process.platform !== "win32"

function harness(storage?: Storage, dir = realpathSync(mkdtempSync(join(tmpdir(), "frizz-cmd-"))), inputQuietMs?: number) {
  const store = storage ?? createStorage(join(dir, "ui.db"), "p")
  let changes = 0
  const runner = createCommandRunner({
    cwd: dir,
    storage: store,
    onChange: () => { changes++ },
    // `sh`, not the operator's login shell: a test must not depend on what ~/.profile prints.
    env: { ...process.env, SHELL: "/bin/sh", FRIZZ_LOG_FILE: "/must/not/leak" },
    stopGraceMs: 1_000,
    ...(inputQuietMs === undefined ? {} : { inputQuietMs }),
  })
  return { runner, storage: store, dir, changes: () => changes }
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

function row(runner: CommandRunner, slug: string) {
  return runner.threads().find((t) => t.id === slug)
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test("a finished command keeps its output and exit code, and a late viewer still sees both", { skip: !posix }, async () => {
  const { runner, dir } = harness()
  const { slug } = runner.start("printf 'hello from %s\\n' \"$PWD\"; printf 'leak=%s\\n' \"${FRIZZ_LOG_FILE:-none}\"; exit 3")
  assert.ok(ThreadSlug.safeParse(slug).success)
  assert.equal(row(runner, slug)?.kind, "command")
  const exited = await until(() => (row(runner, slug)?.command?.state === "exited" ? row(runner, slug) : undefined), "the exit")
  assert.equal(exited.command?.exitCode, 3)
  assert.equal(exited.command?.stopped, undefined)
  assert.equal(exited.runtime, "exited")

  // A viewer attaching AFTER the exit gets the replay first and the exit (with its code) after it.
  const attachment = runner.attach(slug)
  assert.ok(attachment)
  const seen: string[] = []
  attachment.onData(() => {})
  seen.push(attachment.replay())
  const code = await new Promise<number | undefined>((resolve) => attachment.onExit(resolve))
  assert.equal(code, 3)
  assert.match(seen.join(""), new RegExp(`hello from ${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))
  // The server's own FRIZZ_* identity never reaches the command.
  assert.match(seen.join(""), /leak=none/)
  runner.shutdown()
})

test("stop ends the whole process group — the shell's children too — and records it as stopped", { skip: !posix }, async () => {
  const { runner } = harness()
  // The shell forks a child and waits on it, the shape of `npm run dev` forking node.
  const { slug } = runner.start("sleep 60 & echo child=$!; wait")
  const attachment = runner.attach(slug)!
  let output = ""
  attachment.onData((chunk) => { output += chunk })
  const child = Number(await until(() => /child=(\d+)/.exec(output + attachment.replay())?.[1], "the child pid"))
  assert.ok(alive(child), "negative control: the child is running before Stop")
  assert.equal(row(runner, slug)?.command?.state, "running")

  await runner.stop(slug)
  const exited = row(runner, slug)!
  assert.equal(exited.command?.state, "exited")
  assert.equal(exited.command?.stopped, true)
  await until(() => (alive(child) ? undefined : true), "the child to die")
  runner.shutdown()
})

test("restart is a fresh run of the same command; remove forgets the thread", { skip: !posix }, async () => {
  const { runner } = harness()
  const { slug } = runner.start("sleep 60")
  const first = row(runner, slug)!.command!
  assert.equal(first.runId, 1)
  await runner.restart(slug)
  const second = row(runner, slug)!.command!
  assert.equal(second.runId, 2)
  assert.equal(second.state, "running")
  assert.equal(second.command, "sleep 60")

  await runner.remove(slug)
  assert.equal(row(runner, slug), undefined)
  assert.equal(runner.attach(slug), null)
  runner.shutdown()
})

test("a follow-up run is the thread's next command, on a screen that carries the last one's output", { skip: !posix }, async () => {
  const { runner, storage } = harness()
  const { slug } = runner.start("printf 'first-out\\n'")
  await until(() => (row(runner, slug)?.command?.state === "exited" ? true : undefined), "the first run")
  // Marked done, then followed up: the next command reopens it, exactly as a restart does.
  storage.setCommandThreadState(slug, "archived")
  await runner.run(slug, "printf 'second-out\\n'; exit 4")
  const next = row(runner, slug)!
  assert.equal(next.command?.command, "printf 'second-out\\n'; exit 4")
  assert.equal(next.title, next.command?.command)
  assert.equal(next.command?.runId, 2)
  assert.equal(next.state, "open")

  const attachment = runner.attach(slug)!
  attachment.onData(() => {})
  const code = await new Promise<number | undefined>((resolve) => attachment.onExit(resolve))
  assert.equal(code, 4)
  // One session, in order: the first command's line and output, then the second's.
  const screen = attachment.replay().replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
  const order = ["$ printf 'first-out\\n'", "first-out", "$ printf 'second-out\\n'; exit 4", "second-out"].map((part) => screen.indexOf(part))
  assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]!)), `out of order: ${JSON.stringify(screen)}`)

  // A third run does not repeat the lines the second already carries.
  await runner.run(slug, "true")
  const third = runner.attach(slug)!.replay()
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
})

test("a run the previous server never saw finish reads as interrupted after a restart", { skip: !posix }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "frizz-cmd-")))
  const storage = createStorage(join(dir, "ui.db"), "p")
  const before = harness(storage, dir)
  const { slug } = before.runner.start("sleep 60")
  // shutdown() hangs the process up WITHOUT recording an exit — exactly what a dying server leaves.
  before.runner.shutdown()
  const after = harness(storage, dir)
  const interrupted = row(after.runner, slug)!.command!
  assert.equal(interrupted.state, "exited")
  assert.equal(interrupted.exitCode, undefined)
  assert.ok(interrupted.exitedAt)
  // Still attachable (the drawer opens), and it reports the run as over rather than hanging.
  const attachment = after.runner.attach(slug)!
  await new Promise<void>((resolve) => attachment.onExit(() => resolve()))
  after.runner.shutdown()
})

test("the command environment drops every FRIZZ_* variable and names a colour terminal", () => {
  const env = commandEnvironment({ PATH: "/bin", FRIZZ_STATE_DIR: "/x", FRIZZ_LAUNCH_PROJECT_ID: "p", HOME: "/h" })
  assert.deepEqual(Object.keys(env).filter((k) => k.startsWith("FRIZZ_")), [])
  assert.equal(env.PATH, "/bin")
  assert.equal(env.TERM, "xterm-256color")
})

test("a finished run queues until it is marked done, and a restart reopens it", { skip: !posix }, async () => {
  const { runner, storage } = harness()
  const { slug } = runner.start("sleep 30")
  // Running is live work: never queued, never done.
  assert.equal(row(runner, slug)?.needsYou, false)
  assert.equal(row(runner, slug)?.state, "open")
  await runner.stop(slug)
  const finished = await until(() => (row(runner, slug)?.command?.state === "exited" ? row(runner, slug) : undefined), "the stop")
  assert.equal(finished.needsYou, true)

  assert.equal(storage.setCommandThreadState(slug, "archived"), true)
  assert.equal(row(runner, slug)?.needsYou, false)
  assert.equal(row(runner, slug)?.state, "archived")
  assert.equal(row(runner, slug)?.archived, true)

  await runner.restart(slug)
  assert.equal(row(runner, slug)?.state, "open")
  assert.equal(row(runner, slug)?.needsYou, false)
  await runner.remove(slug)
  assert.equal(storage.setCommandThreadState(slug, "archived"), false)
})

// THE 2FA CASE (2026-09-24). `npm publish` stopping at its OTP prompt left a live process the board had
// no word for: it spun in the running band forever while the human had no idea it was asking them.
test("a run sitting at a prompt queues as waiting for input, and answering it takes it back out", { skip: !posix }, async () => {
  const { runner, changes } = harness(undefined, undefined, 300)
  const { slug } = runner.start("printf 'Enter one-time password: '; read otp; echo \"got $otp\"; sleep 30")
  const waiting = await until(() => (row(runner, slug)?.command?.awaitingInput ? row(runner, slug) : undefined), "the prompt")
  assert.equal(waiting.command?.state, "running")
  assert.equal(waiting.runtime, "running")
  assert.equal(waiting.needsYou, true)
  const before = changes()

  // Typing the answer is output (the echo) — the prompt clears and the run is live work again.
  runner.attach(slug)!.write("123456\r")
  const answered = await until(() => {
    const r = row(runner, slug)
    return r && !r.command?.awaitingInput && /got 123456/.test(runner.attach(slug)!.replay()) ? r : undefined
  }, "the answer")
  assert.equal(answered.needsYou, false)
  assert.ok(changes() > before, "the board is told the prompt cleared")
  await runner.stop(slug)
})

test("a quiet run that ended its last line — a dev server after its banner — is not waiting for input", { skip: !posix }, async () => {
  const { runner } = harness(undefined, undefined, 200)
  const { slug } = runner.start("printf 'ready on http://localhost:3000\\n'; sleep 30")
  await until(() => (/ready on/.test(runner.attach(slug)!.replay()) ? true : undefined), "the banner")
  await new Promise((resolve) => setTimeout(resolve, 800))
  assert.equal(row(runner, slug)?.command?.awaitingInput, undefined)
  assert.equal(row(runner, slug)?.needsYou, false)
  await runner.stop(slug)
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
