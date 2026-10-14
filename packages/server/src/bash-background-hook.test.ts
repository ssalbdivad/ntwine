import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { evaluateBashBackgroundHook, isDirectHookExecution, LONG_FOREGROUND_MS, longForegroundContext } from "../../../cc-worker/hooks/bash-background.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const hook = join(here, "../../../cc-worker/hooks/bash-background.mjs")

function decision(command: string, worker = true, extra: Record<string, unknown> = {}): Record<string, any> {
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command, ...extra } }),
    encoding: "utf8",
    // The job gate rides this hook and would wrap `pnpm prChecks`; job-gate.test.ts covers it.
    env: { ...process.env, NTWINE_THREAD: worker ? "thread-under-test" : "", NTWINE_GATE: "0" },
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout || "{}")
}

function output(command: string): Record<string, any> {
  return decision(command).hookSpecificOutput ?? {}
}

test("Bash background hook denies escaping shell jobs that bypass Claude's native task lifecycle", () => {
  for (const command of [
    "cargo test > /tmp/test.log 2>&1 &",
    "(nub scripts/remote-build.ts --job test > /tmp/f3.log 2>&1) &\nsleep 2; echo build started",
    "nohup nub scripts/ci-watch.ts --pr 587 > /tmp/ci.log 2>&1 & echo watcher started",
    "first & second & echo both-started",
  ]) {
    const denied = output(command)
    assert.equal(denied.permissionDecision, "deny", command)
    assert.match(denied.permissionDecisionReason, /cannot report completion or wake this agent/, command)
  }
})

test("Bash background hook denies escaping variants and asynchronous kill without wait", () => {
  for (const command of [
    "server & disown",
    "server & exit 0",
    "server & exec echo done",
    "(server &)",
    "server & pid=$!; kill $pid",
  ]) assert.equal(output(command).permissionDecision, "deny", command)
})

// A local wrapper forks the job and exits, so its `&` escapes exactly as a bare one does. Quoted
// regions are blanked to exempt `ssh host '… &'`, which backgrounds on the REMOTE host — that
// blanking also hid `bash -c 'job &'`, one token away from every command the guard already denies.
test("Bash background hook denies an escaping job inside a local shell wrapper", () => {
  for (const command of [
    `bash -c "nub scripts/ci-watch.ts > /tmp/ci.log 2>&1 &"`,
    "sh -c 'server &'",
    "zsh -lc 'server & echo started'",
    "/bin/sh -c 'server &'",
    "cd /tmp && bash -c 'server &'",
    `bash -c "sh -c 'server &'"`,
  ]) assert.equal(output(command).permissionDecision, "deny", command)
})

// A wrapper in ARGUMENT position belongs to the program before it, which decides where the script
// runs — the same call the `ssh` exemption makes. `xargs sh -c 'job &'` is the local form this gives
// up; the corpus never shows it, and over-blocking every containerized build would cost far more.
test("Bash background hook leaves a shell wrapper handed to another program alone", () => {
  for (const command of [
    "docker run --rm -w /src rust:1-bookworm bash -c 'cargo build &'",
    "limactl shell landlock-vm bash -lc 'df -h / | tail -1 &'",
    "ssh host bash -lc 'remote-job &'",
  ]) assert.deepEqual(decision(command), {}, command)
})

test("Bash background hook preserves self-contained concurrency and non-job ampersands", () => {
  for (const command of [
    "a & b & wait",
    "server & pid=$!; curl localhost:3000; kill $pid; wait $pid",
    "server & pid=$!; trap 'kill $pid' EXIT; curl localhost:3000",
    "printf '%s\\n' '&'",
    'echo "&"',
    `echo "--- decode: $(python3 -c 'v=851968;print(f"{v>>16}.{(v>>8)&255}.{v&255}")')"`,
    "echo one && echo two",
    "tool 2>&1 | tail -1",
    "ssh host 'nohup remote-job > /tmp/job.log 2>&1 &'",
    "ssh host 'bash -c \"remote-job &\"'",
    "cat > probe.sh <<'EOF'\nserver &\necho $!\nEOF",
    "bash -c 'a & b & wait'",
    "bash -c 'cd /tmp && for s in $(cat specs); do npm pack \"$s\"; done; echo DONE'",
    "echo 'bash -c \"server &\"' > note.txt",
  ]) assert.deepEqual(output(command), {}, command)
})

