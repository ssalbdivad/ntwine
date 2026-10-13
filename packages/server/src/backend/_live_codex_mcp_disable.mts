// LIVE probe (not a unit test; excluded from the *.test.ts glob). Can a NEW Codex thread switch off
// the `frizz` MCP server that an app-server started BEFORE the update mounted on its own argv?
//
//   env -u NODE_COMPAT nub packages/server/src/backend/_live_codex_mcp_disable.mts
//   CODEX_BIN=/path/to/codex overrides the binary (default: Frizz's own provisioned pin, then PATH)
//   PROBE_MODEL=<slug> overrides the model slug the tool list is built for (default gpt-5.6-sol)
//
// Why it exists. Until this branch every app-server was started with a process-wide `frizz` MCP
// mount on its argv (`-c mcp_servers.frizz={command, args, cwd, env, …}`, codexMcpConfigArgs). The
// branch stops passing it, but an app-server started BEFORE the update survives it (Frizz reattaches),
// so a NEW thread started there still gets `mcp__frizz__*` from the argv, with no thread identity in
// the child's env, and every call that acts on the caller's own thread fails. The question is whether
// the new thread's OWN config bag can switch that mount off, and in a spelling that also starts on a
// post-update app-server that has no `frizz` entry at all.
//
// NEEDS NO CODEX SIGN-IN and spends no quota: the instrument of `_live_codex_shell_identity.mts`. The
// REAL `codex app-server --stdio`, driven over raw JSON-RPC, argv from the real codexAppServerArgv
// (with and without a FrizzMcp), against a mock Responses provider. The mounted server is this
// checkout's real `cc-worker/bin/frizz-mcp.mjs` (it lists its 16 tools without reaching any server)
// behind a wrapper that logs every start. CODEX_HOME's config.toml also mounts the same script as an
// `operator` server: whatever switches Frizz's mount off must leave an operator's own server alone.
//
// WHAT "CALLABLE" MEANS here. gpt-5.6-sol runs in code mode and the request lists NO MCP tool at all
// ("Some deferred nested tools may be omitted from this description"), so its reading is the `exec`
// isolate's own `ALL_TOOLS`, which the mock's script prints. `PROBE_MODEL=mock-model` is offered MCP
// tools in the request itself (as `mcp__frizz.<tool>`) and gave the same 28 readings.
//
// MEASURED 2026-10-11 against codex-cli 0.161.0 (macOS arm64). Every line is a `finding()` below and
// the run exits 1 if one stops holding:
//
//   1. Control: a thread with no MCP keys on the pre-update app-server can call all 16
//      `mcp__frizz__*` tools, and its child was started with no FRIZZ_THREAD_SLUG.
//   2. `config: { "mcp_servers.frizz.enabled": false }` on that app-server: thread/start succeeds, no
//      frizz tool is callable, and no frizz process starts. The operator's server is untouched.
//   3. The same bag on a post-update app-server (no argv entry) is REFUSED by thread/start:
//      `-32600: failed to load configuration: invalid transport\nin \`mcp_servers.frizz\``. Nothing
//      else reports it: no stderr line, no notification. A dotted key MERGES into an existing entry,
//      and with nothing to merge into, `{enabled: false}` alone is not a server.
//   4. Per spelling (pre-update / post-update):
//        "mcp_servers.frizz.enabled": false                       OFF     / REFUSED
//        mcp_servers: { frizz: { enabled: false } }                REFUSED / REFUSED
//        "mcp_servers.frizz.enabled_tools": []                     OFF     / REFUSED  (process still starts)
//        "mcp_servers.frizz.disabled_tools": [all 16]              OFF     / REFUSED  (process still starts)
//        "mcp_servers.frizz": {}                                   REFUSED / REFUSED
//        mcp_servers: {}                                           OFF     / OFF
//        "mcp_servers.frizz.enabled": false + ".command": "/usr/bin/true"   OFF / OFF
//      A NESTED `mcp_servers` table in the bag REPLACES the argv's whole `mcp_servers` layer (so `{}`
//      drops the argv mount, and `{frizz: {enabled: false}}` is an entry with no transport), while
//      config.toml's servers survive every spelling. The two that work on BOTH shapes are
//      `mcp_servers: {}` and `enabled: false` with a command of its own; neither starts a frizz process.
//      Also: the argv's top-level `default_tools_approval_mode="approve"` is IGNORED by 0.161.0, with
//      a `warning` notification on every thread ("session-flags: `default_tools_approval_mode` is
//      ignored"); only the per-entry key does anything.
//   5. Both working spellings survive `thread/resume` on a FRESH pre-update app-server when the bag is
//      re-sent, and a `spawn_agent` child of such a thread has no frizz tool either. Resumed WITHOUT
//      the bag, a thread gets all 16 back: the switch is not in the rollout. Controls: the no-bag
//      thread's resume and its child both have all 16.
//
//   6. THE BAG FRIZZ SHIPS for a thread taught frizzctl, `{ ...codexThreadMcpOff(), ...codexThreadShellConfig(…) }`
//      imported and sent untouched, on BOTH a pre-update app-server (argv mount) and a post-update one:
//      thread/start succeeds, no frizz tool is callable (the operator's 16 are), and the thread's shell
//      runs bare `frizzctl title "…"` from this checkout, exit 0, with exactly one setOwnThreadTitle
//      reaching the fake Frizz under that thread's slug. The process PATH carries no `cc-worker/bin`.
//
// NOT covered: the `--listen unix://` (native) transport, which shares the argv builder; a thread
// that should KEEP the per-thread mount (codexThreadMcpConfig) while a sibling switches the argv one
// off; Codex versions other than 0.161.0.
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { createServer, type Server, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { provisionedBinary, runtimesRoot } from "../runtimes.ts"
import { CLIENT_CAPABILITIES, CLIENT_INFO, CODEX_APP_SERVER_SUPPORTED_VERSION } from "./codex-app-server.ts"
import { codexAppServerArgv, codexThreadMcpOff } from "./codex-mcp.ts"
import { codexThreadShellConfig } from "./codex-shell-env.ts"
import type { FrizzCli, FrizzMcp } from "./types.ts"
import { inheritWorkerEnvironment } from "./worker-env.ts"

// The binary Frizz itself runs: its own provisioned pin (runtimes.ts), which is the audited version.
const CODEX_BIN = process.env.CODEX_BIN
  || provisionedBinary("codex", runtimesRoot(), CODEX_APP_SERVER_SUPPORTED_VERSION)
  || "codex"
const MODEL = process.env.PROBE_MODEL || "gpt-5.6-sol"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const root = realpathSync(mkdtempSync(join(tmpdir(), "frizz-codex-mcp-disable-")))
const codexHome = join(root, "codex-home")
const stateDir = join(root, "frizz-root", "projects", "proj-1")
for (const dir of [codexHome, stateDir]) mkdirSync(dir, { recursive: true })

// ---- the MCP server the old argv mounted --------------------------------------------------------------
// This checkout's real `frizz-mcp.mjs` (it answers `tools/list` without reaching any server), behind a
// two-line wrapper that records every start with the thread identity it was given, if any.
const realMcp = realpathSync(fileURLToPath(new URL("../../../../cc-worker/bin/frizz-mcp.mjs", import.meta.url)))
const mcpStarts = join(root, "mcp-starts.jsonl")
const wrapper = join(root, "frizz-mcp-wrapper.mjs")
writeFileSync(wrapper, [
  `import { appendFileSync } from "node:fs"`,
  `appendFileSync(${JSON.stringify(mcpStarts)}, JSON.stringify({ pid: process.pid, slug: process.env.FRIZZ_THREAD_SLUG ?? null }) + "\\n")`,
  `await import(${JSON.stringify(pathToFileURL(realMcp).href)})`,
  ``,
].join("\n"))
const mcpStartCount = (): number => (existsSync(mcpStarts) ? readFileSync(mcpStarts, "utf8").trim().split("\n").filter(Boolean).length : 0)
const frizzMcp: FrizzMcp = { scriptPath: wrapper, stateDir, projectId: "proj-1" }
// THE TWO ARGVS, from the real builder. Before the update every app-server was started with the
// process-wide mount; after it, with none.
const PRE_ARGV = codexAppServerArgv(["--stdio"], frizzMcp)

// ---- the bag Frizz now sends a thread taught frizzctl -----------------------------------------------
// codexThreadMcpOff + codexThreadShellConfig, imported and sent untouched, with this checkout's command
// and a fake Frizz that records what reaches it (the instrument of `_live_codex_frizzctl.mts`).
const markers = join(root, "markers")
mkdirSync(markers)
const cli: FrizzCli = { binDir: realpathSync(fileURLToPath(new URL("../../../../cc-worker/bin", import.meta.url))), stateDir, projectId: "proj-1" }
interface Seen { url: string; body: any }
const seen: Seen[] = []
const fakeFrizz = createServer((req, res) => {
  let raw = ""
  req.on("data", (chunk) => { raw += chunk })
  req.on("end", () => {
    let body: any
    try { body = raw ? JSON.parse(raw) : undefined } catch { body = raw }
    seen.push({ url: req.url ?? "", body })
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ result: (req.url ?? "").endsWith("/rpc/setOwnThreadTitle") ? { accepted: true, title: body?.title } : {} }))
  })
})
const POST_ARGV = codexAppServerArgv(["--stdio"])

