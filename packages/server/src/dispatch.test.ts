import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, isAbsolute } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { DISPATCH_TASK_BANNER_MARKER } from "@ntwine/shared"
import { buildClaudeCommand, launchableWorkerPluginDir, loadWorkerPrompt, composePrompt, monitorScriptsDir, resolveWorkerPluginDir, scratchDirRelPath, scratchpadOrientation, workerPluginDir, workerScratchPath, ntwineConfigBlock, workerDispatchPermission, WORKER_DISPATCH_PERMISSION } from "./dispatch.ts"
import { parseTranscript } from "./transcript.ts"
import { NTWINE_MCP } from "./backend/types.ts"

// The worker's MCP config, read from the owner-only FILE its argv names. Never inline JSON: the config
// carries credentials, and an argv is readable through `ps` by every local process.
function mcpConfigOf(argv: string[]) {
  const path = argv[argv.indexOf("--mcp-config") + 1]
  assert.ok(path && isAbsolute(path), `--mcp-config must name a file: ${path}`)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  return JSON.parse(readFileSync(path, "utf8"))
}

// ---- Backend-aware worker contract (worker-contract-backend-aware) ----
// loadWorkerPrompt(kind) delegates to buildWorkerPrompt in workerPrompt.ts (a single compiled-in TS
// source, no runtime markdown/marker fill). The CLAUDE output must still reproduce the pre-split
// contract BYTE-FOR-BYTE (the regression bar); the CODEX output has its own golden.

const here = dirname(fileURLToPath(import.meta.url))
// The FROZEN pre-split claude contract body (the exact string a claude dispatch got before the split).
// Regenerate ONLY when the shipped claude contract is deliberately changed — an unexpected diff here is
// a regression (a core/claude-fragment edit that altered what a claude worker receives).
// The markdown loader trims the contract body; normalize the fixture's conventional POSIX newline
// before making the byte-for-byte comparison of the actual prompt content.
const CLAUDE_GOLDEN = readFileSync(join(here, "WORKER_PROMPT.claude.golden.txt"), "utf8").trimEnd()
const CODEX_GOLDEN = readFileSync(join(here, "WORKER_PROMPT.codex.golden.txt"), "utf8").trimEnd()
const SESSION_SEED = readFileSync(join(here, "../../../cc-worker/hooks/session-seed.mjs"), "utf8")

test("loadWorkerPrompt: default kind is claude", () => {
  assert.equal(loadWorkerPrompt(), loadWorkerPrompt("claude"))
})

test("Claude dispatch supplies the discovered worker plugin via --plugin-dir", () => {
  const plugin = workerPluginDir()
  assert.ok(plugin, "the packaged worker plugin must be discoverable")
  assert.doesNotThrow(() => readFileSync(join(plugin, ".claude-plugin", "plugin.json"), "utf8"))
  const argv = buildClaudeCommand({
    sessionId: "plugin-dispatch",
    permissionMode: "auto",
    prompt: "test",
    workerPrompt: "",
    pluginDir: plugin,
  })
  assert.deepEqual(argv.slice(argv.indexOf("--plugin-dir"), argv.indexOf("--plugin-dir") + 2), ["--plugin-dir", plugin])
})

test("Claude dispatch mounts the unified ntwine MCP server, alone, and pre-approves it", () => {
  const argv = buildClaudeCommand({
    sessionId: "mcp-dispatch",
    permissionMode: "auto",
    prompt: "test",
    workerPrompt: "",
    ntwineMcp: { scriptPath: "/abs/plugin/bin/ntwine-mcp.mjs", stateDir: "/home/.ntwine/projects/pid" },
  })
  const cfg = mcpConfigOf(argv)
  // `ntwine` is the ONLY server ntwine injects. A `chrome-devtools` mount rode every dispatch until
  // 2026-08-26; it cost ~6,400 prefix tokens of tool schema on a worker that mostly never opened a
  // page, and a browser is the project's to bring — its `.mcp.json`, which rides this same config file
  // (next test but one); `claude mcp add --scope user` no longer reaches a worker at all.
  assert.ok(argv.includes("--strict-mcp-config"), "a worker discovers no MCP scope on its own")
  assert.deepEqual(Object.keys(cfg.mcpServers), [NTWINE_MCP.name])
  assert.deepEqual(cfg.mcpServers[NTWINE_MCP.name], {
    command: process.execPath, // absolute node path, not bare "node" (worker PATH-independence)
    args: ["/abs/plugin/bin/ntwine-mcp.mjs"],
    env: { NTWINE_STATE_DIR: "/home/.ntwine/projects/pid" },
  })
  // No NTWINE_PROJECT_ID here because this descriptor carries none: the id is stamped by the SERVER at
  // spawn, from the worker's own project, and is never a tool argument — which is what makes "spawn a
  // thread on another project's board" unexpressible rather than merely discouraged. The same reason
  // NTWINE_THREAD_SLUG is env-only.
  // Tools are pre-approved so a headless worker never blocks on a permission prompt. One comma-joined
  // EQUALS-form token: --allowedTools is variadic, so a space-separated value could swallow a
  // following positional (the prompt) — the equals form binds exactly one token. BOTH rules are
  // SERVER-level, so a tool added to either server needs no allow-list edit.
  assert.ok(argv.includes("--allowedTools=mcp__ntwine"))
  // Nothing in the argv reaches for a browser, on any flag.
  assert.ok(!argv.some((a) => a.includes("chrome-devtools")), "ntwine must inject no browser")
  // The prompt stays the trailing positional (flags never displace it).
  assert.equal(argv[argv.length - 1], "test")
})

