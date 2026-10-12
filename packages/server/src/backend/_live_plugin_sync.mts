// LIVE END-TO-END: a running worker follows a plugin that MOVED, and nobody asks it to.
//   nub packages/server/src/backend/_live_plugin_sync.mts             the proof
//   nub packages/server/src/backend/_live_plugin_sync.mts --control   the negative control
//
// This is the proof for automatic plugin sync (claude-plugin-sync.ts), and it replaces the probe that
// proved the manual reload it retired. Everything is the shipping thing: a real `claude` broker
// daemon, the real socket protocol, the real staging and repoint (stable-plugin-path.ts), the real SDK
// `Query.reloadPlugins()`, and real agent turns on either side.
//
// The worker is launched against the STABLE path while it leads to plugin v1. With the worker idle,
// v2 is staged and the path repointed — exactly what booting a newer Frizz does — and then a follow-up
// is sent. NOTHING ELSE: no reload request crosses the socket. v2 differs from v1 in three ways, one
// per thing that has to move, and each is constructed so that only the real mechanism can satisfy it:
//
//   • a hook SCRIPT that stamps its version — moved by the link alone, reload or no reload;
//   • a hook REGISTRATION (`Stop`) v1 never had — moved only by a reload;
//   • a SKILL v1 never had, holding a token the agent can only produce by invoking it — moved only
//     by a reload, and required as an INVOCATION, since the token also sits in a file on disk.
//
// Then the OPERATOR's half of the closure, the same way: with the worker idle again, a skill is written
// into the project's own `.claude/skills` and a third message is sent. That skill must be invocable
// too, and — the control again — is not when the sync is off: a live session does not notice a new
// project skill by itself.
//
// The daemon PID is captured on both sides: a restart would also "work", and is exactly the too-blunt
// thing this replaces. And because every live worker now does this unasked, what it COSTS is printed:
// the prompt-cache read of the first request after each reload, beside the same request in the control.
//
// `--control` runs the identical sequence with the sync switched off (FRIZZ_PLUGIN_SYNC_OFF=1) and
// asserts the opposite of the two reload-only results. Without it, "the new skill showed up" could not
// be told apart from "claude picks up plugin edits by itself" — which it does not, as the control shows.
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createClaudeAgentBrokerBridge } from "./claude-agent-broker-bridge.ts"
import { claudeBrokerDiagnosticLogPath } from "./claude-broker-diagnostics.ts"
import { claudeBrokerRecordPath, liveBrokerRecord } from "./claude-broker-host.ts"
import { pluginContentDigest, stageStablePluginDir } from "../stable-plugin-path.ts"

const control = process.argv.includes("--control")
// The daemon is forked with this process's environment, which is how the opt-out reaches it in
// production too (set where Frizz is started).
if (control) process.env.FRIZZ_PLUGIN_SYNC_OFF = "1"
else delete process.env.FRIZZ_PLUGIN_SYNC_OFF

const TOKEN = `SYNC-SENTINEL-${randomUUID().slice(0, 8).toUpperCase()}`
const OPERATOR_TOKEN = `OPERATOR-SENTINEL-${randomUUID().slice(0, 8).toUpperCase()}`
const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "psync-state-")))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "psync-repo-")))
execFileSync("git", ["init", "-q", cwd])
const sessionId = randomUUID()
const marksPath = join(stateDir, "hook-marks.jsonl")
// Staged under this probe's own roots, never the machine's: the real stable path is what every live
// worker on this machine runs its hooks through.
const roots = { stageRoot: join(stateDir, "cache", "plugins"), stableRoot: join(stateDir, "cache", "current") }

