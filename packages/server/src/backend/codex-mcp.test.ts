import { test } from "node:test"
import assert from "node:assert/strict"
import { codexMcpConfigArgs, codexThreadMcpConfig, codexThreadMcpOff } from "./codex-mcp.ts"
import { NTWINE_MCP, codexContextWindowConfig } from "./types.ts"

// These pin the SHAPE of the `-c` overrides. The shape is otherwise only observable by running a real
// codex app-server (see _live_codex_mcp_inject.mts), so a refactor could silently stop mounting the
// servers and every unit test would still pass while codex workers quietly lost their tools — which
// is exactly the state this module was written to fix.

/** `-c` is variadic-free here: the args are strictly alternating flag/value pairs. */
function values(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i += 2) {
    assert.equal(args[i], "-c", `expected a -c flag at index ${i}, got ${args[i]}`)
    out.push(args[i + 1]!)
  }
  return out
}

test("codexMcpConfigArgs: with no ntwine descriptor, ntwine mounts NOTHING", () => {
  const vals = values(codexMcpConfigArgs(undefined, "/abs/node"))
  // A `chrome-devtools` override rode every app-server until 2026-08-26 — a browser nobody had asked
  // for, whose tool schemas cost ~6,400 prefix tokens per worker. Ntwine now injects the `ntwine` server
  // and nothing else, on BOTH backends; a project or operator that wants a browser configures it in
  // `~/.codex/config.toml` themselves, and these overrides layer on top of that rather than replacing it.
  assert.ok(!vals.some((v) => v.startsWith("mcp_servers.")), `ntwine must mount no server: ${vals.join(" ")}`)
  assert.ok(!vals.some((v) => v.includes("chrome-devtools")), "ntwine must inject no browser")
  // The approval override still rides along: it governs whatever MCP servers the OPERATOR configured,
  // and a headless worker has nobody to click a prompt for those either.
  assert.deepEqual(vals, ['default_tools_approval_mode="approve"'])
})


test("codexMcpConfigArgs: the ntwine server carries an ABSOLUTE node path and its NTWINE_STATE_DIR", () => {
  const vals = values(codexMcpConfigArgs({ scriptPath: "/abs/plugin/bin/ntwine-mcp.mjs", stateDir: "/abs/state" }, "/abs/node"))
  const ntwine = vals.find((v) => v.startsWith(`mcp_servers.${NTWINE_MCP.name}=`))
  assert.ok(ntwine, "ntwine override missing")
  assert.match(ntwine, /command="\/abs\/node"/)
  assert.match(ntwine, /args=\["\/abs\/plugin\/bin\/ntwine-mcp\.mjs"\]/)
  assert.match(ntwine, /env=\{NTWINE_STATE_DIR="\/abs\/state"\}/)
})

// Both backends mount the same script through the same env builder. Pinned on the CODEX side too
// because this is the half that gets forgotten: the claude path is the one anyone tests by hand, and a
// codex worker whose tools quietly address the launching project's board looks identical until its
// spawned thread turns up on the wrong card.
test("codexMcpConfigArgs: the ntwine server is told where the lock is and which project it serves", () => {
  const vals = values(codexMcpConfigArgs({
    scriptPath: "/abs/plugin/bin/ntwine-mcp.mjs",
    stateDir: "/abs/state",
    serverLock: "/abs/launcher/server.lock",
    projectId: "b47f4055-4262-432a-af18-ded4cbfb3071",
  }, "/abs/node"))
  const ntwine = vals.find((v) => v.startsWith(`mcp_servers.${NTWINE_MCP.name}=`))
  assert.ok(ntwine, "ntwine override missing")
  assert.match(ntwine, /NTWINE_SERVER_LOCK="\/abs\/launcher\/server\.lock"/)
  assert.match(ntwine, /NTWINE_PROJECT_ID="b47f4055-4262-432a-af18-ded4cbfb3071"/)
})

test("codexMcpConfigArgs: approvals are pre-answered — a headless worker cannot click a prompt", () => {
  // Without this a mounted call is CANCELLED at the moment of use ("user cancelled MCP tool call"),
  // which is strictly worse than not mounting the server at all.
  assert.ok(values(codexMcpConfigArgs(undefined)).includes('default_tools_approval_mode="approve"'))
})

test("codexMcpConfigArgs: values are TOML-quoted so a path with a space or quote cannot break parsing", () => {
  const vals = values(codexMcpConfigArgs({ scriptPath: '/has space/and"quote/ntwine-mcp.mjs', stateDir: "/s" }, "/node"))
  const ntwine = vals.find((v) => v.startsWith(`mcp_servers.${NTWINE_MCP.name}=`))!
  // An unquoted/naively-quoted path would terminate the TOML string early and the whole override would
  // fail to parse — codex then starts with NO ntwine server and nothing says so.
  assert.ok(ntwine.includes('"/has space/and\\"quote/ntwine-mcp.mjs"'), `not escaped: ${ntwine}`)
})

test("codexMcpConfigArgs: every emitted value is a well-formed `key=value` override", () => {
  for (const v of values(codexMcpConfigArgs({ scriptPath: "/p/s.mjs", stateDir: "/d" }, "/node"))) {
    assert.match(v, /^[a-z_]+(\.[a-z-]+)*=/, `malformed override: ${v}`)
  }
})

// ---- the PER-THREAD mount: the only channel that can name the caller ----

