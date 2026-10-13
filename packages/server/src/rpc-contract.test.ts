import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRouter } from "./router.ts"
import { createStorage } from "./storage.ts"
import type { AppContext } from "./context.ts"
import type { BoardManager } from "./board.ts"
import type { Project } from "./project.ts"
import type { Tailer } from "./tailer.ts"
import type { BoardSnapshot } from "@ntwine/shared"
import { PROCEDURES } from "../../web/src/api/contract.ts"

// The RUNTIME half of the drift gate (rpc-contract.ts is the type half). It reflects over the REAL
// router object that gets mounted on Hono and compares it against the client's checked-in
// GET/POST table. `tsc` proves the same thing, but its failure reads
// `Type '"foo"' does not satisfy the constraint 'never'`; this one names the procedure and the
// direction in plain English, and it fails `npm test` too — so drift cannot slip through on a
// branch where only the tests were run.

function realRouter() {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-rpc-contract-"))
  const project: Project = { dir, id: "rpc-contract", name: "test", label: "test", stateDir: dir, cwdSlug: "test" }
  const snapshot: BoardSnapshot = {
    projectDir: dir,
    projectName: "test",
    projectLabel: "test",
    threads: [],
    errors: [],
    warnings: [],
  }
  const board: BoardManager = {
    snapshot: async () => snapshot,
    currentSeq: () => 0,
    rebuild: async () => snapshot,
    refresh: () => snapshot,
    start: async () => {},
    stop: async () => {},
  }
  const tailer: Tailer = {
    get: () => undefined,
    foreignIds: () => [],
    subAgent: () => undefined,
    forget: () => {},
    start: () => {},
    stop: () => {},
    tick: () => {},
  }
  const storage = createStorage(join(dir, "ui.db"), "p")
  const ctx = { project, storage, board, tailer } as unknown as AppContext
  // cleanup closes the db before removing the dir: Windows refuses to delete a file another handle
  // still has open, so the reverse order is an EPERM after the assertions have already passed.
  return {
    router: createRouter(ctx),
    cleanup: () => { storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

test("every server procedure is callable from the browser client (and vice versa)", () => {
  const { router, cleanup } = realRouter()
  try {
    const served = Object.keys(router).sort()
    const declared = Object.keys(PROCEDURES).sort()
    // A server-only procedure is UNREACHABLE: the client Proxy returns `undefined` for an unknown
    // name, so the call site dies with "rpc.<name> is not a function".
    assert.deepEqual(
      served.filter((name) => !declared.includes(name)),
      [],
      "these procedures exist on the router but the web client cannot call them — add them to web/src/api/contract.ts",
    )
    // A client-only procedure 404s on every call (Hono has no route for it).
    assert.deepEqual(
      declared.filter((name) => !served.includes(name)),
      [],
      "the web client declares these procedures but the router no longer serves them — every call 404s",
    )
  } finally {
    cleanup()
  }
})

test("the client's GET/POST table matches each procedure's real query|mutation kind", () => {
  const { router, cleanup } = realRouter()
  try {
    const actual = Object.fromEntries(
      Object.entries(router).map(([name, proc]) => [name, (proc as { _tag: string })._tag]),
    )
    // A flipped kind is silent until a user clicks: the client would GET a POST-only route and take
    // Hono's plain-text 404/405, which the transport reports as "Ntwine server restart required".
    assert.deepEqual(actual, { ...PROCEDURES }, "query/mutation kind drift between the router and web/src/api/contract.ts")
  } finally {
    cleanup()
  }
})
