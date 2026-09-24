import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { slugify } from "@frizz/shared"
import { frizzPaths } from "./frizz-paths.ts"
import { existingProjectId } from "./project-root.ts"

// THE MACHINE'S LIST OF PROJECTS.
//
// One Frizz per machine needs something no per-project server ever did: a list of every project, to
// draw a grid of them and to route `/<slug>` at one of them. That list did not exist — the mapping
// only ever ran repo → id, with no reverse index, and 38 of this machine's 46 state directories have
// no on-disk record of which repo they belong to at all.
//
// THIS FILE IS AN INDEX, NOT IDENTITY. The id lives in the project, at `.frizz/.id` (project-root.ts),
// and that stays the source of truth. Everything here is derived from it and rebuildable by opening a
// project again — which is what makes a machine-level file acceptable at all after the deliberate
// choice to keep identity local. Delete registry.json and you lose card ordering and URL slugs, not
// a single thread.
//
// Keying on the id rather than the path is what makes a project SURVIVE BEING MOVED: `~/.frizz/
// projects/<id>/` already holds every thread, log and attachment, so a path-keyed registry would have
// to re-key all of that on a `mv` or keep a path → id map anyway. The id is already the spine.
//
// It also buys back the duplicate-checkout self-heal that went out with `identity.json`: an id found
// at a path the registry does not know, while the path it DOES know still exists, means someone
// `cp -R`'d a project. Copying is the one case the id-in-the-tree design cannot distinguish on its
// own, and the registry sees it for free.

export interface RegistryEntry {
  /** The project id — the same UUID in that project's `.frizz/.id`. */
  id: string
  /** Canonical root, as resolved when it was last opened. */
  path: string
  /** URL alias: `/<slug>`. Derived once at registration and never re-derived — see §1 of the plan. */
  slug: string
  /** Operator's display override, if they renamed it. */
  name?: string
  lastOpenedAt: string
  /** Hidden from the project list without forgetting it — throwaway repos should not be permanent fixtures. */
  archived?: boolean
  /**
   * Absolute path to this project's icon — inside the project when detected, inside its state dir
   * when the operator uploaded one. Cached here so drawing a rail of forty squares is one file read;
   * `resolveProjectIcon` owns filling it in.
   */
  icon?: string
  /** `custom` is an operator's choice and is never overwritten by a scan. */
  iconSource?: "custom" | "detected"
  /** When the scan last ran. Its absence — not a missing `icon` — is what asks for another one. */
  iconScannedAt?: string
  /**
   * Which VERSION of the scanner produced that answer.
   *
   * A cached "this project has no icon" is only as good as the scan that concluded it, and improving
   * the scanner is precisely when every one of those answers becomes suspect. Without this, widening
   * the search (2026-08-06: `site/public` was never looked in, so nub's complete icon set was
   * invisible) would have left every affected project showing a monogram until the 12-hour retry
   * happened to come round. Bumping ICON_SCAN_VERSION re-asks every project at once.
   */
  iconScanVersion?: number
  /**
   * The operator's own position for this project in the rail, ascending.
   *
   * Absent until somebody drags something, and then written for EVERY project at once (see
   * `reorderProjects`) so the list is never half-ordered. Its absence is what keeps recency as the
   * default: a machine nobody has arranged still opens with what it was last working on at the top.
   */
  order?: number
}

export interface Registry {
  version: 1
  projects: RegistryEntry[]
}

export type RegisterAction = "created" | "reopened" | "moved" | "rekeyed" | "duplicate"

const EMPTY: Registry = { version: 1, projects: [] }

/**
 * Basenames too generic to be a useful URL on their own — `~/x/app` and `~/y/app` are both `app`.
 * Qualified with the parent directory at registration (`pullfrog/app` → `pullfrog-app`).
 */
const GENERIC = new Set([
  "app", "src", "web", "www", "main", "repo", "code", "server", "client",
  "packages", "site", "scratch", "tmp", "test",
])

/**
 * Segments a project may never take, because Frizz itself answers on them. `_frizz` is the formal
 * namespace; the rest are today's hardcoded routes and static assets, kept until they move under it.
 */
