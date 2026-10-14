// A worker asking for one of the operator's MCP servers — `ntwinectl mcp-request`.
//
// A Claude worker mounts its project's servers and nothing from the operator's user scope that runs a
// process (project-mcp-servers.ts has why: a fleet multiplied every personal server by N). Some of those
// servers are what a task needs — a desktop-control server for a screenshot of a native window — and
// some are exactly what a worker should never hold unasked, for the same reason. So a worker sees the
// rest of the user scope BY NAME, in its system prompt (mcpOnRequestSection), and asks for one; the ask
// is an ordinary registered question whose question and options the SERVER writes (mcpRequestQuestion),
// so what the human approves cannot be reworded by the worker asking.
//
// THE ANSWER IS THE GRANT, and the question row is its only record:
//   · "this thread"  — mounted into the live session now (the broker's `mount-mcp`), and at every later
//                      fork of the thread, which reads its grants off its own answered rows
//                      (threadMcpGrants). No table of its own: a grant cannot outlive or disagree with
//                      the card that gave it.
//   · "this project" — written to the project's LOCAL scope in `~/.claude.json` through Claude Code's own
//                      `claude mcp add-json --scope local`, which every worker in the project then mounts
//                      (project-mcp-servers.ts), and which the operator undoes with
//                      `claude mcp remove --scope local <name>`. Mounted into this session too.
//   · no             — nothing happens; the worker reads the answer.
//
// Claude workers only. A Codex worker already loads every server in `~/.codex/config.toml` itself.
import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import type { AskedQuestion } from "@ntwine/shared"
import { lazyMcpCacheKey } from "./backend/lazy-mcp-host.ts"
import { requestableMcpServers, type StdioMcpServer } from "./backend/project-mcp-servers.ts"
import { ntwineRoots } from "./ntwine-paths.ts"
import type { ThreadQuestionRow } from "./storage.ts"

export const MCP_GRANT_THREAD = "Allow in this thread"
export const MCP_GRANT_PROJECT = "Allow in every thread of this project"
export const MCP_GRANT_NONE = "Don't allow"

export type McpGrant = "thread" | "project"

function commandLine(server: StdioMcpServer): string {
  return [server.command, ...(server.args ?? [])].join(" ")
}

/** The question an `mcp-request` registers, whatever the worker sent: the server's own words, with the
 *  worker's reason quoted as the reason. */
export function mcpRequestQuestion(name: string, server: StdioMcpServer, reason: string): AskedQuestion {
  return {
    question: `Allow the worker to use your \`${name}\` MCP server (\`${commandLine(server)}\`)?\n\nIts reason: ${reason}`,
    header: "MCP server",
    kind: "question",
    mcp: name,
    options: [
      { label: MCP_GRANT_THREAD, description: "Its tools are available from the worker's next turn, for the rest of this thread." },
      { label: MCP_GRANT_PROJECT, description: `Every thread in this project gets it. Undo with \`claude mcp remove --scope local ${name}\` in the project folder.` },
      { label: MCP_GRANT_NONE, description: "The worker carries on without it." },
    ],
  }
}

function parseJson(text: string | null): Record<string, unknown> | undefined {
  if (!text) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** The grant an answered `mcp-request` row gave, if any — by the label the human picked. */
export function mcpGrantOf(row: Pick<ThreadQuestionRow, "spec" | "answer" | "state">): { name: string; grant: McpGrant } | undefined {
  if (row.state !== "answered") return undefined
  const name = parseJson(row.spec)?.mcp
  if (typeof name !== "string" || !name) return undefined
  const chosen = parseJson(row.answer)?.chosen
  const picked = Array.isArray(chosen) ? chosen[0] : undefined
  if (picked === MCP_GRANT_THREAD) return { name, grant: "thread" }
  if (picked === MCP_GRANT_PROJECT) return { name, grant: "project" }
  return undefined
}

/** Every server the human granted this thread, read off its own answered requests. */
export function threadMcpGrants(rows: readonly ThreadQuestionRow[]): string[] {
  return [...new Set(rows.flatMap((row) => mcpGrantOf(row)?.name ?? []))]
}

/** Write `name` into `cwd`'s local scope through Claude Code itself, so the write takes its lock on
 *  `~/.claude.json` rather than racing every running session that rewrites that file. */
export async function grantMcpToProject(claudeBin: string, cwd: string, name: string, server: StdioMcpServer): Promise<void> {
  const config = { type: "stdio", command: server.command, args: server.args ?? [], ...(server.env ? { env: server.env } : {}) }
  await promisify(execFile)(claudeBin, ["mcp", "add-json", "--scope", "local", name, JSON.stringify(config)], { cwd, timeout: 30_000 })
}

/** The tool names a server answered last time it ran for `cwd`, from the lazy host's cache. */
function cachedToolNames(server: StdioMcpServer, cwd: string): string[] {
  try {
    const cache = JSON.parse(readFileSync(join(ntwineRoots().data, "mcp-cache", `${lazyMcpCacheKey(server, cwd)}.json`), "utf8"))
    const tools: unknown = cache?.answers?.["tools/list"]?.result?.tools
    return Array.isArray(tools) ? tools.flatMap((t) => typeof t?.name === "string" ? [t.name as string] : []) : []
  } catch {
    return []
  }
}

/** The system-prompt section naming what this worker could request. Empty when there is nothing. */
export function mcpOnRequestSection(cwd: string, grants: readonly string[], env: NodeJS.ProcessEnv = process.env): string {
  const servers = Object.entries(requestableMcpServers(cwd, { env, grants }))
  if (servers.length === 0) return ""
  const lines = servers.map(([name, server]) => {
    const tools = cachedToolNames(server, cwd)
    const shown = tools.length > 24 ? [...tools.slice(0, 24), "…"] : tools
    return `- \`${name}\` — \`${commandLine(server)}\`${shown.length ? `; tools: ${shown.join(", ")}` : ""}`
  })
  return (
    "MCP SERVERS ON REQUEST — the user has these MCP servers configured, and they are NOT mounted in this thread:\n" +
    `${lines.join("\n")}\n` +
    "If one would materially help the task, ask for it: `ntwinectl mcp-request <name> --reason-file - <<'EOF'` with one or two " +
    "sentences on what it is for. The user allows it for this thread or this project, and its tools (`mcp__<name>__*`) are " +
    "yours from your next turn. It is a registered question like `ask`: rest after asking. Never request one the task does not need."
  )
}
