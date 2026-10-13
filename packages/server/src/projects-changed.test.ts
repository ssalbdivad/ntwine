import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { ServerEvent } from "@frizz/shared"
import { Bus } from "./bus.ts"
import { listProjects, registerProject, registryPath, renameProject, reorderProjects } from "./project-registry.ts"
import { announceProjectListChanges } from "./projects-changed.ts"

// A reorder in one tab reached no other tab until a reload: the server wrote the new order and told
// nobody. These drive the REAL registry in a sandbox home and real buses — one per open project, which
// is the part that matters, since a tab is subscribed to the board it is showing and nothing else.

function sandbox(): { home: string; ids: string[]; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "frizz-projects-changed-"))
  mkdirSync(join(home, ".frizz"), { recursive: true }) // legacy collapse root, so data lands under it
  const ids = ["alpha", "beta", "gamma"].map((name, index) => {
    const dir = join(home, name)
    mkdirSync(dir)
    const id = `00000000-0000-4000-8000-00000000000${index}`
    registerProject({ dir, id }, home)
    return id
  })
  return { home, ids, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

function tabs(count: number): { buses: Bus[]; heard: ServerEvent[][] } {
  const buses = Array.from({ length: count }, () => new Bus())
  const heard = buses.map((bus) => {
    const events: ServerEvent[] = []
    bus.subscribe((event) => events.push(event))
    return events
  })
  return { buses, heard }
}

/** The announcement is deferred to a microtask; this is one turn past it. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

test("a reorder is announced on every open project's stream, and the list it names is already written", async () => {
  const { home, ids, cleanup } = sandbox()
  const { buses, heard } = tabs(3)
  // What a tab does on the event: re-read the list. Recorded at delivery, so this is the order a tab
  // on another project would actually draw.
  const ordersRead: string[][] = []
  buses[1]!.subscribe(() => ordersRead.push(listProjects(home).map((project) => project.id)))
  const stop = announceProjectListChanges({ registryPath: registryPath(home), buses: () => buses })
  try {
    const next = [ids[2]!, ids[0]!, ids[1]!]
    reorderProjects(next, home)
    assert.deepEqual(heard, [[], [], []], "nothing is published inside the write itself")
    await settle()

    assert.deepEqual(heard, [[{ type: "projects-changed" }], [{ type: "projects-changed" }], [{ type: "projects-changed" }]])
    assert.deepEqual(ordersRead, [next])
  } finally {
    stop()
    cleanup()
  }
})

test("two writes in one handler are one announcement; a later write is another", async () => {
  const { home, ids, cleanup } = sandbox()
  const { buses, heard } = tabs(1)
  const stop = announceProjectListChanges({ registryPath: registryPath(home), buses: () => buses })
  try {
    // A rename that also re-registers the directory writes the registry twice before it returns.
    renameProject(ids[0]!, { name: "First", slug: "first" }, home)
    reorderProjects([ids[1]!, ids[0]!], home)
    await settle()
    assert.equal(heard[0]!.length, 1)

    reorderProjects([ids[0]!, ids[1]!], home)
    await settle()
    assert.equal(heard[0]!.length, 2)
  } finally {
    stop()
    cleanup()
  }
})

test("a project opened after arming hears it too, and another machine's registry is not this server's news", async () => {
  const { home, ids, cleanup } = sandbox()
  const elsewhere = sandbox()
  const { buses, heard } = tabs(2)
  const open = [buses[0]!]
  const stop = announceProjectListChanges({ registryPath: registryPath(home), buses: () => open })
  try {
    reorderProjects([...elsewhere.ids].reverse(), elsewhere.home)
    await settle()
    assert.deepEqual(heard, [[], []], "a write to a different registry file announces nothing")

    open.push(buses[1]!) // a tenant activated since
    reorderProjects([ids[1]!, ids[0]!], home)
    await settle()
    assert.deepEqual(heard.map((events) => events.length), [1, 1])
  } finally {
    stop()
    cleanup()
    elsewhere.cleanup()
  }
})

test("stopped, it announces nothing — including a write already waiting to be announced", async () => {
  const { home, ids, cleanup } = sandbox()
  const { buses, heard } = tabs(1)
  const stop = announceProjectListChanges({ registryPath: registryPath(home), buses: () => buses })
  try {
    reorderProjects([ids[1]!, ids[0]!], home)
    stop() // shutdown lands between the write and its announcement
    await settle()
    reorderProjects([ids[0]!, ids[1]!], home)
    await settle()
    assert.deepEqual(heard, [[]])
  } finally {
    cleanup()
  }
})