// ---- the mock model ---------------------------------------------------------------------------------
// The user message names one shell command; the mock answers with exactly one call of the shell tool
// the request offered, then "done". Codex really runs the command. The tool output Codex sends back on
// the next request is kept too: it is the only reading available where the sandbox forbids a write.
// PROBE_SPAWN is the same command handed to a sub-agent: the mock calls `spawn_agent` with a PROBE_RUN
// message, and the child's own request then takes the path above.
interface Run { id: string; cmd: string; login?: boolean }
interface ResponsesBody { input?: Array<Record<string, any>>; tools?: Array<Record<string, any>> }
const toolOutputs = new Map<string, string>()
const toolsOffered = new Set<string>()
// What ONE turn's first request offered, by probe id: every tool name, flattened out of its namespace,
// and separately every `mcp__frizz__*` name anywhere in the body (code mode lists a nested tool only
// inside the `exec` description).
interface Offered { tools: string[]; frizzMentions: string[] }
const offeredTo = new Map<string, Offered>()
const shellToolsUsed = new Set<string>()
// A sub-agent's task arrives as an `agent_message` whose payload sits in `encrypted_content` (the real
// provider encrypts `spawn_agent`'s message; the mock's plaintext comes back in the same field).
const messageText = (item: Record<string, any>): string =>
  item.type === "message" || item.type === "agent_message"
    ? (item.content ?? []).map((c: { text?: string; encrypted_content?: string }) => c.text ?? c.encrypted_content ?? "").join("")
    : ""
