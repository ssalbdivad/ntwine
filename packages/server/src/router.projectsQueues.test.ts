import assert from "node:assert/strict"
import { tmpdir } from "node:os"
import test from "node:test"
import { parkExpiredWakeMessage, parseParkWake, questionAnswerMessage, SIGNOFF_NUDGE_MESSAGE, type BoardSnapshot, type ThreadView, type TranscriptMessage } from "@frizz/shared"
import { createRouter, handoffOf } from "./router.ts"
import type { AppContext } from "./context.ts"
import type { BoardManager } from "./board.ts"
import type { Project } from "./project.ts"

// The All queues page. Handlers are lazy, so the stub carries only what `createRouter` resolves up front
// plus this procedure's one dependency — `activeTenants`, the server's view of which projects are open.
function harness(activeTenants: AppContext["activeTenants"], own?: { project: Project; board: BoardManager }) {
  const ctx = {
    project: own?.project ?? { dir: tmpdir(), stateDir: tmpdir(), id: "own" },
    storage: {},
    board: own?.board ?? {},
    tailer: {},
    activeTenants,
  } as unknown as AppContext
  return createRouter(ctx)
}

const project = (id: string): Project => ({ id, dir: `/work/${id}`, stateDir: tmpdir(), name: id, label: id, cwdSlug: id })
const board = (threads: Partial<ThreadView>[], meta: Partial<BoardSnapshot> = {}): BoardManager =>
  ({ snapshot: async () => ({ threads, ...meta }) as unknown as BoardSnapshot }) as unknown as BoardManager
const session = (id: string, extra: Partial<ThreadView> = {}): Partial<ThreadView> =>
  ({ id, kind: "session", state: "open", runtime: "turn-idle", ...extra })

test("answers every open project with its open threads, its Done count and the identity its own board is stamped with", async () => {
  const router = harness(() => [
    {
      project: project("a"),
      board: board(
        [
          session("queued", { needsYou: true }),
          session("running", { runtime: "running" }),
          session("snoozed", { snoozedUntil: "2099-01-01T00:00:00.000Z" }),
          session("finished", { state: "archived" }),
          session("finished-2", { state: "archived" }),
          // An archived thread whose worker is still moving travels with the open threads — the client's
          // sectionOf lifts it into Running until it rests (Colin 2026-07-10) — and is not counted as Done.
          session("wrapping-up", { state: "archived", runtime: "running" }),
          session("sub-agent-out", { state: "archived", subAgents: [{ state: "running" } as never] }),
          session("sub-agent-back", { state: "archived", subAgents: [{ state: "completed" } as never] }),
          // A project's own terminal is read-only and never queues; a legacy row is not a session.
          session("terminal", { foreign: true, needsYou: true }),
          { id: "legacy", kind: "legacy" },
          // A thread's terminals ride its row; the thread is listed, the terminal never is.
          session("publishing", { needsYou: true, terminals: [{ id: "term-otp", command: "npm publish", cwd: "/work/alpha", state: "running", awaitingInput: true, runId: 1, startedAt: "2026-09-29T09:00:00.000Z" }] }),
        ],
        { projectSlug: "alpha", projectName: "Alpha", projectDir: "/work/alpha", homeDir: "/home/me", githubRepo: "me/alpha" },
      ),
    },
    // No registry slug on the snapshot (a pre-restart board): the id still addresses it.
    { project: project("b"), board: board([], {}) },
    // A board mid-deactivation throws from snapshot(); that project is absent this round, the rest answer.
    { project: project("c"), board: { snapshot: async () => { throw new Error("board stopped") } } as unknown as BoardManager },
  ])
  const queues = await router.projectsQueues.handler({ input: undefined })
  assert.deepEqual(queues.map((q) => q.projectId), ["a", "b"])
  const [alpha, beta] = queues
  assert.deepEqual(
    { projectSlug: alpha!.projectSlug, projectName: alpha!.projectName, projectDir: alpha!.projectDir, homeDir: alpha!.homeDir, githubRepo: alpha!.githubRepo },
    { projectSlug: "alpha", projectName: "Alpha", projectDir: "/work/alpha", homeDir: "/home/me", githubRepo: "me/alpha" },
  )
  assert.deepEqual(alpha!.threads.map((t) => t.id), ["queued", "running", "snoozed", "wrapping-up", "sub-agent-out", "publishing"])
  assert.equal(alpha!.doneCount, 3)
  assert.deepEqual(alpha!.recentDone?.map((t) => t.id).sort(), ["finished", "finished-2", "sub-agent-back"])
  assert.deepEqual(alpha!.threads.find((t) => t.id === "publishing")?.terminals?.map((t) => t.id), ["term-otp"])
  assert.deepEqual(
    { projectSlug: beta!.projectSlug, projectName: beta!.projectName, projectDir: beta!.projectDir, threads: beta!.threads, doneCount: beta!.doneCount },
    { projectSlug: "b", projectName: "b", projectDir: "/work/b", threads: [], doneCount: 0 },
  )
})

