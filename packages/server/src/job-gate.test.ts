// The host-wide job gate (cc-worker/job-gate): which commands it holds, how the Bash hook rewrites
// them (and leaves alone everything it cannot read), the admission rule, and the real wrapper's
// transparency — exit codes, stdio, signals, queueing.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { classify } from "../../../cc-worker/job-gate/classify.ts"
import { NTWINE_RUN, jobGateCommand, rewriteCommand, segments } from "../../../cc-worker/job-gate/hook.ts"
import {
  decide, estimateMB, heapCapMB, pushHistory, readSettings, repoKey, signatureOf,
  type Host, type Job, type Settings,
} from "../../../cc-worker/job-gate/gate.ts"

const here = dirname(fileURLToPath(import.meta.url))
const cc = join(here, "../../../cc-worker")
const hookScript = join(cc, "hooks/bash-background.mjs")
const P = "'node' 'ntwine-run.ts' --hook --"

// ───────────────────────────── classify

test("the gate holds test suites, typechecks and builds, however they are launched", () => {
  for (const argv of [
    ["pnpm", "test"], ["pnpm", "testTyped", "--skipTypes"], ["pnpm", "mocha"], ["pnpm", "tsc"], ["pnpm", "build"],
    ["pnpm", "prChecks"], ["pnpm", "--filter", "arktype", "test"], ["pnpm", "-r", "build"], ["pnpm", "run", "typecheck"],
    ["npm", "test"], ["npm", "run", "build"], ["yarn", "test"], ["nub", "run", "test"], ["nub", "run", "typecheck"],
    ["npx", "tsc", "--noEmit"], ["npx", "vitest", "run"], ["nubx", "tsc"], ["pnpm", "exec", "tsc", "-p", "."],
    ["tsc", "--noEmit"], ["./node_modules/.bin/tsc"], ["mocha"], ["next", "build"], ["tsgo"],
    ["node", "--conditions=ark-ts", "/w/node_modules/.pnpm/mocha@11.7.4/node_modules/mocha/lib/cli/cli.js", "--exclude", "x"],
    ["node", "--conditions", "ark-ts", "/w/node_modules/mocha/bin/mocha.js"],
    ["node", "/w/node_modules/@typescript/typescript-linux-x64/lib/tsc", "-p", "."],
    ["timeout", "600", "pnpm", "test"], ["nice", "-n", "10", "tsc"],
  ]) assert.equal(classify(argv)?.class, "heavy", argv.join(" "))
  assert.equal(classify(["pnpm", "lint"])?.class, "light")
  assert.equal(classify(["npx", "eslint", "."])?.class, "light")
})

test("the gate leaves alone what is quick, never ends, or is not a suite", () => {
  for (const argv of [
    ["ls"], ["pnpm", "install"], ["pnpm", "i"], ["nub", "install"], ["pnpm", "dev"], ["npm", "view", "x"],
    ["tsc", "--version"], ["tsc", "-w"], ["tsc", "--watch"], ["vitest", "watch"], ["pnpm", "test", "--watch"],
    ["next", "dev"], ["node", "-e", "1"], ["node", "script.ts"], ["node", "--test", "x.test.ts"],
    ["nub", "--test", "x.test.ts"], ["nub", "scripts/shot.mjs"], ["npx", "prettier", "--check", "."], ["git", "status"],
    ["npm", "build"], ["pnpm", "--version"],
  ]) assert.equal(classify(argv), null, argv.join(" "))
})

// ───────────────────────────── rewrite

test("the rewrite inserts the wrapper at the heavy command's own position", () => {
  assert.equal(rewriteCommand("pnpm test", P), `${P} pnpm test`)
  assert.equal(rewriteCommand("cd ark/schema && pnpm test 2>&1 | tail -40", P), `cd ark/schema && ${P} pnpm test 2>&1 | tail -40`)
  assert.equal(rewriteCommand("FOO=1 BAR='a b' npx tsc --noEmit > /tmp/x.log 2>&1; echo done", P), `FOO=1 BAR='a b' ${P} npx tsc --noEmit > /tmp/x.log 2>&1; echo done`)
  assert.equal(rewriteCommand("pnpm build && pnpm test", P), `${P} pnpm build && ${P} pnpm test`)
  assert.equal(rewriteCommand("cd x\npnpm test -- --grep 'a b'", P), `cd x\n${P} pnpm test -- --grep 'a b'`)
  assert.equal(rewriteCommand('pnpm mocha "ark/type/__tests__/narrow.test.ts" || echo failed', P), `${P} pnpm mocha "ark/type/__tests__/narrow.test.ts" || echo failed`)
  assert.equal(rewriteCommand("[ -d x ] && pnpm test", P), `[ -d x ] && ${P} pnpm test`)
  assert.equal(rewriteCommand("pnpm test # run the suite", P), `${P} pnpm test # run the suite`)
})

