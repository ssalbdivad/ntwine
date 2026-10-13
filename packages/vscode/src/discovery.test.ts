import { test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync as realpath, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ntwinePaths, type NtwinePaths } from "@ntwine/server/ntwine-paths"
import { acquireProjectLaunchOwner, processStartTime, projectLaunchTokenProof } from "@ntwine/server/project-launch"
// The launcher's own reader and writer: the extension's replica is pinned to both.
import { acquireStableServerOwner, publishStableServerAddress, readStableServerOwner, releaseStableServerOwner, type ServerOwnerLease } from "../../../src/server-owner.ts"
import { discoverNtwine, launchTokenProof, observeGeneration, originFromSetting, ownedNtwine, pageAddressNote, psGeneration, readOwnerAddress } from "./discovery.ts"

interface Health {
  ok: true
  bootId: string
  projectId?: string
  projectDir?: string
  ownerProof?: string
}

/** A real listener answering /_ntwine/health the way the server does (app.ts), and 404 for anything else. */
async function healthServer(health: () => Health): Promise<{ port: number; server: Server }> {
  const server = createServer((request, response) => {
    if (request.url !== "/_ntwine/health") {
      response.statusCode = 404
      response.end("Not Found")
      return
    }
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify(health()))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { port: (server.address() as AddressInfo).port, server }
}

/** A port nothing listens on: bound, then released. */
async function deadPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  await new Promise((resolve) => server.close(resolve))
  return port
}

function fixtureRoots(): { home: string; roots: NtwinePaths } {
  const home = mkdtempSync(join(tmpdir(), "ntwine-vscode-discovery-"))
  return { home, roots: ntwinePaths({ home, env: {}, platform: "linux" }) }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}

function readJsonFile(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
}

/** This process as the published launcher: the machine-wide owner lease and its address record, written by the server's own code. */
function publishOwner(roots: NtwinePaths, port: number): ServerOwnerLease {
  const acquired = acquireStableServerOwner(roots)
  assert.equal(acquired.kind, "acquired")
  if (acquired.kind !== "acquired") throw new Error("unreachable")
  publishStableServerAddress(acquired.lease, port)
  return acquired.lease
}

test("the launch-token proof is byte-for-byte the server's projectLaunchTokenProof", () => {
  for (const [projectId, projectDir] of [[randomUUID(), "/home/me/repo"], [randomUUID(), "C:\\Users\\me\\repo"], [randomUUID(), "/tmp/ünïcode dir"]] as const) {
    const token = randomUUID()
    const theirs = projectLaunchTokenProof({ projectId, projectDir, stateDir: "/unused" }, token)
    assert.equal(launchTokenProof(projectId, projectDir, token), theirs)
    // Negative control: every input is load-bearing, so a near-miss is a different proof.
    assert.notEqual(launchTokenProof(projectId, `${projectDir}/`, token), theirs)
    assert.notEqual(launchTokenProof(projectId, projectDir, randomUUID()), theirs)
  }
})

test("ntwine.serverUrl is read as an origin, and loopback is always spelled 127.0.0.1", () => {
  assert.equal(originFromSetting(""), undefined)
  assert.equal(originFromSetting("   "), undefined)
  assert.equal(originFromSetting("9393"), "http://127.0.0.1:9393")
  assert.equal(originFromSetting("localhost:9393"), "http://127.0.0.1:9393")
  assert.equal(originFromSetting("http://localhost:9393/?project=ntwine"), "http://127.0.0.1:9393")
  assert.equal(originFromSetting("http://[::1]:19393"), "http://127.0.0.1:19393")
  assert.equal(originFromSetting("http://127.0.0.1:9494/all/x"), "http://127.0.0.1:9494")
  assert.equal(originFromSetting("https://ntwine.example.com"), "https://ntwine.example.com")
  assert.equal(originFromSetting("ftp://127.0.0.1:9393"), undefined)
  assert.equal(originFromSetting("http://"), undefined)
})

