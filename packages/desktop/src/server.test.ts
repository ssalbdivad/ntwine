import { test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DEFAULT_DEV_PORT, DEFAULT_PORT, fallbackPort } from "@frizz/shared"
import { frizzPaths } from "@frizz/server/frizz-paths"
import { acquireProjectLaunchOwner, projectLaunchTokenProof } from "@frizz/server/project-launch"
import {
  findExecutable,
  frizzAnswers,
  latestProgress,
  locateServer,
  needsProjectDirectory,
  ownedFrizz,
  readoutValue,
  startServer,
} from "./server.ts"

const running = (port: number) => ({ kind: "running" as const, port, owner: {} as never })

test("the published launcher's owner record wins over any port probe", async () => {
  const probed: number[] = []
  const found = await locateServer({
    readOwner: () => running(4321),
    healthy: async (port) => { probed.push(port); return true },
  })
  assert.equal(found, "http://127.0.0.1:4321")
  assert.deepEqual(probed, [4321])
})

test("with no record, a server of ours on a well-known port is joined — frizz-dev writes none", async () => {
  const probed: number[] = []
  const found = await locateServer({
    readOwner: () => ({ kind: "idle" }),
    healthy: async () => assert.fail("only the record's port is taken on its health alone"),
    owned: async (port) => { probed.push(port); return port === DEFAULT_DEV_PORT },
  })
  assert.equal(found, `http://127.0.0.1:${DEFAULT_DEV_PORT}`)
  assert.deepEqual(probed, [DEFAULT_PORT, fallbackPort(DEFAULT_PORT), DEFAULT_DEV_PORT])
})

test("nothing running is undefined; a lease with no listener yet is a launch to wait for", async () => {
  const none = async () => false
  assert.equal(await locateServer({ readOwner: () => ({ kind: "idle" }), healthy: none, owned: none }), undefined)
  assert.equal(await locateServer({ readOwner: () => ({ kind: "busy", owner: null }), healthy: none, owned: none }), "starting")
  // A record whose listener does not answer is not "nothing": a second launcher would only queue.
  assert.equal(await locateServer({ readOwner: () => running(4321), healthy: none, owned: none }), "starting")
})

test("a Frizz on a well-known port is ours only if it proves this user's launch token", async () => {
  const home = mkdtempSync(join(tmpdir(), "frizz-desktop-owned-"))
  const project = join(home, "repo")
  mkdirSync(project)
  const roots = frizzPaths({ home, env: {} })
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
    assert.equal(await ownedFrizz(port, roots), true)
    // Another account's server, or a `--sandbox` one: the same health, a token we do not hold.
    ownerProof = projectLaunchTokenProof({ projectId, projectDir: project, stateDir }, randomUUID())
    assert.equal(await ownedFrizz(port, roots), false)
    assert.equal(await frizzAnswers(port), true, "it still answers — answering is not owning")
    // And one whose project has no record in OUR data root at all.
    assert.equal(await ownedFrizz(port, frizzPaths({ home: join(home, "elsewhere"), env: {} })), false)
  } finally {
    server.close()
    lease.release()
    rmSync(home, { recursive: true, force: true })
  }
})