// THE SPAWN-TIME BUDGET PROMPT (server shell-budget.ts: no declared budget ⇒ none). A background call
// with no `timeout` is asked, once, whether it should end on a clock — never blocked, and never nagged
// when it already declared one.
test("an untimed run_in_background call gets ONE non-blocking line; a timed one, a foreground one, or a non-worker gets nothing", () => {
  const untimed = decision("npx vite --port 5231", true, { run_in_background: true })
  assert.equal(untimed.hookSpecificOutput?.hookEventName, "PreToolUse")
  assert.equal(untimed.hookSpecificOutput?.permissionDecision, undefined, "never a decision — permission is untouched")
  // Claude Code stops an untimed background command at 30m; the hook lifts it to the 24h ceiling.
  assert.deepEqual(untimed.hookSpecificOutput?.updatedInput, { command: "npx vite --port 5231", run_in_background: true, timeout: 86_400_000 })
  assert.match(untimed.hookSpecificOutput?.additionalContext ?? "", /no `timeout`/)
  assert.match(untimed.hookSpecificOutput?.additionalContext ?? "", /ntwinectl extend-shell/)
  assert.match(untimed.hookSpecificOutput?.additionalContext ?? "", /dev server or watcher/)
  assert.ok((untimed.hookSpecificOutput?.additionalContext ?? "").length < 500, "brief")
  // The negative controls: the same command, every way that must stay silent.
  assert.deepEqual(decision("npx vite --port 5231", true, { run_in_background: true, timeout: 600_000 }), {}, "a declared timeout is not nagged")
  assert.deepEqual(decision("npx vite --port 5231", true, {}), {}, "a foreground call is not asked")
  assert.deepEqual(decision("npx vite --port 5231", true, { run_in_background: false, timeout: undefined }), {})
  assert.deepEqual(decision("npx vite --port 5231", false, { run_in_background: true }), {}, "inert outside a worker")
  // Garbage is not a declaration (the server clamps the same way: shell-budget.ts declaredShellBudgetMs).
  assert.match(decision("sleep 60", true, { run_in_background: true, timeout: 0 }).hookSpecificOutput?.additionalContext ?? "", /no `timeout`/)
  // An escaping job is still DENIED, not merely advised — the deny outranks the prompt.
  assert.equal(output("server &").permissionDecision, "deny")
  assert.equal(decision("server &", true, { run_in_background: true }).hookSpecificOutput?.permissionDecision, "deny")
})

test("Bash background hook is inert outside an ntwine worker", () => {
  assert.deepEqual(decision("cargo test &", false), {})
})

test("Bash denial tells the worker the tracked replacement", () => {
  const reason = decision("cargo test & disown").hookSpecificOutput?.permissionDecisionReason ?? ""
  assert.match(reason, /^ntwine blocked an untracked shell background job/)
  assert.match(reason, /run_in_background:true/)
  assert.match(reason, /Claude task ID/)
  assert.match(reason, /finish with `wait`/)
})

test("Codex Bash denial points at the managed yield_control lifecycle", () => {
  const result = spawnSync(process.execPath, [hook, "--ntwine-thread"], {
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "cargo test > /tmp/test.log 2>&1 &" },
      model: "gpt-5.6-sol",
    }),
    encoding: "utf8",
    env: { ...process.env, NTWINE_THREAD: "" },
  })
  assert.equal(result.status, 0, result.stderr)
  const reason = JSON.parse(result.stdout).hookSpecificOutput?.permissionDecisionReason ?? ""
  assert.match(reason, /yield_control\(\)/)
  assert.match(reason, /session_id.*foreground continuation/)
  assert.doesNotMatch(reason, /run_in_background/)
})

