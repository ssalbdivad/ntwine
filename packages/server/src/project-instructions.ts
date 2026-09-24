import { createHash } from "node:crypto"
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// The "Project instructions" editor in the model picker's agent settings is an editor for the
// project's `FRIZZ.md`, not a second store. A Settings-blob preamble (`dispatchPreamble`) was retired
// on 2026-07-30 so that there is exactly ONE operator-authored surface — the file frizzConfigBlock
// already injects into every worker's system prompt on dispatch, adopt and resume, for both runtimes,
// and which is reviewable in a diff and travels with a clone. Writing that same file from the UI keeps
// it that way: an edit here reaches the next launch through the path that was already proven, and an
// edit an agent commits to the file is what the editor shows next time it opens.
//
// Workers edit FRIZZ.md too, so a save must never clobber a change the editor never saw. Every read
// hands back a `revision` (a hash of the bytes on disk, "" for no file), every write carries the
// revision it was based on, and a write whose base no longer matches the disk is refused with the
// current content, so the operator reloads instead of silently overwriting.
export const PROJECT_INSTRUCTIONS_FILE = "FRIZZ.md"
// Same ceiling frizzConfigBlock reads under: a file past it is not injected AT ALL, so the editor must
// not be able to write one.
export const PROJECT_INSTRUCTIONS_MAX_BYTES = 64 * 1024

export type ProjectInstructions = { content: string; revision: string }
export type ProjectInstructionsWrite =
  | { ok: true; content: string; revision: string }
  | { ok: false; reason: "conflict" | "tooLarge" | "notAFile"; content: string; revision: string }

function revisionOf(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16)
}

// lstat, not stat: a symlinked or otherwise special FRIZZ.md is left for the operator's own editor.
// Writing through a symlink would edit a file outside the project; replacing it would sever the link.
function readRaw(projectDir: string): { kind: "missing" } | { kind: "file"; bytes: string } | { kind: "other" } {
  const path = join(projectDir, PROJECT_INSTRUCTIONS_FILE)
  let st
  try {
    st = lstatSync(path)
  } catch {
    return { kind: "missing" }
  }
  if (!st.isFile() || st.size > PROJECT_INSTRUCTIONS_MAX_BYTES) return { kind: "other" }
  return { kind: "file", bytes: readFileSync(path, "utf8") }
}

export function readProjectInstructions(projectDir: string): ProjectInstructions & { editable: boolean } {
  const raw = readRaw(projectDir)
  if (raw.kind === "missing") return { content: "", revision: "", editable: true }
  if (raw.kind === "other") return { content: "", revision: "other", editable: false }
  return { content: raw.bytes, revision: revisionOf(raw.bytes), editable: true }
}

// Blank content removes the file rather than leaving an empty one behind: frizzConfigBlock injects
// nothing for either, and a repo that never had a FRIZZ.md should not grow an empty one because the
// operator opened the editor and cleared it. A committed file removed this way is a `git restore` away.
export function writeProjectInstructions(projectDir: string, content: string, baseRevision: string): ProjectInstructionsWrite {
  const raw = readRaw(projectDir)
  const current = raw.kind === "file" ? { content: raw.bytes, revision: revisionOf(raw.bytes) } : { content: "", revision: raw.kind === "missing" ? "" : "other" }
  if (raw.kind === "other") return { ok: false, reason: "notAFile", ...current }
  if (current.revision !== baseRevision) return { ok: false, reason: "conflict", ...current }
  if (Buffer.byteLength(content, "utf8") > PROJECT_INSTRUCTIONS_MAX_BYTES) return { ok: false, reason: "tooLarge", ...current }
  const path = join(projectDir, PROJECT_INSTRUCTIONS_FILE)
  if (!content.trim()) {
    rmSync(path, { force: true })
    return { ok: true, content: "", revision: "" }
  }
  // Temp file + rename, so a worker spawned mid-write reads the old file or the new one, never half.
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, content, "utf8")
  renameSync(tmp, path)
  return { ok: true, content, revision: revisionOf(content) }
}
