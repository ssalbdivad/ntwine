// What actually happens to a BLOCKED native AskUserQuestion when things go wrong, against real claude:
//   nub packages/server/src/backend/_live_broker_ask_mechanics.mts
//
// This exists to settle the fence-vs-native question on evidence rather than intuition. Now that a
// fence question and a native one render through the same component and read identically, the only
// difference left is MECHANICS: a native ask BLOCKS the turn and holds a live session, a fence ENDS the
// turn and hands off. So the question is what that blocked turn survives.
//
// Three scenarios, each measured rather than assumed:
//   1. NTWINE RESTARTS while the question is open. The daemon is detached, so it outlives ntwine; on
//      reconnect it re-delivers the pending permission. Does a NEW ntwine re-bind and can the operator
//      still answer?
//   2. THE DAEMON DIES while the question is open. Is the interaction answerable afterwards, and what
//      is left in the transcript?
//   3. NOBODY ANSWERS. Is the session still sitting there holding its context?
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import Database from "../sqlite.ts"
import { createInteractionStore } from "../interaction-store.ts"
import { createClaudeAgentBrokerBridge } from "./claude-agent-broker-bridge.ts"
import { claudeBrokerRecordPath, readBrokerRecord } from "./claude-broker-host.ts"
import type { InteractionRecord } from "@ntwine/shared"

const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const stateDir = mkdtempSync(join(tmpdir(), "askmech-state-"))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "askmech-repo-"))); execFileSync("git", ["init", "-q", cwd])
const db = new Database(join(stateDir, "ui.db")); db.pragma("journal_mode = WAL")
const interactions = createInteractionStore(db)
const projectId = "askmech"
const env = Object.fromEntries(["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"].filter((k) => process.env[k]).map((k) => [k, process.env[k]!]))

