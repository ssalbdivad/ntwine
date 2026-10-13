// LIVE PROBE: does a REAL ACP agent's turn survive the bridge going away, through the detached daemon?
//   nub packages/server/src/backend/_live_acp_daemon_restart.mts [agentId]     default: opencode
//
// Bridge A dispatches a prompt whose tool call takes ~20s, is shut down mid-turn (exactly what a Ntwine
// restart does to it), and bridge B — a fresh instance over the same state dir — warms up, adopts the
// turn and records its ending. Any permission card the agent raises is answered `accept` here.
// Exit 0 only when B saw the turn live, the turn ended successfully with the sentinel, and the daemon
// generation never changed.
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "../sqlite.ts"
import { createInteractionStore } from "../interaction-store.ts"
import { createAcpBridge, type AcpBridge } from "./acp-bridge.ts"
import { acpTranscriptPath, parseAcpRecord, type AcpRecord } from "./acp-transcript.ts"
import { liveAcpDaemonRecord, stopAcpDaemon } from "./acp-host.ts"

const agentId = process.argv[2] ?? "opencode"
const stateDir = mkdtempSync(join(tmpdir(), "acp-daemon-live-"))
const cwd = mkdtempSync(join(tmpdir(), "acp-daemon-live-repo-"))
const t0 = Date.now()
const at = (): string => `t+${String(Date.now() - t0).padStart(6)}ms`
let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const scope = { projectId: "live", threadSlug: "t1", sessionId: "s1" }

function bridge(label: string): { bridge: AcpBridge; store: ReturnType<typeof createInteractionStore> } {
  const store = createInteractionStore(new Database(":memory:"))
  const b = createAcpBridge({
    projectId: "live", stateDir, interactions: store, env: process.env,
    onDiagnostic: (d) => { if (d.kind !== "stderr") console.log(`DIAG  ${at()} ${label} ${d.kind}: ${d.message.slice(0, 160)}`) },
    onStatusChange: () => console.log(`STATE ${at()} ${label} turnActive=${b.turnLiveness("t1", "s1")?.turnActive}`),
    flushMs: 200,
  })
  // Answer every card the agent raises with accept, so a permission never wedges the probe.
  store.subscribe(() => {
    for (const card of store.listPending(scope)) {
      console.log(`CARD  ${at()} ${label} ${card.payload.kind} → accept`)
      store.resolve(scope, { slug: "t1", sessionId: "s1", interactionId: card.id, sessionEpoch: card.owner.sessionEpoch, capabilityRevision: card.owner.capabilityRevision, expectedRecordRevision: card.recordRevision, responseId: `r-${card.id}`, decisionId: "accept" })
    }
  })
  return { bridge: b, store }
}
const records = (): AcpRecord[] => { try { return readFileSync(acpTranscriptPath(stateDir, "s1"), "utf8").split("\n").map(parseAcpRecord).filter((x): x is AcpRecord => x !== undefined) } catch { return [] } }
const waitFor = async (pred: () => boolean, ms: number, what: string): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (!pred()) { if (Date.now() > deadline) { console.log(`WAIT  ${at()} TIMEOUT waiting for ${what}`); return false }; await sleep(50) }
  return true
}

const a = bridge("A")
let b: ReturnType<typeof bridge> | undefined
try {
  const prompt = "Use your bash tool to run exactly this command and wait for it: `sleep 20 && echo SENTINEL-7731`. Then reply with the single word SENTINEL-7731 and nothing else."
  console.log(`SEND  ${at()} A dispatch (${agentId})`)
  await a.bridge.spawnDispatch({ threadSlug: "t1", sessionId: "s1", cwd, agentId, prompt, userText: prompt })
  await waitFor(() => a.bridge.turnLiveness("t1", "s1")?.turnActive === true, 30_000, "the turn to start")
  await waitFor(() => records().some((r) => r.kind === "tool-call"), 60_000, "the agent's first tool call")
  await sleep(2_000)
  const before = liveAcpDaemonRecord(stateDir, "s1")
  ok("a daemon holds the agent", before !== null)
  console.log(`STOP  ${at()} A shutdown (the restart)`)
  await a.bridge.shutdown()
  ok("shutting down did not end the turn in the transcript", !records().some((r) => r.kind === "turn-end"))
  ok("the daemon is still running", liveAcpDaemonRecord(stateDir, "s1") !== null)

  b = bridge("B")
  console.log(`OPEN  ${at()} B warmUp`)
  await b.bridge.warmUp([{ threadSlug: "t1", sessionId: "s1", cwd, agentId }])
  ok("B sees the turn as live right after reattaching", b.bridge.turnLiveness("t1", "s1")?.turnActive === true)
  await waitFor(() => b!.bridge.turnLiveness("t1", "s1")?.turnActive === false, 120_000, "the turn to end under B")
  const recs = records()
  const ends = recs.filter((r) => r.kind === "turn-end") as Array<{ successful: boolean; finalText?: string }>
  ok("exactly one turn-start and one turn-end", recs.filter((r) => r.kind === "turn-start").length === 1 && ends.length === 1, `${recs.filter((r) => r.kind === "turn-start").length}/${ends.length}`)
  ok("the turn ended successfully with the sentinel", ends[0]?.successful === true && /SENTINEL-7731/.test(ends[0]?.finalText ?? ""), JSON.stringify(ends[0]?.finalText ?? "").slice(0, 120))
  ok("no provider-error", !recs.some((r) => r.kind === "provider-error"))
  ok("the agent process never changed", liveAcpDaemonRecord(stateDir, "s1")?.generation === before?.generation)
  console.log("\nTRANSCRIPT KINDS:", recs.map((r) => r.kind).join(" "))
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
} catch (err) {
  console.log(`ERROR ${err instanceof Error ? err.stack : String(err)}`)
  failures++
} finally {
  try { await a.bridge.shutdown() } catch {}
  try { await b?.bridge.shutdown() } catch {}
  await stopAcpDaemon(stateDir, "s1")
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}
process.exit(failures === 0 ? 0 : 1)
