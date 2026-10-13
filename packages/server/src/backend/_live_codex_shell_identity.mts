// LIVE probe (not a unit test; excluded from the *.test.ts glob). What can a shell command run by a
// Codex thread SEE: of its own thread's identity, of the app-server's environment, and of the machine
// around it under each sandbox?
//
//   env -u NODE_COMPAT nub packages/server/src/backend/_live_codex_shell_identity.mts
//   CODEX_BIN=/path/to/codex overrides the binary (default: Frizz's own provisioned pin, then PATH)
//   PROBE_MODEL=<slug> overrides the model slug the tool list is built for (default gpt-5.6-sol)
//
// Why it exists. A command-line program a worker runs from its own shell has to work out WHICH Frizz
// thread is running it. A Claude thread has a process of its own with FRIZZ_THREAD in it. A Codex
// thread does not: one `codex app-server` per project serves every Codex thread in it, so the process
// environment cannot name a thread, and the MCP mount got its identity from a per-thread `mcp_servers`
// override instead (codexThreadMcpConfig in codex-mcp.ts). This asks what the SHELL has.
//
// NEEDS NO CODEX SIGN-IN and spends no quota. It is the instrument of `_live_codex_config_sync.mts`:
// the REAL `codex app-server` under a temporary CODEX_HOME, pointed at a local mock Responses provider.
// The mock plays the model and answers each turn with one call of the shell tool, running the command
// the probe names; Codex then really runs it. The model SLUG is a real one from the binary's bundled
// catalog, so the tool list is the one that model is offered. For gpt-5.6-sol on 0.161.0 that is code
// mode: one custom `exec` tool that takes JavaScript, with `exec_command` nested inside it, and the
// mock reaches the shell the same way. `PROBE_MODEL=mock-model`, a slug the catalog does not know, is
// offered `exec_command` directly and gave the same readings. What this cannot show is what a model
// would CHOOSE to run, and no turn here was run by a real model (`codex login status` said "Not logged
// in" on the day).
//
// The app-server is driven over raw JSON-RPC on `--stdio`, not through CodexAppServerBridge, so the
// config bag on `thread/start` and `thread/resume` is exactly what this file writes. The thread-level
// params are the ones the bridge sends (`approvalPolicy: "never"`, `sandbox` as a plain mode string),
// and the process environment is Frizz's own rule (inheritWorkerEnvironment: everything, minus FRIZZ_*).
//
// The load-bearing evidence is a MARKER FILE the shell command writes itself, never the model's prose
// (there is no model). Where the sandbox forbids every write, the reading is the listener's own record
// of a request, beside the exit codes in the tool output Codex handed back. The first run of this file
// offered the mock no tool it knew, every marker was absent and every listener silent: the harness can
// fail. Thread `c` (no bag) and the `outside_cwd` write are the standing controls.
//
// MEASURED 2026-10-11 against codex-cli 0.161.0 on macOS 26.6 (arm64, seatbelt). Every line is a
// `finding()` below, and the run exits 1 if one of them stops holding:
//
//   1. CODEX_THREAD_ID. Every shell command sees `CODEX_THREAD_ID`, and its value is exactly the
//      `thread.id` that `thread/start` returned. Five threads on one app-server each saw their own,
//      two of them in turns running at the same time. It holds on a later turn, and after
//      `thread/resume` on a FRESH app-server process. `CODEX_SESSION_ID` is there too and is the same
//      value for a top-level thread; `CODEX_VERSION`, `CODEX_CI=1` and `CODEX_HOME` come with them.
//
//      A SUB-AGENT is the exception that matters (`spawn_agent`, measured one level deep): its shell
//      sees a `CODEX_THREAD_ID` of its OWN, which no `thread/start` ever returned to Frizz, and a
//      `CODEX_SESSION_ID` equal to the PARENT thread's id. So the variable that names the Frizz-bound
//      thread from anywhere in its tree is `CODEX_SESSION_ID`, not `CODEX_THREAD_ID`.
//
//   2. Per-thread shell environment. `config: { shell_environment_policy: { set: { FRIZZ_THREAD } } }`
//      on `thread/start` reaches that thread's shell commands, each thread its own value. Three
//      spellings all work: the nested table, the dotted key `"shell_environment_policy.set": {…}`, and
//      the fully dotted `"shell_environment_policy.set.FRIZZ_THREAD": "…"`. It ADDS to what the
//      process environment gave; it does not replace it. A sub-agent inherits its parent's value.
//      It is NOT in the rollout: a thread resumed on a fresh app-server with no bag has no
//      FRIZZ_THREAD at all, and one resumed with a bag sees the value that resume sent. So it has to
//      ride every bag the way `mcp_servers` does (threadConfig in codex-app-server.ts).
//
//   3. Process-level inheritance. Variables in the app-server's own environment reach every shell
//      command under the default policy: FRIZZ_STATE_DIR and FRIZZ_PROJECT_ID did, and so did ones
//      named `*TOKEN*` and `*KEY*` (the default excludes are not applied). A directory prepended to
//      the app-server's PATH is in the shell's PATH and a bare name in it resolves, but it is NEVER
//      FIRST. Codex puts two entries of its own ahead of the inherited PATH (`…/codex-path` and
//      `$CODEX_HOME/tmp/arg0/codex-arg0…`), and then the user's shell startup files reorder it: on this
//      machine the directory was entry #5 of 33 with `login: false` (behind ~/.zshenv's two additions)
//      and #26 of 38 under the default login shell, behind /opt/homebrew/bin, /usr/local/bin and
//      /usr/bin. The order also differs from turn to turn (#19 of 31 on a turn run straight after
//      `thread/start`; why was not established). A same-named program earlier on PATH would win.
//
//   4. Sandbox reach.
//        danger-full-access  loopback TCP yes; unix sockets yes; writes anywhere.
//        workspace-write     NO loopback TCP and NO unix socket (curl exit 7), not even a socket inside
//                            the cwd's own `.frizz/`. Writes land under the cwd, under `.frizz/` in it
//                            (an existing directory and a new one) and under $TMPDIR; `.git/` and
//                            anywhere outside the cwd are refused.
//        read-only           no loopback, no unix socket, no write anywhere ($TMPDIR included). A
//                            program run from this shell has no channel back to Frizz at all.
//      Sandboxed shells see `CODEX_SANDBOX=seatbelt` and `CODEX_SANDBOX_NETWORK_DISABLED=1`.
//      Two arms Frizz does NOT use today, for what opening the network would take: workspace-write
//      with `sandbox_workspace_write: { network_access: true }` in the bag, and read-only with
//      `sandboxPolicy: { type: "readOnly", networkAccess: true }` on `turn/start`, both reach loopback
//      TCP and both unix sockets with their file rules unchanged. That is the whole network, not
//      loopback alone.
//
// The sandbox arm's working directories are made under ~/Library/Caches (not $TMPDIR, which
// workspace-write leaves writable) and removed when the run ends. Markers stay in the temp workspace
// the run prints.
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { provisionedBinary, runtimesRoot } from "../runtimes.ts"
import { CLIENT_CAPABILITIES, CLIENT_INFO, CODEX_APP_SERVER_SUPPORTED_VERSION } from "./codex-app-server.ts"
import { codexAppServerArgv } from "./codex-mcp.ts"
import { inheritWorkerEnvironment } from "./worker-env.ts"

