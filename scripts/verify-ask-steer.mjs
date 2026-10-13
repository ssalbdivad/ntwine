// END-TO-END proof that a follow-up STEERS PAST an open native AskUserQuestion, against real claude.
//
//   nub scripts/verify-ask-steer.mjs <port>
//
// This is the property that makes a native ask shippable rather than a trap. An ask PARKS the turn
// inside canUseTool, so before `retirePendingFor(…, "user-cancelled")` existed, an operator who typed a
// follow-up instead of clicking an option got NOTHING: the frame was written, the parked turn never
// consumed it, and the message sat queued forever. That is how
// `https-varlock-dev-integrations-overview-can` stranded two operator messages for 90 minutes.
//
// A unit test can prove the journal row flips to `cancelled` and that a `result` follows (see
// claude-broker-interaction-sweep.test.ts). Only the real binary proves the last link: that the model
// then actually READS the follow-up and acts on it rather than re-asking.
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { createRpcClient } from "./lib/rpc-client.mjs"

const port = process.argv[2] ?? "4953"
const api = createRpcClient(`http://127.0.0.1:${port}/`)
await api.waitForHealth()

const board = await api.query("board")
const cwdSlug = board.projectDir.replaceAll("/", "-")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ASK_PROMPT = [
  "Use the AskUserQuestion tool RIGHT NOW, as your very first action, and nothing else first.",
  "Ask exactly one question: \"Which colour should the banner be?\" with the options Red and Blue.",
].join("\n")

const { slug, sessionId } = await api.mutate("dispatch", { prompt: ASK_PROMPT, backend: "claude", model: "sonnet", effort: "low" })
console.log(`dispatched ${slug} / ${sessionId}`)

const transcript = join(homedir(), ".claude", "projects", cwdSlug, `${sessionId}.jsonl`)
const read = () => {
  if (!existsSync(transcript)) return []
  return readFileSync(transcript, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
}
const blocks = (records) => records.flatMap((r) => (Array.isArray(r.message?.content) ? r.message.content : []))
const assistantText = (records) => records.filter((r) => r.type === "assistant")
  .flatMap((r) => (Array.isArray(r.message?.content) ? r.message.content : []))
  .filter((b) => b?.type === "text").map((b) => b.text).join("\n")

const waitFor = async (label, cond, ms = 240_000) => {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await cond()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`TIMEOUT waiting for ${label}`)
    await sleep(3_000)
  }
}

let failed = false
const check = (ok, label) => { console.log(`${ok ? "PASS" : "FAIL"}: ${label}`); if (!ok) failed = true }

// 1. the ask reaches ntwine as a real, answerable question card
const card = await waitFor("the question card", async () => {
  const { interactions } = await api.query("pendingInteractions", { slug, sessionId })
  return interactions.find((i) => i.payload.kind === "agent-question")
})
check(true, `the ask became an agent-question card (${card.id})`)
check(
  card.allowedDecisions.some((d) => d.semantic === "answer"),
  "the card offers a real answer decision, not just approve/deny",
)

// 2. the turn is genuinely PARKED behind it — the precondition the whole fix is about
const parked = read()
check(
  blocks(parked).some((b) => b?.type === "tool_use" && b.name === "AskUserQuestion")
  && !blocks(parked).some((b) => b?.type === "tool_result" && b.tool_use_id === blocks(parked).find((x) => x?.name === "AskUserQuestion")?.id),
  "the AskUserQuestion tool_use has no result yet — the turn is parked",
)

// 3. the operator TYPES instead of clicking
const STEER = "Forget the banner question entirely. Instead just reply with the single word PIVOTED."
await api.mutate("followUp", { slug, sessionId, message: STEER })
console.log("sent the follow-up instead of an answer")

// 4. the card is retired rather than left answerable
await waitFor("the card to retire", async () => {
  const { interactions } = await api.query("pendingInteractions", { slug, sessionId })
  return !interactions.some((i) => i.id === card.id)
}, 60_000)
check(true, "the superseded card left the queue")

// 5. THE LINK ONLY THE REAL BINARY PROVES: the model reads the follow-up and acts on it
const text = await waitFor("the model to act on the steer", async () => {
  const records = read()
  const said = assistantText(records)
  return /PIVOTED/.test(said) ? said : null
})
check(/PIVOTED/.test(text), "the model read the follow-up and obeyed it")
console.log("---- the worker's own words ----")
console.log(text.trim().slice(-800))
console.log("--------------------------------")

console.log(failed ? "OVERALL: FAIL" : "OVERALL: PASS — a follow-up steers past an open native ask")
if (failed) process.exitCode = 1
