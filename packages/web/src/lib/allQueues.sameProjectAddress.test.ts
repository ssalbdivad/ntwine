import { test } from "node:test"
import assert from "node:assert/strict"
import type { ProjectCard, ThreadView } from "@ntwine/shared"
import { sameProjectAddress, type QueuesProject } from "./allQueues.ts"

// A queue card compares its project by ADDRESS, not identity: the poll rebuilds every project each tick
// and a live board rebuilds its project on every delta, so the object is new while nothing a card reads
// moved. By identity, every card of a project re-rendered whenever any of its threads changed.

const card = { id: "alpha", slug: "alpha", name: "alpha" } as unknown as ProjectCard
const base: QueuesProject = {
  id: "alpha",
  slug: "alpha",
  name: "alpha",
  card,
  open: true,
  stale: false,
  projectDir: "/src/alpha",
  homeDir: "/home/me",
  githubRepo: "acme/alpha",
  queued: [],
  running: [],
  snoozed: [],
  doneCount: 0,
}

test("a project rebuilt around new thread lists is the same address", () => {
  const moved = { ...base, queued: [{ id: "t" } as ThreadView], running: [{ id: "u" } as ThreadView], doneCount: 3 }
  assert.equal(sameProjectAddress(base, moved), true)
})

test("anything a card reads from its project is compared", () => {
  for (const change of [{ slug: "beta" }, { name: "Alpha" }, { projectDir: "/src/other" }, { homeDir: "/root" }, { githubRepo: "acme/beta" }, { open: false }, { stale: true }, { card: { ...card } as ProjectCard }, { id: "beta" }] as Partial<QueuesProject>[]) {
    assert.equal(sameProjectAddress(base, { ...base, ...change }), false, JSON.stringify(Object.keys(change)))
  }
})
