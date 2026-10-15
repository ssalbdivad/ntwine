// A QUESTION THE HUMAN TYPED PAST (2026-10-14, shared questionPassedOver) — against real SQLite, the REAL
// board and the real router. It stays open and answerable where it was asked, and the board still sends
// it, flagged, so the transcript can draw it in place; but it no longer holds the thread: it queues
// nothing, and the done card is not superseded by it. Each case flips ONE input — whether the human's
// newest typed turn landed after the ask — on the same thread, so the control is the identical state.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NEEDS_INPUT_REQUIRED_AT, queueUrgency, type AwaitingHint, type Settings, type ThreadView } from "@ntwine/shared"
import { createBoard } from "./board.ts"
import { Bus } from "./bus.ts"
import { createRouter } from "./router.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import type { AppContext } from "./context.ts"
import type { Project } from "./project.ts"
import type { SessionTelemetry, Tailer } from "./tailer.ts"

const SPAWN = new Date(Date.parse(NEEDS_INPUT_REQUIRED_AT) + 60_000).toISOString()
const ASKED_MS = Date.parse(SPAWN) + 60_000
const BEFORE_ASK = new Date(ASKED_MS - 30_000).toISOString()
const AFTER_ASK = new Date(ASKED_MS + 30_000).toISOString()
const REST = new Date(ASKED_MS + 60_000).toISOString()
const NOW = Date.parse(REST) + 60_000

const LIVE_SHELL = { id: "toolu_shell", taskId: "bzvtnt3ig", label: "nub run bench", startedAt: REST, state: "running" as const }
// A quiet park on running work: out of the queue on its own, so only a question can put it back in.
const WORKING_PARK: AwaitingHint[] = [{ kind: "shell", value: "bzvtnt3ig" }, { kind: "for", value: "2h" }, { kind: "status", value: "working" }]

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-passed-over-"))
  const project: Project = { dir, id: "p", name: "fixture", label: "fixture", stateDir: dir, cwdSlug: "fixture" }
  const storage = createStorage(join(dir, "ui.db"), "p")
  let lastHumanAt = BEFORE_ASK
  const tailer = {
    get: () => ({
      turn: "idle", permPrompt: false, subAgents: [], bgShells: [LIVE_SHELL], pendingQuestion: false,
      lastAssistantAt: REST, lastActivityAt: REST, lastHumanAt, firstHumanAt: SPAWN,
      lastFence: { kind: "awaiting", body: "", hints: WORKING_PARK },
    }) as SessionTelemetry,
    foreignIds: () => [], subAgent: () => undefined, forget: () => {},
    start: () => {}, stop: () => {}, tick: () => {},
  } satisfies Tailer
  const board = createBoard(project, storage, new Bus(), tailer, "passed-over", { claudeBrokerDaemonAlive: () => true, now: () => NOW })
  const ctx = { project, storage, board, tailer, scheduler: { kick: () => {} }, getSettings: () => ({ permissionMode: "auto" }) as unknown as Settings } as unknown as AppContext
  storage.upsertSession(row())
  storage.setBackend("t", "claude")
  storage.setClaudeRuntime("t", "broker")
  storage.askThreadQuestion({ id: "qst_passed00001", slug: "t", askedAtMs: ASKED_MS, spec: JSON.stringify({ question: "SQLite or a JSON file?", kind: "question", options: [{ label: "SQLite" }, { label: "JSON file" }] }) })
  return {
    storage,
    router: createRouter(ctx),
    view: (): ThreadView => board.refresh().threads.find((t) => t.id === "t")!,
    typed: (at: string) => { lastHumanAt = at },
    close: () => { board.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug: "t", session_id: "sess-t", thread_name: "ntwine-t", spawned_at: SPAWN,
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: REST, title_auto: 0,
    title: "t", state: "open", meta: null, seen_at: null, transcript_id: null, ...over,
  }
}

test("a question the human typed past is sent flagged and queues nothing; the same question still held queues the thread", () => {
  const h = harness()
  try {
    const held = h.view()
    assert.deepEqual(held.questions.map((q) => [q.id, q.passedOver]), [["qst_passed00001", undefined]])
    assert.equal(held.needsYou, true, "control: a held question outranks the quiet park")
    assert.match(queueUrgency(held), /q:qst_passed00001/)

    h.typed(AFTER_ASK)
    const passed = h.view()
    assert.deepEqual(passed.questions.map((q) => [q.id, q.passedOver]), [["qst_passed00001", true]], "still sent, so the chat draws it in place")
    assert.equal(passed.needsYou, false)
    assert.doesNotMatch(queueUrgency(passed), /q:/)
  } finally { h.close() }
})

test("done goes through a question the human typed past, and the done card is not superseded by it", async () => {
  const h = harness()
  try {
    const refused = await h.router.markOwnDone.handler({ input: { slug: "t", body: "Shipped the store." } })
    assert.deepEqual(refused.blockingQuestions.map((q) => q.id), ["qst_passed00001"], "control: held, it refuses")

    h.typed(AFTER_ASK)
    assert.equal((await h.router.markOwnDone.handler({ input: { slug: "t", body: "Shipped the store." } })).done, true)
    const view = h.view()
    assert.equal(view.lastFence?.kind, "done")
    assert.equal(view.questions[0]?.passedOver, true, "and the card is still there to answer")
  } finally { h.close() }
})

test("answering a question typed past on an archived thread reopens it, so the answer is delivered", async () => {
  const h = harness()
  try {
    h.typed(AFTER_ASK)
    h.storage.setState("t", "archived")
    assert.equal(h.storage.getSession("t")?.state, "archived")
    const answered = await h.router.answerQuestions.handler({ input: { slug: "t", answers: [
      { questionId: "qst_passed00001", question: "SQLite or a JSON file?", chosen: ["SQLite"] },
    ] } })
    assert.deepEqual(answered.answered, ["qst_passed00001"])
    assert.equal(h.storage.getSession("t")?.state, "open")
  } finally { h.close() }
})