test("bundling the detector into ntwine cannot turn the server entry into the hook executable", () => {
  const serverEntry = "/artifact/runtime/src/index.js"
  assert.equal(isDirectHookExecution(serverEntry, "file:///artifact/runtime/src/index.js"), false)
  assert.equal(isDirectHookExecution(hook, pathToFileURL(hook).href), true)
})

// Node realpaths the main entry, so `import.meta.url` is the resolved spelling while `argv[1]` is
// whatever CLAUDE_PLUGIN_ROOT spelled. Under an 8.3 short name or a junction the two differ, the
// URL comparison fails, and the hook silently allowed everything (Windows audit 2026-09-11,
// finding 15). A symlink is the same divergence this machine can produce.
test("an aliased plugin path (symlink, junction, 8.3 short name) still recognizes the hook as itself", () => {
  const alias = join(mkdtempSync(join(tmpdir(), "ntwine-hook-alias-")), "hooks")
  symlinkSync(dirname(hook), alias, "dir")
  const viaAlias = join(alias, "bash-background.mjs")
  assert.notEqual(pathToFileURL(viaAlias).href, pathToFileURL(hook).href, "the control: the spellings really differ")
  assert.equal(isDirectHookExecution(viaAlias, pathToFileURL(hook).href), true)
  // A different file that merely shares the basename is still not this hook …
  const impostor = join(mkdtempSync(join(tmpdir(), "ntwine-hook-impostor-")), "bash-background.mjs")
  writeFileSync(impostor, "")
  assert.equal(isDirectHookExecution(impostor, pathToFileURL(hook).href), false)
  // … and a path that does not exist cannot be it either.
  assert.equal(isDirectHookExecution(join(alias, "missing", "bash-background.mjs"), pathToFileURL(hook).href), false)
  // The whole hook, executed THROUGH the alias, still denies: the end-to-end proof of the self-check.
  const result = spawnSync(process.execPath, [viaAlias], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "cargo test > /tmp/t.log 2>&1 &" } }),
    encoding: "utf8",
    env: { ...process.env, NTWINE_THREAD: "thread-under-test" },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput?.permissionDecision, "deny")
})

// THE LONG-FOREGROUND PROMPT (arktype session 50d1f5b7, 2026-09-29/30: a repo-wide gate run five times
// in the foreground under a 1h `timeout`, the thread read as stuck each time). Advice, never a refusal —
// the 24h foreground ceiling is deliberate — and only past LONG_FOREGROUND_MS (15m).
test("a foreground call declaring more than the long-foreground window gets ONE non-blocking line; nothing else does", () => {
  const long = decision("pnpm prChecks", true, { timeout: 3_600_000 })
  assert.equal(long.hookSpecificOutput?.hookEventName, "PreToolUse")
  assert.equal(long.hookSpecificOutput?.permissionDecision, undefined, "never a decision — the call runs as written")
  const context = long.hookSpecificOutput?.additionalContext ?? ""
  assert.match(context, /up to 1h\./)
  assert.match(context, /past 15m/)
  assert.match(context, /run_in_background: true/)
  assert.ok(context.length < 500, "brief")
  assert.match(decision("pnpm prChecks", true, { timeout: 20 * 60_000, run_in_background: false }).hookSpecificOutput?.additionalContext ?? "", /up to 20m\./)
  // The negative controls.
  assert.deepEqual(decision("pnpm prChecks", true, { timeout: LONG_FOREGROUND_MS }), {}, "at the window, no advice")
  assert.deepEqual(decision("pnpm prChecks", true, { timeout: 600_000 }), {}, "an ordinary sized call")
  assert.deepEqual(decision("pnpm prChecks", true, {}), {}, "no timeout: Claude bounces it to the background itself")
  assert.deepEqual(decision("pnpm prChecks", true, { timeout: 3_600_000, run_in_background: true }), {}, "already in the background")
  assert.deepEqual(decision("pnpm prChecks", false, { timeout: 3_600_000 }), {}, "inert outside a worker")
  // The deny still outranks the advice.
  assert.equal(decision("server &", true, { timeout: 3_600_000 }).hookSpecificOutput?.permissionDecision, "deny")
})

