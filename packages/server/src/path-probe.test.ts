import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expandHome, isDirectory } from "./path-probe.ts"

test("expandHome: `~` and `~/…` are HOME; every other spelling is left as typed", () => {
  assert.equal(expandHome("~", "/h/u"), "/h/u")
  assert.equal(expandHome("~/", "/h/u"), "/h/u")
  assert.equal(expandHome("~/.cache/nub/x", "/h/u"), "/h/u/.cache/nub/x")
  for (const asIs of ["~user/x", "a/~/b", "/abs/~", "rel", ""]) assert.equal(expandHome(asIs, "/h/u"), asIs)
})

test("isDirectory: a folder is; a file, a missing path and an empty one are not", () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-path-probe-"))
  try {
    writeFileSync(join(dir, "f"), "x")
    assert.equal(isDirectory(dir), true)
    assert.equal(isDirectory(join(dir, "f")), false)
    assert.equal(isDirectory(join(dir, "missing")), false)
    assert.equal(isDirectory(""), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
