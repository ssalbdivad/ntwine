import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BUILD, BUILD_FILE, buildLabel, builtAtLabel, installedBuild, readBuildFile, type BuildInfo } from "./build-info.ts"

// An extensions directory laid out the way VS Code lays one out: `<publisher>.<name>-<version>` folders,
// each with the build record scripts/build.ts writes, and `.obsolete` naming the ones a newer install
// replaced.

const ID = "ssalbdivad.ntwine-vscode"

function extensionsDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-build-info-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function install(dir: string, folder: string, build: BuildInfo | string): string {
  const path = join(dir, folder)
  mkdirSync(join(path, "dist"), { recursive: true })
  writeFileSync(join(path, BUILD_FILE), typeof build === "string" ? build : JSON.stringify(build))
  return path
}

const running: BuildInfo = { version: "0.1.0", commit: "1a2b3c4d", builtAt: "2026-10-02T10:00:00.000Z", id: "running" }

test("the label is the version with the commit as build metadata, dirty when the bundle's sources were", () => {
  assert.equal(buildLabel({ version: "0.1.0", commit: "1a2b3c4d" }), "0.1.0+1a2b3c4d")
  assert.equal(buildLabel({ version: "0.1.0", commit: "1a2b3c4d", dirty: true }), "0.1.0+1a2b3c4d-dirty")
  assert.equal(buildLabel({ version: "0.1.0" }), "0.1.0", "no commit outside a checkout")
  assert.equal(builtAtLabel({ builtAt: "2026-10-02T14:03:59.000Z" }, "UTC"), "2026-10-02 14:03")
  assert.equal(builtAtLabel({}), "")
  // Run from source, never built: a stand-in that names no commit.
  assert.equal(BUILD.id, "source")
})

test("a build record is read whole or not at all", (t) => {
  const dir = extensionsDir(t)
  assert.deepEqual(readBuildFile(join(install(dir, "a", running), BUILD_FILE)), running)
  assert.equal(readBuildFile(join(install(dir, "b", "{not json"), BUILD_FILE)), undefined)
  assert.equal(readBuildFile(join(install(dir, "c", JSON.stringify({ version: "0.1.0" })), BUILD_FILE)), undefined, "no id: not a record")
  assert.equal(readBuildFile(join(dir, "missing", BUILD_FILE)), undefined)
})

test("the same version reinstalled over this window's folder is a new build, newer or not", (t) => {
  const dir = extensionsDir(t)
  const here = install(dir, `${ID}-0.1.0`, running)
  assert.equal(installedBuild(here, ID, running), undefined, "what it loaded is what is there")
  const rebuilt = { ...running, commit: "5e6f7a8b", builtAt: "2026-10-02T09:00:00.000Z", id: "rebuilt" }
  install(dir, `${ID}-0.1.0`, rebuilt)
  assert.deepEqual(installedBuild(here, ID, running), rebuilt, "what a reload would load, even if built earlier")
})

test("a new version beside this one counts when it is newer and not marked obsolete", (t) => {
  const dir = extensionsDir(t)
  const here = install(dir, `${ID}-0.1.0`, running)
  // An older version still on disk, and a stranger's extension: neither is a new build of this one.
  install(dir, `${ID}-0.0.9`, { ...running, version: "0.0.9", builtAt: "2026-10-01T10:00:00.000Z", id: "older" })
  install(dir, "someone.else-1.0.0", { ...running, builtAt: "2026-10-03T10:00:00.000Z", id: "stranger" })
  assert.equal(installedBuild(here, ID, running), undefined)
  const next = { ...running, version: "0.1.1", builtAt: "2026-10-02T11:00:00.000Z", id: "next" }
  install(dir, `${ID}-0.1.1`, next)
  // VS Code's own folder names keep the publisher's case; the id it reports is lowercase.
  install(dir, "SsalbDivad.Ntwine-Vscode-0.1.2", { ...running, version: "0.1.2", builtAt: "2026-10-02T12:00:00.000Z", id: "newest" })
  assert.equal(installedBuild(here, ID, running)?.id, "newest", "the newest of them")
  writeFileSync(join(dir, ".obsolete"), JSON.stringify({ "SsalbDivad.Ntwine-Vscode-0.1.2": true }))
  assert.deepEqual(installedBuild(here, ID, running), next, "one VS Code is removing is not what a reload loads")
})