test("the rewrite fails open on anything it cannot read with certainty", () => {
  for (const command of [
    "ls -la",
    "echo $(pnpm test)",
    "echo `pnpm test`",
    "(cd x && pnpm test)",
    "for p in a b; do pnpm test; done",
    "if true; then pnpm test; fi",
    "{ pnpm test; }",
    "cat <<EOF\npnpm test\nEOF",
    "pnpm test <<< input",
    "time pnpm test",
    "pnpm test &",
    "$RUNNER test",
    "echo 'unterminated",
    "ntwine-run -- pnpm test",
    "diff <(pnpm test) x",
    "",
    "   ",
  ]) assert.equal(rewriteCommand(command, P), null, JSON.stringify(command))
})

test("the word reader keeps quotes, escapes and redirects in their words", () => {
  const parsed = segments(`a 'b c' "d \\"e" f\\ g 2>&1 >&2 &>x | h`)!
  assert.deepEqual(parsed.map((s) => s.words.map((w) => w.text)), [["a", "b c", 'd "e', "f g", "2>&1", ">&2", "&>x"], ["h"]])
})

test("the hook entry point is inert for Codex, when switched off, and for non-strings", () => {
  const input = { tool_input: { command: "pnpm test" } }
  const dir = mkdtempSync(join(tmpdir(), "job-gate-cfg-"))
  const env = { NTWINE_GATE_DIR: dir }
  assert.match(jobGateCommand(input, env, "/n") ?? "", /^'\/n' '.*ntwine-run\.ts' --hook -- pnpm test$/)
  assert.equal(jobGateCommand({ ...input, model: "gpt-5" }, env), null)
  assert.equal(jobGateCommand(input, { ...env, NTWINE_GATE: "0" }), null)
  assert.equal(jobGateCommand({ tool_input: { command: 42 } }, env), null)
  assert.equal(jobGateCommand(null, env), null)
  writeFileSync(join(dir, "config.json"), JSON.stringify({ NTWINE_GATE: "0" }))
  assert.equal(jobGateCommand(input, env), null, "the host-wide config file switches the fleet off")
})

// ───────────────────────────── the hook process, composed with bash-background

function runHook(script: string, toolInput: Record<string, unknown>, env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: toolInput }),
    encoding: "utf8",
    env: { ...process.env, NTWINE_THREAD: "thread-under-test", NTWINE_GATE: "", NTWINE_GATE_DIR: mkdtempSync(join(tmpdir(), "job-gate-h-")), ...env },
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout || "{}")
}

test("the Bash hook wraps a heavy command and keeps bash-background's own patch in the same updatedInput", () => {
  const wrapped = runHook(hookScript, { command: "pnpm test" })
  assert.equal(wrapped.hookSpecificOutput.updatedInput.command, `'${process.execPath}' '${NTWINE_RUN}' --hook -- pnpm test`)
  assert.equal(wrapped.hookSpecificOutput.hookEventName, "PreToolUse")
  assert.equal(wrapped.hookSpecificOutput.permissionDecision, undefined)
  // An untimed background suite gets BOTH the wrap and the 24h timeout: one updatedInput, no race.
  const bg = runHook(hookScript, { command: "pnpm test", run_in_background: true, description: "suite" })
  assert.deepEqual(bg.hookSpecificOutput.updatedInput, {
    command: `'${process.execPath}' '${NTWINE_RUN}' --hook -- pnpm test`, run_in_background: true, description: "suite", timeout: 86_400_000,
  })
  assert.match(bg.hookSpecificOutput.additionalContext, /background shell with no `timeout`/)
  // A sub-agent's suite weighs the same as its thread's: it is gated too.
  const sub = spawnSync(process.execPath, [hookScript], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", agent_id: "a1", tool_input: { command: "pnpm test" } }),
    encoding: "utf8",
    env: { ...process.env, NTWINE_THREAD: "thread-under-test", NTWINE_GATE: "" },
  })
  assert.match(JSON.parse(sub.stdout).hookSpecificOutput.updatedInput.command, /--hook -- pnpm test$/)
  // The controls: a light command, a denied escape, a non-worker and Codex are exactly as before.
  assert.deepEqual(runHook(hookScript, { command: "ls" }), {})
  assert.equal(runHook(hookScript, { command: "pnpm test &" }).hookSpecificOutput.permissionDecision, "deny")
  assert.equal(runHook(hookScript, { command: "pnpm test &" }).hookSpecificOutput.updatedInput, undefined)
  assert.deepEqual(runHook(hookScript, { command: "pnpm test" }, { NTWINE_THREAD: "" }), {})
  assert.deepEqual(runHook(hookScript, { command: "pnpm test" }, { NTWINE_GATE: "0" }), {})
})

