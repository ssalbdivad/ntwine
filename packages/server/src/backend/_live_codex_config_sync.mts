// LIVE proof (not a unit test; excluded from the *.test.ts glob). After a Frizz update, what does a
// Codex thread that was already running end up on — and is anything it was doing lost on the way?
//
//   env -u NODE_COMPAT nub packages/server/src/backend/_live_codex_config_sync.mts
//   … --control      the same run with FRIZZ_PLUGIN_SYNC_OFF=1: the thread that was mid-turn must
//                    STAY on the old generation, or the run above proves nothing about the rebuild
//   CODEX_BIN=/path/to/codex overrides the binary (default: Frizz's own provisioned pin, then PATH)
//
// NEEDS NO CODEX SIGN-IN. Codex is pointed at a local mock Responses provider under a temporary
// CODEX_HOME, so a real turn runs — hooks fire, the MCP tool is listed and called, a background command
// is started — and the mock records the request the model would have been sent. What it cannot show is
// what a model would have CHOSEN to do; nothing here depends on that.
//
// The flow is the real one: the REAL CodexAppServerBridge over the REAL production transport (a detached
// `codex app-server --listen unix://`), the real per-thread MCP mount and the real hook config. "A Frizz
// update" is exactly what the code sees: bridge A is built with generation A's MCP script and hooks,
// then closed, which leaves the listener running as a server exit does; bridge B is built over the same
// database with generation B's. Three threads cross it:
//
//   IDLE     at rest when the old server went away
//   MIDTURN  a turn still running when the old server went away
//   EXEC     at rest, with a background command (`sleep`) still running
//
// PASS: IDLE and MIDTURN answer their next turn from generation B's MCP script with generation B's hooks
// and the reasoning summary still on; MIDTURN's running turn is never touched; EXEC's command survives
// the new server's start and the thread stays on generation A until the command has ended, then moves;
// and it is one app-server process throughout — a rebuild in place, not a restart.
//
// This is also the check that a Codex bump has not changed what `thread/resume` does with a config bag
// (see threadConfig in codex-app-server.ts): the rule was measured on 0.161.0 and nothing documents it.
import { execFileSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { createServer, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "../sqlite.ts"
import { createInteractionStore } from "../interaction-store.ts"
import { codexScratchpadHookConfig } from "../dispatch.ts"
import { provisionedBinary, runtimesRoot } from "../runtimes.ts"
import { CODEX_APP_SERVER_SUPPORTED_VERSION, CodexAppServerBridge } from "./codex-app-server.ts"
import { killNativeListener, nativeListenCodexAppServerHost, readNativeRecord } from "./codex-app-server-native.ts"

const CONTROL = process.argv.includes("--control")
if (CONTROL) process.env.FRIZZ_PLUGIN_SYNC_OFF = "1"
else delete process.env.FRIZZ_PLUGIN_SYNC_OFF
// The binary Frizz itself runs: its own provisioned pin (runtimes.ts), which is the audited version.
const CODEX_BIN = process.env.CODEX_BIN
  || provisionedBinary("codex", runtimesRoot(), CODEX_APP_SERVER_SUPPORTED_VERSION)
  || "codex"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const root = realpathSync(mkdtempSync(join(tmpdir(), "frizz-codex-config-sync-")))
const codexHome = join(root, "codex-home")
const repo = join(root, "repo")
mkdirSync(codexHome); mkdirSync(repo)
execFileSync("git", ["init", "-q", repo])
writeFileSync(join(repo, "README.md"), "probe repo\n")
// Inherited by the app-server (codexAppServerEnvironment), so nothing reads or writes the real ~/.codex.
process.env.CODEX_HOME = codexHome

// ---- two server generations on disk: an MCP script and a hooks directory each ----------------------
const mcpEvents = join(root, "mcp-events.jsonl")
const hooksLog = join(root, "hooks.log")
type Generation = "A" | "B"
const generation = {} as Record<Generation, { mcp: string; hook: string }>
for (const g of ["A", "B"] as const) {
  const dir = join(root, `generation-${g}`, "runtime", "cc-worker")
  mkdirSync(join(dir, "bin"), { recursive: true }); mkdirSync(join(dir, "hooks"), { recursive: true })
  const mcp = join(dir, "bin", "frizz-mcp.mjs")
  // A dependency-free stdio MCP server with one tool, which answers with the path of its own file.
  writeFileSync(mcp, `
import { appendFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
const SELF = fileURLToPath(import.meta.url)
appendFileSync(${JSON.stringify(mcpEvents)}, JSON.stringify({ pid: process.pid, copy: SELF }) + "\\n")
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n")
const reply = (id, result) => send({ jsonrpc: "2.0", id, result })
function handle({ id, method, params } = {}) {
  if (method === "initialize") return reply(id, { protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "frizzprobe", version: "0.0.1" } })
  if (method === "tools/list") return reply(id, { tools: [{ name: "probe_ping", description: "Say which copy of the probe server answered.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] })
  if (method === "tools/call") return reply(id, { content: [{ type: "text", text: "answered by " + SELF + " pid " + process.pid }] })
  if (method === "ping") return reply(id, {})
  if (id != null) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } })
}
let buf = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buf += chunk
  for (let nl; (nl = buf.indexOf("\\n")) >= 0;) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
    if (line) try { handle(JSON.parse(line)) } catch {}
  }
})
process.stdin.on("end", () => process.exit(0))
process.on("SIGTERM", () => process.exit(0))
`)
  // Both hook scripts log which generation's copy ran, and for which event.
  for (const name of ["scratchpad.mjs", "bash-background.mjs"]) {
    writeFileSync(join(dir, "hooks", name), `
import { appendFileSync, readFileSync } from "node:fs"
let input = {}
try { input = JSON.parse(readFileSync(0, "utf8")) } catch {}
appendFileSync(${JSON.stringify(hooksLog)}, JSON.stringify({ gen: ${JSON.stringify(g)}, event: input.hook_event_name ?? "?", source: input.source ?? null }) + "\\n")
`)
  }
  generation[g] = { mcp, hook: join(dir, "hooks", "scratchpad.mjs") }
}
const generationOf = (path: string): string => (path.includes("generation-A") ? "A" : path.includes("generation-B") ? "B" : "?")

// ---- the mock model ---------------------------------------------------------------------------------
// One verb per user message: CALL_PROBE calls the MCP tool, SLOW_TURN holds the response open (a turn
// that is still running), START_BG starts a background command, anything else just answers.
const BG_SECONDS = 70_000 + (process.pid % 9_000) // unique, so `pgrep` can only ever find our own
interface ResponsesBody { input?: Array<Record<string, any>>; tools?: Array<Record<string, any>>; reasoning?: { summary?: string } }
const requests: ResponsesBody[] = []
const userText = (item: Record<string, any>): string =>
  item.type === "message" && item.role === "user" ? (item.content ?? []).map((c: { text?: string }) => c.text ?? "").join("") : ""
const mock = createServer((req, res) => {
  let raw = ""
  req.on("data", (chunk) => { raw += chunk })
  req.on("end", () => {
    if (req.method !== "POST" || !/\/responses$/.test((req.url ?? "").split("?")[0]!)) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "mock: not found" } }))
      return
    }
    const body = JSON.parse(raw) as ResponsesBody
    const index = requests.push(body) - 1
    const input = body.input ?? []
    const at = input.findLastIndex((item) => /CALL_PROBE|SLOW_TURN|START_BG|PLAIN/.test(userText(item)))
    const text = at >= 0 ? userText(input[at]!) : ""
    const called = input.slice(at + 1).some((item) => /function_call/.test(String(item.type ?? "")))
    const tools = (body.tools ?? []).flatMap((tool) => (Array.isArray(tool.tools) ? tool.tools.map((inner: Record<string, any>) => ({ ...inner, namespace: tool.name })) : [tool]))
    const call = (name: RegExp, args: Record<string, unknown>) => {
      const tool = tools.find((candidate) => name.test(String(candidate.name ?? "")))
      return tool ? { type: "function_call", id: `fc_${index}`, call_id: `call_${index}`, name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}), arguments: JSON.stringify(args) } : undefined
    }
    const say = (words: string) => ({ type: "message", role: "assistant", id: `msg_${index}`, content: [{ type: "output_text", text: words }] })
    const item = (!called && text.includes("CALL_PROBE") && call(/probe_ping/, {}))
      || (!called && text.includes("START_BG") && call(/^exec_command$/, { cmd: `sleep ${BG_SECONDS}`, yield_time_ms: 500 }))
      || say("done")
    stream(res, `resp_${index}`, item, !called && text.includes("SLOW_TURN") ? 12_000 : 0)
  })
})
function stream(res: ServerResponse, id: string, item: unknown, holdMs: number): void {
  const write = (event: { type: string }) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  write({ type: "response.created", response: { id } } as { type: string })
  setTimeout(() => {
    write({ type: "response.output_item.done", item } as { type: string })
    write({ type: "response.completed", response: { id, usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } } as { type: string })
    res.end()
  }, holdMs)
}
await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve))
const mockPort = (mock.address() as { port: number }).port
writeFileSync(join(codexHome, "config.toml"), [
  `model = "mock-model"`, `model_provider = "mock"`,
  `[model_providers.mock]`, `name = "mock"`, `base_url = "http://127.0.0.1:${mockPort}/v1"`, `wire_api = "responses"`, ``,
].join("\n"))

