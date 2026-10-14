// WHICH BUILD THIS IS — the identity scripts/build.ts stamps into the bundle and beside it.
//
// Every build said `0.1.0`, and the server dropped the hello's version on the floor, so when the
// maintainer asked "is this window running the fix?" nobody could say: not the output channel, not the
// status bar, not ntwine (review-final.md item 7). Now each build carries its version, the commit it was
// built from (and whether the tree had uncommitted changes in what the bundle is made of), when it was
// built, and a random id. The label — `0.1.0+1a2b3c4d`, `0.1.0+1a2b3c4d-dirty` — is what the hello, the
// log and the status bar's tooltip say; the id is what tells two builds apart, since two builds of one
// dirty tree share a label.
//
// The same record is written to `dist/build.json`, which ships in the .vsix. A window keeps running the
// code it loaded, so when `nub run vscode:install` puts a new build on disk the window offers to reload
// (`installedBuild`): it compares the id on disk with its own.
//
// Pure node, no `vscode`: build-info.test.ts runs it over folders laid out the way VS Code lays out an
// extensions directory.

import { readdirSync, readFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"

export interface BuildInfo {
  /** package.json's version. */
  version: string
  /** The short commit the bundle was built from; absent outside a git checkout. */
  commit?: string
  /** The bundle's sources (packages/vscode, packages/shared) had uncommitted changes. */
  dirty?: boolean
  /** ISO time of the build. */
  builtAt?: string
  /** Random per build: what says two builds differ when their labels do not. */
  id: string
}

/** Where scripts/build.ts writes the record, relative to the extension's folder. */
export const BUILD_FILE = join("dist", "build.json")

// esbuild's `define` replaces this identifier with the build's record. Run from source (the unit tests,
// `nub` on a module) it is not defined, and the build reads as the source tree's.
declare const __NTWINE_BUILD__: BuildInfo | undefined

/** This bundle's build, or — run from source, never built — a stand-in that names no commit. */
export const BUILD: BuildInfo = typeof __NTWINE_BUILD__ === "undefined" ? { version: "0.0.0", id: "source" } : __NTWINE_BUILD__

/** `0.1.0+1a2b3c4d`, `0.1.0+1a2b3c4d-dirty`, or the bare version when no commit is known (semver build metadata). */
export function buildLabel(build: Pick<BuildInfo, "version" | "commit" | "dirty">): string {
  if (!build.commit) return build.version
  return `${build.version}+${build.commit}${build.dirty ? "-dirty" : ""}`
}

/** `2026-10-02 14:03`, from the build's ISO time, in the reader's local clock; "" when unknown. */
export function builtAtLabel(build: Pick<BuildInfo, "builtAt">, timeZone?: string): string {
  if (!build.builtAt) return ""
  const at = new Date(build.builtAt)
  if (Number.isNaN(at.getTime())) return ""
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at)
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? ""
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`
}

/** A build record from a file, or undefined when it is missing or not one. */
export function readBuildFile(path: string): BuildInfo | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BuildInfo>
    if (typeof parsed.version !== "string" || typeof parsed.id !== "string") return undefined
    return {
      version: parsed.version,
      id: parsed.id,
      ...(typeof parsed.commit === "string" ? { commit: parsed.commit } : {}),
      ...(parsed.dirty === true ? { dirty: true } : {}),
      ...(typeof parsed.builtAt === "string" ? { builtAt: parsed.builtAt } : {}),
    }
  } catch {
    return undefined
  }
}

/**
 * VS Code's record of the folders it is about to delete (`<extensions dir>/.obsolete`, a JSON object
 * keyed by folder name): an older version a newer install replaced, which stays on disk until every
 * window that loaded it is gone.
 */
function obsoleteFolders(extensionsDir: string): Set<string> {
  try {
    return new Set(Object.keys(JSON.parse(readFileSync(join(extensionsDir, ".obsolete"), "utf8")) as Record<string, unknown>))
  } catch {
    return new Set()
  }
}

/**
 * A different build of this extension on disk than the one running, or undefined. Two ways a new build
 * lands, and both are looked for:
 *
 *  - The SAME version reinstalled (`--install-extension --force`, every local build until the version
 *    moves): VS Code replaces the folder this window loaded from, so its `dist/build.json` carries
 *    another id. Any other id there counts, newer or not — it is what a reload would load.
 *  - A NEW version: it goes into a folder of its own beside this one (`<publisher>.<name>-<version>`),
 *    and this window's folder is marked obsolete. The newest build among the siblings not marked so
 *    counts when it was built after this one.
 *
 * Run from source (`--extensionDevelopmentPath`) the folder has no siblings of that name, and only the
 * first rule applies — a rebuild of `dist/` is a new build too.
 */
export function installedBuild(extensionPath: string, extensionId: string, running: BuildInfo = BUILD): BuildInfo | undefined {
  const here = readBuildFile(join(extensionPath, BUILD_FILE))
  if (here && here.id !== running.id) return here
  const parent = dirname(extensionPath)
  const prefix = `${extensionId.toLowerCase()}-`
  const obsolete = obsoleteFolders(parent)
  let newest: BuildInfo | undefined
  let entries: string[]
  try {
    entries = readdirSync(parent)
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (!entry.toLowerCase().startsWith(prefix) || entry === basename(extensionPath) || obsolete.has(entry)) continue
    const build = readBuildFile(join(parent, entry, BUILD_FILE))
    if (!build || build.id === running.id || !build.builtAt) continue
    if (!newest || build.builtAt > (newest.builtAt ?? "")) newest = build
  }
  if (!newest) return undefined
  // Only a newer one: an older version left behind, not yet removed, is not what a reload would load.
  return running.builtAt && newest.builtAt! <= running.builtAt ? undefined : newest
}
