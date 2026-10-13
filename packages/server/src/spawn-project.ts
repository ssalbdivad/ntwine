// WHICH PROJECT A SPAWNED THREAD STARTS IN (2026-10-06).
//
// `spawn_thread` used to start the new thread in the CALLER's project, always, and the shim had no way to
// say otherwise. That is right for most spawns and wrong in exactly the case that matters: a standup
// digest running in Home spawned a fix for ArkType's docs, its prompt said "Repo: `~/arktype`", and the
// thread landed on Home's board — working in ArkType's checkout from a project that is not ArkType, out of
// sight of anyone looking at ArkType's queue (maintainer: "should have opened @star-fallback in arktype,
// not home").
//
// So the caller may NAME the project (`project`, matched here), and a spawn that names none is checked
// against its own prompt: a path inside ANOTHER open project's checkout is refused with the list of
// projects, so the worker has to choose rather than default. Passing `project` — even this project's own
// name — is the override, which keeps a prompt that merely mentions another repo dispatchable.
//
// Only paths count, never bare words: "arktype" in prose is a topic as often as a place, while
// `~/arktype/ark/docs` names where the work happens. And a path inside a project that CONTAINS the
// caller's (Home, for every repo under the home folder) is not evidence either — `~/.ntwine/scratch` in a
// Ntwine thread's brief is Home's folder, but the work is still Ntwine's.

import { homedir } from "node:os"

export interface SpawnProject {
  id: string
  /** The URL segment the board shows the project under (`/project/<slug>`) — what a worker types. */
  slug: string
  /** Display name. */
  name: string
  /** Where its agents run (project.ts workDirOf): the checkout, or Home's folder. */
  dir: string
}

const trimSlash = (path: string) => (path.length > 1 ? path.replace(/\/+$/u, "") : path)

function expand(path: string, home: string): string {
  if (path === "~") return home
  if (path.startsWith("~/")) return home + path.slice(1)
  return path
}

const contains = (dir: string, path: string) => path === dir || path.startsWith(`${dir}/`)

/** The project a `project` argument names: its slug, display name, id, or checkout path (`~` expands). */
export function resolveSpawnProject<P extends SpawnProject>(want: string, open: readonly P[], home = homedir()): P | undefined {
  const needle = want.trim().replace(/^@/u, "")
  if (!needle) return undefined
  const lower = needle.toLowerCase()
  const byName = open.find((p) => p.slug.toLowerCase() === lower || p.id === needle) ?? open.find((p) => p.name.toLowerCase() === lower)
  if (byName) return byName
  if (!needle.startsWith("/") && !needle.startsWith("~")) return undefined
  const path = trimSlash(expand(needle, home))
  return open.find((p) => trimSlash(p.dir) === path)
}

// A path as a brief writes one: `~/…` or an absolute `/…`, starting a word, a backtick span or a bracket,
// running to the next space or quote. A URL's path (`https://github.com/…`) starts mid-token after `:/`,
// so it never matches.
const PATH_RE = /(?<=^|[\s`'"(<[])(~(?=\/|[\s`'")>\]]|$)|\/(?=[A-Za-z0-9._~-]))[^\s`'"()<>[\]]*/gu

/**
 * The OTHER projects whose checkouts `prompt` names by path, each with the first mention that placed it.
 * A path belongs to the most specific open project containing it; a path in `here`, or in a project that
 * contains `here`, is not counted (see the header).
 */
export function projectsNamedIn<P extends SpawnProject>(
  prompt: string,
  here: SpawnProject,
  open: readonly P[],
  home = homedir(),
): { project: P; mention: string }[] {
  const hereDir = trimSlash(here.dir)
  const found = new Map<string, { project: P; mention: string }>()
  for (const match of prompt.matchAll(PATH_RE)) {
    const mention = match[0].replace(/[.,:;!?]+$/u, "")
    const path = trimSlash(expand(mention, home))
    let owner: P | undefined
    for (const candidate of open) {
      const dir = trimSlash(candidate.dir)
      if (contains(dir, path) && (!owner || dir.length > trimSlash(owner.dir).length)) owner = candidate
    }
    if (!owner || owner.id === here.id || contains(trimSlash(owner.dir), hereDir)) continue
    if (!found.has(owner.id)) found.set(owner.id, { project: owner, mention })
  }
  return [...found.values()]
}

/** The open projects as a worker should read them, one per line, the caller's marked. */
export function spawnProjectList(open: readonly SpawnProject[], here: SpawnProject, home = homedir()): string {
  const tilde = (dir: string) => (contains(home, dir) ? `~${dir.slice(home.length)}` : dir)
  return open
    .map((p) => `- \`${p.slug}\` — ${p.name}, \`${tilde(p.dir) || "~"}\`${p.id === here.id ? " (this thread's project)" : ""}`)
    .join("\n")
}
