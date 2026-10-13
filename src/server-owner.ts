import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { ntwinePaths, type NtwinePaths } from "@ntwine/server/ntwine-paths"
import {
  processGenerationIsStale,
  readProjectLaunchOwner,
  removeProjectStatus,
  tryAcquireProjectLaunchOwner,
  writeProjectStatus,
  type ProjectLaunchLease,
  type ProjectLaunchOwnerRecord,
  type ProjectLaunchTarget,
} from "@ntwine/server/project-launch"

/** Human-facing name for the machine-wide server lease. */
export const STABLE_SERVER_OWNER_NAME = "ntwine-server"

/**
 * The lease directory's name on these roots. A Frizz-era install (ntwine-paths.ts `brand`) keeps the
 * `frizz-server` it already has, so a server started before the rename and one started after it
 * contend for ONE lease rather than each finding its own empty one and both serving the same data.
 */
export function stableServerOwnerName(roots: { brand?: NtwinePaths["brand"] }): string {
  return roots.brand === "frizz" ? "frizz-server" : STABLE_SERVER_OWNER_NAME
}
// Project-launch ownership deliberately requires a UUID to reject malformed/cross-project records.
// This is the fixed UUID envelope for the one logical `ntwine-server` target, never a repository id.
export const STABLE_SERVER_OWNER_PROJECT_ID = "c1fd5810-0f8a-4c1d-91a0-6d7445d28e5a"
const ADDRESS_NAME = "address.json"
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

type ServerOwnerRoots = Pick<NtwinePaths, "data" | "state"> & Partial<Pick<NtwinePaths, "brand">>

export interface ServerOwnerLease {
  readonly target: ProjectLaunchTarget
  readonly token: string
  readonly pid: number
  readonly processStart: string
  readonly publisherToken: string
}

export type ServerOwnerRead =
  | { kind: "running"; port: number; owner: ProjectLaunchOwnerRecord }
  | { kind: "busy"; owner: ProjectLaunchOwnerRecord | null }
  | { kind: "idle" }

export type ServerOwnerAcquire =
  | { kind: "acquired"; lease: ServerOwnerLease }
  | Exclude<ServerOwnerRead, { kind: "idle" }>

interface ServerAddressRecord {
  version: 1
  ownerToken: string
  pid: number
  processStart: string
  publisherToken: string
  port: number
}

function rootsFor(roots: ServerOwnerRoots | undefined): ServerOwnerRoots {
  return roots ?? ntwinePaths()
}

/** One stable-server target per Ntwine home, independent of the repository that launched it. */
export function stableServerOwnerTarget(roots?: ServerOwnerRoots): ProjectLaunchTarget {
  const resolved = rootsFor(roots)
  mkdirSync(resolved.data, { recursive: true, mode: 0o700 })
  return {
    projectId: STABLE_SERVER_OWNER_PROJECT_ID,
    projectDir: realpathSync(resolved.data),
    stateDir: join(resolved.state, stableServerOwnerName(resolved)),
  }
}

export function stableServerOwnerAddressPath(roots?: ServerOwnerRoots): string {
  return join(stableServerOwnerTarget(roots).stateDir, ADDRESS_NAME)
}

function matchingTarget(owner: ProjectLaunchOwnerRecord, target: ProjectLaunchTarget): boolean {
  return owner.projectId === target.projectId && owner.projectDir === target.projectDir
}

function readAddress(path: string): ServerAddressRecord | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ServerAddressRecord>
    if (
      value.version !== 1 ||
      typeof value.ownerToken !== "string" || !UUID_RE.test(value.ownerToken) ||
      typeof value.publisherToken !== "string" || !UUID_RE.test(value.publisherToken) ||
      typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0 ||
      typeof value.processStart !== "string" || value.processStart.length === 0 ||
      typeof value.port !== "number" || !Number.isInteger(value.port) || value.port < 1 || value.port > 65_535
    ) return null
    return value as ServerAddressRecord
  } catch {
    return null
  }
}

