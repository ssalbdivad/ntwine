import { test } from "node:test"
import assert from "node:assert/strict"
import type { ProjectCard, ProjectQueue, ThreadView } from "@frizz/shared"
import { handoffParts, isBusy, laneSummary, queuesProjects, queuesTotals, threadKey, liveQueue, overlayQueues } from "./allQueues.ts"

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

const REGISTERED = [{ id: "qst_ab12cd34", spec: { question: "Which hero headline should the launch page ship with?", kind: "question" as const, options: [] } }]

test("a handoff splits into prose, its signal fences, and the question fences no registered card draws", () => {
  const parts = handoffParts(
    [
      "**Needs you** — three variants are drafted.",
      "",
      "```question qst_ab12cd34",
      "```",
      "",
      "```question",
      "Which hero headline should the launch page ship with?",
      "A. Ship the queue",
      "```",
      "",
      "```question",
      "Should the old headline stay up until launch day?",
      "A. Yes",
      "B. No",
      "```",
      "",
      "```done",
      "- Drafted three variants",
      "```",
    ].join("\n"),
    REGISTERED as never,
  )
  assert.equal(parts.prose, "**Needs you** — three variants are drafted.")
  // The empty marker and the fence restating the registered question are its card's; the third is not.
  assert.deepEqual(parts.questions.map((q) => q.raw.split("\n")[0]), ["Should the old headline stay up until launch day?"])
  assert.deepEqual(parts.fences, [{ kind: "done", body: "- Drafted three variants" }])
})

test("with nothing registered, a question fence with a body is KEPT — on a legacy thread it is the live ask", () => {
  const parts = handoffParts("Pick one.\n\n```question\nSeconds or epoch?\nA. Seconds\nB. Epoch\n```")
  assert.equal(parts.questions.length, 1)
  assert.equal(parts.prose, "Pick one.")
})

test("an archived row an older server still sends is counted Done, working or not", () => {
  const [project] = queuesProjects([card("a")], [queue("a", [
    // A sub-agent still running does not lift an archived thread out of Done — only the human reopens it…
    thread("sub-agent-out", { state: "archived", archived: true, subAgents: [{ id: "s1", state: "running", depth: 1 } as never] }),
    // …and neither does a background wait.
    thread("parked", { state: "archived", archived: true, awaitingBackground: true, watches: [{ kind: "timer", state: "armed" }] as never }),
  ], { doneCount: 5 })])
  assert.deepEqual(project!.running.map((t) => t.id), [])
  assert.equal(project!.doneCount, 7)
})

test("a terminal command thread takes the band its own rail gives it: a finished run queues, a running one runs", () => {
  const run = (state: "running" | "exited") => ({ command: "pnpm test", state, runId: 1, startedAt: "2026-09-23T09:00:00.000Z", ...(state === "exited" ? { exitedAt: "2026-09-23T09:05:00.000Z", exitCode: 1 } : {}) })
  const [project] = queuesProjects([card("a")], [queue("a", [
    thread("term-finished", { kind: "command", needsYou: true, command: run("exited") }),
    thread("term-running", { kind: "command", command: run("running") }),
  ])])
  assert.deepEqual(project!.queued.map((t) => t.id), ["term-finished"])
  assert.deepEqual(project!.running.map((t) => t.id), ["term-running"])
  assert.deepEqual(queuesTotals([project!]), { queued: 1, running: 1, projectsWithQueue: 1 })
})

// The focused project is the page project, so its board is live in the store; the poll lags it by up to
// a poll. Acting in its drawer (Mark as done) or dispatching into it must show at once.
test("the focused project is drawn from its live board, never another project's", () => {
  const polled = [
    queue("alpha", [thread("fix-auth", { needsYou: true })], { doneCount: 4 }),
    queue("beta", [thread("fix-auth", { needsYou: true })]),
  ]
  const live = { projectSlug: "alpha", threads: [thread("fix-auth", { state: "archived", archived: true }), thread("new-one", { runtime: "turn-running" })] }
  const alphaLive = liveQueue(polled, live, "alpha")!
  assert.deepEqual(alphaLive.threads.map((t) => t.id), ["fix-auth", "new-one"])
  assert.equal(alphaLive.doneCount, 0, "the rail counts the live Done rows itself")
  const base = queuesProjects([card("alpha"), card("beta")], polled)
  const projects = overlayQueues(base, [alphaLive])
  assert.equal(projects.find((p) => p.id === "alpha")!.queued.length, 0, "the finished card leaves at once")
  assert.equal(projects.find((p) => p.id === "alpha")!.card, base[0]!.card, "keeps its registry card")
  assert.equal(projects.find((p) => p.id === "beta"), base[1], "beta's same-slug thread is untouched, and so is beta")
  assert.equal(overlayQueues(base, [undefined]), base, "nothing live, nothing rebuilt")

  // NEGATIVE: a board that is not provably the focus — mid focus change, the store still holds the old
  // project's — is never drawn under the focus's name.
  assert.equal(liveQueue(polled, { projectSlug: "beta", threads: [] }, "alpha"), undefined)
  assert.equal(liveQueue(polled, { projectSlug: undefined, threads: [] }, "alpha"), undefined)
  assert.equal(liveQueue(polled, null, "alpha"), undefined)
  // Foreign rows never reach the page, as the server's poll never sends them.
  assert.equal(liveQueue(polled, { projectSlug: "alpha", threads: [thread("ext", { foreign: true })] }, "alpha")!.threads.length, 0)
})
