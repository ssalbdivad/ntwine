// LIVE DEPTH-2 STEER PROBE: can a GRANDCHILD — a sub-agent dispatched by a sub-agent — be steered?
//
//   nub packages/server/src/backend/_live_broker_steer_depth.mts
//
// WHY THIS EXISTS. `subAgentSteerable` (router.ts) refuses any non-DIRECT child with "this one belongs
// to another agent", and the comment beside it explains the refusal as a protocol limit: "the CLI only
// knows tool_use ids its own main thread issued". That sentence was never MEASURED. `_live_broker_steer`
// proves depth-1 routing works; `_live_broker_depth` proves the on-disk tree describes grandchildren.
// Neither ever sent an input frame addressed to a grandchild's dispatch id. This does.
//
// The steer frame is `{ text, parent_tool_use_id }` and it goes to the ONE top-level claude process,
// which also hosts every descendant (sub-agents are in-process tasks, not separate processes). So the
// routing table plausibly does know the grandchild's id — but the id was minted inside the CHILD's
// turn, and whether the top-level input router indexes it is exactly the open question.
//
// THREE outcomes, and they must be told apart — a file alone cannot do it, since a misdelivered steer
// makes the MAIN thread run the same command:
//   (a) the GRANDCHILD received it as a DELIVERED INPUT       → routing works at depth; gate is
//       over-conservative and can be relaxed.
//   (b) the ROOT main thread received it as a delivered input → MISDELIVERY, the exact failure the
//       gate exists to prevent. Gate stays.
//   (c) nobody received it                                    → silently dropped. Gate stays.
//
// ── RESULT (2026-07-30, first run): (b). THE GATE IS CORRECT. ────────────────────────────────────
// An input frame carrying a grandchild's dispatch id is NOT routed to the grandchild. The unknown
// `parent_tool_use_id` is silently ignored and the frame falls through to the top-level session's MAIN
// thread, which received it as `{"type":"user","promptSource":"sdk"}` — the same delivery an ordinary
// unaddressed follow-up gets. So the comment beside `subAgentSteerable` ("the CLI only knows tool_use
// ids its own main thread issued") is right, and steering a descendant would hijack the WORKER's turn.
//
// MEASURE DELIVERY, NOT MEMBERSHIP — this is the trap, and the first version of this probe fell in it.
// The token reached the grandchild's transcript anyway and the side-effect file appeared, so a
// membership check reported "landed on GRANDCHILD" and PASSED. It got there because the ROOT MODEL READ
// the misdelivered steer, understood it, and VOLUNTARILY relayed it down with `SendMessage` — root →
// child → grandchild, two model-chosen hops. That is a model being helpful, not a transport routing a
// frame, and it is not something a steer may rely on. The verdict below therefore keys on how each
// transcript RECEIVED the text (an SDK-delivered user turn vs. a SendMessage relay), never on whether
// the bytes are present.
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createClaudeAgentBrokerBridge } from "./claude-agent-broker-bridge.ts"
import { createClaudeRuntimeIngest } from "./claude-runtime-ingest.ts"
import { createTailer, defaultLogDir, type Tailer } from "../tailer.ts"
import { createStorage } from "../storage.ts"
import { createClaudeBackend } from "./claude.ts"
import { Bus } from "../bus.ts"
import { cwdSlug, type Project } from "../project.ts"
import type { AgentBackend } from "./types.ts"

const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const stateDir = mkdtempSync(join(tmpdir(), "steerd-state-"))
// REALPATH: claude slugifies the RESOLVED cwd (see _live_broker_steer).
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "steerd-repo-")))
execFileSync("git", ["init", "-q", cwd])

const GRAND_TOKEN = "GRANDSTEER5501"
const grandFile = join(cwd, "grand-obeyed.txt")

let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const el = () => `t+${Math.round((Date.now() - t0) / 1000)}s`

