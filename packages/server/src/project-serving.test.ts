import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { test, type TestContext } from "node:test"
import { startServer } from "./index.ts"
import { tryAcquireProjectLaunchOwner, type ProcessPlatformAdapter } from "./project-launch.ts"
import {
  claimProjectServing,
  ProjectServedElsewhereError,
  projectServedElsewhere,
  readProjectServing,
} from "./project-serving.ts"

/** One fake machine: processes that come and go, each an adapter that can claim as itself. */
function machine() {
  const processes = new Map<number, { processStart: string; alive: boolean }>()
  let now = 1_000
  const as = (pid: number): ProcessPlatformAdapter => ({
    current: () => ({ pid, processStart: processes.get(pid)!.processStart }),
    observe: (other) => {
      const found = processes.get(other)
      return found?.alive ? { processStart: found.processStart, confidence: "exact" } : { confidence: "unavailable" }
    },
    isAlive: (other) => processes.get(other)?.alive === true,
    now: () => now,
    sleep: (ms) => { now += ms },
  })
  return {
    start(pid: number) {
      processes.set(pid, { processStart: `linux:boot:${pid}:${now++}`, alive: true })
      return as(pid)
    },
    exit(pid: number) { processes.get(pid)!.alive = false },
  }
}

function project(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "frizz-serving-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const projectDir = join(root, "repo")
  const stateDir = join(root, "state")
  mkdirSync(projectDir)
  mkdirSync(stateDir)
  return { projectId: "11111111-1111-4111-8111-111111111111", projectDir, stateDir, name: "kirby" }
}

test("a second live server is refused a project the first has open, by its pid", (t) => {
  const target = project(t)
  const box = machine()
  const installed = box.start(100), dev = box.start(200)
  claimProjectServing(target, { adapter: installed })
  assert.throws(
    () => claimProjectServing(target, { adapter: dev }),
    (error: unknown) => error instanceof ProjectServedElsewhereError && error.pid === 100
      && /^kirby is already being served by another Frizz \(pid 100\)\. Stop that one first/.test(error.message),
  )
  assert.equal(projectServedElsewhere(target.stateDir, target.projectId, dev), 100)
  assert.equal(projectServedElsewhere(target.stateDir, target.projectId, installed), undefined, "a server is not another server to itself")
  assert.equal(projectServedElsewhere(target.stateDir, "22222222-2222-4222-8222-222222222222", dev), undefined, "the record is about one project")
})

test("a claim whose server exited, or whose pid now belongs to another process, never blocks", (t) => {
  const target = project(t)
  const box = machine()
  claimProjectServing(target, { adapter: box.start(100) })
  box.exit(100)
  claimProjectServing(target, { adapter: box.start(200) })
  box.exit(200)
  // pid 200 again, started later: a different process.
  box.start(200)
  claimProjectServing(target, { adapter: box.start(300) })
  assert.equal(readProjectServing(target.stateDir)?.server?.pid, 300)
})

test("closing a project keeps its folder for registry recovery and drops only its own claim", (t) => {
  const target = project(t)
  const box = machine()
  const first = box.start(100), second = box.start(200)
  const claim = claimProjectServing(target, { adapter: first })
  claim.release()
  const closed = readProjectServing(target.stateDir)
  assert.equal(closed?.projectDir, target.projectDir)
  assert.equal(closed?.server, undefined)
  const next = claimProjectServing(target, { adapter: second })
  // A late second release from the first server is not allowed to erase the second's claim.
  claim.release()
  assert.equal(readProjectServing(target.stateDir)?.server?.pid, 200)
  assert.throws(() => claimProjectServing(target, { adapter: first }), ProjectServedElsewhereError)
  next.release()
  assert.equal(readProjectServing(target.stateDir)?.server, undefined)
})

// The lease is how a server running ON a project said it had it before there was a record, and how a
// frizz-dev that is still booting says so now. Under a supervisor, though, the lease on the project a
// server was LAUNCHED on is the supervisor's, a different process, so that claim reads the record alone.
test("a launch lease on the project refuses it as one of many, but not as the project the server was launched on", (t) => {
  const target = project(t)
  const box = machine()
  const supervisor = box.start(100), server = box.start(200)
  const lease = tryAcquireProjectLaunchOwner(target, "supervisor", { adapter: supervisor })
  assert.equal(lease.kind, "acquired")
  assert.throws(() => claimProjectServing(target, { adapter: server }), ProjectServedElsewhereError)
  claimProjectServing(target, { launched: true, adapter: server })
  assert.equal(readProjectServing(target.stateDir)?.server?.pid, 200)
})

const servingUrl = pathToFileURL(join(import.meta.dirname, "project-serving.ts")).href

// The seam the fakes cannot reach: two real processes, real process identities, and the real boot
// path, which must refuse before it opens the project's database.
test("a real server will not boot on a project another live process has open, and names it", { timeout: 20_000 }, async (t) => {
  const target = project(t)
  const holder = spawn(process.execPath, ["--input-type=module", "--eval", `
    import { claimProjectServing } from ${JSON.stringify(servingUrl)}
    claimProjectServing(JSON.parse(process.env.TARGET))
    console.log("claimed")
    setInterval(() => {}, 1000)
  `], { env: { ...process.env, TARGET: JSON.stringify(target) }, stdio: ["ignore", "pipe", "inherit"] })
  t.after(() => { if (holder.exitCode === null) holder.kill("SIGKILL") })
  const [first] = await once(holder.stdout, "data") as [Buffer]
  assert.equal(first.toString().trim(), "claimed")

  const boot = () => startServer({
    port: 65_124,
    project: { id: target.projectId, dir: target.projectDir, stateDir: target.stateDir, name: "kirby", label: "kirby", cwdSlug: "-kirby" },
  })
  await assert.rejects(boot(), new RegExp(`kirby is already being served by another Frizz \\(pid ${holder.pid}\\)`))
  assert.equal(existsSync(join(target.stateDir, "ui.db")), false, "refused before it opened the board")

  // Once that process is gone its record is a dead one, and nothing is left to clean up by hand.
  const exited = once(holder, "exit")
  holder.kill("SIGKILL")
  await exited
  assert.equal(projectServedElsewhere(target.stateDir, target.projectId), undefined)
  assert.equal(JSON.parse(readFileSync(join(target.stateDir, "serving.json"), "utf8")).server.pid, holder.pid)
})
