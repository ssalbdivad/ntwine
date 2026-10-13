// LIVE end-to-end proof that a real Claude worker reaches Frizz through `frizzctl`, against real claude:
//   nub packages/server/src/backend/_live_broker_frizzctl.mts
//
// A unit test cannot prove this. The command line replaced the Frizz MCP tools on 2026-10-11, and every
// link between a worker's model and the server now runs through things only the real claude binary
// decides: whether the plugin's `bin/` is on the PATH of the shell its Bash tool starts, whether that
// shell inherits the environment the broker forked the daemon with, and whether the `Bash(frizzctl:*)`
// pre-approval matches the command forms the contract teaches. Get any of them wrong and the suite stays
// green while a worker cannot name its thread, ask a question or sign off.
//
// The worker is real (real bridge, real daemon, real claude, the real cc-worker plugin, the environment
// built by the same `resolveFrizzCli` / `claudeCliConfig` the server calls). Frizz's RPC surface is a
// recording http server, because the claim under test is what ARRIVES, not what the router does with it.
//
// Proves:
//   1. `frizzctl` resolves by BARE NAME in a worker's Bash tool, to the plugin's own bin/
//   2. the request it sends names THIS thread and THIS project, from the environment alone
//   3. the worker is mounted NO `mcp__frizz__*` tool
//   4. on a thread in `default` mode, where every Bash call that is not read-only becomes an approval
//      card, a bare `frizzctl …`, a quoted heredoc into `--input -`, and `frizzctl … && frizzctl …` all
//      run with NO card
//   5. NEGATIVE CONTROL: on that same thread an ordinary writing command DOES raise a card — so (4) is
//      the pre-approval working and not a thread that never asks
import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdirSync, mkdtempSync, readdirSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import Database from "../sqlite.ts"
import { createInteractionStore } from "../interaction-store.ts"
import { createClaudeAgentBrokerBridge } from "./claude-agent-broker-bridge.ts"
import { readClaudeBrokerDiagnostics } from "./claude-broker-diagnostics.ts"
import { claudeCliConfig, resolveFrizzCli } from "../dispatch.ts"
import type { InteractionRecord } from "@frizz/shared"

const claudeBin = process.env.CLAUDE_BIN ?? execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const projectId = "live-cli"
// `<root>/projects/<project id>`: the shape of a real project state dir, which is where the command
// line reads its project id when nothing hands it one.
const root = realpathSync(mkdtempSync(join(tmpdir(), "frizzctl-live-")))
const stateDir = join(root, "projects", projectId)
mkdirSync(stateDir, { recursive: true })
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "frizzctl-repo-"))); execFileSync("git", ["init", "-q", cwd])
const db = new Database(join(stateDir, "ui.db")); db.pragma("journal_mode = WAL")
const interactions = createInteractionStore(db)

let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---- the recording stand-in for Frizz's RPC surface ------------------------------------------------
interface Seen { procedure: string; project: string; body: any }
const seen: Seen[] = []
const http = createServer((req, res) => {
  let raw = ""
  req.on("data", (c) => (raw += c))
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : undefined
    const match = /^\/_frizz\/([^/]+)\/rpc\/(.+)$/.exec(req.url ?? "")
    const procedure = match?.[2] ?? req.url ?? ""
    seen.push({ procedure, project: match?.[1] ?? "", body })
    const result =
      procedure === "setOwnThreadTitle" ? { accepted: true, title: body.title }
      : procedure === "ask" ? { registered: body.questions.map((q: any, i: number) => ({ id: `qst_live${i}`, spec: q })) }
      : {}
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ result }))
  })
})
await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port: (http.address() as { port: number }).port }))

const pluginDir = join(import.meta.dirname, "..", "..", "..", "..", "cc-worker")
const cli = resolveFrizzCli({ stateDir, projectId }, pluginDir)
ok("the worker plugin carries frizzctl", cli !== undefined, pluginDir)
if (!cli) process.exit(1)
const config = claudeCliConfig(cli)
ok("the worker is handed no Frizz MCP server and the one pre-approval", Object.keys(config.mcpServers).length === 0 && config.allowedTools.join() === "Bash(frizzctl:*)", JSON.stringify(config))

const bridge = createClaudeAgentBrokerBridge({
  stateDir, executablePath: claudeBin, interactions, projectId,
  env: Object.fromEntries(["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"].filter((k) => process.env[k]).map((k) => [k, process.env[k]!])),
  // The same four fields context.ts builds for a real project.
  workerEnv: { pluginDir, ...config, permDir: join(stateDir, "perm-requests"), cli },
  onDiagnostic: (_slug, _sid, diagnostic) => console.log("[diag]", JSON.stringify(diagnostic).slice(0, 400)),
})

