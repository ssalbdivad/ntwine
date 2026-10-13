// Does a SCHEDULED recurring prompt actually reach a worker that is MID-TURN?
//
// The scheduler unit tests pin the delivery GATE with a stubbed `resume`. They cannot answer the only
// question that matters for this feature: whether the real broker will take a message addressed at a
// `claude` that is busy, and whether the agent then reads it without the turn having to end first.
// That is a seam between three processes (ntwine → broker daemon → the CLI's own command queue), so it
// gets driven for real here.
//
// Run against a stack booted with --wakers and a real HOME (the broker needs the keychain):
//   nub scripts/adhoc-stack.mjs --port=4931 --home=$HOME --project=/tmp/rp-probe-repo --wakers &
//   nub scripts/verify-recurring-prompt-midturn.mjs 4931
//
// PASS requires all of:
//   1. a delivery happens while the thread's turn is in flight, not at a rest;
//   2. the worker READS it before the turn that was running has ended;
//   3. the cadence keeps running — a second one arrives an interval later, still mid-turn.
import { createRpcClient } from "./lib/rpc-client.mjs"
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

const port = process.argv[2] ?? "4931"
const api = createRpcClient(`http://127.0.0.1:${port}/`)
const INTERVAL_S = 60
const BEAT_TEXT = "HEARTBEAT-PROBE: say the word BEATHEARD, then carry on with the sleeps."

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const stamp = () => new Date().toISOString().slice(11, 23)
const log = (...a) => console.log(`[${stamp()}]`, ...a)