test("a copy where the gate cannot load (under node_modules, or missing) emits bash-background's own result", () => {
  // Node refuses to strip types under node_modules — exactly where a published ntwine-server lives.
  const root = mkdtempSync(join(tmpdir(), "job-gate-nm-"))
  const installed = join(root, "node_modules", "ntwine-server", "runtime", "cc-worker")
  mkdirSync(installed, { recursive: true })
  cpSync(join(cc, "hooks"), join(installed, "hooks"), { recursive: true })
  cpSync(join(cc, "job-gate"), join(installed, "job-gate"), { recursive: true })
  const inNodeModules = join(installed, "hooks", "bash-background.mjs")
  assert.deepEqual(runHook(inNodeModules, { command: "pnpm test" }), {})
  assert.deepEqual(runHook(inNodeModules, { command: "pnpm test", run_in_background: true }).hookSpecificOutput.updatedInput, {
    command: "pnpm test", run_in_background: true, timeout: 86_400_000,
  })
  // The control: the same tree outside node_modules does wrap, so the copy is a faithful one.
  const outside = join(root, "cc-worker")
  cpSync(installed, outside, { recursive: true })
  assert.match(runHook(join(outside, "hooks", "bash-background.mjs"), { command: "pnpm test" }).hookSpecificOutput.updatedInput.command, /ntwine-run\.ts' --hook -- pnpm test$/)
  // A gate module that throws on load.
  writeFileSync(join(outside, "job-gate", "hook.ts"), "throw new Error('broken')\n")
  assert.deepEqual(runHook(join(outside, "hooks", "bash-background.mjs"), { command: "pnpm test" }), {})
  // Malformed hook input.
  const garbage = spawnSync(process.execPath, [hookScript], { input: "{not json", encoding: "utf8", env: { ...process.env, NTWINE_THREAD: "t" } })
  assert.equal(garbage.status, 0)
  assert.deepEqual(JSON.parse(garbage.stdout), {})
})

// ───────────────────────────── signatures and history

test("every worktree of a repo shares one signature for the same suite", () => {
  const files: Record<string, string> = {
    "/h/arktype/.ntwine/worktrees/jsi-rev2-val/.git": "gitdir: /h/arktype/.git/worktrees/jsi-rev2-val\n",
    "/h/arktype/.ntwine/worktrees/jsi-rev2-obj/.git": "gitdir: /h/arktype/.git/worktrees/jsi-rev2-obj\n",
  }
  const dirs = new Set(["/h/arktype/.git"])
  const read = (p: string) => { if (p in files) return files[p]; throw new Error("ENOENT") }
  const isDir = (p: string) => { if (dirs.has(p)) return true; if (p in files) return false; throw new Error("ENOENT") }
  const a = repoKey("/h/arktype/.ntwine/worktrees/jsi-rev2-val/ark/schema", read, isDir)
  const b = repoKey("/h/arktype/.ntwine/worktrees/jsi-rev2-obj/ark/schema", read, isDir)
  const main = repoKey("/h/arktype/ark/schema", read, isDir)
  assert.equal(a, "arktype:ark/schema")
  assert.equal(b, a)
  assert.equal(main, a)
  assert.equal(repoKey("/h/arktype", read, isDir), "arktype:.")
  assert.equal(repoKey("/nowhere/x", read, isDir), "x:.")
  const sig = (argv: string[]) => signatureOf(a, classify(argv)!)
  assert.equal(sig(["pnpm", "test"]), "arktype:ark/schema|pnpm test")
  assert.equal(
    sig(["node", "--conditions=ark-ts", "/h/arktype/.ntwine/worktrees/jsi-rev2-val/node_modules/.pnpm/mocha@11.7.4/node_modules/mocha/lib/cli/cli.js", "--exclude", "ark/attest/**"]),
    sig(["node", "--conditions=ark-ts", "/h/arktype/.ntwine/worktrees/jsi-rev2-obj/node_modules/.pnpm/mocha@11.7.4/node_modules/mocha/lib/cli/cli.js", "--exclude", "ark/attest/**"]),
  )
})

test("estimates come from measured peaks, and a heap cap never undercuts what a job has needed", () => {
  assert.equal(estimateMB(undefined, "heavy"), 2560)
  assert.equal(estimateMB(undefined, "light"), 512)
  let h = pushHistory({}, "s", { peakMB: 1000, at: 1, exit: 0 })
  h = pushHistory(h, "s", { peakMB: 2000, at: 2, exit: 0 })
  assert.equal(estimateMB(h.s, "heavy"), 2200, "worst recent peak plus 10%")
  assert.equal(estimateMB(pushHistory({}, "s", { peakMB: 200, at: 1, exit: 0 }).s, "heavy"), 220, "history may lower a default")
  for (let i = 0; i < 6; i++) h = pushHistory(h, "s", { peakMB: 500, at: 10 + i, exit: 0 })
  assert.equal(h.s.length, 5, "five deep")
  assert.equal(heapCapMB(undefined, 2048), null, "never cap what was never measured")
  assert.equal(heapCapMB([{ peakMB: 900, at: 1, exit: 0 }], 1536), 1536, "the floor")
  assert.equal(heapCapMB([{ peakMB: 2900, at: 1, exit: 0 }], 2048), 2944, "the measured peak, rounded up")
  assert.equal(heapCapMB([{ peakMB: 1800, at: 1, exit: 0, capMB: 3000 }], 2048), 3008, "a cap that held does not ratchet down")
  assert.equal(heapCapMB([{ peakMB: 1800, at: 1, exit: 134, capMB: 2048, oom: true }], 2048), 3072, "a cap it died under grows by half")
})

// ───────────────────────────── admission

const S: Settings = { enabled: true, dir: "/x", reserveMB: 6144, maxPerSession: 2, maxHeavy: 6, psiThreshold: 10, swapinMBps: 10, heapFloorMB: 2048, caps: true, scope: false, heavyMB: 1024 }
let seq = 0
const job = (over: Partial<Job> = {}): Job => ({
  id: `j${++seq}`, pid: 1, session: "a", signature: "s", cmd: "c", cwd: "/", heavy: true, estimateMB: 2560, status: "queued", enqueuedAt: seq, ...over,
})
const host = (memAvailableMB: number, over: Partial<Host> = {}): Host => ({ memAvailableMB, pressure: { kind: "swapin", value: 0, high: false }, rssMB: {}, ...over })

test("with nothing heavy running the head always starts, however full the box", () => {
  const me = job()
  assert.deepEqual(decide(me, [me], host(500), S), { admit: true, reason: "idle" })
  assert.deepEqual(decide(me, [me], host(500, { pressure: { kind: "swapin", value: 50, high: true } }), S), { admit: true, reason: "idle" })
})

test("a heavy job waits until memory above the reserve covers it, counting what running jobs have yet to grow into", () => {
  const running = job({ status: "running", session: "b" })
  const me = job()
  assert.equal(decide(me, [running, me], host(6144 + 2560 + 2560), S).admit, true, "room for both estimates")
  const fresh = decide(me, [running, me], host(6144 + 2560 + 100), S)
  assert.equal(fresh.admit, false, "the running job has not grown into its 2.5GB yet")
  assert.match((fresh as { reason: string }).reason, /needs 2\.5GB, 0\.1GB free above the 6\.0GB reserve/)
  assert.equal(decide(me, [running, me], host(6144 + 2560 + 100, { rssMB: { [running.id]: 2500 } }), S).admit, true, "once it has, MemAvailable already shows it")
})

test("pressure, the host cap and the per-session cap each hold a heavy job", () => {
  const other = job({ status: "running", session: "b", estimateMB: 100 })
  const me = job()
  const roomy = host(64_000)
  assert.equal(decide(me, [other, me], roomy, S).admit, true)
  const swapping = decide(me, [other, me], host(64_000, { pressure: { kind: "swapin", value: 25, high: true } }), S)
  assert.match((swapping as { reason: string }).reason, /swap-in at 25MB\/s \(limit 10MB\/s\)/)
  const psi = decide(me, [other, me], host(64_000, { pressure: { kind: "psi", value: 30, high: true } }), S)
  assert.match((psi as { reason: string }).reason, /memory pressure at 30%/)
  const full = Array.from({ length: 6 }, (_, i) => job({ status: "running", session: `s${i}`, estimateMB: 100 }))
  assert.match((decide(me, [...full, me], roomy, S) as { reason: string }).reason, /6 heavy jobs running \(limit 6\)/)
  const mine = [job({ status: "running", estimateMB: 100 }), job({ status: "running", estimateMB: 100 })]
  assert.match((decide(me, [...mine, me], roomy, S) as { reason: string }).reason, /this thread already runs 2 heavy jobs/)
})

test("first in, first out — except that a session at its cap never blocks another session's job", () => {
  const busy = [job({ status: "running", session: "a", estimateMB: 100 }), job({ status: "running", session: "a", estimateMB: 100 })]
  const blocked = job({ session: "a" }) // queued first, but its session is at the cap
  const first = job({ session: "b" })
  const second = job({ session: "c" })
  const queue = [...busy, blocked, first, second]
  const roomy = host(64_000)
  assert.equal(decide(blocked, queue, roomy, S).admit, false)
  assert.equal(decide(first, queue, roomy, S).admit, true, "skips over the capped session's job")
  assert.deepEqual(decide(second, queue, roomy, S), { admit: false, reason: "1 job ahead in the queue" })
  // When the head cannot fit, nothing smaller jumps it.
  const tight = host(6144 + 300)
  const small = job({ session: "d", estimateMB: 1100 })
  const big = job({ session: "e", estimateMB: 4000 })
  const q2 = [job({ status: "running", session: "z", estimateMB: 100 }), big, small]
  assert.equal(decide(big, q2, tight, S).admit, false)
  assert.equal(decide(small, q2, tight, S).admit, false)
})

test("a light job skips the line and the caps, and needs only the memory", () => {
  const full = Array.from({ length: 6 }, (_, i) => job({ status: "running", session: `s${i}`, estimateMB: 100 }))
  const lint = job({ heavy: false, estimateMB: 512 })
  assert.equal(decide(lint, [...full, job(), lint], host(64_000), S).admit, true)
  assert.equal(decide(lint, [...full, lint], host(6144 + 100), S).admit, false)
  assert.equal(decide(job({ heavy: false }), [], host(10), S).admit, true, "nothing running at all")
})

test("switched off, everything starts at once; settings read the environment over the config file", () => {
  const me = job()
  const busy = Array.from({ length: 6 }, (_, i) => job({ status: "running", session: `s${i}` }))
  assert.deepEqual(decide(me, [...busy, me], host(0), { ...S, enabled: false }), { admit: true, reason: "off" })
  const dir = mkdtempSync(join(tmpdir(), "job-gate-set-"))
  writeFileSync(join(dir, "config.json"), JSON.stringify({ NTWINE_GATE_RESERVE_GB: 8, NTWINE_GATE_MAX_PER_SESSION: "3" }))
  const s = readSettings({ NTWINE_GATE_DIR: dir, NTWINE_GATE_MAX_PER_SESSION: "1" })
  assert.equal(s.reserveMB, 8192)
  assert.equal(s.maxPerSession, 1)
  assert.equal(readSettings({ NTWINE_GATE_DIR: dir, NTWINE_GATE: "0" }).enabled, false)
  assert.equal(readSettings({ NTWINE_GATE_DIR: dir, NTWINE_GATE: "0" }, { honorEnvOffSwitch: false }).enabled, true, "a per-call NTWINE_GATE=0 does not reach a hooked wrapper")
  writeFileSync(join(dir, "config.json"), JSON.stringify({ NTWINE_GATE: "0" }))
  assert.equal(readSettings({ NTWINE_GATE_DIR: dir }, { honorEnvOffSwitch: false }).enabled, false, "the file always can")
})

// ───────────────────────────── the real wrapper

function wrapper(argv: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [NTWINE_RUN, "--hook", "--", ...argv], { encoding: "utf8", env: { ...process.env, NTWINE_GATE: "", NTWINE_GATE_SCOPE: "0", ...env } })
}

