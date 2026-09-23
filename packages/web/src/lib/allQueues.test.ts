import { test } from "node:test"
import assert from "node:assert/strict"
import type { ProjectCard, ProjectQueue, ThreadView } from "@frizz/shared"
import { isBusy, laneSummary, queuesProjects, queuesTotals, threadKey } from "./allQueues.ts"

function thread(id: string, over: Partial<ThreadView> = {}): ThreadView {
  return {
    id,
    title: id,
    status: "active",
    mechanism: null,
    humanBlocked: false,
    ready: false,
    dependsOn: [],
    externalDeps: [],
    agents: [],
    errors: [],
    warnings: [],
    runtime: "turn-idle",
    unread: false,
    archived: false,
    hasPlan: false,
    subAgents: [],
    pendingQuestion: false,
    kind: "session",
    state: "open",
    spawnedAt: "2026-09-23T08:00:00.000Z",
    ...over,
  }
}

const card = (id: string, over: Partial<ProjectCard> = {}): ProjectCard =>
  ({ id, slug: id, name: id, path: `/work/${id}`, lastOpenedAt: "2026-09-23T08:00:00.000Z", stale: false, iconStatus: "none", ...over })

const queue = (projectId: string, threads: ThreadView[], over: Partial<ProjectQueue> = {}): ProjectQueue =>
  ({ projectId, projectSlug: projectId, projectName: projectId, projectDir: `/work/${projectId}`, threads, doneCount: 0, ...over })

test("projects follow the operator's rail order, and a registered project with no open board is still drawn", () => {
  const projects = queuesProjects(
    [card("b"), card("a"), card("gone", { stale: true })],
    [queue("a", []), queue("b", [])],
  )
  assert.deepEqual(projects.map((p) => [p.id, p.open, p.stale]), [["b", true, false], ["a", true, false], ["gone", false, true]])
})

test("a board the list has not caught up with yet is drawn last rather than dropped", () => {
  const projects = queuesProjects([card("a")], [queue("a", []), queue("new", [thread("x", { needsYou: true })], { projectName: "New one" })])
  assert.deepEqual(projects.map((p) => [p.id, p.name, p.queued.length]), [["a", "a", 0], ["new", "New one", 1]])
})

test("each project is banded the way its own rail bands it", () => {
  const [project] = queuesProjects([card("a")], [queue("a", [
    thread("older-rest", { needsYou: true, lastAssistantAt: "2026-09-23T09:00:00.000Z" }),
    thread("newer-rest", { needsYou: true, lastAssistantAt: "2026-09-23T10:00:00.000Z" }),
    // A pinned thread that needs you keeps its queue card on its own board, so it queues here too.
    thread("pinned-ask", { needsYou: true, pinnedAt: "2026-09-23T07:00:00.000Z", lastAssistantAt: "2026-09-23T09:30:00.000Z" }),
    thread("spinning", { runtime: "running", lastUserAt: "2026-09-23T09:10:00.000Z" }),
    thread("parked", { snoozedUntil: "2099-01-01T00:00:00.000Z" }),
  ], { doneCount: 4 })], "fifo")
  assert.deepEqual(project!.queued.map((t) => t.id), ["older-rest", "pinned-ask", "newer-rest"])
  assert.deepEqual(project!.running.map((t) => t.id), ["spinning"])
  assert.deepEqual(project!.snoozed.map((t) => t.id), ["parked"])
  assert.equal(project!.doneCount, 4)
  assert.equal(laneSummary(project!), "3 in the queue · 1 running · 1 snoozed")
})

test("the queue direction preference is honoured, newest first under lifo", () => {
  const [project] = queuesProjects([card("a")], [queue("a", [
    thread("older", { needsYou: true, lastAssistantAt: "2026-09-23T09:00:00.000Z" }),
    thread("newer", { needsYou: true, lastAssistantAt: "2026-09-23T10:00:00.000Z" }),
  ])], "lifo")
  assert.deepEqual(project!.queued.map((t) => t.id), ["newer", "older"])
})

test("totals count the queue and the running rows across every project", () => {
  const projects = queuesProjects([card("a"), card("b"), card("c")], [
    queue("a", [thread("q1", { needsYou: true }), thread("r1", { runtime: "running" })]),
    queue("b", [thread("q2", { needsYou: true }), thread("q3", { needsYou: true })]),
    queue("c", []),
  ])
  assert.deepEqual(queuesTotals(projects), { queued: 3, running: 1, projectsWithQueue: 2 })
  assert.deepEqual(projects.map(isBusy), [true, true, false])
})

test("the same slug in two projects is two threads", () => {
  assert.notEqual(threadKey("a", "fix-auth"), threadKey("b", "fix-auth"))
})
