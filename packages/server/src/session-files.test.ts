import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { SYSTEM_PROMPT_DIR, cleanupSessionFiles } from "./session-files.ts"

// The system-prompt child is removed WITHOUT following it: a symlink in its place is unlinked, and
// whatever it points at is left alone. On Node 23.0–24.13.0 and 25.0–25.3.x rmSync looked through a
// link (nodejs/node#61040) — a link to a directory threw ERR_FS_EISDIR and a dangling link was silently
// left in place — so cleanup reported not-clean for a child it could have removed.
test("session-file cleanup unlinks a symlinked system-prompt child and never touches its target", () => {
  const project = mkdtempSync(join(tmpdir(), "ntwine-session-files-"))
  mkdirSync(SYSTEM_PROMPT_DIR, { recursive: true })
  const outside = join(project, "outside")
  mkdirSync(outside)
  writeFileSync(join(outside, "keep.txt"), "keep")
  const cases = [
    { name: "a link to a directory", target: outside },
    { name: "a dangling link", target: join(project, "gone") },
  ]
  try {
    for (const { name, target } of cases) {
      const sessionId = randomUUID()
      const child = join(SYSTEM_PROMPT_DIR, `${sessionId}.md`)
      symlinkSync(target, child)
      try {
        assert.equal(cleanupSessionFiles(project, sessionId), true, `${name}: cleanup reports clean`)
        assert.throws(() => lstatSync(child), { code: "ENOENT" }, `${name}: the link itself is gone`)
      } finally {
        // unlink, for the same reason: an affected Node's rmSync would leave a dangling link behind.
        try { unlinkSync(child) } catch {}
      }
    }
    assert.equal(existsSync(join(outside, "keep.txt")), true, "the link's target is never followed")
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})