// ---- bridges ----------------------------------------------------------------------------------------
const diagnostics: Array<{ event: string; threadSlug?: string }> = []
function makeBridge(g: Generation) {
  const db = new Database(join(root, "ui.db"))
  db.pragma("journal_mode = WAL")
  let interactionId = 0, clientId = 0
  const interactions = createInteractionStore(db, { now: () => new Date(), id: () => `i-${g}-${++interactionId}` })
  const bridge = new CodexAppServerBridge({
    projectId: "probe", projectDir: repo, stateDir: root, db, interactions,
    // What context.ts hands the bridge: this generation's own MCP script, and this generation's hooks.
    frizzMcp: { scriptPath: generation[g].mcp, stateDir: root, projectId: "probe" },
    workerConfig: (_slug, sessionId) => ({ model_reasoning_summary: "detailed", ...codexScratchpadHookConfig(generation[g].hook, sessionId) }),
    codexBin: CODEX_BIN, host: nativeListenCodexAppServerHost,
    now: () => new Date(), id: () => `c-${g}-${++clientId}`, requestTimeoutMs: 60_000,
    diagnostic: (event) => { diagnostics.push(event) },
  })
  return { bridge, close: () => { bridge.close(); interactions.dispose?.(); db.close() } }
}
interface Thread { threadSlug: string; sessionId: string }
const IDLE: Thread = { threadSlug: "idle-thread", sessionId: "session-idle" }
const MIDTURN: Thread = { threadSlug: "midturn-thread", sessionId: "session-midturn" }
const EXEC: Thread = { threadSlug: "exec-thread", sessionId: "session-exec" }

