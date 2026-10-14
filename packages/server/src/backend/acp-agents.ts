import { accessSync, constants, statSync } from "node:fs"
import { access, stat } from "node:fs/promises"
import { delimiter, isAbsolute, join } from "node:path"
import { ACP_MODEL_PREFIX, acpAgentIdFromModel, acpModelSlug } from "@ntwine/shared"

// Which ACP agents ntwine knows how to launch, and which of them this machine actually has.
//
// ACP agents are PATH-resolved, never provisioned (plans/acp-backend.md, decision 5): the operator
// installs and logs into `opencode`, `gemini`, `copilot` … with the vendor's own installer and CLI, and
// ntwine only needs to know the executable and the argument that puts it into ACP mode. The registry at
// github.com/agentclientprotocol/registry is the source for those launch shapes; the ones here are the
// agents with measurable usage in 2026 (see plans/acp-backend.md) plus the ones that share a binary
// family with them. Anything else rides `settings.acpAgents`, the same shape, and wins on id collision.

export interface AcpAgentSpec {
  /** Stable id, used as the thread's `acp_agent` column and the composer's `acp:<id>` model slug. */
  id: string
  label: string
  /** Executable name (looked up on PATH) or an absolute path. */
  command: string
  args: string[]
}

export const ACP_AGENT_CATALOGUE: readonly AcpAgentSpec[] = [
  { id: "opencode", label: "OpenCode", command: "opencode", args: ["acp"] },
  { id: "cursor", label: "Cursor agent", command: "cursor-agent", args: ["acp"] },
  { id: "gemini", label: "Gemini CLI", command: "gemini", args: ["--acp"] },
  { id: "copilot", label: "GitHub Copilot CLI", command: "copilot", args: ["--acp"] },
  { id: "kilo", label: "Kilo", command: "kilo", args: ["acp"] },
  { id: "qwen", label: "Qwen Code", command: "qwen", args: ["--acp"] },
  { id: "goose", label: "goose", command: "goose", args: ["acp"] },
  { id: "kimi", label: "Kimi CLI", command: "kimi", args: ["acp"] },
  // `grok agent stdio` is ACP over stdio (registry: `npx @xai-official/grok agent stdio`); verified
  // live 2026-09-16 against grok 1.0.13 — it mounted the probe MCP server and called its tool.
  { id: "grok", label: "Grok Build", command: "grok", args: ["agent", "stdio"] },
  // pi has no native ACP mode; `pi-acp` is its registry wrapper and takes no arguments.
  { id: "pi", label: "pi", command: "pi-acp", args: [] },
]

/** What the operator writes under `settings.acpAgents`: the spec with `args` optional. */
export type AcpAgentInput = Omit<AcpAgentSpec, "args"> & { args?: readonly string[] }

export interface ResolvedAcpAgent extends AcpAgentSpec {
  /** The absolute executable, when it was found. */
  bin?: string
}

// The `acp:<id>` model-slug grammar lives in @ntwine/shared so the composer and the dispatcher cannot drift.
export { ACP_MODEL_PREFIX, acpAgentIdFromModel, acpModelSlug }

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    if (process.platform !== "win32") accessSync(path, constants.X_OK)
    return true
  } catch { return false }
}

/** Find `command` on PATH (or verify it as an absolute path). Windows also tries PATHEXT suffixes. */
export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (isAbsolute(command)) return isExecutableFile(command) ? command : undefined
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)
  const exts = process.platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""]
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, command + ext.toLowerCase())
      if (isExecutableFile(candidate)) return candidate
      if (ext && isExecutableFile(join(dir, command + ext))) return join(dir, command + ext)
    }
  }
  return undefined
}

/** The catalogue merged with the operator's own entries (theirs win on id), in catalogue order. */
export function acpAgentSpecs(custom: readonly AcpAgentInput[] | undefined): AcpAgentSpec[] {
  const byId = new Map<string, AcpAgentSpec>()
  for (const spec of ACP_AGENT_CATALOGUE) byId.set(spec.id, spec)
  for (const spec of custom ?? []) if (spec.id && spec.command) byId.set(spec.id, { ...spec, args: [...(spec.args ?? [])] })
  return [...byId.values()]
}

