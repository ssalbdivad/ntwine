import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_DEV_PORT, DEFAULT_PORT, fallbackPort } from "@ntwine/shared"
import { ntwinePaths } from "@ntwine/server/ntwine-paths"
import { acquireProjectLaunchOwner, projectLaunchTokenProof } from "@ntwine/server/project-launch"
import { locateServer, ntwineAnswers, ownedNtwine } from "./server.ts"

const running = (port: number) => ({ kind: "running" as const, port, owner: {} as never })
const none = async () => false

test("a dev board of ours on a well-known port wins over the published launcher's record", async () => {
  const probed: number[] = []
  const found = await locateServer({
    readOwner: () => running(4321),
    healthy: async () => assert.fail("the record is not read while a well-known port is ours"),
    owned: async (port) => { probed.push(port); return port === DEFAULT_DEV_PORT },
  })
  assert.equal(found, `http://127.0.0.1:${DEFAULT_DEV_PORT}`)
  assert.deepEqual(probed, [DEFAULT_PORT, fallbackPort(DEFAULT_PORT), DEFAULT_DEV_PORT])
})

test("with no board of ours on a well-known port, the launcher's record is joined", async () => {
  assert.equal(await locateServer({ readOwner: () => running(4321), healthy: async () => true, owned: none }), "http://127.0.0.1:4321")
})

test("nothing answering is undefined, a stale record included", async () => {
  assert.equal(await locateServer({ readOwner: () => ({ kind: "idle" }), healthy: none, owned: none }), undefined)
  assert.equal(await locateServer({ readOwner: () => running(4321), healthy: none, owned: none }), undefined)
})

test("an ntwine on a well-known port is ours only if it proves this user's launch token", async () => {
  const home = mkdtempSync(join(tmpdir(), "ntwine-desktop-owned-"))
  const project = join(home, "repo")
  mkdirSync(project)
  const roots = ntwinePaths({ home, env: {} })
  const projectId = randomUUID()
  const stateDir = join(roots.data, "projects", projectId)
  mkdirSync(stateDir, { recursive: true })
  const lease = acquireProjectLaunchOwner({ projectId, projectDir: project, stateDir }, "launcher")
  let ownerProof = projectLaunchTokenProof({ projectId, projectDir: project, stateDir }, lease.token)
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ ok: true, projectId, projectDir: project, bootId: "boot", ownerProof }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  try {
    assert.equal(await ownedNtwine(port, roots), true)
    // Another account's server, or a `--sandbox` one: the same health, a token we do not hold.
    ownerProof = projectLaunchTokenProof({ projectId, projectDir: project, stateDir }, randomUUID())
    assert.equal(await ownedNtwine(port, roots), false)
    assert.equal(await ntwineAnswers(port), true, "it still answers — answering is not owning")
    // And one whose project has no record in OUR data root at all.
    assert.equal(await ownedNtwine(port, ntwinePaths({ home: join(home, "elsewhere"), env: {} })), false)
  } finally {
    server.close()
    lease.release()
    rmSync(home, { recursive: true, force: true })
  }
})
