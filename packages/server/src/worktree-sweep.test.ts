// REMOVING IDLE WORKTREES — the predicate (pure), then the whole sweep against a REAL git repository.
//
// The repository test builds one worktree per keep/remove case under `.ntwine/worktrees` and runs the
// real sweep over it: real `git worktree list`, `git status --ignored`, `git worktree remove`. Only
// the eligible worktree may go, its branch must survive, and every other case is a negative control
// that proves the sweep CAN keep (a sweep that removed everything would fail four ways).
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BoardSnapshot, ThreadView } from "@ntwine/shared"
import type { AppContext } from "./context.ts"
import type { Project } from "./project.ts"
import { threadFoldersInUse } from "./router.ts"
import { createStorage } from "./storage.ts"
import { idleWorktreeKeepReason, parseWorktreeList, regenerable, sweepIdleWorktrees, type WorktreeFacts } from "./worktree-sweep.ts"

const DAY = 86_400_000
const NOW = Date.parse("2026-10-07T12:00:00.000Z")

const facts = (over: Partial<WorktreeFacts> = {}): WorktreeFacts => ({
  path: "/nowhere/wt",
  changes: [],
  ignored: [],
  headOnRef: true,
  lastCommitMs: NOW - 10 * DAY,
  newestFileMs: NOW - 9 * DAY,
  ...over,
})

test("an idle, clean worktree nobody is in may go", () => {
  assert.equal(idleWorktreeKeepReason(facts(), 7, NOW), undefined)
})

test("each check keeps the worktree on its own", () => {
  const cases: [Partial<WorktreeFacts>, RegExp][] = [
    [{ locked: true }, /locked/],
    [{ prunable: true }, /already gone/],
    [{ project: "ntwine-wt" }, /registered project ntwine-wt/],
    [{ inUseBy: { dir: "/nowhere/wt/packages", by: "ntwine/fix-it" } }, /thread ntwine\/fix-it is working in it/],
    [{ changes: [" M src/a.ts"] }, /uncommitted changes: {2}M src\/a\.ts/],
    [{ changes: ["?? notes.md"] }, /uncommitted changes/],
    [{ ignored: [".env"] }, /ignored files git cannot restore: \.env/],
    [{ ignored: ["node_modules/", "data/app.db"] }, /data\/app\.db/],
    [{ headOnRef: false }, /orphan/],
    // Idle is measured from the NEWER of the commit and the newest file.
    [{ newestFileMs: NOW - 2 * DAY }, /used 2d ago, under 7d/],
    [{ lastCommitMs: NOW - 3 * 3_600_000 }, /used 3h ago/],
  ]
  for (const [over, reason] of cases) assert.match(idleWorktreeKeepReason(facts(over), 7, NOW) ?? "", reason, JSON.stringify(over))
})

test("a fact that could not be read keeps the worktree", () => {
  for (const key of ["changes", "ignored", "headOnRef", "lastCommitMs", "newestFileMs"] as const) {
    assert.match(idleWorktreeKeepReason(facts({ [key]: undefined }), 7, NOW) ?? "", /could not/, key)
  }
})

test("0 days is off", () => {
  assert.match(idleWorktreeKeepReason(facts(), 0, NOW) ?? "", /off/)
})

test("only dependency and build output counts as regenerable", () => {
  for (const entry of ["node_modules/", "packages/web/node_modules/", "dist/", "build/", ".turbo/", ".cache/", ".next/", "coverage/", "tsconfig.tsbuildinfo", "packages/x/tsconfig.tsbuildinfo", "dist/inner.env", "__pycache__/", "a.pyc", ".DS_Store"]) {
    assert.equal(regenerable(entry, "/nowhere"), true, entry)
  }
  for (const entry of [".env", ".env.local", "data/app.db", "local.sqlite", "secrets/", "fixtures/big.json", ".venv/", "out/", ".ntwine/"]) {
    assert.equal(regenerable(entry, "/nowhere"), false, entry)
  }
})

