import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveNtwineCli } from "../dispatch.ts"
import { decideOrphans, enumerateProcs } from "../orphan-reaper.ts"
import { codexThreadShellConfig } from "./codex-shell-env.ts"
import { NTWINE_CLI, ntwineCliEnv, withNtwineCliOnPath, type NtwineCli } from "./types.ts"

const CLI: NtwineCli = { binDir: "/plugin/bin", stateDir: "/data/projects/proj-1", serverLock: "/data/server.lock", projectId: "proj-1" }

test("the command's environment names the server, the project and the node to run it on", () => {
  assert.deepEqual(ntwineCliEnv(CLI, undefined, "/abs/node"), {
    NTWINE_STATE_DIR: "/data/projects/proj-1",
    NTWINE_SERVER_LOCK: "/data/server.lock",
    NTWINE_PROJECT_ID: "proj-1",
    NTWINE_NODE: "/abs/node",
  })
  // The caller's identity rides only where the process serves ONE thread — and never as NTWINE_THREAD,
  // which is the orphan reaper's tag (see the reaper test below).
  assert.equal(ntwineCliEnv(CLI, "the-thread", "/abs/node").NTWINE_THREAD_SLUG, "the-thread")
  assert.equal("NTWINE_THREAD" in ntwineCliEnv(CLI, "the-thread", "/abs/node"), false)
  // A pre-singleton target has neither a machine lock nor a registry id, and must not invent one.
  assert.deepEqual(Object.keys(ntwineCliEnv({ binDir: "/b", stateDir: "/s" }, undefined, "/n")), ["NTWINE_STATE_DIR", "NTWINE_NODE"])
})

test("the command's directory goes FIRST on PATH, under the key the environment already uses", () => {
  assert.deepEqual(withNtwineCliOnPath({ PATH: "/usr/bin:/bin", HOME: "/h" }, CLI, "darwin"), { PATH: "/plugin/bin:/usr/bin:/bin", HOME: "/h" })
  // Windows spells it `Path` and separates with `;`. Writing a second `PATH` beside it would leave
  // which one a child reads to the runtime.
  assert.deepEqual(withNtwineCliOnPath({ Path: "C:\\Windows" }, { ...CLI, binDir: "C:\\plugin\\bin" }, "win32"), { Path: "C:\\plugin\\bin;C:\\Windows" })
  // Already there ⇒ unchanged, so a resume that re-applies it does not grow the variable.
  const once = withNtwineCliOnPath({ PATH: "/usr/bin" }, CLI, "linux")
  assert.equal(withNtwineCliOnPath(once, CLI, "linux"), once)
  // No PATH at all stays that way: one holding only our directory would take /usr/bin from every
  // other command the worker runs.
  assert.deepEqual(withNtwineCliOnPath({ HOME: "/h" }, CLI, "linux"), { HOME: "/h" })
  assert.deepEqual(withNtwineCliOnPath({ PATH: "" }, CLI, "linux"), { PATH: "" })
})

// The shape `_live_codex_shell_identity.mts` measured against the real codex 0.161.0: dotted keys, one
// per variable, in the thread's own config bag.
test("a codex thread's shell is told who it is through its own config bag, one dotted key per variable", () => {
  const bag = codexThreadShellConfig(CLI, "thread-a", { PATH: "/usr/bin:/bin", HOME: "/h" }, "/abs/node", "darwin")
  assert.deepEqual(bag, {
    "shell_environment_policy.set.NTWINE_STATE_DIR": "/data/projects/proj-1",
    "shell_environment_policy.set.NTWINE_SERVER_LOCK": "/data/server.lock",
    "shell_environment_policy.set.NTWINE_PROJECT_ID": "proj-1",
    "shell_environment_policy.set.NTWINE_NODE": "/abs/node",
    "shell_environment_policy.set.NTWINE_THREAD_SLUG": "thread-a",
    // WHOLE, because a `set` entry replaces the variable; nothing else of the environment is restated.
    "shell_environment_policy.set.PATH": "/plugin/bin:/usr/bin:/bin",
  })
  // Two threads on one app-server differ in exactly the one key that names them.
  const other = codexThreadShellConfig(CLI, "thread-b", { PATH: "/usr/bin:/bin" }, "/abs/node", "darwin")
  const first: Record<string, unknown> = bag
  assert.deepEqual(Object.keys(first).filter((k) => first[k] !== other[k]), ["shell_environment_policy.set.NTWINE_THREAD_SLUG"])
  // An app-server with no PATH gets none set, and no descriptor means nothing at all.
  assert.equal("shell_environment_policy.set.PATH" in codexThreadShellConfig(CLI, "t", {}, "/n", "linux"), false)
  assert.deepEqual(codexThreadShellConfig(undefined, "t", { PATH: "/usr/bin" }), {})
})

test("the command is resolved under the plugin a worker is launched against, or not at all", () => {
  const plugin = mkdtempSync(join(tmpdir(), "ntwine-cli-plugin-"))
  const target = { stateDir: "/data/projects/proj-1", serverLock: "/data/server.lock", projectId: "proj-1" }
  // A plugin directory without the command (an older artifact, a broken stage) yields nothing, so a
  // backend adds no PATH entry that leads nowhere.
  assert.equal(resolveNtwineCli(target, plugin), undefined)
  mkdirSync(join(plugin, "bin"))
  writeFileSync(join(plugin, "bin", NTWINE_CLI.name), "#!/bin/sh\n")
  assert.deepEqual(resolveNtwineCli(target, plugin), { binDir: join(plugin, "bin"), ...target })
  assert.deepEqual(resolveNtwineCli("/bare/state", plugin), { binDir: join(plugin, "bin"), stateDir: "/bare/state" })
})

// The orphan reaper owns NTWINE_THREAD: a process carrying it is reaped once it is two minutes old unless
// a live `claude`/`codex` session root carries the same slug. Neither a codex thread's shell (under a
// per-project app-server that names no thread) nor an ACP agent has such a root. So the environment this
// file builds for them must not be that tag, or the reaper kills a codex worker's long build and an ACP
// agent with its whole subtree. Driven through the reaper's OWN env reading, on the Linux path whose
// reader is injectable, so a change to what it matches is caught here too.
test("the environment a codex shell or an ACP agent is given is not the orphan reaper's ownership tag", async () => {
  const ps = [
    "  100     1  01:00:00 /usr/local/bin/codex app-server --stdio",
    "  200   100     10:00 /bin/zsh -lc make -j8",
    "  300     1     10:00 /opt/homebrew/bin/opencode acp",
  ].join("\n")
  const environ = (env: Record<string, string>) => Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\0")
  const reaped = async (env: Record<string, string>) => {
    const rows = await enumerateProcs(() => ps, { platform: "linux", readEnv: (pid) => pid === 100 ? environ({ HOME: "/h" }) : environ(env) })
    return decideOrphans(rows, { minAgeMs: 120_000, protectedPids: new Set() }).reap
  }
  const shell = Object.fromEntries(Object.entries(codexThreadShellConfig(CLI, "thread-a", { PATH: "/usr/bin" }, "/abs/node", "linux"))
    .map(([k, v]) => [k.replace("shell_environment_policy.set.", ""), String(v)]))
  assert.deepEqual(await reaped(shell), [])
  assert.deepEqual(await reaped(ntwineCliEnv(CLI, "thread-a", "/abs/node")), [])
  // CONTROL: the same processes tagged NTWINE_THREAD are what the reaper kills.
  assert.deepEqual(await reaped({ ...shell, NTWINE_THREAD: "thread-a" }), [200, 300])
})
