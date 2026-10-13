import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { test } from "node:test"
import { migrateFrizzInstall } from "./frizz-migration.ts"

const ID = "6f3c2b1a-0d4e-4f5a-8b6c-7d8e9f0a1b2c"
const OTHER_ID = "50577e5e-802f-4567-bd0e-cf7cbf3d2ed5"
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

/** A home shaped like a Frizz install on Linux: three roots, a registry naming one repository whose board is `.frizz`. */
function frizzHome(t: { after(fn: () => void): void }) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "frizz-migration-")))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const data = join(home, ".local", "share", "frizz")
  const repo = join(home, "repo")
  mkdirSync(join(data, "projects", ID, "claude-broker"), { recursive: true })
  mkdirSync(join(home, ".local", "state", "frizz", "frizz-server"), { recursive: true })
  mkdirSync(join(home, ".cache", "frizz", "runtimes"), { recursive: true })
  writeFileSync(join(home, ".cache", "frizz", "runtimes", "claude"), "binary")
  writeFileSync(join(data, "registry.json"), JSON.stringify({ version: 1, projects: [{ id: ID, path: repo, icon: join(data, "projects", ID, "icon.ico") }] }))
  mkdirSync(join(repo, ".frizz", "threads", "t1"), { recursive: true })
  git(repo, "init", "-q")
  git(repo, "config", "frizz.id", ID)
  writeFileSync(join(repo, ".frizz", ".id"), `${ID}\n`)
  writeFileSync(join(repo, ".frizz", ".gitignore"), "*\n")
  writeFileSync(join(repo, ".frizz", "threads", "t1", "notes.md"), "written before the rename")
  const db = new DatabaseSync(join(data, "ui.db"))
  db.exec("CREATE TABLE session (slug TEXT, thread_name TEXT); INSERT INTO session VALUES ('a', 'frizz-a'), ('b', 'ntwine-b')")
  db.exec("CREATE TABLE codex_app_server_session (frizz_session_id TEXT)")
  db.close()
  return { home, data, repo }
}

const linux = (home: string) => ({ env: {}, platform: "linux" as const, home })

test("a Frizz install moves to the Ntwine names, leaving a link at every old path, and a second run finds nothing", (t) => {
  const { home, data, repo } = frizzHome(t)
  const result = migrateFrizzInstall(linux(home))
  assert.equal(result.status, "migrated")

  const ntwineData = join(home, ".local", "share", "ntwine")
  for (const [from, to] of [
    [data, ntwineData],
    [join(home, ".local", "state", "frizz"), join(home, ".local", "state", "ntwine")],
    [join(home, ".cache", "frizz"), join(home, ".cache", "ntwine")],
    [join(home, ".local", "state", "ntwine", "frizz-server"), join(home, ".local", "state", "ntwine", "ntwine-server")],
    [join(repo, ".frizz"), join(repo, ".ntwine")],
  ]) {
    assert.ok(lstatSync(from!).isSymbolicLink(), `${from} is a link`)
    assert.equal(realpathSync(from!), to, `${from} resolves to ${to}`)
  }
  assert.equal(readFileSync(join(repo, ".ntwine", "threads", "t1", "notes.md"), "utf8"), "written before the rename")
  assert.equal(git(repo, "config", "ntwine.id"), ID)
  assert.equal(git(repo, "config", "frizz.id"), ID, "the old key is copied, not moved")
  assert.equal(git(repo, "status", "--porcelain"), "", "the board ignores itself and the link is excluded")
  assert.ok(readFileSync(join(repo, ".git", "info", "exclude"), "utf8").split("\n").includes("/.frizz"))
  assert.deepEqual(JSON.parse(readFileSync(join(ntwineData, "registry.json"), "utf8")).projects[0].icon, join(ntwineData, "projects", ID, "icon.ico"))

  const db = new DatabaseSync(join(ntwineData, "ui.db"), { readOnly: true })
  assert.deepEqual(db.prepare("SELECT thread_name FROM session ORDER BY slug").all().map((row) => row.thread_name), ["ntwine-a", "ntwine-b"])
  assert.deepEqual(db.prepare("PRAGMA table_info(codex_app_server_session)").all().map((row) => row.name), ["ntwine_session_id"])
  db.close()

  assert.deepEqual(migrateFrizzInstall(linux(home)), { status: "none", steps: [], moved: [] })
})