test("Claude dispatch stamps the singleton's lock path and the worker's OWN project into the ntwine MCP env", () => {
  const argv = buildClaudeCommand({
    sessionId: "mcp-tenant",
    permissionMode: "auto",
    prompt: "test",
    workerPrompt: "",
    ntwineMcp: {
      scriptPath: "/abs/plugin/bin/ntwine-mcp.mjs",
      stateDir: "/home/.ntwine/projects/tenant",
      serverLock: "/home/.ntwine/projects/launcher/server.lock",
      projectId: "b47f4055-4262-432a-af18-ded4cbfb3071",
    },
  })
  const cfg = mcpConfigOf(argv)
  // One process serves N projects and writes ONE lock (the launcher's), so a tenant's worker is told
  // where that lock is; and the RPC it POSTs is prefixed with its own project, because unprefixed
  // means the LAUNCHING project — the difference between spawning onto your board and onto someone
  // else's. Neither value is derivable inside the worker, and neither is a tool argument.
  assert.deepEqual(cfg.mcpServers[NTWINE_MCP.name].env, {
    NTWINE_STATE_DIR: "/home/.ntwine/projects/tenant",
    NTWINE_SERVER_LOCK: "/home/.ntwine/projects/launcher/server.lock",
    NTWINE_PROJECT_ID: "b47f4055-4262-432a-af18-ded4cbfb3071",
  })
})

test("Claude dispatch mounts NOTHING when no ntwine-MCP descriptor resolved — no empty flags", () => {
  const argv = buildClaudeCommand({ sessionId: "no-mcp", permissionMode: "auto", prompt: "test", workerPrompt: "" })
  // With the browser mount gone this is a real state, and the flags must be ABSENT rather than empty:
  // `--allowedTools=` hands the CLI one rule that is the empty string, which is not the same as no
  // rule at all. `--strict-mcp-config` is the one flag that stays: it is what keeps the operator's
  // user-scope servers out of the worker, and a worker with nothing to mount still must not boot them
  // (the project's own `.mcp.json` arrives through `projectMcpServers`, never through discovery).
  assert.ok(argv.includes("--strict-mcp-config"))
  assert.ok(!argv.includes("--mcp-config"))
  assert.ok(!argv.some((a) => a.startsWith("--allowedTools")))
})

test("Claude dispatch mounts the project's approved servers under --strict-mcp-config, and ntwine wins a name collision", () => {
  const argv = buildClaudeCommand({
    sessionId: "mcp-project",
    permissionMode: "auto",
    prompt: "test",
    workerPrompt: "",
    ntwineMcp: { scriptPath: "/abs/plugin/bin/ntwine-mcp.mjs", stateDir: "/home/.ntwine/projects/pid" },
    projectMcpServers: {
      "chrome-devtools": { command: "npx", args: ["-y", "chrome-devtools-mcp@1.7.0", "--headless"] },
      Neon: { type: "http", url: "https://mcp.neon.tech/mcp" },
      [NTWINE_MCP.name]: { command: "/not/ntwine" },
    },
  })
  assert.ok(argv.includes("--strict-mcp-config"))
  const cfg = mcpConfigOf(argv)
  // The project's servers travel in the SAME config file as the ntwine mount — under strict mode that
  // config is the whole MCP surface — and a project cannot shadow `ntwine` by naming a server after it.
  assert.deepEqual(Object.keys(cfg.mcpServers).sort(), ["Neon", "chrome-devtools", NTWINE_MCP.name].sort())
  assert.deepEqual(cfg.mcpServers["chrome-devtools"], { command: "npx", args: ["-y", "chrome-devtools-mcp@1.7.0", "--headless"] })
  assert.deepEqual(cfg.mcpServers.Neon, { type: "http", url: "https://mcp.neon.tech/mcp" })
  assert.equal(cfg.mcpServers[NTWINE_MCP.name].args[0], "/abs/plugin/bin/ntwine-mcp.mjs")
  // Only the ntwine server is pre-approved; a project server keeps whatever approval story it had.
  assert.ok(argv.includes("--allowedTools=mcp__ntwine"))
})

