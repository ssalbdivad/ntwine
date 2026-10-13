// Seed a disposable adhoc stack with one thread whose assistant prose carries every Markdown
// COMPONENT Frizz draws beyond plain CommonMark, in the two places a worker's Markdown is drawn in the
// transcript:
//
//   • plain prose — a callout of each kind, a `<details>` section, a second one holding a gallery, a
//     picture and a diagram, `<kbd>` / `<sub>` / `<sup>` / `<mark>`, a `mermaid` fence, a fence with
//     marked lines, a `ts-diff`, a git diff with hunk headers, and a fence long enough to fold;
//   • a registered done card, whose body goes through a different component (LinkedHtml) than the
//     prose does, at the card's own 13px scale.
//
// The fixture pages (packages/web/code-blocks-fixture.html and its siblings) drive the renderer alone.
// This drives the real path around it — tailer → transcript projection → ChatView's fence and prose
// splitters — which is where a fence can be cut out of the prose, or a raw HTML tag split across two
// blocks, before the Markdown renderer ever sees it whole.
//
// Follows the frizz-stack recipe: a session row + a JSONL the REAL tailer reads.
//
// Usage: node scripts/seed-markdown-components.mjs --home=/abs/temp-home [--cwd=/abs/project] [--slug=markdown-components]
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, cwd = process.cwd() } = flags
if (!home) {
  console.error("usage: node seed-markdown-components.mjs --home=/abs/temp-home [--cwd=/abs/project]")
  process.exit(1)
}

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
const cwdSlug = cwd.replace(/[/.]/g, "-")
const jsonlDir = join(home, ".claude", "projects", cwdSlug)
mkdirSync(jsonlDir, { recursive: true })

const now = () => new Date().toISOString()
let uuidN = 0
const uuid = () => `0000000${(++uuidN).toString().padStart(4, "0")}-0000-4000-8000-000000000000`.slice(-36)

const slug = flags.slug ?? "markdown-components"
// `--session` seeds a second copy beside the first (the tailer keeps its place in a file by id).
const sessionId = flags.session ?? "c0de7ab5-0000-4000-8000-000000000002"

const record = (type, message) => ({
  parentUuid: null,
  isSidechain: false,
  type,
  message,
  uuid: uuid(),
  timestamp: now(),
  session_id: sessionId,
  cwd,
})
const user = (text) => record("user", { role: "user", content: text })
const assistant = (text) => record("assistant", {
  model: "claude-opus-5",
  id: `msg_${uuid()}`,
  type: "message",
  role: "assistant",
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  usage: { input_tokens: 2, output_tokens: 200 },
})

const fence = (info, ...lines) => ["```" + info, ...lines, "```"].join("\n")

const retry = [
  "export async function retry<T>(run: () => Promise<T>, attempts = 3): Promise<T> {",
  "  let last: unknown",
  "  for (let attempt = 0; attempt < attempts; attempt++) {",
  "    try {",
  "      return await run()",
  "    } catch (error) {",
  "      last = error",
  "      await sleep(2 ** attempt * 100)",
  "    }",
  "  }",
  "  throw last",
  "}",
]

const change = [
  "     } catch (error) {",
  "       last = error",
  "-      await sleep(100)",
  "+      // Back off: 100ms, 200ms, 400ms.",
  "+      await sleep(2 ** attempt * 100)",
  "     }",
]

const longFile = Array.from({ length: 58 }, (_, i) =>
  i % 9 === 0 ? `// section ${i / 9 + 1}` : `export const value${i + 1} = compute(${i + 1})`)