test("a .ntwine folder is regenerable only when it holds nothing but Ntwine's markers", () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-wt-markers-"))
  try {
    mkdirSync(join(dir, ".ntwine"))
    writeFileSync(join(dir, ".ntwine", ".id"), "x")
    writeFileSync(join(dir, ".ntwine", ".gitignore"), "*\n")
    assert.equal(regenerable(".ntwine/", dir), true)
    mkdirSync(join(dir, ".ntwine", "threads"))
    assert.equal(regenerable(".ntwine/", dir), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("git worktree list --porcelain parses", () => {
  const parsed = parseWorktreeList(
    "worktree /r\nHEAD aaa\nbranch refs/heads/main\n\nworktree /r/.ntwine/worktrees/a\nHEAD bbb\ndetached\nlocked because\n\nworktree /r/.ntwine/worktrees/b\nHEAD ccc\nbranch refs/heads/b\nprunable gitdir file points to non-existent location\n",
  )
  assert.deepEqual(parsed, [
    { path: "/r", head: "aaa", branch: "refs/heads/main" },
    { path: "/r/.ntwine/worktrees/a", head: "bbb", locked: true },
    { path: "/r/.ntwine/worktrees/b", head: "ccc", branch: "refs/heads/b", prunable: true },
  ])
})

// ── threadFoldersInUse: which threads count as open work ─────────────────────────────────────────────

test("open, pinned and snoozed threads report their folders; an unpinned done one does not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-wt-inuse-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  try {
    const project: Project = { dir, id: "p", name: "proj", label: "proj", stateDir: dir, cwdSlug: "proj" }
    const view = (id: string, over: Partial<ThreadView>): ThreadView =>
      ({ kind: "session", id, state: "open", runtime: "exited", subAgents: [], bgShells: [], ...over }) as unknown as ThreadView
    const wt = (name: string) => join(dir, ".ntwine", "worktrees", name)
    const threads = [
      view("running", { runtime: "running", checkout: { dir: wt("a"), kind: "worktree" } }),
      view("queued", { checkout: { dir: wt("b"), kind: "worktree" } }),
      view("snoozed", { snoozedUntil: new Date(Date.now() + DAY).toISOString(), checkout: { dir: wt("c"), kind: "worktree" } } as Partial<ThreadView>),
      view("pinned-done", { state: "archived", pinnedAt: "2026-10-01T00:00:00Z", checkout: { dir: wt("d"), kind: "worktree" } }),
      view("done", { state: "archived", checkout: { dir: wt("e"), kind: "worktree" } }),
      view("shell", { bgShells: [{ label: "dev", startedAt: "x", state: "running", cwd: wt("f") }] }),
    ]
    const snapshot = { projectDir: dir, projectName: "proj", projectLabel: "proj", threads, errors: [], warnings: [] } as unknown as BoardSnapshot
    const ctx = {
      project,
      storage,
      board: { snapshot: async () => snapshot },
      tailer: { get: (slug: string) => (slug === "queued" ? { workingDir: wt("b/packages") } : undefined) },
      backendFor: () => undefined,
    } as unknown as AppContext
    const found = await threadFoldersInUse(ctx)
    const dirs = new Set(found.map((use) => use.dir))
    for (const name of ["a", "b", "b/packages", "c", "d", "f"]) assert.ok(dirs.has(wt(name)), name)
    assert.ok(!dirs.has(wt("e")), "a done, unpinned thread at rest does not hold its worktree")
    assert.ok(found.every((use) => use.by.startsWith("proj/")))
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── The real repository ──────────────────────────────────────────────────────────────────────────────

function sh(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1", HOME: cwd, ...env },
  })
}

/** Set every file and folder under `dir` to `ms`, skipping `.git`. */
function age(dir: string, ms: number): void {
  const at = ms / 1000
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue
    const p = join(dir, entry.name)
    if (entry.isDirectory()) age(p, ms)
    utimesSync(p, at, at)
  }
}

test("the real sweep removes only the idle, clean, unused worktree, and keeps its branch", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-wt-sweep-")))
  const main = join(root, "repo")
  const old = Date.now() - 20 * DAY
  const oldDate = `${Math.floor(old / 1000)} +0000`
  try {
    mkdirSync(main)
    sh(main, ["init", "-q", "-b", "main"])
    writeFileSync(join(main, ".gitignore"), "node_modules/\n*.tsbuildinfo\n.env\n*.db\n")
    writeFileSync(join(main, "a.ts"), "export {}\n")
    sh(main, ["add", "-A"])
    sh(main, ["commit", "-q", "-m", "init"], { GIT_COMMITTER_DATE: oldDate, GIT_AUTHOR_DATE: oldDate })
    // Ntwine's own marker folder, ignored by its own .gitignore as in every Ntwine project.
    mkdirSync(join(main, ".ntwine", "worktrees"), { recursive: true })
    writeFileSync(join(main, ".ntwine", ".gitignore"), "*\n")
    writeFileSync(join(main, ".ntwine", ".id"), "id\n")

    const names = ["eligible", "dirty", "untracked", "dotenv", "recent", "in-use", "locked", "orphan"] as const
    const wt = (name: string) => join(main, ".ntwine", "worktrees", name)
    for (const name of names) {
      if (name === "orphan") sh(main, ["worktree", "add", "-q", "--detach", wt(name)])
      else sh(main, ["worktree", "add", "-q", "-b", name, wt(name)])
    }
    // Regenerable ignored output in the eligible one: must NOT keep it.
    mkdirSync(join(wt("eligible"), "node_modules", "pkg"), { recursive: true })
    writeFileSync(join(wt("eligible"), "node_modules", "pkg", "index.js"), "1\n")
    writeFileSync(join(wt("eligible"), "tsconfig.tsbuildinfo"), "{}\n")
    writeFileSync(join(wt("dirty"), "a.ts"), "export const changed = 1\n")
    writeFileSync(join(wt("untracked"), "notes.md"), "mine\n")
    writeFileSync(join(wt("dotenv"), ".env"), "SECRET=1\n")
    sh(main, ["worktree", "lock", wt("locked")])
    // A commit on the detached worktree that no ref contains.
    writeFileSync(join(wt("orphan"), "b.ts"), "export {}\n")
    sh(wt("orphan"), ["add", "b.ts"])
    sh(wt("orphan"), ["commit", "-q", "-m", "orphan"], { GIT_COMMITTER_DATE: oldDate, GIT_AUTHOR_DATE: oldDate })
    // A folder in the worktree folder git does not know.
    mkdirSync(join(main, ".ntwine", "worktrees", "stray"))
    writeFileSync(join(main, ".ntwine", "worktrees", "stray", "keep.txt"), "x\n")

    // Everything is 20 days old — except the recent worktree, whose file was touched just now.
    for (const name of names) age(wt(name), old)
    age(join(main, ".ntwine", "worktrees", "stray"), old)
    // The folder's own mtime is recent everywhere (we just wrote into it); it must not count.
    writeFileSync(join(wt("recent"), "a.ts"), "export {}\n") // same content: clean, but a fresh mtime

    const projects = [{ id: "p", name: "repo", dir: main, stale: false, open: true }]
    const inUse = [{ dir: join(wt("in-use"), "packages", "web"), by: "repo/working" }]
    const result = await sweepIdleWorktrees({ days: () => 7, projects: () => projects, inUse: async () => inUse })

    assert.deepEqual(result.removed, [wt("eligible")])
    assert.equal(existsSync(wt("eligible")), false, "the eligible worktree's folder is gone")
    const reasons = Object.fromEntries(result.kept.map((k) => [k.path.split("/").at(-1), k.reason]))
    assert.match(reasons.dirty!, /uncommitted changes/)
    assert.match(reasons.untracked!, /uncommitted changes: \?\? notes\.md/)
    assert.match(reasons.dotenv!, /ignored files git cannot restore: \.env/)
    assert.match(reasons.recent!, /used \d+m ago, under 7d/)
    assert.match(reasons["in-use"]!, /thread repo\/working is working in it/)
    assert.match(reasons.locked!, /locked/)
    assert.match(reasons.orphan!, /orphan the commit/)
    assert.match(reasons.stray!, /not a worktree git knows/)
    for (const name of names.filter((n) => n !== "eligible")) assert.ok(existsSync(wt(name)), `${name} is kept`)
    // The branch survives, and git no longer lists the worktree (pruned).
    assert.match(sh(main, ["rev-parse", "--verify", "refs/heads/eligible"]), /^[0-9a-f]{40}/)
    assert.doesNotMatch(sh(main, ["worktree", "list", "--porcelain"]), /worktrees\/eligible/)

    // A second pass is a no-op on what is left.
    const again = await sweepIdleWorktrees({ days: () => 7, projects: () => projects, inUse: async () => inUse })
    assert.deepEqual(again.removed, [])

    // Negative controls at the machine level: off, and a project of this repository not open here.
    sh(main, ["worktree", "add", "-q", "-b", "eligible-2", wt("eligible-2")])
    age(wt("eligible-2"), old)
    assert.deepEqual((await sweepIdleWorktrees({ days: () => 0, projects: () => projects, inUse: async () => [] })).removed, [])
    const closed = [...projects, { id: "q", name: "repo-wt", dir: wt("dirty"), stale: false, open: false }]
    assert.deepEqual((await sweepIdleWorktrees({ days: () => 7, projects: () => closed, inUse: async () => [] })).removed, [])
    assert.ok(existsSync(wt("eligible-2")))
    // …and with neither, it goes.
    assert.deepEqual((await sweepIdleWorktrees({ days: () => 7, projects: () => projects, inUse: async () => inUse })).removed, [wt("eligible-2")])
    assert.match(sh(main, ["rev-parse", "--verify", "refs/heads/eligible-2"]), /^[0-9a-f]{40}/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