const decode = (text: string, verb: string): Run =>
  JSON.parse(Buffer.from(text.match(new RegExp(`${verb} (\\S+)`))![1]!, "base64url").toString("utf8")) as Run
const outputText = (item: Record<string, any>): string => (typeof item.output === "string" ? item.output : JSON.stringify(item.output))
let mockIndex = 0
const mock = createServer((req, res) => {
  let raw = ""
  req.on("data", (chunk) => { raw += chunk })
  req.on("end", () => {
    if (req.method !== "POST" || !/\/responses$/.test((req.url ?? "").split("?")[0]!)) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "mock: not found" } }))
      return
    }
    const index = mockIndex++
    const body = JSON.parse(raw) as ResponsesBody
    const input = body.input ?? []
    const say = (words: string) => ({ type: "message", role: "assistant", id: `msg_${index}`, content: [{ type: "output_text", text: words }] })
    // Where the tool list is depends on the model slug: `tools` on the body, or (gpt-5.6-sol on 0.161.0)
    // an `additional_tools` item in the input. Namespaces are flattened either way.
    const listed = [...(body.tools ?? []), ...input.flatMap((item) => (item.type === "additional_tools" && Array.isArray(item.tools) ? item.tools : []))]
    const tools = listed.flatMap((tool) => (Array.isArray(tool.tools) ? tool.tools.map((inner: Record<string, any>) => ({ ...inner, namespace: tool.name })) : [tool]))
    for (const tool of tools) toolsOffered.add(`${tool.namespace ? `${tool.namespace}.` : ""}${tool.name ?? tool.type}(${tool.type})`)
    const seenBy = (id: string) => {
      if (offeredTo.has(id)) return
      offeredTo.set(id, {
        tools: tools.map((tool) => `${tool.namespace ? `${tool.namespace}.` : ""}${tool.name ?? tool.type}`),
        frizzMentions: [...new Set(raw.match(/mcp__frizz__[a-z_]+/g) ?? [])].sort(),
      })
    }
    const functionCall = (name: RegExp, args: Record<string, unknown>) => {
      const tool = tools.find((candidate) => candidate.type === "function" && name.test(String(candidate.name ?? "")))
      return tool && {
        type: "function_call", id: `fc_${index}`, call_id: `call_${index}`, name: tool.name,
        ...(tool.namespace ? { namespace: tool.namespace } : {}), arguments: JSON.stringify(args),
      }
    }
    const spawnAt = input.findLastIndex((item) => /PROBE_SPAWN \S+/.test(messageText(item)))
    const at = input.findLastIndex((item) => /PROBE_RUN \S+/.test(messageText(item)))
    if (spawnAt > at) {
      // The PARENT of a sub-agent: spawn it, wait for it once, stop.
      const text = messageText(input[spawnAt]!)
      const run = decode(text, "PROBE_SPAWN")
      seenBy(`${run.id}:parent`)
      const outputs = input.slice(spawnAt + 1).filter((item) => /call_output/.test(String(item.type ?? "")))
      toolOutputs.set(`${run.id}:parent`, outputs.map(outputText).join("\n"))
      const next = outputs.length === 0
        ? functionCall(/^spawn_agent$/, { task_name: "probe_child", message: `PROBE_RUN ${text.match(/PROBE_SPAWN (\S+)/)![1]}`, fork_turns: "none" })
        : outputs.length === 1 ? functionCall(/^wait_agent$/, { timeout_ms: 30_000 }) : undefined
      return stream(res, `resp_${index}`, next ?? say("done"))
    }
    if (at < 0) {
      // A request that names a probe verb somewhere this mock does not look: keep it, to read by hand.
      if (raw.includes("PROBE_")) writeFileSync(join(root, `unmatched-request-${index}.json`), JSON.stringify(body, null, 2))
      return stream(res, `resp_${index}`, say("done"))
    }
    const run = decode(messageText(input[at]!), "PROBE_RUN")
    seenBy(run.id)
    const after = input.slice(at + 1)
    const output = after.findLast((item) => /call_output/.test(String(item.type ?? "")))
    if (output) {
      toolOutputs.set(run.id, outputText(output))
      return stream(res, `resp_${index}`, say("done"))
    }
    if (after.some((item) => /_call$/.test(String(item.type ?? "")))) return stream(res, `resp_${index}`, say("done"))
    // One whole request kept beside the markers: its tool list is what this model slug is offered.
    if (!existsSync(join(root, "first-request.json"))) writeFileSync(join(root, "first-request.json"), JSON.stringify(body, null, 2))
    const login = run.login === undefined ? {} : { login: run.login }
    const execArgs = { cmd: run.cmd, yield_time_ms: 30_000, ...login }
    // Code mode: the model's only way to a shell is JavaScript handed to `exec`, which calls the nested
    // `exec_command`. That is what a real gpt-5.6-sol turn does, so it is what the mock does.
    const codeMode = tools.find((candidate) => candidate.type === "custom" && candidate.name === "exec")
    if (codeMode) {
      shellToolsUsed.add("exec (code mode) -> tools.exec_command")
      return stream(res, `resp_${index}`, {
        type: "custom_tool_call", id: `ctc_${index}`, call_id: `call_${index}`, name: "exec",
        ...(codeMode.namespace ? { namespace: codeMode.namespace } : {}),
        // Code mode lists an MCP tool nowhere in the request ("Some deferred nested tools may be omitted
        // from this description"), so the isolate's own ALL_TOOLS is the only reading of what it can call.
        input: `const result = await tools.exec_command(${JSON.stringify(execArgs)});\ntext(typeof result === "string" ? result : JSON.stringify(result));\ntext("ALL_TOOLS=" + JSON.stringify(ALL_TOOLS.map((tool) => tool.name)));\n`,
      })
    }
    const direct = functionCall(/^exec_command$/, execArgs)
      ?? functionCall(/^shell_command$/, { command: run.cmd, timeout_ms: 30_000, ...login })
      ?? functionCall(/^shell$/, { command: ["/bin/sh", "-c", run.cmd], timeout_ms: 30_000 })
    if (direct) {
      shellToolsUsed.add(String(direct.name))
      return stream(res, `resp_${index}`, direct)
    }
    toolOutputs.set(run.id, "MOCK: the request offered no shell tool")
    stream(res, `resp_${index}`, say("no shell tool"))
  })
})
function stream(res: ServerResponse, id: string, item: unknown): void {
  const write = (event: { type: string }) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  write({ type: "response.created", response: { id } } as { type: string })
  write({ type: "response.output_item.done", item } as { type: string })
  write({ type: "response.completed", response: { id, usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } } as { type: string })
  res.end()
}
const listen = (server: Server, ...where: [number, string] | [string]) => new Promise<void>((resolve, reject) => {
  server.once("error", reject)
  if (where.length === 2) server.listen(where[0], where[1], resolve)
  else server.listen(where[0], resolve)
})
await listen(mock, 0, "127.0.0.1")
const mockPort = (mock.address() as { port: number }).port
writeFileSync(join(codexHome, "config.toml"), [
  `model = ${JSON.stringify(MODEL)}`, `model_provider = "mock"`,
  `[model_providers.mock]`, `name = "mock"`, `base_url = "http://127.0.0.1:${mockPort}/v1"`, `wire_api = "responses"`, ``,
  // An MCP server the OPERATOR configured: whatever switches Frizz's mount off must leave this alone.
  // The same script, so it needs nothing of its own; its tools are `mcp__operator__*`.
  `[mcp_servers.operator]`, `command = ${JSON.stringify(process.execPath)}`, `args = [${JSON.stringify(wrapper)}]`,
  `env = { FRIZZ_STATE_DIR = ${JSON.stringify(stateDir)} }`, `default_tools_approval_mode = "approve"`, ``,
].join("\n"))