const RESERVED = new Set([
  "_frizz", "rpc", "events", "ws", "term", "attach", "local-image", "local-visualization",
  // `control` answers `/control/stop` and `/control/status` — the supervisor channel the board polls
  // every few seconds. It was missing from this list, so a directory called `control` could have taken
  // the segment and routed the whole machine's supervisor polling into one project's app, which has no
  // such route. Only newly minted slugs consult this, so adding it strands nothing already registered.
  "control",
  "project-icon", "assets", "favicon", "manifest", "index", "api", "health",
])

export function registryPath(home = homedir()): string {
  return join(frizzPaths({ home }).data, "registry.json")
}

export function readRegistry(home = homedir()): Registry {
  let raw: string
  try {
    raw = readFileSync(registryPath(home), "utf8")
  } catch {
    return { ...EMPTY, projects: [] }
  }
  try {
    const parsed = JSON.parse(raw) as Registry
    if (parsed?.version !== 1 || !Array.isArray(parsed.projects)) return { ...EMPTY, projects: [] }
    // A malformed entry is dropped rather than poisoning the whole list — this is an index, and the
    // cost of forgetting one card is that opening that project re-registers it.
    return {
      version: 1,
      projects: parsed.projects.filter(
        (p) => p && typeof p.id === "string" && typeof p.path === "string" && typeof p.slug === "string",
      ),
    }
  } catch {
    return { ...EMPTY, projects: [] }
  }
}

/** open(wx) → fsync → rename, the same shape project-launch.ts uses: a reader never sees a half file. */
export function writeRegistry(registry: Registry, home = homedir()): void {
  const path = registryPath(home)
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temp, "w", 0o600)
    writeFileSync(fd, `${JSON.stringify(registry, null, 2)}\n`, "utf8")
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, path)
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd) } catch {} }
    try { rmSync(temp, { force: true }) } catch {}
    throw error
  }
}

function slugifyProject(value: string): string {
  const s = slugify(value)
  return s === "thread" ? "project" : s // slugify's own fallback is thread-shaped
}

/**
 * The URL alias, derived ONCE at registration.
 *
 * Never re-derived on boot: renaming a directory must not silently change a bookmarked URL. The
 * incumbent always keeps its slug for the same reason — a newcomer is what gets qualified.
 */
export function deriveSlug(
  dir: string,
  taken: ReadonlySet<string>,
  options: { remoteOwner?: string } = {},
): string {
  const base = slugifyProject(basename(dir))
  const parent = slugifyProject(basename(dirname(dir)))
  const qualified = GENERIC.has(base) && parent ? `${parent}-${base}` : base

  const candidates = [
    qualified,
    ...(options.remoteOwner ? [`${slugifyProject(options.remoteOwner)}-${base}`] : []),
    ...(parent && parent !== qualified ? [`${parent}-${base}`] : []),
  ]
  for (const candidate of candidates) {
    if (candidate && !taken.has(candidate) && !RESERVED.has(candidate)) return candidate
  }
  const root = candidates[0] || "project"
  for (let n = 2; ; n++) {
    const candidate = `${root}-${n}`
    if (!taken.has(candidate) && !RESERVED.has(candidate)) return candidate
  }
}

/**
 * Record that `id` lives at `dir`, reconciling whatever the registry believed before.
 *
 * `duplicate` is the one the caller must act on: the id is registered at a DIFFERENT path that still
 * exists, so this directory is a copy of that one rather than the same project moved. Nothing is
 * written in that case — the caller mints a fresh id for the copy and calls again.
 */
/**
 * The canonical form of a project path — resolved through every symlink.
 *
 * ONE place, because the callers disagreed and the disagreement was invisible until a rail rendered
 * the same project twice. On macOS `/var` is a symlink to `/private/var`, so the launcher (which
 * realpaths) and the grid's add path (which did not) registered one directory under two paths, with
 * two ids and two slugs. Normalising at the boundary means no caller can get it wrong, and a path
 * that cannot be resolved — a directory since deleted — is kept verbatim so a stale card still
 * matches the entry it came from.
 */
function canonicalPath(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return dir
  }
}