test("carries each project's most recently rested Done threads, newest first and capped, for the `@` typeahead", async () => {
  const rested = (i: number) => session(`done-${i}`, { state: "archived", lastAssistantAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString() })
  const router = harness(() => [{ project: project("a"), board: board(Array.from({ length: 25 }, (_, i) => rested(i))) }])
  const [alpha] = await router.projectsQueues.handler({ input: undefined })
  assert.equal(alpha!.doneCount, 25)
  assert.deepEqual(alpha!.recentDone?.map((t) => t.id), Array.from({ length: 20 }, (_, i) => `done-${24 - i}`))
})

test("a PINNED Done thread rides along whole, outside the Done count, so every project's Pinned band can row it", async () => {
  // The pinned-Done hole (plans/upstream-superset.md §2): the archived filter ran before anything looked
  // at the pin, so a pinned thread finished in a project the page was not on had no row on All projects.
  const router = harness(() => [
    {
      project: project("a"),
      board: board([
        session("open-pin", { pinnedAt: "2026-10-01T00:00:00.000Z", needsYou: true }),
        session("done-pin", { state: "archived", pinnedAt: "2026-10-02T00:00:00.000Z" }),
        session("done-plain", { state: "archived" }),
        // A foreign session never rows, pinned field or not.
        session("foreign-pin", { state: "archived", foreign: true, pinnedAt: "2026-10-03T00:00:00.000Z" }),
      ]),
    },
    { project: project("b"), board: board([session("done", { state: "archived" })]) },
  ])
  const [alpha, beta] = await router.projectsQueues.handler({ input: undefined })
  assert.deepEqual(alpha!.threads.map((t) => t.id), ["open-pin"], "open threads are unchanged: a Done one never joins them")
  assert.deepEqual(alpha!.pinnedDone?.map((t) => t.id), ["done-pin"])
  assert.equal(alpha!.doneCount, 1, "the Done band's count, as the project's own board files it: the pinned one is under Pinned")
  assert.deepEqual(alpha!.recentDone?.map((t) => t.id).sort(), ["done-pin", "done-plain"], "the typeahead still offers every Done thread")
  assert.equal(beta!.pinnedDone, undefined, "absent when there are none")
  assert.equal(beta!.doneCount, 1)
})

test("without a tenant map (a test context, a one-project server) it answers for its own project alone", async () => {
  const router = harness(undefined, { project: project("solo"), board: board([session("x", { needsYou: true })], { projectSlug: "solo" }) })
  const queues = await router.projectsQueues.handler({ input: undefined })
  assert.deepEqual(queues.map((q) => [q.projectId, q.threads.length]), [["solo", 1]])
})

const msg = (role: "user" | "assistant", text: string, extra: Partial<TranscriptMessage> = {}): TranscriptMessage =>
  ({ role, text, tools: [], at: "2026-09-23T10:00:00.000Z", ...extra }) as TranscriptMessage

test("a handoff is the last assistant message that says something, and the human's last message before it", () => {
  const handoff = handoffOf([
    msg("user", "TASK:\nFix the cursor."),
    msg("assistant", "Reading the cursor."),
    msg("user", "Also check the tie-break.", { displayText: "Also check the tie-break." }),
    msg("assistant", "Working on it."),
    // A wake, a sub-agent steer and a peer's report are Frizz or another agent speaking, not the human.
    msg("user", "PR #12 has new review activity", { wake: true }),
    msg("user", "<agent-message from=\"Explore\">found it</agent-message>", { peerFrom: "Explore" }),
    // …and so is another thread messaging this one (it projects as `sessionPeer`, with no `peerFrom`).
    msg("user", "the audit is in", { sessionPeer: { name: "audit-run" } }),
    msg("assistant", "**Fixed** — ties no longer skip rows.\n\n```done\n- Fixed it\n```"),
    // Trailing tools-only step and transcript punctuation are not the handoff.
    msg("assistant", ""),
    msg("assistant", "Agent finished", { kind: "event" }),
  ])
  assert.equal(handoff.text, "**Fixed** — ties no longer skip rows.\n\n```done\n- Fixed it\n```")
  assert.equal(handoff.asked, "Also check the tie-break.")
})

