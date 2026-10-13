// LIVE end-to-end proof of NATIVE AskUserQuestion on the Claude broker path, against real claude:
//   nub packages/server/src/backend/_live_broker_ask.mts
//
// A unit test cannot prove this. The whole risk lives in ONE contract that only the real claude binary
// enforces: the answers object must be keyed by the FULL QUESTION TEXT, and the value must be exactly
// an advertised option label. Get either wrong and everything still "works" — the decision validates,
// the tool call completes — while claude's own result mapper quietly tells the model "The user did not
// answer the questions." and it asks again. So the assertion here is not "we sent an answer": it is
// that the MODEL, in its own next words, repeats the option the operator picked.
//
// Proves, against a real session driven through the real bridge + a real InteractionStore:
//   1. AskUserQuestion reaches canUseTool at all (the cc-worker PreToolUse deny hook stands down when
//      NTWINE_NATIVE_ASK=1, which the bridge stamps whenever a store is wired)
//   2. it is journaled as an `agent-question` interaction — NOT "Approve AskUserQuestion?" — with one
//      select/multi-select field per question, carrying the real options
//   3. resolving with `answer` returns {questions, answers} and the model RECEIVES the chosen labels
//   4. a multiSelect question round-trips as the ", "-joined labels claude's schema documents
//   5. declining denies with a reason, and the session stays alive and answers afterwards
import { execFileSync } from "node:child_process"
import { mkdtempSync, readdirSync, existsSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import Database from "../sqlite.ts"
import { createInteractionStore } from "../interaction-store.ts"
import { createClaudeAgentBrokerBridge } from "./claude-agent-broker-bridge.ts"
import { readClaudeBrokerDiagnostics } from "./claude-broker-diagnostics.ts"
import type { InteractionRecord } from "@ntwine/shared"

const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const stateDir = mkdtempSync(join(tmpdir(), "ask-state-"))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ask-repo-"))); execFileSync("git", ["init", "-q", cwd])
const db = new Database(join(stateDir, "ui.db")); db.pragma("journal_mode = WAL")
const interactions = createInteractionStore(db)

let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const projectId = "live-ask"
const slug = "ask-live"
const sessionId = randomUUID()
const scope = { projectId, threadSlug: slug, sessionId }

// The worker plugin is what makes this a REAL ntwine worker session: its PreToolUse hook is the thing
// that used to deny AskUserQuestion outright, so pointing at it is load-bearing, not decoration.
const pluginDir = join(import.meta.dirname, "..", "..", "..", "..", "..", "cc-worker")
ok("cc-worker plugin dir resolves (the deny-ask hook is in play)", existsSync(join(pluginDir, "hooks", "deny-ask.mjs")), pluginDir)

const bridge = createClaudeAgentBrokerBridge({
  stateDir, executablePath: claudeBin, interactions, projectId,
  env: Object.fromEntries(["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"].filter((k) => process.env[k]).map((k) => [k, process.env[k]!])),
  workerEnv: { pluginDir },
  onDiagnostic: (_slug, _sid, diagnostic) => console.log("[diag]", JSON.stringify(diagnostic).slice(0, 500)),
})

function transcriptText(): string {
  const base = join(homedir(), ".claude", "projects")
  if (!existsSync(base)) return ""
  for (const dir of readdirSync(base)) {
    const file = join(base, dir, `${sessionId}.jsonl`)
    if (existsSync(file)) { try { return readFileSync(file, "utf8") } catch { return "" } }
  }
  return ""
}

// ONLY the model's own words. Scanning the raw JSONL is a trap that nearly shipped here: every token
// this harness asks the model to echo is ALSO present in the prompt that asked for it, so a raw-text
// match "passes" whether or not the model ever answered. Assertions about what the model SAID must run
// against assistant text and nothing else.
function assistantText(): string {
  const out: string[] = []
  for (const line of transcriptText().split("\n")) {
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

async function waitForQuestion(timeoutMs = 180_000): Promise<InteractionRecord | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pending = interactions.listPending(scope)
    if (pending.length > 0) return pending[0]
    if (!bridge.isDaemonAlive(sessionId)) return undefined
    await sleep(1_000)
  }
  return undefined
}

/** Answer a pending question card exactly as the web card's resolve mutation would. */
function answerCard(record: InteractionRecord, values: Record<string, string | string[]>) {
  return interactions.resolve(scope, {
    slug, sessionId, interactionId: record.id,
    sessionEpoch: record.owner.sessionEpoch, capabilityRevision: record.owner.capabilityRevision,
    expectedRecordRevision: record.recordRevision,
    responseId: randomUUID(), decisionId: "answer", values,
  })
}

/** Wait for the MODEL to say something, not for the string to appear anywhere in the JSONL. */
async function waitForReply(needle: string, timeoutMs = 180_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (assistantText().includes(needle)) return true
    if (!bridge.isDaemonAlive(sessionId)) return false
    await sleep(2_000)
  }
  return false
}