test("executables are found the way a shell finds them, .cmd shims included on Windows", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-desktop-path-"))
  try {
    writeFileSync(join(dir, "npx"), "")
    writeFileSync(join(dir, "npx.cmd"), "")
    if (process.platform !== "win32") assert.equal(findExecutable("npx", { PATH: `/nonexistent:${dir}` }, "linux"), join(dir, "npx"))
    assert.equal(findExecutable("npx", { Path: `C:\\missing;${dir}`, PATHEXT: ".COM;.EXE;.CMD" }, "win32"), join(dir, "npx.cmd"))
    assert.equal(findExecutable("node", { PATH: dir }, "linux"), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The launcher's non-TTY readout (src/readout.ts emitPlain/ready/fail), as a detached launch logs it.
const JOINED = [
  "frizz: ··· server — checking port 9393",
  "frizz: already running on port 9393",
  "frizz: local: http://127.0.0.1:9393/",
  "frizz: project: frizz — ~/frizz",
].join("\n")

test("the launcher's readout rows are read by label, newest last", () => {
  assert.equal(readoutValue(JOINED, "local"), "http://127.0.0.1:9393/")
  assert.equal(readoutValue(JOINED, "failed"), undefined)
  assert.equal(latestProgress("frizz: ··· installing — frizz-server 0.13.8\n"), "installing — frizz-server 0.13.8")
  assert.equal(latestProgress(""), undefined)
})

test("the launcher's refusal to open $HOME is recognised by its own wording", () => {
  // Pinned to the source rather than copied: if production.ts rewords the refusal, the folder picker
  // this drives would silently stop appearing, so the test reads the real text.
  const source = readFileSync(resolve(import.meta.dirname, "../../../src/production.ts"), "utf8")
  const home = /"(frizz cannot open your home directory[^"]+)"/u.exec(source)?.[1]
  assert.ok(home, "production.ts no longer carries the $HOME refusal this app recognises")
  assert.equal(needsProjectDirectory(home), true)
  assert.equal(needsProjectDirectory("port 9393 is in use"), false)
})

const posix = process.platform !== "win32"

/** A PATH holding a real `node` and a fake `npx` that answers --_frizz-print-launcher with `launcher`. */
function fakeToolchain(dir: string, launcherSource: string): NodeJS.ProcessEnv {
  const bin = join(dir, "bin")
  const launcher = join(dir, "launcher.mjs")
  writeFileSync(launcher, launcherSource)
  rmSync(bin, { recursive: true, force: true })
  mkdirSync(bin)
  symlinkSync(process.execPath, join(bin, "node"))
  writeFileSync(join(bin, "npx"), `#!/bin/sh\n[ "$3" = "--_frizz-print-launcher" ] && echo "${launcher}"\n`)
  chmodSync(join(bin, "npx"), 0o755)
  return { PATH: `${bin}:/usr/bin:/bin`, HOME: dir }
}

test("a launcher that exits refusing $HOME comes back as a request for a project folder", { skip: !posix }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-desktop-start-"))
  try {
    const env = fakeToolchain(dir, [
      `import { writeFileSync } from "node:fs"`,
      `writeFileSync(${JSON.stringify(join(dir, "argv.json"))}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }))`,
      `console.log("frizz: ··· workspace — resolving")`,
      // Exactly how the real one refuses: its own fail(), before any readout row (src/production.ts).
      `console.error("frizz: frizz cannot open your home directory as a project, and there is no other project to show yet. cd into a repository and run frizz there.")`,
      `process.exit(1)`,
    ].join("\n"))
    const progress: string[] = []
    const outcome = await startServer({
      env,
      cwd: dir,
      logPath: join(dir, "logs", "launcher.log"),
      onProgress: (line) => progress.push(line),
      locate: async () => undefined,
    })
    assert.equal(outcome.kind, "failed")
    assert.equal(outcome.kind === "failed" && outcome.needsProject, true)
    assert.match(outcome.kind === "failed" ? outcome.message : "", /^frizz cannot open your home directory/u)
    const launched = JSON.parse(readFileSync(join(dir, "argv.json"), "utf8"))
    assert.deepEqual(launched.argv, ["--no-app"])
    assert.equal(launched.cwd, dir)
    assert.ok(progress.includes("finding the frizz launcher"), progress.join(" | "))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a launcher that joins a server this app did not probe hands back its address", { skip: !posix }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-desktop-start-"))
  try {
    const env = fakeToolchain(dir, `console.log(${JSON.stringify(JOINED.replaceAll("9393", "4567"))})\n`)
    const outcome = await startServer({ env, cwd: dir, logPath: join(dir, "launcher.log"), locate: async () => undefined })
    assert.deepEqual(outcome, { kind: "ready", origin: "http://127.0.0.1:4567" })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a launcher that stays up is detached: it outlives the wait and is found by the record", { skip: !posix }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-desktop-start-"))
  const pidFile = join(dir, "pid")
  try {
    const env = fakeToolchain(dir, [
      `import { writeFileSync } from "node:fs"`,
      `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
      `console.log("frizz: ··· server — starting")`,
      `setInterval(() => {}, 1000)`,
    ].join("\n"))
    let polls = 0
    const outcome = await startServer({
      env,
      cwd: dir,
      logPath: join(dir, "launcher.log"),
      // The record appears once the launcher has written its pid, as the real one does once it listens.
      locate: async () => { polls++; try { readFileSync(pidFile); return "http://127.0.0.1:5555" } catch { return undefined } },
    })
    assert.deepEqual(outcome, { kind: "ready", origin: "http://127.0.0.1:5555" })
    const pid = Number(readFileSync(pidFile, "utf8"))
    // Still running after startServer returned, in its OWN process group (detached) — so quitting the
    // app, which signals the app's group, cannot take the server with it.
    assert.doesNotThrow(() => process.kill(pid, 0))
    assert.doesNotThrow(() => process.kill(-pid, 0))
    process.kill(-pid, "SIGKILL")
    assert.ok(polls >= 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a launcher that stays up is found by its own ready row, wherever it settled", { skip: !posix }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-desktop-start-"))
  let pid = 0
  try {
    // A real listener on an arbitrary port, announced the way the real launcher's non-TTY readout
    // does — the case where the record lives where this app did not look (a login shell's XDG root).
    const env = fakeToolchain(dir, [
      `import { createServer } from "node:http"`,
      `const server = createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: true, bootId: "b" })) })`,
      `server.listen(0, "127.0.0.1", () => {`,
      `  console.log("frizz: ready in 1.2s")`,
      `  console.log("frizz: local: http://127.0.0.1:" + server.address().port + "/")`,
      `})`,
    ].join("\n"))
    const outcome = await startServer({ env, cwd: dir, logPath: join(dir, "launcher.log"), locate: async () => undefined })
    assert.equal(outcome.kind, "ready")
    const port = outcome.kind === "ready" ? Number(new URL(outcome.origin).port) : 0
    assert.ok(port > 0)
    pid = Number(execFileSync("sh", ["-c", `ps -eo pid,args | grep "${join(dir, "launcher.mjs")}" | grep -v grep | awk '{print $1}'`], { encoding: "utf8" }).trim().split("\n")[0])
  } finally {
    if (pid) try { process.kill(-pid, "SIGKILL") } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
})

test("no node on PATH fails with the requirement, not a spawn error", async () => {
  const outcome = await startServer({ env: { PATH: "/nonexistent" }, cwd: tmpdir(), logPath: join(tmpdir(), "unused.log") })
  assert.equal(outcome.kind, "failed")
  assert.match(outcome.kind === "failed" ? outcome.message : "", /Node\.js 22\.13 or newer/u)
})