test("an ANSWER to a registered question is the human's turn, though Frizz delivered it as a wake", () => {
  const answered = questionAnswerMessage([{ questionId: "qst_1", question: "Seconds or epoch?", chosen: ["Seconds"] }])
  const handoff = handoffOf([
    msg("user", "TASK:\nAdd the rate-limit headers."),
    msg("assistant", "**Needs you** — seconds or epoch?"),
    msg("user", `${answered}\n\n<!-- frizz-wake:abc -->`, { wake: true, displayText: answered }),
    msg("assistant", "**Fixed** — seconds it is."),
  ])
  assert.equal(handoff.asked, answered, "the card quotes the answer, not the task before it")
  assert.equal(handoff.text, "**Fixed** — seconds it is.")
})

test("an \"Ask for update\" click is the human's turn, quoted by its head line alone", () => {
  // 2026-10-06: skipping it quoted a retry typed hours earlier over the progress note the click produced.
  const requested = parkExpiredWakeMessage(["- `agent: a01b2d20b32feab11` — still running"], true, true)
  const handoff = handoffOf([
    msg("user", "Continue exactly where you left off."),
    msg("assistant", "You've hit your weekly limit"),
    msg("assistant", "Parked.\n\n```awaiting\nagents: [a01b2d20b32feab11]\nneeds_input: false\nfor: 30m\n```"),
    msg("user", `${requested}\n\n<!-- frizz-wake:abc -->`, { wake: true, displayText: requested }),
    msg("assistant", "Progress since my last note: the second review pass is running."),
  ])
  assert.equal(handoff.asked, requested.split("\n")[0])
  assert.equal(parseParkWake(handoff.asked!)?.kind, "requested", "the card can still tell it is the click")
  assert.equal(handoff.text, "Progress since my last note: the second review pass is running.")
  assert.equal(handoff.answer, undefined)
  // The expiry the same park reaches on its own clock is Frizz's, not the human's.
  const expired = handoffOf([msg("user", "Go."), msg("user", parkExpiredWakeMessage([], true), { wake: true }), msg("assistant", "Still going.")])
  assert.equal(expired.asked, "Go.")
})

test("a reply belongs to the human's LAST turn: a turn with no reply yet has an ask and no text", () => {
  const handoff = handoffOf([
    msg("user", "TASK:\nFix the cursor."),
    msg("assistant", "**Fixed** — ties no longer skip rows."),
    msg("user", "Also backfill the old cursors."),
  ])
  assert.equal(handoff.asked, "Also backfill the old cursors.")
  assert.equal(handoff.text, undefined, "the earlier reply answered an earlier turn")
  // A QUEUED send has not been delivered, so it is not a turn yet.
  const queued = handoffOf([msg("user", "TASK:\nGo."), msg("assistant", "Done."), msg("user", "One more thing", { queued: true })])
  assert.equal(queued.asked, "TASK:\nGo.")
  assert.equal(queued.text, "Done.")
})

test("a reply to the sign-off nudge carries the message it signs off, so 'nothing to add' is never the whole card", () => {
  const nudge = msg("user", `${SIGNOFF_NUDGE_MESSAGE}\n\n(It is now 22:32.)`, { wake: true })
  const handoff = handoffOf([
    msg("user", "TASK:\nShip it."),
    msg("assistant", "Shipped."),
    msg("user", "Can we migrate before publishing?"),
    msg("assistant", "Not quite: copy the code in, or publish first."),
    nudge,
    msg("assistant", ""),
    msg("assistant", "Nothing to add; my previous message has the full answer."),
  ])
  assert.equal(handoff.text, "Not quite: copy the code in, or publish first.\n\nNothing to add; my previous message has the full answer.")
  assert.equal(handoff.asked, "Can we migrate before publishing?")
  // Any OTHER wake is new input with its own answer, so it does not bridge.
  const woke = handoffOf([
    msg("user", "Watch CI."),
    msg("assistant", "Watching."),
    msg("user", "PR #12 went green", { wake: true }),
    msg("assistant", "Green."),
  ])
  assert.equal(woke.text, "Green.")
  // Nor does a nudge with no reply before it in this turn reach past the human's message.
  const fresh = handoffOf([msg("assistant", "Old answer."), msg("user", "New ask."), nudge, msg("assistant", "Done.")])
  assert.equal(fresh.text, "Done.")
})

