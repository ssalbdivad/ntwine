// WHICH PROJECT A SPAWNED THREAD STARTS IN — the pure matching (spawn-project.ts), then the real router
// over two projects in one SQLite database, with only the dispatchers stubbed.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BoardSnapshot, DispatchInput } from "@ntwine/shared"
import type { BoardManager } from "./board.ts"
import { createApp } from "./app.ts"
import { createRouter } from "./router.ts"
import Database from "./sqlite.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import type { AppContext } from "./context.ts"
import type { Project } from "./project.ts"
import { registerProject } from "./project-registry.ts"
import { projectsNamedIn, resolveSpawnProject, type SpawnProject } from "./spawn-project.ts"

const HOME = "/home/u"
const home: SpawnProject = { id: "h", slug: "home", name: "Home", dir: HOME }
const arktype: SpawnProject = { id: "a", slug: "arktype", name: "arktype", dir: `${HOME}/arktype` }
const ntwine: SpawnProject = { id: "f", slug: "ntwine", name: "ntwine", dir: `${HOME}/ntwine` }
const open = [home, arktype, ntwine]
const named = (prompt: string, here: SpawnProject) => projectsNamedIn(prompt, here, open, HOME).map((n) => [n.project.slug, n.mention])

test("the @star-fallback brief, spawned from Home, names ArkType's checkout", () => {
  const prompt = "Repo: `~/arktype` (origin arktypeio/arktype). File: `ark/docs/components/GhStarButton.tsx`."
  assert.deepEqual(named(prompt, home), [["arktype", "~/arktype"]])
})

test("a path is owned by the most specific project, absolute or under ~, trailing punctuation dropped", () => {
  assert.deepEqual(named(`Edit /home/u/ntwine/packages/server/src/router.ts.`, home), [["ntwine", "/home/u/ntwine/packages/server/src/router.ts"]])
  assert.deepEqual(named("see (~/arktype/ark/docs), then ~/ntwine.", home), [["arktype", "~/arktype/ark/docs"], ["ntwine", "~/ntwine"]])
  assert.deepEqual(named("look at ~/arktype twice: ~/arktype/README.md", home), [["arktype", "~/arktype"]], "one entry per project")
})

test("this project's own paths, a project containing it, URLs and bare words are not evidence", () => {
  assert.deepEqual(named("fix ~/ntwine/packages/web and write notes to ~/.ntwine/scratch/x", ntwine), [], "Home contains ntwine")
  assert.deepEqual(named("the arktype docs at https://arktype.io/docs and github.com/arktypeio/arktype", home), [])
  assert.deepEqual(named("ran /usr/bin/env and read /etc/hosts", ntwine), [], "a path in no project")
  assert.deepEqual(named("ark/docs/components/GhStarButton.tsx in arktype", home), [], "a relative path names no project")
  // A sibling is evidence from anywhere, Home's folder included.
  assert.deepEqual(named("port it to ~/arktype", ntwine), [["arktype", "~/arktype"]])
})

test("a `project` argument resolves by slug, name, id or checkout path", () => {
  for (const want of ["arktype", "ArkType", "@arktype", "a", "~/arktype", "~/arktype/", `${HOME}/arktype`]) {
    assert.equal(resolveSpawnProject(want, open, HOME)?.slug, "arktype", want)
  }
  assert.equal(resolveSpawnProject("~", open, HOME)?.slug, "home")
  assert.equal(resolveSpawnProject("zod", open, HOME), undefined)
  assert.equal(resolveSpawnProject("~/arktype/ark", open, HOME), undefined, "a path inside a checkout is not its root")
})

// ── The router: two projects, one database ────────────────────────────────────────────────────────

const sessionRow = (slug: string): SessionRow => ({
  slug, session_id: `sid-${slug}`, thread_name: `ntwine-${slug}`, spawned_at: "2026-10-06T08:00:00.000Z", last_read_at: null,
  unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: slug, state: "open", meta: null, seen_at: null,
  transcript_id: null,
})

