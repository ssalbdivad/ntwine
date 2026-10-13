// LIVE end-to-end test of the CONTEXT METER's denominator across a ntwine restart:
//   real claude → broker daemon → socket → bridge.onEvent → ingest.contextWindow → tailer state.
//   nub packages/server/src/backend/_live_broker_context_window.mts
//
// The window rides ONE frame — `result.modelUsage` — and picking this thread's row out of it needs the
// resolved model alias, which only `init` names (claude-runtime-ingest.ts pickWindow). Real claude
// re-emits `init` at the start of EVERY turn, but the SDK wrapper used to swallow every re-init, so the
// alias was announced exactly once per DAEMON lifetime — to whichever ntwine process happened to be
// attached at that moment. A broker daemon OUTLIVES the ntwine server, so after a restart the reattached
// thread could never relearn it and its context dial never came back, however long it kept working.
// Measured on the maintainer's board before the fix: 42 of 323 claude threads carried a reading, split
// exactly on which ntwine process had forked the daemon.
//
// So the shape here is the restart itself: fork a daemon, run a turn, DROP the bridge and the ingest
// while leaving the daemon alive, build fresh ones (what a restarted ntwine does), follow up, and demand
// the reading come back. The second half of this harness fails on the pre-fix wrapper.
import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createClaudeAgentBrokerBridge, type ClaudeAgentBrokerBridge } from "./claude-agent-broker-bridge.ts"
import { createClaudeRuntimeIngest, type ClaudeRuntimeIngest } from "./claude-runtime-ingest.ts"
import { createTailer, defaultLogDir, type Tailer } from "../tailer.ts"
import { createStorage } from "../storage.ts"
import { createClaudeBackend } from "./claude.ts"
import { Bus } from "../bus.ts"
import { cwdSlug, type Project } from "../project.ts"
import type { AgentBackend } from "./types.ts"

const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const stateDir = mkdtempSync(join(tmpdir(), "bctx-state-"))
// REALPATH: claude slugifies the RESOLVED cwd, so a /var/folders temp dir lands under
// -private-var-folders-…; skipping it points the tailer at an empty log dir (see _live_broker_ingest).
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "bctx-repo-"))); execFileSync("git", ["init", "-q", cwd])
let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }

const project: Project = { dir: cwd, id: "live", name: "live", label: "o/live", stateDir, cwdSlug: cwdSlug(cwd) }
const storage = createStorage(join(stateDir, "ui.db"), "p")
const claudeBackend = createClaudeBackend({ claudeBin, logDir: defaultLogDir(project) })
const backendFor = (kind?: string): AgentBackend => claudeBackend

const slug = "ctx-live"
const sessionId = randomUUID()
const env = Object.fromEntries(
  ["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"]
    .filter((k) => process.env[k]).map((k) => [k, process.env[k]!]),
)

/** One ntwine generation: a bridge, its ingest, and the tailer that reads the window off it. */
function generation(label: string) {
  const kinds: string[] = []
  let tailer!: Tailer
  const ingest: ClaudeRuntimeIngest = createClaudeRuntimeIngest({ nudge: () => { try { tailer.nudge?.() } catch {} } })
  const bridge: ClaudeAgentBrokerBridge = createClaudeAgentBrokerBridge({
    stateDir, executablePath: claudeBin, env,
    onEvent: (s, sid, event) => { kinds.push(event.kind); ingest.onEvent(s, sid, event) },
  })
  tailer = createTailer({
    project, storage, bus: new Bus(), backendFor,
    onChange: () => {},
    paneDead: () => false,
    runtimeLiveness: (sid) => ingest.liveness(sid),
    runtimeContextWindow: (sid) => ingest.contextWindow(sid),
  })
  const settled = async (deadlineMs = 240_000) => {
    const deadline = Date.now() + deadlineMs
    while (ingest.liveness(sessionId)?.turn !== "settled" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
    // One more beat so the settling nudge's tick has folded before we read the tail.
    await new Promise((r) => setTimeout(r, 400))
    tailer.tick()
    return ingest.liveness(sessionId)?.turn === "settled"
  }
  const close = () => { try { bridge.close() } catch {} ; try { ingest.close() } catch {} ; try { tailer.stop() } catch {} }
  return { label, kinds, ingest, bridge, tailer, settled, close }
}

let first: ReturnType<typeof generation> | undefined
let second: ReturnType<typeof generation> | undefined
try {
  storage.upsertSession({
    slug, session_id: sessionId, thread_name: `ntwine-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  })
  storage.setBackend(slug, "claude")
  storage.setClaudeRuntime(slug, "broker")

  // ── generation 1: the ntwine that FORKS the daemon ────────────────────────────────────────────────
  first = generation("gen1")
  first.tailer.tick() // prime
  await first.bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd, prompt: "Reply with exactly LIVE-OK then stop. Do not use any tools." })
  ok("gen1: the turn settled", await first.settled())
  ok("gen1: saw the session init", first.kinds.includes("init"), first.kinds.join(","))
  const w1 = first.ingest.contextWindow(sessionId)
  ok("gen1: latched a context window", typeof w1 === "number" && w1 > 0, `window=${w1}`)
  ok("gen1: it reached the tail state", (first.tailer.get(slug)?.contextWindow ?? 0) > 0, `tail=${first.tailer.get(slug)?.contextWindow}`)
  ok("gen1: the numerator is on disk too", (first.tailer.get(slug)?.contextTokens ?? 0) > 0, `tokens=${first.tailer.get(slug)?.contextTokens}`)

  // ── the restart: drop every in-memory reading, leave the daemon running ─────────────────────────
  first.close()
  first = undefined

  // ── generation 2: the ntwine that REATTACHES ──────────────────────────────────────────────────────
  second = generation("gen2")
  second.tailer.tick() // prime — a fresh process re-derives the fold from the transcript
  await second.bridge.followUp({ threadSlug: slug, sessionId, cwd, text: "Reply with exactly LIVE-TWO then stop. Do not use any tools." })
  ok("gen2: the turn settled", await second.settled())
  // THE REGRESSION. Pre-fix this is false: the daemon's handle had already emitted its one init to the
  // process that is now gone, and every later re-init was swallowed inside the wrapper.
  ok("gen2: the reattached ntwine was told the model (per-turn re-init)", second.kinds.includes("init"), second.kinds.join(","))
  const w2 = second.ingest.contextWindow(sessionId)
  ok("gen2: the context window came back after the restart", typeof w2 === "number" && w2 > 0, `window=${w2}`)
  ok("gen2: it reached the tail state", (second.tailer.get(slug)?.contextWindow ?? 0) > 0, `tail=${second.tailer.get(slug)?.contextWindow}`)
  ok("gen2: same window as before the restart", w1 === w2, `${w1} vs ${w2}`)
} catch (e) {
  failures++
  console.log("FAIL  harness threw —", e)
} finally {
  try { second?.bridge.releaseSession(slug, sessionId, "session-deleted") } catch {}
  first?.close()
  second?.close()
  try { storage.close() } catch {}
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