const project: Project = { dir: cwd, id: "live", name: "live", label: "o/live", stateDir, cwdSlug: cwdSlug(cwd) }
const storage = createStorage(join(stateDir, "ui.db"), "p")
const claudeBackend = createClaudeBackend({ claudeBin, logDir: defaultLogDir(project) })
const backendFor = (_kind?: string): AgentBackend => claudeBackend

let tailer!: Tailer
const ingest = createClaudeRuntimeIngest({ nudge: () => { try { tailer.nudge?.() } catch { /* ignore */ } } })
const bridge = createClaudeAgentBrokerBridge({
  stateDir, executablePath: claudeBin,
  env: Object.fromEntries(["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"].filter((k) => process.env[k]).map((k) => [k, process.env[k]!])),
  onEvent: (slug, sessionId, event) => ingest.onEvent(slug, sessionId, event),
})
tailer = createTailer({
  project, storage, bus: new Bus(), backendFor,
  onChange: () => {}, paneDead: () => false,
  runtimeLiveness: (sessionId) => ingest.liveness(sessionId),
  runtimeTasks: (sessionId) => ingest.tasks(sessionId),
})

const slug = "steer-depth-live"
const sessionId = randomUUID()

// Single-quoted inner prompts, so three levels of instruction nest without escaping games.
const GRAND_TASK = "Repeat 20 times: run the Bash command `date`, then run `sleep 4`. If you receive a NEW message while working, obey it immediately before continuing the loop. When the loop finishes, reply DONE."
const CHILD_TASK = `Use the Agent tool ONCE with subagent_type 'general-purpose' and run_in_background true, description 'steer target', prompt: '${GRAND_TASK}'. After dispatching it, do NOT wait for it and do NOT dispatch anything else — reply 'dispatched' and stop.`
const PROMPT = `Use the Agent tool ONCE with subagent_type 'general-purpose' and run_in_background true, description 'level one', prompt: '${CHILD_TASK}'. After dispatching it, do NOT wait for it and do NOT dispatch anything else — reply 'dispatched' and stop.`

