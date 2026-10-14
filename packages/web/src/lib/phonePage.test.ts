import { test } from "node:test"
import assert from "node:assert/strict"
import type { ProjectCard, ThreadView } from "@ntwine/shared"
import { queuesProjects, threadKey, type QueuesProject } from "./allQueues.ts"
import { listOverlay } from "./listBands.ts"
import { phoneCounts, phoneDone, phoneProjects, phoneQueue, phoneSnoozed, phoneSubtitle } from "./phonePage.ts"

// The phone page's tabs, across the projects a view shows (components/PhonePage.tsx). The rows are the
// desktop list's own bands (lib/listBands.ts loudBands); what is the phone's is the merge across projects
// and upstream's asks-first order inside the one Queue tab.

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
const snoozed = (id: string, activeMsAgo: number) => ready(id, 0, { needsYou: false, queuedAt: undefined, snoozedUntil: new Date(NOW + 3_600_000).toISOString(), lastActivityAt: ago(activeMsAgo), lastUserAt: ago(activeMsAgo) })
const done = (id: string, activeMsAgo: number) => ready(id, 0, { needsYou: false, queuedAt: undefined, state: "archived", status: "done", lastActivityAt: ago(activeMsAgo), lastUserAt: ago(activeMsAgo) })

const project = (id: string, over: Partial<QueuesProject> = {}): QueuesProject =>
  ({ id, slug: id, name: id, card: undefined, open: true, stale: false, projectDir: `/w/${id}`, homeDir: "/home/x", githubRepo: undefined, queued: [], running: [], snoozed: [], pinnedDone: [], doneCount: 0, ...over }) as QueuesProject

const names = (rows: readonly { project: QueuesProject; thread: ThreadView }[]) => rows.map((r) => `${r.project.id}:${r.thread.id}`)

test("the queue merges every shown project: asks first, then the rest of Ready in ONE queue order, then Working", () => {
  const alpha = project("alpha", { queued: [ready("a-old", 50 * 60_000), ask("a-ask", 5 * 60_000)], running: [running("a-run", 30 * 60_000)] })
  const beta = project("beta", { queued: [ready("b-mid", 20 * 60_000), ask("b-ask", 40 * 60_000)], running: [running("b-run", 2 * 60_000)] })
  assert.deepEqual(names(phoneQueue([alpha, beta])), [
    // Asks, oldest in the queue first, whichever project they are in.
    "beta:b-ask",
    "alpha:a-ask",
    // The rest of Ready in the same merged order — alpha's oldest card ahead of beta's.
    "alpha:a-old",
    "beta:b-mid",
    // Working by the human's last interaction, newest first.
    "beta:b-run",
    "alpha:a-run",
  ])
})

test("a pinned thread leads even the asks, in pin order, and is listed once", () => {
  const pinnedLate = ready("pinned-late", 10_000, { pinnedAt: ago(1_000) })
  const pinnedEarly = running("pinned-early", 60_000)
  pinnedEarly.pinnedAt = ago(9_000)
  const alpha = project("alpha", { queued: [ask("a-ask", 60_000), pinnedLate], running: [pinnedEarly] })
  const rows = names(phoneQueue([alpha]))
  assert.deepEqual(rows, ["alpha:pinned-early", "alpha:pinned-late", "alpha:a-ask"])
})

test("a pinned Done thread the poll carries is the Done tab's, not the queue's shelf — one tab per thread", () => {
  const shelved = { ...done("shelved", 5_000), pinnedAt: ago(9_000) }
  const alpha = project("alpha", { queued: [ask("a-ask", 60_000)], pinnedDone: [shelved] })
  assert.deepEqual(names(phoneQueue([alpha])), ["alpha:a-ask"])
  assert.deepEqual(names(phoneDone([alpha], () => ({ threads: [shelved] }))), ["alpha:shelved"])
})

test("a same-slug thread in two projects is two rows with two keys", () => {
  const rows = phoneQueue([project("alpha", { queued: [ready("fix-auth", 60_000)] }), project("beta", { queued: [ready("fix-auth", 30_000)] })])
  assert.deepEqual(rows.map((r) => r.key), [threadKey("alpha", "fix-auth"), threadKey("beta", "fix-auth")])
})

