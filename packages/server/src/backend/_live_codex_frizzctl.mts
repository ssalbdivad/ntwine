// LIVE probe (not a unit test; excluded from the *.test.ts glob). Can a Codex thread's own shell run
// `frizzctl` by bare name, as that thread, on an app-server that was started BEFORE Frizz knew about
// the command?
//
//   env -u NODE_COMPAT nub packages/server/src/backend/_live_codex_frizzctl.mts
//   CODEX_BIN=/path/to/codex overrides the binary (default: Frizz's own provisioned pin, then PATH)
//   PROBE_MODEL=<slug> overrides the model slug the tool list is built for (default gpt-5.6-sol)
//
// Why it exists. `codexThreadShellConfig` (codex-shell-env.ts) is how a Codex thread's shell is told
// where the command is, where the server is and who is calling: a `shell_environment_policy.set.*`
// entry per variable in the config bag of every `thread/start` and `thread/resume`, PATH among them.
// `_live_codex_shell_identity.mts` measured that such an entry reaches the shell for FRIZZ_THREAD. It
// did not measure PATH arriving that way (it read PATH only as something the process inherits), and
// it never ran the command. This does both, with the bag IMPORTED from that function and sent
// untouched, and the real `cc-worker/bin/frizzctl` of this checkout on the other end of the bare name.
//
// The case is the hard one on purpose: the app-server's own environment has NO `cc-worker/bin` on
// its PATH (this checkout's or an installed Frizz's) and no FRIZZ_* variable, which is what a daemon
// that outlived the update that introduced the command looks like. Everything the shell knows about
// Frizz therefore came through the bag.
//
// NEEDS NO CODEX SIGN-IN and spends no quota: the instrument of `_live_codex_shell_identity.mts`. The
// REAL `codex app-server --stdio` under a temporary CODEX_HOME, driven over raw JSON-RPC, pointed at a
// mock Responses provider that answers each turn with one shell call (code mode's `exec` ->
// `tools.exec_command` for gpt-5.6-sol; `PROBE_MODEL=mock-model` is offered `exec_command` directly
// and gave the same readings). Codex really runs the command. "Frizz" is a fake RPC server on
// 127.0.0.1 named by a `server.lock` under `<tmp>/frizz-root/projects/proj-1`.
//
// THE EVIDENCE is the fake server's own record of the requests it received, and a marker file per
// command holding what it printed and its exit code, both written without any model in the way
// (`frizzctl title "…" > marker 2>&1; echo "exit=$?" >> marker`). Two controls can fail it: a thread
// with NO bag on the same process, and a resume with no bag, where the shell must not find the command.
//
// MEASURED 2026-10-11 against codex-cli 0.161.0 on macOS 26.6 (arm64, zsh). Every line is a
// `finding()` below, and the run exits 1 if one stops holding:
//
//   - Two threads, each started with its own bag, turns running at once: bare `frizzctl title` exits
//     0 in both, and Frizz receives exactly one `/_frizz/proj-1/rpc/setOwnThreadTitle` per thread,
//     carrying that thread's slug. It also works with `login: false`.
//   - The control thread with no bag: `zsh:1: command not found: frizzctl`, exit 127, no request.
//   - A `spawn_agent` child of one thread runs the same command: exit 0, and its request carries the
//     PARENT thread's slug.
//   - `thread/resume` on a FRESH app-server with the bag re-sent: the command works as that thread.
//     The same resume with no bag: command not found, exit 127.
//   - A `workspace-write` thread: exit 1, the message says "sandboxed with network access off", and
//     no request reaches Frizz.
//   - WHERE `set.PATH` LANDS. The command's directory reaches the shell every time and the bare name
//     resolves to this checkout's file. Its position is not stable, so it is printed and not pinned:
//       `login: false`                        #4 of 31, behind Codex's own `…/codex-path` and the two
//                                             directories ~/.zshenv prepends on this machine
//       default login shell, a later turn     #6 of 33, behind the same (the zshenv pair twice)
//       default login shell, a thread's       #18 of 29, behind /opt/homebrew/bin, /usr/local/bin,
//       FIRST turn after `thread/start`       /usr/bin and /bin as well
//     So `set` does not put the directory out of a login shell's reach: on a first turn the system
//     directories are ahead of it exactly as they are ahead of a directory the app-server inherited
//     (`_live_codex_shell_identity.mts` read #19 and #26 there). Why a later turn differs was not
//     established. A program named `frizzctl` in /opt/homebrew/bin or /usr/local/bin would win on a
//     first turn; presence can be relied on, position cannot.
//
// NOT covered: FRIZZ_SERVER_LOCK (the `cli` here names no `serverLock`, so the bag has no such key and
// the command finds the server through FRIZZ_STATE_DIR); any command but `title`; a real model's own
// choice of command; Linux.
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { createServer, type Server, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { provisionedBinary, runtimesRoot } from "../runtimes.ts"
import { CLIENT_CAPABILITIES, CLIENT_INFO, CODEX_APP_SERVER_SUPPORTED_VERSION } from "./codex-app-server.ts"
import { codexAppServerArgv } from "./codex-mcp.ts"
import { codexThreadShellConfig } from "./codex-shell-env.ts"
import type { FrizzCli } from "./types.ts"
import { inheritWorkerEnvironment } from "./worker-env.ts"

// The binary Frizz itself runs: its own provisioned pin (runtimes.ts), which is the audited version.
const CODEX_BIN = process.env.CODEX_BIN
  || provisionedBinary("codex", runtimesRoot(), CODEX_APP_SERVER_SUPPORTED_VERSION)
  || "codex"
const MODEL = process.env.PROBE_MODEL || "gpt-5.6-sol"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const root = realpathSync(mkdtempSync(join(tmpdir(), "frizz-codex-frizzctl-")))
const codexHome = join(root, "codex-home")
const markers = join(root, "markers")
// A state dir shaped like the real one, `<frizz root>/projects/<project id>`: the command finds the
// server through it.
const stateDir = join(root, "frizz-root", "projects", "proj-1")
for (const dir of [codexHome, markers, stateDir]) mkdirSync(dir, { recursive: true })

// THIS checkout's command, the one a worker would be handed: `<plugin dir>/bin`.
const binDir = realpathSync(fileURLToPath(new URL("../../../../cc-worker/bin", import.meta.url)))
const cli: FrizzCli = { binDir, stateDir, projectId: "proj-1" }

// ---- the fake Frizz ---------------------------------------------------------------------------------
// Frizz's RPC surface as far as `frizzctl title` needs it. Its own record of what it was sent is the
// evidence: a request is here only if the command, run by a shell, reached it.
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

// ---- one `codex app-server --stdio`, spoken to directly ---------------------------------------------
// Not the bridge: the bag on `thread/start` and `thread/resume` has to be codexThreadShellConfig's and
// nothing else, so that what the shell holds is that one function's doing.
const servers: AppServer[] = []
class AppServer {
  readonly child: ChildProcessWithoutNullStreams
  readonly notifications: Array<{ method: string; params: any }> = []
  readonly serverRequests: string[] = []
  stderr = ""
  private nextId = 1
  private buffer = ""
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()

  constructor(readonly label: string, env: Record<string, string>) {
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
const valueIn = (text: string | null | undefined, key: string): string | undefined =>
  text?.split("\n").find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1)
/** The command, by bare name, with everything it printed and its exit code written by the shell itself. */
const titleTo = (label: string, title: string) => {
  const file = join(markers, `${label}.txt`)
  return `frizzctl title ${JSON.stringify(title)} > ${file} 2>&1; echo "exit=$?" >> ${file}`
}
/** What the shell resolves the bare name to, and the PATH it resolves it on. */
const pathTo = (label: string) => `{ echo "frizzctl=$(command -v frizzctl)"; echo "PATH=$PATH"; env | grep "^FRIZZ_" | sort; } > ${join(markers, `${label}.txt`)} 2>&1`
/** The fake server's own record of the `setOwnThreadTitle` calls that asked for this title. */
const titled = (title: string): Seen[] => seen.filter((request) => request.url === "/_frizz/proj-1/rpc/setOwnThreadTitle" && request.body?.title === title)
const slugsOf = (requests: Seen[]): string[] => requests.map((request) => String(request.body?.slug))
function pathPosition(text: string | null | undefined): { at: number; of: number; ahead: string[] } {
  const entries = valueIn(text, "PATH")?.split(":") ?? []
  const at = entries.indexOf(binDir)
  return { at, of: entries.length, ahead: at < 0 ? [] : entries.slice(0, at) }
}
// A marker is printed whole except a PATH line, which is a screen long: the file is kept in `markers/`.
const show = (title: string, text: string | null | undefined) => console.log(`\n--- ${title} ---\n${text == null ? "(absent)" : text.trimEnd().split("\n").map((line) => {
  if (!line.startsWith("PATH=")) return line
  const entries = line.slice(5).split(":")
  return `PATH=${entries.slice(0, 3).join(":")}:… (${entries.length} entries)`
}).join("\n") || "(empty)"}`)
const showRequests = (title: string) => console.log(`fake Frizz saw for "${title}": ${JSON.stringify(titled(title))}`)

// Each line states what was measured on 0.161.0. A line that stops holding is a change in Codex or in
// the command, and the run exits non-zero.
let drift = 0
function finding(label: string, holds: boolean, detail: unknown = ""): void {
  if (!holds) drift++
  console.log(`${holds ? "HOLDS        " : "DOES NOT HOLD"}  ${label}${detail === "" ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`)
}

let harnessError = false
try {
  await listen(fakeFrizz, 0, "127.0.0.1")
  const frizzPort = (fakeFrizz.address() as { port: number }).port
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port: frizzPort }))
  console.log(`[frizzctl] codex ${CODEX_BIN}\n[frizzctl] ${execFileSync(CODEX_BIN, ["--version"]).toString().trim()} · model slug ${MODEL} · workspace ${root}`)
  console.log(`[frizzctl] fake Frizz on 127.0.0.1:${frizzPort}, named by ${join(stateDir, "server.lock")}\n[frizzctl] the command: ${join(binDir, "frizzctl")}`)

  // THE APP-SERVER THAT PREDATES THE UPDATE: Frizz's own rule for the process environment (everything,
  // minus FRIZZ_*), and no `cc-worker/bin` of ANY Frizz on its PATH, this checkout's or an installed
  // one's (a probe run from inside a Frizz worker inherits the installed server's).
  const appServerEnv: Record<string, string> = { ...inheritWorkerEnvironment(process.env) }
  for (const key of Object.keys(appServerEnv)) if (key.startsWith("CODEX_")) delete appServerEnv[key]
  appServerEnv.CODEX_HOME = codexHome
  appServerEnv.PATH = (appServerEnv.PATH ?? "").split(":").filter((entry) => !/cc-worker\/bin\/?$/.test(entry)).join(":")
  const frizzKeys = Object.keys(appServerEnv).filter((key) => key.startsWith("FRIZZ_"))
  console.log(`app-server environment: FRIZZ_* variables ${JSON.stringify(frizzKeys)}; PATH has ${appServerEnv.PATH.split(":").length} entries, the command's directory among them: ${appServerEnv.PATH.split(":").includes(binDir)}`)
  if (frizzKeys.length || appServerEnv.PATH.split(":").includes(binDir)) throw new Error("the app-server environment is not the pre-update one this probe is about")

  const cwdOf = (label: string) => { const dir = join(root, `cwd-${label}`); mkdirSync(dir, { recursive: true }); return dir }
  const FULL = "danger-full-access"
  // The bag is codexThreadShellConfig's, whole and untouched: the function under test.
  const bagFor = (slug: string) => codexThreadShellConfig(cli, slug, appServerEnv)
  const sampleBag = bagFor("probe-alpha")
  console.log(`the bag for probe-alpha: ${JSON.stringify(Object.fromEntries(Object.entries(sampleBag).map(([key, value]) => [key, key.endsWith(".PATH") ? `${String(value).split(":").slice(0, 2).join(":")}:… (${String(value).split(":").length} entries)` : value])), null, 2)}`)

  // ==== one app-server, started with none of it ======================================================
  console.log("\n======== ONE app-server; the bag is the only thing that knows about frizzctl ========")
  const one = new AppServer("one", appServerEnv)
  console.log(`userAgent: ${await one.initialize()}`)

  // The control: a thread with NO bag, on the same process. If this one can run the command, the
  // readings below say nothing about the bag.
  const none = await one.startThread(cwdOf("none"), FULL)
  console.log(`turn none (no bag): ${await one.run(none.id, "none", titleTo("none", "Probe none"))}`)
  show("marker none", marker("none"))
  showRequests("Probe none")

  const alpha = await one.startThread(cwdOf("alpha"), FULL, bagFor("probe-alpha"))
  const beta = await one.startThread(cwdOf("beta"), FULL, bagFor("probe-beta"))
  console.log(`\nthread probe-alpha: id=${alpha.id}\nthread probe-beta:  id=${beta.id}`)
  // Both at once: two turns interleaved on one process is the case that would mix the callers up.
  const together = await Promise.all([
    one.run(alpha.id, "alpha", titleTo("alpha", "Probe probe-alpha")),
    one.run(beta.id, "beta", titleTo("beta", "Probe probe-beta")),
  ])
  console.log(`turns alpha, beta (concurrent): ${together.join(", ")}`)
  for (const [label, title] of [["alpha", "Probe probe-alpha"], ["beta", "Probe probe-beta"]] as const) { show(`marker ${label}`, marker(label)); showRequests(title) }

  // Where the bag's PATH lands, under the shell Codex starts by default and under `login: false`.
  console.log(`\nturn alpha-path-login: ${await one.run(alpha.id, "alpha-path-login", pathTo("alpha-path-login"))}`)
  console.log(`turn alpha-path-nologin: ${await one.run(alpha.id, "alpha-path-nologin", pathTo("alpha-path-nologin"), { login: false })}`)
  console.log(`turn none-path-login (the control thread): ${await one.run(none.id, "none-path-login", pathTo("none-path-login"))}`)
  console.log(`turn beta-nologin (the command itself, login: false): ${await one.run(beta.id, "beta-nologin", titleTo("beta-nologin", "Probe probe-beta nologin"), { login: false })}`)
  // The first probe saw the order differ on a turn run straight after `thread/start`, so read that too.
  const gamma = await one.startThread(cwdOf("gamma"), FULL, bagFor("probe-gamma"))
  console.log(`turn gamma-path-first (straight after thread/start): ${await one.run(gamma.id, "gamma-path-first", pathTo("gamma-path-first"))}`)
  for (const label of ["alpha-path-login", "alpha-path-nologin", "gamma-path-first", "none-path-login"]) {
    show(`marker ${label}`, marker(label))
    const position = pathPosition(marker(label))
    console.log(position.at < 0 ? `the command's directory is NOT in this shell's PATH (${position.of} entries)` : `the command's directory is PATH entry #${position.at + 1} of ${position.of}; ahead of it: ${position.ahead.join(":") || "nothing"}`)
  }
  show("marker beta-nologin", marker("beta-nologin"))
  showRequests("Probe probe-beta nologin")

  // A sub-agent of probe-alpha runs the same command.
  console.log(`\nturn alpha-spawn: ${await one.run(alpha.id, "alpha-child", titleTo("alpha-child", "Probe child of probe-alpha"), { verb: "PROBE_SPAWN" })}`)
  for (const start = Date.now(); Date.now() - start < 30_000 && !/exit=/.test(marker("alpha-child") ?? ""); await sleep(200)) { /* the child runs on after its parent's turn */ }
  show("marker alpha-child (written by the sub-agent's shell)", marker("alpha-child"))
  show("what the parent's spawn_agent / wait_agent calls returned", toolOutputs.get("alpha-child:parent"))
  showRequests("Probe child of probe-alpha")

  // A thread a human narrowed. Its cwd is under $TMPDIR, which workspace-write leaves writable, so the
  // marker can still be written.
  const narrowed = await one.startThread(cwdOf("ww"), "workspace-write", bagFor("probe-ww"))
  console.log(`\nturn ww (workspace-write): ${await one.run(narrowed.id, "ww", titleTo("ww", "Probe probe-ww"))}`)
  show("marker ww", marker("ww"))
  showRequests("Probe probe-ww")
  await one.stop()

  // ==== a FRESH app-server: thread/resume ============================================================
  console.log("\n======== a FRESH app-server (same pre-update environment): thread/resume ========")
  const two = new AppServer("two", appServerEnv)
  await two.initialize()
  await two.resumeThread(beta.id, FULL, bagFor("probe-beta"))
  console.log(`turn beta-resumed (bag re-sent): ${await two.run(beta.id, "beta-resumed", titleTo("beta-resumed", "Probe probe-beta resumed"))}`)
  // And the control for it: the same resume with no bag.
  await two.resumeThread(alpha.id, FULL)
  console.log(`turn alpha-resumed-nobag: ${await two.run(alpha.id, "alpha-resumed-nobag", titleTo("alpha-resumed-nobag", "Probe probe-alpha no bag"))}`)
  for (const [label, title] of [["beta-resumed", "Probe probe-beta resumed"], ["alpha-resumed-nobag", "Probe probe-alpha no bag"]] as const) { show(`marker ${label}`, marker(label)); showRequests(title) }
  await two.stop()

  // ==== what held ====================================================================================
  console.log("")
  const exitOf = (label: string) => valueIn(marker(label), "exit")
  const one_ = (title: string, slug: string) => { const requests = titled(title); return requests.length === 1 && requests[0]!.body.slug === slug }
  finding("control: with no bag the shell cannot find `frizzctl` (exit 127) and nothing reaches Frizz", exitOf("none") === "127" && titled("Probe none").length === 0, marker("none")?.trim())
  finding("probe-alpha: bare `frizzctl title` exits 0, and Frizz got ONE setOwnThreadTitle carrying slug probe-alpha", exitOf("alpha") === "0" && one_("Probe probe-alpha", "probe-alpha"), slugsOf(titled("Probe probe-alpha")))
  finding("probe-beta: the same, carrying slug probe-beta (the two turns ran at once)", exitOf("beta") === "0" && one_("Probe probe-beta", "probe-beta"), slugsOf(titled("Probe probe-beta")))
  finding("the command printed the board's answer", /This thread is now named "Probe probe-alpha" on the board\./.test(marker("alpha") ?? ""))
  const pathLabels = ["alpha-path-login", "alpha-path-nologin", "gamma-path-first"]
  finding("the bare name resolves to THIS checkout's command: under a login shell, without one, and on a thread's first turn",
    pathLabels.every((label) => valueIn(marker(label), "frizzctl") === join(binDir, "frizzctl")))
  finding("the bag's PATH reaches the shell: the command's directory is in it every time",
    pathLabels.every((label) => pathPosition(marker(label)).at >= 0),
    pathLabels.map((label) => `${label}: #${pathPosition(marker(label)).at + 1} of ${pathPosition(marker(label)).of}`).join(", "))
  // WHERE it lands is printed, not pinned: it moves with the turn (see the header), and the design
  // relies on the directory being present, never on its position.
  const system = new Set(["/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin"])
  for (const label of pathLabels) {
    const position = pathPosition(marker(label))
    const behind = position.ahead.filter((entry) => system.has(entry))
    console.log(`READING        ${label}: entry #${position.at + 1} of ${position.of}, ${behind.length ? `BEHIND ${[...new Set(behind)].join(", ")}` : "ahead of every system directory"}`)
  }
  finding("and it is not in the control thread's PATH on the same process", pathPosition(marker("none-path-login")).at < 0 && valueIn(marker("none-path-login"), "frizzctl") === "")
  finding("with `login: false` the command itself works too", exitOf("beta-nologin") === "0" && one_("Probe probe-beta nologin", "probe-beta"))
  finding("a `spawn_agent` child's command exits 0 and its request carries the PARENT's slug", exitOf("alpha-child") === "0" && one_("Probe child of probe-alpha", "probe-alpha"), slugsOf(titled("Probe child of probe-alpha")))
  finding("resumed on a fresh app-server with the bag re-sent, the command still works as probe-beta", exitOf("beta-resumed") === "0" && one_("Probe probe-beta resumed", "probe-beta"), slugsOf(titled("Probe probe-beta resumed")))
  finding("control: resumed with NO bag, the shell cannot find the command (exit 127)", exitOf("alpha-resumed-nobag") === "127" && titled("Probe probe-alpha no bag").length === 0, marker("alpha-resumed-nobag")?.trim())
  finding("workspace-write: exit 1, the message says \"sandboxed with network access off\", and nothing reaches Frizz",
    exitOf("ww") === "1" && /sandboxed with network access off/.test(marker("ww") ?? "") && titled("Probe probe-ww").length === 0 && !seen.some((request) => request.body?.slug === "probe-ww"))
  finding("Frizz was sent nothing but those five title calls", seen.length === 5 && seen.every((request) => request.url === "/_frizz/proj-1/rpc/setOwnThreadTitle"), seen.map((request) => `${request.url} ${JSON.stringify(request.body)}`))

  console.log(`\nevery request the fake Frizz received, in order:\n${seen.map((request) => `  POST ${request.url} ${JSON.stringify(request.body)}`).join("\n") || "  (none)"}`)
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
  for (const server of [mock, fakeFrizz]) await new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()) })
  console.log(`\n${harnessError ? "THE PROBE COULD NOT FINISH" : drift === 0 ? "EVERY READING IS AS RECORDED" : `${drift} READING(S) DIFFER FROM THE RECORD`}`)
  process.exit(harnessError ? 2 : drift === 0 ? 0 : 1)
}
