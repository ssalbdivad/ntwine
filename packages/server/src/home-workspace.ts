import { mkdirSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { projectStateDir } from "./ntwine-paths.ts"
import { isDirectory } from "./path-probe.ts"
import { cwdSlug, projectFromRegistryEntry, type Project } from "./project.ts"
import { findById, findProjectBySegment, listProjects, readRegistry, reorderProjects, writeRegistry, type RegistryEntry } from "./project-registry.ts"

// THE HOME WORKSPACE — where a prompt that belongs to no project runs.
//
// Some work has no project yet: cloning a repository, a question about the machine, a scratch script.
// Every thread needs a board to live on, and until this existed the only boards were registered project
// folders, so that work was filed under whichever project happened to be open. Home is the prompt box's
// other target: agents run in the operator's home folder, and its threads get a board of their own
// that behaves like any project's — its entry in Everything's project list, its lane in the queue, its
// square in the switcher.
//
// IT IS NOT A REGISTERED PROJECT, and cannot be one. A project's board is `<folder>/.ntwine/`, and
// `~/.ntwine` is not a free name: it is Ntwine's own data root on every install that predates the XDG
// layout, and on every other install the mere EXISTENCE of that directory switches Ntwine back to it on
// the next boot (ntwine-paths.ts), taking every project's threads with it. The home folder is also the
// one directory project-root.ts refuses to adopt, for the same reason. So Home is synthesized here
// rather than written into registry.json, and its Project splits the two directories every registered
// project keeps as one:
//
//   · `workDir` — the home folder, where agents are spawned and resumed, where their transcripts are
//     sharded, and what their relative paths resolve against (project.ts workDirOf);
//   · `dir`     — its STATE DIRECTORY, which holds the board: `<state>/.ntwine/threads/<session>/` is
//     where a Home thread's scratch directory lives, and a worker is handed that path absolute.
//
// Everything that reads `dir` meaning "the board" works unchanged, and a site that should have read
// workDirOf but did not puts an agent in Ntwine's state directory — visibly wrong, never `~/.ntwine`.
//
// It stays out of the registry's own lookups on purpose. The launcher reads listProjects to pick a
// project to host the server from (src/launcher.ts mostRecentProject), and hosting from Home would
// resolve its folder as a workspace — minting `.ntwine/.id` in it. Only the SERVER's surfaces — the
// project list, routing, tenant priming — ask for workspaces.

/** Fixed, so every row, state directory and remembered pick survives a restart. "home" in hex. */
export const HOME_WORKSPACE_ID = "686f6d65-0000-4000-8000-000000000000"
/** Reserved in project-registry.ts, so no project registered from now on can take it. */
export const HOME_WORKSPACE_SLUG = "home"
export const HOME_WORKSPACE_NAME = "Home"
/**
 * Home is never "the project opened most recently". That reading picks where a fresh page lands, which
 * is where the operator was last working in a terminal — a project, never this.
 */
const NEVER_OPENED = new Date(0).toISOString()

export function isHomeWorkspace(id: string | undefined): boolean {
  return id === HOME_WORKSPACE_ID
}

/**
 * The folder Home's agents run in: the operator's home folder, resolved through every symlink when it
 * exists so it compares equal to the registry's paths.
 */
export function homeWorkspaceFolder(home = homedir()): string {
  try {
    return realpathSync(home)
  } catch {
    return home
  }
}

/**
 * Home's address. `taken` is the registry's slugs: a project registered as `home` before the name was
 * reserved keeps its address, and Home then answers on its id, a valid segment everywhere a slug is.
 */
export function homeWorkspaceSlug(
  home = homedir(),
  taken: ReadonlySet<string> = new Set(readRegistry(home).projects.map((project) => project.slug)),
): string {
  return taken.has(HOME_WORKSPACE_SLUG) ? HOME_WORKSPACE_ID : HOME_WORKSPACE_SLUG
}

/** Home as a registry entry — the shape every list, route and card is already built from. */
export function homeWorkspaceEntry(home = homedir(), taken?: ReadonlySet<string>): RegistryEntry {
  return {
    id: HOME_WORKSPACE_ID,
    path: homeWorkspaceFolder(home),
    slug: homeWorkspaceSlug(home, taken),
    name: HOME_WORKSPACE_NAME,
    lastOpenedAt: NEVER_OPENED,
  }
}

/**
 * Every registered project and Home, in the order the project list draws them. Home is LAST until the
 * operator drags it somewhere: it is always there, so by default it is furniture rather than news. Once
 * placed, it sits above the first project whose `order` is at or past the registry's `homeOrder` — so a
 * project registered afterwards, which has no order, still arrives at the end, below Home.
 */
export function listWorkspaces(home = homedir()): (RegistryEntry & { stale: boolean })[] {
  const projects = listProjects(home)
  const entry = homeWorkspaceEntry(home, new Set(projects.map((project) => project.slug)))
  const homeOrder = readRegistry(home).homeOrder
  const at =
    homeOrder === undefined ? -1 : projects.findIndex((project) => project.order === undefined || project.order >= homeOrder)
  const listed = [...projects]
  listed.splice(at < 0 ? listed.length : at, 0, { ...entry, stale: !isDirectory(entry.path) })
  return listed
}

/**
 * Pin the project list's order to exactly `ids`, Home included (reorderProjects, which knows nothing of
 * Home). Home's place is recorded as the `order` of the project now below it — reorderProjects numbers
 * the named projects 0…n-1 in `ids`' order — so it is the count of projects named above it. A list that
 * does not name Home leaves its place as it was.
 */
export function reorderWorkspaces(ids: readonly string[], home = homedir()): void {
  const projects = ids.filter((id) => !isHomeWorkspace(id))
  reorderProjects(projects, home)
  const index = ids.indexOf(HOME_WORKSPACE_ID)
  if (index < 0) return
  const registry = readRegistry(home)
  const known = new Set(registry.projects.map((project) => project.id))
  registry.homeOrder = ids.slice(0, index).filter((id) => known.has(id)).length
  writeRegistry(registry, home)
}

/** findProjectBySegment, and Home by its slug or id. A registered project wins its own slug. */
export function findWorkspaceBySegment(segment: string, home = homedir()): RegistryEntry | undefined {
  const project = findProjectBySegment(segment, home)
  if (project) return project
  const entry = homeWorkspaceEntry(home)
  return segment === entry.slug || segment === HOME_WORKSPACE_ID ? entry : undefined
}

export function findWorkspaceById(id: string, home = homedir()): RegistryEntry | undefined {
  return isHomeWorkspace(id) ? homeWorkspaceEntry(home) : findById(id, home)
}

/** Home's Project: its board in its state directory, its agents in `folder`. See the header. */
export function homeWorkspaceProject(home = homedir(), folder = homeWorkspaceFolder(home)): Project {
  const stateDir = projectStateDir(HOME_WORKSPACE_ID, home)
  // Created here for the reason projectFromRegistryEntry creates a project's: SQLite will not open a
  // database under a directory that does not exist, and here the directory is also the board.
  mkdirSync(stateDir, { recursive: true })
  return {
    dir: stateDir,
    workDir: folder,
    id: HOME_WORKSPACE_ID,
    name: HOME_WORKSPACE_NAME,
    // No repository identity, deliberately — not even when the home folder IS one (a dotfiles repo is
    // common). Its issues are not what a `#12` in a Home thread means, and it is not Home's GitHub.
    label: HOME_WORKSPACE_NAME,
    stateDir,
    cwdSlug: cwdSlug(folder),
  }
}

/** The Project for any workspace entry — Home, or a registered project. */
export function projectForEntry(entry: { id: string; path: string; name?: string }, home = homedir()): Project {
  return isHomeWorkspace(entry.id) ? homeWorkspaceProject(home, entry.path) : projectFromRegistryEntry(entry, home)
}