// ---- one `codex app-server --stdio`, spoken to directly ---------------------------------------------
// Not the bridge: the bag on `thread/start` and `thread/resume` has to be codexThreadShellConfig's and
// nothing else, so that what the shell holds is that one function's doing.
const servers: AppServer[] = []
class AppServer {
  readonly child: ChildProcessWithoutNullStreams
  readonly notifications: Array<{ method: string; params: any }> = []
  readonly serverRequests: string[] = []
  stderr = ""
  /** Every stderr line, kept whole: an arm reads the ones written while it ran. */
  readonly stderrLines: string[] = []
  private stderrRest = ""
  private nextId = 1
  private buffer = ""
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()

  constructor(readonly label: string, env: Record<string, string>, readonly argv: string[]) {
    this.child = spawn(CODEX_BIN, argv, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] })
    servers.push(this)
    this.child.stderr.setEncoding("utf8")
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-16_000)
      const lines = (this.stderrRest + chunk).split("\n")
      this.stderrRest = lines.pop() ?? ""
      this.stderrLines.push(...lines)
    })
    this.child.stdout.setEncoding("utf8")
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk
      for (let nl; (nl = this.buffer.indexOf("\n")) >= 0;) {
        const line = this.buffer.slice(0, nl).trim()
        this.buffer = this.buffer.slice(nl + 1)
        if (!line) continue
        let message: any
        try { message = JSON.parse(line) } catch { continue }
        if (message.id !== undefined && message.method === undefined) {
          const waiter = this.pending.get(message.id)
          this.pending.delete(message.id)
          if (message.error) waiter?.reject(new Error(`${message.error.code}: ${message.error.message}`))
          else waiter?.resolve(message.result)
        } else if (message.id !== undefined) {
          // Nothing here should ask for approval (`approvalPolicy: "never"`); refuse rather than hang.
          this.serverRequests.push(message.method)
          this.send({ id: message.id, error: { code: -32601, message: "probe answers no server requests" } })
        } else {
          this.notifications.push({ method: message.method, params: message.params })
        }
      }
    })
    this.child.on("exit", () => { for (const waiter of this.pending.values()) waiter.reject(new Error(`app-server ${label} exited`)); this.pending.clear() })
  }

  private send(message: unknown): void { this.child.stdin.write(`${JSON.stringify(message)}\n`) }

  request(method: string, params: unknown, ms = 60_000): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`timed out: ${method}`)) }, ms)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      this.send({ id, method, params })
    })
  }

  async initialize(): Promise<string> {
    const response = await this.request("initialize", { clientInfo: CLIENT_INFO, capabilities: CLIENT_CAPABILITIES })
    this.send({ method: "initialized" })
    return String(response.userAgent)
  }

  /** The thread-level params Frizz sends on `thread/start` (startDisposableSession), plus this bag. */
  async startThread(cwd: string, sandbox: string, config?: Record<string, unknown>): Promise<{ id: string; sessionId: string }> {
    const response = await this.request("thread/start", {
      cwd, model: null, approvalPolicy: "never", approvalsReviewer: "user", sandbox,
      ...(config ? { config } : {}), ephemeral: false,
    })
    return { id: response.thread.id, sessionId: response.thread.sessionId }
  }

  /** And on `thread/resume` (rebindOwnedSession). */
  async resumeThread(threadId: string, sandbox: string, config?: Record<string, unknown>): Promise<{ id: string; sessionId: string }> {
    const response = await this.request("thread/resume", {
      threadId, excludeTurns: true, approvalsReviewer: "user", sandbox, approvalPolicy: "never",
      ...(config ? { config } : {}),
    })
    return { id: response.thread.id, sessionId: response.thread.sessionId }
  }

  /** One turn that runs one shell command; resolves with the turn's own status once it has ended. */
  async run(threadId: string, id: string, cmd: string, options: { login?: boolean; verb?: "PROBE_RUN" | "PROBE_SPAWN"; sandboxPolicy?: Record<string, unknown> } = {}): Promise<string> {
    const payload: Run = { id, cmd, ...(options.login === undefined ? {} : { login: options.login }) }
    const text = `${options.verb ?? "PROBE_RUN"} ${Buffer.from(JSON.stringify(payload)).toString("base64url")}`
    const response = await this.request("turn/start", {
      threadId, clientUserMessageId: randomUUID(), input: [{ type: "text", text, text_elements: [] }],
      ...(options.sandboxPolicy ? { sandboxPolicy: options.sandboxPolicy } : {}),
    })
    const turnId = response.turn.id
    for (const start = Date.now(); Date.now() - start < 120_000; await sleep(50)) {
      const ended = this.notifications.find((note) => note.method === "turn/completed" && note.params?.threadId === threadId && note.params?.turn?.id === turnId)
      if (ended) return String(ended.params.turn.status ?? "completed")
    }
    return "TIMEOUT"
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()))
    this.child.kill("SIGTERM")
    await Promise.race([exited, sleep(3_000)])
    if (this.child.exitCode === null && this.child.signalCode === null) { this.child.kill("SIGKILL"); await Promise.race([exited, sleep(2_000)]) }
  }
}


