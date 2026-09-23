import assert from "node:assert/strict"
import { tmpdir } from "node:os"
import test from "node:test"
import { questionAnswerMessage, type BoardSnapshot, type ThreadView, type TranscriptMessage } from "@frizz/shared"
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
          // Archived but its turn is still going: the project's own rail keeps it in Active, not Done.
          session("wrapping-up", { state: "archived", runtime: "running" }),
          // …and so is one whose turn is over while a sub-agent it dispatched still runs. A finished one
          // is not live work, so that thread is Done.
          session("sub-agent-out", { state: "archived", subAgents: [{ state: "running" } as never] }),
          session("sub-agent-back", { state: "archived", subAgents: [{ state: "completed" } as never] }),
          // A project's own terminal is read-only and never queues; a legacy row is not a session.
          session("terminal", { foreign: true, needsYou: true }),
          { id: "legacy", kind: "legacy" },
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
  assert.deepEqual(alpha!.threads.map((t) => t.id), ["queued", "running", "snoozed", "wrapping-up", "sub-agent-out"])
  assert.equal(alpha!.doneCount, 3)
  assert.deepEqual(
    { projectSlug: beta!.projectSlug, projectName: beta!.projectName, projectDir: beta!.projectDir, threads: beta!.threads, doneCount: beta!.doneCount },
    { projectSlug: "b", projectName: "b", projectDir: "/work/b", threads: [], doneCount: 0 },
  )
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

test("an empty window has no handoff, a thread that has not spoken has only its ask, and a very long ask is clipped", () => {
  assert.deepEqual(handoffOf([]), {})
  assert.deepEqual(handoffOf([msg("user", "TASK:\nGo.")]), { asked: "TASK:\nGo.", askedAt: "2026-09-23T10:00:00.000Z" })
  const long = "x".repeat(5000)
  const handoff = handoffOf([msg("user", long), msg("assistant", "Done.")])
  assert.equal(handoff.asked?.length, 1200)
  assert.ok(handoff.asked?.endsWith("…"))
})
