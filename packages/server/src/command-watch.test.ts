// COMMAND WATCHES: the process and the gate (command-watch.ts), against a real `/bin/sh` and real
// settings files. The scheduler's half is command-watch.scheduler.test.ts; the RPC's is
// router.command-watch.test.ts.
//
// The runner is tested for real because every property that matters is a property of processes: that
// the group dies on a timeout (a `curl` the shell waits on, the other half of a pipeline), that a
// background child the command left behind is reaped, that stdin is closed rather than inherited. A
// fake runner proves none of that.
import { test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { COMMAND_WATCH_OUTPUT_MAX_BYTES } from "@frizz/shared"
import {
  claudeSandboxRefusal,
  commandWatchEnvironment,
  commandWatchRefusal,
  createCommandWatchService,
  createRunLimiter,
  outputTail,
  runWatchCommand,
  type CommandRunResult,
} from "./command-watch.ts"

const posix = process.platform !== "win32"
const run = (command: string, over: Partial<Parameters<typeof runWatchCommand>[0]> = {}) =>
  runWatchCommand({ command, cwd: mkdtempSync(join(tmpdir(), "cmw-cwd-")), env: { PATH: process.env.PATH }, ...over })

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function eventually(check: () => boolean, ms = 3000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return check()
}

// ---- the process ---------------------------------------------------------------------------------

test("runner: exit status is the verdict, and output is stdout and stderr together", { skip: !posix }, async () => {
  const ok = await run("echo out; echo err >&2; exit 0")
  assert.equal(ok.outcome, "exit")
  assert.equal(ok.exitCode, 0)
  assert.match(ok.output, /out/)
  assert.match(ok.output, /err/)
  const no = await run("exit 3")
  assert.deepEqual([no.outcome, no.exitCode, no.output], ["exit", 3, ""])
  assert.ok(no.finishedAtMs >= no.startedAtMs)
})

test("runner: /bin/sh -c in the given cwd, with exactly the given environment, and stdin closed", { skip: !posix }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "cmw-where-"))
  const r = await run('pwd; echo "v=$CMW_PROBE"; if read line; then echo "read:$line"; else echo "stdin closed"; fi', {
    cwd,
    env: { PATH: process.env.PATH, CMW_PROBE: "here" },
  })
  assert.equal(r.exitCode, 0)
  // macOS resolves /var → /private/var, so compare the tail.
  assert.ok(r.output.split("\n")[0]!.endsWith(cwd.split("/").pop()!), r.output)
  assert.match(r.output, /v=here/)
  assert.match(r.output, /stdin closed/, "a command that reads stdin must see EOF, never the server's own stdin")
})

test("runner: a command not found is the shell's own 127, not an error", { skip: !posix }, async () => {
  const r = await run("definitely-not-a-command-frizz-cmw")
  assert.equal(r.outcome, "exit")
  assert.equal(r.exitCode, 127)
  assert.match(r.output, /not found/)
})

test("runner: a timeout kills the WHOLE process group — the shell and every child it is waiting on", { skip: !posix }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cmw-timeout-"))
  const pidFile = join(dir, "child.pid")
  // The child is a separate process the shell WAITS on — the `curl` case. A SIGTERM to the shell alone
  // would leave it running.
  const r = await run(`sleep 30 & echo $! > ${pidFile}; wait`, { timeoutMs: 300 })
  assert.equal(r.outcome, "timeout")
  assert.equal(r.exitCode, null)
  const child = Number(readFileSync(pidFile, "utf8").trim())
  assert.ok(child > 0)
  assert.ok(await eventually(() => !alive(child)), `the child ${child} outlived the timeout`)
})

test("runner: a background child the command left running is reaped once the shell exits", { skip: !posix }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cmw-stray-"))
  const pidFile = join(dir, "stray.pid")
  const r = await run(`sleep 30 >/dev/null 2>&1 & echo $! > ${pidFile}; exit 1`)
  assert.deepEqual([r.outcome, r.exitCode], ["exit", 1])
  const stray = Number(readFileSync(pidFile, "utf8").trim())
  assert.ok(await eventually(() => !alive(stray)), `the stray child ${stray} survived its check`)
})

test("runner: an abort kills the group and reads as a signal", { skip: !posix }, async () => {
  const abort = new AbortController()
  const pending = run("sleep 30", { signal: abort.signal })
  setTimeout(() => abort.abort(), 100)
  const r = await pending
  assert.equal(r.outcome, "signal")
  assert.ok(r.finishedAtMs - r.startedAtMs < 5000)
})

test("runner: only the TAIL of the output is kept, bounded, and cut on a character boundary", { skip: !posix }, async () => {
  // 20 000 bytes of a two-byte character, then a marker: the head is dropped, the marker survives.
  const r = await run(`i=0; while [ $i -lt 10000 ]; do printf 'é'; i=$((i+1)); done; echo; echo THE-END`)
  assert.equal(r.exitCode, 0)
  assert.ok(Buffer.byteLength(r.output) <= COMMAND_WATCH_OUTPUT_MAX_BYTES + Buffer.byteLength("…"))
  assert.ok(r.output.startsWith("…"))
  assert.match(r.output, /THE-END\n$/)
  assert.ok(!r.output.includes("�"), "a split UTF-8 sequence would decode as a replacement character")
})