// ---- reading the evidence ---------------------------------------------------------------------------
/** Every tool name the model could call on this probe turn: the request's own list, and in code mode
 *  the names the `exec` isolate reported from ALL_TOOLS. */
function callable(label: string): string[] {
  const nested = (toolOutputs.get(label) ?? "").match(/ALL_TOOLS=(\[[^\]]*\])/)?.[1]?.replace(/\\"/g, '"')
  let inside: string[] = []
  try { inside = nested ? JSON.parse(nested) as string[] : [] } catch { inside = [] }
  return [...new Set([...(offeredTo.get(label)?.tools ?? []), ...(offeredTo.get(label)?.frizzMentions ?? []), ...inside])]
}
const named = (label: string, server: string) => callable(label).filter((name) => new RegExp(`mcp__${server}`).test(name)).sort()

// Each line states what was measured on 0.161.0. A line that stops holding is a Codex change, and the
// run exits non-zero.
let drift = 0
function finding(label: string, holds: boolean, detail: unknown = ""): void {
  if (!holds) drift++
  console.log(`${holds ? "HOLDS        " : "DOES NOT HOLD"}  ${label}${detail === "" ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`)
}

interface Arm { label: string; bag?: Record<string, unknown> }
interface Reading {
  label: string; server: string; bag: Record<string, unknown> | undefined
  started: boolean; error?: string; threadId?: string; status?: string
  frizz: string[]; operator: string[]; toolCount: number; mcpStarts: number; notes: string[]; stderr: string[]
}
const readings: Reading[] = []
const NOISE = /^(thread\/started|thread\/status\/changed|turn\/|item\/|thread\/tokenUsage|account\/|thread\/name|serverRequest\/)/

/** Start one thread with `bag` on `server`, run one turn, and read what its first request offered. */
async function arm(server: AppServer, { label, bag }: Arm, sandbox = "danger-full-access", cmd = "true"): Promise<Reading> {
  const notesFrom = server.notifications.length
  const stderrFrom = server.stderrLines.length
  const startsFrom = mcpStartCount()
  const reading: Reading = { label, server: server.label, bag, started: false, frizz: [], operator: [], toolCount: 0, mcpStarts: 0, notes: [], stderr: [] }
  const cwd = join(root, `cwd-${label}`)
  mkdirSync(cwd, { recursive: true })
  try {
    const thread = await server.startThread(cwd, sandbox, bag)
    reading.started = true
    reading.threadId = thread.id
    reading.status = await server.run(thread.id, label, cmd)
  } catch (error) {
    reading.error = (error as Error).message
  }
  await sleep(300)
  reading.frizz = named(label, "frizz")
  reading.operator = named(label, "operator")
  reading.toolCount = callable(label).length
  reading.mcpStarts = mcpStartCount() - startsFrom
  reading.notes = server.notifications.slice(notesFrom).filter((note) => !NOISE.test(note.method)).map((note) => `${note.method} ${JSON.stringify(note.params).slice(0, 400)}`)
  reading.stderr = server.stderrLines.slice(stderrFrom).filter((line) => /mcp|frizz|warn|error|invalid|config/i.test(line)).map((line) => line.slice(0, 400))
  readings.push(reading)
  report(reading)
  return reading
}
function report(reading: Reading): void {
  console.log(`\n--- ${reading.label} on app-server ${reading.server} · bag ${JSON.stringify(reading.bag ?? null)} ---`)
  console.log(reading.started ? `thread/start: ok (${reading.threadId}); turn ${reading.status}` : `thread/start: REFUSED — ${reading.error}`)
  console.log(`frizz tools callable (${reading.frizz.length} of ${reading.toolCount} tools): ${reading.frizz.join(", ") || "none"}`)
  console.log(`operator's config.toml server: ${reading.operator.length} tools`)
  console.log(`frizz MCP processes started meanwhile: ${reading.mcpStarts}`)
  if (reading.notes.length) console.log(`notifications: \n  ${reading.notes.join("\n  ")}`)
  if (reading.stderr.length) console.log(`app-server stderr (mcp/frizz/warn/error/config lines): \n  ${reading.stderr.join("\n  ")}`)
}

