import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { z } from "zod"
import { deleteMachineConfig, machineConfigPath, readMachineConfig, writeMachineConfig } from "./machine-config.ts"

const Font = z.object({ font: z.enum(["sans", "mono"]) })

function withHome<T>(body: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "ntwine-machine-config-"))
  try {
    return body(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test("records are keyed in one file, and writing one never drops another", () => {
  withHome((home) => {
    assert.equal(readMachineConfig(home, "a", Font), undefined, "nothing yet")
    writeMachineConfig(home, "a", { font: "mono" })
    writeMachineConfig(home, "b", { font: "sans" })
    assert.deepEqual(readMachineConfig(home, "a", Font), { font: "mono" })
    assert.deepEqual(readMachineConfig(home, "b", Font), { font: "sans" })
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(machineConfigPath(home), "utf8"))).sort(), ["a", "b"])
  })
})

test("a value that fails its owner's schema reads as undefined and is left on disk", () => {
  withHome((home) => {
    writeMachineConfig(home, "a", { font: "comic" })
    assert.equal(readMachineConfig(home, "a", Font), undefined)
    assert.deepEqual(JSON.parse(readFileSync(machineConfigPath(home), "utf8")).a, { font: "comic" }, "a read never rewrites")
  })
})

test("an unreadable file reads as empty rather than throwing, and the next write replaces it", () => {
  withHome((home) => {
    writeMachineConfig(home, "a", { font: "mono" })
    writeFileSync(machineConfigPath(home), "{ not json")
    assert.equal(readMachineConfig(home, "a", Font), undefined)
    writeMachineConfig(home, "b", { font: "sans" })
    assert.deepEqual(readMachineConfig(home, "b", Font), { font: "sans" })
    assert.equal(readMachineConfig(home, "a", Font), undefined, "the corrupt file's contents are not resurrected")
  })
})

test("deleting a key keeps the others, and deleting a missing key writes nothing", () => {
  withHome((home) => {
    deleteMachineConfig(home, "a")
    assert.equal(existsSync(machineConfigPath(home)), false)
    writeMachineConfig(home, "a", { font: "mono" })
    writeMachineConfig(home, "b", { font: "sans" })
    deleteMachineConfig(home, "a")
    assert.equal(readMachineConfig(home, "a", Font), undefined)
    assert.deepEqual(readMachineConfig(home, "b", Font), { font: "sans" })
  })
})