/** One version of the plugin, as an artifact would carry it at its own immutable path. */
function pluginVersion(version: "v1" | "v2"): string {
  const dir = join(stateDir, `generation-${version}`, "runtime", "cc-worker")
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true })
  mkdirSync(join(dir, "hooks"), { recursive: true })
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "sync-probe", version: "0.0.1" }) + "\n")
  // Stamps WHICH copy ran and for which event. The version is baked into the script, so the stamp
  // says which directory the hook command resolved to at the moment it fired.
  writeFileSync(join(dir, "hooks", "mark.mjs"), [
    `import { appendFileSync } from "node:fs"`,
    `let input = ""`,
    `process.stdin.on("data", (chunk) => { input += chunk })`,
    `process.stdin.on("end", () => {`,
    `  let event = "unknown"`,
    `  try { event = JSON.parse(input).hook_event_name ?? event } catch { /* a stamp is still worth having */ }`,
    `  appendFileSync(${JSON.stringify(marksPath)}, JSON.stringify({ version: ${JSON.stringify(version)}, event }) + "\\n")`,
    `})`,
  ].join("\n") + "\n")
  const mark = { hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/mark.mjs"' }] }
  writeFileSync(join(dir, "hooks", "hooks.json"), JSON.stringify({
    hooks: { UserPromptSubmit: [mark], ...(version === "v2" ? { Stop: [mark] } : {}) },
  }, null, 2) + "\n")
  if (version === "v2") {
    mkdirSync(join(dir, "skills", "sync-probe-skill"), { recursive: true })
    writeFileSync(join(dir, "skills", "sync-probe-skill", "SKILL.md"), [
      "---",
      "name: sync-probe-skill",
      "description: A probe skill that exists only in the plugin's second version; used to prove an automatic reload.",
      "---",
      "",
      `The sync probe token is ${TOKEN}.`,
    ].join("\n"))
  }
  return dir
}
const publish = (source: string) => stageStablePluginDir({ source, version: pluginContentDigest(source), ...roots })