export function registerProject(
  input: { dir: string; id: string; remoteOwner?: string; now?: () => Date },
  home = homedir(),
): { entry?: RegistryEntry; action: RegisterAction } {
  input = { ...input, dir: canonicalPath(input.dir) }
  const registry = readRegistry(home)
  const at = (input.now ?? (() => new Date()))().toISOString()
  const byId = registry.projects.find((p) => p.id === input.id)

  if (byId) {
    if (byId.path === input.dir) {
      byId.lastOpenedAt = at
      writeRegistry(registry, home)
      return { entry: byId, action: "reopened" }
    }
    // The id is claimed by a path that is still there ⇒ this directory is a COPY of it, not the same
    // project relocated. Refuse rather than stealing the original's threads.
    if (existsSync(join(byId.path, ".frizz", ".id"))) return { action: "duplicate" }
    byId.path = input.dir
    byId.lastOpenedAt = at
    writeRegistry(registry, home)
    return { entry: byId, action: "moved" }
  }

  // A known path whose id changed — the directory was replaced. The file in the tree wins.
  const byPath = registry.projects.find((p) => p.path === input.dir)
  if (byPath) {
    byPath.id = input.id
    byPath.lastOpenedAt = at
    writeRegistry(registry, home)
    return { entry: byPath, action: "rekeyed" }
  }

  const taken = new Set(registry.projects.map((p) => p.slug))
  const entry: RegistryEntry = {
    id: input.id,
    path: input.dir,
    slug: deriveSlug(input.dir, taken, { remoteOwner: input.remoteOwner }),
    lastOpenedAt: at,
  }
  registry.projects.push(entry)
  writeRegistry(registry, home)
  return { entry, action: "created" }
}

/** Most recently opened first — the order a project list wants. `stale` marks a path that is gone. */
/**
 * Seed the registry from state directories that predate it.
 *
 * WHY THIS EXISTS. The registry only learns about a project when something opens it, so a machine
 * that has been running Frizz for months arrives at its first project list with one project — and the operator's
 * only way to fill it is to visit every repository in a terminal, which is precisely the chore one
 * server for the machine was supposed to end. Everything needed is already on disk: each state dir is
 * named for its project id and records the directory it was opened from.
 *
 * CONSERVATIVE ON PURPOSE. A state dir is adopted only when the project STILL CLAIMS THAT ID. It may
 * claim it either way Frizz has ever stored one: `.frizz/.id`, or the older `git config frizz.id`.
 * Checking only the file was a real bug — boron and pullfrog/app both predate the gitless change and
 * had never been reopened since, so they carried a git-config id and no file, and the backfill
 * silently skipped two of the four projects actually in use (2026-08-06). A checkout that has since been re-identified (copied,
 * or re-created after a delete) is skipped rather than guessed at, because the cost of guessing is a
 * card that opens the wrong board. Same for a directory that no longer exists.
 *
 * DUPLICATES ARE REAL. Two ids can name one path — a project deleted and re-opened leaves the old
 * state dir behind, and this machine had two for nub and two for boron. The `.frizz/.id` check
 * settles it: only the id the project currently claims is adopted.
 *
 * Runs once at boot and is idempotent: a path already registered is left exactly as it is, so an
 * operator's rename is never undone.
 */