test("codexThreadMcpConfig: mounts the ntwine server with THIS thread's slug in its env", () => {
  const config = codexThreadMcpConfig(
    { scriptPath: "/plugin/bin/ntwine-mcp.mjs", stateDir: "/state", serverLock: "/lock/server.lock", projectId: "proj-1" },
    "compiled-hono",
    "/abs/node",
  )
  const entry = (config.mcp_servers as Record<string, any>)[NTWINE_MCP.name]
  assert.ok(entry, "the ntwine server is mounted for the thread")
  assert.equal(entry.command, "/abs/node") // absolute, never bare "node" — the app-server's PATH varies
  assert.deepEqual(entry.args, ["/plugin/bin/ntwine-mcp.mjs"])
  // THE POINT OF THE WHOLE MOUNT. Without this, `title`/`ask`/`done`/`watch`/`timer`/`goal`/`activity`
  // all fail with "this ntwine MCP server was not told which thread it belongs to".
  assert.equal(entry.env.NTWINE_THREAD_SLUG, "compiled-hono")
  // …and the project half still rides along, so a tenant's worker reaches the right lock and board.
  assert.equal(entry.env.NTWINE_SERVER_LOCK, "/lock/server.lock")
  assert.equal(entry.env.NTWINE_PROJECT_ID, "proj-1")
  // Per-SERVER, not inherited from the top-level argv key: an entry without it was refused on 0.153.2
  // with "MCP tool call requires approval, but approval policy is never".
  assert.equal(entry.default_tools_approval_mode, "approve")
})

test("codexThreadMcpConfig: no descriptor ⇒ an EMPTY bag, so no `config` key is sent at all", () => {
  // Degrades to exactly the pre-2026-09-04 behaviour rather than sending a half-built mount.
  assert.deepEqual(codexThreadMcpConfig(undefined, "compiled-hono", "/abs/node"), {})
})

// The argv entry is what a thread falls back to when a resume reaches the app-server without the
// per-thread bag. Measured 2026-09-18 (`_live_codex_resume_mcp.mts`, codex 0.155.0/0.155.1): without
// the per-entry key that fallback listed the tool and refused every call — "MCP tool call requires
// approval, but approval policy is never" — so the top-level `default_tools_approval_mode` beside it
// was never enough on its own.
test("codexMcpConfigArgs: the argv entry carries its OWN default_tools_approval_mode, not just the top-level key", () => {
  const vals = values(codexMcpConfigArgs({ scriptPath: "/abs/plugin/bin/ntwine-mcp.mjs", stateDir: "/abs/state" }, "/abs/node"))
  const ntwine = vals.find((v) => v.startsWith(`mcp_servers.${NTWINE_MCP.name}=`))!
  assert.match(ntwine, /default_tools_approval_mode="approve"/)
})

// Codex runs a thread's stdio MCP children in the THREAD's cwd unless the entry pins its own, and a
// thread whose recorded cwd no longer exists (a project directory rename) then gets NO MCP children
// at all — measured 2026-09-18 with `STALE_CWD=1`: no child spawned, the model answered NOTOOL. The
// state dir exists for as long as the project is registered, and the script reads nothing relative
// to its cwd.
test("both mounts pin the MCP child's cwd to the project state dir, never the thread's", () => {
  const descriptor = { scriptPath: "/plugin/bin/ntwine-mcp.mjs", stateDir: "/state/proj-1", projectId: "proj-1" }
  const argv = values(codexMcpConfigArgs(descriptor, "/abs/node")).find((v) => v.startsWith(`mcp_servers.${NTWINE_MCP.name}=`))!
  assert.match(argv, /cwd="\/state\/proj-1"/)
  const bag = codexThreadMcpConfig(descriptor, "compiled-hono", "/abs/node") as { mcp_servers: Record<string, { cwd: string }> }
  assert.equal(bag.mcp_servers[NTWINE_MCP.name]!.cwd, "/state/proj-1")
})

test("codexContextWindowConfig: a positive integer window becomes `model_context_window`, anything else sends nothing", () => {
  // The value is passed through UNCLAMPED: codex clamps it to the model's max_context_window itself
  // (measured 2026-09-11: 1_000_000 on gpt-5.6-sol reported 828_400 = 872K × 95%), and a table of
  // per-model caps here would go stale the moment a model shipped a bigger one.
  assert.deepEqual(codexContextWindowConfig({ codexContextWindow: 600_000 }), { model_context_window: 600_000 })
  assert.deepEqual(codexContextWindowConfig({ codexContextWindow: 1_000_000 }), { model_context_window: 1_000_000 })
  // Unset ⇒ the model's stock window, exactly as before the setting existed.
  assert.deepEqual(codexContextWindowConfig(undefined), {})
  assert.deepEqual(codexContextWindowConfig({}), {})
  for (const junk of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(codexContextWindowConfig({ codexContextWindow: junk }), {}, `${String(junk)} must send no override`)
  }
})

// An app-server started before the rename still mounts the server as `frizz`; the per-thread switch must
// turn that one off as well, each with the `command` that makes a lone `enabled = false` a valid entry.
test("codexThreadMcpOff switches off the pre-rename frizz mount alongside ntwine", () => {
  assert.deepEqual(codexThreadMcpOff("/n"), {
    "mcp_servers.ntwine.enabled": false,
    "mcp_servers.ntwine.command": "/n",
    "mcp_servers.frizz.enabled": false,
    "mcp_servers.frizz.command": "/n",
  })
})