function transcriptText(sessionId: string): string {
  const base = join(homedir(), ".claude", "projects")
  if (!existsSync(base)) return ""
  for (const dir of readdirSync(base)) {
    const file = join(base, dir, `${sessionId}.jsonl`)
    if (existsSync(file)) { try { return readFileSync(file, "utf8") } catch { return "" } }
  }
  return ""
}

interface Block { type?: string; text?: string; name?: string; input?: { command?: string } }
function assistantBlocks(sessionId: string): Block[] {
  const out: Block[] = []
  for (const line of transcriptText(sessionId).split("\n")) {
    if (!line.trim()) continue
    let record: { type?: string; message?: { content?: unknown } }
    try { record = JSON.parse(line) } catch { continue }
    if (record.type !== "assistant" || !Array.isArray(record.message?.content)) continue
    out.push(...(record.message.content as Block[]))
  }
  return out
}
// ONLY the model's own words: every token a prompt asks for is also IN that prompt, so a match against
// the raw transcript passes whether or not the model said it.
const assistantText = (sessionId: string) => assistantBlocks(sessionId).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n")
const bashCommands = (sessionId: string) => assistantBlocks(sessionId).filter((b) => b.type === "tool_use" && b.name === "Bash").map((b) => b.input?.command ?? "")
const toolNames = (sessionId: string) => [...new Set(assistantBlocks(sessionId).filter((b) => b.type === "tool_use").map((b) => b.name ?? ""))]

interface Thread { slug: string; sessionId: string }
const scopeOf = (t: Thread) => ({ projectId, threadSlug: t.slug, sessionId: t.sessionId })

/** Wait until the model has said `needle`, noting every card that went pending on the way. */
async function turn(t: Thread, needle: string, timeoutMs = 240_000): Promise<{ said: boolean; cards: InteractionRecord[] }> {
  const cards = new Map<string, InteractionRecord>()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const card of interactions.listPending(scopeOf(t))) cards.set(card.id, card)
    if (assistantText(t.sessionId).includes(needle)) return { said: true, cards: [...cards.values()] }
    // A card nobody answers would hold the turn until the deadline; one is already the finding.
    if (cards.size > 0) return { said: false, cards: [...cards.values()] }
    if (!bridge.isDaemonAlive(t.sessionId)) break
    await sleep(1_000)
  }
  return { said: false, cards: [...cards.values()] }
}
const describe = (cards: InteractionRecord[]) => cards.map((c) => `${c.payload.kind}: ${JSON.stringify("title" in c.payload ? c.payload.title : "")}`).join("; ")
function cancel(t: Thread, card: InteractionRecord) {
  interactions.cancel(scopeOf(t), {
    slug: t.slug, sessionId: t.sessionId, interactionId: card.id,
    sessionEpoch: card.owner.sessionEpoch, capabilityRevision: card.owner.capabilityRevision,
    expectedRecordRevision: card.recordRevision,
  })
}
const requests = (procedure: string, slug: string) => seen.filter((s) => s.procedure === procedure && s.body?.slug === slug)