// The binary Frizz itself runs: its own provisioned pin (runtimes.ts), which is the audited version.
const CODEX_BIN = process.env.CODEX_BIN
  || provisionedBinary("codex", runtimesRoot(), CODEX_APP_SERVER_SUPPORTED_VERSION)
  || "codex"
const MODEL = process.env.PROBE_MODEL || "gpt-5.6-sol"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const root = realpathSync(mkdtempSync(join(tmpdir(), "frizz-codex-shell-identity-")))
const codexHome = join(root, "codex-home")
const markers = join(root, "markers")
const binDir = join(root, "frizz-bin")
const stateDir = join(root, "state")
for (const dir of [codexHome, markers, binDir, stateDir]) mkdirSync(dir)
// The sandbox arm's directories live OUTSIDE the temp directory on purpose: `workspace-write` as Frizz
// sends it leaves $TMPDIR and /tmp writable, so a cwd under either could not tell "the cwd is writable"
// from "the temp directory is". Removed again in the `finally`.
const outsideBase = join(homedir(), process.platform === "darwin" ? "Library/Caches" : ".cache")
mkdirSync(outsideBase, { recursive: true })
const outside = realpathSync(mkdtempSync(join(outsideBase, "frizz-codex-shell-identity-")))
const unixSocket = `/tmp/frizz-si-${process.pid}.sock`