test("a card being finished keeps its row under Working, and a steer moves its row to Working at once", () => {
  const alpha = project("alpha", { queued: [ready("leaving", 60_000), ready("replied", 40_000), ready("waiting", 20_000)] })
  const hidden = (key: string) => key === threadKey("alpha", "leaving")
  const steered = { [threadKey("alpha", "replied")]: NOW - 100 }
  const rows = phoneQueue([alpha], hidden, (p) => listOverlay(p.id, false, steered, {}, NOW))
  assert.deepEqual(names(rows), ["alpha:waiting", "alpha:replied", "alpha:leaving"])
  assert.equal(rows[1]!.thread.runtime, "running", "the steered row reads as running, so its mark and the header count agree")
})

test("the header counts asks apart from the rest of Ready, and the spinning band", () => {
  const alpha = project("alpha", { queued: [ask("a-ask", 60_000), ready("handoff", 30_000)], running: [running("run", 1_000)] })
  const beta = project("beta", { queued: [ask("b-ask", 10_000)] })
  assert.deepEqual(phoneCounts(phoneQueue([alpha, beta])), { asks: 2, ready: 1, working: 1 })
  // A permission request waiting on the human wears the "?" too, so it is an ask: lifted with the others
  // and counted. `needsAction`, upstream's predicate, leaves it among the handoffs.
  const approval = ready("approve-bash", 90_000, { actionableInteraction: { id: "i1" } } as Partial<ThreadView>)
  const gamma = project("gamma", { queued: [ready("plain", 120_000), approval] })
  assert.deepEqual(names(phoneQueue([gamma])), ["gamma:approve-bash", "gamma:plain"])
  assert.deepEqual(phoneCounts(phoneQueue([gamma])), { asks: 1, ready: 1, working: 0 })
  assert.deepEqual(phoneCounts([]), { asks: 0, ready: 0, working: 0 })
})

test("the header never says nothing needs you over a queue that holds anything", () => {
  // Four handoffs and no asks: what the sidebar spike showed under "Nothing needs you" (2026-10-01).
  const handoffs = project("alpha", { queued: [ready("a", 40_000), ready("b", 30_000), ready("c", 20_000), ready("d", 10_000)] })
  assert.deepEqual(phoneSubtitle(phoneCounts(phoneQueue([handoffs]))), { accent: null, rest: "4 queued" })
  const mixed = project("beta", { queued: [ask("q", 60_000), ready("h", 30_000)], running: [running("r", 1_000)] })
  assert.deepEqual(phoneSubtitle(phoneCounts(phoneQueue([mixed]))), { accent: "1 needs you", rest: "1 queued · 1 working" })
  assert.deepEqual(phoneSubtitle({ asks: 2, ready: 0, working: 0 }), { accent: "2 need you", rest: null })
  assert.deepEqual(phoneSubtitle(phoneCounts([])), { accent: null, rest: "Nothing needs you" })
})

test("Snoozed and Done list every shown project's rows, most recently touched first", () => {
  const alpha = project("alpha", { snoozed: [snoozed("a-zz", 60_000), ready("a-zz-pinned", 0, { pinnedAt: ago(5), snoozedUntil: new Date(NOW + 60_000).toISOString() })] })
  const beta = project("beta", { snoozed: [snoozed("b-zz", 10_000)] })
  assert.deepEqual(names(phoneSnoozed([alpha, beta])), ["beta:b-zz", "alpha:a-zz"], "a pinned park is on the queue's shelf, not here")

  const boards: Record<string, { threads: ThreadView[] }> = {
    alpha: { threads: [done("a-old", 90_000), done("a-new", 5_000), ready("a-open", 1_000), done("a-pinned", 1_000)] },
    beta: { threads: [done("b-mid", 30_000)] },
  }
  boards.alpha!.threads[3]!.pinnedAt = ago(1)
  assert.deepEqual(names(phoneDone([alpha, beta], (p) => boards[p.id])), ["alpha:a-pinned", "alpha:a-new", "beta:b-mid", "alpha:a-old"])
  // A project whose board has not been read contributes nothing yet — never a guess.
  assert.deepEqual(names(phoneDone([alpha, beta], (p) => (p.id === "beta" ? boards.beta : undefined))), ["beta:b-mid"])
})

