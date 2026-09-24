// NOTE 2026-09-24: the expectation below is REVERSED. An open question now stays at the rest that asked
// it (lib/questionAnchor), so the card belongs ABOVE the human's reply, not at the tail; a marker in the
// older handoff keeps placing there, with its Send right after that rest.
// Seed a disposable adhoc stack with ONE simulated worker in the shape that made a rest read as a bare
// stop: the worker registered a question and wrote its ```question qst_… PLACEMENT MARKER into that
// handoff, the human replied past it without answering, and the worker worked on and rested AGAIN with
// the question still open and no marker in the new handoff.
//
// The card used to stay pinned at the OLD rest — thousands of pixels up — while the tail drew the
// group's bare disabled "Send answers" with nothing above it to answer, so the newest handoff read as a
// rest with no sign-off at all (maintainer 2026-09-13: "How did this thread pause without a sign-off?",
// which is the 2026-08-31 report arriving again through the marker). The anchor path's at-rest
// re-anchor could never reach it: a PLACED question is subtracted before that path runs.
//
// Pass --fresh-marker to write the marker into the FINAL handoff instead. That is the control: the same
// code path must place the card INSIDE that message rather than at the tail, so a run that draws the
// card at the tail either way proves nothing.
//
// Follows the frizz-stack recipe: a session row + a JSONL the REAL tailer reads. No process.
// Usage: nub scripts/seed-stale-question-marker.mjs --home=/abs/temp-home --port=NNNN [--fresh-marker]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { createRpcClient } from "./lib/rpc-client.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, port, cwd = process.cwd() } = flags
const freshMarker = "fresh-marker" in flags
if (!home || !port) {
  console.error("usage: nub scripts/seed-stale-question-marker.mjs --home=/abs/temp-home --port=NNNN [--fresh-marker]")
  process.exit(1)
}

const db = join(home, ".frizz", "ui.db")
if (!existsSync(db)) throw new Error(`no ui.db at ${db} — is the stack booted?`)
const registry = JSON.parse(readFileSync(join(home, ".frizz", "registry.json"), "utf8"))
const projectId = registry.projects.find((p) => p.path === cwd)?.id
if (!projectId) throw new Error(`${cwd} is not registered in ${home}/.frizz/registry.json`)
const jsonlDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(jsonlDir, { recursive: true })

const T0 = Date.now() - 3 * 60 * 60_000
const at = (m) => new Date(T0 + m * 60_000).toISOString()
let n = 0
const uuid = () => `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`
// A distinct slug and session per variant: the tailer reads a JSONL once and will NOT re-read one
// rewritten under it, so reusing the slug silently renders the PREVIOUS variant — a control that agrees
// with the test for the wrong reason.
const slug = freshMarker ? "fresh-question-marker" : "stale-question-marker"
const sessionId = freshMarker ? "51a1e000-0000-4000-9000-0000000000bb" : "51a1e000-0000-4000-9000-0000000000aa"
const questionId = freshMarker ? "qst_33c7ca222ec1" : "qst_22b6b9111db0"

const user = (min, content) => ({
  parentUuid: null, isSidechain: false, type: "user", uuid: uuid(), timestamp: at(min), session_id: sessionId, cwd,
  message: { role: "user", content },
})
const assistant = (min, text) => ({
  parentUuid: null, isSidechain: false, type: "assistant", uuid: uuid(), timestamp: at(min), session_id: sessionId, cwd,
  message: {
    model: "claude-opus-5", id: `msg_${n}`, type: "message", role: "assistant", stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: 38_000, output_tokens: 280 },
  },
})

const MARKER = `\`\`\`question ${questionId}\n\`\`\``
const ASKING_HANDOFF = [
  "Both PRs are compatible. Here's where everything stands.",
  "",
  "## On extending it to the Mini form",
  "",
  "Worth knowing before you decide: **Mini already has the type safety.** What Mini lacks is only *autocomplete*, and that's the part with a price tag.",
  "",
  freshMarker ? "" : MARKER,
  "",
  "Both PRs have watchers armed, so CI results and reviews on either will wake me.",
].join("\n")
const FINAL_HANDOFF = [
  "Publishing is underway. Here's the state.",
  "",
  "## Release status",
  "",
  "All four gates passed — lint, circular dependencies, and both TypeScript 5.5 and 6. `build_and_publish` is running now, with a background watch armed that will wake me when it finishes.",
  "",
  freshMarker ? MARKER : "",
  "",
  "The Mini autocomplete question is still open and unaffected by any of this.",
].join("\n")

const records = [
  user(0, "we need to add a properties example for Zod Mini"),
  assistant(4, "Reading the docs page and the classic `.properties()` implementation."),
  assistant(12, ASKING_HANDOFF),
  user(30, "I guess let's just unrevert it. We'll announce it in the 4.7 blog post, though."),
  assistant(34, "Un-reverting now, then re-applying the bump on top."),
  assistant(41, "Both matrix legs pass. Pushing to main."),
  assistant(48, FINAL_HANDOFF),
]

writeFileSync(join(jsonlDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
execFileSync("sqlite3", [
  db,
  `INSERT OR REPLACE INTO session (project_id, slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, rested_at)
   VALUES ('${projectId}', '${slug}', '${sessionId}', 'frizz-${slug}', '${at(0)}', 'Properties docs and instanceof shape typing', 'claude', 'opus', 'high', 'default', '${at(48)}')`,
])

// The registration the marker names. Hand-written for the same reason the session row is: the row IS the
// fixture, and everything downstream of it — the board projection, the anchor, the placement, the card —
// is the real pipeline.
const spec = JSON.stringify({
  question: "Zod Mini already rejects a wrong key and a wrong property type. What it does not do is autocomplete the key names. Should key autocomplete be pursued for the Mini form?",
  header: "Mini keys",
  kind: "question",
  options: [
    { label: "Leave it — safety only", description: "Mini keeps the key and type errors it already has, and autocomplete stays exclusive to the classic method form.", recommended: true },
    { label: "Add a helper naming the class", description: "A curried call such as `z.propertiesOf<File>()({ … })` would make the keys autocomplete in Mini. Costs a new exported function in every Mini bundle." },
    { label: "Change the shared check() signature", description: "Flowing the base type into every `.check()` call would give autocomplete with no new export, but it touches the type-checking hot path for the entire library." },
  ],
}).replace(/'/g, "''")
execFileSync("sqlite3", [
  db,
  `INSERT OR REPLACE INTO thread_question (id, project_id, thread_slug, spec, state, answer, delivered, asked_at, settled_at)
   VALUES ('${questionId}', '${projectId}', '${slug}', '${spec}', 'open', NULL, 0, ${Date.parse(at(12))}, NULL)`,
])

const api = createRpcClient(`http://127.0.0.1:${port}/`)
await api.waitForHealth()
for (let i = 0; i < 40; i++) {
  const board = await api.query("board")
  if (board.threads.some((t) => t.id === slug)) break
  await new Promise((r) => setTimeout(r, 250))
}
const board = await api.query("board")
const t = board.threads.find((x) => x.id === slug)
console.log(JSON.stringify({ slug, marker: freshMarker ? "final handoff" : "asking rest (stale)", runtime: t?.runtime, questions: t?.questions?.map((q) => ({ id: q.id, askedAt: q.askedAt })) }, null, 1))
