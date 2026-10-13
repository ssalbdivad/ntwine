// A simulated transcript plus real files for filePanelStack.e2e.test.ts. No provider is dispatched.
// Usage: nub scripts/seed-file-panel-stack.mjs --home=<adhoc-stack HOME>
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const home = process.argv.find((a) => a.startsWith("--home="))?.slice(7)
if (!home) throw new Error("Pass --home=<disposable adhoc-stack HOME>")
const project = process.cwd()
const sandbox = resolveSandboxDb(home)
const { cols, vals } = sessionProjectColumns(sandbox)
const docs = join(home, "file-stack-docs")
mkdirSync(docs, { recursive: true })
writeFileSync(join(docs, "first.md"), [
  "# First document", "", "[Read the second document](second.md)", "",
  ...Array.from({ length: 70 }, (_, i) => `Paragraph ${i + 1}: the first document keeps its reading position.\n`),
  "[Continue to the second document](second.md)",
].join("\n"))
writeFileSync(join(docs, "second.md"), "# Second document\n\n[Revisit the first document](first.md)\n\n[Read the source file](example.ts)\n\nSelect this passage for the chat.\n")
writeFileSync(join(docs, "example.ts"), "export const stacked = true\n")
const slug = "file-panel-stack"
const sessionId = randomUUID()
const now = new Date().toISOString()
const jsonlDir = join(home, ".claude", "projects", project.replace(/[/.]/g, "-"))
mkdirSync(jsonlDir, { recursive: true })
const records = [
  { type: "user", message: { role: "user", content: "Read the linked documents" } },
  { type: "assistant", message: { model: "claude-opus-5", id: randomUUID(), type: "message", role: "assistant", content: [{ type: "text", text: `[Read the first document](${join(docs, "first.md")})` }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 20 } } },
].map((r) => ({ ...r, uuid: randomUUID(), parentUuid: null, isSidechain: false, timestamp: now, session_id: sessionId, cwd: project }))
writeFileSync(join(jsonlDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
execFileSync("sqlite3", [sandbox.db, `INSERT INTO session (${cols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, rested_at)
  VALUES (${vals}'${slug}', '${sessionId}', 'ntwine-${slug}', '${now}', 'File preview stack', 'claude', 'opus', 'high', 'default', '${now}')`])
console.log(JSON.stringify({ slug, docs }))
