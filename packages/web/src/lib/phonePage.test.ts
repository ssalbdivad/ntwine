import { test } from "node:test"
import assert from "node:assert/strict"
import type { ProjectCard, ThreadView } from "@ntwine/shared"
import { queuesProjects, threadKey, type QueuesProject } from "./allQueues.ts"
import { listOverlay } from "./listBands.ts"
import { phoneBands, phoneCounts, phoneSubtitle } from "./phonePage.ts"

// The phone page's bands, across the projects a view shows (components/PhonePage.tsx): the desktop list's
// own (lib/listBands.ts loudBands, components/TierList.tsx), merged across projects as that list merges them.

const NOW = Date.parse("2026-09-30T12:00:00.000Z")
const ago = (ms: number) => new Date(NOW - ms).toISOString()

/** A Ready thread that entered the queue `queuedMsAgo` ago — a plain handoff unless `over` makes it an ask. */
const ready = (id: string, queuedMsAgo: number, over: Partial<ThreadView> = {}) =>
  ({
    id,
    title: id,
    kind: "session",
    state: "open",
    status: "active",
    runtime: "turn-idle",
    needsYou: true,
    queuedAt: ago(queuedMsAgo),
    spawnedAt: ago(3_600_000),
    lastUserAt: ago(3_600_000),
    lastActivityAt: ago(queuedMsAgo),
    subAgents: [],
    watches: [],
    questions: [],
    ...over,
  }) as unknown as ThreadView
const ask = (id: string, queuedMsAgo: number) => ready(id, queuedMsAgo, { humanBlocked: true, questions: [{ id: `q-${id}`, askedAt: ago(queuedMsAgo), spec: { question: "A or B?", kind: "question" } }] as ThreadView["questions"] })
const running = (id: string, userMsAgo: number) => ready(id, 0, { runtime: "running", needsYou: false, queuedAt: undefined, lastUserAt: ago(userMsAgo), lastActivityAt: ago(1_000) })
const snoozed = (id: string, activeMsAgo: number) => ready(id, 0, { needsYou: false, queuedAt: undefined, snoozedUntil: "2999-01-01T00:00:00.000Z", lastActivityAt: ago(activeMsAgo), lastUserAt: ago(activeMsAgo) })
const done = (id: string, activeMsAgo: number) => ready(id, 0, { needsYou: false, queuedAt: undefined, state: "archived", status: "done", lastActivityAt: ago(activeMsAgo), lastUserAt: ago(activeMsAgo) })

const project = (id: string, over: Partial<QueuesProject> = {}): QueuesProject =>
  ({ id, slug: id, name: id, card: undefined, open: true, stale: false, projectDir: `/w/${id}`, homeDir: "/home/x", githubRepo: undefined, queued: [], running: [], snoozed: [], pinnedDone: [], recentDone: [], doneCount: 0, ...over }) as QueuesProject

const names = (rows: readonly { project: QueuesProject; thread: ThreadView }[]) => rows.map((r) => `${r.project.id}:${r.thread.id}`)
const bands = (projects: QueuesProject[], hidden?: (key: string) => boolean, overlay?: Parameters<typeof phoneBands>[2]) => phoneBands(projects, hidden, overlay, NOW)

test("Ready merges every shown project into ONE queue order; Working keeps each project's rows together", () => {
  const alpha = project("alpha", { queued: [ready("a-old", 50 * 60_000), ask("a-ask", 5 * 60_000)], running: [running("a-run", 30 * 60_000), running("a-run2", 1_000)] })
  const beta = project("beta", { queued: [ready("b-mid", 20 * 60_000), ask("b-ask", 40 * 60_000)], running: [running("b-run", 2 * 60_000)] })
  const out = bands([alpha, beta])
  // The desktop's cards' order, oldest in the queue first — an ask is not lifted out of it.
  assert.deepEqual(names(out.ready), ["alpha:a-old", "beta:b-ask", "beta:b-mid", "alpha:a-ask"])
  // A project's run, newest interaction first within it, in the project order.
  assert.deepEqual(names(out.working), ["alpha:a-run2", "alpha:a-run", "beta:b-run"])
})

test("a pin takes its thread out of every other band, open or Done, in pin order", () => {
  const pinnedLate = ready("pinned-late", 10_000, { pinnedAt: ago(1_000) })
  const pinnedEarly = running("pinned-early", 60_000)
  pinnedEarly.pinnedAt = ago(9_000)
  const shelvedDone = { ...done("shelved", 5_000), pinnedAt: ago(5_000) }
  const alpha = project("alpha", { queued: [ask("a-ask", 60_000), pinnedLate], running: [pinnedEarly], pinnedDone: [shelvedDone], recentDone: [shelvedDone] })
  const out = bands([alpha])
  assert.deepEqual(names(out.pinned), ["alpha:pinned-early", "alpha:shelved", "alpha:pinned-late"])
  assert.deepEqual(names([...out.ready, ...out.working, ...out.done]), ["alpha:a-ask"])
})

