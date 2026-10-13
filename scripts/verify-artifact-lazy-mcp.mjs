// END-TO-END proof, on a PROMOTED ARTIFACT, that a Claude worker's stdio MCP servers start on first
// use and not at boot (packages/server/src/backend/lazy-mcp-host.ts).
//
// The host lives in the broker daemon, which a promoted artifact runs as its own bundled file — so a
// source-run stack proves nothing about whether the bundle carries it. This builds a REAL artifact,
// boots the real server from it, and drives real Claude workers in a project whose `.mcp.json` brings
// chrome-devtools (this repo's own), asserting on the process table:
//
//   1. the first worker of a configuration starts the server at the handshake (nothing cached yet)
//      and leaves a cache behind;
//   2. the second worker starts NOTHING at boot — its config mounts the server as loopback http;
//   3. asking that worker for a chrome-devtools tool starts the server, under the broker daemon, and
//      the tool answers.
//
// Isolation: temp HOME with the real ~/.claude linked in (a dispatch needs credentials), temp project
// and state dir, unique port, wakers and reaper off. Uses haiku.
//
//   nub scripts/verify-artifact-lazy-mcp.mjs
import { execFileSync, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { buildFrizzArtifact } from "../src/artifacts.ts"
import { frizzPaths } from "../packages/server/src/frizz-paths.ts"
import { acquireProjectLaunchOwner, projectLaunchEnvironment } from "../packages/server/src/project-launch.ts"
import { createRpcClient } from "./lib/rpc-client.mjs"

const SOURCE = resolve(import.meta.dirname, "..")
const PORT = Number(process.env.VERIFY_PORT ?? 4947)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log("[verify]", ...a)
let failures = 0
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

const realHome = homedir()
const root = realpathSync(mkdtempSync(join(tmpdir(), "frizz-verify-lazy-mcp-")))
const home = join(root, "home")
mkdirSync(join(home, ".frizz"), { recursive: true })
for (const name of [".claude", ".claude.json"]) symlinkSync(join(realHome, name), join(home, name))
const PROJECT_DIR = join(root, "project")
mkdirSync(join(PROJECT_DIR, ".claude"), { recursive: true })
execFileSync("git", ["init", "-q"], { cwd: PROJECT_DIR })
writeFileSync(join(PROJECT_DIR, "README.md"), "# verify fixture\n")
// This repo's own server, by absolute path: its `.mcp.json` names the wrapper relative to the repo root,
// and this fixture project has no `scripts/`.
writeFileSync(join(PROJECT_DIR, ".mcp.json"), JSON.stringify({ mcpServers: { "chrome-devtools": { command: "node", args: [join(SOURCE, "scripts", "chrome-devtools-mcp.mjs")] } } }))
writeFileSync(join(PROJECT_DIR, ".claude", "settings.json"), JSON.stringify({ enabledMcpjsonServers: ["chrome-devtools"] }))
const stateDir = join(root, "state")
mkdirSync(stateDir, { recursive: true })
const api = createRpcClient(`http://127.0.0.1:${PORT}/`)
let child
let release

/** Every process below `pid`, as `{ pid, command }`. */
function descendants(pid) {
  const out = []
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n")
  const table = rows.map((row) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(row)).filter(Boolean).map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }))
  const walk = (parent) => { for (const row of table) if (row.ppid === parent) { out.push(row); walk(row.pid) } }
  walk(pid)
  return out
}

/** The broker daemon for `sessionId`, from the record it publishes. */
function brokerPid(sessionId) {
  const dir = join(stateDir, "claude-broker")
  for (const file of existsSync(dir) ? readdirSync(dir) : []) {
    if (!file.endsWith(".json")) continue
    try {
      const record = JSON.parse(readFileSync(join(dir, file), "utf8"))
      if (record.sessionId === sessionId && record.daemonPid) return record.daemonPid
    } catch {}
  }
  return undefined
}

const browserServers = (sessionId) => descendants(brokerPid(sessionId) ?? -1).filter((row) => /^chrome-devtools-mcp\b/.test(row.command))

// A marker must never appear in the prompt that asks for it: the transcript carries the prompt too, so
// a literal marker "arrives" the moment the prompt is recorded. Each one is asked for as two words and
// awaited joined.
const ask = (first, second) => `Reply with the word ${first} and the word ${second} joined by one hyphen, and nothing else.`

async function waitForReply(slug, marker, ms) {
  for (let i = 0; i < Math.ceil(ms / 2000); i++) {
    const transcript = JSON.stringify(await api.query("threadTranscript", { slug }).catch(() => ""))
    if (transcript.includes(marker)) return transcript
    await sleep(2000)
  }
  return undefined
}