// The program a worker would run by bare name. It writes its own marker: who ran it, and what it saw.
const CLI_NAME = "frizz-probe-cli"
writeFileSync(join(binDir, CLI_NAME), [
  "#!/bin/sh",
  `{ echo "argv0=$0"; echo "label=$1"; env | grep -E '^(CODEX_|FRIZZ_|PATH=)' | sort; } > ${JSON.stringify(markers)}/"$1".txt`,
  "",
].join("\n"))
chmodSync(join(binDir, CLI_NAME), 0o755)

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
        input: `const result = await tools.exec_command(${JSON.stringify(execArgs)});\ntext(typeof result === "string" ? result : JSON.stringify(result));\n`,
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
].join("\n"))

// ---- what a sandboxed shell is asked to reach -------------------------------------------------------
// Each records the request it was sent, so "reached" is the LISTENER's word, not curl's.
const hits: string[] = []
const listeners: Server[] = []
async function listener(via: string, ...where: [number, string] | [string]): Promise<Server> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => { hits.push(`${via} ${req.url}`); res.writeHead(200).end("pong") })
  listeners.push(server)
  await listen(server, ...where)
  return server
}
const tcpPort = ((await listener("tcp", 0, "127.0.0.1")).address() as { port: number }).port
await listener("unix-tmp", unixSocket)

// ---- one `codex app-server --stdio`, spoken to directly ---------------------------------------------
// Not the bridge: the config bag on `thread/start` and `thread/resume` has to be exactly what this file
// writes, and the bridge builds its own.
const servers: AppServer[] = []
class AppServer {
  readonly child: ChildProcessWithoutNullStreams
  readonly notifications: Array<{ method: string; params: any }> = []
  readonly serverRequests: string[] = []
  stderr = ""
  private nextId = 1
  private buffer = ""
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()

  constructor(readonly label: string, extraEnv: Record<string, string> = {}, pathPrefix?: string) {
    // What Frizz gives its own app-server (codexAppServerEnvironment): everything it has, minus FRIZZ_*.
    // This process may itself be a Frizz worker, so that subtraction is also what keeps the reading honest.
    const env: Record<string, string> = { ...inheritWorkerEnvironment(process.env) }
    for (const key of Object.keys(env)) if (key.startsWith("CODEX_")) delete env[key]
    Object.assign(env, { CODEX_HOME: codexHome }, extraEnv)
    if (pathPrefix) env.PATH = `${pathPrefix}:${env.PATH ?? ""}`
    this.child = spawn(CODEX_BIN, codexAppServerArgv(["--stdio"]), { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] })
    servers.push(this)
    this.child.stderr.setEncoding("utf8")
    this.child.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-16_000) })
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
const marker = (label: string): string | null => {
  const path = join(markers, `${label}.txt`)
  return existsSync(path) ? readFileSync(path, "utf8") : null
}
/** What the command printed, dug out of the tool output Codex handed the model for that turn. */
function shellOutput(id: string): string {
  const handed = toolOutputs.get(id) ?? ""
  try {
    for (const part of JSON.parse(handed) as Array<{ text?: string }>) {
      try { const result = JSON.parse(part.text ?? ""); if (typeof result?.output === "string") return result.output } catch { /* the prose part */ }
    }
  } catch { /* not code mode: the output is already the text */ }
  try { const result = JSON.parse(handed); if (typeof result?.output === "string") return result.output } catch { /* plain text */ }
  return handed
}
const valueIn = (text: string | null | undefined, key: string): string | undefined =>
  text?.split("\n").find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1)