test("the long-foreground window is 15m, the value the POSIX-sh pre-filter hard-codes", () => {
  assert.equal(LONG_FOREGROUND_MS, 900_000)
  assert.match(longForegroundContext(150 * 60_000), /up to 2h 30m\./)
})

test("the long-foreground prompt is Claude-only: a codex exec has no run_in_background to point at", () => {
  const out = evaluateBashBackgroundHook(
    { model: "gpt-5", tool_input: { command: "pnpm prChecks", timeout: 3_600_000 } },
    { NTWINE_THREAD: "thread-under-test" },
  )
  assert.deepEqual(out, {})
})

// THE TWO PROMPTS ARE THE THREAD'S, NEVER A SUB-AGENT'S (2026-09-29..10-01 transcripts): the no-timeout
// line sent sub-agents to `extend_shell`, which cannot see a sub-agent's shell and answered "already
// finished … or the id is wrong" about one running for 3s; the long-foreground line told sub-agents to
// background their gates while their own dispatch epilogue says to run them in the FOREGROUND.
function subAgentDecision(command: string, extra: Record<string, unknown>, idKey = "agent_id"): Record<string, any> {
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", [idKey]: "a19ae4fa7706777f6", tool_input: { command, ...extra } }),
    encoding: "utf8",
    env: { ...process.env, NTWINE_THREAD: "thread-under-test", NTWINE_GATE: "0" },
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout || "{}")
}

test("inside a sub-agent neither the no-timeout nor the long-foreground prompt fires; the deny still does", () => {
  // The positive controls: the identical calls from the THREAD do get their lines.
  assert.match(decision("npx vite --port 5231", true, { run_in_background: true }).hookSpecificOutput?.additionalContext ?? "", /ntwinectl extend-shell/)
  assert.match(decision("pnpm prChecks", true, { timeout: 3_600_000 }).hookSpecificOutput?.additionalContext ?? "", /run_in_background: true/)
  // From a sub-agent, nothing — either spelling of the id.
  assert.deepEqual(subAgentDecision("npx vite --port 5231", { run_in_background: true }), {})
  assert.deepEqual(subAgentDecision("pnpm prChecks", { timeout: 3_600_000 }), {})
  assert.deepEqual(subAgentDecision("pnpm prChecks", { timeout: 3_600_000 }, "agentId"), {})
  // An escaping job is a lifecycle hole wherever it runs, so a sub-agent is still refused.
  assert.equal(subAgentDecision("server &", { run_in_background: true }).hookSpecificOutput?.permissionDecision, "deny")
})

// The denial tells the worker to "own cleanup with an EXIT trap", and the idiomatic order arms the trap
// BEFORE the launch. Checking only the text after the last `&` refused exactly that (standard-schema
// sub-agent, 2026-09-30).
test("an EXIT trap armed before the launch owns the job as much as one armed after it", () => {
  assert.deepEqual(decision("trap 'kill $pid 2>/dev/null; wait' EXIT; PORT=0 pnpm start > /tmp/start.log 2>&1 & pid=$!; for i in 1 2 3; do grep -q http /tmp/start.log && break; sleep 1; done; curl -s localhost"), {})
  assert.deepEqual(decision("trap 'kill $pid' 0; server & pid=$!; curl -s localhost"), {})
  // The negative control: the same command with no trap anywhere is still an escaping job.
  assert.equal(output("PORT=0 pnpm start > /tmp/start.log 2>&1 & pid=$!; for i in 1 2 3; do grep -q http /tmp/start.log && break; sleep 1; done; curl -s localhost").permissionDecision, "deny")
  // A trap on some other signal owns nothing at exit.
  assert.equal(output("trap 'kill $pid' INT; server & pid=$!; curl -s localhost").permissionDecision, "deny")
})
