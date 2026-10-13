// FINDING NTWINE from an editor window, with nothing configured. Ntwine is one server per machine, and
// it leaves records of where it listens in its own data and state roots; this reads them in the order
// that gets the PUBLIC origin — the one the human's tab is on — whenever one exists:
//
//   1. `ntwine.serverUrl`, when the human set it. Nothing else is consulted.
//   2. `<state>/ntwine-server/address.json` — the published launcher's address record, naming the port it
//      serves. Trusted the way the launcher trusts it (src/server-owner.ts `readStableServerOwner`):
//      the machine-wide owner record beside it must name the same token, pid and process start, and that
//      process generation must still be alive. The record outlives a crash, and by then its port can be
//      anyone's — a `ntwine --sandbox` takes the next free well-known port, another account any port.
//   3. The well-known ports (9393, 19393, 9494, 19494), accepted only with the launch-token proof
//      (`ownedNtwine` below): loopback is shared with every other account on the machine and with a
//      `ntwine --sandbox`, so answering proves nothing.
//   4. `<data>/projects/<id>/dev-supervisor.lock` — `ntwine-dev`'s public port when it is not on a
//      well-known one. Ours by construction (it is in our own data root), so liveness is enough.
//   5. `<data>/server.lock` — written by every launch mode, only while the pid that wrote it is alive.
//      Behind the restart supervisor its port is the control plane's PRIVATE listener: RPC and the editor
//      socket work there, but a page opened on it is a different origin (its own storage, and a port
//      that moves on every restart). Without a supervisor (a bare `startServer`) it IS the public port.
//      Last for the first reason. The steps above win whenever a supervisor is up, so pages land here
//      only in narrow windows — a supervisor that died under a live child, or an Ntwine on a port outside
//      the well-known set with no address record — and the extension logs which kind of address a page
//      was opened on (app.ts `openUrl`) instead of refusing to open one.
//
// Every address is `http://127.0.0.1:<port>`, never `localhost`: the server's origin gate compares
// hostnames exactly, and `localhost` is a different origin to the browser as well.
//
// Pure node — no `vscode` import — so the unit tests run it against fixture roots and a real listener.

import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, realpathSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { ntwinePathsNow, type NtwinePaths } from "@ntwine/server/ntwine-paths"

/** `DEFAULT_PORT`, its fallback, `DEFAULT_DEV_PORT`, its fallback (packages/shared `fallbackPort` = +10 000). */
export const WELL_KNOWN_PORTS: readonly number[] = [9393, 19393, 9494, 19494]

export type DiscoverySource = "setting" | "owner-record" | "well-known-port" | "dev-supervisor" | "server-lock"

/** Where an address came from, for the log. */
export const SOURCE_WORDS: Record<DiscoverySource, string> = {
  setting: "the ntwine.serverUrl setting",
  "owner-record": "the launcher's address record",
  "well-known-port": "its well-known port",
  "dev-supervisor": "ntwine-dev's address record",
  "server-lock": "the server's own lock file",
}

/**
 * What kind of address a page is being opened on, for the log line beside it. Every source but the
 * lock file names the port the human's own tab is on. The lock file's is that port only when Ntwine runs
 * without its restart supervisor; behind one it is the control plane's private port, where a tab keeps
 * drafts of its own and stops answering on the next restart — the log says so, so a tab that went dead
 * has its explanation one command away.
 */
export function pageAddressNote(source: DiscoverySource): { level: "info" | "warn"; note: string } {
  if (source !== "server-lock") return { level: "info", note: `a public address, from ${SOURCE_WORDS[source]}` }
  return {
    level: "warn",
    note: "an address from the server's own lock file, found because no public one was. It is Ntwine's page address only when Ntwine runs without its restart supervisor; otherwise the tab keeps separate drafts and stops working when Ntwine restarts. Set ntwine.serverUrl to Ntwine's page address to pin it",
  }
}

export interface FoundNtwine {
  origin: string
  port: number
  source: DiscoverySource
}

export interface DiscoveryResult {
  found?: FoundNtwine
  /** One line per place looked, for the log: what was there and why it was or was not taken. */
  notes: string[]
}

export interface DiscoveryOptions {
  /** The `ntwine.serverUrl` setting; empty means find it. */
  serverUrl?: string
  roots?: Pick<NtwinePaths, "data" | "state"> & Partial<Pick<NtwinePaths, "brand">>
  ports?: readonly number[]
  timeoutMs?: number
  pidAlive?: (pid: number) => boolean
  /** A live process's start marker, in the server's tagged format; injectable for tests. */
  observeGeneration?: (pid: number) => Promise<string | undefined>
}

