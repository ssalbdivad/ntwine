import { execFile } from "node:child_process"
import { lstatSync, realpathSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { promisify } from "node:util"
import { ThreadSlug } from "@ntwine/shared"

const execFileP = promisify(execFile)

// We SHELL OUT to the ntwine board scripts (board/*.mjs) rather than importing them.
// They are zero-dep plain node but pull in a wide internal module graph (ownership, bindings,
// agent-status, decisions) and read the project via CLAUDE_PROJECT_DIR/cwd — invoking the CLI
// with that env is the robust, drift-proof path (the board logic is never duplicated here, per
// the architecture invariant). The scripts dir is resolved relative to this package (the ntwine
// monorepo) and overridable via NTWINE_SCRIPTS_DIR for a marketplace-installed plugin later.
//
// RISK: the default path assumes the server runs inside the ntwine monorepo. A standalone install
// against another repo must set NTWINE_SCRIPTS_DIR to the installed plugin's scripts/ntwine dir.
export function ntwineScriptsDir(): string {
  if (process.env.NTWINE_SCRIPTS_DIR) return process.env.NTWINE_SCRIPTS_DIR
  // src/ -> server -> packages -> <repo root>
  return resolve(import.meta.dirname, "..", "..", "..", "board")
}

// The per-thread shape emitted by `ntwine --json` (index.mjs, the --json branch). Parsed
// DEFENSIVELY: only the fields the board read-model needs are typed; unknowns are ignored.
export interface NtwineThread {
  id: string
  title: string
  status: string
  status_text?: string
  activity?: string // form-constrained gerund label (≤100 chars) — the UI listing-row gloss
  next?: string
  hasPlan?: boolean // derived: the body has a `## Plan` section (drives the UI's quiet PLAN badge)
  mechanism?: string
  humanBlocked?: boolean
  ready?: boolean
  threadDeps?: string[]
  externalDeps?: { type: string; label: string }[]
  owner?: string | null
  revalidate?: { atMs: number } | null
  agents?: { id: string; label?: string; state?: string }[]
  errors?: string[]
  warnings?: string[]
}

// Structured, per-file error emitted alongside the legacy `errors` strings by the ntwine --json branch.
// `kind: "no-frontmatter"` is the one-click-repairable case; the server surfaces it to the client so
// the board banner can offer a Repair button (see repair.ts + the repairThread RPC).
export interface NtwineErrorItem {
  file: string
  kind: "no-frontmatter" | "other"
  message: string
}

export interface NtwineBoard {
  config: unknown
  threads: NtwineThread[]
  errors: string[]
  warnings: string[]
  errorItems: NtwineErrorItem[]
}

function directNtwineRoot(projectDir: string): string | null {
  try {
    const projectRoot = realpathSync(projectDir)
    const path = join(projectRoot, ".ntwine")
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null
    const real = realpathSync(path)
    return dirname(real) === projectRoot && basename(real) === ".ntwine" ? real : null
  } catch {
    return null
  }
}

// Whether `.ntwine/` exists. This is a STORAGE capability probe (scratchpads, the legacy CLI —
// which would just print a "no .ntwine/" notice), NOT a board-existence check: threads are session-first
// and live in the ui.db registry, so a project with no `.ntwine/` can still have a full board, and
// dispatch creates the directory on its way (see writeScratchDir).
export function ntwineDirExists(projectDir: string): boolean {
  return directNtwineRoot(projectDir) !== null
}

export async function readBoard(projectDir: string, scriptsDir = ntwineScriptsDir()): Promise<NtwineBoard> {
  if (!directNtwineRoot(projectDir)) throw new Error("unsafe or missing .ntwine directory")
  const { stdout } = await execFileP("node", [join(scriptsDir, "index.mjs"), "--json"], {
    cwd: projectDir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    maxBuffer: 32 * 1024 * 1024,
  })
  const parsed = JSON.parse(stdout) as Partial<NtwineBoard>
  const rawThreads = Array.isArray(parsed.threads) ? parsed.threads : []
  const invalidIds = rawThreads
    .map((thread) => thread?.id)
    .filter((id) => !ThreadSlug.safeParse(id).success)
  const invalidErrors = invalidIds.map((id) => `Ignored legacy thread with unsafe filename stem ${JSON.stringify(String(id))}`)
  const invalidErrorItems: NtwineErrorItem[] = invalidIds.map((id) => ({
    file: JSON.stringify(String(id)),
    kind: "other",
    message: "Legacy thread filename must use lowercase ASCII letters, digits, and hyphens",
  }))
  return {
    config: parsed.config ?? {},
    threads: rawThreads.filter((thread) => ThreadSlug.safeParse(thread?.id).success),
    errors: [...(Array.isArray(parsed.errors) ? parsed.errors : []), ...invalidErrors],
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
    // Additive: absent on a pre-update ntwine script (older board scripts) → [] (the board just loses the
    // repair affordance, never the plain error strings).
    errorItems: [...(Array.isArray(parsed.errorItems) ? parsed.errorItems : []), ...invalidErrorItems],
  }
}

// Structured thread-file write, through the SAME code path as `ntwine-update` (never a
// hand-rolled markdown edit). e.g. runThreadUpdate(dir, slug, ["--status", "done"]).
export async function runThreadUpdate(
  projectDir: string,
  slug: string,
  args: string[],
  scriptsDir = ntwineScriptsDir(),
): Promise<void> {
  await execFileP("node", [join(scriptsDir, "thread-update.mjs"), slug, ...args], {
    cwd: projectDir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  })
}
