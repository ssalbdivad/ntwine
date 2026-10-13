import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import {
  acquireMutationGuard,
  currentProcessGeneration,
  defaultProcessPlatformAdapter,
  processGenerationIsStale,
  servedByAnotherProcess,
  type ProcessGeneration,
  type ProcessPlatformAdapter,
} from "./project-launch.ts"

/**
 * Which server has a project open, so a second one refuses it instead of scheduling it twice.
 *
 * Two servers on one project is two tailers on one SQLite file, which survives, and two SCHEDULERS,
 * which does not: both decide the same recurring prompt or timer is due and dispatch it twice into the
 * same worker. The launch lease used to be the only guard (`servedByAnotherProcess`), and only the
 * folder a server RUNS ON has one. The installed Frizz runs on its own folder now and opens every
 * project as one of many, so without this record nothing stopped a `frizz-dev` typed in a project the
 * installed Frizz had open from opening it again (decided by the maintainer 2026-10-11: refuse, and
 * name the other server).
 *
 * Written when a server opens the project and kept when it closes it, minus the server: the folder it
 * names is the most recent one any server opened the project from, which is what registry recovery
 * reads (`recordedProjectDir`). A record whose server has gone never blocks — process generation
 * settles it, so a crash leaves nothing to clean up.
 */

export const PROJECT_SERVING_FILE = "serving.json"

export interface ProjectServingRecord {
  version: 1
  projectId: string
  projectDir: string
  updatedAt: string
  /** The server that has the project open; absent once it closed it. */
  server?: ProcessGeneration & { openedAt: string }
}

export interface ProjectServingTarget {
  projectId: string
  projectDir: string
  stateDir: string
}

function parse(value: unknown): ProjectServingRecord | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  if (record.version !== 1 || typeof record.projectId !== "string" || typeof record.projectDir !== "string") return null
  if (!isAbsolute(record.projectDir) || typeof record.updatedAt !== "string") return null
  const server = record.server as Record<string, unknown> | undefined
  const generation = server
    && Number.isInteger(server.pid) && (server.pid as number) > 0
    && typeof server.processStart === "string" && server.processStart.length > 0
    && typeof server.openedAt === "string"
    ? { pid: server.pid as number, processStart: server.processStart, openedAt: server.openedAt }
    : undefined
  return {
    version: 1,
    projectId: record.projectId,
    projectDir: record.projectDir,
    updatedAt: record.updatedAt,
    ...(generation ? { server: generation } : {}),
  }
}

export function readProjectServing(stateDir: string): ProjectServingRecord | null {
  try {
    return parse(JSON.parse(readFileSync(join(stateDir, PROJECT_SERVING_FILE), "utf8")))
  } catch {
    return null
  }
}

/** Whole or not at all: a reader in another process never sees half a record. */
function writeRecord(stateDir: string, record: ProjectServingRecord): void {
  const path = join(stateDir, PROJECT_SERVING_FILE)
  const partial = `${path}.${process.pid}.tmp`
  writeFileSync(partial, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  renameSync(partial, path)
}

const same = (a: ProcessGeneration, b: ProcessGeneration): boolean => a.pid === b.pid && a.processStart === b.processStart

/** The pid of ANOTHER live server whose serving record says it has this project open. */
export function servingRecordElsewhere(
  stateDir: string,
  projectId: string,
  adapter: ProcessPlatformAdapter = defaultProcessPlatformAdapter,
): number | undefined {
  const record = readProjectServing(stateDir)
  if (!record?.server || record.projectId !== projectId) return undefined
  if (same(record.server, currentProcessGeneration(adapter)) || processGenerationIsStale(record.server, adapter)) return undefined
  return record.server.pid
}

/**
 * The pid of ANOTHER live server that has this project open, if there is one: by its serving record,
 * or by the launch lease of a server that runs on the project itself (an older Frizz, or `frizz-dev`
 * still booting, which takes the lease before it opens anything).
 *
 * Not for the project a server was LAUNCHED on: under a supervisor that lease is the supervisor's, a
 * different process, so the server would refuse its own board. That claim reads the record alone.
 */
export function projectServedElsewhere(
  stateDir: string,
  projectId: string,
  adapter: ProcessPlatformAdapter = defaultProcessPlatformAdapter,
): number | undefined {
  return servingRecordElsewhere(stateDir, projectId, adapter)
    ?? servedByAnotherProcess(stateDir, projectId, adapter.current().pid, (pid) => adapter.isAlive(pid as number))
}

export function servedElsewhereMessage(name: string, pid: number): string {
  return `${name} is already being served by another Frizz (pid ${pid}). Stop that one first — two servers on one board would fire its timers and recurring prompts twice.`
}

export class ProjectServedElsewhereError extends Error {
  readonly pid: number
  constructor(name: string, pid: number) {
    super(servedElsewhereMessage(name, pid))
    this.name = "ProjectServedElsewhereError"
    this.pid = pid
  }
}

/**
 * Record that this process has the project open, or refuse it, naming the server that has it.
 *
 * Under the project's mutation guard, so two servers opening one project at the same moment cannot
 * both read "nobody" and both go on. The release keeps the folder and drops only this process, and
 * only if the record is still its own. `launched` is the project the server was started on, whose
 * launch lease is its own side's (see projectServedElsewhere).
 */
export function claimProjectServing(
  target: ProjectServingTarget & { name: string },
  options: { launched?: boolean; adapter?: ProcessPlatformAdapter } = {},
): { release(): void } {
  const adapter = options.adapter ?? defaultProcessPlatformAdapter
  const self = currentProcessGeneration(adapter)
  const unlock = acquireMutationGuard(target.stateDir, undefined, adapter)
  try {
    const other = options.launched
      ? servingRecordElsewhere(target.stateDir, target.projectId, adapter)
      : projectServedElsewhere(target.stateDir, target.projectId, adapter)
    if (other !== undefined) throw new ProjectServedElsewhereError(target.name, other)
    const at = new Date(adapter.now()).toISOString()
    writeRecord(target.stateDir, {
      version: 1,
      projectId: target.projectId,
      projectDir: target.projectDir,
      updatedAt: at,
      server: { ...self, openedAt: at },
    })
  } finally {
    unlock()
  }
  let released = false
  return {
    release() {
      if (released) return
      released = true
      const unlockRelease = acquireMutationGuard(target.stateDir, undefined, adapter)
      try {
        const current = readProjectServing(target.stateDir)
        if (!current?.server || !same(current.server, self)) return
        const { server: _closed, ...kept } = current
        writeRecord(target.stateDir, { ...kept, updatedAt: new Date(adapter.now()).toISOString() })
      } finally {
        unlockRelease()
      }
    },
  }
}