async function turnEnded(bridge: CodexAppServerBridge, thread: Thread, ms = 60_000): Promise<boolean> {
  for (const start = Date.now(); Date.now() - start < ms; await sleep(100)) {
    if (bridge.binding(thread.threadSlug, thread.sessionId)?.currentTurnId == null) return true
  }
  return false
}
let hookCursor = 0
function hooksSince(): string[] {
  const all = existsSync(hooksLog) ? readFileSync(hooksLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { gen: string; event: string; source: string | null }) : []
  const fresh = all.slice(hookCursor)
  hookCursor = all.length
  return fresh.map((entry) => `gen${entry.gen}:${entry.event}${entry.source ? `(${entry.source})` : ""}`)
}
/** One follow-up through the entry point the router uses, and everything the thread ran it on. */
async function probe(bridge: CodexAppServerBridge, thread: Thread) {
  hooksSince()
  const from = requests.length
  await bridge.followUp({ ...thread, text: "CALL_PROBE" })
  const ended = await turnEnded(bridge, thread)
  await sleep(400)
  const seen = requests.slice(from)
  const output = JSON.stringify(seen.at(-1)?.input?.findLast((item) => /output/.test(String(item.type ?? ""))) ?? "")
  const answered = output.match(/answered by (\S+?frizz-mcp\.mjs) pid (\d+)/)
  return {
    ended,
    mcp: answered ? generationOf(answered[1]!) : "none",
    mcpPid: answered ? Number(answered[2]) : undefined,
    hooks: hooksSince(),
    summary: seen[0]?.reasoning?.summary ?? null,
  }
}
const sleepPids = (): number[] => {
  try { return execFileSync("pgrep", ["-f", `sleep ${BG_SECONDS}`]).toString().trim().split("\n").filter(Boolean).map(Number) } catch { return [] }
}