test("outputTail keeps short output whole and marks a cut", () => {
  assert.equal(outputTail([Buffer.from("short")]), "short")
  const cut = outputTail([Buffer.from("a".repeat(10)), Buffer.from("b".repeat(10))], 8)
  assert.equal(cut, "…bbbbbbbb")
})

test("runner: a cwd that does not exist is an `error` outcome, never a throw", { skip: !posix }, async () => {
  const r = await run("true", { cwd: "/definitely/not/a/dir/frizz-cmw" })
  assert.equal(r.outcome, "error")
  assert.match(r.output, /could not start/)
})

test("the environment carries the thread's identity, drops the reaper's tag, and never prompts", () => {
  const env = commandWatchEnvironment(
    { PATH: "/usr/bin", FRIZZ_THREAD: "someone-else", HOME: "/h" },
    { FRIZZ_THREAD_SLUG: "me", FRIZZ_STATE_DIR: "/s" },
  )
  assert.equal(env.FRIZZ_THREAD, undefined, "FRIZZ_THREAD is the orphan reaper's ownership tag")
  assert.equal(env.FRIZZ_THREAD_SLUG, "me")
  assert.equal(env.GIT_TERMINAL_PROMPT, "0")
  assert.equal(env.GH_PROMPT_DISABLED, "1")
  assert.equal(env.HOME, "/h")
})

// ---- the bound -----------------------------------------------------------------------------------

test("the limiter never runs more than its limit at once, and runs everything eventually", async () => {
  const limit = createRunLimiter(2)
  let active = 0
  let peak = 0
  const job = () => limit(async () => {
    active++
    peak = Math.max(peak, active)
    await new Promise((r) => setTimeout(r, 10))
    active--
    return 1
  })
  const results = await Promise.all(Array.from({ length: 7 }, job))
  assert.equal(peak, 2)
  assert.equal(results.length, 7)
})

test("a registration's first check does not queue: past two at once, it is skipped", async () => {
  const release: (() => void)[] = []
  const result: CommandRunResult = { outcome: "exit", exitCode: 1, output: "", startedAtMs: 0, finishedAtMs: 0 }
  const service = createCommandWatchService({
    cwd: "/tmp",
    env: () => ({}),
    runner: () => new Promise((resolve) => release.push(() => resolve(result))),
  })
  const a = service.probe("t", "a")
  const b = service.probe("t", "b")
  assert.equal(await service.probe("t", "c"), undefined, "a third concurrent first check is skipped, not queued")
  for (const r of release) r()
  assert.deepEqual(await Promise.all([a, b]), [result, result])
  release.length = 0
  const again = service.probe("t", "d")
  release[0]!()
  assert.equal(await again, result, "the slots come back")
})

// ---- the gate ------------------------------------------------------------------------------------

const BYPASS = { backend: "claude", permission_mode: "bypassPermissions", permission_pending: null } as const

function settingsRoots() {
  const root = mkdtempSync(join(tmpdir(), "cmw-settings-"))
  const cwd = join(root, "project")
  const home = join(root, "home")
  const managed = join(root, "managed", "managed-settings.json")
  mkdirSync(join(cwd, ".claude"), { recursive: true })
  mkdirSync(join(home, ".claude"), { recursive: true })
  mkdirSync(join(root, "managed"), { recursive: true })
  const gate = { cwd, home, env: {} as NodeJS.ProcessEnv, managedPaths: [managed], managedPreferencePaths: [] as string[], platform: "darwin" as const }
  return { root, cwd, home, managed, gate }
}

test("gate: a Claude thread in bypassPermissions with no sandbox anywhere may have commands run", () => {
  const { gate } = settingsRoots()
  assert.equal(commandWatchRefusal(BYPASS, gate), undefined)
})

test("gate: every other permission mode refuses, and so does an unrecorded one", () => {
  const { gate } = settingsRoots()
  for (const mode of ["default", "auto", "acceptEdits", "plan", null]) {
    const refusal = commandWatchRefusal({ ...BYPASS, permission_mode: mode }, gate)
    assert.ok(refusal, `${mode} must refuse`)
    assert.match(refusal!, /bypassPermissions/)
    assert.match(refusal!, /background shell instead\.$/)
  }
})

test("gate: a pending change away from bypassPermissions refuses before it lands", () => {
  const { gate } = settingsRoots()
  assert.match(commandWatchRefusal({ ...BYPASS, permission_pending: "default" }, gate)!, /being changed to `default`/)
  assert.equal(commandWatchRefusal({ ...BYPASS, permission_pending: "bypassPermissions" }, gate), undefined)
})

test("gate: Codex and ACP threads are refused outright, whatever their mode", () => {
  const { gate } = settingsRoots()
  assert.match(commandWatchRefusal({ ...BYPASS, backend: "codex" }, gate)!, /Claude threads only.*Codex/)
  assert.match(commandWatchRefusal({ ...BYPASS, backend: "acp" }, gate)!, /Claude threads only.*ACP/)
})