export interface NtwineHealth {
  ok: true
  bootId: string
  projectId?: string
  projectDir?: string
  ownerProof?: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

export function loopbackOrigin(port: number): string {
  return `http://127.0.0.1:${port}`
}

/**
 * The origin a `ntwine.serverUrl` value names, or undefined when it names none. A bare port and a
 * `host:port` are accepted, and a loopback name is spelled `127.0.0.1` whatever the human typed.
 */
export function originFromSetting(raw: string): string | undefined {
  const value = raw.trim()
  if (!value) return undefined
  const spelled = /^\d+$/u.test(value) ? `http://127.0.0.1:${value}` : /^[a-z][a-z0-9+.-]*:\/\//iu.test(value) ? value : `http://${value}`
  let url: URL
  try {
    url = new URL(spelled)
  } catch {
    return undefined
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
  if (LOOPBACK_NAMES.has(url.hostname)) url.hostname = "127.0.0.1"
  return url.origin
}

export async function readHealth(origin: string, timeoutMs = 1_000): Promise<NtwineHealth | undefined> {
  try {
    const response = await fetch(`${origin}/_ntwine/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return undefined
    const health = (await response.json()) as Partial<NtwineHealth>
    return health.ok === true && typeof health.bootId === "string" ? (health as NtwineHealth) : undefined
  } catch {
    return undefined
  }
}

/**
 * The launch-token proof an Ntwine's health carries: sha256 over a fixed tag, the launching project's id
 * and folder, and the owner token from `<data>/projects/<id>/project-launch.owner`. Reimplemented, not
 * imported — `@ntwine/server/project-launch` drags process bookkeeping into the bundle — and pinned
 * byte-for-byte to `projectLaunchTokenProof` by discovery.test.ts.
 */
export function launchTokenProof(projectId: string, projectDir: string, token: string): string {
  return createHash("sha256")
    .update("frizz-project-launch-v2\0")
    .update(projectId)
    .update("\0")
    .update(projectDir)
    .update("\0")
    .update(token)
    .digest("hex")
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"))
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function validPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535
}

export function defaultPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: alive, and owned by someone else — still a live writer of the record.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Whether the Ntwine on this port is the one THIS user launched from these roots. The health answer
 * names the launching project; its owner record sits in our data root, readable by nobody else, and
 * the proof in the answer must be the hash of the token in it.
 */
export async function ownedNtwine(port: number, data: string, timeoutMs = 1_000): Promise<boolean> {
  const health = await readHealth(loopbackOrigin(port), timeoutMs)
  if (!health || typeof health.projectId !== "string" || typeof health.projectDir !== "string" || typeof health.ownerProof !== "string") return false
  // The id becomes a path segment below; a hostile listener must not be able to aim it elsewhere.
  if (!UUID_RE.test(health.projectId)) return false
  const owner = readJson(join(data, "projects", health.projectId, "project-launch.owner"))
  if (!owner || typeof owner.token !== "string" || !UUID_RE.test(owner.token)) return false
  if (owner.projectId !== health.projectId || owner.projectDir !== health.projectDir) return false
  return launchTokenProof(health.projectId, health.projectDir, owner.token) === health.ownerProof
}

// ── the published launcher's address record ──────────────────────────────────────────────────────────
//
// `readStableServerOwner` (src/server-owner.ts) REPLICATED, not imported. It bundles (14 KB, nothing
// native), but three things it does are wrong in an editor's extension host, which runs every
// extension on one thread: its module load observes the current process's generation, which on
// Windows is a synchronous PowerShell spawn (250-430ms, process-generation.ts) during activation; its
// staleness check spawns PowerShell synchronously again on every discovery that finds a live pid; and
// `stableServerOwnerTarget` creates Ntwine's data folder — a read that writes, on a machine where the
// extension is installed and Ntwine is not. Here the same verdict is reached with async spawns and no
// writes, and discovery.test.ts runs both readers over the same fixture files, written by the server's
// own writer, so the two cannot drift apart silently.

/** `STABLE_SERVER_OWNER_PROJECT_ID`: the fixed id of the one machine-wide server target, never a repository's. */
const STABLE_SERVER_OWNER_ID = "c1fd5810-0f8a-4c1d-91a0-6d7445d28e5a"
/** server-owner.ts `stableServerOwnerName`: a Frizz-era install keeps its `frizz-server` lease. */
function stableServerDir(roots: { brand?: NtwinePaths["brand"] }): string {
  return roots.brand === "frizz" ? "frizz-server" : "ntwine-server"
}
const GENERATION_TAG_RE = /^(?:linux|ps-utc|win32|opaque):/u

export type OwnerAddressRead = { kind: "running"; port: number } | { kind: "not-running"; why: string }

interface Generation {
  pid: number
  processStart: string
}

function validText(value: unknown, max = 4096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\0\r\n]/u.test(value)
}

/** project-launch.ts `parseOwner`, down to the fields the verdict reads. */
function readOwner(path: string): (Generation & { token: string; projectId: string; projectDir: string }) | undefined {
  const value = readJson(path)
  if (!value) return undefined
  const { pid, processStart, token, projectId, projectDir } = value
  if (
    (value.version !== 1 && value.version !== 2) ||
    typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || !validText(processStart, 128) ||
    typeof token !== "string" || !UUID_RE.test(token) ||
    typeof projectId !== "string" || !UUID_RE.test(projectId) ||
    !validText(projectDir) || !isAbsolute(projectDir) ||
    (value.role !== "launcher" && value.role !== "supervisor" && value.role !== "server") ||
    !validText(value.acquiredAt, 128) || !validText(value.updatedAt, 128) ||
    (value.version === 2 && ((value.state !== "active" && value.state !== "draining") || !Array.isArray(value.delegates) || value.delegates.length > 64))
  ) return undefined
  return { pid, processStart, token, projectId, projectDir }
}

/** server-owner.ts `readAddress`. */
function readAddress(path: string): (Generation & { ownerToken: string; port: number }) | undefined {
  const value = readJson(path)
  if (!value) return undefined
  const { ownerToken, publisherToken, pid, processStart, port } = value
  if (
    value.version !== 1 ||
    typeof ownerToken !== "string" || !UUID_RE.test(ownerToken) ||
    typeof publisherToken !== "string" || !UUID_RE.test(publisherToken) ||
    typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 ||
    typeof processStart !== "string" || processStart.length === 0 ||
    !validPort(port)
  ) return undefined
  return { ownerToken, pid, processStart, port }
}

function linuxGeneration(pid: number): string | undefined {
  try {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().toLowerCase()
    if (!/^[0-9a-f-]{36}$/u.test(bootId)) return undefined
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8").trim()
    const suffixAt = stat.lastIndexOf(") ")
    if (suffixAt < 0) return undefined
    const startTicks = stat.slice(suffixAt + 2).trim().split(/\s+/u)[19]
    return startTicks && /^\d+$/u.test(startTicks) ? `linux:${bootId}:${startTicks}` : undefined
  } catch {
    return undefined
  }
}

function run(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: "utf8", timeout: 5_000, windowsHide: true, ...(env ? { env } : {}) }, (error, stdout) => resolve(error ? undefined : stdout.trim()))
  })
}

export async function psGeneration(pid: number): Promise<string | undefined> {
  const value = (await run("ps", ["-o", "lstart=", "-p", String(pid)], { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC0" }))?.replace(/\s+/gu, " ")
  return value && value.length <= 128 && !/[\0\r\n]/u.test(value) ? `ps-utc:${value}` : undefined
}

async function windowsGeneration(pid: number): Promise<string | undefined> {
  const shell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  const value = await run(shell, [
    "-NoProfile", "-NonInteractive", "-NoLogo", "-Command",
    `try{[Console]::Out.Write((Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc())}catch{exit 1}`,
  ])
  return value && /^\d{1,20}$/u.test(value) ? `win32:${value}` : undefined
}

/** process-generation.ts `observeDefault`, asynchronously: the marker a live pid has now, or undefined. */
export async function observeGeneration(pid: number): Promise<string | undefined> {
  if (process.platform === "linux") return linuxGeneration(pid) ?? (await psGeneration(pid))
  if (process.platform === "darwin") return psGeneration(pid)
  if (process.platform === "win32") return windowsGeneration(pid)
  return undefined
}

/**
 * process-generation.ts `processGenerationIsStale`: dead, or alive as a DIFFERENT process (the pid was
 * reused). A marker that cannot be compared — opaque, a legacy format, a platform that cannot observe —
 * is not stale, exactly as the server retains such an owner rather than stealing from it.
 */
async function generationIsStale(generation: Generation, pidAlive: (pid: number) => boolean, observe: (pid: number) => Promise<string | undefined>): Promise<boolean> {
  if (!pidAlive(generation.pid)) return true
  if (generation.processStart.startsWith("opaque:") || !GENERATION_TAG_RE.test(generation.processStart)) return false
  const observed = await observe(generation.pid)
  if (!observed) return false
  if (observed.split(":", 1)[0] !== generation.processStart.split(":", 1)[0]) return false
  return observed !== generation.processStart
}

/** The port the published launcher serves, when its address record is backed by a live owner generation. */
export async function readOwnerAddress(
  roots: Pick<NtwinePaths, "data" | "state"> & Partial<Pick<NtwinePaths, "brand">>,
  pidAlive: (pid: number) => boolean = defaultPidAlive,
  observe: (pid: number) => Promise<string | undefined> = observeGeneration,
): Promise<OwnerAddressRead> {
  let dataDir: string
  try {
    dataDir = realpathSync(roots.data)
  } catch {
    return { kind: "not-running", why: "no Ntwine data folder" }
  }
  const stateDir = join(roots.state, stableServerDir(roots))
  const owner = readOwner(join(stateDir, "project-launch.owner"))
  if (!owner || owner.projectId !== STABLE_SERVER_OWNER_ID || owner.projectDir !== dataDir) return { kind: "not-running", why: "no owner record behind it" }
  if (await generationIsStale(owner, pidAlive, observe)) return { kind: "not-running", why: `its owner, pid ${owner.pid}, is gone` }
  const address = readAddress(join(stateDir, "address.json"))
  if (!address) return { kind: "not-running", why: "none" }
  if (address.ownerToken !== owner.token || address.pid !== owner.pid || address.processStart !== owner.processStart) {
    return { kind: "not-running", why: `port ${address.port} was written by another owner than the live one` }
  }
  return { kind: "running", port: address.port }
}

/** Find the running Ntwine. Asked again before every connection attempt: the port can move. */
export async function discoverNtwine(options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const notes: string[] = []
  const timeoutMs = options.timeoutMs ?? 1_000
  const pidAlive = options.pidAlive ?? defaultPidAlive

  if (options.serverUrl?.trim()) {
    const origin = originFromSetting(options.serverUrl)
    if (!origin) {
      notes.push(`ntwine.serverUrl "${options.serverUrl}" is not an http address`)
      return { notes }
    }
    notes.push(`ntwine.serverUrl: ${origin}`)
    return { found: { origin, port: Number(new URL(origin).port || (origin.startsWith("https:") ? 443 : 80)), source: "setting" }, notes }
  }

  // Resolved afresh per discovery, never memoised: this host lives for days and owns no Ntwine data,
  // and the server it looks for may have started on other roots than this process would have frozen
  // (ntwine-paths.ts `ntwinePathsNow`).
  const roots = options.roots ?? ntwinePathsNow()

  const addressPath = join(roots.state, stableServerDir(roots), "address.json")
  const owner = await readOwnerAddress(roots, pidAlive, options.observeGeneration ?? observeGeneration)
  if (owner.kind === "running") {
    if (await readHealth(loopbackOrigin(owner.port), timeoutMs)) {
      notes.push(`${addressPath}: port ${owner.port} answers`)
      return { found: { origin: loopbackOrigin(owner.port), port: owner.port, source: "owner-record" }, notes }
    }
    notes.push(`${addressPath}: port ${owner.port} does not answer (Ntwine may be starting)`)
  } else {
    notes.push(`${addressPath}: ${owner.why}`)
  }

  const ports = options.ports ?? WELL_KNOWN_PORTS
  // In parallel — a closed port refuses at once, and an open one owes us its answer within the timeout —
  // then taken in the listed order, so the result never depends on which reply came back first.
  const owned = await Promise.all(ports.map((port) => ownedNtwine(port, roots.data, timeoutMs)))
  const ownedPort = ports.find((_, i) => owned[i])
  if (ownedPort !== undefined) {
    notes.push(`port ${ownedPort} answers with this user's launch token`)
    return { found: { origin: loopbackOrigin(ownedPort), port: ownedPort, source: "well-known-port" }, notes }
  }
  notes.push(`ports ${ports.join(", ")}: no Ntwine of this user's`)

  const lockPath = join(roots.data, "server.lock")
  const lock = readJson(lockPath)
  if (!lock || !validPort(lock.port) || typeof lock.pid !== "number") {
    notes.push(`${lockPath}: none`)
    return { notes }
  }
  if (!pidAlive(lock.pid)) {
    notes.push(`${lockPath}: written by pid ${lock.pid}, which is gone`)
    return { notes }
  }

  if (typeof lock.projectId === "string" && UUID_RE.test(lock.projectId)) {
    const devPath = join(roots.data, "projects", lock.projectId, "dev-supervisor.lock")
    const dev = readJson(devPath)
    if (dev && validPort(dev.port) && typeof dev.pid === "number" && pidAlive(dev.pid) && await readHealth(loopbackOrigin(dev.port), timeoutMs)) {
      notes.push(`${devPath}: port ${dev.port} answers`)
      return { found: { origin: loopbackOrigin(dev.port), port: dev.port, source: "dev-supervisor" }, notes }
    }
  }

  if (await readHealth(loopbackOrigin(lock.port), timeoutMs)) {
    notes.push(`${lockPath}: port ${lock.port} answers (the control plane's own port)`)
    return { found: { origin: loopbackOrigin(lock.port), port: lock.port, source: "server-lock" }, notes }
  }
  notes.push(`${lockPath}: port ${lock.port} does not answer`)
  return { notes }
}
