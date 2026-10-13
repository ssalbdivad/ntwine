// Seed a disposable adhoc stack with one thread whose assistant prose carries the Markdown blocks of
// packages/web/src/lib/callouts.ts and lib/disclosure.ts — a callout, a `<details>` section, and the
// inline `<kbd>` / `<sub>` / `<sup>` / `<mark>` — in both places a worker's Markdown is drawn:
//
//   • plain transcript prose, where the message passes through ChatView's splitters (signal fences,
//     question blocks, and lib/imagePaths' attachment lines) BEFORE the Markdown renderer sees it;
//   • a registered done card, whose body goes through LinkedHtml at the card's own 13px scale.
//
// The fixture page (packages/web/md-blocks-fixture.html) drives the renderer alone. This drives the
// real path around it, which is where a `<details>` can be cut apart: `--gallery=/abs/picture.png` adds
// a section holding a ```lightbox fence, the one block the transcript lifts out of prose on its way to
// the renderer.
//
// `--append` writes one more exchange into the same thread, the way a worker's next turn does, so a
// section the reader opened can be watched across a real transcript push.
//
// Follows the frizz-stack recipe: a session row + a JSONL the REAL tailer reads.
//
// Usage: node scripts/seed-md-blocks.mjs --home=/abs/temp-home [--cwd=/abs/project] [--slug=md-blocks]
//          [--gallery=/abs/picture.png] [--append]
import { execFileSync } from "node:child_process"
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => {
    const s = a.replace(/^--/, "")
    const i = s.indexOf("=")
    return i < 0 ? [s, true] : [s.slice(0, i), s.slice(i + 1)]
  }),
)
const { home, cwd = process.cwd() } = flags
if (!home) {
  console.error("usage: node seed-md-blocks.mjs --home=/abs/temp-home [--cwd=/abs/project] [--gallery=/abs/picture.png] [--append]")
  process.exit(1)
}

const slug = flags.slug ?? "md-blocks"
const sessionId = "b10c5a11-0000-4000-8000-000000000001"
const cwdSlug = cwd.replace(/[/.]/g, "-")
const jsonlDir = join(home, ".claude", "projects", cwdSlug)
const jsonl = join(jsonlDir, `${sessionId}.jsonl`)

const now = () => new Date().toISOString()
// `--append` runs in a second process: its uuids must not collide with the first run's.
let uuidN = flags.append ? 5000 : 0
const uuid = () => `0000000${(++uuidN).toString().padStart(4, "0")}-0000-4000-8000-000000000000`.slice(-36)

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

if (flags.append) {
  appendFileSync(jsonl, [user("And the next step?"), assistant("Nothing further: the release is cut.")].map((r) => JSON.stringify(r)).join("\n") + "\n")
  console.log(`appended to ${slug}`)
  process.exit(0)
}

const fence = (info, ...lines) => ["```" + info, ...lines, "```"].join("\n")
const details = (summary, ...body) => ["<details>", `<summary>${summary}</summary>`, "", ...body, "", "</details>"].join("\n")

const prose = [
  "The suite is green and the branch is ready. Press <kbd>⌘</kbd> <kbd>K</kbd> to open it; the bundle grew by 2<sup>10</sup> bytes, CO<sub>2</sub> not included, and <mark>one file moved</mark>.",
  "",
  "> [!WARNING]",
  "> This rewrites history on `main`.",
  "",
  "> [!TIP] Before you merge",
  "> Rebase first:",
  ">",
  "> " + fence("sh", "git fetch origin", "git rebase origin/main").replaceAll("\n", "\n> "),
  "",
  details("Full test output",
    "Everything under `packages/web` passed:",
    "",
    fence("text", "ℹ tests 63", "ℹ pass 63", "ℹ fail 0"),
    "",
    "- the sanitizer battery",
    "- the tab strip",
    "",
    fence("bash npm", "npm test"),
    "",
    fence("bash pnpm", "pnpm test")),
  "",
  "1. Cut the release.",
  "",
  "   > [!CAUTION]",
  "   > npm cannot unpublish it afterwards.",
  "2. Watch the run.",
  ...(flags.gallery ? [
    "",
    details("The screenshots", "What the row looked like:", "", fence("lightbox", `${flags.gallery} The glyph rows`)),
  ] : []),
].join("\n")

const records = [user("TASK:\nIs the branch ready to merge?"), assistant(prose)]

// The card's body is REGISTERED (`frizzctl done`), not written as a ```done fence: a signal fence
// ends at the first bare ``` line, so a code fence cannot be written inside one at all.
const doneBody = [
  "Ready to merge. Press <kbd>⏎</kbd> to confirm.",
  "",
  "> [!IMPORTANT]",
  "> Both packages publish together.",
  "",
  details("What ships", "- `frizz` 0.14.0", "- `frizz-server` 0.14.0", "", fence("sh", "gh workflow run release.yml --ref release")),
  ...(flags.gallery ? ["", details("The screenshots", fence("lightbox", `${flags.gallery} The glyph rows`))] : []),
].join("\n")

mkdirSync(jsonlDir, { recursive: true })
writeFileSync(jsonl, records.map((r) => JSON.stringify(r)).join("\n") + "\n")

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
execFileSync("sqlite3", [
  db,
  `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, rested_at)
   VALUES (${sessionVals}'${slug}', '${sessionId}', 'frizz-${slug}', '${now()}', 'Markdown blocks', 'claude', 'opus', 'high', 'default', '${now()}')`,
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