let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }
const note = (label: string, detail: string) => console.log(`INFO  ${label} — ${detail}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const newBridge = () => createClaudeAgentBrokerBridge({ stateDir, executablePath: claudeBin, interactions, projectId, env })

const ASK = (question: string, header: string, a: string, b: string, tail: string) =>
  `Use the AskUserQuestion tool RIGHT NOW, before anything else, with exactly one question: question "${question}", ` +
  `header "${header}", options label "${a}" (description "one") and label "${b}" (description "two"). ` +
  `Do not use any other tool first. ${tail}`

function transcriptText(sessionId: string): string {
  const base = join(homedir(), ".claude", "projects")
  if (!existsSync(base)) return ""
  for (const dir of readdirSync(base)) {
    const file = join(base, dir, `${sessionId}.jsonl`)
    if (existsSync(file)) { try { return readFileSync(file, "utf8") } catch { return "" } }
  }
  return ""
}

function assistantText(sessionId: string): string {
  const out: string[] = []
  for (const line of transcriptText(sessionId).split("\n")) {
    if (!line.trim()) continue
    let record: { type?: string; message?: { content?: unknown } }
    try { record = JSON.parse(line) } catch { continue }
    if (record.type !== "assistant" || !Array.isArray(record.message?.content)) continue
    for (const block of record.message.content as Array<{ type?: string; text?: string }>) {
      if (block?.type === "text" && typeof block.text === "string") out.push(block.text)
    }
  }
  return out.join("\n")
}

/** Every AskUserQuestion tool_use in the transcript that has NO tool_result — a turn left mid-tool-call. */
function danglingToolUses(sessionId: string): string[] {
  const uses = new Set<string>(), results = new Set<string>()
  for (const line of transcriptText(sessionId).split("\n")) {
    if (!line.trim()) continue
    let record: { message?: { content?: unknown } }
    try { record = JSON.parse(line) } catch { continue }
    if (!Array.isArray(record.message?.content)) continue
    for (const block of record.message.content as Array<{ type?: string; name?: string; id?: string; tool_use_id?: string }>) {
      if (block?.type === "tool_use" && block.name === "AskUserQuestion" && block.id) uses.add(block.id)
      if (block?.type === "tool_result" && block.tool_use_id) results.add(block.tool_use_id)
    }
  }
  return [...uses].filter((id) => !results.has(id))
}

async function waitForQuestion(scope: { projectId: string; threadSlug: string; sessionId: string }, timeoutMs = 180_000): Promise<InteractionRecord | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pending = interactions.listPending(scope)
    if (pending.length > 0) return pending[0]
    await sleep(1_000)
  }
  return undefined
}

function answer(scope: { projectId: string; threadSlug: string; sessionId: string }, record: InteractionRecord, values: Record<string, string>) {
  return interactions.resolve(scope, {
    slug: scope.threadSlug, sessionId: scope.sessionId, interactionId: record.id,
    sessionEpoch: record.owner.sessionEpoch, capabilityRevision: record.owner.capabilityRevision,
    expectedRecordRevision: record.recordRevision, responseId: randomUUID(), decisionId: "answer", values,
  })
}

async function waitForReply(sessionId: string, needle: string, timeoutMs = 180_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (assistantText(sessionId).includes(needle)) return true
    await sleep(2_000)
  }
  return false
}

const sessions: Array<{ slug: string; sessionId: string }> = []

try {
  // ---- 1. NTWINE RESTARTS with the question open ---------------------------------------------------
  {
    const slug = "askmech-restart", sessionId = randomUUID()
    sessions.push({ slug, sessionId })
    const scope = { projectId, threadSlug: slug, sessionId }
    let bridge = newBridge()
    await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd, prompt: ASK("Which colour?", "Colour", "Red", "Blue", "After I answer, reply with the single line PICKED=<the exact label> and stop.") })
    const before = await waitForQuestion(scope)
    ok("[restart] the question is journaled", before !== undefined)

    // ntwine dies: drop every socket WITHOUT killing the detached daemon. This is the ntwine-restart shape.
    bridge.close()
    await sleep(1_500)
    const record = readBrokerRecord(claudeBrokerRecordPath(stateDir, sessionId))
    const daemonAlive = !!record && (() => { try { process.kill(record.daemonPid, 0); return true } catch { return false } })()
    ok("[restart] the daemon outlives ntwine (it is detached)", daemonAlive)

    // a NEW ntwine attaches: the daemon re-delivers the still-pending permission on reconnect.
    bridge = newBridge()
    await bridge.followUp({ threadSlug: slug, sessionId, cwd, text: "" }).catch(() => {})
    await sleep(4_000)
    const after = interactions.listPending(scope)[0]
    ok("[restart] the question is STILL pending after the restart (SQLite kept it)", after !== undefined)
    if (after) {
      answer(scope, after, { q0: "Blue" })
      ok("[restart] answering AFTER a ntwine restart still reaches the model", await waitForReply(sessionId, "PICKED=Blue"), assistantText(sessionId).slice(-200))
    }
    bridge.releaseSession(slug, sessionId, "session-deleted")
    bridge.close()
  }

  // ---- 2. THE DAEMON DIES with the question open --------------------------------------------------
  {
    const slug = "askmech-daemon-death", sessionId = randomUUID()
    sessions.push({ slug, sessionId })
    const scope = { projectId, threadSlug: slug, sessionId }
    const bridge = newBridge()
    await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd, prompt: ASK("Which animal?", "Animal", "Cat", "Dog", "After I answer, reply with the single line ANIMAL=<the exact label> and stop.") })
    const card = await waitForQuestion(scope)
    ok("[daemon-death] the question is journaled", card !== undefined)

    const record = readBrokerRecord(claudeBrokerRecordPath(stateDir, sessionId))
    if (record) { try { process.kill(record.daemonPid, "SIGKILL") } catch {} }
    await sleep(3_000)
    ok("[daemon-death] the daemon is gone", !bridge.isDaemonAlive(sessionId))

    // The card is still on the operator's dashboard — SQLite does not know the far end died.
    const stillPending = interactions.listPending(scope)[0]
    ok("[daemon-death] the card is STILL PENDING with nobody left to answer it", stillPending !== undefined)
    if (stillPending) {
      answer(scope, stillPending, { q0: "Dog" })
      await sleep(8_000)
      const heard = assistantText(sessionId).includes("ANIMAL=")
      // REPORTED, NOT ASSERTED — measured both ways across runs, and the non-determinism IS the
      // finding. The operator's answer is written to a socket whose far end is gone, so whether the
      // turn ever completes depends on a race between the daemon dying and claude resolving the tool
      // on its own. An operator cannot tell which happened from the dashboard: the card looks the
      // same either way. A fence question has no such race — the answer is just the next user message.
      note("[daemon-death] did the model end up hearing anything?", heard ? "yes (claude self-resolved the tool)" : "no (the answer went nowhere)")
      note("[daemon-death] either way", "the answer ntwine delivered was written to a dead socket; the outcome is a race")
    }
    // What is left in the DURABLE transcript — the thing a cold resume replays and the thing the
    // operator can still read. MEASURED, not assumed: the answer decides how recoverable this is.
    const text = transcriptText(sessionId)
    const dangling = danglingToolUses(sessionId)
    const mentionsQuestion = text.includes("Which animal?")
    note("[daemon-death] transcript bytes", String(text.length))
    note("[daemon-death] AskUserQuestion tool_use blocks with no tool_result", JSON.stringify(dangling))
    note("[daemon-death] does the transcript record the question text at all?", String(mentionsQuestion))
    ok("[daemon-death] the durable transcript holds no ANSWERABLE question — the tool call is closed or absent, never re-askable",
      dangling.length === 0, `dangling=${dangling.length} mentionsQuestion=${mentionsQuestion}`)
    note("[daemon-death] what a fence would have left instead", "durable markdown in the same transcript, re-readable and answerable by any later turn")
    bridge.releaseSession(slug, sessionId, "session-deleted")
    bridge.close()
  }

  // ---- 3. NOBODY ANSWERS --------------------------------------------------------------------------
  {
    const slug = "askmech-unanswered", sessionId = randomUUID()
    sessions.push({ slug, sessionId })
    const scope = { projectId, threadSlug: slug, sessionId }
    const bridge = newBridge()
    await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd, prompt: ASK("Which fruit?", "Fruit", "Apple", "Pear", "After I answer, reply with the single line FRUIT=<the exact label> and stop.") })
    const card = await waitForQuestion(scope)
    ok("[unanswered] the question is journaled", card !== undefined)
    await sleep(20_000)
    ok("[unanswered] 20s later the claude process is STILL ALIVE holding the turn", bridge.isDaemonAlive(sessionId))
    ok("[unanswered] and the turn has NOT completed (no reply)", !assistantText(sessionId).includes("FRUIT="))
    // A follow-up cannot get past it: the operator's only lever is the card itself.
    await bridge.followUp({ threadSlug: slug, sessionId, cwd, text: "Forget the question, just reply STEERED and stop." })
    await sleep(20_000)
    ok("[unanswered] a follow-up typed in the composer does NOT get through while the tool blocks", !assistantText(sessionId).includes("STEERED"))
    note("[unanswered] the practical consequence", "the thread is steerable only through the card; a fence-rested thread takes any reply")
    bridge.releaseSession(slug, sessionId, "session-deleted")
    bridge.close()
  }
} catch (error) {
  failures++
  console.log("FAIL  harness threw —", error instanceof Error ? error.message : String(error))
} finally {
  for (const { sessionId } of sessions) {
    const record = readBrokerRecord(claudeBrokerRecordPath(stateDir, sessionId))
    if (record) { try { process.kill(record.daemonPid, "SIGKILL") } catch {} }
  }
  await sleep(1_000)
  try { db.close() } catch {}
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
