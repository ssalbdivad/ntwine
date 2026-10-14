import { createHash } from "node:crypto"
import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { ntwinePaths } from "./ntwine-paths.ts"

// THE STABLE WORKER PLUGIN PATH — the one thing that makes a live plugin reload useful.
//
// A worker is launched against a plugin directory and reads its HOOKS from there. The Claude Agent
// SDK can re-read that directory on demand (`query.reloadPlugins()`), but the request takes NO
// arguments: it re-reads whatever path the session started with. ntwine's paths are the problem —
// dev workers point at `~/.ntwine/builds/<sha>/runtime/cc-worker` and production workers at
// `<npm package>/runtime/cc-worker`, and BOTH are immutable and version-specific. Reloading one
// re-reads the same old bytes, so the reload is a no-op and a worker can never move forward.
//
// So ntwine stages each version's plugin under its own directory and publishes ONE stable path that
// points at the current one. A worker launched against the stable path can then be moved onto a newer
// plugin by repointing the link and asking it to reload — no restart, no lost context, no lost
// in-memory sub-agents. Measured: repointing this link mid-session and calling reloadPlugins() arms a
// hook the process did not start with.
//
// BOTH HALVES ARE WIRED (2026-10-11), and nobody presses anything. `workerPluginDir()` in dispatch.ts
// stages the plugin an artifact launch was handed and returns the stable path, so booting a new
// version IS the repoint; and each worker daemon compares `pluginFingerprint` of that path at its own
// turn boundaries and reloads when it moved (backend/claude-plugin-sync.ts). The link alone already
// moves every hook SCRIPT, because `${CLAUDE_PLUGIN_ROOT}/hooks/x.mjs` is resolved through it on each
// run; the reload is what moves the hook REGISTRATIONS, the skills and the sub-agent profiles.
//
// Staging is a COPY, deliberately, rather than a link straight into the source tree. In production the
// plugin lives inside an npx execution cache, which npm may evict while a worker is still live; a
// dangling plugin path would break every hook at once. The tree is ~300K, so the copy is cheap
// insurance. It is also what makes the stable path outlive the build that produced it.

/** `~/.ntwine/plugins` — one subdirectory per staged version, siblings of `builds/`. */
export function defaultPluginStageRoot(home = homedir()): string {
  return join(ntwinePaths({ home }).cache, "plugins")
}

/** `~/.ntwine/current` — where the stable, repointable links live. */
export function defaultStablePluginRoot(home = homedir()): string {
  return join(ntwinePaths({ home }).cache, "current")
}

export type SymlinkOutcome = "created" | "repointed" | "unchanged"

// A JUNCTION on Windows: a directory symlink there needs Developer Mode or an elevated process, and a
// junction needs neither. Every target this module links to is an absolute directory, which is all a
// junction can hold.
const LINK_TYPE = process.platform === "win32" ? "junction" : undefined

// Remove a link that may or may not be there — unlinkSync, for the reason ensureSymlink gives, with a
// missing path as the one error that is not one.
function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error
  }
}

/**
 * Point `link` at `target`, idempotently.
 *
 * Four cases, each handled explicitly — the shape is lifted from t3code's `CodexHomeLayout.ensureSymlink`,
 * which solved exactly this problem for its shadow home:
 *   • nothing there            → create
 *   • a real file or directory → THROW. Silently deleting a directory someone else put here is not a
 *                                recovery, it is data loss; a stable path colliding with real content
 *                                is a bug that must surface.
 *   • a symlink pointing elsewhere → swap in a new one (the repoint case — the whole point)
 *   • already correct          → no-op
 *
 * The existing target is resolved RELATIVE TO THE LINK'S OWN DIRECTORY before comparing, so a relative
 * symlink is not mistaken for a stale one and repointed on every call.
 */
export function ensureSymlink(link: string, target: string): SymlinkOutcome {
  mkdirSync(dirname(link), { recursive: true })
  let existing: ReturnType<typeof lstatSync> | undefined
  try {
    existing = lstatSync(link)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error
  }
  if (!existing) {
    symlinkSync(target, link, LINK_TYPE)
    return "created"
  }
  if (!existing.isSymbolicLink()) {
    throw new Error(`refusing to replace ${link}: it exists and is not a symlink`)
  }
  const current = readlinkSync(link)
  if (resolve(isAbsolute(current) ? current : resolve(dirname(link), current)) === resolve(target)) return "unchanged"
  // REPLACED BY RENAME, never by remove-then-create: live workers run a hook through this path on
  // every tool call, and a link that is absent for even a moment fails whichever hook lands in that
  // moment — which Claude reads as "no objection", so a refusal hook silently allows. `rename` swaps
  // one link for the other in a single step. Windows cannot rename over a directory junction, so
  // there the old link has to go first and the window is real; it is the narrowest one available.
  //
  // Every link removal here is unlinkSync, never rmSync: unlink removes the LINK on every Node. rmSync
  // looks through it on Node 23.0–24.13.0 and 25.0–25.3.x (its C++ port checked the path with
  // std::filesystem::status(), which follows symlinks; nodejs/node#61040 fixed it in 24.13.1 and
  // 25.4.0; 22.x was never affected) — a link to a directory throws ERR_FS_EISDIR, and a DANGLING link
  // (its build pruned) is reported missing, swallowed by `force`, and left in place, so the
  // symlinkSync after it fails EEXIST. Measured on this machine 2026-10-02: v25.2.1 throws,
  // v20.20.0 / v22.18.0 / v24.14.1 remove the link.
  const pending = `${link}.pending-${process.pid}`
  unlinkIfPresent(pending)
  symlinkSync(target, pending, LINK_TYPE)
  try {
    renameSync(pending, link)
  } catch {
    unlinkSync(link)
    renameSync(pending, link)
  }
  return "repointed"
}