export function backfillRegistry(
  home = homedir(),
  read: (root: string) => string | undefined = existingProjectId,
): number {
  let dirs: string[]
  try {
    dirs = readdirSync(join(frizzPaths({ home }).data, "projects"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return 0 // no state dirs yet — a genuinely new machine has nothing to recover
  }
  const known = new Set(readRegistry(home).projects.map((p) => p.path))
  let added = 0
  for (const id of dirs) {
    // Canonical BEFORE the known-check: the registry stores canonical paths, so comparing a raw
    // recorded one misses its own entry and re-registers the same project on every single boot.
    const recorded = recordedProjectDir(join(frizzPaths({ home }).data, "projects", id))
    const dir = recorded ? canonicalPath(recorded) : undefined
    if (!dir || known.has(dir)) continue
    if (read(dir) !== id) continue
    try {
      const result = registerProject({ dir, id }, home)
      if (result.entry) {
        known.add(dir)
        added++
      }
    } catch {
      // One unreadable state dir must not stop the rest; this is a convenience, not a source of truth.
    }
  }
  return added
}

/**
 * The directory a state dir was last opened from, per the small JSON files the launcher leaves.
 *
 * `launcher.json` FIRST, and that ordering is the whole point: it is the only one of the three that
 * SURVIVES A CLEAN SHUTDOWN. `server.lock` and `project-launch.owner` are liveness records and are
 * removed when the server stops, so a backfill that consulted only those could recover a project that
 * happened to be running and nothing else — which on this machine meant boron and pullfrog/app, both
 * stopped, stayed invisible even after the identity fix that was supposed to find them (2026-08-06).
 */
function recordedProjectDir(stateDir: string): string | undefined {
  for (const name of ["launcher.json", "server.lock", "project-launch.owner"]) {
    try {
      const value = (JSON.parse(readFileSync(join(stateDir, name), "utf8")) as { projectDir?: unknown }).projectDir
      if (typeof value === "string" && value.length > 0 && existsSync(value)) return value
    } catch {
      // Missing or malformed; try the next one.
    }
  }
  return undefined
}

/**
 * Every project, in the order the rail and the cross-project page's list draw them.
 *
 * The operator's ARRANGEMENT wins where one exists, and recency is the default until it does. Both
 * surfaces read this one function on purpose: they are on screen together at `/`, and a rail the
 * operator has arranged sitting beside a list that has re-sorted itself by recency is two answers to
 * the same question.
 *
 * Recency as the default is not merely a fallback, it is the better cold start — a machine nobody has
 * arranged opens with what it was last working on at the top. But it also means the rail SHUFFLES
 * ITSELF as you work, which is the thing manual order exists to stop, so the first drag pins
 * everything (`reorderProjects` writes an order for every project, not just the moved one).
 *
 * A project registered after an arrangement has no order and sorts to the END, newest first, which is
 * where a new arrival belongs in a list somebody has already arranged.
 */
export function listProjects(home = homedir()): (RegistryEntry & { stale: boolean })[] {
  const byRecency = (a: RegistryEntry, b: RegistryEntry) =>
    a.lastOpenedAt < b.lastOpenedAt ? 1 : a.lastOpenedAt > b.lastOpenedAt ? -1 : 0
  return readRegistry(home)
    .projects.map((p) => ({ ...p, stale: !existsSync(p.path) }))
    .sort((a, b) => {
      if (a.order === undefined && b.order === undefined) return byRecency(a, b)
      if (a.order === undefined) return 1
      if (b.order === undefined) return -1
      return a.order - b.order
    })
}

/**
 * Pin the rail's order to exactly `ids`.
 *
 * Writes an order for EVERY project the registry knows, not only the ones named: a half-ordered list
 * has to fall back to recency for the rest, and then the unordered tail keeps rearranging itself
 * underneath an operator who has just said where they want things. Anything the caller did not name
 * (registered on another tab, mid-drag) keeps its relative position after the named ones rather than
 * being dropped.
 */
export function reorderProjects(ids: readonly string[], home = homedir()): RegistryEntry[] {
  const registry = readRegistry(home)
  const rank = new Map(ids.map((id, index) => [id, index]))
  const known = registry.projects.filter((p) => rank.has(p.id))
  const rest = listProjects(home).filter((p) => !rank.has(p.id))
  known.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
  ;[...known, ...rest].forEach((entry, index) => {
    const target = registry.projects.find((p) => p.id === entry.id)
    if (target) target.order = index
  })
  writeRegistry(registry, home)
  return registry.projects
}

/** The entry for a directory Frizz already knows, if it knows it. */
export function findByPath(path: string, home = homedir()): RegistryEntry | undefined {
  // Canonical on both sides, or a caller passing the symlinked spelling misses its own entry.
  const canonical = canonicalPath(path)
  return readRegistry(home).projects.find((p) => p.path === canonical || p.path === path)
}

export function findBySlug(slug: string, home = homedir()): RegistryEntry | undefined {
  return readRegistry(home).projects.find((p) => p.slug === slug)
}

export function findById(id: string, home = homedir()): RegistryEntry | undefined {
  return readRegistry(home).projects.find((p) => p.id === id)
}

/**
 * The project a `/_frizz/<segment>/…` request names: its slug, or its id.
 *
 * The browser addresses a project by SLUG, because that is what the operator reads in the URL bar. A
 * worker's frizz MCP server addresses it by ID, because it is handed the segment once when it spawns
 * and then holds it for the life of a detached daemon — a rename would silently strand it, and the
 * failure would be an unknown segment falling through to whichever project launched the server.
 *
 * Slug wins a tie. An id is a UUID and the slug rule cannot mint one from a directory basename
 * without someone naming a directory after a UUID, so the two do not realistically collide.
 */
export function findProjectBySegment(segment: string, home = homedir()): RegistryEntry | undefined {
  return findBySlug(segment, home) ?? findById(segment, home)
}

// ── ICONS ───────────────────────────────────────────────────────────────────────────────────────
//
// The rail draws one square per project, and the icon behind each square is DERIVED — a path found by
// scanning the project (project-icon.ts), or one the operator uploaded. Both live here for the same
// reason the rest of this file does: the rail needs forty of them at once, and opening forty projects
// to answer is exactly what lazy activation exists to avoid.
//
// Losing this cache costs one rescan, like losing anything else in the index.

/**
 * Bump whenever the SCAN changes in a way that could find something it previously missed.
 *
 * 2 — `site/public` and its family: hosts (`site`, `web`, `docs`, `frontend`, …) are now crossed with
 *     asset directories instead of hand-listed, so a site in a subdirectory is finally looked in.
 * 3 — a colourless SVG is demoted below any coloured sibling, so a Simple-Icons-style glyph stops
 *     winning and rendering as a solid black tile. A cached PICK is as stale as a cached miss here:
 *     bun had already stored the black one.
 */
export const ICON_SCAN_VERSION = 3

/** Where an uploaded icon lands: the project's own state dir, never inside the repository. */
export function customIconPath(id: string, extension: string, home = homedir()): string {
  return join(frizzPaths({ home }).data, "projects", id, `icon${extension}`)
}

function updateEntry(
  id: string,
  apply: (entry: RegistryEntry) => void,
  home: string,
): RegistryEntry | undefined {
  const registry = readRegistry(home)
  const entry = registry.projects.find((p) => p.id === id)
  if (!entry) return undefined
  apply(entry)
  writeRegistry(registry, home)
  return entry
}

/**
 * Record the operator's own icon for a project. `custom` is a floor, not a preference: no later scan
 * overwrites it, because a person choosing a picture outranks anything a heuristic finds.
 */
export function setProjectIcon(id: string, path: string, home = homedir()): RegistryEntry | undefined {
  return updateEntry(id, (entry) => {
    entry.icon = path
    entry.iconSource = "custom"
    entry.iconScannedAt = new Date().toISOString()
  }, home)
}

/** Forget whatever we hold, so the next resolve scans the project again. */
export function clearProjectIcon(id: string, home = homedir()): RegistryEntry | undefined {
  return updateEntry(id, (entry) => {
    delete entry.icon
    delete entry.iconSource
    delete entry.iconScannedAt
  }, home)
}

/**
 * This project's icon path, scanning for one the first time it is asked and caching what it finds.
 *
 * RESOLVED LAZILY, which is the whole design. Scanning at registration would leave every project
 * registered before this feature shipped without an icon forever, and scanning inside `listProjects`
 * would turn the project list's one file read into forty directory walks. Instead the icon ROUTE calls this,
 * once per project, and the answer is cached from then on.
 *
 * A remembered path that has since been deleted — someone reorganised `public/` — triggers a rescan
 * rather than a broken image. So does a project with no icon at all, but only after `rescanAfterMs`,
 * so forty icon-less projects do not re-walk their trees on every page load.
 */
export function resolveProjectIcon(
  id: string,
  detect: (root: string) => string | undefined,
  options: { home?: string; rescanAfterMs?: number; now?: () => number; version?: number } = {},
): string | undefined {
  const home = options.home ?? homedir()
  const rescanAfterMs = options.rescanAfterMs ?? 12 * 60 * 60 * 1000
  const version = options.version ?? ICON_SCAN_VERSION
  const now = options.now ?? Date.now
  const entry = readRegistry(home).projects.find((p) => p.id === id)
  if (!entry) return undefined

  const staleScan = (entry.iconScanVersion ?? 0) !== (options.version ?? ICON_SCAN_VERSION)

  // THE OPERATOR'S OWN CHOICE IS NOT A SCAN RESULT, so no scanner version can overrule it. This is
  // checked FIRST and on its own for that reason: folding it in below let a version bump discard
  // every uploaded icon on the machine at once — every entry written before versioning existed has
  // no `iconScanVersion`, so all of them read as stale, and a project whose icon the operator had
  // deliberately chosen fell back to its monogram. Measured on a real registry (2026-08-08).
  //
  // A chosen file that has gone MISSING is a broken square, not an invitation to pick a different
  // picture for them — leave the choice recorded and let them fix it.
  if (entry.iconSource === "custom") {
    return entry.icon && existsSync(entry.icon) ? entry.icon : undefined
  }

  // A stored DETECTED pick goes stale exactly as a stored miss does: improving the RANKING (not just
  // the search) means the file we settled on may no longer be the one this project should wear. bun
  // had already cached a black glyph, so re-asking only the misses would have left it black.
  if (entry.icon && existsSync(entry.icon) && !staleScan) return entry.icon
  // A remembered "nothing here" is only trusted while it came from the CURRENT scanner and is recent.
  // The version check is what makes improving the scan take effect immediately rather than whenever
  // each project's 12 hours happen to elapse.
  if (!entry.icon && !staleScan && entry.iconScannedAt && now() - Date.parse(entry.iconScannedAt) < rescanAfterMs) {
    return undefined
  }
  if (!existsSync(entry.path)) return undefined

  const found = detect(entry.path)
  updateEntry(id, (target) => {
    if (found) {
      target.icon = found
      target.iconSource = "detected"
    } else {
      delete target.icon
      delete target.iconSource
    }
    target.iconScannedAt = new Date(now()).toISOString()
    target.iconScanVersion = version
  }, home)
  return found
}

/** Rename is the escape hatch for every derivation rule above, so it exists from day one. */
export function renameProject(
  id: string,
  /** `name: null` clears the display override, so the card follows the directory's basename again. */
  update: { slug?: string; name?: string | null; archived?: boolean },
  home = homedir(),
): RegistryEntry | undefined {
  const registry = readRegistry(home)
  const entry = registry.projects.find((p) => p.id === id)
  if (!entry) return undefined
  if (update.slug !== undefined) {
    const slug = slugifyProject(update.slug)
    if (RESERVED.has(slug)) throw new Error(`"${slug}" is reserved by Frizz itself`)
    if (registry.projects.some((p) => p.id !== id && p.slug === slug)) {
      throw new Error(`another project already uses "${slug}"`)
    }
    entry.slug = slug
  }
  if (update.name === null) delete entry.name
  else if (update.name !== undefined) entry.name = update.name
  if (update.archived !== undefined) entry.archived = update.archived
  writeRegistry(registry, home)
  return entry
}

/**
 * Rename a project's DIRECTORY to a sibling basename, and re-register it there.
 *
 * The one first-party way to change the folder itself. The id travels with the tree, so this is the
 * "moved" case `registerProject` already reconciles — the difference is that Frizz did the move and
 * knows about it at once, rather than learning at the next `frizz` run. Off by default in the rename
 * dialog: a folder is the operator's, and renaming Frizz's card must never rename it uninvited.
 *
 * A basename only — no separators, no `.`/`..` — so this can rename a folder and cannot move one
 * somewhere else. The target must not exist: `rename(2)` onto a directory either fails or, on some
 * platforms, replaces an empty one, and neither is what "rename" means here.
 */
export function moveProjectDirectory(id: string, newBasename: string, home = homedir()): RegistryEntry {
  const entry = findById(id, home)
  if (!entry) throw new Error("No such project.")
  const name = newBasename.trim()
  if (!name || name === "." || name === ".." || /[\\/\0]/u.test(name)) {
    throw new Error("A folder name cannot contain a slash.")
  }
  if (!existsSync(entry.path)) throw new Error(`The folder is missing: ${entry.path}`)
  const target = join(dirname(entry.path), name)
  if (target === entry.path) return entry
  if (existsSync(target)) throw new Error(`Something already exists at ${target}`)
  renameSync(entry.path, target)
  const moved = registerProject({ dir: target, id }, home)
  // The old path is gone, so this can only be "moved"; anything else means the registry changed under
  // us between the read above and the rename, and the folder is already where the operator asked.
  return moved.entry ?? entry
}

export function forgetProject(id: string, home = homedir()): boolean {
  const registry = readRegistry(home)
  const before = registry.projects.length
  registry.projects = registry.projects.filter((p) => p.id !== id)
  if (registry.projects.length === before) return false
  writeRegistry(registry, home)
  return true
}
