// The MCP servers a ntwine worker mounts BESIDES the unified `ntwine` server — and, since 2026-09-03, the
// ONLY servers it mounts: every worker launches under `--strict-mcp-config`, so what this module returns
// plus the ntwine mount (claudeMcpConfig, dispatch.ts) is the whole MCP surface of a thread.
//
// WHY STRICT. Without it the CLI discovers every scope a plain `claude` would: the project's `.mcp.json`
// AND the operator's user-scope servers in `~/.claude.json`. Measured 2026-09-02 on the maintainer's
// machine with nine live workers: the user-scope `chrome-real` (an npx chrome-devtools-mcp) and the
// project's `chrome-devtools` both booted in EVERY worker — 18 browser servers, 36 processes, 4.2 GB —
// none of it asked for by any thread. A user-scope stdio server is a process the operator wants beside
// THEIR OWN sessions; a fleet multiplying it by N is not what `claude mcp add --scope user` meant, and
// it was the largest avoidable block in the two memory crashes of that day.
//
// WHAT A WORKER GETS, lowest precedence first (a later entry wins a name collision):
//   1. the operator's user-scope REMOTE servers (`type: "http" | "sse"` in `~/.claude.json`, both the
//      machine-wide map and the cwd's local-scope record). A URL costs no process, so nothing about the
//      double-spawn applies to them, and dropping them would change what a worker can reach for no
//      memory in return.
//   2. the project's `.mcp.json`, filtered by the SAME approval Claude Code applies to it: a server loads
//      iff it is not in `disabledMcpjsonServers` and either `enableAllProjectMcpServers` is set or it is
//      named in `enabledMcpjsonServers` — read from the project's `.claude/settings.json` and
//      `.claude/settings.local.json`, the user settings file, and the cwd's record in `~/.claude.json`,
//      unioned. A headless worker cannot answer the approval prompt, so an unapproved server is skipped
//      exactly as `claude -p` skips it.
//   3. the `ntwine` server, which always wins (workerMcpServers below).
// User-scope STDIO servers are the one thing deliberately absent. An operator who wants one in the fleet
// declares it in the project's `.mcp.json`: that is the scope that means "this repo's sessions".
//
// WHEN they start is the broker daemon's business, not this module's: it hands every project stdio server
// to the lazy MCP host, which mounts it in the worker as a loopback `http` server and starts the real
// command on the first tool call (lazy-mcp-host.ts). What a worker CAN reach is decided here, unchanged.
//
// `${VAR}` and `${VAR:-default}` in command/args/env/url/headers are expanded HERE against the worker's
// environment: under strict mode the CLI receives these servers in a config file ntwine writes, and ntwine should
// not depend on whether it expands that config the way it expands a discovered file. A reference with no value
// and no default drops that server, which is what the CLI does with a discovered one.
//
// Every read fails OPEN to "no servers": a missing or malformed file is an empty one and never blocks a
// dispatch.
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface StdioMcpServer { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
export interface RemoteMcpServer { type: "http" | "sse"; url: string; headers?: Record<string, string> }
export type WorkerMcpServer = StdioMcpServer | RemoteMcpServer
export type WorkerMcpServers = Record<string, WorkerMcpServer>

export interface ProjectMcpServersOptions {
  /** The worker's environment — what `${VAR}` references resolve against. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Claude Code's config dir. Defaults to `CLAUDE_CONFIG_DIR` (from `env`), else `~/.claude`. When it
   *  is an override, `.claude.json` lives INSIDE it; otherwise beside it in `home` — the same rule
   *  auth-status.ts follows. Tests point this at a fixture. */
  claudeConfigDir?: string
  /** Defaults to `os.homedir()`. */
  home?: string
}

type JsonObject = Record<string, unknown>

function readJsonObject(path: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : undefined
  } catch {
    return undefined
  }
}

function objectField(source: JsonObject | undefined, key: string): JsonObject | undefined {
  const value = source?.[key]
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined
}

function stringList(source: JsonObject | undefined, key: string): string[] {
  const value = source?.[key]
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as JsonObject)) {
    if (typeof entry === "string") out[key] = entry
  }
  return out
}

// `${VAR}` and `${VAR:-default}` — the two forms Claude Code documents for `.mcp.json`.
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

/** Expand every env reference in `value`; `undefined` when a reference has neither a value nor a default. */
export function expandMcpEnvRefs(value: string, env: NodeJS.ProcessEnv): string | undefined {
  let unresolved = false
  const out = value.replace(ENV_REF, (_match, name: string, fallback: string | undefined) => {
    const resolved = env[name]
    if (resolved !== undefined) return resolved
    if (fallback !== undefined) return fallback
    unresolved = true
    return ""
  })
  return unresolved ? undefined : out
}

