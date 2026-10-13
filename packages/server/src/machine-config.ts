import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { z } from "zod"
import { ntwinePaths } from "./ntwine-paths.ts"

// THE MACHINE-LEVEL KEY/VALUE STORE — the counterpart of a project database's `settings` table.
//
// A project's `Storage.getSetting/setSetting` is where a small persistent record goes when it belongs
// to one repository. Until 2026-08-25 there was no equivalent for a record that belongs to the
// OPERATOR — one value for every project the singleton server serves — so each one grew its own file
// with its own reader and writer (`settings.json`, `registry.json`, `cloud.json`), and the next one
// would have too (maintainer: "surely we have some general-purpose system for storing bits of
// persistent configuration like this?"). This is that system: one JSON object at `<data>/config.json`,
// keyed by record name, each value validated by the schema its owner hands in.
//
// The rules every record inherits, so no owner re-derives them:
//   · a read never throws and never rewrites — a missing file, bad JSON or a value that fails the
//     owner's schema all read as `undefined`, and the owner falls back to whatever it fell back to
//     before (a project row, a shipped default);
//   · a write is read-modify-write of the whole object, open(w) → fsync → rename, so a reader never
//     sees a half file and one key's write cannot drop another key — safe because the singleton is the
//     only writer and node's sync fs calls serialize it;
//   · a write that fails is swallowed: these are preferences, not state, and failing to persist a font
//     must never fail the save that carried it.
//
// `home` is REQUIRED and deliberately not defaulted to homedir() — see settings.ts for the run that
// silently rewrote the maintainer's own notifications flag when a test defaulted it.

export function machineConfigPath(home: string): string {
  return join(ntwinePaths({ home }).data, "config.json")
}

function readAll(home: string): Record<string, unknown> {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(machineConfigPath(home), "utf8"))
  } catch {
    return {}
  }
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
}

function writeAll(home: string, all: Record<string, unknown>): void {
  const path = machineConfigPath(home)
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temp, "w", 0o600)
    writeFileSync(fd, `${JSON.stringify(all, null, 2)}\n`, "utf8")
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, path)
  } catch {
    if (fd !== undefined) try { closeSync(fd) } catch { /* already gone */ }
    try { rmSync(temp, { force: true }) } catch { /* already gone */ }
  }
}

/** One record, or undefined when it is absent or does not satisfy `schema`. Never throws. */
export function readMachineConfig<T>(home: string, key: string, schema: z.ZodType<T>): T | undefined {
  const value = readAll(home)[key]
  if (value === undefined) return undefined
  const parsed = schema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export function writeMachineConfig(home: string, key: string, value: unknown): void {
  writeAll(home, { ...readAll(home), [key]: value })
}

export function deleteMachineConfig(home: string, key: string): void {
  const all = readAll(home)
  if (!(key in all)) return
  delete all[key]
  writeAll(home, all)
}