/** The shell's own view of the three things in question, written by the shell to a file. */
const envTo = (label: string) => `sh -c 'env | grep -E "^(CODEX_|FRIZZ_|PATH=)" | sort > ${join(markers, `${label}.txt`)}'`
/** Where the directory the app-server was given FIRST in its PATH ended up in the shell's. */
function pathPosition(text: string | null | undefined): { at: number; of: number; first: string[] } {
  const entries = valueIn(text, "PATH")?.split(":") ?? []
  return { at: entries.indexOf(binDir), of: entries.length, first: entries.slice(0, 3) }
}
// A marker is printed whole except its PATH, which is a screen long: the file itself is kept in `markers/`.
const show = (title: string, text: string | null | undefined) => console.log(`\n--- ${title} ---\n${text == null ? "(absent)" : text.trimEnd().split("\n").map((line) => {
  if (!line.startsWith("PATH=")) return line
  const entries = line.slice(5).split(":")
  return `PATH=${entries.slice(0, 3).join(":")}:… (${entries.length} entries)`
}).join("\n") || "(empty)"}`)

// Each line states what was measured on 0.161.0. A line that stops holding is a Codex change, and the
// run exits non-zero so a bump cannot move one of them quietly.
let drift = 0
function finding(label: string, holds: boolean, detail: unknown = ""): void {
  if (!holds) drift++
  console.log(`${holds ? "HOLDS        " : "DOES NOT HOLD"}  ${label}${detail === "" ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`)
}

