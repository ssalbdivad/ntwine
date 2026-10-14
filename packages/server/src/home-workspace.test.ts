import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { test } from "node:test"
import { workerScratchPath } from "./dispatch.ts"
import { ntwinePathsNow, legacyNtwineRoot, projectStateDir } from "./ntwine-paths.ts"
import {
  findWorkspaceById,
  findWorkspaceBySegment,
  HOME_WORKSPACE_ID,
  homeWorkspaceEntry,
  homeWorkspaceProject,
  homeWorkspaceSlug,
  listWorkspaces,
  projectForEntry,
  reorderWorkspaces,
} from "./home-workspace.ts"
import { cwdSlug, workDirOf } from "./project.ts"
import { registerProject, writeRegistry } from "./project-registry.ts"

// These sandboxes run on the XDG layout, NOT the legacy `<home>/.ntwine` collapse root the registry
// tests use — the whole point here is that Home must never bring `<home>/.ntwine` into existence, and a
// sandbox that created it up front could not see that happen. An XDG variable inherited from the
// developer's shell would move that layout out of the sandbox into their real data root, so drop them.
for (const name of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) delete process.env[name]

const A = "0f5e2a1b-3c4d-4e6f-8a9b-1c2d3e4f5a6b"
const B = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d"

function sandbox(): string {
  // realpath'd: Home's folder is canonical, so an expectation built from a symlinked tmpdir would not match.
  return realpathSync(mkdtempSync(join(tmpdir(), "ntwine-home-ws-")))
}

/** A directory that looks like a registered project, registered in `home`'s sandbox registry. */
function project(home: string, rel: string, id: string): string {
  const dir = join(home, rel)
  mkdirSync(join(dir, ".ntwine"), { recursive: true })
  writeFileSync(join(dir, ".ntwine", ".id"), `${id}\n`)
  registerProject({ dir, id }, home)
  return dir
}

/** The invariant every case ends on: nothing created the home folder's board, and the layout did not flip. */
function assertNoHomeBoard(home: string): void {
  assert.equal(existsSync(legacyNtwineRoot(home)), false, "Home must never create <home>/.ntwine")
  // Afresh, as the next boot would: this process's memo would answer from before the case ran.
  assert.equal(ntwinePathsNow({ home }).legacy, false)
}

