import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { frizzConfigBlock } from "./dispatch.ts"
import { PROJECT_INSTRUCTIONS_MAX_BYTES, readProjectInstructions, writeProjectInstructions } from "./project-instructions.ts"

function project() {
  const dir = mkdtempSync(join(tmpdir(), "frizz-instructions-"))
  return { dir, [Symbol.dispose]: () => rmSync(dir, { recursive: true, force: true }) }
}

test("an instruction written from the editor is what frizzConfigBlock injects", () => {
  using p = project()
  assert.deepEqual(readProjectInstructions(p.dir), { content: "", revision: "", editable: true })
  const w = writeProjectInstructions(p.dir, "Run `nub run test` before committing.", "")
  assert.equal(w.ok, true)
  assert.equal(readProjectInstructions(p.dir).revision, w.revision)
  assert.match(frizzConfigBlock(p.dir), /Run `nub run test` before committing\./)
})

test("a write based on a stale revision is refused and returns the file as it now is", () => {
  using p = project()
  const first = writeProjectInstructions(p.dir, "one", "")
  writeFileSync(join(p.dir, "FRIZZ.md"), "edited by a worker")
  const stale = writeProjectInstructions(p.dir, "two", first.revision)
  assert.equal(stale.ok, false)
  assert.equal(stale.ok === false && stale.reason, "conflict")
  assert.equal(stale.content, "edited by a worker")
  assert.equal(readFileSync(join(p.dir, "FRIZZ.md"), "utf8"), "edited by a worker")
  // Creating a file that appeared since the editor opened is a conflict too.
  using q = project()
  writeFileSync(join(q.dir, "FRIZZ.md"), "committed")
  assert.equal(writeProjectInstructions(q.dir, "mine", "").ok, false)
})

test("clearing the instructions removes the file instead of leaving an empty one", () => {
  using p = project()
  const w = writeProjectInstructions(p.dir, "x", "")
  const cleared = writeProjectInstructions(p.dir, "  \n", w.revision)
  assert.deepEqual(cleared, { ok: true, content: "", revision: "" })
  assert.equal(existsSync(join(p.dir, "FRIZZ.md")), false)
  assert.equal(frizzConfigBlock(p.dir), "")
})

test("oversized content and a symlinked FRIZZ.md are never written", () => {
  using p = project()
  const big = writeProjectInstructions(p.dir, "x".repeat(PROJECT_INSTRUCTIONS_MAX_BYTES + 1), "")
  assert.equal(big.ok === false && big.reason, "tooLarge")
  assert.equal(existsSync(join(p.dir, "FRIZZ.md")), false)

  using q = project()
  writeFileSync(join(q.dir, "target.md"), "elsewhere")
  symlinkSync(join(q.dir, "target.md"), join(q.dir, "FRIZZ.md"))
  const read = readProjectInstructions(q.dir)
  assert.equal(read.editable, false)
  const w = writeProjectInstructions(q.dir, "overwrite", read.revision)
  assert.equal(w.ok === false && w.reason, "notAFile")
  assert.equal(readFileSync(join(q.dir, "target.md"), "utf8"), "elsewhere")
})