test("the setting wins outright — nothing on disk is read and no port is probed", async () => {
  const { home, roots } = fixtureRoots()
  try {
    writeJson(join(roots.state, "ntwine-server", "address.json"), { version: 1, port: 1 })
    const result = await discoverNtwine({ serverUrl: "localhost:4567", roots, ports: [], pidAlive: () => assert.fail("no pid is checked") })
    assert.deepEqual(result.found, { origin: "http://127.0.0.1:4567", port: 4567, source: "setting" })
    assert.equal((await discoverNtwine({ serverUrl: "ftp://nope", roots })).found, undefined, "a setting that names no http address finds nothing rather than falling back")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("the launcher's address record is taken while its port answers health, and passed over once it does not", async () => {
  const { home, roots } = fixtureRoots()
  const { port, server } = await healthServer(() => ({ ok: true, bootId: "boot" }))
  const lease = publishOwner(roots, port)
  try {
    const live = await discoverNtwine({ roots, ports: [] })
    assert.deepEqual(live.found, { origin: `http://127.0.0.1:${port}`, port, source: "owner-record" })

    // Negative control: the same live owner's record over a dead listener finds nothing.
    publishStableServerAddress(lease, await deadPort())
    const dead = await discoverNtwine({ roots, ports: [] })
    assert.equal(dead.found, undefined)
    assert.match(dead.notes.join("\n"), /does not answer/)
  } finally {
    releaseStableServerOwner(lease)
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test("an address record a crash left behind is not trusted, even when something answers health on its port", async () => {
  // The case the record's own comment warns about: the launcher was SIGKILLed (or WSL shut down), the
  // record stayed, and a `ntwine --sandbox` or another account's Ntwine now holds the port.
  const { home, roots } = fixtureRoots()
  const foreign = await healthServer(() => ({ ok: true, bootId: "foreign" }))
  const addressPath = join(roots.state, "ntwine-server", "address.json")
  mkdirSync(roots.data, { recursive: true })
  try {
    // A record with no owner beside it, and one whose owner pid is gone.
    writeJson(addressPath, { version: 1, ownerToken: randomUUID(), pid: 999_999, processStart: "linux:x:1", publisherToken: randomUUID(), port: foreign.port })
    const orphan = await discoverNtwine({ roots, ports: [], pidAlive: () => false })
    assert.equal(orphan.found, undefined)
    assert.match(orphan.notes.join("\n"), /no owner record behind it/)

    const lease = publishOwner(roots, foreign.port)
    releaseStableServerOwner(lease)
    // The release removed both; put back what a crash leaves: the owner record and the address, pid dead.
    const ownerToken = randomUUID()
    writeJson(join(roots.state, "ntwine-server", "project-launch.owner"), {
      version: 2, token: ownerToken, projectId: "c1fd5810-0f8a-4c1d-91a0-6d7445d28e5a", projectDir: realpath(roots.data), role: "server",
      state: "active", delegates: [], acquiredAt: "t", updatedAt: "t", pid: 999_999, processStart: "linux:x:1",
    })
    writeJson(addressPath, { version: 1, ownerToken, pid: 999_999, processStart: "linux:x:1", publisherToken: randomUUID(), port: foreign.port })
    const crashed = await discoverNtwine({ roots, ports: [], pidAlive: () => false })
    assert.equal(crashed.found, undefined, "a dead owner's port is not this user's Ntwine any more")
    assert.match(crashed.notes.join("\n"), /its owner, pid 999999, is gone/)
  } finally {
    foreign.server.close()
    rmSync(home, { recursive: true, force: true })
  }
})

// The fixtures forge Linux process-start markers (`linux:<boot id>:<ticks>`); elsewhere a forged marker
// would carry the wrong platform tag, which both readers rightly decline to compare.
test("the address-record verdict is readStableServerOwner's, case by case, over files the server's own writer wrote", { skip: process.platform !== "linux" && "Linux process-start markers" }, async () => {
  const { home, roots } = fixtureRoots()
  const ownerPath = join(roots.state, "ntwine-server", "project-launch.owner")
  const addressPath = join(roots.state, "ntwine-server", "address.json")
  const lease = publishOwner(roots, 4321)
  const owner = readJsonFile(ownerPath)
  const address = readJsonFile(addressPath)
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
  const dead = 2 ** 22 + 12_345
  const cases: { name: string; owner?: Record<string, unknown> | null; address?: Record<string, unknown>; running: boolean }[] = [
    { name: "the live owner and its own address", running: true },
    { name: "an address from another owner token", address: { ...address, ownerToken: randomUUID() }, running: false },
    { name: "an address naming another pid", address: { ...address, pid: 1 }, running: false },
    { name: "an address naming another process start", address: { ...address, processStart: `linux:${bootId}:1` }, running: false },
    { name: "an address missing its publisher token", address: { ...address, publisherToken: undefined }, running: false },
    { name: "an owner whose pid was reused by another process", owner: { ...owner, processStart: `linux:${bootId}:1` }, address: { ...address, processStart: `linux:${bootId}:1` }, running: false },
    { name: "an owner whose pid is gone", owner: { ...owner, pid: dead }, address: { ...address, pid: dead }, running: false },
    { name: "no owner record at all", owner: null, running: false },
    { name: "an owner from another data folder", owner: { ...owner, projectDir: "/elsewhere" }, running: false },
    { name: "an owner the platform cannot compare (opaque), still alive", owner: { ...owner, processStart: "opaque:x" }, address: { ...address, processStart: "opaque:x" }, running: true },
  ]
  try {
    for (const entry of cases) {
      if (entry.owner === null) rmSync(ownerPath, { force: true })
      else writeJson(ownerPath, entry.owner ?? owner)
      writeJson(addressPath, entry.address ?? address)
      const theirs = readStableServerOwner(roots)
      const ours = await readOwnerAddress(roots)
      assert.equal(theirs.kind === "running", entry.running, `${entry.name}: the desktop's reader says ${theirs.kind}`)
      assert.equal(ours.kind === "running", entry.running, `${entry.name}: the extension's reader says ${JSON.stringify(ours)}`)
      if (theirs.kind === "running" && ours.kind === "running") assert.equal(ours.port, theirs.port)
    }
  } finally {
    writeJson(ownerPath, owner)
    writeJson(addressPath, address)
    releaseStableServerOwner(lease)
    rmSync(home, { recursive: true, force: true })
  }
})

test("a live process's start marker is byte-for-byte the server's processStartTime", async () => {
  assert.equal(await observeGeneration(process.pid), processStartTime(process.pid))
  // The ps fallback (Linux without /proc, and macOS): canonical, and stable across reads.
  const ps = await psGeneration(process.pid)
  assert.match(ps ?? "", /^ps-utc:[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/)
  assert.equal(await psGeneration(process.pid), ps)
})

test("a well-known port is joined only when its health proves THIS user's launch token", async () => {
  const { home, roots } = fixtureRoots()
  const projectDir = join(home, "repo")
  mkdirSync(projectDir)
  const projectId = randomUUID()
  const stateDir = join(roots.data, "projects", projectId)
  mkdirSync(stateDir, { recursive: true })
  // The real writer of the owner record, so the reader is pinned to the format the server writes.
  const lease = acquireProjectLaunchOwner({ projectId, projectDir, stateDir }, "launcher")
  let health: Health = { ok: true, bootId: "boot", projectId, projectDir, ownerProof: projectLaunchTokenProof({ projectId, projectDir, stateDir }, lease.token) }
  const { port, server } = await healthServer(() => health)
  const closed = await deadPort()
  try {
    assert.equal(await ownedNtwine(port, roots.data), true)
    const found = await discoverNtwine({ roots, ports: [closed, port] })
    assert.deepEqual(found.found, { origin: `http://127.0.0.1:${port}`, port, source: "well-known-port" })

    // Another account's Ntwine or a --sandbox one: the same health shape, a token we do not hold.
    health = { ...health, ownerProof: projectLaunchTokenProof({ projectId, projectDir, stateDir }, randomUUID()) }
    assert.equal(await ownedNtwine(port, roots.data), false)
    assert.equal((await discoverNtwine({ roots, ports: [port] })).found, undefined)

    // A listener naming a project id that is not a uuid never gets to aim a path at our data root.
    health = { ok: true, bootId: "boot", projectId: "../../etc", projectDir, ownerProof: "0".repeat(64) }
    assert.equal(await ownedNtwine(port, roots.data), false)
  } finally {
    server.close()
    lease.release()
    rmSync(home, { recursive: true, force: true })
  }
})

test("ntwine-dev's public port beats server.lock's private one; server.lock is the last resort, while its pid lives", async () => {
  const { home, roots } = fixtureRoots()
  const projectId = randomUUID()
  const publicSide = await healthServer(() => ({ ok: true, bootId: "boot" }))
  const privateSide = await healthServer(() => ({ ok: true, bootId: "boot" }))
  try {
    writeJson(join(roots.data, "server.lock"), { pid: 4242, port: privateSide.port, projectId })
    const alive = new Set([4242, 5151])

    const lockOnly = await discoverNtwine({ roots, ports: [], pidAlive: (pid) => alive.has(pid) })
    assert.deepEqual(lockOnly.found, { origin: `http://127.0.0.1:${privateSide.port}`, port: privateSide.port, source: "server-lock" })

    writeJson(join(roots.data, "projects", projectId, "dev-supervisor.lock"), { pid: 5151, port: publicSide.port })
    const dev = await discoverNtwine({ roots, ports: [], pidAlive: (pid) => alive.has(pid) })
    assert.deepEqual(dev.found, { origin: `http://127.0.0.1:${publicSide.port}`, port: publicSide.port, source: "dev-supervisor" })

    // A dead supervisor's record is skipped for the control plane's own port.
    alive.delete(5151)
    assert.equal((await discoverNtwine({ roots, ports: [], pidAlive: (pid) => alive.has(pid) })).found?.source, "server-lock")

    // Negative control: a lock whose writer is gone is not an address, even though the port answers.
    alive.delete(4242)
    const stale = await discoverNtwine({ roots, ports: [], pidAlive: (pid) => alive.has(pid) })
    assert.equal(stale.found, undefined)
    assert.match(stale.notes.join("\n"), /pid 4242, which is gone/)
  } finally {
    publicSide.server.close()
    privateSide.server.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test("with nothing on disk and nothing listening, discovery finds nothing and says where it looked", async () => {
  const { home, roots } = fixtureRoots()
  try {
    const result = await discoverNtwine({ roots, ports: [await deadPort()] })
    assert.equal(result.found, undefined)
    assert.equal(result.notes.length, 3)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("a page opened on server.lock's port is logged as such; every other source is a public address", () => {
  for (const source of ["setting", "owner-record", "well-known-port", "dev-supervisor"] as const) {
    const { level, note } = pageAddressNote(source)
    assert.equal(level, "info")
    assert.match(note, /^a public address/)
  }
  const lock = pageAddressNote("server-lock")
  assert.equal(lock.level, "warn")
  assert.match(lock.note, /lock file/)
  assert.match(lock.note, /only when Ntwine runs without its restart supervisor/)
  assert.match(lock.note, /ntwine\.serverUrl/)
})