test("a same-slug thread in two projects is two rows with two keys", () => {
  const out = bands([project("alpha", { queued: [ready("fix-auth", 60_000)] }), project("beta", { queued: [ready("fix-auth", 30_000)] })])
  assert.deepEqual(out.ready.map((r) => r.key), [threadKey("alpha", "fix-auth"), threadKey("beta", "fix-auth")])
})

test("a card being finished keeps its row under Working, and a steer moves its row to Working at once", () => {
  const alpha = project("alpha", { queued: [ready("leaving", 60_000), ready("replied", 40_000), ready("waiting", 20_000)] })
  const hidden = (key: string) => key === threadKey("alpha", "leaving")
  const steered = { [threadKey("alpha", "replied")]: NOW - 100 }
  const out = bands([alpha], hidden, (p) => listOverlay(p.id, false, steered, {}, NOW))
  assert.deepEqual(names(out.ready), ["alpha:waiting"])
  assert.deepEqual(names(out.working), ["alpha:replied", "alpha:leaving"])
  assert.equal(out.working[0]!.thread.runtime, "running", "the steered row reads as running, so its mark and the count agree")
})

test("the view line counts asks apart from the rest of Ready, and never says nothing needs you over a queue", () => {
  // A permission request waiting on the human wears the "?" too, so it is an ask.
  const approval = ready("approve-bash", 90_000, { actionableInteraction: { id: "i1" } } as Partial<ThreadView>)
  const alpha = project("alpha", { queued: [ask("a-ask", 60_000), ready("handoff", 30_000), approval], running: [running("run", 1_000)] })
  assert.deepEqual(phoneCounts(bands([alpha])), { asks: 2, ready: 1, working: 1 })
  assert.deepEqual(phoneSubtitle(phoneCounts(bands([alpha]))), { accent: "2 need you", rest: "1 ready · 1 working" })
  // Four handoffs and no asks: what the sidebar spike showed under "Nothing needs you" (2026-10-01).
  const handoffs = project("beta", { queued: [ready("a", 40_000), ready("b", 30_000), ready("c", 20_000), ready("d", 10_000)] })
  assert.deepEqual(phoneSubtitle(phoneCounts(bands([handoffs]))), { accent: null, rest: "4 ready" })
  assert.deepEqual(phoneSubtitle({ asks: 1, ready: 0, working: 0 }), { accent: "1 needs you", rest: null })
  assert.deepEqual(phoneSubtitle(phoneCounts(bands([]))), { accent: null, rest: "Nothing needs you" })
})

test("Snoozed is the human's snoozes alone; Done today is what rested since midnight, newest first", () => {
  const agentPark = ready("agent-park", 0, { needsYou: false, queuedAt: undefined, snoozedUntil: undefined })
  const alpha = project("alpha", {
    snoozed: [snoozed("a-zz", 60_000), ready("a-zz-pinned", 0, { pinnedAt: ago(5), snoozedUntil: "2999-01-01T00:00:00.000Z" }), agentPark],
    recentDone: [done("a-new", 5_000), done("a-yesterday", 30 * 3_600_000)],
  })
  const beta = project("beta", { snoozed: [snoozed("b-zz", 10_000)], recentDone: [done("b-mid", 30_000)] })
  const out = bands([alpha, beta])
  assert.deepEqual(names(out.snoozed), ["alpha:a-zz", "beta:b-zz"])
  assert.deepEqual(names(out.done), ["alpha:a-new", "beta:b-mid"])
})

test("an archived thread whose worker is still running is under Working, never in Done", () => {
  const draining = { ...done("a-draining", 1_000), runtime: "running" } as ThreadView
  const card = { id: "alpha", slug: "alpha", name: "alpha", path: "/w/alpha", lastOpenedAt: ago(0), stale: false, iconStatus: "none" } as ProjectCard
  const [alpha] = queuesProjects([card], [{ projectId: "alpha", projectSlug: "alpha", projectName: "alpha", projectDir: "/w/alpha", threads: [draining], doneCount: 1 }])
  const out = bands([alpha!])
  assert.deepEqual(names(out.working), ["alpha:a-draining"])
  assert.deepEqual(out.done, [])
  assert.equal(phoneCounts(out).working, 1)
})