test("wakes that rest after the human's answer keep that answer on the card, as its own part", () => {
  const nudge = msg("user", `${SIGNOFF_NUDGE_MESSAGE}\n\n(It is now 14:49.)`, { wake: true })
  // @yes-0-1-0, 2026-10-01, in the shape the transcript projects: the question answered, the sign-off
  // nudge, a shell wake (only a `wake` boundary, no user message), then a CI wake.
  const rest = msg("assistant", "Agent rested", { kind: "event", boundary: "rest" })
  const handoff = handoffOf([
    msg("user", "TASK:\nBump yes."),
    msg("assistant", "Parked on CI.\n\n```awaiting\nprs: [a/b#1]\nfor: 3d\n---\nCI.\n```"),
    rest,
    msg("user", "Where was the Buffer case?"),
    msg("assistant", "Looking."),
    msg("assistant", "It's `putPrivateObject`."),
    rest,
    nudge,
    msg("assistant", "```awaiting\nprs: [a/b#1]\nfor: 3d\n---\nCI.\n```"),
    rest,
    msg("assistant", "Agent terminal finished", { kind: "event", boundary: "wake" }),
    msg("assistant", ""),
    msg("assistant", "Asked about the merge."),
    rest,
    msg("user", "CI PASSED on a/b#1", { wake: true }),
    msg("assistant", "Every check is green; nothing has changed."),
    rest,
  ])
  assert.equal(handoff.asked, "Where was the Buffer case?")
  assert.equal(handoff.answer, "It's `putPrivateObject`.\n\n```awaiting\nprs: [a/b#1]\nfor: 3d\n---\nCI.\n```", "the rest that answered, nudge reply and all, not the narration before it")
  assert.equal(handoff.text, "Every check is green; nothing has changed.", "the newest rest; the wake reply between is dropped")
  // No wake after the answer: the newest rest IS the answer, and the narration before it is not one.
  const plain = handoffOf([msg("user", "Where?"), msg("assistant", "Looking."), msg("assistant", "Here."), rest, nudge, msg("assistant", "Nothing to add."), rest])
  assert.equal(plain.answer, undefined)
  assert.equal(plain.text, "Here.\n\nNothing to add.")
  // A wake the worker answered without saying anything leaves nothing to separate.
  const silent = handoffOf([msg("user", "Where?"), msg("assistant", "Here."), msg("user", "CI went green", { wake: true }), msg("assistant", "")])
  assert.equal(silent.answer, undefined)
  assert.equal(silent.text, "Here.")
})

test("an answer written before the work it starts rides the rest's card; narration between tool calls does not", () => {
  // @disk-usage, 2026-10-07: the human asked, the worker answered, dispatched a sub-agent, and rested on a
  // fence whose body was one status line. The card showed the status line alone.
  const answer = "A few real risks, and each one has a fix:\n\n- Ignored files that cannot be rebuilt."
  const fence = "```awaiting\nagents: [ada5091be0b1e047e]\nstatus: needs_input\nfor: 30m\n---\nThe sub-agent is building it.\n```"
  const handoff = handoffOf([
    msg("user", "Any real risk?"),
    msg("assistant", answer),
    msg("assistant", "Dispatching the build."),
    msg("assistant", "", { tools: [{ id: "t1", name: "Agent" } as TranscriptMessage["tools"][number]] }),
    msg("assistant", "Agent started", { kind: "event" }),
    msg("assistant", fence),
  ])
  assert.equal(handoff.text, `${answer}\n\n${fence}`, "the answer, then the rest; the one-line narration stays off")
  assert.equal(handoff.asked, "Any real risk?")
  // An EARLIER turn's write-up is not this rest's: a rest or wake line ends the turn.
  const rest = msg("assistant", "Agent rested", { kind: "event", boundary: "rest" })
  const earlier = handoffOf([msg("user", "Go."), msg("assistant", answer), rest, msg("assistant", "Agent finished", { kind: "event", boundary: "wake" }), msg("assistant", "Still going.")])
  assert.equal(earlier.text, "Still going.")
})

test("an empty window has no handoff, a thread that has not spoken has only its ask, and a very long ask is clipped", () => {
  assert.deepEqual(handoffOf([]), {})
  assert.deepEqual(handoffOf([msg("user", "TASK:\nGo.")]), { asked: "TASK:\nGo.", askedAt: "2026-09-23T10:00:00.000Z" })
  const long = "x".repeat(5000)
  const handoff = handoffOf([msg("user", long), msg("assistant", "Done.")])
  assert.equal(handoff.asked?.length, 1200)
  assert.ok(handoff.asked?.endsWith("…"))
})