let harnessError = false
try {
  console.log(`[mcp-disable] codex ${CODEX_BIN}\n[mcp-disable] ${execFileSync(CODEX_BIN, ["--version"]).toString().trim()} · model slug ${MODEL} · workspace ${root}`)
  console.log(`[mcp-disable] the MCP script: ${realMcp}\n[mcp-disable] pre-update argv:  ${JSON.stringify(PRE_ARGV)}\n[mcp-disable] post-update argv: ${JSON.stringify(POST_ARGV)}`)
  if (!PRE_ARGV.some((arg) => arg.startsWith("mcp_servers.frizz="))) throw new Error("codexAppServerArgv no longer builds the argv mount this probe is about")
  const env: Record<string, string> = { ...inheritWorkerEnvironment(process.env) }
  for (const key of Object.keys(env)) if (key.startsWith("CODEX_")) delete env[key]
  env.CODEX_HOME = codexHome
  // No Frizz's `cc-worker/bin` on the process PATH (a probe run from inside a Frizz worker inherits the
  // installed one's), so a bare `frizzctl` can only come from the bag.
  env.PATH = (env.PATH ?? "").split(":").filter((entry) => !/cc-worker\/bin\/?$/.test(entry)).join(":")
  await listen(fakeFrizz, 0, "127.0.0.1")
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port: (fakeFrizz.address() as { port: number }).port }))

  const ALL_TOOLS = ["spawn_thread", "goal", "timer", "watch_pr", "watch", "unwatch", "ask", "unask", "done", "title", "activity", "link", "unlink", "watch_issue", "secret", "steer"]
  // Every per-thread spelling that might switch the mount off. The config keys are the ones the
  // 0.161.0 binary's RawMcpServerConfig names (`enabled`, `enabled_tools`, `disabled_tools`), plus the
  // two "empty" shapes a merge could read as a removal.
  const spellings: Arm[] = [
    { label: "enabled-false", bag: { "mcp_servers.frizz.enabled": false } },
    { label: "enabled-false-nested", bag: { mcp_servers: { frizz: { enabled: false } } } },
    { label: "enabled-tools-empty", bag: { "mcp_servers.frizz.enabled_tools": [] } },
    { label: "disabled-tools-all", bag: { "mcp_servers.frizz.disabled_tools": ALL_TOOLS } },
    { label: "frizz-empty-table", bag: { "mcp_servers.frizz": {} } },
    { label: "servers-empty-table", bag: { mcp_servers: {} } },
    // `enabled: false` with a transport of its own, so the entry is valid whether or not the process
    // has a `frizz` entry to merge it into.
    { label: "enabled-false-with-command", bag: { "mcp_servers.frizz.enabled": false, "mcp_servers.frizz.command": "/usr/bin/true" } },
  ]

  // ==== 1, 2, 4: the app-server that predates the update ==============================================
  console.log("\n======== PRE: an app-server started with the argv mount ========")
  const pre = new AppServer("pre", env, PRE_ARGV)
  console.log(`userAgent: ${await pre.initialize()}`)
  const control = await arm(pre, { label: "pre-control" })
  const preArms: Record<string, Reading> = {}
  for (const spelling of spellings) preArms[spelling.label] = await arm(pre, { ...spelling, label: `pre-${spelling.label}` })
  const controlAfter = await arm(pre, { label: "pre-control-after" })

  // ==== 3: the app-server after the update ============================================================
  console.log("\n======== POST: an app-server with no argv mount ========")
  const post = new AppServer("post", env, POST_ARGV)
  await post.initialize()
  const postControl = await arm(post, { label: "post-control" })
  const postArms: Record<string, Reading> = {}
  for (const spelling of spellings) postArms[spelling.label] = await arm(post, { ...spelling, label: `post-${spelling.label}` })
  await post.stop()

  // ==== 6: the bag Frizz ships (codexThreadMcpOff + codexThreadShellConfig) ===========================
  console.log("\n======== 6: the shipped bag, on a pre-update and a post-update app-server ========")
  const shipped: Record<string, { reading: Reading; slug: string; marker: string }> = {}
  const post2 = new AppServer("post-2", env, POST_ARGV)
  await post2.initialize()
  for (const [shape, server] of [["pre", pre], ["post", post2]] as const) {
    const slug = `probe-${shape}-update`
    const bag = { ...codexThreadMcpOff(), ...codexThreadShellConfig(cli, slug, env) }
    const file = join(markers, `${slug}.txt`)
    const cmd = `{ echo "resolved=$(command -v frizzctl)"; frizzctl title "Probe ${slug}"; echo "exit=$?"; } > ${file} 2>&1`
    const reading = await arm(server, { label: `shipped-${shape}`, bag }, "danger-full-access", cmd)
    const marker = existsSync(file) ? readFileSync(file, "utf8") : "(absent)"
    shipped[shape] = { reading, slug, marker }
    console.log(`bag keys: ${Object.keys(bag).join(", ")}`)
    console.log(`marker (written by the thread's shell):\n  ${marker.trim().split("\n").join("\n  ")}`)
    console.log(`fake Frizz saw for "Probe ${slug}": ${JSON.stringify(seen.filter((request) => request.body?.title === `Probe ${slug}`))}`)
  }
  await post2.stop()

  // ==== 5: a sub-agent, and resume ====================================================================
  // For the two spellings that matter: `enabled: false` (the obvious one) and `mcp_servers: {}` (the one
  // that also starts on a post-update app-server).
  const carried = spellings.filter((spelling) => spelling.label === "enabled-false" || spelling.label === "servers-empty-table")
  console.log("\n======== 5: a spawn_agent child of each thread, on the same pre-update app-server ========")
  const childOf = async (label: string, parent: Reading) => {
    const status = await pre.run(parent.threadId!, label, "true", { verb: "PROBE_SPAWN" })
    for (const start = Date.now(); Date.now() - start < 30_000 && !toolOutputs.has(label); await sleep(200)) { /* the child runs on */ }
    await sleep(300)
    const reading: Reading = { label, server: "pre", bag: undefined, started: offeredTo.has(label), status, frizz: named(label, "frizz"), operator: named(label, "operator"), toolCount: callable(label).length, mcpStarts: 0, notes: [], stderr: [] }
    readings.push(reading)
    console.log(`\n--- ${label}: a spawn_agent child (parent turn ${status}) ---`)
    console.log(`the child could call frizz tools (${reading.frizz.length} of ${reading.toolCount}): ${reading.frizz.join(", ") || "none"}; operator tools: ${reading.operator.length}`)
    console.log(`what the parent's spawn_agent / wait_agent returned: ${(toolOutputs.get(`${label}:parent`) ?? "").replace(/\n/g, " | ")}`)
    return reading
  }
  const children: Record<string, Reading> = { control: await childOf("child-of-control", control) }
  for (const spelling of carried) children[spelling.label] = await childOf(`child-of-${spelling.label}`, preArms[spelling.label]!)
  await pre.stop()

  console.log("\n======== 5: thread/resume onto a FRESH pre-update app-server ========")
  const fresh = new AppServer("pre-fresh", env, PRE_ARGV)
  await fresh.initialize()
  const resumeRun = async (label: string, threadId: string, bag?: Record<string, unknown>) => {
    const startsFrom = mcpStartCount()
    const reading: Reading = { label, server: fresh.label, bag, started: false, frizz: [], operator: [], toolCount: 0, mcpStarts: 0, notes: [], stderr: [] }
    try {
      await fresh.resumeThread(threadId, "danger-full-access", bag)
      reading.started = true
      reading.threadId = threadId
      reading.status = await fresh.run(threadId, label, "true")
    } catch (error) { reading.error = (error as Error).message }
    await sleep(300)
    reading.frizz = named(label, "frizz")
    reading.operator = named(label, "operator")
    reading.toolCount = callable(label).length
    reading.mcpStarts = mcpStartCount() - startsFrom
    readings.push(reading)
    report({ ...reading, label: `${label} (thread/resume)` })
    return reading
  }
  const resumed: Record<string, Reading> = { control: await resumeRun("resumed-control", control.threadId!) }
  for (const spelling of carried) resumed[spelling.label] = await resumeRun(`resumed-${spelling.label}-with-bag`, preArms[spelling.label]!.threadId!, spelling.bag)
  // A thread that hid them, resumed WITHOUT its bag: does the switch live in the rollout?
  resumed.withoutBag = await resumeRun("resumed-disabled-without-bag", preArms["enabled-tools-empty"]!.threadId!)
  await fresh.stop()

  // ==== what held =====================================================================================
  console.log("")
  const FRIZZ_16 = ALL_TOOLS.map((tool) => `mcp__frizz__${tool}`).sort().join(",")
  const allSixteen = (reading: Reading) => reading.frizz.map((name) => name.replace("mcp__frizz.", "mcp__frizz__")).sort().join(",") === FRIZZ_16
  finding("1. control: a thread with no MCP keys on the pre-update app-server can call all 16 frizz tools", control.started && allSixteen(control), control.frizz)
  finding("   and a second control after every arm still can: no arm changed the process's mount", allSixteen(controlAfter))
  finding("   the operator's own config.toml server is there in every thread that started", readings.filter((reading) => reading.started).every((reading) => reading.operator.length === 16))
  const e = preArms["enabled-false"]!
  finding("2. `\"mcp_servers.frizz.enabled\": false` on the pre-update app-server: thread/start succeeds and no frizz tool is callable", e.started && e.frizz.length === 0, e.frizz)
  finding("2. and no frizz MCP process is started for it (the one start is the operator's)", e.mcpStarts === 1)
  const p = postArms["enabled-false"]!
  finding("3. on the post-update app-server, `enabled: false` ALONE is REFUSED by thread/start: \"invalid transport in `mcp_servers.frizz`\"",
    !p.started && /invalid transport/.test(p.error ?? "") && /mcp_servers\.frizz/.test(p.error ?? ""), p.error ?? "it started")
  finding("3. and nothing else says so: no stderr line, no notification", p.stderr.length === 0 && p.notes.length === 0, { stderr: p.stderr, notes: p.notes })
  finding("3. post-update control: no frizz tool without any bag", postControl.started && postControl.frizz.length === 0, postControl.frizz)
  const outcome = (reading: Reading) => (reading.started ? (reading.frizz.length ? "frizz tools ON" : "frizz tools OFF") : "REFUSED")
  const expected: Record<string, [string, string]> = {
    "enabled-false": ["frizz tools OFF", "REFUSED"],
    "enabled-false-nested": ["REFUSED", "REFUSED"],
    "enabled-tools-empty": ["frizz tools OFF", "REFUSED"],
    "disabled-tools-all": ["frizz tools OFF", "REFUSED"],
    "frizz-empty-table": ["REFUSED", "REFUSED"],
    "servers-empty-table": ["frizz tools OFF", "frizz tools OFF"],
    "enabled-false-with-command": ["frizz tools OFF", "frizz tools OFF"],
  }
  for (const spelling of spellings) {
    const [onPre, onPost] = expected[spelling.label]!
    finding(`4. ${JSON.stringify(spelling.bag)}: pre-update ${onPre}, post-update ${onPost}`,
      outcome(preArms[spelling.label]!) === onPre && outcome(postArms[spelling.label]!) === onPost,
      `measured: pre ${outcome(preArms[spelling.label]!)}, post ${outcome(postArms[spelling.label]!)}`)
  }
  finding("4. `enabled_tools: []` and `disabled_tools` hide the tools but STILL START the frizz process; the others start none",
    preArms["enabled-tools-empty"]!.mcpStarts === 2 && preArms["disabled-tools-all"]!.mcpStarts === 2
      && ["enabled-false", "servers-empty-table", "enabled-false-with-command"].every((label) => preArms[label]!.mcpStarts === 1),
    Object.fromEntries(spellings.map((spelling) => [spelling.label, preArms[spelling.label]!.mcpStarts])))
  finding("   the argv's top-level `default_tools_approval_mode` is IGNORED by 0.161.0, with a warning notification on every thread",
    control.notes.some((note) => note.startsWith("warning ") && note.includes("`default_tools_approval_mode` is ignored")))
  for (const spelling of carried) {
    finding(`5. ${JSON.stringify(spelling.bag)}: resumed on a fresh pre-update app-server WITH the bag re-sent, still no frizz tool`,
      resumed[spelling.label]!.started && resumed[spelling.label]!.frizz.length === 0, resumed[spelling.label]!.frizz)
    finding(`5. ${JSON.stringify(spelling.bag)}: a spawn_agent child of that thread has no frizz tool either`,
      children[spelling.label]!.started && children[spelling.label]!.frizz.length === 0, children[spelling.label]!.frizz)
  }
  finding("5. control: the resumed no-bag thread gets all 16 back from the argv mount", allSixteen(resumed.control!))
  finding("5. a thread that hid them, resumed WITHOUT its bag, gets all 16 back: the switch is not in the rollout", allSixteen(resumed.withoutBag!))
  finding("5. control: a spawn_agent child of the no-bag thread can call all 16", children.control!.started && allSixteen(children.control!))

  for (const shape of ["pre", "post"] as const) {
    const { reading, slug, marker } = shipped[shape]!
    const requests = seen.filter((request) => request.url === "/_frizz/proj-1/rpc/setOwnThreadTitle" && request.body?.title === `Probe ${slug}`)
    finding(`6. ${shape}-update app-server, the shipped bag: thread/start succeeds, no frizz tool is callable and no frizz process starts (the operator's one does)`,
      reading.started && reading.frizz.length === 0 && reading.operator.length === 16 && reading.mcpStarts === 1, reading.error ?? { frizz: reading.frizz, mcpStarts: reading.mcpStarts })
    finding(`6. ${shape}-update app-server: bare \`frizzctl title\` resolves to this checkout's command, exits 0, and Frizz gets ONE setOwnThreadTitle as ${slug}`,
      marker.includes(`resolved=${join(cli.binDir, "frizzctl")}`) && /\nexit=0/.test(marker) && requests.length === 1 && requests[0]!.body.slug === slug,
      requests.map((request) => request.body))
  }
  console.log("\n======== summary ========")
  for (const reading of readings) console.log(`${reading.label.padEnd(30)} ${reading.server.padEnd(10)} start=${reading.started ? "ok" : "REFUSED"} frizz=${reading.frizz.length} operator=${reading.operator.length} tools=${reading.toolCount} mcpStarts=${reading.mcpStarts}${reading.error ? ` error=${reading.error}` : ""}`)
  console.log(`\nshell tool the mock called: ${[...shellToolsUsed].join(", ")}`)
  console.log(`MCP starts, with the slug each was given: ${existsSync(mcpStarts) ? readFileSync(mcpStarts, "utf8").trim().split("\n").join(" ") : "(none)"}`)
  for (const server of servers) if (server.serverRequests.length) console.log(`app-server ${server.label} sent requests the probe refused: ${server.serverRequests.join(", ")}`)
  writeFileSync(join(root, "readings.json"), JSON.stringify({ readings, offered: Object.fromEntries(offeredTo) }, null, 2))
  console.log(`\nreadings and every first request's tool list: ${join(root, "readings.json")}`)
} catch (error) {
  harnessError = true
  console.error("HARNESS ERROR:", (error as Error).stack ?? error)
  for (const server of servers) if (server.stderr.trim()) console.error(`\napp-server ${server.label} stderr (tail):\n${server.stderr.slice(-3_000)}`)
} finally {
  for (const server of servers) await server.stop()
  for (const server of [mock, fakeFrizz]) await new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()) })
  console.log(`\n${harnessError ? "THE PROBE COULD NOT FINISH" : drift === 0 ? "EVERY READING IS AS RECORDED" : `${drift} READING(S) DIFFER FROM THE RECORD`}`)
  process.exit(harnessError ? 2 : drift === 0 ? 0 : 1)
}