test("Claude worker surfaces share the canonical per-session scratch DIRECTORY path", () => {
  const sessionId = "scratch-canonical"
  const canonical = `.ntwine/threads/${sessionId}/`
  assert.match(composePrompt(sessionId, "task", "claude"), new RegExp(canonical.replaceAll("/", "\\/")))
  assert.match(scratchpadOrientation(sessionId, "claude"), new RegExp(canonical.replaceAll("/", "\\/")))
  assert.match(SESSION_SEED, /\.ntwine\/threads\//)
  // No surface may resurrect the canonical filename: nothing reserves a name in that directory now.
  assert.doesNotMatch(composePrompt(sessionId, "task", "claude"), /scratch\.md/)
  assert.doesNotMatch(scratchpadOrientation(sessionId, "claude"), /scratch\.md/)
  assert.doesNotMatch(SESSION_SEED, /scratch\.md/)
  assert.doesNotMatch(SESSION_SEED, /\.ntwine\/scratch\//)
})

// ---- NTWINE.md project-config injection (defer-to-project-norms) ----
// A repo-committed NTWINE.md at the project root is injected into the worker SYSTEM prompt under an
// "overrides ntwine defaults" header, so a project's own norms win over ntwine's built-in defaults.
test("ntwineConfigBlock: absent NTWINE.md injects nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-md-absent-"))
  assert.equal(ntwineConfigBlock(dir), "")
})

test("ntwineConfigBlock: empty/whitespace NTWINE.md injects nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-md-empty-"))
  writeFileSync(join(dir, "NTWINE.md"), "\n  \n")
  assert.equal(ntwineConfigBlock(dir), "")
})

test("ntwineConfigBlock: present NTWINE.md is wrapped in an overrides-ntwine-defaults header", () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-md-present-"))
  const body = "## Our norms\n- Gates: `pnpm check`\n- Skip adversarial review on small UI diffs."
  writeFileSync(join(dir, "NTWINE.md"), body + "\n")
  const block = ntwineConfigBlock(dir)
  assert.match(block, /PROJECT NTWINE CONFIG \(from this repo's NTWINE\.md\)/)
  // Header is scoped to PROCESS defaults and explicitly does NOT relax the ntwine-mechanical contract —
  // so a NTWINE.md can't contradict the "Defer" section's non-negotiable browser/signal gates.
  assert.match(block, /OVERRIDE the ntwine worker PROCESS defaults above/)
  assert.match(block, /do NOT relax the ntwine-mechanical contract/)
  assert.ok(block.includes(body), "the NTWINE.md body must be present verbatim")
})

test("ntwineConfigBlock: an over-cap NTWINE.md content is clipped with a truncation marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-md-clip-"))
  writeFileSync(join(dir, "NTWINE.md"), "x".repeat(50_000)) // > 24k chars, < 64KB → read then clipped
  const block = ntwineConfigBlock(dir)
  assert.match(block, /\[NTWINE\.md truncated\]/)
  assert.ok(block.length < 26_000, "the injected block must stay within the system-prompt budget")
})

// THE CAP HAS TO CLEAR A REAL FILE, not just look prudent, and the clip is silent to everyone who
// matters: the marker lands in a system prompt nobody reads. At 12,000 this repo's own NTWINE.md
// (16,522 chars on 2026-08-28) lost its last 4,522 on EVERY dispatch — beginning at the "NEVER open a
// pull request" section, which CLAUDE.md calls the most-violated rule in the repo. This test is the
// guard; the constant is only a number.
test("ntwineConfigBlock injects this repo's own NTWINE.md IN FULL — the cap clears the real file", () => {
  const repoRoot = join(here, "..", "..", "..")
  const body = readFileSync(join(repoRoot, "NTWINE.md"), "utf8").trim()
  const block = ntwineConfigBlock(repoRoot)
  assert.doesNotMatch(
    block,
    /\[NTWINE\.md truncated\]/,
    `NTWINE.md is ${body.length} chars and no longer fits the injection cap — raise NTWINE_MD_MAX_CHARS or trim the file, because workers are silently losing its tail`,
  )
  assert.ok(block.includes(body), "the whole file must reach the worker, never a prefix of it")
})