try {
  // ---- 1/2. a single-select question becomes an agent-question card ------------------------------
  await bridge.spawnDispatch({
    threadSlug: slug, sessionId, cwd,
    prompt: "Use the AskUserQuestion tool RIGHT NOW, before doing anything else, to ask me exactly one " +
      'question: question "Which release channel should we ship on?", header "Channel", with exactly two ' +
      'options: label "Stable" (description "Battle tested") and label "Beta" (description "Ships weekly"). ' +
      "Do not use any other tool first. After you get my answer, reply with the single line " +
      "CHOSE=<the exact label I picked> and stop.",
  })

  const card = await waitForQuestion()
  ok("AskUserQuestion reached canUseTool and was journaled", card !== undefined)
  if (!card) throw new Error("no interaction was journaled — the deny hook or the tool never fired")
  ok("journaled as an agent-question card, not an approval", card.payload.kind === "agent-question", card.payload.kind)
  ok("the card is claude-provided and agent-sourced", card.provider.kind === "claude" && card.source.kind === "agent", `${card.provider.kind}/${card.source.kind}`)
  ok("it advertises an `answer` decision the web canonicalizes", card.allowedDecisions.some((d) => d.id === "answer" && d.semantic === "answer"))
  const fields = card.payload.kind === "agent-question" ? card.payload.fields : []
  ok("one field per question", fields.length === 1, JSON.stringify(fields.map((f) => f.id)))
  const field = fields[0]
  ok("the field is a select carrying the real option labels", field?.input === "select" &&
    field.options.some((o) => o.value === "Stable") && field.options.some((o) => o.value === "Beta"),
    JSON.stringify(field && "options" in field ? field.options : field))
  ok("the question text survives as the field description", (field?.description ?? "").includes("release channel"), field?.description)
  console.log("    card title:", JSON.stringify(card.payload.title))

  // ---- 3. answering returns the chosen label TO THE MODEL ----------------------------------------
  answerCard(card, { q0: "Beta" })
  // "CHOSE=Beta" appears NOWHERE in the prompt — only the template "CHOSE=<the exact label I picked>"
  // does — so the model can only produce it by having actually received the answer "Beta".
  const heard = await waitForReply("CHOSE=Beta")
  ok("THE MODEL RECEIVED THE OPERATOR'S ANSWER (it replied CHOSE=Beta)", heard, assistantText().slice(-300))
  // The failure this whole change exists to kill: an unanswered AskUserQuestion makes claude tell the
  // model the question was not answered, and it asks again.
  ok("claude did NOT report the question as unanswered", !transcriptText().includes("did not answer the questions"))

  // ---- 4. a multiSelect question round-trips as ", "-joined labels -------------------------------
  await bridge.followUp({
    threadSlug: slug, sessionId, cwd,
    text: "Now use the AskUserQuestion tool again with ONE question, multiSelect true: question " +
      '"Which extras should we enable?", header "Extras", options label "Metrics" (description "Emit metrics") ' +
      'and label "Tracing" (description "Emit traces"). After I answer, reply with the single line ' +
      "PICKED=<the exact labels I picked, comma separated> and stop.",
  })
  const multi = await waitForQuestion()
  ok("the multiSelect question also became a card", multi !== undefined)
  const multiField = multi && multi.payload.kind === "agent-question" ? multi.payload.fields[0] : undefined
  ok("multiSelect maps to a multi-select field", multiField?.input === "multi-select", multiField?.input)
  if (multi) answerCard(multi, { q0: ["Metrics", "Tracing"] })
  // Again a string the prompt never contains: the two labels, comma-joined, after PICKED=.
  const bothHeard = await waitForReply("PICKED=Metrics")
  ok("THE MODEL RECEIVED BOTH multi-select labels (it replied PICKED=Metrics, Tracing)",
    bothHeard && /PICKED=Metrics,\s*Tracing/u.test(assistantText()), assistantText().slice(-300))

  // ---- 5. declining denies with a reason, and the session survives -------------------------------
  await bridge.followUp({
    threadSlug: slug, sessionId, cwd,
    text: 'Use AskUserQuestion once more: question "Should we tag a release now?", header "Release", ' +
      'options label "Yes" (description "tag it") and label "No" (description "wait"). ' +
      "If the question is refused, just reply DECLINED-OK and stop.",
  })
  const third = await waitForQuestion()
  ok("the third question became a card", third !== undefined)
  if (third) {
    interactions.cancel(scope, {
      slug, sessionId, interactionId: third.id,
      sessionEpoch: third.owner.sessionEpoch, capabilityRevision: third.owner.capabilityRevision,
      expectedRecordRevision: third.recordRevision,
    })
  }
  ok("cancelling the card unblocks the model (it is not left hanging)", await waitForReply("DECLINED-OK", 180_000), assistantText().slice(-300))

  // ---- the assertion that outranks all the others -------------------------------------------------
  const token = `ALIVE-${randomUUID().slice(0, 8)}`
  await bridge.followUp({ threadSlug: slug, sessionId, cwd, text: `Reply with exactly ${token} and nothing else. Do not use any tools.` })
  ok("the session is STILL ALIVE and still answering after all of it", await waitForReply(token, 180_000))
  ok("no crashed lifecycle diagnostic", !readClaudeBrokerDiagnostics(stateDir, sessionId).some((r) => r.diagnostic.kind === "lifecycle" && r.diagnostic.phase === "crashed"))
} catch (error) {
  failures++
  console.log("FAIL  harness threw —", error instanceof Error ? error.message : String(error))
} finally {
  bridge.releaseSession(slug, sessionId, "session-deleted")
  bridge.close()
  await sleep(1_000)
  try { for (const record of readClaudeBrokerDiagnostics(stateDir, sessionId)) console.log("[daemon]", JSON.stringify(record.diagnostic).slice(0, 600)) } catch {}
  try { db.close() } catch {}
  // ASK_KEEP=1 preserves the state dir + repo for post-mortem on a failed run.
  if (!process.env.ASK_KEEP) {
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  } else console.log(`kept stateDir=${stateDir} cwd=${cwd}`)
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