test("Home's slug is `home`, and a project already registered under it keeps it", () => {
  const home = sandbox()
  try {
    assert.equal(homeWorkspaceSlug(home), "home")
    assert.equal(homeWorkspaceSlug(home, new Set(["ntwine", "home"])), HOME_WORKSPACE_ID)

    // Written directly: registerProject can no longer mint `home`, but a registry from before the name
    // was reserved can hold it, and a bookmarked URL must not change under that project.
    const dir = join(home, "home")
    mkdirSync(dir)
    writeRegistry({ version: 1, projects: [{ id: A, path: dir, slug: "home", lastOpenedAt: new Date().toISOString() }] }, home)
    assert.equal(homeWorkspaceSlug(home), HOME_WORKSPACE_ID)
    assert.equal(homeWorkspaceEntry(home).slug, HOME_WORKSPACE_ID)

    assert.equal(findWorkspaceBySegment("home", home)?.id, A, "the registered project wins its own slug")
    const byId = findWorkspaceBySegment(HOME_WORKSPACE_ID, home)
    assert.equal(byId?.id, HOME_WORKSPACE_ID, "…and Home still answers on its id")
    assert.equal(byId?.path, home)
    assertNoHomeBoard(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("findWorkspaceBySegment: projects by slug or id, Home on `home` and on its id", () => {
  const home = sandbox()
  try {
    project(home, "code/proj", A)
    assert.equal(findWorkspaceBySegment("proj", home)?.id, A)
    assert.equal(findWorkspaceBySegment(A, home)?.id, A)
    for (const segment of ["home", HOME_WORKSPACE_ID]) {
      const entry = findWorkspaceBySegment(segment, home)
      assert.equal(entry?.id, HOME_WORKSPACE_ID, segment)
      assert.equal(entry?.slug, "home", segment)
      assert.equal(entry?.path, home, `${segment}: Home runs in the home folder`)
    }
    assert.equal(findWorkspaceBySegment("nope", home), undefined)
    assert.equal(findWorkspaceById(HOME_WORKSPACE_ID, home)?.slug, "home")
    assert.equal(findWorkspaceById(A, home)?.slug, "proj")
    assertNoHomeBoard(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("listWorkspaces: registered projects first, Home last", () => {
  const home = sandbox()
  try {
    project(home, "code/alpha", A)
    project(home, "code/beta", B)
    const listed = listWorkspaces(home)
    assert.deepEqual(listed.map((entry) => entry.id).slice(0, 2).sort(), [A, B].sort())
    assert.equal(listed.length, 3)
    const last = listed[2]
    assert.equal(last.id, HOME_WORKSPACE_ID, "Home is furniture: always last")
    assert.equal(last.stale, false)
    assert.equal(last.path, home)
    assertNoHomeBoard(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("reorderWorkspaces: Home holds the place it is dragged to, and later arrivals land below it", () => {
  const home = sandbox()
  const C = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e"
  try {
    project(home, "code/alpha", A)
    project(home, "code/beta", B)
    const ids = () => listWorkspaces(home).map((entry) => entry.id)

    reorderWorkspaces([B, HOME_WORKSPACE_ID, A], home)
    assert.deepEqual(ids(), [B, HOME_WORKSPACE_ID, A])
    reorderWorkspaces([HOME_WORKSPACE_ID, A, B], home)
    assert.deepEqual(ids(), [HOME_WORKSPACE_ID, A, B])

    // A list that does not name Home leaves it where it was.
    reorderWorkspaces([B, A], home)
    assert.deepEqual(ids(), [HOME_WORKSPACE_ID, B, A])

    // A project registered after the arrangement has no order: it goes to the end, below Home.
    reorderWorkspaces([B, HOME_WORKSPACE_ID, A], home)
    project(home, "code/gamma", C)
    assert.deepEqual(ids(), [B, HOME_WORKSPACE_ID, A, C])

    // Dragged back to the bottom, Home stays below every project then known.
    reorderWorkspaces([B, A, C, HOME_WORKSPACE_ID], home)
    assert.deepEqual(ids(), [B, A, C, HOME_WORKSPACE_ID])
    assertNoHomeBoard(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// The split the whole feature rests on: agents run in the home folder, the board lives in ntwine's
// state directory. `dir` being the home folder would make a worker's `.ntwine/threads/…` be `~/.ntwine`,
// which the next boot reads as the legacy data root.
test("homeWorkspaceProject: the board is in Home's state dir, the agents in the folder", () => {
  const home = sandbox()
  try {
    const folder = join(home, "work")
    mkdirSync(folder)
    const workspace = homeWorkspaceProject(home, folder)
    assert.equal(workspace.dir, projectStateDir(HOME_WORKSPACE_ID, home))
    assert.equal(workspace.stateDir, workspace.dir)
    assert.ok(existsSync(workspace.dir), "created, or SQLite cannot open the board's database")
    assert.notEqual(workspace.dir, folder)
    assert.equal(workspace.workDir, folder)
    assert.equal(workDirOf(workspace), folder)
    assert.equal(workspace.cwdSlug, cwdSlug(folder), "transcripts are sharded by where the agent runs")
    assert.equal(workspace.githubRepo, undefined, "a dotfiles repo in the home folder is not Home's GitHub")

    // By default the folder is the home folder itself — and the board is still NOT <home>/.ntwine.
    const bare = homeWorkspaceProject(home)
    assert.equal(bare.workDir, home)
    assert.notEqual(bare.dir, home)
    assert.ok(relative(legacyNtwineRoot(home), bare.dir).startsWith(".."), `${bare.dir} is outside <home>/.ntwine`)
    // A Home worker is told an ABSOLUTE scratch path in the state dir; the relative one would name <home>/.ntwine.
    const scratch = workerScratchPath(bare, "sid-1")
    assert.equal(scratch, join(bare.dir, ".ntwine", "threads", "sid-1"))
    assert.ok(!scratch.startsWith(legacyNtwineRoot(home)))
    assertNoHomeBoard(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("projectForEntry builds Home's split Project for Home, and an ordinary one otherwise", () => {
  const home = sandbox()
  try {
    const dir = project(home, "code/proj", A)
    const registered = projectForEntry({ id: A, path: dir }, home)
    assert.equal(registered.dir, dir)
    assert.equal(registered.workDir, undefined)
    assert.equal(workDirOf(registered), dir)

    const entry = homeWorkspaceEntry(home)
    const homeProject = projectForEntry(entry, home)
    assert.equal(homeProject.id, HOME_WORKSPACE_ID)
    assert.equal(homeProject.workDir, home)
    assert.equal(homeProject.dir, projectStateDir(HOME_WORKSPACE_ID, home))
    assertNoHomeBoard(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