try {
  await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd, prompt: PROMPT })
  storage.upsertSession({
    slug, session_id: sessionId, thread_name: `ntwine-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  } as never)
  storage.setBackend(slug, "claude")
  storage.setClaudeRuntime(slug, "broker")
  tailer.tick()

  // ---- wait for the tailer to surface a live DEPTH-2 descendant (the row the gate refuses) ----
  let grandId: string | undefined
  const findDeadline = Date.now() + 300_000
  while (Date.now() < findDeadline) {
    tailer.tick()
    const rows = tailer.get(slug)?.subAgents ?? []
    const grand = rows.find((v) => (v.depth ?? 1) >= 2 && v.state === "running" && v.id)
    if (grand?.id) {
      const info = tailer.subAgent(slug, grand.id)
      // The gate's own reading: resolvable, running, and NOT direct — i.e. exactly what it refuses.
      console.log(`${el()} descendant row: id=${grand.id} depth=${grand.depth} direct=${info?.direct} state=${info?.state}`)
      if (info && !info.direct) { grandId = grand.id; break }
    }
    await sleep(2_000)
  }
  ok("a live DEPTH-2 descendant appeared to aim at", Boolean(grandId), grandId ?? "none")
  if (!grandId) throw new Error("no grandchild appeared")

  await sleep(6_000) // let it get into its loop, so the steer lands mid-work
  console.log(`${el()} steering GRANDCHILD ${grandId} (bypassing the router gate, calling the bridge directly)`)
  await bridge.steerSubAgent({
    threadSlug: slug, sessionId, subAgentId: grandId,
    text: `${GRAND_TOKEN}: stop the loop right now and run this Bash command immediately: echo ${GRAND_TOKEN} > ${grandFile}`,
  })
  console.log(`${el()} steer sent`)

  const effectDeadline = Date.now() + 180_000
  while (Date.now() < effectDeadline && !existsSync(grandFile)) { tailer.tick(); await sleep(2_000) }
  console.log(`\n${el()} side effect: ${grandFile}: ${existsSync(grandFile) ? readFileSync(grandFile, "utf8").trim() : "absent"}`)

  // ---- THE VERDICT: which transcript actually received the token? ----
  const projects = join(process.env.HOME!, ".claude", "projects")
  const dirs = readdirSync(projects).filter((d) => d.includes(cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/^-/, "")))
  const walk = (p: string, depth = 0): string[] => {
    if (depth > 3) return []
    const out: string[] = []
    for (const entry of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, entry.name)
      if (entry.isDirectory()) out.push(...walk(full, depth + 1))
      else if (entry.name.endsWith(".jsonl")) out.push(full)
    }
    return out
  }
  // A DELIVERY is a `user` record whose content IS the steer text — the shape the SDK writes when it
  // hands an input frame to a turn. Anything else carrying the token (a SendMessage tool_use relaying
  // it, a task-notification quoting it back, the queue-operation bookkeeping) is NOT a delivery, and
  // counting it as one is what made the first version of this probe pass on a misdelivery.
  const deliveredTo: string[] = []
  console.log("\n  --- how each transcript RECEIVED the token ---")
  for (const dir of dirs) {
    for (const file of walk(join(projects, dir))) {
      const body = readFileSync(file, "utf8")
      if (!body.includes(GRAND_TOKEN)) continue
      const agentId = /agent-(.+)\.jsonl$/.exec(file)?.[1]
      let depth: number | undefined
      if (agentId) {
        try { depth = JSON.parse(readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf8")).spawnDepth } catch { /* unknown */ }
      }
      const who = agentId ? `AGENT ${agentId} (spawnDepth ${depth ?? "?"})` : "ROOT main thread"
      for (const line of body.split("\n").filter(Boolean)) {
        if (!line.includes(GRAND_TOKEN)) continue
        let rec: { type?: string; promptSource?: string; message?: { role?: string; content?: unknown } }
        try { rec = JSON.parse(line) } catch { continue }
        const content = rec.message?.content
        // A delivered turn's content is a bare string on some harness versions and text BLOCKS on
        // others. Match both — keying on the string form alone silently UNDER-reports deliveries,
        // which would flip a misdelivery back into a false pass from the other direction.
        const text = typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : "")).join("\n")
            : ""
        const isDelivery = rec.type === "user" && text.includes(GRAND_TOKEN)
        const relayed = JSON.stringify(content ?? "").includes("SendMessage")
        console.log(`  ${who}: type=${rec.type} role=${rec.message?.role ?? "-"} promptSource=${rec.promptSource ?? "-"} DELIVERED=${isDelivery} relay=${relayed}`)
        if (isDelivery) deliveredTo.push(who)
      }
      console.log(`     ${file.replace(projects, "…")} (${statSync(file).size}B)`)
    }
  }
  const grandGotIt = deliveredTo.some((w) => /spawnDepth 2/.test(w))
  const rootGotIt = deliveredTo.some((w) => w.startsWith("ROOT"))
  console.log(`\n  VERDICT: delivered to → ${deliveredTo.length ? deliveredTo.join(" AND ") : "nobody"}`)
  ok("the steer was NOT misdelivered to the thread's main turn", !rootGotIt,
    rootGotIt ? "the root main thread received it as an SDK input — this is the hijack the gate prevents" : "")
  ok("a grandchild CAN be addressed — the steer was DELIVERED to the depth-2 agent", grandGotIt,
    grandGotIt ? "" : "no depth-2 delivery; any token in its transcript arrived by model-chosen SendMessage relay")
} finally {
  bridge.releaseSession(slug, sessionId, "session-deleted")
  bridge.close()
  tailer.stop?.()
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}  (stateDir ${stateDir}, cwd ${cwd})`)
}
process.exit(failures === 0 ? 0 : 1)
