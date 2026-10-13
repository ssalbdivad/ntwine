// A DETACHED DAEMON is a module ntwine spawns as its own `node <file>` process. Unlike every other
// module in this workspace it must therefore EXIST AS A REAL FILE at runtime — being reachable
// through an `import` is not enough.
//
// That is the trap this module exists to close. A promoted ntwine artifact is ONE esbuild bundle
// (`<artifact>/runtime/src/index.js`), so a daemon referenced the obvious way —
// `new URL("./thing-daemon.ts", import.meta.url)` — resolves to a sibling path the bundle never
// emitted. `spawn()` still succeeds; node then exits MODULE_NOT_FOUND, and the caller reports the
// generic "daemon exited before it became ready". Nothing in dev catches it, because in a source
// checkout the `.ts` really is on disk.
//
// Live incident 2026-07-23: the Codex app-server moved into a detached daemon at 10:34, the artifact
// was promoted at 12:16, and every Codex dispatch, follow-up, steer and interrupt failed until this
// was found. Three layers now make that unrepeatable:
//   1. artifacts.ts bundles every entry below beside index.js,
//   2. artifacts.ts then ASSERTS each one landed — a build that would ship a missing daemon fails,
//   3. resolveDetachedDaemonEntry() checks the file exists and names what it looked for if not.
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

/** Every module spawned as its own node process, as a path relative to the `ui` workspace root. */
export const DETACHED_DAEMON_ENTRIES = [
  "packages/server/src/backend/codex-app-server-daemon.ts",
  // The Claude session broker: owns a live Claude Agent SDK session and serves a socket, so the
  // session survives a ntwine restart (ntwine reconnects instead of cold resume-from-disk). Forked by
  // claude-broker-host.ts; run as its own `node <file>` process, so it must ship as a real sibling .js.
  "packages/server/src/backend/claude-agent-broker.ts",
  // The ACP agent daemon: owns one ACP agent child per thread and serves its JSON-RPC over a socket,
  // so the agent and its running turn survive a ntwine restart. Forked by acp-host.ts.
  "packages/server/src/backend/acp-daemon.ts",
  // Deliberately SHORT beyond these. One thing is pointedly absent:
  //
  //   dev-bootstrap.ts — see the exemption in dev-supervisor.ts. Emitting it woke a control-plane
  //     path that had been dead in artifacts since artifacts existed, and that path is not safe to
  //     run there yet.
  //
  // Add an entry only when something is genuinely spawned as its own process IN PRODUCTION.
] as const

/** The filename an entry must be emitted under, beside the runtime bundle. */
export function detachedDaemonOutputName(entry: string): string {
  return (entry.split("/").pop() ?? entry).replace(/\.ts$/, ".js")
}

/**
 * Resolve a spawnable daemon file next to the CALLER's module: the bundled `.js` in a promoted
 * artifact, the `.ts` in a source checkout. Pass the caller's own `import.meta.url` — in the bundle
 * every module reports the bundle's URL, which is exactly where the daemons are emitted.
 *
 * Throws naming both candidates rather than handing `spawn()` a path that does not exist, so the
 * failure reads as a packaging bug instead of a mysterious dead daemon.
 */
export function resolveDetachedDaemonEntry(moduleUrl: string, basename: string): string {
  const candidates = [`./${basename}.js`, `./${basename}.ts`].map((rel) => fileURLToPath(new URL(rel, moduleUrl)))
  const found = candidates.find((path) => existsSync(path))
  if (!found) throw new Error(`ntwine is missing the ${basename} entry — looked for ${candidates.join(" and ")}`)
  return found
}
