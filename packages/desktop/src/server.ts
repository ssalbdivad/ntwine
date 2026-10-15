import { readFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_DEV_PORT, DEFAULT_PORT, fallbackPort } from "@ntwine/shared"
import { ntwinePathsNow, type NtwinePaths } from "@ntwine/server/ntwine-paths"
import { projectLaunchTokenProof, readProjectLaunchOwner } from "@ntwine/server/project-launch"
import { readStableServerOwner, STABLE_SERVER_OWNER_NAME, type ServerOwnerRead } from "../../../src/server-owner.ts"

/**
 * Finding the ONE ntwine server on this machine. The window is a client of it exactly as a browser tab
 * is; when none answers it starts the launcher in its own process (launch.ts), never inside Electron,
 * whose embedded Node could not host the server anyway — node-pty is built for the system Node.
 */

export interface LocateOptions {
  roots?: Pick<NtwinePaths, "data" | "state">
  readOwner?: () => ServerOwnerRead
  healthy?: (port: number) => Promise<boolean>
  owned?: (port: number) => Promise<boolean>
}

interface NtwineHealth {
  ok?: unknown
  bootId?: unknown
  projectId?: unknown
  projectDir?: unknown
  ownerProof?: unknown
}

async function readHealth(port: number, timeoutMs: number): Promise<NtwineHealth | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/_ntwine/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return undefined
    const health = (await response.json()) as NtwineHealth
    return health.ok === true && typeof health.bootId === "string" ? health : undefined
  } catch {
    return undefined
  }
}

/** An ntwine answering on this loopback port, by the launcher's own health handshake. */
export async function ntwineAnswers(port: number, timeoutMs = 1_500): Promise<boolean> {
  return (await readHealth(port, timeoutMs)) !== undefined
}

/**
 * An ntwine on this port that THIS USER launched, from these roots.
 *
 * Loopback is shared by every account on the machine, and by an `ntwine --sandbox`, so answering the
 * health handshake proves only that some ntwine is there. What proves it is ours is the launch token:
 * the server's health carries a hash of the token in its project's owner record, and that record lives
 * in our own data root, readable by nobody else — the same proof `ntwine --stop` checks.
 */
export async function ownedNtwine(port: number, roots: Pick<NtwinePaths, "data"> = ntwinePathsNow(), timeoutMs = 1_500): Promise<boolean> {
  const health = await readHealth(port, timeoutMs)
  if (!health || typeof health.projectId !== "string" || typeof health.projectDir !== "string") return false
  if (typeof health.ownerProof !== "string" || !/^[0-9a-f-]{36}$/iu.test(health.projectId)) return false
  const stateDir = join(roots.data, "projects", health.projectId)
  const owner = readProjectLaunchOwner(stateDir)
  if (!owner || owner.projectId !== health.projectId || owner.projectDir !== health.projectDir) return false
  return projectLaunchTokenProof({ projectId: health.projectId, projectDir: health.projectDir, stateDir }, owner.token) === health.ownerProof
}

/**
 * The origin of the board to show, or undefined when none of ours is up.
 *
 * The well-known ports come FIRST, because this is a dev-loop window: `nub run dev` writes no owner
 * record, and when a published `ntwine` runs beside it the HMR board is the one being worked on. A
 * board found by port is joined only if it proves it is ours (`ownedNtwine`), since a port answers for
 * whoever holds it. The published launcher's owner record is the fallback.
 */
export async function locateServer(options: LocateOptions = {}): Promise<string | undefined> {
  // Afresh per search, never memoised: the server resolved its roots at ITS boot.
  const roots = options.roots ?? ntwinePathsNow()
  const readOwner = options.readOwner ?? (() => readStableServerOwner(roots))
  const healthy = options.healthy ?? ((port: number) => ntwineAnswers(port))
  const owned = options.owned ?? ((port: number) => ownedNtwine(port, roots))
  for (const port of new Set([DEFAULT_PORT, fallbackPort(DEFAULT_PORT), DEFAULT_DEV_PORT, fallbackPort(DEFAULT_DEV_PORT)])) {
    if (await owned(port)) return loopbackOrigin(port)
  }
  const owner = readOwner()
  if (owner.kind === "running" && await healthy(owner.port)) return loopbackOrigin(owner.port)
  return undefined
}

export function loopbackOrigin(port: number): string {
  return `http://127.0.0.1:${port}`
}

/**
 * The launcher's record as a Windows window reads it, through `\\wsl.localhost` roots: the port the
 * stable server published, if its address names the owner's current generation. This skips the check
 * readStableServerOwner makes that the owner's process is alive, which reads /proc and so cannot run
 * from Windows; the health probe locateServer makes next is the liveness check instead.
 */
export function readRecordedServer(roots: Pick<NtwinePaths, "state">): ServerOwnerRead {
  const stateDir = join(roots.state, STABLE_SERVER_OWNER_NAME)
  const owner = readProjectLaunchOwner(stateDir)
  if (!owner) return { kind: "idle" }
  try {
    const address = JSON.parse(readFileSync(join(stateDir, "address.json"), "utf8")) as { ownerToken?: unknown; port?: unknown }
    if (address.ownerToken === owner.token && typeof address.port === "number") return { kind: "running", port: address.port, owner }
  } catch {
    // No address yet: the launcher is still starting it.
  }
  return { kind: "busy", owner }
}