const open: Thread[] = []
try {
  // ---- 1-3. the ordinary worker: full access, the mode Frizz dispatches in -----------------------
  const a: Thread = { slug: "cli-live-a", sessionId: randomUUID() }
  open.push(a)
  await bridge.spawnDispatch({
    threadSlug: a.slug, sessionId: a.sessionId, cwd, model: "haiku", permissionMode: "bypassPermissions",
    prompt: "Run this exact shell command with the Bash tool, exactly as written, as ONE call, before anything else:\n\n" +
      'frizzctl title "Live CLI probe"; echo "exit=$?"; command -v frizzctl\n\n' +
      "Then reply with exactly two lines and stop. Line one: WHERE=<the last line the command printed>. " +
      "Line two: MCPTOOLS=<a comma-separated list of every tool you have whose name starts with mcp__frizz, or NONE>.",
  })
  const first = await turn(a, "WHERE=")
  ok("the worker ran the command and reported", first.said, assistantText(a.sessionId).slice(-300))
  const said = assistantText(a.sessionId)
  ok("1. `frizzctl` resolved by bare name, to the plugin's own bin/", said.includes(`WHERE=${join(cli.binDir, "frizzctl")}`), /WHERE=.*/.exec(said)?.[0])
  const titled = requests("setOwnThreadTitle", a.slug)
  ok("2. the request reached Frizz naming this thread", titled.length === 1 && titled[0]!.body.title === "Live CLI probe", JSON.stringify(seen))
  ok("2. …and this project", titled[0]?.project === projectId, titled[0]?.project)
  ok("3. the worker says it has no mcp__frizz tool", /MCPTOOLS=\s*NONE/u.test(said), /MCPTOOLS=.*/.exec(said)?.[0])
  ok("3. …and it called none", toolNames(a.sessionId).every((name) => !name.startsWith("mcp__frizz")), toolNames(a.sessionId).join(","))

  // ---- 4. a thread the human moved to `default`: no card for any form the contract teaches -------
  const b: Thread = { slug: "cli-live-b", sessionId: randomUUID() }
  open.push(b)
  await bridge.spawnDispatch({
    threadSlug: b.slug, sessionId: b.sessionId, cwd, model: "haiku", permissionMode: "default",
    prompt: "Run this exact shell command with the Bash tool, exactly as written, as ONE call:\n\n" +
      'frizzctl title "Default mode probe"\n\n' +
      "Then reply with the single line BARE-RAN and stop. If the command is refused or needs approval, do not try anything else.",
  })
  const bare = await turn(b, "BARE-RAN")
  ok("4a. a bare `frizzctl …` ran with no approval card", bare.said && bare.cards.length === 0, describe(bare.cards) || assistantText(b.sessionId).slice(-200))
  ok("4a. …and reached Frizz", requests("setOwnThreadTitle", b.slug).some((s) => s.body.title === "Default mode probe"))
  for (const card of bare.cards) cancel(b, card)

  await bridge.followUp({
    threadSlug: b.slug, sessionId: b.sessionId, cwd,
    text: "Now run this exact shell command with the Bash tool as ONE call. It is three lines — a heredoc — and must be sent exactly as written:\n\n" +
      "frizzctl ask --input - <<'EOF'\n" +
      '{"question":"Ship the `beta` build?","kind":"question","options":[{"label":"Yes","description":"go"},{"label":"No","description":"wait"}]}\n' +
      "EOF\n\n" +
      "Then reply with the single line HEREDOC-RAN and stop. If the command is refused or needs approval, do not try anything else.",
  })
  const heredoc = await turn(b, "HEREDOC-RAN")
  ok("4b. a quoted heredoc into `--input -` ran with no approval card", heredoc.said && heredoc.cards.length === 0, describe(heredoc.cards) || assistantText(b.sessionId).slice(-200))
  const asked = requests("ask", b.slug)
  ok("4b. …and the question reached Frizz intact", asked.length === 1 && asked[0]!.body.questions?.[0]?.question === "Ship the `beta` build?", JSON.stringify(asked.map((s) => s.body)))
  for (const card of heredoc.cards) cancel(b, card)

  await bridge.followUp({
    threadSlug: b.slug, sessionId: b.sessionId, cwd,
    text: "Now run this exact shell command with the Bash tool as ONE call:\n\n" +
      'frizzctl title "Chained probe" && frizzctl activity\n\n' +
      "Then reply with the single line CHAIN-RAN and stop. If the command is refused or needs approval, do not try anything else.",
  })
  const chain = await turn(b, "CHAIN-RAN")
  ok("4c. `frizzctl … && frizzctl …` ran with no approval card", chain.said && chain.cards.length === 0, describe(chain.cards) || assistantText(b.sessionId).slice(-200))
  ok("4c. …and both halves reached Frizz", requests("setOwnThreadTitle", b.slug).some((s) => s.body.title === "Chained probe") && requests("listOwnThreadActivity", b.slug).length === 1)
  for (const card of chain.cards) cancel(b, card)

  // ---- 5. the negative control ---------------------------------------------------------------------
  await bridge.followUp({
    threadSlug: b.slug, sessionId: b.sessionId, cwd,
    text: "Now run this exact shell command with the Bash tool as ONE call:\n\n" +
      "touch control-marker.txt\n\n" +
      "Then reply with the single line CONTROL-RAN and stop. If the command is refused, reply CONTROL-REFUSED and stop.",
  })
  const control = await turn(b, "CONTROL-")
  ok("5. an ordinary writing command on the same thread DID raise an approval card", control.cards.length > 0, describe(control.cards) || assistantText(b.sessionId).slice(-200))
  ok("5. …and did not run without it", !existsSync(join(cwd, "control-marker.txt")))
  for (const card of control.cards) cancel(b, card)

  console.log("\nBash calls the workers made:")
  for (const t of open) for (const command of bashCommands(t.sessionId)) console.log(`  [${t.slug}] ${JSON.stringify(command)}`)
  for (const t of open) ok(`no crashed lifecycle diagnostic (${t.slug})`, !readClaudeBrokerDiagnostics(stateDir, t.sessionId).some((r) => r.diagnostic.kind === "lifecycle" && r.diagnostic.phase === "crashed"))
} catch (error) {
  failures++
  console.log("FAIL  harness threw —", error instanceof Error ? (error.stack ?? error.message) : String(error))
} finally {
  for (const t of open) bridge.releaseSession(t.slug, t.sessionId, "session-deleted")
  bridge.close()
  http.close()
  await sleep(1_000)
  try { db.close() } catch {}
  // CLI_KEEP=1 preserves the state dir + repo for post-mortem on a failed run.
  if (!process.env.CLI_KEEP) {
    rmSync(root, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  } else console.log(`kept stateDir=${stateDir} cwd=${cwd}`)
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