function tenant(root: string, db: Database, id: string) {
  const dir = join(root, id)
  const project: Project = { dir, id, name: id, label: id, stateDir: dir, cwdSlug: id }
  const storage = createStorage(db, id)
  const snapshot: BoardSnapshot = { projectDir: dir, projectName: id, projectLabel: id, threads: [], errors: [], warnings: [] }
  let refreshes = 0
  const board: BoardManager = {
    snapshot: async () => snapshot, currentSeq: () => 0, rebuild: async () => snapshot,
    refresh: () => (refreshes++, snapshot), start: async () => {}, stop: async () => {},
  }
  const dispatched: DispatchInput[] = []
  const ctx = {
    project, storage, board,
    dispatcher: {
      dispatch: async (input: DispatchInput) => {
        dispatched.push(input)
        const slug = `new-in-${id}`
        storage.upsertSession(sessionRow(slug))
        return { slug, sessionId: `sid-${slug}` }
      },
    },
  } as unknown as AppContext
  return { ctx, dir, dispatched, refreshes: () => refreshes, close: () => storage.close() }
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), "ntwine-spawn-project-"))
  // The router lists REGISTERED projects too (listWorkspaces reads the registry under HOME), so an empty
  // HOME keeps this machine's own projects out of the answer.
  const realHome = process.env.HOME
  process.env.HOME = join(root, "home")
  const db = new Database(join(root, "ntwine.db"))
  const alpha = tenant(root, db, "alpha")
  const beta = tenant(root, db, "beta")
  const tenants = [alpha, beta].map((t) => ({ project: t.ctx.project, board: t.ctx.board, ctx: t.ctx }))
  for (const t of [alpha, beta]) (t.ctx as { activeTenants?: AppContext["activeTenants"] }).activeTenants = () => tenants
  return {
    alpha, beta, router: createRouter(alpha.ctx),
    close: () => { process.env.HOME = realHome; alpha.close(); beta.close(); db.close(); rmSync(root, { recursive: true, force: true }) },
  }
}

const spawn = (prompt: string, extra: Partial<DispatchInput> = {}) =>
  ({ prompt, model: "opus", effort: "high", spawnedFrom: "caller", ...extra }) as DispatchInput

test("spawn_thread naming another project starts the thread there, and says which", async () => {
  const h = harness()
  try {
    const result = await h.router.dispatch.handler({ input: spawn("fix it", { project: "beta" }) })
    assert.deepEqual(result, { slug: "new-in-beta", sessionId: "sid-new-in-beta", project: "beta" })
    assert.equal(h.alpha.dispatched.length, 0)
    assert.equal(h.beta.dispatched.length, 1)
    assert.equal("project" in h.beta.dispatched[0]!, false, "routing fields stop at the router")
    assert.ok(h.beta.refreshes() > 0, "the target's board learns of it")

    // Its checkout path works too, and naming this project starts it here.
    await h.router.dispatch.handler({ input: spawn("again", { project: h.beta.dir }) })
    assert.equal(h.beta.dispatched.length, 2)
    const here = await h.router.dispatch.handler({ input: spawn("here", { project: "alpha" }) })
    assert.equal(here.slug, "new-in-alpha")
    assert.equal("project" in here, false)
  } finally {
    h.close()
  }
})