let harnessError = false
try {
  console.log(`[shell-identity] codex ${CODEX_BIN}\n[shell-identity] ${execFileSync(CODEX_BIN, ["--version"]).toString().trim()} · model slug ${MODEL} · workspace ${root}`)
  const cwdOf = (label: string) => { const dir = join(root, `cwd-${label}`); mkdirSync(dir, { recursive: true }); return dir }
  const FULL = "danger-full-access"
  const setThread = (value: string) => ({ shell_environment_policy: { set: { FRIZZ_THREAD: value } } })

  // ==== 1 + 2: one app-server, several threads =======================================================
  console.log("\n======== ONE app-server (plain environment), several threads ========")
  const one = new AppServer("one")
  console.log(`userAgent: ${await one.initialize()}`)
  // The spellings a per-thread shell environment could take in the config bag; c is the control.
  const bags: Record<string, Record<string, unknown> | undefined> = {
    a: setThread("thread-a"),
    b: setThread("thread-b"),
    c: undefined,
    d: { "shell_environment_policy.set": { FRIZZ_THREAD: "thread-d" } },
    e: { "shell_environment_policy.set.FRIZZ_THREAD": "thread-e" },
  }
  const threads: Record<string, { id: string; sessionId: string }> = {}
  for (const [label, config] of Object.entries(bags)) {
    try {
      threads[label] = await one.startThread(cwdOf(label), FULL, config)
      console.log(`thread ${label}: id=${threads[label]!.id} sessionId=${threads[label]!.sessionId}  bag=${JSON.stringify(config ?? null)}`)
    } catch (error) {
      console.log(`thread ${label}: thread/start REFUSED the bag ${JSON.stringify(config)}: ${(error as Error).message}`)
    }
  }
  // a and b at the same time: two turns interleaved on one process is the case that would mix them up.
  const together = await Promise.all((["a", "b"] as const).map((label) => one.run(threads[label]!.id, `${label}-1`, envTo(`${label}-1`))))
  console.log(`turns a-1, b-1 (concurrent): ${together.join(", ")}`)
  for (const label of ["c", "d", "e"]) {
    if (threads[label]) console.log(`turn ${label}-1: ${await one.run(threads[label]!.id, `${label}-1`, envTo(`${label}-1`))}`)
  }
  console.log(`turn a-2 (a later turn, same process): ${await one.run(threads.a!.id, "a-2", envTo("a-2"))}`)
  for (const label of ["a-1", "b-1", "c-1", "d-1", "e-1", "a-2"]) show(`marker ${label}`, marker(label))
  await one.stop()

  console.log("")
  for (const label of ["a", "b", "c", "d", "e"]) {
    finding(`thread ${label}'s shell sees CODEX_THREAD_ID, and it is the id thread/start returned`,
      threads[label] !== undefined && valueIn(marker(`${label}-1`), "CODEX_THREAD_ID") === threads[label]!.id, valueIn(marker(`${label}-1`), "CODEX_THREAD_ID") ?? "absent")
  }
  finding("the ids differ between threads on the one process", new Set(["a", "b", "c", "d", "e"].map((label) => valueIn(marker(`${label}-1`), "CODEX_THREAD_ID"))).size === 5)
  finding("CODEX_SESSION_ID is there too, and for a top-level thread it is the same value", ["a", "b", "c"].every((label) => valueIn(marker(`${label}-1`), "CODEX_SESSION_ID") === threads[label]?.sessionId && threads[label]?.sessionId === threads[label]?.id))
  finding("it holds on a later turn of the same thread", valueIn(marker("a-2"), "CODEX_THREAD_ID") === threads.a?.id)
  finding("nested `shell_environment_policy: { set: {…} }` reaches the shell, each thread its own value",
    valueIn(marker("a-1"), "FRIZZ_THREAD") === "thread-a" && valueIn(marker("b-1"), "FRIZZ_THREAD") === "thread-b" && valueIn(marker("a-2"), "FRIZZ_THREAD") === "thread-a")
  finding("a thread started with no bag has no FRIZZ_THREAD (the control)", marker("c-1") !== null && valueIn(marker("c-1"), "FRIZZ_THREAD") === undefined)
  finding('the dotted key `"shell_environment_policy.set": {…}` works as well', valueIn(marker("d-1"), "FRIZZ_THREAD") === "thread-d")
  finding('and so does `"shell_environment_policy.set.FRIZZ_THREAD": "…"`', valueIn(marker("e-1"), "FRIZZ_THREAD") === "thread-e")

  // ==== 1 + 2 across a restart: a FRESH app-server, thread/resume ====================================
  console.log("\n======== a FRESH app-server: thread/resume ========")
  const two = new AppServer("two")
  await two.initialize()
  const resumedA = await two.resumeThread(threads.a!.id, FULL)
  console.log(`resumed a with NO bag: id=${resumedA.id} sessionId=${resumedA.sessionId}`)
  console.log(`turn a-resumed-nobag: ${await two.run(threads.a!.id, "a-resumed-nobag", envTo("a-resumed-nobag"))}`)
  const resumedB = await two.resumeThread(threads.b!.id, FULL, setThread("thread-b-resumed"))
  console.log(`resumed b WITH a bag: id=${resumedB.id} sessionId=${resumedB.sessionId}`)
  console.log(`turn b-resumed-bag: ${await two.run(threads.b!.id, "b-resumed-bag", envTo("b-resumed-bag"))}`)
  for (const label of ["a-resumed-nobag", "b-resumed-bag"]) show(`marker ${label}`, marker(label))
  await two.stop()

  console.log("")
  finding("a thread resumed on a fresh app-server still sees its own CODEX_THREAD_ID",
    valueIn(marker("a-resumed-nobag"), "CODEX_THREAD_ID") === threads.a?.id && valueIn(marker("b-resumed-bag"), "CODEX_THREAD_ID") === threads.b?.id)
  finding("resumed with NO bag, the thread has LOST its FRIZZ_THREAD: the rollout does not carry it", marker("a-resumed-nobag") !== null && valueIn(marker("a-resumed-nobag"), "FRIZZ_THREAD") === undefined)
  finding("resumed WITH a bag, the shell sees the value that resume sent", valueIn(marker("b-resumed-bag"), "FRIZZ_THREAD") === "thread-b-resumed")

  // ==== 3: what the PROCESS was given ================================================================
  console.log("\n======== an app-server started with a PATH entry and FRIZZ_ variables of its own ========")
  const processEnv = {
    FRIZZ_STATE_DIR: stateDir, FRIZZ_PROJECT_ID: "abc",
    // Codex's default excludes are named `*KEY*` / `*SECRET*` / `*TOKEN*`: do they bite a Frizz variable?
    FRIZZ_PROBE_SECRET_TOKEN: "tok", FRIZZ_PROBE_API_KEY: "key",
  }
  const three = new AppServer("three", processEnv, binDir)
  await three.initialize()
  const f = await three.startThread(cwdOf("f"), FULL)
  console.log(`turn f-login-default: ${await three.run(f.id, "f-login-default", `${CLI_NAME} f-login-default`)}`)
  console.log(`turn f-login-false: ${await three.run(f.id, "f-login-false", `${CLI_NAME} f-login-false`, { login: false })}`)
  // The pairing a design would use: the process names the project, the thread names itself.
  const g = await three.startThread(cwdOf("g"), FULL, setThread("thread-g"))
  console.log(`turn g-with-bag: ${await three.run(g.id, "g-with-bag", `${CLI_NAME} g-with-bag`)}`)
  await sleep(4_000)
  console.log(`turn g-later (4s on): ${await three.run(g.id, "g-later", `${CLI_NAME} g-later`)}`)
  const cliLabels = ["f-login-default", "f-login-false", "g-with-bag", "g-later"]
  for (const label of cliLabels) {
    show(`marker ${label} (written by ${CLI_NAME} itself)`, marker(label))
    const position = pathPosition(marker(label))
    console.log(`the prepended directory is PATH entry #${position.at + 1} of ${position.of}; the shell's PATH starts ${position.first.join(":")}`)
  }

  console.log("")
  finding(`a bare \`${CLI_NAME}\` resolves to the script in the directory the app-server was given`, cliLabels.every((label) => valueIn(marker(label), "argv0") === join(binDir, CLI_NAME)))
  finding("but that directory is NEVER first in the shell's PATH: Codex and the login shell put entries ahead of it",
    cliLabels.every((label) => pathPosition(marker(label)).at > 0), cliLabels.map((label) => `${label}: #${pathPosition(marker(label)).at + 1}`).join(", "))
  finding("FRIZZ_STATE_DIR and FRIZZ_PROJECT_ID reach the shell under the default policy",
    cliLabels.every((label) => valueIn(marker(label), "FRIZZ_STATE_DIR") === stateDir && valueIn(marker(label), "FRIZZ_PROJECT_ID") === "abc"))
  finding("so do variables named *TOKEN* and *KEY*: the default excludes are not applied",
    cliLabels.every((label) => valueIn(marker(label), "FRIZZ_PROBE_SECRET_TOKEN") === "tok" && valueIn(marker(label), "FRIZZ_PROBE_API_KEY") === "key"))
  finding("a per-thread `set` ADDS to what the process gave; it does not replace it",
    valueIn(marker("g-with-bag"), "FRIZZ_THREAD") === "thread-g" && valueIn(marker("g-with-bag"), "FRIZZ_PROJECT_ID") === "abc" && valueIn(marker("f-login-default"), "FRIZZ_THREAD") === undefined)

  // ==== beyond the four questions: a sub-agent's shell ===============================================
  console.log("\n======== a sub-agent (`spawn_agent`) of a thread that has a bag ========")
  const h = await three.startThread(cwdOf("h"), FULL, setThread("thread-h"))
  console.log(`parent thread h: id=${h.id} sessionId=${h.sessionId}`)
  console.log(`turn h-parent: ${await three.run(h.id, "h-parent", envTo("h-parent"))}`)
  console.log(`turn h-spawn: ${await three.run(h.id, "h-child", envTo("h-child"), { verb: "PROBE_SPAWN" })}`)
  for (const start = Date.now(); Date.now() - start < 30_000 && marker("h-child") === null; await sleep(200)) { /* the child runs on after its parent's turn */ }
  show("marker h-parent", marker("h-parent"))
  show("marker h-child (written by the sub-agent's shell)", marker("h-child"))
  show("what the parent's spawn_agent / wait_agent calls returned", toolOutputs.get("h-child:parent"))
  console.log("")
  if (marker("h-child") === null) {
    console.log("NOT MEASURED   the sub-agent wrote no marker (see the tool output above)")
  } else {
    finding("a sub-agent's shell sees a CODEX_THREAD_ID of its OWN, not its parent's", ![undefined, h.id].includes(valueIn(marker("h-child"), "CODEX_THREAD_ID")), valueIn(marker("h-child"), "CODEX_THREAD_ID"))
    finding("its CODEX_SESSION_ID is the PARENT thread's id", valueIn(marker("h-child"), "CODEX_SESSION_ID") === h.id, valueIn(marker("h-child"), "CODEX_SESSION_ID"))
    finding("and it inherits the parent's per-thread FRIZZ_THREAD", valueIn(marker("h-child"), "FRIZZ_THREAD") === "thread-h", valueIn(marker("h-child"), "FRIZZ_THREAD") ?? "absent")
  }

  // ==== 4: sandbox reach, on that same process =======================================================
  console.log("\n======== sandbox reach: loopback, unix sockets, and writes ========")
  const notCwd = join(outside, "not-the-cwd")
  mkdirSync(notCwd)
  // The first three are the modes Frizz uses, sent as Frizz sends them. The last two are NOT something
  // Frizz does today: they ask what it would take to open the network under the same file rules.
  const arms: Array<{ label: string; sandbox: string; config?: Record<string, unknown>; sandboxPolicy?: Record<string, unknown> }> = [
    { label: "danger-full-access", sandbox: "danger-full-access" },
    { label: "workspace-write", sandbox: "workspace-write" },
    { label: "read-only", sandbox: "read-only" },
    { label: "ww-net", sandbox: "workspace-write", config: { sandbox_workspace_write: { network_access: true } } },
    { label: "ro-net", sandbox: "read-only", sandboxPolicy: { type: "readOnly", networkAccess: true } },
  ]
  interface Reach { exits: Record<string, number>; hits: string[]; files: Record<string, boolean>; env: string[] }
  const reach: Record<string, Reach> = {}
  for (const arm of arms) {
    const cwd = join(outside, arm.label)
    mkdirSync(join(cwd, ".frizz"), { recursive: true })
    execFileSync("git", ["init", "-q", cwd])
    // A socket inside the project's own `.frizz/`, which `workspace-write` can write to.
    const cwdSocket = join(cwd, ".frizz", "s.sock")
    await listener("unix-cwd", cwdSocket)
    const thread = await three.startThread(cwd, arm.sandbox, arm.config)
    const write = (name: string, target: string) => `( echo ok > ${target} ) 2>/dev/null; echo "${name}_exit=$?"`
    const curl = (name: string, args: string) => `curl -sS -m 5 -o /dev/null ${args} 2>/dev/null; echo "${name}_exit=$?"`
    const cmd = [
      curl("tcp", `http://127.0.0.1:${tcpPort}/hit/${arm.label}`),
      curl("unix_tmp", `--unix-socket ${unixSocket} http://localhost/hit/${arm.label}`),
      curl("unix_cwd", `--unix-socket ${cwdSocket} http://localhost/hit/${arm.label}`),
      write("cwd", "probe-cwd.txt"),
      write("dotfrizz", ".frizz/probe.txt"),
      `( mkdir -p .frizz/threads/x && echo ok > .frizz/threads/x/probe.txt ) 2>/dev/null; echo "dotfrizz_mkdir_exit=$?"`,
      write("dotgit", ".git/probe.txt"),
      write("outside_cwd", join(notCwd, `${arm.label}.txt`)),
      write("tmpdir", join(markers, `sandbox-${arm.label}.txt`)),
      `${CLI_NAME} sandbox-cli-${arm.label} 2>/dev/null; echo "cli_exit=$?"`,
      `env | grep -E "^(CODEX_SANDBOX|FRIZZ_PROJECT_ID)" | sort`,
    ].join("; ")
    const status = await three.run(thread.id, `sandbox-${arm.label}`, cmd, arm.sandboxPolicy ? { sandboxPolicy: arm.sandboxPolicy } : {})
    await sleep(200)
    // The tool output is what Codex handed the model: the only reading there is where no write is allowed.
    const output = shellOutput(`sandbox-${arm.label}`)
    const exits = Object.fromEntries([...output.matchAll(/^(\w+)_exit=(\d+)$/gm)].map((match) => [match[1]!, Number(match[2])]))
    reach[arm.label] = {
      exits,
      hits: hits.filter((hit) => hit.endsWith(`/hit/${arm.label}`)).map((hit) => hit.split(" ")[0]!),
      files: {
        cwd: existsSync(join(cwd, "probe-cwd.txt")), dotfrizz: existsSync(join(cwd, ".frizz/probe.txt")),
        dotfrizzMkdir: existsSync(join(cwd, ".frizz/threads/x/probe.txt")), dotgit: existsSync(join(cwd, ".git/probe.txt")),
        outsideCwd: existsSync(join(notCwd, `${arm.label}.txt`)), tmpdir: existsSync(join(markers, `sandbox-${arm.label}.txt`)),
        cliMarker: marker(`sandbox-cli-${arm.label}`) !== null,
      },
      env: output.split("\n").filter((line) => line.startsWith("CODEX_SANDBOX")),
    }
    console.log(`\n--- ${arm.label} (turn ${status})${arm.config ? ` bag=${JSON.stringify(arm.config)}` : ""}${arm.sandboxPolicy ? ` turn sandboxPolicy=${JSON.stringify(arm.sandboxPolicy)}` : ""} ---`)
    console.log(`exit codes the shell printed: ${JSON.stringify(exits)}`)
    console.log(`the listeners saw:            ${JSON.stringify(reach[arm.label]!.hits)}`)
    console.log(`files on disk afterwards:     ${JSON.stringify(reach[arm.label]!.files)}`)
    console.log(`sandbox variables it saw:     ${JSON.stringify(reach[arm.label]!.env)}`)
  }
  await three.stop()

  console.log("")
  const all = (value: boolean, files: Record<string, boolean>, keys: string[]) => keys.every((key) => files[key] === value)
  const everyFile = ["cwd", "dotfrizz", "dotfrizzMkdir", "dotgit", "outsideCwd", "tmpdir", "cliMarker"]
  finding("danger-full-access: loopback TCP and both unix sockets are reached, every write lands (the positive control)",
    reach["danger-full-access"]!.hits.length === 3 && all(true, reach["danger-full-access"]!.files, everyFile))
  finding("workspace-write: NO loopback TCP and NO unix socket, not even one inside the cwd's .frizz/", reach["workspace-write"]!.hits.length === 0, reach["workspace-write"]!.exits)
  finding("workspace-write: the shell can write under its cwd and under .frizz/ in it (existing or new directory), and under $TMPDIR",
    all(true, reach["workspace-write"]!.files, ["cwd", "dotfrizz", "dotfrizzMkdir", "tmpdir", "cliMarker"]))
  finding("workspace-write: it cannot write into .git/ or outside the cwd (the negative control)", all(false, reach["workspace-write"]!.files, ["dotgit", "outsideCwd"]))
  finding("read-only: no loopback, no unix socket, and no write anywhere, $TMPDIR included",
    reach["read-only"]!.hits.length === 0 && all(false, reach["read-only"]!.files, everyFile), reach["read-only"]!.exits)
  finding("extra: workspace-write with `sandbox_workspace_write.network_access = true` in the bag reaches loopback TCP", reach["ww-net"]!.hits.includes("tcp"), reach["ww-net"]!.hits)
  finding("extra: read-only with `networkAccess: true` in the turn's sandboxPolicy reaches loopback TCP", reach["ro-net"]!.hits.includes("tcp"), reach["ro-net"]!.hits)

  console.log(`\ntools the request offered the model (${MODEL}): ${[...toolsOffered].sort().join(", ")}`)
  console.log(`shell tool the mock called: ${[...shellToolsUsed].join(", ")}`)
  for (const server of servers) if (server.serverRequests.length) console.log(`app-server ${server.label} sent requests the probe refused: ${server.serverRequests.join(", ")}`)
  console.log(`\nmarkers kept in ${markers}`)
} catch (error) {
  harnessError = true
  console.error("HARNESS ERROR:", (error as Error).stack ?? error)
  for (const server of servers) if (server.stderr.trim()) console.error(`\napp-server ${server.label} stderr (tail):\n${server.stderr.slice(-3_000)}`)
} finally {
  for (const server of servers) await server.stop()
  for (const server of [mock, ...listeners]) await new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()) })
  rmSync(unixSocket, { force: true })
  rmSync(outside, { recursive: true, force: true })
  console.log(`\n${harnessError ? "THE PROBE COULD NOT FINISH" : drift === 0 ? "EVERY READING IS AS RECORDED" : `${drift} READING(S) DIFFER FROM THE RECORD`}`)
  process.exit(harnessError ? 2 : drift === 0 ? 0 : 1)
}
