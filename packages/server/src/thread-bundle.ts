import { promisify } from "node:util"
import { gunzip, gzipSync } from "node:zlib"
import { isAbsolute, normalize } from "node:path"

// THE MOVED THREAD AS ONE BLOB (plans/thread-handoff.md § 5): a manifest and the files it lists, gzipped,
// then sealed by the peer channel. `[u32 BE manifest length][manifest JSON][each file's bytes in
// manifest order]`. A container of our own rather than tar because it is twenty lines, needs no
// dependency, and every path in it is checked against the root it names before anything is written.

/** Which directory on the destination a file is relative to. */
export type BundleRoot = "claude" | "scratch" | "attachments" | "git"
export const BUNDLE_ROOTS: readonly BundleRoot[] = ["claude", "scratch", "attachments", "git"]

export interface BundleFile {
  root: BundleRoot
  /** Relative, `/`-separated, inside its root. */
  rel: string
  size: number
  mode: number
}

/** The uncompressed ceiling. A long thread's transcript is tens of MB; this leaves room and stops a bomb. */
export const BUNDLE_MAX_BYTES = 768 * 1024 * 1024

export function packBundle(manifest: { files: readonly BundleFile[] }, contents: readonly Buffer[]): Buffer {
  if (manifest.files.length !== contents.length) throw new Error("bundle manifest and contents disagree")
  const json = Buffer.from(JSON.stringify(manifest), "utf8")
  const length = Buffer.alloc(4)
  length.writeUInt32BE(json.length)
  return gzipSync(Buffer.concat([length, json, ...contents]), { level: 6 })
}

export class BundleError extends Error {}

const inflate = promisify(gunzip)

/**
 * Unpack and check the container's own consistency. The manifest's MEANING is the importer's to check.
 *
 * Inflated on libuv's thread pool, not the event loop: a bundle at the limit is hundreds of MB, and
 * `gunzipSync` (until 2026-11-12) froze the whole server — every project's board — for the seconds that
 * took, on a request any paired machine can send. `maxOutputLength` still stops a bomb at the ceiling.
 * Memory is the caller's to bound (peer-service.ts lets one import unpack at a time).
 */
export async function unpackBundle(blob: Buffer, maxBytes = BUNDLE_MAX_BYTES): Promise<{ manifest: Record<string, unknown>; files: { file: BundleFile; data: Buffer }[] }> {
  let raw: Buffer
  try {
    raw = await inflate(blob, { maxOutputLength: maxBytes })
  } catch (error) {
    throw new BundleError(`the thread's bundle could not be read (${error instanceof Error ? error.message : String(error)})`)
  }
  if (raw.length < 4) throw new BundleError("the thread's bundle is truncated")
  const length = raw.readUInt32BE(0)
  if (4 + length > raw.length) throw new BundleError("the thread's bundle is truncated")
  let manifest: unknown
  try {
    manifest = JSON.parse(raw.subarray(4, 4 + length).toString("utf8"))
  } catch {
    throw new BundleError("the thread's bundle has an unreadable manifest")
  }
  if (!manifest || typeof manifest !== "object" || !Array.isArray((manifest as { files?: unknown }).files)) {
    throw new BundleError("the thread's bundle has no file list")
  }
  const listed = (manifest as { files: unknown[] }).files
  const files: { file: BundleFile; data: Buffer }[] = []
  let offset = 4 + length
  for (const entry of listed) {
    const file = bundleFile(entry)
    if (!file) throw new BundleError("the thread's bundle lists a file it cannot place")
    if (offset + file.size > raw.length) throw new BundleError("the thread's bundle is truncated")
    files.push({ file, data: raw.subarray(offset, offset + file.size) })
    offset += file.size
  }
  if (offset !== raw.length) throw new BundleError("the thread's bundle has bytes its manifest does not list")
  return { manifest: manifest as Record<string, unknown>, files }
}

function bundleFile(value: unknown): BundleFile | undefined {
  if (!value || typeof value !== "object") return undefined
  const entry = value as Record<string, unknown>
  if (typeof entry.root !== "string" || !BUNDLE_ROOTS.includes(entry.root as BundleRoot)) return undefined
  if (typeof entry.rel !== "string" || !safeRelativePath(entry.rel)) return undefined
  if (typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0) return undefined
  const mode = typeof entry.mode === "number" && Number.isInteger(entry.mode) ? entry.mode & 0o777 : 0o644
  return { root: entry.root as BundleRoot, rel: entry.rel, size: entry.size, mode }
}

/**
 * A path that stays inside whatever root it is joined to: relative, `/`-separated, no `..`, no empty or
 * `.` segment, no backslash or NUL (which would let a Windows-shaped name escape on another platform).
 */
export function safeRelativePath(rel: string): boolean {
  if (!rel || rel.length > 1024 || isAbsolute(rel) || rel.includes("\\") || rel.includes("\0")) return false
  const segments = rel.split("/")
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false
  return normalize(rel) === rel
}
