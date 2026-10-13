import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCodexDiagnosticSink, codexDiagnosticLogPath } from "./codex-app-server-diagnostics.ts"

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-codex-diag-"))
  return { dir, path: codexDiagnosticLogPath(dir, "proj") }
}

test("records each event as one timestamped JSONL line under the project state dir", () => {
  const { dir, path } = fresh()
  const at = new Date("2026-07-24T12:00:00.000Z")
  const sink = createCodexDiagnosticSink(dir, "proj", () => at)
  sink({ event: "connected", version: "0.144.6", connectionEpoch: 3 })
  sink({ event: "daemon-replaced", previousGeneration: "gen-A", deathReason: "app-server-killed-SIGKILL", deathAt: "2026-07-24T11:59:00.000Z" })

  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l))
  assert.equal(lines.length, 2)
  assert.deepEqual(lines[0], { at: "2026-07-24T12:00:00.000Z", event: "connected", version: "0.144.6", connectionEpoch: 3 })
  assert.equal(lines[1].event, "daemon-replaced")
  assert.equal(lines[1].deathReason, "app-server-killed-SIGKILL")
})

test("drops the high-frequency stderr pings that would drown the death signal", () => {
  const { dir, path } = fresh()
  const sink = createCodexDiagnosticSink(dir, "proj")
  sink({ event: "stderr", bytes: 1200, truncated: false })
  sink({ event: "disconnected", connectionEpoch: 1, reason: "exit" })
  const contents = existsSync(path) ? readFileSync(path, "utf8") : ""
  assert.ok(!contents.includes("stderr"), "stderr events must not be logged")
  assert.ok(contents.includes("disconnected"), "real lifecycle events must be logged")
})

test("rotates to a single .1 file once the log passes its size cap, never growing without bound", () => {
  const { dir, path } = fresh()
  const sink = createCodexDiagnosticSink(dir, "proj")
  // Pre-seed the log past the 4 MB cap so the next write rotates.
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, "x".repeat(5 * 1024 * 1024))
  sink({ event: "connected", version: "0.144.6", connectionEpoch: 9 })
  assert.ok(existsSync(`${path}.1`), "the oversized log was rotated aside")
  const fresh_contents = readFileSync(path, "utf8").trim().split("\n")
  assert.equal(fresh_contents.length, 1, "the live log restarted from the rotation")
  assert.equal(JSON.parse(fresh_contents[0]).connectionEpoch, 9)
})

test("a logging failure never throws into the bridge", () => {
  // An unwritable directory (the path's parent is a FILE) must be swallowed, not propagated.
  const dir = mkdtempSync(join(tmpdir(), "ntwine-codex-diag-bad-"))
  writeFileSync(join(dir, "codex-app-server"), "not a directory")
  const sink = createCodexDiagnosticSink(dir, "proj")
  assert.doesNotThrow(() => sink({ event: "connected", version: "0.144.6", connectionEpoch: 1 }))
})