/**
 * Stage `source` as the plugin for `version` and publish it at the stable path.
 *
 * Returns the STABLE path — the one every worker should be launched against. Staging is skipped when
 * that version's directory already exists, so this is cheap to call on every boot; it is the symlink
 * that carries the change, and repointing it is what a live worker's next reload will observe.
 *
 * `version` is the identity of the plugin content, not merely a release number: dev passes the build
 * digest, production the package version. Anything that changes the plugin must change this, or a
 * worker will reload and see the same bytes.
 */
export function stageStablePluginDir(opts: {
  source: string
  version: string
  name?: string
  stageRoot?: string
  stableRoot?: string
  home?: string
}): { stablePath: string; stagedPath: string; outcome: SymlinkOutcome } {
  const name = opts.name ?? "cc-worker"
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(opts.version)) {
    throw new Error(`unsafe plugin version identity: ${opts.version}`)
  }
  const home = opts.home ?? homedir()
  const stageRoot = opts.stageRoot ?? defaultPluginStageRoot(home)
  const stableRoot = opts.stableRoot ?? defaultStablePluginRoot(home)
  const stagedPath = join(stageRoot, opts.version, name)

  let staged = false
  try {
    lstatSync(stagedPath)
    staged = true
  } catch {
    // Not staged yet.
  }
  if (!staged) {
    // Stage through a temp sibling and rename, so a worker can never observe a HALF-COPIED plugin —
    // a hooks.json present before the script it names would fail every hook until the copy finished.
    const pending = join(stageRoot, `.${opts.version}.pending-${process.pid}`)
    rmSync(pending, { recursive: true, force: true })
    mkdirSync(pending, { recursive: true })
    try {
      cpSync(opts.source, join(pending, name), { recursive: true, dereference: true })
      mkdirSync(join(stageRoot, opts.version), { recursive: true })
      // RENAME, not a second copy: rename is atomic within a filesystem, so the version directory
      // either does not exist or holds the complete plugin. A copy here would reintroduce exactly the
      // half-staged window this whole dance exists to avoid — hooks.json landing before the script it
      // names, so every hook fails until the copy catches up.
      try {
        renameSync(join(pending, name), stagedPath)
      } catch (error) {
        // Losing a concurrent race is fine — the winner staged identical content under the same
        // content identity. Anything else is a real staging failure and must surface.
        const code = (error as NodeJS.ErrnoException)?.code
        if (code !== "ENOTEMPTY" && code !== "EEXIST") throw error
      }
    } finally {
      rmSync(pending, { recursive: true, force: true })
    }
  }

  const stablePath = join(stableRoot, name)
  const outcome = ensureSymlink(stablePath, realpathSync(stagedPath))
  return { stablePath, stagedPath, outcome }
}

/** Every file under `root`, as sorted `/`-separated relative paths. Follows links, as staging does. */
function pluginFiles(root: string): string[] {
  const files: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const rel = prefix ? `${prefix}/${name}` : name
      if (statSync(join(dir, name)).isDirectory()) walk(join(dir, name), rel)
      else files.push(rel)
    }
  }
  walk(root, "")
  return files
}

/**
 * The identity of a plugin tree's CONTENT — the `version` to stage it under.
 *
 * Content, not a release number, because the rule on `stageStablePluginDir` is absolute: anything that
 * changes the plugin must change the identity. A package version satisfies it for a published release
 * and fails it for a promoted artifact rebuilt from an edited checkout under the same `plugin.json`
 * version; a digest satisfies it for both, with nothing to remember. Hashing the whole tree is ~400K
 * and happens once per server process.
 */
export function pluginContentDigest(dir: string): string {
  const hash = createHash("sha256")
  for (const rel of pluginFiles(dir)) hash.update(rel).update("\0").update(readFileSync(join(dir, rel))).update("\0")
  return hash.digest("hex").slice(0, 16)
}

/**
 * What a RUNNING worker compares to learn that its plugin moved, cheaply enough to ask at every turn
 * boundary: where the path leads now, and the size and mtime of every file there.
 *
 * Both halves are needed, because a worker is launched against one of two kinds of path. The stable
 * link changes by being REPOINTED at another immutable staged copy, which only the resolved location
 * shows. A source checkout's `cc-worker/` never moves and is edited in place, which only the stats
 * show. Undefined when the tree cannot be read right now — never a reason to reload.
 */
export function pluginFingerprint(dir: string): string | undefined {
  try {
    const root = realpathSync(dir)
    const hash = createHash("sha1").update(root)
    for (const rel of pluginFiles(root)) {
      const stat = statSync(join(root, rel))
      hash.update(`\0${rel}\0${stat.size}\0${stat.mtimeMs}`)
    }
    return hash.digest("hex")
  } catch {
    return undefined
  }
}
