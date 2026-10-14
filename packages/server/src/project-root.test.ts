import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
  chosenProjectRoot,
  discoverProjectRoot,
  ensureProjectIdFile,
  existingProjectId,
  isExistingProjectRoot,
  isHomeDirectory,
  projectIdPath,
  readProjectIdFile,
  writeProjectIdFile,
} from "./project-root.ts"
import { randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"

const UUID = "029a30af-f126-40e3-b04c-d80e74e3e090"
const OTHER = "50577e5e-802f-4567-bd0e-cf7cbf3d2ed5"

function sandbox(name: string): string {
  return mkdtempSync(join(tmpdir(), `ntwine-root-${name}-`))
}

// The property a naive "just use cwd" loses, and the one users notice: two boards for one project,
// with two thread histories and nothing explaining why.
test("a sub-directory resolves to the project root, not to itself", () => {
  const home = sandbox("home")
  try {
    const root = join(home, "proj")
    mkdirSync(join(root, "src", "components"), { recursive: true })
    writeFileSync(join(root, "package.json"), "{}")
    assert.equal(discoverProjectRoot(join(root, "src", "components"), home), root)
    assert.equal(discoverProjectRoot(join(root, "src"), home), root)
    assert.equal(discoverProjectRoot(root, home), root)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("any VCS marks a root — git, jj, hg, svn — so a non-colocated jj checkout is a project", () => {
  const home = sandbox("vcs")
  try {
    for (const marker of [".git", ".jj", ".hg", ".svn"]) {
      const root = join(home, `repo${marker}`)
      mkdirSync(join(root, marker, "inner"), { recursive: true })
      mkdirSync(join(root, "deep", "nested"), { recursive: true })
      assert.equal(discoverProjectRoot(join(root, "deep", "nested"), home), root, marker)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// An existing ntwine project wins over the VCS or manifest it happens to sit inside.
test("a directory that already has an id is the root", () => {
  const home = sandbox("existing")
  try {
    const outer = join(home, "outer")
    const inner = join(outer, "packages", "inner")
    mkdirSync(inner, { recursive: true })
    writeFileSync(join(outer, "package.json"), "{}")
    mkdirSync(join(inner, ".ntwine"), { recursive: true })
    writeFileSync(projectIdPath(inner), `${UUID}\n`)
    assert.equal(discoverProjectRoot(inner, home), inner)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// A stray ~/package.json would otherwise make the whole home directory one project, with agents
// dispatched at it.
test("the home directory is never adopted as a project root", () => {
  const home = sandbox("guard")
  try {
    writeFileSync(join(home, "package.json"), "{}")
    mkdirSync(join(home, "loose"), { recursive: true })
    assert.equal(discoverProjectRoot(join(home, "loose"), home), join(home, "loose"))
    assert.equal(discoverProjectRoot(home, home), home, "cwd itself is still returned, just not adopted by a child")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("a plain directory under home with no markers at all is its own root", () => {
  const home = sandbox("plain")
  try {
    const dir = join(home, "notes")
    mkdirSync(dir, { recursive: true })
    assert.equal(discoverProjectRoot(dir, home), dir)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// The kirby bug (2026-09-02): ~/Documents was an adopted project, so picking a brand-new empty
// folder anywhere under it "added" documents instead — the picker navigated to another project's
// board, and no flow could create the new project at all.
test("an explicit pick is not captured by an adopted plain-directory ancestor", () => {
  const home = sandbox("chosen")
  try {
    const umbrella = join(home, "Documents")
    const picked = join(umbrella, "projects", "kirby")
    mkdirSync(picked, { recursive: true })
    writeProjectIdFile(umbrella, UUID)
    assert.equal(chosenProjectRoot(picked, home), picked)
    // The launcher's cwd walk-up keeps sub-directory equivalence for the same tree.
    assert.equal(discoverProjectRoot(picked, home), umbrella)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// The reason the walk-up exists at all: a folder inside a checkout is part of that checkout, and
// making it a project of its own would fragment the repo. An explicit pick still resolves up.
test("an explicit pick inside a checkout still adds the checkout", () => {
  const home = sandbox("chosen-repo")
  try {
    const repo = join(home, "repo")
    const picked = join(repo, "packages", "web")
    mkdirSync(join(repo, ".git"), { recursive: true })
    mkdirSync(picked, { recursive: true })
    writeProjectIdFile(repo, UUID) // adopted AND a repository — the marker keeps the capture
    assert.equal(chosenProjectRoot(picked, home), repo)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("an explicit pick of an adopted root, or of any marked folder, is that folder", () => {
  const home = sandbox("chosen-self")
  try {
    const adopted = join(home, "Documents")
    mkdirSync(adopted, { recursive: true })
    writeProjectIdFile(adopted, UUID)
    assert.equal(chosenProjectRoot(adopted, home), adopted)
    const manifest = join(home, "site")
    mkdirSync(manifest, { recursive: true })
    writeFileSync(join(manifest, "package.json"), "{}")
    assert.equal(chosenProjectRoot(manifest, home), manifest)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// The hazard that used to justify keeping identity in `git config --local`: a file in the tree can be
// committed, and two clones then share an id. A self-ignoring directory removes it outright.
test("writing an id also makes the directory ignore itself", () => {
  const dir = sandbox("ignore")
  try {
    writeProjectIdFile(dir, UUID)
    assert.equal(readFileSync(join(dir, ".ntwine", ".gitignore"), "utf8"), "*\n")
    assert.equal(readProjectIdFile(dir), UUID)
    // Re-writing must not clobber a .gitignore the user has since edited.
    writeFileSync(join(dir, ".ntwine", ".gitignore"), "*\n!keep\n")
    writeProjectIdFile(dir, OTHER)
    assert.equal(readFileSync(join(dir, ".ntwine", ".gitignore"), "utf8"), "*\n!keep\n")
    assert.equal(readProjectIdFile(dir), OTHER)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a missing id reads as absent; a malformed one is refused rather than guessed at", () => {
  const dir = sandbox("malformed")
  try {
    assert.equal(readProjectIdFile(dir), undefined)
    mkdirSync(join(dir, ".ntwine"), { recursive: true })
    writeFileSync(projectIdPath(dir), "not-a-uuid\n")
    assert.throws(() => readProjectIdFile(dir), /expected exactly one UUID/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("ensureProjectIdFile mints once and is stable across calls", () => {
  const home = sandbox("mint-home")
  const dir = sandbox("mint")
  try {
    const first = ensureProjectIdFile(dir, home)
    assert.match(first, /^[0-9a-f-]{36}$/)
    assert.equal(ensureProjectIdFile(dir, home), first, "a second launch adopts the same id")
    assert.equal(readProjectIdFile(dir), first)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})

// The whole reason an established repository does not lose its board: `git config ntwine.id` seeds the
// file rather than a fresh UUID being minted beside every thread the repo ever had.
test("an existing store seeds the file, and only when the file has nothing yet", () => {
  const home = sandbox("seed-home")
  const dir = sandbox("seed")
  try {
    assert.equal(ensureProjectIdFile(dir, home, UUID), UUID, "adopted the seed")
    assert.equal(readProjectIdFile(dir), UUID)
    assert.equal(ensureProjectIdFile(dir, home, OTHER), UUID, "the recorded id wins over a later seed")
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a seed that is not a UUID is refused rather than recorded", () => {
  const home = sandbox("badseed-home")
  const dir = sandbox("badseed")
  try {
    assert.throws(() => ensureProjectIdFile(dir, home, "nonsense"))
    assert.equal(existsSync(projectIdPath(dir)), false, "nothing was written")
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})

// $HOME is where ntwine keeps its OWN state (~/.ntwine), so adopting it as a project writes a project
// id into the global state root — and from then on the walk-up finds it from every unmarked
// directory under home. It happened on the maintainer's machine (2026-08-06).
test("the home directory is recognised even when it is reached through a symlink", () => {
  const real = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-realhome-")))
  const link = join(realpathSync(tmpdir()), `ntwine-linkhome-${randomUUID().slice(0, 8)}`)
  symlinkSync(real, link)
  try {
    assert.equal(isHomeDirectory(real, real), true)
    // THE BUG: comparing the paths as written misses this, because macOS hands the launcher a
    // resolved cwd while homedir() stays symlinked — and the guard silently lets home through.
    assert.equal(isHomeDirectory(link, real), true, "a symlinked home is still home")
    assert.equal(isHomeDirectory(real, link), true, "…in either direction")
    const child = join(real, "a-project")
    mkdirSync(child, { recursive: true })
    assert.equal(isHomeDirectory(child, real), false, "a directory inside home is not home")
  } finally {
    // unlinkSync, not rmSync: Node 25's rmSync follows a link to a directory and throws ERR_FS_EISDIR
    // (nodejs/node#61040), which failed this test in its cleanup after every assertion had passed.
    unlinkSync(link)
    rmSync(real, { recursive: true, force: true })
  }
})

// Boron and pullfrog/app were both in this state on the maintainer's machine — established boards
// with 15 and 85 threads, carrying only a `git config ntwine.id` because they predate the gitless
// change and had not been reopened since. A file-only check made them invisible to the registry
// backfill AND made the launcher offer to "add" them as if they were new, which would have minted a
// fresh id and orphaned every thread (2026-08-06).
test("a project whose id lives only in git config is still an EXISTING project", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-gitid-")))
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir })
    const id = randomUUID()
    execFileSync("git", ["config", "--local", "ntwine.id", id], { cwd: dir })
    assert.equal(existsSync(join(dir, ".ntwine", ".id")), false, "no id FILE, on purpose")

    assert.equal(existingProjectId(dir), id, "found in the git config")
    assert.equal(isExistingProjectRoot(dir), true, "so it is not a new directory")

    // The file still wins when both exist — it is the current store.
    writeProjectIdFile(dir, id)
    assert.equal(existingProjectId(dir), id)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a directory that claims no id at all is genuinely new", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-noid-")))
  try {
    assert.equal(existingProjectId(dir), undefined)
    assert.equal(isExistingProjectRoot(dir), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

