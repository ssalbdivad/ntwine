import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { completePath } from "./path-complete.ts"

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ntwine-path-complete-"))
  for (const dir of ["code/fable", "code/Fray", "code/nub", "code/.hidden", "other"]) mkdirSync(join(home, dir), { recursive: true })
  writeFileSync(join(home, "code/fable.txt"), "")
  symlinkSync(join(home, "other"), join(home, "code/linked"))
  return { home, [Symbol.dispose]: () => rmSync(home, { recursive: true, force: true }) }
}

test("folders continuing the last segment, case-insensitive, spelled as typed, never files", () => {
  using f = fixture()
  assert.deepEqual(completePath("~/code/f", f.home), { status: "missing", suggestions: ["~/code/fable/", "~/code/Fray/"] })
  assert.deepEqual(completePath(`${f.home}/code/`, f.home).suggestions, [
    `${f.home}/code/fable/`, `${f.home}/code/Fray/`, `${f.home}/code/linked/`, `${f.home}/code/nub/`,
  ])
})

test("status names what is at the typed path", () => {
  using f = fixture()
  assert.equal(completePath("~/code/nub", f.home).status, "directory")
  assert.equal(completePath("~/code/nub/", f.home).status, "directory")
  assert.equal(completePath("~/code/fable.txt", f.home).status, "file")
  assert.equal(completePath("~/code/nope", f.home).status, "missing")
  assert.deepEqual(completePath("  ", f.home), { status: "empty", suggestions: [] })
})

test("dotfolders only once a dot is typed; the exact match is not re-offered; ~ descends", () => {
  using f = fixture()
  assert.deepEqual(completePath("~/code/.", f.home).suggestions, ["~/code/.hidden/"])
  assert.deepEqual(completePath("~/code/nub", f.home).suggestions, [])
  assert.deepEqual(completePath("~", f.home).suggestions, ["~/code/", "~/other/"])
  assert.deepEqual(completePath("~/missing/x", f.home), { status: "missing", suggestions: [] })
})