test("a dry run lists every step and changes nothing", (t) => {
  const { home, data, repo } = frizzHome(t)
  const before = execFileSync("find", [home, "-printf", "%p %y %s\n"], { encoding: "utf8" })
  const result = migrateFrizzInstall({ ...linux(home), dryRun: true })
  assert.equal(execFileSync("find", [home, "-printf", "%p %y %s\n"], { encoding: "utf8" }), before)
  assert.deepEqual(result.moved.map((pair) => pair.from), [data, join(home, ".local", "state", "frizz"), join(home, ".cache", "frizz")])
  assert.deepEqual(result.steps.map((line) => line.split(" ")[0]), [
    "Move", "Link", "Move", "Link", "Move", "Link", // three roots
    "Move", "Link", // the lease
    "Rewrite", "Rename", "Rename", // registry, thread names, codex column
    "Move", "Link", "Exclude", // the board
    "Copy", // git id
  ])
  assert.ok(result.steps.some((line) => line.includes(join(repo, ".frizz"))))
})

test("refuses, touching nothing, when an Ntwine install already exists beside the Frizz one", (t) => {
  const { home, data } = frizzHome(t)
  mkdirSync(join(home, ".local", "share", "ntwine"), { recursive: true })
  writeFileSync(join(home, ".local", "share", "ntwine", "registry.json"), "{}")
  const result = migrateFrizzInstall(linux(home))
  assert.equal(result.status, "refused")
  assert.match(result.reason!, /^Both a Frizz install \(.+\) and an Ntwine install \(.+\) are on this machine/)
  assert.ok(lstatSync(data).isDirectory() && !lstatSync(data).isSymbolicLink())
})

// The live machine at the cutover: worker hooks on current code wrote under the new names first.
test("what was written under the new name first is merged in; where both sides hold a file the newer wins and the older is kept", (t) => {
  const { home, repo } = frizzHome(t)
  mkdirSync(join(home, ".local", "state", "ntwine", "job-gate"), { recursive: true })
  writeFileSync(join(home, ".local", "state", "ntwine", "job-gate", "state.json"), "new")
  mkdirSync(join(home, ".local", "state", "frizz", "job-gate"), { recursive: true })
  writeFileSync(join(home, ".local", "state", "frizz", "job-gate", "state.json"), "old")
  utimesSync(join(home, ".local", "state", "frizz", "job-gate", "state.json"), new Date(0), new Date(0))
  mkdirSync(join(repo, ".ntwine", "worktrees", "w"), { recursive: true })
  writeFileSync(join(repo, ".ntwine", "worktrees", "w", "file"), "a worktree made after the rename")

  assert.equal(migrateFrizzInstall(linux(home)).status, "migrated")
  const state = join(home, ".local", "state", "ntwine")
  assert.equal(readFileSync(join(state, "job-gate", "state.json"), "utf8"), "new")
  const [stamp] = readdirSync(join(state, "frizz-migration-conflicts"))
  assert.equal(readFileSync(join(state, "frizz-migration-conflicts", stamp!, "job-gate", "state.json"), "utf8"), "old")
  assert.equal(readFileSync(join(repo, ".ntwine", "worktrees", "w", "file"), "utf8"), "a worktree made after the rename")
  assert.equal(readFileSync(join(repo, ".ntwine", "threads", "t1", "notes.md"), "utf8"), "written before the rename")
})

test("a board whose two halves name different projects is left alone", (t) => {
  const { home, repo } = frizzHome(t)
  mkdirSync(join(repo, ".ntwine"))
  writeFileSync(join(repo, ".ntwine", ".id"), `${OTHER_ID}\n`)
  const lines: string[] = []
  migrateFrizzInstall({ ...linux(home), log: (line) => lines.push(line) })
  assert.ok(lstatSync(join(repo, ".frizz")).isDirectory() && !lstatSync(join(repo, ".frizz")).isSymbolicLink())
  assert.equal(readFileSync(join(repo, ".ntwine", ".id"), "utf8"), `${OTHER_ID}\n`)
  assert.ok(lines.includes(`Left ${join(repo, ".frizz")} where it is: ${join(repo, ".ntwine")} names a different project id`))
})

test("an install in ~/.frizz becomes ~/.ntwine; a ~/.frizz without a registry is never taken for one", (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "frizz-migration-dot-")))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  mkdirSync(join(home, ".frizz", "scratch"), { recursive: true })
  assert.equal(migrateFrizzInstall(linux(home)).status, "none", "agent scratch is not an install")
  assert.ok(!existsSync(join(home, ".ntwine")))

  writeFileSync(join(home, ".frizz", "registry.json"), JSON.stringify({ projects: [] }))
  assert.equal(migrateFrizzInstall(linux(home)).status, "migrated")
  assert.equal(realpathSync(join(home, ".frizz")), join(home, ".ntwine"))
  assert.ok(existsSync(join(home, ".ntwine", "scratch")))
})