const records = [
  user("TASK:\nMake the retry back off, and show me what changed."),

  assistant([
    "The retry now backs off between attempts. Press <kbd>⌘</kbd> <kbd>K</kbd> to find the thread, and note the delay is 2<sup>n</sup> × 100ms, where n<sub>max</sub> is <mark>two</mark>.",
    "",
    "> [!NOTE]",
    "> Only the wait changed. The number of attempts is still three.",
    "",
    "> [!TIP]",
    "> Pass `attempts` to raise the ceiling for one call.",
    "",
    "> [!IMPORTANT]",
    "> Callers that relied on the fixed 100ms wait now wait up to 400ms.",
    "",
    "> [!WARNING]",
    "> The total worst case is 700ms, up from 300ms.",
    "",
    "> [!CAUTION]",
    "> Do not call this inside a request handler with a 500ms budget.",
    "",
    "The backoff is the two marked lines:",
    "",
    fence('ts title="packages/server/src/retry.ts" {7-8}', ...retry),
    "",
    "The same change as a diff:",
    "",
    fence("ts-diff", ...change),
    "",
    "And as git wrote it:",
    "",
    fence("diff",
      "diff --git a/packages/server/src/retry.ts b/packages/server/src/retry.ts",
      "index 3f1c2aa..9b04e17 100644",
      "--- a/packages/server/src/retry.ts",
      "+++ b/packages/server/src/retry.ts",
      "@@ -100,4 +100,5 @@ export async function retry<T>(run: () => Promise<T>, attempts = 3): Promise<T> {",
      ...change),
    "",
    "How a call moves through it:",
    "",
    // `call` and `end` are words of Mermaid's own grammar, so no node is named either.
    fence("mermaid",
      "flowchart LR",
      "  attempt[run] --> ok{succeeded?}",
      "  ok -- yes --> finish[return]",
      "  ok -- no --> wait[sleep 2^n × 100ms]",
      "  wait --> attempt"),
    "",
    "<details>",
    "<summary>The full test output</summary>",
    "",
    "All 63 tests pass, including the three new ones:",
    "",
    fence("text", "ℹ tests 63", "ℹ pass 63", "ℹ fail 0"),
    "",
    "</details>",
    "",
    // A section holding the three things the transcript otherwise lifts OUT of prose into blocks of
    // their own (lib/imagePaths.ts): closed, it must hide all of them.
    "<details>",
    "<summary>The screenshots, and the flow again</summary>",
    "",
    fence("lightbox", `${join(cwd, "assets/board.png")}  The board`, `${join(cwd, "assets/question.png")}  A question card`),
    "",
    join(cwd, "assets/snooze.png"),
    "",
    fence("mermaid", "flowchart LR", "  attempt[run] --> ok{succeeded?}", "  ok -- no --> wait[back off] --> attempt"),
    "",
    "</details>",
    "",
    "The generated table it reads from, in full:",
    "",
    fence("ts", ...longFile),
  ].join("\n")),
]

// The card's body is REGISTERED (`frizzctl done`), not written as a ```done fence: a signal fence
// ends at the first bare ``` line, so a code fence cannot be written inside one at all.
const doneBody = [
  "The retry backs off between attempts.",
  "",
  "> [!WARNING]",
  "> The worst case is now 700ms, up from 300ms.",
  "",
  fence("ts-diff", ...change),
  "",
  "<details>",
  "<summary>Why not jitter</summary>",
  "",
  "Three attempts is too few for jitter to matter. Press <kbd>R</kbd> to rerun.",
  "",
  "</details>",
  "",
  fence("mermaid", "flowchart LR", "  attempt[run] --> ok{succeeded?}", "  ok -- no --> wait[back off] --> attempt"),
].join("\n")

writeFileSync(join(jsonlDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")

execFileSync("sqlite3", [
  db,
  `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, rested_at)
   VALUES (${sessionVals}'${slug}', '${sessionId}', 'frizz-${slug}', '${now()}', 'markdown components', 'claude', 'opus', 'high', 'default', '${now()}')`,
])
// `thread_done` exists only on the unified schema, where every row carries its project.
if (sandbox.hasProjectId) {
  execFileSync("sqlite3", [
    db,
    `INSERT OR REPLACE INTO thread_done (project_id, thread_slug, body, done_at)
     VALUES ('${sandbox.projectId}', '${slug}', '${doneBody.replaceAll("'", "''")}', ${Date.now()})`,
  ])
}
console.log(`seeded ${slug} → ${sessionId}`)