function expandMap(map: Record<string, string> | undefined, env: NodeJS.ProcessEnv): Record<string, string> | undefined | null {
  if (!map) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(map)) {
    const expanded = expandMcpEnvRefs(value, env)
    if (expanded === undefined) return null
    out[key] = expanded
  }
  return out
}

/** Normalize one raw server record to the shapes a worker can mount, with env references expanded.
 *  Anything else (an `sdk`-type server, a malformed record, an unresolved reference) is `undefined`. */
export function normalizeMcpServer(raw: unknown, env: NodeJS.ProcessEnv): WorkerMcpServer | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const record = raw as JsonObject
  const type = typeof record.type === "string" ? record.type : undefined
  if (type === "http" || type === "sse") {
    if (typeof record.url !== "string") return undefined
    const url = expandMcpEnvRefs(record.url, env)
    const headers = expandMap(stringMap(record.headers), env)
    if (url === undefined || headers === null) return undefined
    return { type, url, ...(headers ? { headers } : {}) }
  }
  if (type !== undefined && type !== "stdio") return undefined
  if (typeof record.command !== "string") return undefined
  const command = expandMcpEnvRefs(record.command, env)
  if (command === undefined) return undefined
  const args: string[] = []
  for (const entry of Array.isArray(record.args) ? record.args : []) {
    if (typeof entry !== "string") return undefined
    const expanded = expandMcpEnvRefs(entry, env)
    if (expanded === undefined) return undefined
    args.push(expanded)
  }
  const serverEnv = expandMap(stringMap(record.env), env)
  if (serverEnv === null) return undefined
  return { command, ...(args.length ? { args } : {}), ...(serverEnv ? { env: serverEnv } : {}) }
}

interface Approval { all: boolean; enabled: Set<string>; disabled: Set<string> }

function collectApproval(layers: Array<JsonObject | undefined>): Approval {
  const approval: Approval = { all: false, enabled: new Set(), disabled: new Set() }
  for (const layer of layers) {
    if (layer?.enableAllProjectMcpServers === true) approval.all = true
    for (const name of stringList(layer, "enabledMcpjsonServers")) approval.enabled.add(name)
    for (const name of stringList(layer, "disabledMcpjsonServers")) approval.disabled.add(name)
  }
  return approval
}

/** The servers the operator's user scope contributes to a worker: remote ones only (see the header). */
function userScopeRemoteServers(account: JsonObject | undefined, cwd: string, env: NodeJS.ProcessEnv): WorkerMcpServers {
  const out: WorkerMcpServers = {}
  const maps = [objectField(account, "mcpServers"), objectField(objectField(objectField(account, "projects"), cwd), "mcpServers")]
  for (const map of maps) {
    for (const [name, raw] of Object.entries(map ?? {})) {
      const server = normalizeMcpServer(raw, env)
      if (server && server.type !== undefined && server.type !== "stdio") out[name] = server
    }
  }
  return out
}

/** Everything a worker in `cwd` mounts besides the ntwine server. See the header for the rule. */
export function projectMcpServers(cwd: string, options: ProjectMcpServersOptions = {}): WorkerMcpServers {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const configOverride = options.claudeConfigDir ?? (env.CLAUDE_CONFIG_DIR?.trim() ? env.CLAUDE_CONFIG_DIR.trim() : undefined)
  const accountFile = configOverride ? join(configOverride, ".claude.json") : join(home, ".claude.json")
  const userSettingsFile = join(configOverride ?? join(home, ".claude"), "settings.json")
  const account = readJsonObject(accountFile)

  const out: WorkerMcpServers = userScopeRemoteServers(account, cwd, env)

  const declared = objectField(readJsonObject(join(cwd, ".mcp.json")), "mcpServers")
  if (!declared) return out
  const approval = collectApproval([
    readJsonObject(join(cwd, ".claude", "settings.json")),
    readJsonObject(join(cwd, ".claude", "settings.local.json")),
    readJsonObject(userSettingsFile),
    objectField(objectField(account, "projects"), cwd),
  ])
  for (const [name, raw] of Object.entries(declared)) {
    if (approval.disabled.has(name)) continue
    if (!approval.all && !approval.enabled.has(name)) continue
    const server = normalizeMcpServer(raw, env)
    if (server) out[name] = server
  }
  return out
}

/** The complete mount for one worker: the project's servers with the ntwine server layered over them, so
 *  a project cannot shadow `ntwine` by declaring a server of that name. */
export function workerMcpServers(project: WorkerMcpServers | undefined, ntwine: WorkerMcpServers | undefined): WorkerMcpServers {
  return { ...(project ?? {}), ...(ntwine ?? {}) }
}