/** Every known agent, with `bin` set for the ones present on this machine. */
export function listAcpAgents(custom: readonly AcpAgentInput[] | undefined, env: NodeJS.ProcessEnv = process.env): ResolvedAcpAgent[] {
  return acpAgentSpecs(custom).map((spec) => {
    const bin = findOnPath(spec.command, env)
    return bin ? { ...spec, bin } : { ...spec }
  })
}

// THE `acpAgents` RPC NEVER WALKS PATH ON THE EVENT LOOP. The synchronous walk above is a `stat` per PATH
// entry per agent, and on WSL the inherited Windows PATH puts ~30 `/mnt/c/…` entries in it, each a 9P round
// trip: measured 1.9–2.3s for the ten catalogue agents on 2026-10-01, every call. The composer asks on every
// project switch, so opening another project's thread from the queue stalled `board` and `threadTranscript`
// behind it — the drawer took ~5s to appear. So the RPC reads this instead: the same answer, found with
// parallel async stats, memoized per PATH + agent list. A fresh entry is served as is; a stale one is still
// served at once and re-walked in the background, so an agent installed while ntwine runs shows up a call
// later rather than never. The dispatch path keeps the synchronous walk: it resolves ONE agent, once, and
// needs the answer before it can spawn.
const AGENT_LIST_TTL_MS = 60_000
const agentListCache = new Map<string, { at: number; value: Promise<ResolvedAcpAgent[]> }>()

async function isExecutableFileAsync(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false
    if (process.platform !== "win32") await access(path, constants.X_OK)
    return true
  } catch { return false }
}

/** `findOnPath`, with every candidate checked concurrently and PATH order still deciding the winner. */
export async function findOnPathAsync(command: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (isAbsolute(command)) return (await isExecutableFileAsync(command)) ? command : undefined
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)
  const exts = process.platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""]
  const candidates = dirs.flatMap((dir) => exts.flatMap((ext) => {
    const lower = join(dir, command + ext.toLowerCase())
    const exact = join(dir, command + ext)
    return ext && exact !== lower ? [lower, exact] : [lower]
  }))
  const found = await Promise.all(candidates.map(isExecutableFileAsync))
  return candidates[found.indexOf(true)]
}

async function walkAcpAgents(specs: AcpAgentSpec[], env: NodeJS.ProcessEnv): Promise<ResolvedAcpAgent[]> {
  return await Promise.all(specs.map(async (spec) => {
    const bin = await findOnPathAsync(spec.command, env)
    return bin ? { ...spec, bin } : { ...spec }
  }))
}

/** `listAcpAgents` for the RPC: off the event loop, memoized, stale-while-revalidate (see above). */
export function listAcpAgentsCached(custom: readonly AcpAgentInput[] | undefined, env: NodeJS.ProcessEnv = process.env, now = Date.now()): Promise<ResolvedAcpAgent[]> {
  const specs = acpAgentSpecs(custom)
  // The whole spec list is in the key, so a settings edit is a new entry, never a stale answer.
  const key = JSON.stringify([env.PATH ?? env.Path ?? "", specs])
  const hit = agentListCache.get(key)
  if (hit && now - hit.at < AGENT_LIST_TTL_MS) return hit.value
  if (hit) {
    // Re-walk in the background; the stale answer keeps serving, and a pass still running is not doubled.
    hit.at = now
    const value = walkAcpAgents(specs, env)
    value.then(() => agentListCache.set(key, { at: Date.now(), value }), () => {})
    return hit.value
  }
  const value = walkAcpAgents(specs, env)
  agentListCache.set(key, { at: now, value })
  value.catch(() => agentListCache.delete(key))
  return value
}

export function resolveAcpAgent(id: string, custom: readonly AcpAgentInput[] | undefined, env: NodeJS.ProcessEnv = process.env): ResolvedAcpAgent | undefined {
  const spec = acpAgentSpecs(custom).find((s) => s.id === id)
  if (!spec) return undefined
  const bin = findOnPath(spec.command, env)
  return bin ? { ...spec, bin } : { ...spec }
}