test("an archived thread whose worker is still running is under Working on the queue tab, never in Done", () => {
  // Upstream 2026-07-10: a running worker is never filed under Done, which is collapsed (a tab here). The
  // server sends the row with the open threads; the same sectionOf bands it on every surface.
  const draining = { ...done("a-draining", 1_000), runtime: "running" } as ThreadView
  const finished = done("a-finished", 5_000)
  const card = { id: "alpha", slug: "alpha", name: "alpha", path: "/w/alpha", lastOpenedAt: ago(0), stale: false, iconStatus: "none" } as ProjectCard
  const [alpha] = queuesProjects([card], [{ projectId: "alpha", projectSlug: "alpha", projectName: "alpha", projectDir: "/w/alpha", threads: [draining], doneCount: 1 }])
  assert.deepEqual(names(phoneQueue([alpha!])), ["alpha:a-draining"])
  assert.equal(phoneCounts(phoneQueue([alpha!])).working, 1)
  assert.deepEqual(names(phoneDone([alpha!], () => ({ threads: [draining, finished] }))), ["alpha:a-finished"])
})

test("the projects list leads with the busy ones, keeps Home last, and counts asks and Working", () => {
  const card = (id: string, home = false) => ({ id, slug: id, name: id, path: `/w/${id}`, lastOpenedAt: "", stale: false, iconStatus: "unknown", ...(home ? { home: true } : {}) }) as QueuesProject["card"]
  const quiet = project("quiet", { card: card("quiet"), snoozed: [snoozed("zz", 1_000)] })
  // Two asks and a handoff in Ready: the accent counts the asks alone (upstream ef6f7f23) — a handoff asks
  // nothing. `r2` is a card being finished, which still counts: it is still marked "?" on this page.
  const busy = project("busy", { card: card("busy"), queued: [ask("r1", 1_000), ask("r2", 2_000), ready("handoff", 3_000)], running: [running("w", 1_000), ready("excused", 0, { needsYou: false, queuedAt: undefined })] })
  const home = project("home", { card: card("home", true), queued: [ready("h", 1_000)] })
  const list = phoneProjects([quiet, home, busy], (key) => key === threadKey("busy", "r2"))
  // Working is the rail's Active band, which also takes a resting row the server excused from the queue
  // (`excused`): the badge's rule, so the list and the rail say the same number.
  assert.deepEqual(list.projects.map((e) => [e.project.id, e.asks, e.working]), [["busy", 2, 2], ["quiet", 0, 0]])
  assert.equal(list.home?.project.id, "home")
  assert.equal(list.home?.asks, 0, "a project of handoffs alone has no asks to count")
})

test("a project's ask count is the one its own Queue header shows, overlay and all", () => {
  // A permission request waiting on the human wears the "?", so it is counted here as the header counts it.
  const approval = ready("approve-bash", 90_000, { actionableInteraction: { id: "i1" } } as Partial<ThreadView>)
  const alpha = project("alpha", { queued: [ask("q1", 60_000), ask("q2", 30_000), approval, ready("handoff", 10_000)] })
  assert.equal(phoneProjects([alpha]).projects[0]!.asks, 3, "two questions and an approval")
  // The human approved the request a moment ago: it leaves the count on the list exactly as it leaves the
  // header, before the poll says so.
  const steered = { [threadKey("alpha", "approve-bash")]: NOW - 100 }
  const overlay = (p: QueuesProject) => listOverlay(p.id, false, steered, {}, NOW)
  const header = phoneCounts(phoneQueue([alpha], undefined, overlay)).asks
  assert.equal(header, 2)
  assert.equal(phoneProjects([alpha], undefined, overlay).projects[0]!.asks, header)
})
