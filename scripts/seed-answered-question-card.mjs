// Seed a disposable adhoc stack with ONE simulated worker whose transcript is the shape that made the
// queue card repaint itself: the human's ask, a whole iteration, the answer to a REGISTERED question,
// then a second whole iteration.
//
// The answer is the point. It is the one user turn ntwine DELIVERS that the HUMAN wrote — it arrives as a
// scheduler wake (the human may have answered while the worker's process was down), so a card that reads
// `wake` as "ntwine wrote this" walks straight past it, back to the ask, and paints both iterations
// (maintainer 2026-08-31: "the cue card should only go back to the most recent user interaction"). The
// card must open on the ANSWER, with everything above it left to the drawer.
//
// The delivered text is composed by the SAME shared formatter the scheduler uses and carries the real
// wake-delivery token and clock note, so this exercises the production projection rather than a
// hand-written string — the clock note in particular is why the rule has to read `displayText`.
//
// Follows the ntwine-stack recipe: a session row + a JSONL the REAL tailer reads. No process: liveness
// comes from the row.
// Usage: nub scripts/seed-answered-question-card.mjs --home=/abs/temp-home --port=NNNN
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { questionAnswerMessage, wakeDeliveryToken } from "../packages/shared/src/index.ts"
import { createRpcClient } from "./lib/rpc-client.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, port, cwd = process.cwd() } = flags
if (!home || !port) {
  console.error("usage: nub scripts/seed-answered-question-card.mjs --home=/abs/temp-home --port=NNNN")
  process.exit(1)
}

// ONE server, EVERY project: the DB is a single `~/.ntwine/ui.db` and a session row names its project,
// so the row has to carry the registry's id for this cwd or the board never sees it.
const db = join(home, ".ntwine", "ui.db")
if (!existsSync(db)) throw new Error(`no ui.db at ${db} — is the stack booted?`)
const registry = JSON.parse(readFileSync(join(home, ".ntwine", "registry.json"), "utf8"))
const projectId = registry.projects.find((p) => p.path === cwd)?.id
if (!projectId) throw new Error(`${cwd} is not registered in ${home}/.ntwine/registry.json`)
const jsonlDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(jsonlDir, { recursive: true })

const T0 = Date.now() - 5 * 60 * 60_000
const at = (m) => new Date(T0 + m * 60_000).toISOString()
let n = 0
const uuid = () => `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`
const slug = "answered-question-card"
const sessionId = "a5e70000-0000-4000-9000-0000000000aa"

const user = (min, content) => ({
  parentUuid: null, isSidechain: false, type: "user", uuid: uuid(), timestamp: at(min), session_id: sessionId, cwd,
  message: { role: "user", content },
})
// `stop_reason: "end_turn"` is the authoritative signal the rest divider is projected from — see
// transcript.ts § the agent came to rest.
const assistant = (min, text) => ({
  parentUuid: null, isSidechain: false, type: "assistant", uuid: uuid(), timestamp: at(min), session_id: sessionId, cwd,
  message: {
    model: "claude-opus-5", id: `msg_${n}`, type: "message", role: "assistant", stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: 41_000, output_tokens: 320 },
  },
})

// Exactly what the scheduler enqueues (questionAnswerMessage), delivered exactly as the runtime records
// it: ntwine's clock note, then the token the outbox acks on. The server strips both into `displayText`.
const ANSWER = `${questionAnswerMessage([{
  questionId: "qst_1",
  question: "The Fable-limit fix is committed on the local main branch, one commit ahead of origin. Push it to GitHub now, or leave it local?",
  chosen: ["Push it to origin/main"],
}])}\n\n⏱ ${new Date(T0 + 260 * 60_000).toISOString().slice(0, 16).replace("T", " ")} — you last spoke 4h29m ago.\n\n${wakeDeliveryToken("a".repeat(64))}`

const records = [
  user(0, "we should also switch if we hit the Fable limit"),
  assistant(2, "You've reached your Fable 5 limit. Switch to another model, or manage usage credits at claude.ai/settings."),
  user(4, "go"),
  // ITERATION ONE — everything above the answer, which the drawer keeps and the card must not repaint.
  assistant(6, "I'll start by getting oriented in the repo, since my scratch directory is empty and I need ground truth on how the broker reads a quota response."),
  assistant(20, "The wire tells a clear story. A rejected response carries no itemized window, so the parser falls through to the model-scoped cap and reports the wrong reset."),
  assistant(38, "The defect is confirmed. Now I'll fix the parser so a rejection outranks the itemized window rather than losing to it."),
  assistant(52, "The fix holds and the suite is green. Now the tests that pin this behaviour."),
  assistant(74, "Another writer is editing this tree concurrently — `src/tokens.ts` and `src/activation.ts` are both dirty and neither is mine. Committing only my four paths."),
  assistant(95, "**Fixed** — a Fable limit now switches like any other.\n\n```done\n- Taught the broker's quota parser that a rejection outranks the itemized window, in `src/pass.ts` (`b91d3de`).\n- Added the two regression tests; the project's gates are green.\n```"),
  // THE HUMAN'S ANSWER — ntwine's transport, the human's words. The card opens here.
  user(260, ANSWER),
  // ITERATION TWO — the only turn the card should paint.
  assistant(262, "Pushing to origin/main. First let me re-check the repo state — over four hours passed, and this tree has other writers in it."),
  assistant(268, "Working tree is clean and my fix is intact. Running the project's gates before publishing."),
  assistant(272, "**Fixed** — `origin/main` is at `4697c10`, and the Fable-limit fix `b91d3de` is on the remote.\n\n```done\n- Pushed `b91d3de` to `origin/main` after re-running both gates green.\n```"),
]

writeFileSync(join(jsonlDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
execFileSync("sqlite3", [
  db,
  `INSERT OR REPLACE INTO session (project_id, slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, rested_at)
   VALUES ('${projectId}', '${slug}', '${sessionId}', 'ntwine-${slug}', '${at(0)}', 'Switch models on a Fable limit', 'claude', 'opus', 'high', 'default', '${at(272)}')`,
])

const api = createRpcClient(`http://127.0.0.1:${port}/`)
await api.waitForHealth()
for (let i = 0; i < 40; i++) {
  const board = await api.query("board")
  if (board.threads.some((t) => t.id === slug)) break
  await new Promise((r) => setTimeout(r, 250))
}
const page = await api.query("threadTranscript", { slug })
console.log(JSON.stringify(page.messages.map((m, i) => ({ i, role: m.role, kind: m.kind, boundary: m.boundary, wake: m.wake, text: (m.displayText ?? m.text).slice(0, 52) })), null, 1))
