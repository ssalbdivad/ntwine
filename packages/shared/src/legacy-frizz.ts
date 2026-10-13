// LEGACY — EVERYTHING THE SHARED PACKAGE STILL KNOWS ABOUT THE OLD NAME. This product was Frizz until
// 2026-10-13 (the rename is 67962b73, 12:32 EDT). Processes started before then are still running on the
// maintainer's machine, and they speak the old name: they hand out FRIZZ_* variables, call `/_frizz/…`,
// and write the old spelling into the transcripts Ntwine reads. This file is the whole of what reads
// them, so retiring the old name here is deleting this file and unwrapping its callers.
//
// REMOVE (this file, its tests, and every import of it) by the runbook in the thread notes that made it
// (`frizz-final-pass.md`), once no process started before the rename is alive. Its gate:
//   for p in /proc/[0-9]*; do [ "${p#/proc/}" = $$ ] && continue
//     tr '\0' '\n' < $p/environ 2>/dev/null | grep -qE '^FRIZZ_|/(share|state)/frizz(/|$)|/\.cache/frizz(/|$)|/\.frizz(/|$)' && echo "${p#/proc/}"
//   done
// prints nothing. cc-worker/lib/legacy-frizz.mjs is the dependency-free twin of the environment shim
// below, for the worker scripts; keep the two agreeing.

// ── The environment ─────────────────────────────────────────────────────────────────────────────────
// A process started by pre-rename code keeps handing out FRIZZ_* variables until it exits: a pre-rename
// broker runs today's hook scripts with them. Every entry imports this module FIRST, before anything reads
// the environment, so each one is read under its NTWINE_* name. An NTWINE_* value already set always wins.
const LEGACY_ENV_PREFIX = "FRIZZ_"

type Env = Record<string, string | undefined>

export function adoptLegacyEnv(env: Env): void {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(LEGACY_ENV_PREFIX) || value === undefined) continue
    const renamed = `NTWINE_${key.slice(LEGACY_ENV_PREFIX.length)}`
    if (env[renamed] === undefined) env[renamed] = value
    // Moved, not copied: code that later deletes the NTWINE_* name must not see it come back from here.
    delete env[key]
  }
}

// Reached through `globalThis` because the browser bundle imports this module too (through the package
// index), and has no environment and no Node types.
const processEnv = (globalThis as { process?: { env?: Env } }).process?.env
if (processEnv) adoptLegacyEnv(processEnv)

// ── The route prefix ────────────────────────────────────────────────────────────────────────────────
// A pre-rename worker's MCP server (`frizz-mcp.mjs`, started lazily and alive since) still calls
// `/_frizz/…`, so the server reads that prefix as its own. `prefix` is NTWINE_ROUTE_PREFIX, passed in so
// this file imports nothing from the index (which imports it).
const LEGACY_ROUTE_PREFIX = "/_frizz"

export function adoptLegacyRoute(url: string, prefix: string): string {
  return url === LEGACY_ROUTE_PREFIX || url.startsWith(`${LEGACY_ROUTE_PREFIX}/`) || url.startsWith(`${LEGACY_ROUTE_PREFIX}?`)
    ? `${prefix}${url.slice(LEGACY_ROUTE_PREFIX.length)}`
    : url
}

// ── Stored text ─────────────────────────────────────────────────────────────────────────────────────
// Everything Ntwine wrote into a transcript before the rename — markers, wake tokens, notices, trailers,
// the completion relay's idempotence marker, the `frizz:` sub-agent namespace — spells the name the old
// way, and a pre-rename worker keeps writing it until it exits. The text lives in Claude Code's and
// Codex's own transcripts, which Ntwine reads and never rewrites (discover.ts). Every recognizer that
// reads stored text matches both spellings through these helpers, so the old spelling is derived from the
// current constant and the two cannot drift.
//
// Removing these is a product decision as well as a cleanup: once they go, a thread whose transcript
// predates the rename shows its old markers as text and loses what they drove (a wake is not recognized
// as one, a merged wake is not split). The runbook says so.

/** `text` as Ntwine wrote it before the rename. */
export function frizzWording(text: string): string {
  return text.replaceAll("Ntwine", "Frizz").replaceAll("ntwine", "frizz").replaceAll("NTWINE", "FRIZZ")
}

/** Every spelling stored text may carry `text` in: today's, then the pre-rename one when it differs. */
export function brandSpellings(text: string): string[] {
  const old = frizzWording(text)
  return old === text ? [text] : [text, old]
}

/** `re`, matching the product's name in either spelling wherever its source names it. */
export function eitherBrand(re: RegExp): RegExp {
  return new RegExp(
    re.source.replace(/NTWINE|Ntwine|ntwine/g, (name) => `(?:${name}|${frizzWording(name)})`),
    re.flags,
  )
}