test("a worker's prompt naming another project's checkout, with no `project`, is refused with the list", async () => {
  const h = harness()
  try {
    const prompt = `Repo: \`${h.beta.dir}\`. File: \`src/x.ts\`.`
    await assert.rejects(h.router.dispatch.handler({ input: spawn(prompt) }), (error: Error) => {
      assert.match(error.message, /^Nothing was spawned\./)
      assert.match(error.message, /project: "beta"/)
      assert.match(error.message, /- `alpha` — alpha, `[^`]+` \(this thread's project\)\n- `beta` — beta/)
      return true
    })
    assert.equal(h.alpha.dispatched.length + h.beta.dispatched.length, 0, "a refusal starts nothing")

    // Naming either project is the answer; so is the board's own dispatch, which is never checked.
    await h.router.dispatch.handler({ input: spawn(prompt, { project: "alpha" }) })
    await h.router.dispatch.handler({ input: { prompt, model: "opus", effort: "high" } as DispatchInput })
    assert.equal(h.alpha.dispatched.length, 2)

    await assert.rejects(h.router.dispatch.handler({ input: spawn("x", { project: "gamma" }) }), /No project is called "gamma"[\s\S]*`beta`/)
  } finally {
    h.close()
  }
})

test("a registered project this server has not opened yet is a candidate, and spawning there opens it", async () => {
  const h = harness()
  try {
    // gamma: registered on the machine, no tenant open. The guard sees its checkout; `project` opens it.
    const gamma = tenant(mkdtempSync(join(tmpdir(), "ntwine-spawn-gamma-")), new Database(":memory:"), "gamma")
    mkdirSync(gamma.dir, { recursive: true })
    const { entry } = registerProject({ dir: gamma.dir, id: "gamma" })
    const opened: string[] = []
    ;(h.alpha.ctx as { openProject?: AppContext["openProject"] }).openProject = async (id) => (opened.push(id), id === "gamma" ? gamma.ctx : undefined)

    await assert.rejects(h.router.dispatch.handler({ input: spawn(`work in ${gamma.dir}/src`) }), new RegExp(`project: "${entry!.slug}"`))
    assert.deepEqual(opened, [], "a refusal opens nothing")

    const result = await h.router.dispatch.handler({ input: spawn("work there", { project: entry!.slug }) })
    assert.deepEqual(opened, ["gamma"])
    assert.equal(result.project, entry!.slug)
    assert.equal(gamma.dispatched.length, 1)
    gamma.close()
  } finally {
    h.close()
  }
})

// A worker whose MCP shim predates `spawnedFrom` (one is spawned per session and lives as long as it) sends
// the body below — what @pullfrog-status's did when it started @superset-impl in Home with the fork's
// checkout in its brief. Through the real app: its request has no `Origin` and node's user agent, so the
// guard runs anyway; the board's own dispatch, from a browser, still goes through untouched.
test("a worker too old to send `spawnedFrom` is still checked, and the board's dispatch is not", async () => {
  const h = harness()
  try {
    const port = 49_178
    const app = createApp(Object.assign(h.alpha.ctx, { bootId: "boot" }), { port })
    const prompt = `Implement the plan in the fork at \`${h.beta.dir}\`.`
    const post = (headers: Record<string, string>) =>
      app.request(`http://127.0.0.1:${port}/_ntwine/rpc/dispatch`, {
        method: "POST",
        headers: { host: `127.0.0.1:${port}`, "content-type": "application/json", ...headers },
        body: JSON.stringify({ prompt, model: "opus", effort: "xhigh", title: "Superset impl" }),
      })

    // The shim's headers exactly (ntwine-mcp.mjs postToNtwine, sent through node's fetch).
    const stale = await post({ "sec-fetch-site": "same-origin", "user-agent": "node" })
    const error = ((await stale.json()) as { error: string }).error
    assert.match(error, /^Nothing was spawned\./)
    assert.match(error, /older than its `project` argument/)
    assert.match(error, /start it from beta's board \(`beta`\)/)
    assert.equal(h.alpha.dispatched.length + h.beta.dispatched.length, 0, "a refusal starts nothing")

    // A browser: Origin on the POST, or (the no-Origin PWA path app.test.ts keeps open) a browser's user agent.
    assert.equal((await post({ origin: `http://127.0.0.1:${port}` })).status, 200)
    assert.equal((await post({ "sec-fetch-site": "same-origin", "user-agent": "Mozilla/5.0 (X11; Linux x86_64)" })).status, 200)
    assert.equal(h.alpha.dispatched.length, 2, "what the human types is never second-guessed")
  } finally {
    h.close()
  }
})
