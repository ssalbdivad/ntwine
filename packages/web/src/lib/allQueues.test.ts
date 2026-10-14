import { test } from "node:test"
import assert from "node:assert/strict"
import type { ProjectCard, ProjectQueue, ThreadView } from "@ntwine/shared"
import { answerProse, handoffParts, isBusy, mergedQueue, queuesProjects, threadKey, liveQueue, overlayQueues } from "./allQueues.ts"

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
  ], { doneCount: 4 })])
  assert.deepEqual(project!.queued.map((t) => t.id), ["older-rest", "pinned-ask", "newer-rest"])
  assert.deepEqual(project!.running.map((t) => t.id), ["spinning"])
  assert.deepEqual(project!.snoozed.map((t) => t.id), ["parked"])
  assert.equal(project!.doneCount, 4)
})

test("a project is busy with a queue or live work — never with parked work alone", () => {
  const projects = queuesProjects([card("a"), card("b"), card("c"), card("d")], [
    queue("a", [thread("q1", { needsYou: true })]),
    queue("b", [thread("r1", { runtime: "running" })]),
    queue("c", [thread("parked", { snoozedUntil: "2099-01-01T00:00:00.000Z" })]),
    queue("d", []),
  ])
  assert.deepEqual(projects.map(isBusy), [true, true, false, false])
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
  assert.deepEqual(parts.fences, [{ kind: "done", body: "- Drafted three variants", hints: [] }])
})

// The card heads a to-do with the fence's own title and lists its steps (AllQueuesCard FenceBody), so
// the frontmatter has to survive the split: a steps fence's BODY is empty by design, and the card drew a
// bare "Awaiting" over nothing when only the body came through (2026-10-06).
test("an awaiting fence keeps its frontmatter, so a steps-only fence still carries its title and steps", () => {
  const parts = handoffParts("You can use it two ways.\n\n```awaiting\ntitle: Restart Ntwine\nsteps:\n  - Restart Ntwine.\n  - Start a new thread.\n```")
  assert.equal(parts.prose, "You can use it two ways.")
  assert.deepEqual(parts.fences, [{
    kind: "awaiting",
    body: "",
    hints: [{ kind: "title", value: "Restart Ntwine" }, { kind: "step", value: "Restart Ntwine." }, { kind: "step", value: "Start a new thread." }],
  }])
})

test("with nothing registered, a question fence with a body is KEPT — on a legacy thread it is the live ask", () => {
  const parts = handoffParts("Pick one.\n\n```question\nSeconds or epoch?\nA. Seconds\nB. Epoch\n```")
  assert.equal(parts.questions.length, 1)
  assert.equal(parts.prose, "Pick one.")
})

test("an archived row whose worker is still running is listed under Running; one at rest is counted Done", () => {
  const [project] = queuesProjects([card("a")], [queue("a", [
    // A sub-agent still running lifts an archived thread into Running until it rests (upstream 2026-07-10):
    // Done is collapsed, and a running worker filed there would be invisible. Its state stays archived.
    thread("sub-agent-out", { state: "archived", archived: true, subAgents: [{ id: "s1", state: "running", depth: 1 } as never] }),
    thread("draining", { state: "archived", archived: true, runtime: "running" }),
    // A background wait is not live work (an armed timer parks), so this one is Done — counted, as an
    // older server that sent every archived row would have it.
    thread("parked", { state: "archived", archived: true, awaitingBackground: true, watches: [{ kind: "timer", state: "armed" }] as never }),
  ], { doneCount: 5 })])
  assert.deepEqual(project!.running.map((t) => t.id).sort(), ["draining", "sub-agent-out"])
  assert.equal(project!.doneCount, 6)
})

test("a PINNED Done thread is a Pinned row, never a number in Done — from the poll and from the live board", () => {
  // The poll sends it apart (server router.ts projectsQueues `pinnedDone`), outside its Done count.
  const [polled] = queuesProjects([card("a")], [queue("a", [], {
    doneCount: 3,
    pinnedDone: [thread("later-pin", { state: "archived", pinnedAt: "2026-10-02T00:00:00.000Z" }), thread("first-pin", { state: "archived", pinnedAt: "2026-10-01T00:00:00.000Z" })],
  })])
  assert.deepEqual(polled!.pinnedDone.map((t) => t.id), ["first-pin", "later-pin"], "oldest pin first, the shelf's own order")
  assert.equal(polled!.doneCount, 3)
  // The focused project's live board sends every thread, archived ones included (liveQueue) — while the
  // poll it is drawn over still carries the same pinned Done thread apart, as the server always sends it.
  const donePin = thread("done-pin", { state: "archived", archived: true, pinnedAt: "2026-10-01T00:00:00.000Z" })
  const live = liveQueue([queue("a", [], { doneCount: 9, pinnedDone: [donePin] })], {
    projectSlug: "a",
    threads: [thread("open"), donePin, thread("done", { state: "archived", archived: true })],
  }, "a")
  const [focused] = queuesProjects([card("a")], [live!])
  assert.deepEqual(focused!.pinnedDone.map((t) => t.id), ["done-pin"], "once: the board's copy, not the poll's as well")
  assert.equal(focused!.doneCount, 1, "only the unpinned Done thread is counted")
  assert.deepEqual([...focused!.queued, ...focused!.running, ...focused!.snoozed].map((t) => t.id), ["open"])
})