let failures = 0
const ok = (label: string, cond: boolean, detail = ""): void => {
  if (!cond) failures++
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const daemonPid = (): number | null => liveBrokerRecord(claudeBrokerRecordPath(stateDir, sessionId))?.daemonPid ?? null
const marks = (): Array<{ version: string; event: string }> =>
  existsSync(marksPath) ? readFileSync(marksPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []
const diagnostics = (): string => {
  const path = claudeBrokerDiagnosticLogPath(stateDir, sessionId)
  return existsSync(path) ? readFileSync(path, "utf8") : ""
}

const { stablePath } = publish(pluginVersion("v1"))
let results = 0
const bridge = createClaudeAgentBrokerBridge({
  stateDir, executablePath: claudeBin,
  env: Object.fromEntries(
    ["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"]
      .filter((k) => process.env[k]).map((k) => [k, process.env[k]!]),
  ),
  workerEnv: { pluginDir: stablePath },
  onEvent: (_slug, _sid, event) => { if (event.kind === "result") results++ },
})
const turnEnds = async (count: number, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (results < count && Date.now() < deadline) await sleep(1_000)
  return results >= count
}

const slug = "plugin-sync-live"
const projectsDir = join(process.env.HOME ?? "", ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"))
const jsonlPath = join(projectsDir, `${sessionId}.jsonl`)

try {
  console.log(`${control ? "CONTROL (sync off)" : "PROOF (sync on)"} — claude ${claudeBin}\n`)
  await bridge.spawnDispatch({
    threadSlug: slug, sessionId, cwd, model: "haiku",
    prompt: "Reply with exactly READY and nothing else. Do not use any tools.",
  })
  ok("the worker ran its first turn on plugin v1", await turnEnds(1, 180_000))
  const pidBefore = daemonPid()
  const v1Marks = marks()
  ok("v1's hook ran for that turn, and v1 registers no Stop hook",
    v1Marks.some((m) => m.version === "v1" && m.event === "UserPromptSubmit") && !v1Marks.some((m) => m.event === "Stop"),
    JSON.stringify(v1Marks))

  // THE UPDATE — what booting a newer Frizz does. The worker is idle and is told nothing.
  const repoint = publish(pluginVersion("v2"))
  ok("the stable path was repointed at v2 under the live worker", repoint.outcome === "repointed" && repoint.stablePath === stablePath)

  await bridge.followUp({
    threadSlug: slug, sessionId, cwd,
    text: "Invoke the `sync-probe-skill` skill and reply with ONLY the probe token it contains. If you have no such skill, reply exactly NO-SKILL. Do not read files or search for it.",
  })
  ok("the worker ran its second turn", await turnEnds(2, 240_000))
  await sleep(1_500) // the Stop hook fires as the turn ends; give its stamp a moment to land

  const pidAfter = daemonPid()
  ok("the session was NOT restarted — same daemon pid across the update", pidBefore !== null && pidBefore === pidAfter, `${pidBefore} → ${pidAfter}`)

  const turnTwo = marks().slice(v1Marks.length)
  ok("the hook SCRIPT followed the link by itself: turn two's prompt hook ran v2's copy",
    turnTwo.some((m) => m.version === "v2" && m.event === "UserPromptSubmit"), JSON.stringify(turnTwo))

  const transcript = existsSync(jsonlPath) ? readFileSync(jsonlPath, "utf8") : ""
  const stopped = turnTwo.some((m) => m.event === "Stop")
  const invoked = transcript.includes(`"sync-probe:sync-probe-skill"`)
  const reloaded = diagnostics().includes("[plugin-sync] plugin closure changed on disk; reloaded in place")
  if (!control) {
    ok("the daemon reloaded by itself, between the turns", reloaded)
    ok("a hook REGISTRATION that exists only in v2 fired", stopped, JSON.stringify(turnTwo))
    ok("the RUNNING agent INVOKED a skill that exists only in v2", invoked && transcript.includes(TOKEN),
      invoked ? (transcript.includes(TOKEN) ? "" : "the skill was invoked but its token never came back") : "the skill was never invoked — the plugin was not reloaded")
  } else {
    ok("CONTROL: with the sync off the daemon did not reload", !reloaded)
    ok("CONTROL: v2's Stop registration never fired — claude does not re-read a plugin by itself", !stopped, JSON.stringify(turnTwo))
    ok("CONTROL: and the agent could not invoke v2's skill", !invoked)
  }

  // THE OPERATOR'S EDIT — a skill added to the project while the worker rests. Again nothing is asked.
  mkdirSync(join(cwd, ".claude", "skills", "operator-probe-skill"), { recursive: true })
  writeFileSync(join(cwd, ".claude", "skills", "operator-probe-skill", "SKILL.md"), [
    "---",
    "name: operator-probe-skill",
    "description: A probe skill the operator added to the project after the session started.",
    "---",
    "",
    `The operator probe token is ${OPERATOR_TOKEN}.`,
  ].join("\n"))
  await bridge.followUp({
    threadSlug: slug, sessionId, cwd,
    text: "Invoke the `operator-probe-skill` skill and reply with ONLY the probe token it contains. If you have no such skill, reply exactly NO-SKILL. Do not read files or search for it.",
  })
  ok("the worker ran its third turn", await turnEnds(3, 240_000))
  const after = existsSync(jsonlPath) ? readFileSync(jsonlPath, "utf8") : ""
  const operatorInvoked = after.includes(`"operator-probe-skill"`) && after.includes(OPERATOR_TOKEN) && after.slice(transcript.length).includes(`"name":"Skill"`)
  if (!control) ok("the RUNNING agent INVOKED a skill the operator added to the project mid-session", operatorInvoked)
  else ok("CONTROL: a live session does not notice a new project skill by itself", !operatorInvoked)
  ok("still the same daemon", daemonPid() === pidBefore, `${pidBefore} → ${daemonPid()}`)

  // What a reload costs the conversation's prompt cache: the first request of each later turn.
  const usage = after.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } })
    .filter((record) => record?.type === "assistant" && record.message?.usage)
    .map((record) => record.message.usage)
  console.log(`\nprompt cache, one line per model request (read / written / uncached input tokens):`)
  for (const [index, u] of usage.entries()) console.log(`  request ${index + 1}: ${u.cache_read_input_tokens ?? 0} / ${u.cache_creation_input_tokens ?? 0} / ${u.input_tokens ?? 0}`)

  console.log(`\nstable path ${stablePath}`)
  console.log(`token       ${TOKEN}`)
} finally {
  try { bridge.releaseSession(slug, sessionId, "session-deleted") } catch { /* ignore */ }
  try { bridge.close() } catch { /* ignore */ }
  await sleep(1_000)
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
  // The transcript this probe's own throwaway session wrote under the real ~/.claude.
  if (projectsDir.includes("psync-repo-")) rmSync(projectsDir, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