const results = []
function check(name, ok, detail = "") {
  results.push({ name, ok })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`)
}

// The transcript the tailer is reading, so the probe reads exactly what ntwine reads.
function transcriptPath(cwd, sessionId) {
  const slugged = cwd.replace(/[^a-zA-Z0-9]/g, "-")
  const dir = join(homedir(), ".claude", "projects", slugged)
  if (!existsSync(dir)) return null
  const exact = join(dir, `${sessionId}.jsonl`)
  if (existsSync(exact)) return exact
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
  if (files.length !== 1) return null
  return join(dir, files[0])
}

function readRecords(path) {
  if (!path || !existsSync(path)) return []
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

// `runtime` is the ThreadView's live state ("running" while a turn is in flight, "turn-idle" at rest).
// NOT `turn` — that is the tailer's internal field and reads undefined here, which silently makes every
// busy-thread assertion vacuous. Cost one whole probe run on 2026-08-03.
async function threadOf(slug) {
  const board = await api.query("board")
  return (board.threads ?? []).find((t) => t.id === slug)
}
const isBusy = (t) => t?.runtime === "running"

await api.waitForHealth()
log("stack healthy")

// TAKE THE PROJECT DIR FROM THE BOARD, never from the path you passed to --project. Claude Code slugs
// the REALPATH, and on macOS `/tmp` is a symlink to `/private/tmp` — so `/tmp/hb-probe-repo` slugs to
// `-tmp-hb-probe-repo` while the transcript actually lives in `-private-tmp-hb-probe-repo`. The lookup
// then silently finds nothing and every assertion below reads an empty transcript.
const PROJECT = (await api.query("board")).projectDir
log(`project dir (realpath, from the board): ${PROJECT}`)

// A turn made of MANY short foreground steps, so the CLI has a sampling boundary every ~20s. A single
// 200s Bash would prove delivery but not that the agent can READ the beat before the turn ends.
const { slug, sessionId } = await api.mutate("dispatch", {
  prompt: [
    "Run `sleep 20` in the FOREGROUND (never run_in_background), one at a time, twelve times in a row.",
    "After each one, print which iteration you just finished.",
    "Do not use a single long sleep and do not batch them. Do not stop early.",
  ].join(" "),
  backend: "claude",
})
log(`dispatched ${slug} (${sessionId})`)

// Wait for the worker to actually be RUNNING before arming, so the beat can only ever be a mid-turn one.
// WAIT FOR REAL WORK, not just a row that says "running" — a freshly spawned thread reads running
// within milliseconds, before the CLI has even created its JSONL. Arming there resolves the transcript
// path to null and every later assertion reads an empty file, so the probe reports a confident FAIL it
// never actually measured. (That is exactly what the first control run did on 2026-08-03.) The
// precondition is: the transcript EXISTS, the worker has started a tool call, and the board still says
// running.
let becameBusyAt = null
for (let i = 0; i < 120; i++) {
  const t = await threadOf(slug)
  const recs = readRecords(transcriptPath(PROJECT, sessionId))
  const working = recs.some((r) => r.type === "assistant" && JSON.stringify(r).includes("tool_use"))
  if (isBusy(t) && working) { becameBusyAt = Date.now(); break }
  await sleep(2000)
}
check("the probe worker reached a running turn with a live transcript", becameBusyAt !== null)
if (!becameBusyAt) process.exit(1)
log("worker is mid-turn and producing — arming the schedule trigger now")

const thread = await threadOf(slug)
await api.mutate("setThreadRecurringPrompt", {
  slug, sessionId: thread.sessionId ?? sessionId,
  prompt: BEAT_TEXT, onRest: false, onSchedule: true, intervalSeconds: INTERVAL_S,
})
log(`recurring prompt armed: SCHEDULE trigger only, every ${INTERVAL_S}s`)

// WHAT COUNTS AS THE DELIVERY INSTANT. Not the `user` record — Claude Code materializes that when it
// DEQUEUES the message, which for a mid-turn beat is later than the moment ntwine handed it over. The
// honest marker is the `queued_command` attachment / `queue-operation` record, which the CLI writes when
// the message ENTERS its queue. Reading the user record instead makes a mid-turn delivery look like a
// post-rest one, which is exactly the wrong answer for this probe.
log(`transcript: ${transcriptPath(PROJECT, sessionId)}`)

const armedAtMs = Date.now()
let queuedAt = null          // first queue record carrying the beat
let queuedWhileBusy = null   // board runtime observed at that sample
let firstEndTurnAfterArm = null
let answeredAt = null        // the assistant message that acts on the beat
let secondQueuedAt = null

for (let i = 0; i < 160; i++) {
  const busy = isBusy(await threadOf(slug))
  const records = readRecords(transcriptPath(PROJECT, sessionId))

  const queueRecs = records.filter((r) =>
    (r.type === "queue-operation" || r.type === "attachment") &&
    JSON.stringify(r).includes("HEARTBEAT-PROBE"))
  if (!queuedAt && queueRecs.length > 0) {
    queuedAt = queueRecs[0].timestamp ?? new Date().toISOString()
    queuedWhileBusy = busy
    log(`beat ENTERED the CLI queue at ${queuedAt} — board runtime right now: ${busy ? "running" : "idle"}`)
  }
  // A distinct later beat: a queue record more than half an interval after the first.
  if (queuedAt && !secondQueuedAt) {
    const later = queueRecs.find((r) => Date.parse(r.timestamp ?? "") - Date.parse(queuedAt) > (INTERVAL_S * 1000) / 2)
    if (later) { secondQueuedAt = later.timestamp; log(`a SECOND beat entered the queue at ${secondQueuedAt}`) }
  }
  for (const r of records) {
    const ts = Date.parse(r.timestamp ?? "")
    if (!Number.isFinite(ts) || ts < armedAtMs) continue
    if (!firstEndTurnAfterArm && r.type === "assistant" && r.message?.stop_reason === "end_turn") {
      firstEndTurnAfterArm = r.timestamp
    }
    if (!answeredAt && r.type === "assistant" && JSON.stringify(r).includes("BEATHEARD")) {
      answeredAt = r.timestamp
      log(`the worker ANSWERED the beat at ${answeredAt}`)
    }
  }
  if (queuedAt && answeredAt && secondQueuedAt) break
  await sleep(3000)
}

const beforeFirstRest = queuedAt && firstEndTurnAfterArm
  ? Date.parse(queuedAt) < Date.parse(firstEndTurnAfterArm)
  : queuedAt !== null && firstEndTurnAfterArm === null

check("a beat reached the worker at all", queuedAt !== null, queuedAt ?? "never queued")
check(
  "the beat was handed over while the turn was STILL RUNNING, not at a rest",
  queuedWhileBusy === true && beforeFirstRest,
  `queued ${queuedAt}; first end_turn after arming ${firstEndTurnAfterArm ?? "(none yet)"}; board said ${queuedWhileBusy ? "running" : "idle"}`,
)
// "Before the turn ended" must also hold when the turn NEVER ended inside the observation window —
// that is the strongest form of the evidence, not a missing comparison. Requiring an end_turn to
// compare against made a clean mid-turn run report a false FAIL on 2026-08-03.
check(
  "the worker READ it inside that same turn",
  answeredAt !== null && (firstEndTurnAfterArm === null || Date.parse(answeredAt) <= Date.parse(firstEndTurnAfterArm)),
  answeredAt
    ? `answered ${answeredAt}; turn end after arming: ${firstEndTurnAfterArm ?? "never (still running)"}`
    : "never answered",
)
check(
  "the cadence kept running — a second beat followed about one interval later",
  secondQueuedAt !== null,
  secondQueuedAt ? `${Math.round((Date.parse(secondQueuedAt) - Date.parse(queuedAt)) / 1000)}s after the first` : "only one beat",
)

// Leave the thread quiet.
try {
  const t = await threadOf(slug)
  await api.mutate("setThreadRecurringPrompt", { slug, sessionId: t?.sessionId ?? sessionId, prompt: null, onRest: false, onSchedule: false })
  log("recurring prompt disarmed")
} catch (e) { log(`could not disarm: ${e.message}`) }

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`)
process.exit(results.every((r) => r.ok) ? 0 : 1)
