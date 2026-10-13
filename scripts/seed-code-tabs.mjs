// Seed a disposable adhoc stack with one thread whose assistant prose carries CODE TABS
// (packages/web/src/lib/codeTabs.ts) in every place a worker's Markdown is drawn in the transcript:
//
//   • plain prose — a run of labelled fences (tabs), a run labelled with `title=` (files), one
//     labelled fence (a title bar), and two UNLABELLED neighbours, which must stay two blocks;
//   • a list item, where an install step's tabs sit under the step's own text;
//   • a registered done card, whose body goes through a different component (LinkedHtml) than the
//     prose does, at the card's own 13px scale.
//
// The fixture page (packages/web/code-tabs-fixture.html) drives the renderer alone. This drives the
// real path around it — tailer → transcript projection → ChatView's fence and prose splitters — which
// is where a run of fences could be cut apart before the Markdown renderer ever sees it as a run.
//
// Follows the frizz-stack recipe: a session row + a JSONL the REAL tailer reads.
//
// Usage: node scripts/seed-code-tabs.mjs --home=/abs/temp-home [--cwd=/abs/project] [--slug=code-tabs]
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, cwd = process.cwd() } = flags
if (!home) {
  console.error("usage: node seed-code-tabs.mjs --home=/abs/temp-home [--cwd=/abs/project]")
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

const slug = flags.slug ?? "code-tabs"
const sessionId = "c0de7ab5-0000-4000-8000-000000000001"

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

const records = [
  user("TASK:\nShow me how to install and call the client."),

  assistant([
    "Install it with whichever package manager the repo uses:",
    "",
    fence("bash npm", "npm install left-pad", "npx left-pad --help"),
    "",
    fence("bash pnpm", "pnpm add left-pad", "pnpm dlx left-pad --help"),
    "",
    fence("bash yarn", "yarn add left-pad"),
    "",
    "The server and the client it talks to:",
    "",
    fence('ts title="src/server.ts"',
      'import { createServer } from "node:http"',
      "",
      "export const server = createServer((req, res) => {",
      '  res.end("ok")',
      "})"),
    "",
    fence('ts title="src/client.ts"',
      'const res = await fetch("http://localhost:3000")',
      "console.log(await res.text())"),
    "",
    "One labelled fence is a title, not a tab:",
    "",
    fence("json package.json", "{", '  "type": "module"', "}"),
    "",
    "Unlabelled neighbours stay two blocks — a command and its output:",
    "",
    fence("bash", "node src/client.ts"),
    "",
    fence("text", "ok"),
    "",
    "1. Start the server:",
    "",
    "   " + fence("bash node", "node src/server.ts").replaceAll("\n", "\n   "),
    "",
    "   " + fence("bash bun", "bun src/server.ts").replaceAll("\n", "\n   "),
    "2. Call it from the client.",
  ].join("\n")),
]

// The card's body is REGISTERED (`frizzctl done`), not written as a ```done fence: a signal fence
// ends at the first bare ``` line, so a code fence cannot be written inside one at all.
const doneBody = [
  "Both entry points are written. Run the server with either runtime:",
  "",
  fence("bash node", "node src/server.ts"),
  "",
  fence("bash bun", "bun src/server.ts"),
].join("\n")

writeFileSync(join(jsonlDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")

execFileSync("sqlite3", [
  db,
  `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, rested_at)
   VALUES (${sessionVals}'${slug}', '${sessionId}', 'frizz-${slug}', '${now()}', 'code tabs', 'claude', 'opus', 'high', 'default', '${now()}')`,
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