try {
  log("building a real artifact from", SOURCE)
  const artifact = buildFrizzArtifact(SOURCE, join(root, "artifacts"))
  check(existsSync(join(artifact.runtimeDir, "src", "claude-agent-broker.js")), "the artifact ships the bundled broker daemon")
  const bundled = readFileSync(join(artifact.runtimeDir, "src", "claude-agent-broker.js"), "utf8")
  check(bundled.includes("server/discover") && bundled.includes("frizz-lazy-"), "the bundled broker daemon carries the lazy MCP host")

  const projectId = randomUUID()
  const target = { projectId, projectDir: PROJECT_DIR, stateDir }
  const owner = acquireProjectLaunchOwner(target, "launcher")
  release = owner.release
  // This harness is usually run from INSIDE a frizz worker: its FRIZZ_* control-plane variables would
  // point the artifact at the live server instead of this one.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("FRIZZ_")))
  let output = ""
  child = spawn(process.execPath, [join(artifact.runtimeDir, "src", "index.js")], {
    cwd: PROJECT_DIR,
    env: projectLaunchEnvironment({
      ...inherited,
      HOME: home,
      FRIZZ_RUNTIMES_DIR: join(frizzPaths({ home: realHome }).cache, "runtimes"),
      FRIZZ_DEV_CHILD: "1",
      FRIZZ_DEV_PORT: String(PORT),
      FRIZZ_WAKERS_OFF: "1",
      FRIZZ_ORPHAN_REAPER_OFF: "1",
      FRIZZ_TENANT_PRIME_OFF: "1",
      FRIZZ_SANDBOX_TAG: `frizz-verify-${PORT}-${process.pid}`,
      FRIZZ_STABLE_ARTIFACT: artifact.digest,
      FRIZZ_STABLE_WEB_DIST: artifact.webDir,
      FRIZZ_SCRIPTS_DIR: join(artifact.runtimeDir, "board"),
      FRIZZ_WORKER_PLUGIN_DIR: join(artifact.runtimeDir, "cc-worker"),
    }, target, owner.token),
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout.on("data", (c) => { output += c })
  child.stderr.on("data", (c) => { output += c })
  const healthy = await api.waitForHealth(60_000)
  check(healthy, "the artifact server booted", `port ${PORT}`)
  if (!healthy) throw new Error(`server never came up:\n${output.slice(-4000)}`)

  // 1. The first worker of this configuration: nothing cached, so the handshake starts the server.
  const first = await api.mutate("dispatch", { prompt: `${ask("FIRST", "DONE")} Do not use any tools.`, backend: "claude", model: "haiku" })
  check(!!(await waitForReply(first.slug, "FIRST-DONE", 120_000)), "the first worker answered")
  const cacheDir = join(home, ".frizz", "mcp-cache")
  const cached = existsSync(cacheDir) ? readdirSync(cacheDir).filter((f) => f.endsWith(".json")) : []
  check(cached.length === 1, "the first worker left a cache for the configuration", cached.join(","))
  check(browserServers(first.sessionId).length === 1, "the first worker's server runs under its broker daemon (started for the cache)")

  // 2. The second worker: everything it needs at boot comes from the cache.
  const second = await api.mutate("dispatch", { prompt: `${ask("SECOND", "DONE")} Do not use any tools.`, backend: "claude", model: "haiku" })
  check(!!(await waitForReply(second.slug, "SECOND-DONE", 120_000)), "the second worker answered")
  await sleep(3000)
  const idle = browserServers(second.sessionId)
  check(brokerPid(second.sessionId) !== undefined, "the second worker's broker daemon is live")
  check(idle.length === 0, "the second worker started NO chrome-devtools server at boot", idle.map((r) => r.pid).join(","))
  // The CLI reads its --mcp-config once; the factory deletes the file after init, so it carries no tokens
  // at rest — and everything below, the tool call included, runs without it.
  const claudeArgv = descendants(brokerPid(second.sessionId) ?? -1).find((row) => row.command.includes("--mcp-config"))?.command ?? ""
  const configPath = /--mcp-config (\S+)/.exec(claudeArgv)?.[1]
  check(!!configPath && !configPath.startsWith("{"), "the worker's CLI was handed a config FILE", configPath ?? "(none)")
  check(!!configPath && !existsSync(configPath), "that file is gone once the session initialized")

  // 3. A tool call starts it, and the tool answers.
  await api.mutate("followUp", {
    slug: second.slug, sessionId: second.sessionId, deliveryId: randomUUID(),
    message: "Call mcp__chrome-devtools__new_page with url about:blank, then mcp__chrome-devtools__list_pages. Then reply with the word LISTED and the word DONE joined by one hyphen, followed by the list_pages output.",
  })
  const listed = await waitForReply(second.slug, "LISTED-DONE", 180_000)
  // "## Pages" is list_pages' own heading — text the prompt does not contain.
  check(!!listed && listed.includes("## Pages"), "the chrome-devtools tools answered through the lazy host")
  check(browserServers(second.sessionId).length === 1, "the tool call started exactly one server, under the second worker's broker daemon")
  const diagnostics = join(stateDir, "claude-broker", `${second.sessionId}.diagnostics.log`)
  const starts = existsSync(diagnostics) ? readFileSync(diagnostics, "utf8").match(/\[lazy-mcp\][^"]*/g) ?? [] : []
  check(starts.length === 1 && /for tools\/call/.test(starts[0]), "the daemon logged one start, for tools/call", starts.join(" | "))
} catch (error) {
  check(false, "harness completed without throwing", String(error?.stack ?? error?.message ?? error))
} finally {
  // Kill only what THIS run forked: the daemons named in its own records, then the server.
  const dir = join(stateDir, "claude-broker")
  for (const file of existsSync(dir) ? readdirSync(dir) : []) {
    if (!file.endsWith(".json")) continue
    try { const pid = JSON.parse(readFileSync(join(dir, file), "utf8")).daemonPid; if (pid) process.kill(pid, "SIGTERM") } catch {}
  }
  if (child?.pid) { try { process.kill(child.pid, "SIGTERM") } catch {} }
  await sleep(3000)
  if (child?.pid) { try { process.kill(child.pid, "SIGKILL") } catch {} }
  try { release?.() } catch {}
  rmSync(root, { recursive: true, force: true })
  // Claude Code keys its transcript dir on the project path, which lived under `root`.
  try { rmSync(join(realHome, ".claude", "projects", PROJECT_DIR.replace(/[^A-Za-z0-9]/g, "-")), { recursive: true, force: true }) } catch {}
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