test("ntwineConfigBlock: a runaway (>64KB) NTWINE.md is rejected unread, not slurped", () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-md-runaway-"))
  writeFileSync(join(dir, "NTWINE.md"), "x".repeat(200_000)) // exceeds the read-size guard
  assert.equal(ntwineConfigBlock(dir), "")
})

test("ntwineConfigBlock: a non-regular NTWINE.md (a directory) injects nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-md-dir-"))
  mkdirSync(join(dir, "NTWINE.md"))
  assert.equal(ntwineConfigBlock(dir), "")
})

test("ntwineConfigBlock composes AFTER the worker contract (override position) in the system prompt", () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-md-order-"))
  writeFileSync(join(dir, "NTWINE.md"), "PROJECT-NORM-SENTINEL")
  const sessionId = "ntwine-md-order"
  const system = [loadWorkerPrompt("claude"), scratchpadOrientation(sessionId, "claude"), ntwineConfigBlock(dir)]
    .filter(Boolean)
    .join("\n\n")
  assert.ok(system.indexOf("PROJECT-NORM-SENTINEL") > system.indexOf("Defer to the project's own norms"))
})

test("artifact worker resolver finds runtime/cc-worker through pnpm's nested module store", () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-worker-plugin-resolver-"))
  const runtime = join(root, "runtime")
  const module = join(runtime, "node_modules", ".pnpm", "@ntwine+server@fixture", "node_modules", "@ntwine", "server", "src", "dispatch.js")
  const plugin = join(runtime, "cc-worker")
  mkdirSync(dirname(module), { recursive: true })
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true })
  writeFileSync(module, "export {}\n")
  writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), "{}\n")
  assert.equal(resolveWorkerPluginDir(pathToFileURL(module).href, {}), plugin)
})

// ---- the path a worker is LAUNCHED against (launchableWorkerPluginDir) ----

/** A plugin as an artifact carries it: found at a version-specific path the launcher names. */
function artifactPlugin(root: string, marker: string): string {
  const dir = join(root, "runtime", "cc-worker")
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true })
  mkdirSync(join(dir, "hooks"), { recursive: true })
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), "{}\n")
  writeFileSync(join(dir, "hooks", "hooks.json"), JSON.stringify({ marker }))
  return dir
}

test("an artifact's plugin is launched through the stable path, and a newer artifact's boot moves it", () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-launchable-plugin-"))
  const roots = { stageRoot: join(root, "cache", "plugins"), stableRoot: join(root, "cache", "current") }
  const marker = (path: string) => JSON.parse(readFileSync(join(path, "hooks", "hooks.json"), "utf8")).marker

  const v1 = artifactPlugin(join(root, "generation-1"), "v1")
  const launched = launchableWorkerPluginDir(v1, { NTWINE_WORKER_PLUGIN_DIR: v1 }, roots)
  assert.equal(launched, join(roots.stableRoot, "cc-worker"), "a worker is handed the stable path, not the generation's own")
  assert.equal(marker(launched), "v1")

  // The next version boots: a different process in production, the same call here.
  const v2 = artifactPlugin(join(root, "generation-2"), "v2")
  assert.equal(launchableWorkerPluginDir(v2, { NTWINE_WORKER_PLUGIN_DIR: v2 }, roots), launched, "the path a running worker holds never changes")
  assert.equal(marker(launched), "v2", "and what it leads to is now the new version's plugin")
  assert.equal(marker(v1), "v1", "with the old generation's own directory left exactly as it was")
})

test("a source checkout's plugin is launched where it stands — it is edited in place, so it is already live", () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-launchable-plugin-"))
  const roots = { stageRoot: join(root, "cache", "plugins"), stableRoot: join(root, "cache", "current") }
  const checkout = artifactPlugin(root, "source")
  assert.equal(launchableWorkerPluginDir(checkout, {}, roots), checkout)
  assert.equal(existsSync(join(root, "cache")), false, "nothing was staged")
})

