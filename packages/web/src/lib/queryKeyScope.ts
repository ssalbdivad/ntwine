import { hashKey } from "@tanstack/react-query"
import { projectSlug } from "./base-path.ts"

// THE CACHE IS PER PROJECT, AND NOBODY HAS TO REMEMBER THAT.
//
// One ntwine serves every project on the machine from one origin, so `["transcript", "fix-auth"]` names
// a different thread depending on which project asked — thread slugs are unique only WITHIN a project
// (see `rebindProject` in api/socket.ts). `["settingsGet"]` is worse: the server reads a per-project
// blob (`getSettings` in packages/server/src/settings.ts), so the same key genuinely holds different
// data per project. Every key in this app was project-blind, and what stood between that and a visible
// bug was a `removeQueries` sweep on every switch — a rule, enforced in one place, that a late response
// or a new call site could walk around.
//
// react-query identifies a cache entry by its HASH, not by the key array, and the hash function is a
// client-level default. So the project can be folded in ONCE, here, and every query — including every
// one written after this — is scoped without its author doing anything. That is the difference between
// a convention and a property: prefixing 19 key shapes by hand would have worked exactly until the
// twentieth.
//
// WHAT THIS BUYS, concretely: a response for project A that resolves after the operator has switched
// lands under A's hash, where nothing on B's page is looking. B cannot read it, and B's own observers
// build their own entries. Returning to A finds A's cache still warm instead of a wiped one.

/**
 * Keys that name the MACHINE rather than one project, and must stay shared.
 *
 * `projectsList` is every project on the machine — scoping it would refetch the whole list on every
 * switch and blank the project list and dock mid-navigation, which is the flicker the client-side router exists to remove.
 * `threadLocate` deliberately searches every registered project server-side, so a per-project copy
 * would be several caches of one answer. `projectsRailCounts` is the rail's badges — one answer for
 * every project, read by a rail that outlives every switch. `dispatchPreferencesGet` is the prompt
 * box's model + effort profile, which the server keeps in one machine-level file
 * (server/dispatch-preferences.ts): scoping it would let a switch briefly paint the profile this
 * project last saw instead of the one just chosen in another.
 * `codexModels` is read from the machine's one `~/.codex` model cache; scoped, every project switch left
 * the prompt box's profile unresolved (and Enter silently ignored) until the same list came back again.
 * `supervisorStatus` is the LAUNCHER's own state — one supervisor per machine, sitting above every
 * project it serves (api/supervisorStatus.ts) — so scoping it would mint a second poll of one answer on
 * every project switch.
 * `projectsQueues` is the All queues page's read — every open project at once, on a page that names none.
 * `ofProject` is the head of a key that CARRIES its project — `["ofProject", projectId, …]` — for data the
 * All queues page reads about one project from a page that names none. Folding the page's scope in on top
 * would be wrong twice over: that page's scope is `project:`, the very scope the unprefixed LAUNCHING
 * project's own entries live in, and the key already says whose it is.
 * `quota` and `authStatus` are the provider ACCOUNT's — the server reads both through its one Claude
 * binary and the machine's credentials, whichever project asks. Scoped, the status row's quota chips
 * started empty every time the cross-project page's focus moved to a project not yet asked.
 */
const MACHINE_WIDE = new Set(["projectsList", "projectsRailCounts", "projectsQueues", "ofProject", "threadLocate", "dispatchPreferencesGet", "codexModels", "supervisorStatus", "quota", "authStatus"])

/** The `queryKeyHashFn` for this app's QueryClient. Nothing else should need to call it. */
export function projectScopedQueryKeyHash(key: readonly unknown[]): string {
  // The page's own project, or "" for the unprefixed launching project — which is a REAL project and
  // must therefore be a stable scope of its own, not an absence of one.
  return projectQueryKeyHash(projectSlug() ?? "", key)
}

/** The hash `key` takes on a page bound to project `slug` — for an entry written BEFORE the page moves
 *  there (hooks.ts prefetchProjectTranscript). */
export function projectQueryKeyHash(slug: string, key: readonly unknown[]): string {
  const head = key[0]
  if (typeof head === "string" && MACHINE_WIDE.has(head)) return hashKey(key)
  return hashKey([`project:${slug}`, ...key])
}