test("gate: Windows is refused — there is no /bin/sh", () => {
  const { gate } = settingsRoots()
  assert.match(commandWatchRefusal(BYPASS, { ...gate, platform: "win32" })!, /\/bin\/sh/)
})

test("gate: Claude Code's sandbox enabled in ANY scope refuses — managed, local, project or user", () => {
  for (const scope of ["managed", "local", "project", "user"] as const) {
    const { cwd, home, managed, gate } = settingsRoots()
    const file = {
      managed,
      local: join(cwd, ".claude", "settings.local.json"),
      project: join(cwd, ".claude", "settings.json"),
      user: join(home, ".claude", "settings.json"),
    }[scope]
    writeFileSync(file, JSON.stringify({ permissions: { allow: [] }, sandbox: { enabled: true } }))
    const refusal = commandWatchRefusal(BYPASS, gate)
    assert.ok(refusal, `${scope}: an enabled sandbox must refuse`)
    assert.match(refusal!, /sandbox is on/)
    assert.ok(refusal!.includes(file), `${scope}: the refusal names the file`)
    assert.match(refusal!, /background shell instead\.$/)
  }
})

test("gate: a scope that turns the sandbox OFF does not unlock one that turns it on (fail closed)", () => {
  const { cwd, home, gate } = settingsRoots()
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ sandbox: { enabled: true } }))
  writeFileSync(join(cwd, ".claude", "settings.local.json"), JSON.stringify({ sandbox: { enabled: false } }))
  assert.ok(commandWatchRefusal(BYPASS, gate))
})

test("gate: a sandbox block that is off, or says nothing about `enabled`, does not refuse", () => {
  const { cwd, home, gate } = settingsRoots()
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ sandbox: { enabled: false } }))
  writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ sandbox: { excludedCommands: ["docker"] } }))
  assert.equal(commandWatchRefusal(BYPASS, gate), undefined)
  // Anything that is not plainly off reads as on.
  writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ sandbox: { enabled: "yes" } }))
  assert.ok(commandWatchRefusal(BYPASS, gate))
  writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ sandbox: true }))
  assert.ok(commandWatchRefusal(BYPASS, gate))
})

test("gate: a settings file Frizz cannot parse or read refuses — it might be the one that says `enabled: true`", { skip: !posix || process.getuid?.() === 0 }, () => {
  const { cwd, home, gate } = settingsRoots()
  writeFileSync(join(cwd, ".claude", "settings.json"), "{ not json")
  assert.match(commandWatchRefusal(BYPASS, gate)!, /not valid JSON/)
  writeFileSync(join(cwd, ".claude", "settings.json"), "{}")
  const user = join(home, ".claude", "settings.json")
  writeFileSync(user, JSON.stringify({ sandbox: { enabled: false } }))
  chmodSync(user, 0o000)
  try {
    assert.match(commandWatchRefusal(BYPASS, gate)!, /could not read/)
  } finally {
    chmodSync(user, 0o600)
  }
})

test("gate: CLAUDE_CONFIG_DIR moves the user scope, as it does for Claude Code", () => {
  const { cwd, home } = settingsRoots()
  const configDir = mkdtempSync(join(tmpdir(), "cmw-config-"))
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ sandbox: { enabled: true } }))
  assert.match(claudeSandboxRefusal({ cwd, home, env: { CLAUDE_CONFIG_DIR: configDir }, managedPaths: [], managedPreferencePaths: [] })!, /sandbox is on/)
  assert.equal(claudeSandboxRefusal({ cwd, home, env: {}, managedPaths: [], managedPreferencePaths: [] }), undefined)
})

// An MDM configuration profile reaches Claude Code as `/Library/Managed Preferences/…/com.anthropic.claudecode.plist`,
// which it converts with `plutil` and reads as settings — a sandbox turned on there is in no JSON file.
test("gate: a sandbox an MDM profile turns on refuses, and a profile Frizz cannot convert refuses too", () => {
  const { root, gate } = settingsRoots()
  const plist = join(root, "com.anthropic.claudecode.plist")
  writeFileSync(plist, "<plist/>") // only its existence is read; the conversion is the seam below
  let converted = JSON.stringify({ sandbox: { enabled: true } })
  const withProfile = { ...gate, managedPreferencePaths: [plist, join(root, "absent.plist")], readPlistJson: () => converted }
  assert.match(commandWatchRefusal(BYPASS, withProfile)!, /sandbox is on .*com\.anthropic\.claudecode\.plist/)
  converted = JSON.stringify({ permissions: { allow: [] } })
  assert.equal(commandWatchRefusal(BYPASS, withProfile), undefined, "a profile that leaves the sandbox alone is no refusal")
  assert.match(commandWatchRefusal(BYPASS, { ...withProfile, readPlistJson: () => { throw new Error("plutil failed") } })!, /could not read/)
  assert.equal(commandWatchRefusal(BYPASS, { ...gate, managedPreferencePaths: [join(root, "absent.plist")], readPlistJson: () => { throw new Error("never asked") } }), undefined, "an absent profile is not read")
})