test("staging that fails costs no dispatch: the worker is launched against the immutable directory", () => {
  const root = mkdtempSync(join(tmpdir(), "ntwine-launchable-plugin-"))
  const roots = { stageRoot: join(root, "cache", "plugins"), stableRoot: join(root, "cache", "current") }
  // Something real already sits where the link belongs, which ensureSymlink refuses to replace.
  mkdirSync(join(roots.stableRoot, "cc-worker"), { recursive: true })
  const artifact = artifactPlugin(join(root, "generation"), "v1")
  assert.equal(launchableWorkerPluginDir(artifact, { NTWINE_WORKER_PLUGIN_DIR: artifact }, roots), artifact)
})

test("loadWorkerPrompt(claude) is BYTE-IDENTICAL to the pre-split contract (the regression bar)", () => {
  assert.equal(loadWorkerPrompt("claude"), CLAUDE_GOLDEN)
})

// The codex contract prints the ABSOLUTE path of the bundled CI/review monitors, which differs per
// checkout — so the golden keeps the unfilled token and the comparison substitutes it back. The fill
// itself is pinned separately below.
test("loadWorkerPrompt(codex) is BYTE-IDENTICAL to its golden (regenerate on deliberate codex edits)", () => {
  const monitors = monitorScriptsDir()
  const normalized = monitors ? loadWorkerPrompt("codex").replaceAll(monitors, "{{NTWINE_MONITORS_DIR}}") : loadWorkerPrompt("codex")
  assert.equal(normalized, CODEX_GOLDEN)
})

// Codex has no skills and no plugin, so "use the bundled monitors" is only actionable as a path it can
// actually open — an unresolvable one used to be the reason the model wrote its own short-poll loop.
test("the codex contract names the bundled monitors by a path that exists", () => {
  const dir = monitorScriptsDir()
  assert.ok(dir, "the worker plugin ships the portable monitors; resolving it must not fail in the repo")
  assert.ok(existsSync(join(dir!, "ci-watch.mjs")))
  assert.ok(existsSync(join(dir!, "review-watch.mjs")))
  const escaped = dir!.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")
  assert.match(loadWorkerPrompt("codex"), new RegExp(`node ${escaped}/ci-watch\\.mjs `))
  assert.match(loadWorkerPrompt("codex"), new RegExp(`node ${escaped}/review-watch\\.mjs `))
})