/**
 * Read the global stable server owner without treating a listener-less owner as absent.
 *
 * A launcher that is preparing a child must block another repository's launch even before it has a
 * port. Likewise an unreadable or mismatched address under a live generation is fail-closed: joining
 * a wrong listener is recoverable, while starting a second scheduler against the shared database is
 * not. A stale generation is idle here and is retired atomically by `acquireStableServerOwner`.
 */
export function readStableServerOwner(roots?: ServerOwnerRoots): ServerOwnerRead {
  const target = stableServerOwnerTarget(roots)
  const owner = readProjectLaunchOwner(target.stateDir)
  if (!owner || !matchingTarget(owner, target) || processGenerationIsStale(owner)) return { kind: "idle" }
  const address = readAddress(join(target.stateDir, ADDRESS_NAME))
  if (
    !address ||
    address.ownerToken !== owner.token ||
    address.pid !== owner.pid ||
    address.processStart !== owner.processStart
  ) return { kind: "busy", owner }
  return { kind: "running", port: address.port, owner }
}

function wrapLease(lease: ProjectLaunchLease): ServerOwnerLease {
  return {
    target: lease.target,
    token: lease.token,
    pid: lease.pid,
    processStart: lease.processStart,
    publisherToken: randomUUID(),
  }
}

/** Acquire the exact generation-verified machine-wide stable-server lease, or report its owner. */
export function acquireStableServerOwner(roots?: ServerOwnerRoots): ServerOwnerAcquire {
  const target = stableServerOwnerTarget(roots)
  const attempt = tryAcquireProjectLaunchOwner(target, "server")
  if (attempt.kind === "acquired") return { kind: "acquired", lease: holdLease(attempt.lease) }
  const observed = readStableServerOwner(roots)
  return observed.kind === "running" || observed.kind === "busy"
    ? observed
    : { kind: "busy", owner: attempt.owner }
}

/** Publish the public listener only from the exact lease generation that acquired the global owner. */
export function publishStableServerAddress(lease: ServerOwnerLease, port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`invalid stable Ntwine server port: ${port}`)
  const owner = readProjectLaunchOwner(lease.target.stateDir)
  if (
    !owner ||
    !matchingTarget(owner, lease.target) ||
    owner.token !== lease.token ||
    owner.pid !== lease.pid ||
    owner.processStart !== lease.processStart ||
    processGenerationIsStale(owner)
  ) throw new Error("cannot publish an address without the exact live stable Ntwine server owner")
  writeProjectStatus(join(lease.target.stateDir, ADDRESS_NAME), {
    version: 1,
    ownerToken: lease.token,
    pid: lease.pid,
    processStart: lease.processStart,
    publisherToken: lease.publisherToken,
    port,
  })
}

/** Remove this generation's address and release its project-launch lease; never touch a successor. */
export function releaseStableServerOwner(lease: ServerOwnerLease): boolean {
  return releaseHeldLease(lease)
}

const heldLeases = new Map<string, ProjectLaunchLease>()

function holdLease(lease: ProjectLaunchLease): ServerOwnerLease {
  const wrapped = wrapLease(lease)
  heldLeases.set(wrapped.publisherToken, lease)
  return wrapped
}

function releaseHeldLease(lease: ServerOwnerLease): boolean {
  const held = heldLeases.get(lease.publisherToken)
  if (!held || held.token !== lease.token || held.pid !== lease.pid || held.processStart !== lease.processStart) return false
  const released = held.release()
  if (!released) return false
  heldLeases.delete(lease.publisherToken)
  removeProjectStatus(join(lease.target.stateDir, ADDRESS_NAME), {
    ownerToken: lease.token,
    pid: lease.pid,
    processStart: lease.processStart,
    publisherToken: lease.publisherToken,
  })
  return true
}