let failures = 0
function check(label: string, ok: boolean, detail: unknown = ""): void {
  if (!ok) failures++
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`)
}
const onGeneration = (g: Generation, reading: Awaited<ReturnType<typeof probe>>): boolean =>
  reading.mcp === g
  && reading.hooks.includes(`gen${g}:UserPromptSubmit`) && reading.hooks.includes(`gen${g}:PostToolUse`)
  && !reading.hooks.some((hook) => !hook.startsWith(`gen${g}:`))
  && reading.summary === "detailed"

let listenerPid = -1
try {
  console.log(`[config-sync] ${CONTROL ? "CONTROL (FRIZZ_PLUGIN_SYNC_OFF=1)" : "proof"} · codex ${CODEX_BIN}\n[config-sync] workspace ${root}`)
  console.log("\n-- generation A's server dispatches three Codex threads --")
  const one = makeBridge("A")
  for (const thread of [IDLE, MIDTURN, EXEC]) {
    // No `config` on the dispatch: the hooks are the bridge's to send, as dispatch.ts now leaves them.
    await one.bridge.spawnDispatch({ ...thread, cwd: repo, prompt: "PLAIN first turn", sandbox: "read-only", baseInstructions: "WORKER CONTRACT" })
    await turnEnded(one.bridge, thread)
  }
  listenerPid = readNativeRecord(root, "probe")!.listenerPid
  check("the dispatch itself registered the hooks, with nothing passed to it", hooksSince().filter((hook) => hook === "genA:SessionStart(startup)").length === 3)
  for (const thread of [IDLE, MIDTURN, EXEC]) {
    const before = await probe(one.bridge, thread)
    check(`${thread.threadSlug} runs on generation A before the update`, onGeneration("A", before), before)
  }
  await one.bridge.followUp({ ...EXEC, text: "START_BG" })
  await turnEnded(one.bridge, EXEC)
  await sleep(500)
  const command = sleepPids()
  check("the EXEC thread has a background command running", command.length === 1 && one.bridge.backgroundExecs(EXEC.threadSlug, EXEC.sessionId).length === 1, command)

  console.log("\n-- the update: server A exits with MIDTURN mid-turn, server B starts --")
  await one.bridge.followUp({ ...MIDTURN, text: "SLOW_TURN" })
  await sleep(1_500)
  one.close()
  check("the app-server outlived the server that started it", alive(listenerPid))
  await sleep(2_000)
  const two = makeBridge("B")
  await two.bridge.warmUp()
  await sleep(1_000)
  check("server B attached to the same app-server", readNativeRecord(root, "probe")!.listenerPid === listenerPid)
  check("MIDTURN's turn is still running under server B", two.bridge.binding(MIDTURN.threadSlug, MIDTURN.sessionId)?.currentTurnId != null)
  check("the background command SURVIVED server B's start", command.every(alive) && sleepPids().length === 1, sleepPids())
  check("and server B knows it is running", two.bridge.backgroundExecs(EXEC.threadSlug, EXEC.sessionId).length === 1)

  console.log("\n-- each thread's next turn, from server B --")
  const idleAfter = await probe(two.bridge, IDLE)
  check("IDLE moved to generation B: its MCP script, its hooks, summaries still on", onGeneration("B", idleAfter), idleAfter)
  check("a resume is what the hook was told, so the real hook can stay silent", idleAfter.hooks.includes("genB:SessionStart(resume)"), idleAfter.hooks)

  const execDuring = await probe(two.bridge, EXEC)
  check("EXEC is left on generation A while its command runs", execDuring.mcp === "A" && execDuring.hooks.every((hook) => hook.startsWith("genA:")), execDuring)
  check("and the command is still running after that turn", command.every(alive))

  check("MIDTURN's running turn finished on its own under server B", await turnEnded(two.bridge, MIDTURN, 40_000))
  hooksSince()
  const midAfter = await probe(two.bridge, MIDTURN)
  if (CONTROL) {
    check("CONTROL: with the sync off, MIDTURN stays on generation A", onGeneration("A", midAfter), midAfter)
  } else {
    check("MIDTURN moved to generation B before its next turn", onGeneration("B", midAfter), midAfter)
    check("and the bridge put that rebuild on the record", diagnostics.some((event) => event.event === "thread-config-reloaded" && event.threadSlug === MIDTURN.threadSlug))
    const again = await probe(two.bridge, MIDTURN)
    check("once: the next turn is answered by the same MCP process", again.mcp === "B" && again.mcpPid === midAfter.mcpPid && !again.hooks.some((hook) => hook.includes("SessionStart")), again)
  }

  console.log("\n-- the background command ends --")
  for (const pid of command) { try { process.kill(pid, "SIGTERM") } catch { /* already gone */ } }
  for (const start = Date.now(); Date.now() - start < 15_000 && two.bridge.backgroundExecs(EXEC.threadSlug, EXEC.sessionId).length > 0; await sleep(200)) { /* wait for item/completed */ }
  check("server B heard the command end", two.bridge.backgroundExecs(EXEC.threadSlug, EXEC.sessionId).length === 0)
  const execAfter = await probe(two.bridge, EXEC)
  if (CONTROL) check("CONTROL: with the sync off, EXEC stays on generation A", onGeneration("A", execAfter), execAfter)
  else check("EXEC moved to generation B once nothing of its own could be lost", onGeneration("B", execAfter), execAfter)

  check("one app-server process throughout — a rebuild in place, never a restart", alive(listenerPid) && readNativeRecord(root, "probe")!.listenerPid === listenerPid)
  check("no thread lost the unsubscribe path", !diagnostics.some((event) => event.event === "thread-config-sync-unavailable"))
  two.close()
} catch (error) {
  failures++
  console.error("HARNESS ERROR:", (error as Error).stack ?? error)
} finally {
  // The listener is detached by design; end exactly the one this run's own record names.
  try { killNativeListener(root, "probe") } catch { /* never started */ }
  await sleep(1_500)
  if (listenerPid > 0 && alive(listenerPid)) { try { process.kill(listenerPid, "SIGKILL") } catch { /* gone */ } }
  for (const pid of sleepPids()) { try { process.kill(pid, "SIGTERM") } catch { /* gone */ } }
  await new Promise<void>((resolve) => { mock.closeAllConnections?.(); mock.close(() => resolve()) })
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}${CONTROL ? " (control)" : ""}`)
  process.exit(failures === 0 ? 0 : 1)
}