test("the wrapper is transparent: stdout, stderr, exit code, cwd, and the signal that killed the job", () => {
  const dir = mkdtempSync(join(tmpdir(), "job-gate-run-"))
  const env = { NTWINE_GATE_DIR: dir, NTWINE_THREAD: "t1" }
  const r = spawnSync(process.execPath, [NTWINE_RUN, "--hook", "--", "sh", "-c", "pwd; echo err >&2; exit 7"], { encoding: "utf8", cwd: dir, env: { ...process.env, ...env, NTWINE_GATE_SCOPE: "0" } })
  assert.equal(r.status, 7)
  assert.equal(r.stdout.trim(), dir)
  assert.equal(r.stderr, "err\n")
  const killed = wrapper(["sh", "-c", "kill -TERM $$"], env)
  assert.equal(killed.signal, "SIGTERM")
  assert.equal(wrapper(["definitely-not-a-command-xyz"], env).status, 127)
  const lines = readFileSync(join(dir, "jobs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
  assert.equal(lines.length, 3)
  assert.deepEqual(lines.map((l) => [l.exit, l.signal, l.session]), [[7, null, "t1"], [null, "SIGTERM", "t1"], [127, null, "t1"]])
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).jobs, [], "nothing left behind")
})

test("a signal to the wrapper reaches the job's whole tree, and the wrapper dies of it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "job-gate-sig-"))
  const marker = join(dir, "grandchild.pid")
  const child = spawn(process.execPath, [NTWINE_RUN, "--hook", "--", "sh", "-c", `sh -c 'echo $$ > ${marker}; exec sleep 30' ; echo unreachable`], {
    env: { ...process.env, NTWINE_GATE_DIR: dir, NTWINE_THREAD: "t1", NTWINE_GATE_SCOPE: "0" },
    stdio: "ignore",
    detached: true, // its own group: the only signal anything here receives is the one we forward
  })
  const deadline = Date.now() + 10_000
  let grandchild = 0
  while (Date.now() < deadline) {
    try { grandchild = Number(readFileSync(marker, "utf8")); if (grandchild) break } catch {}
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.ok(grandchild > 0, "the grandchild started")
  const exited = new Promise<[number | null, NodeJS.Signals | null]>((r) => child.on("exit", (code, signal) => r([code, signal])))
  child.kill("SIGTERM")
  assert.deepEqual(await exited, [null, "SIGTERM"])
  // The wrapper signals the tree before it dies, so the grandchild is already signalled here; what is
  // left is the kernel ending it and its new parent reaping it. A zombie has died, so it counts as
  // gone (kill(pid, 0) still succeeds on one). Bounded generously: under load reaping can lag.
  const gone = () => {
    try { return readFileSync(`/proc/${grandchild}/stat`, "utf8").split(") ")[1]?.[0] === "Z" } catch { return true }
  }
  const until = Date.now() + 10_000
  while (!gone() && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
  assert.ok(gone(), "the grandchild got the signal too")
})

test("a second heavy job from a session at its cap queues, says why once, and starts when the first ends", async () => {
  const dir = mkdtempSync(join(tmpdir(), "job-gate-q-"))
  const env = { ...process.env, NTWINE_GATE_DIR: dir, NTWINE_THREAD: "t1", NTWINE_GATE_SCOPE: "0", NTWINE_GATE_MAX_PER_SESSION: "1", NTWINE_GATE: "" }
  const first = spawn(process.execPath, [NTWINE_RUN, "--hook", "--", "sh", "-c", "sleep 2; echo first"], { env, stdio: ["ignore", "pipe", "pipe"] })
  await new Promise((r) => setTimeout(r, 700))
  const second = spawnSync(process.execPath, [NTWINE_RUN, "--hook", "--", "sh", "-c", "echo second"], { env, encoding: "utf8" })
  assert.equal(second.status, 0)
  assert.equal(second.stdout, "second\n")
  const notes = second.stderr.trim().split("\n")
  assert.equal(notes.length, 2, second.stderr)
  assert.match(notes[0], /^ntwine-run: queued: this thread already runs 1 heavy jobs \(limit 1\)\. It starts on its own/)
  assert.match(notes[1], /^ntwine-run: started after \d+s in the queue$/)
  await new Promise((r) => first.on("exit", r))
  const lines = readFileSync(join(dir, "jobs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
  const queued = lines.find((l) => l.cmd === "sh -c echo second")
  assert.ok(queued.queueWaitMs >= 800, `waited ${queued.queueWaitMs}ms`)
})