test("loadWorkerPrompt: no unresolved {{NTWINE_*}} markers survive in either backend's contract", () => {
  assert.doesNotMatch(loadWorkerPrompt("claude"), /\{\{NTWINE_/)
  assert.doesNotMatch(loadWorkerPrompt("codex"), /\{\{NTWINE_/)
})

test("loadWorkerPrompt(codex) OMITS every Claude-Code-only construct a codex worker can't use", () => {
  const c = loadWorkerPrompt("codex")
  // No Claude session/wake, no Agent tool, no ntwine profiles, no sub-agent blackboard framing.
  assert.doesNotMatch(c, /claude session/)
  assert.doesNotMatch(c, /claude -r/)
  assert.doesNotMatch(c, /## Sub-agents/)
  assert.doesNotMatch(c, /Agent tool/)
  assert.doesNotMatch(c, /run_in_background/)
  assert.doesNotMatch(c, /ntwine:<model>-<effort>/)
  assert.doesNotMatch(c, /ntwine:opus/)
  assert.doesNotMatch(c, /blackboard/)
})

test("loadWorkerPrompt(codex) requests exactly one first-output invisible title comment", () => {
  const c = loadWorkerPrompt("codex")
  assert.match(c, /## Thread title signal/)
  assert.match(c, /<!-- ntwine title="Queue focus" -->/)
  assert.match(c, /very FIRST assistant message/)
  assert.match(c, /before any[\s\S]*commentary[\s\S]*tool call/)
  assert.match(c, /ONE or TWO words naming the SUBJECT/)
  assert.match(c, /strips this comment from visible chat/)
  assert.match(c, /user rename always wins/)
  assert.match(c.replace(/\s+/g, " "), /Never use an H1 for the title signal/)
  assert.doesNotMatch(loadWorkerPrompt("claude"), /<!-- ntwine-title:/)
})

test("session-seed is a SLIM runtime pointer, not a fourth full contract copy", () => {
  // The full contract lives ONCE in the system prompt (loadWorkerPrompt) — the on-demand ntwine:worker
  // skill copy was deleted. The SessionStart hook only re-grounds: it points at the system prompt, carries the runtime
  // scratchpad path + a signal-at-rest anchor, and must NOT re-duplicate the re-entry drill or any
  // browser-QA checklist (that duplication is exactly what drifted and what this slim removes).
  assert.match(SESSION_SEED, /Your full worker contract is in your SYSTEM PROMPT/)
  // The worker-skill copy is GONE — the seed must not tell workers to load a skill that no longer exists.
  assert.doesNotMatch(SESSION_SEED, /ntwine:worker/)
  assert.match(SESSION_SEED, /\.ntwine\/threads\//)
  assert.doesNotMatch(SESSION_SEED, /scratch\.md/, "no filename is reserved in the scratch directory")
  // One line since 2026-10-14: the pointer, the three endings by name, and the runtime path.
  assert.match(SESSION_SEED, /end every rest with `ntwinectl done`, `ntwinectl ask`, or an ```awaiting fence/)
  assert.doesNotMatch(SESSION_SEED, /mcp__ntwine__/)
  assert.doesNotMatch(SESSION_SEED, /placement marker|ALWAYS SIGN OFF|SCRATCH DIRECTORY \(OPTIONAL\)/)
  assert.doesNotMatch(SESSION_SEED, /```done \/ ```awaiting \/ ```question/)
  assert.doesNotMatch(SESSION_SEED, /RUNTIME RELEASE GATE:/)
  assert.doesNotMatch(SESSION_SEED, /never build a bespoke screenshot tool/)
  assert.doesNotMatch(SESSION_SEED, /back to awaiting/)
})

test("runtime release gate: WIPED — no worker surface carries browser-QA opinionation", () => {
  // The settings-toggled Runtime-release-gate module was deleted (maintainer 2026-08-03: "extremely
  // overfit to our specific requirements inside of this repo. Wipe it entirely."). Browser-QA policy
  // now belongs to a project's own NTWINE.md/CLAUDE.md, which ntwineConfigBlock injects per repo — never to
  // every worker ntwine dispatches anywhere.
  for (const raw of [loadWorkerPrompt("claude"), loadWorkerPrompt("codex")]) {
    const c = raw.replace(/\s+/g, " ")
    assert.doesNotMatch(c, /Runtime release gate/i)
    assert.doesNotMatch(c, /SKIP IT for the small and the certain/i)
    assert.doesNotMatch(c, /never build a bespoke screenshot tool/i)
    assert.doesNotMatch(c, /Chrome DevTools MCP/i)
    assert.doesNotMatch(c, /agent-browser/i)
    // The generic, repo-agnostic verification rule stays — it names no browser.
    assert.match(c, /Verify behavior end-to-end before calling anything done/i)
    // …as does the guidance for SHOWING the human the screenshots a worker does produce.
    assert.match(c, /## Showing the user pictures, video and designs/)
  }
})

// ---- composePrompt: the first VISIBLE user message's scratchpad line is backend-aware ----

test("composePrompt gives each backend's sub-agents their OWN file, never a shared document", () => {
  const claude = composePrompt("sid", "do the thing", "claude")
  assert.match(claude, /Name it in a sub-agent's prompt/)
  assert.match(claude, /give each child its OWN file rather than having them all edit one/)
  assert.equal(composePrompt("sid", "do the thing"), claude) // default = claude (unchanged)

  const codex = composePrompt("sid", "do the thing", "codex")
  assert.match(codex, /Native sub-agents share it — have each write its OWN file/)

  for (const [kind, text] of [["claude", claude], ["codex", codex]] as const) {
    // The merge contract is GONE, not reworded: one file per writer is what removed the hazard.
    assert.doesNotMatch(text, /merge/i, `${kind} must not reintroduce a shared-document merge contract`)
    assert.doesNotMatch(text, /blackboard/, `${kind} must not reintroduce the shared blackboard`)
    // The post-compaction goal stays NAMED as a capability — offered, never pushed (2026-08-28).
    assert.match(text, /`ntwinectl goal start --post-compaction`/, `${kind} must name the post-compaction capability`)
  }
  assert.ok(codex.endsWith("do the thing")) // the task still rides through, and rides through LAST
})

// The pad is OPTIONAL and is NOT a deliverable — pinned because the opposite framing has a measured
// behavioural cost. Presented as "the CANONICAL record" with a mandatory "next action" field, a worker
// treats WRITING the next step as equivalent to DOING it, writes "next: X" for an X the human already
// asked for, and rests mid-mandate. Both surfaces must keep saying optional, and must keep saying that
// writing in it is not doing the work.
test("every scratch surface presents notes as optional and never a substitute for the work", () => {
  for (const kind of ["claude", "codex"] as const) {
    const prompt = composePrompt("sid", "do the thing", kind)
    assert.match(prompt, /nothing is expected in it/, `${kind} composePrompt must not present notes as mandatory`)
    assert.match(prompt, /never a substitute for doing the work/, `${kind} composePrompt must refuse the substitution`)
    assert.doesNotMatch(prompt, /CANONICAL/, `${kind} composePrompt must not re-promote a canonical doc`)

    const orientation = scratchpadOrientation("sid", kind)
    assert.match(orientation, /nothing is expected in it/, `${kind} orientation must not present notes as mandatory`)
    assert.match(orientation, /never a substitute for doing the work/, `${kind} orientation must refuse the substitution`)
    assert.doesNotMatch(orientation, /CANONICAL/, `${kind} orientation must not re-promote a canonical doc`)
  }
})

// ---- composePrompt: the system→human handoff carries a loud demarcation banner ----

test("composePrompt puts NOTHING of ntwine's below the banner — the operator's prompt is the whole tail", () => {
  const task = "Fix the thing.\n\nWith a second paragraph."
  const composed = composePrompt("sid", task, "claude")

  // The banner sits between the orientation/instructions and the task, padded by blank lines.
  const banner = composed.indexOf("YOUR TASK")
  assert.notEqual(banner, -1)
  // Anchor on the scratchpad orientation: the operator preamble moved to the system prompt, and
  // asserting `indexOf(...) < banner` on an ABSENT string passes vacuously (-1 < banner).
  assert.ok(composed.indexOf(".ntwine/threads/") < banner)
  assert.doesNotMatch(composed, /PROJECT INSTRUCTIONS/)
  assert.match(composed, /\n\n\n\n=+\n=+ {4}YOUR TASK {4}=+\n=+\n/)
  // THE property the banner exists for: below it is the operator's prompt, byte for byte. The framing
  // note that used to sit underneath now sits above, and the bare `TASK:` marker is gone entirely.
  assert.ok(composed.endsWith(`${DISPATCH_TASK_BANNER_MARKER}${task}`))
  assert.equal(composed.indexOf(DISPATCH_TASK_BANNER_MARKER), composed.lastIndexOf(DISPATCH_TASK_BANNER_MARKER))
  assert.ok(!composed.includes("\nTASK:\n"))
  assert.ok(composed.indexOf("ntwine system orientation") < banner)

  // Round-trip through the real parser: the UI's first user message shows exactly the human's words,
  // while the stored text keeps the whole machine-facing prompt the worker actually received.
  const raw = JSON.stringify({
    type: "user",
    timestamp: "2026-07-01T00:00:00.000Z",
    message: { content: composed },
  })
  const [message] = parseTranscript(raw)
  assert.equal(message.displayText, task)
  assert.equal(message.text, composed)
})

// The broker runtime delivers the dispatch prompt as a `queue-operation` enqueue record, NOT as a plain
// `user` record — which is how the whole composed prompt (orientation, project instructions, banner and
// all) ended up rendered in the first chat bubble of every broker thread.
test("composePrompt round-trips through the BROKER's enqueue record with the same bubble", () => {
  const task = "run `claude rc` in this repo"
  const composed = composePrompt("sid", task, "claude")
  const raw = [
    JSON.stringify({ type: "queue-operation", timestamp: "2026-07-01T00:00:00.000Z", operation: "enqueue", content: composed }),
    JSON.stringify({ type: "queue-operation", timestamp: "2026-07-01T00:00:00.100Z", operation: "dequeue", content: composed }),
  ].join("\n")
  const [message] = parseTranscript(raw)
  assert.equal(message.displayText, task)
  assert.equal(message.text, composed) // the raw content stays the queued-bubble map's key
  assert.equal(message.queued, false)
})

// ---- scratchpadOrientation: the SYSTEM-level line is backend-aware ----

test("scratchpadOrientation names the directory, the arming, and one file per sub-agent", () => {
  const claude = scratchpadOrientation("sid", "claude")
  assert.match(claude, /SCRATCH DIRECTORY: \.ntwine\/threads\/sid\//)
  assert.match(claude, /name it in a sub-agent's prompt when you want its notes back, and give each child its own file/)
  assert.equal(scratchpadOrientation("sid"), claude)

  const codex = scratchpadOrientation("sid", "codex")
  assert.match(codex, /native sub-agents share it, so give each its own file/)

  for (const [kind, text] of [["claude", claude], ["codex", codex]] as const) {
    // The post-compaction trigger stays named as an available capability, never a prescription.
    assert.match(text, /`ntwinectl goal start --post-compaction`/, `${kind} must name the trigger`)
    assert.match(text, /Nothing in this directory is read automatically/, `${kind} must not imply an injection`)
    assert.doesNotMatch(text, /merge/i, `${kind} must not reintroduce the merge contract`)
    assert.doesNotMatch(text, /scratch\.md/, `${kind} must not reserve a filename`)
  }
})

// ---- workerScratchPath: relative wherever the board is the worker's cwd, absolute for Home ----

test("workerScratchPath is relative for a registered project and absolute when the board is elsewhere", () => {
  const rel = scratchDirRelPath("sid")
  assert.equal(workerScratchPath({ dir: "/repo" }, "sid"), rel)
  assert.equal(workerScratchPath({ dir: "/repo", workDir: "/repo" }, "sid"), rel)
  // The Home workspace: agents in the home folder, board in the state dir. Relative would name
  // `<home>/.ntwine/threads/…` — the legacy data root.
  assert.equal(workerScratchPath({ dir: "/state/home", workDir: "/home/x" }, "sid"), join("/state/home", rel))
})

test("the scratch path threads into both prompt surfaces, and the default is byte-identical", () => {
  const rel = scratchDirRelPath("sid")
  for (const kind of ["claude", "codex"] as const) {
    // Every registered project's worker is told exactly what it was told before the path became a parameter.
    assert.equal(composePrompt("sid", "task", kind, rel), composePrompt("sid", "task", kind))
    assert.equal(scratchpadOrientation("sid", kind, rel), scratchpadOrientation("sid", kind))

    const abs = join("/state/home", rel)
    assert.ok(composePrompt("sid", "task", kind, abs).includes(`Your scratch directory is \`${abs}/\``), kind)
    assert.ok(scratchpadOrientation("sid", kind, abs).includes(`SCRATCH DIRECTORY: ${abs}/ `), kind)
  }
})

// ---- workerDispatchPermission: the Settings-driven launch mode for a NEW worker ----
// The floor (WORKER_DISPATCH_PERMISSION) keeps an unattended worker out of any mode that could stall it
// on an unanswerable prompt. The ONE deviation Settings can ask for is bypassPermissions on Claude,
// which is strictly more permissive and therefore cannot softlock.

test("workerDispatchPermission: Claude launches at the auto floor unless Settings asks to bypass", () => {
  assert.equal(workerDispatchPermission("claude", { permissionMode: "auto" }), "auto")
  assert.equal(workerDispatchPermission("claude", { permissionMode: "bypassPermissions" }), "bypassPermissions")
  assert.equal(WORKER_DISPATCH_PERMISSION.claude, "auto") // the floor itself is still auto
})

test("workerDispatchPermission: a restrictive stored mode can never reach a Claude spawn", () => {
  // Settings.permissionMode accepts the whole enum (it predates this control), but every mode that
  // would park a headless worker on a modal nobody is watching coerces back to the floor.
  for (const mode of ["default", "acceptEdits", "plan"] as const) {
    assert.equal(workerDispatchPermission("claude", { permissionMode: mode }), "auto")
  }
})

test("workerDispatchPermission: codex ignores the Claude setting and stays at full access", () => {
  // Codex has no permission-mode axis to raise — it already dispatches at danger-full-access, and the
  // Settings control is Claude-only, so neither value may move it.
  assert.equal(workerDispatchPermission("codex", { permissionMode: "auto" }), "bypassPermissions")
  assert.equal(workerDispatchPermission("codex", { permissionMode: "bypassPermissions" }), "bypassPermissions")
})

test("buildClaudeCommand carries bypassPermissions through to --permission-mode", () => {
  // The spawned-CLI fallback transport. (The broker — the default — passes the same mode into the SDK, which
  // additionally sets allowDangerouslySkipPermissions for exactly this value.)
  const argv = buildClaudeCommand({ sessionId: "bypass-dispatch", permissionMode: "bypassPermissions", prompt: "test", workerPrompt: "" })
  assert.deepEqual(
    argv.slice(argv.indexOf("--permission-mode"), argv.indexOf("--permission-mode") + 2),
    ["--permission-mode", "bypassPermissions"],
  )
})