test("a thread's terminals ride its row: one at a prompt queues the thread, and no terminal rows on its own", () => {
  const terminal = (id: string, over: Partial<NonNullable<ThreadView["terminals"]>[number]> = {}) => ({ id, command: "npm publish", cwd: "/repo", state: "running" as const, runId: 1, startedAt: "2026-09-29T09:00:00.000Z", ...over })
  const [project] = queuesProjects([card("a")], [queue("a", [
    // The server queued it for the terminal's OTP prompt (board.ts withThreadTerminals).
    thread("publishes", { runtime: "turn-idle", needsYou: true, terminals: [terminal("term-otp", { awaitingInput: true })] }),
    thread("serves", { runtime: "running", terminals: [terminal("term-dev", { command: "npm run dev" })] }),
  ])])
  assert.deepEqual(project!.queued.map((t) => t.id), ["publishes"])
  assert.deepEqual(project!.running.map((t) => t.id), ["serves"])
  const ids = [...project!.queued, ...project!.running].map((t) => t.id)
  assert.equal(ids.some((id) => id.startsWith("term-")), false)
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

// THE PAGE'S ONE QUEUE (David 2026-09-28: "One queue across all projects").
test("every project's ready threads merge into one queue, in the order each entered it", () => {
  const ready = (id: string, queuedAt: string) => thread(id, { needsYou: true, queuedAt: `2026-09-23T${queuedAt}:00.000Z`, lastAssistantAt: "2026-09-23T08:00:00.000Z" })
  // `app` is listed ABOVE `ntwine` in the rail. Its first ready thread arrives at 10:30, after both of
  // ntwine's: it joins the bottom, where lanes in rail order drew its whole lane above the card being read.
  const projects = queuesProjects([card("app"), card("ntwine")], [
    queue("app", [ready("pr-1402", "10:30")]),
    queue("ntwine", [ready("fix-auth", "10:00"), ready("2fa", "10:10")]),
  ])
  assert.deepEqual(mergedQueue(projects).map(({ project, thread }) => threadKey(project.id, thread.id)), ["ntwine/fix-auth", "ntwine/2fa", "app/pr-1402"])
})

test("two projects' threads with the same slug stay two cards, each with its own project", () => {
  const projects = queuesProjects([card("a"), card("b")], [
    queue("a", [thread("fix-auth", { needsYou: true, queuedAt: "2026-09-23T10:00:00.000Z" })]),
    queue("b", [thread("fix-auth", { needsYou: true, queuedAt: "2026-09-23T09:00:00.000Z" })]),
  ])
  assert.deepEqual(mergedQueue(projects).map(({ project, thread }) => `${project.id}/${thread.id}`), ["b/fix-auth", "a/fix-auth"])
})

test("a project the poll answered unchanged keeps its object, so the list can skip re-rendering it", () => {
  const cards = [card("a"), card("b")]
  const a = queue("a", [thread("x", { needsYou: true })])
  const first = queuesProjects(cards, [a, queue("b", [])])
  // The next poll: `a` structurally shared by the query cache, `b` changed.
  const second = queuesProjects(cards, [a, queue("b", [thread("y")])])
  assert.equal(second[0], first[0])
  assert.notEqual(second[1], first[1])
})

test("a done supersedes the earlier answer; a status line after a wake does not", () => {
  const answer = "The six scouts are still reading the codebase."
  assert.equal(answerProse(answer, handoffParts("**Fixed** — landed.\n\n```done\n- Shipped it.\n```"), false), "", "a fenced done")
  assert.equal(answerProse(answer, handoffParts("**Fixed** — landed."), true), "", "a registered done")
  assert.equal(answerProse(answer, handoffParts("Every check is green; nothing has changed."), false), answer)
  assert.equal(answerProse(`${answer}\n\n\`\`\`awaiting\nfor: 1h\n---\nScouts.\n\`\`\``, handoffParts("Still green."), false), answer, "its own fences are dropped")
  assert.equal(answerProse(undefined, null, false), "")
})
