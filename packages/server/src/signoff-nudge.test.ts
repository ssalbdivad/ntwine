// THE BUILT-IN SIGN-OFF NUDGE (scheduler SOURCE 9) — ntwine's own stop hook, always on and invisible.
//
// It exists to make ONE invariant true: every item in the queue is a question you can answer or a
// checkmark you can archive. So it fires on exactly one thing — a rest that carried NO fence — and on
// nothing else. Every test here is a way that could go wrong: nudging a thread that DID sign off (which
// arrives after a ```done and reads as ntwine not having noticed), or nudging one forever (a nag loop
// ntwine itself generates).
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage, type SessionRow } from "./storage.ts"
import { NEEDS_INPUT_REQUIRED_AT, QUESTION_FENCE_RETIRED_AT, retiredAwaitingKindsIn, SIGNOFF_NUDGE_MARKER, SIGNOFF_NUDGE_MESSAGE } from "@ntwine/shared"
import { Bus } from "./bus.ts"
import type { Project } from "./project.ts"
import { applyRecord, createTailer, newTailState, type SessionTelemetry, type Tailer } from "./tailer.ts"
import { createScheduler, enqueueThreadMessageWake } from "./scheduler.ts"
import { replyWaitPrompt } from "./thread-mentions.ts"
import { createCodexBackend } from "./backend/codex.ts"
import { createWakeDeliveryStore } from "./wake-store.ts"

// `runtime` is opt-in because it changes which delivery path the scheduler takes, and the difference is
// load-bearing rather than cosmetic. With it absent — the shape every test below it was written in —
// `deliverDue` cannot tell whether the worker is alive, so it falls through to the acknowledge-and-settle
// path. In PRODUCTION the runtime is always knowable, so the sent-and-confirm-later path is the only one
// that ever runs. A cap that is only spent on the path tests take is not a cap; see the two tests at the
// bottom of this file.
// A dispatch instant BEFORE the answer-required cut, for the cases that pin the legacy contract.
const LEGACY_SPAWN = new Date(Date.parse(NEEDS_INPUT_REQUIRED_AT) - 86_400_000).toISOString()

function nudger(tele: Partial<SessionTelemetry>, opts: { setting?: string; runtime?: "alive" | "dead"; spawnedAt?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-signoff-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  const slug = "resting"
  storage.upsertSession({
    slug, session_id: "sid", thread_name: `ntwine-${slug}`, spawned_at: opts.spawnedAt ?? new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  } as SessionRow)
  if (opts.setting) storage.setSetting("signoffNudge", opts.setting)
  const delivered: string[] = []
  const s = createScheduler({
    // No quiet window here: this file pins its SOURCE, and hands one thread several wakes within a few
    // clock minutes. The window and the merge are pinned in scheduler.test.ts.
    wakeQuietWindowMs: 0,
    storage,
    tailer: {
      get: () => ({
        turn: "idle", lastActivityAt: "2026-08-12T00:00:00.000Z",
        // The AGENT spoke last, which is the shape of a real fenceless rest — and the one thing ntwine's
        // own delivery cannot fake, since ntwine only ever speaks as the user.
        lastAssistantAt: "2026-08-12T00:00:00.000Z",
        subAgents: [], bgShells: [], pendingQuestion: false, permPrompt: false,
        ...tele,
      }),
    } as unknown as Tailer,
    resume: async (_slug, message) => { delivered.push(message) },
    ...(opts.runtime ? { wakeRuntimeState: () => opts.runtime! } : {}),
    log: () => {},
  })
  // THE NUDGE'S OWN DELIVERIES. `delivered` is every wake the scheduler sent, and an awaiting fence
  // ntwine cannot honour legitimately draws SOURCE 12's correction on the same rest — so "the nudge held"
  // has to be asked of the nudge's namespace, not of an empty array.
  const nudges = () => storage.db
    .prepare("SELECT message FROM wake_delivery WHERE thread_slug = ? AND fence_id LIKE 'signoff:%' AND state = 'delivered'")
    .all(slug) as { message: string }[]
  return { s, storage, slug, delivered, nudges, close: () => { void s.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test("Codex failed turns cannot trigger a sign-off reminder or an armed rest Goal", async () => {
  const fold = newTailState("resting", "sid", "/fixture")
  createCodexBackend().foldLine(fold, JSON.stringify({ timestamp: "2026-09-06T15:31:27.526Z", type: "event_msg", payload: {
    type: "task_complete", last_agent_message: null, error: { message: "Rejected", codex_error_info: "cyber_policy" },
  } }))
  const h = nudger({ apiFault: fold.apiFault, lastAssistantAt: fold.lastAssistantAt, lastActivityAt: fold.lastActivityAt }, { runtime: "alive" })
  try {
    h.storage.setRecurringPromptBySlug(h.slug, { prompt: "Keep going", stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: "2026-09-06T15:00:00.000Z" })
    await h.s.tick()
    assert.deepEqual(h.delivered, [])
    assert.equal(h.storage.db.prepare("SELECT count(*) AS n FROM wake_delivery").get()?.n, 0)
  } finally { h.close() }
})

test("provider failures supersede sign-off and rest Goal deliveries queued before the failure was decoded", async () => {
  const at = "2026-08-12T00:00:00.000Z"
  const h = nudger({ apiFault: true }, { runtime: "alive" })
  try {
    h.storage.setRecurringPromptBySlug(h.slug, { prompt: "Keep going", stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: at })
    const outbox = createWakeDeliveryStore(h.storage.scope, { quietWindowMs: 0 })
    for (const prefix of ["signoff", "stophook"]) {
      outbox.enqueue({ id: prefix, slug: h.slug, sessionId: "sid", fenceId: prefix === "signoff" ? `signoff:${at}` : `stophook:${at}:${at}`, hintKey: prefix, message: "Do not deliver", reason: "Pre-upgrade failure misread as a rest" }, Date.parse(at))
    }
    await h.s.tick()
    assert.deepEqual(h.delivered, [])
    assert.deepEqual(h.storage.db.prepare("SELECT state FROM wake_delivery ORDER BY id").all().map((row) => row.state), ["superseded", "superseded"])
  } finally { h.close() }
})

test("a rest with no fence is told how to sign off, and the text names all three ways", async () => {
  const h = nudger({})
  try {
    await h.s.tick()
    assert.equal(h.delivered.length, 1)
    assert.match(h.delivered[0], /```question/)
    assert.match(h.delivered[0], /```done/)
    assert.match(h.delivered[0], /```awaiting/)
    // THE CURRENT FENCE GRAMMAR, not the deleted `watch:` one — this reminder is the last thing many
    // workers read before writing a fence, so a stale example here teaches the wrong syntax to exactly
    // the audience that most needs the right one.
    //
    // This fixture spawns NOW, so it is an answer-required thread (NEEDS_INPUT_REQUIRED_AT) and is taught
    // `status:` with a fence that needs no prose; the legacy example is pinned against the legacy text.
    assert.match(h.delivered[0], /agents: \[<the id your runtime gave you>\]/)
    assert.match(h.delivered[0], /status: working/)
    for (const word of ["working", "watching", "needs_input"]) assert.match(h.delivered[0], new RegExp(`- \`${word}\` — `))
    assert.match(h.delivered[0], /`working` and `watching` owe NO write-up/)
    assert.match(SIGNOFF_NUDGE_MESSAGE, /shells: \[<the id your runtime gave you>\]/)
    assert.match(SIGNOFF_NUDGE_MESSAGE, /prs: \[owner\/repo#123\]/)
    assert.doesNotMatch(SIGNOFF_NUDGE_MESSAGE, /needs_input|status:/, "a pre-cut worker is not taught a key its contract never had")
    // …and never the SINGULAR keys the 2026-08-24 YAML cutover retired. The example kept them for a
    // month after the park check started refusing them by name, so a worker that copied the reminder's
    // own fence was bumped for it.
    assert.deepEqual(retiredAwaitingKindsIn(h.delivered[0].split("```awaiting\n")[1].split("```")[0]), [])
    assert.match(h.delivered[0], /for: 2h/)
    // FRONTMATTER, THEN MARKDOWN (2026-08-17): the structural lines, a `---`, and the worker's prose
    // below it. This pinned `reason:` — the ONE-LINE form that shape replaced — for two days after the
    // parser stopped needing it, which is the same staleness the comment above is about: the example
    // kept teaching the superseded field to the audience least able to know it was superseded.
    assert.match(SIGNOFF_NUDGE_MESSAGE, /^\s*---\s*$/m, "the delimiter, which is what makes the prose prose")
    assert.doesNotMatch(h.delivered[0], /reason:/, "and not the one-line form it replaced")
    assert.doesNotMatch(h.delivered[0], /`watch: <id>`/, "the deleted grammar must not come back")
    // THE GOAL'S VERBIAGE LIVES HERE NOW. A new thread no longer arms the default Goal (2026-08-16) —
    // the bump is the same nudge — so the bump has to carry what the Goal used to say about finishing
    // the work and about deciding rather than asking, or dropping it quietly removed both.
    assert.match(h.delivered[0], /unfinished, unverified, or deferred/)
    assert.match(h.delivered[0], /DECIDE RATHER THAN ASK/)
    // THE TASK IS ALSO THE CEILING. "Keep going" with no upper bound is unbounded by construction —
    // every codebase always has more to do — so a worker forbidden to stop can only stop by widening
    // what it was asked. Traced 2026-08-17 on `investigate-nubjs-nub-642`: dispatched to TRIAGE an
    // issue, it shipped seven commits instead. See DEFAULT_RECURRING_PROMPT for the full account.
    assert.match(h.delivered[0], /FINDING TO REPORT/, "discovered work is reported, not adopted")
    assert.match(h.delivered[0], /THE DOCUMENT IS THE ENDING/, "a triage/review/plan ends with its write-up")
    assert.match(h.delivered[0], /not permission to go build the answer/, "an unanswered question is not a mandate")
    // …and the old copy that made the wrong reading correct must not come back: it listed a written-up
    // plan among the things that are NOT an ending, which for an analysis task denies the deliverable.
    assert.doesNotMatch(h.delivered[0], /a written-up plan and a long turn are none of them endings/)
    // `\s` rather than a literal space: the message is a wrapped array of lines, so this phrase spans a
    // newline and a regex written for one line silently stops pinning anything.
    assert.match(h.delivered[0], /which way you went and\s+what would reverse/)
    // `done` must arrive with its COST attached, or it becomes the cheapest way to stop being nudged —
    // the exact failure the retired ALLDONE warning existed for.
    assert.match(h.delivered[0], /DISMISSAL/)
    // ...and "still owed" has to spell out the cases that read as finished: a RECOMMENDATION whose act
    // the human must perform, an unsent draft, and discovered follow-up that is someone else's to do.
    // Two zod threads fenced `done` on exactly those on 2026-08-16 — see workerPrompt.ts above SIGNALS.
    assert.match(h.delivered[0], /STILL OWED counts things you are not going to do yourself/)
    assert.match(h.delivered[0], /`ntwinectl spawn-thread`/)
    assert.match(h.delivered[0], /not\s+worth a card is not worth a SENTENCE/)
    assert.match(h.delivered[0], /the card is the ledger of what shipped/)
    // SELF-CONTAINEDNESS is the point the first version missed: the human has seen nothing since their
    // own last message, and everything in between came from ntwine. An agent that does not know that
    // writes a handoff about the last thing it touched.
    assert.match(h.delivered[0], /readable cold/i)
    assert.match(h.delivered[0], /came from\s+ntwine/)
    // THE HEADLINE INSTRUCTION: a thread whose handoff already stands alone should answer with the
    // fence and nothing else. Without this the agent restates its whole summary under the reminder and
    // the human reads it twice (maintainer 2026-08-12).
    // THE MENU IS THE SECOND BRANCH, NOT THE FIRST (2026-08-14). This delivery lands on a rest that may
    // simply be premature, and a fence menu handed to a half-finished thread has no correct entry on it —
    // the agent picks the closest, which is `done`, which files the thread away. So the reminder tells it
    // to resume first and only then offers the shapes. The Goal arriving on the same rest says the same
    // thing; two ntwine deliveries pulling opposite ways is the failure this pins against.
    assert.match(h.delivered[0], /THE FENCE IS NOT WHAT YOU OWE — THE WORK IS/)
    assert.ok(
      h.delivered[0].indexOf("THE WORK IS") < h.delivered[0].indexOf("```question"),
      "resuming the work is offered BEFORE the fence menu, not as a footnote under it",
    )
    assert.match(h.delivered[0], /none of\s+them endings/, "and the endings a worker mistakes for one are named")
    assert.match(h.delivered[0], /DO NOT REPEAT YOURSELF/)
    assert.match(h.delivered[0], /sign off with the fence or the registration ALONE and write no prose after it/)
    // The 1-3-sentences shape belongs to a `done` BODY and nowhere else — read as general guidance it
    // made an agent omit most of what had happened (maintainer 2026-08-12, with the screenshot).
    // The 1-3-sentence shape belongs to the `done` entry and nowhere else.
    assert.match(h.delivered[0], /done[\s\S]{0,220}at most one sentence/)
    assert.doesNotMatch(h.delivered[0], /^Keep it SHORT/m)
  } finally { h.close() }
})

// A thread that signed off is not an untriageable item, whichever way it signed off. `awaiting` counts
// too while it still exists — it is a legitimate answer to "where do you stand".
for (const [what, tele] of [
  ["a done fence", { lastFence: { kind: "done" as const, body: "", hints: [] } }],
  ["an awaiting fence", { lastFence: { kind: "awaiting" as const, body: "", hints: [] } }],
  ["a question fence", { pendingQuestion: true }],
  ["a native ask", { pendingAsk: { id: "a1", questions: [] } }],
  ["a permission prompt", { permPrompt: true }],
  ["the legacy ALLDONE sentinel", { lastAssistantAllDone: true }],
] as Array<[string, Partial<SessionTelemetry>]>) {
  test(`${what} is already a sign-off, so nothing is injected`, async () => {
    const h = nudger(tele)
    try {
      await h.s.tick()
      assert.deepEqual(h.nudges(), [])
    } finally { h.close() }
  })
}

// THE FREE-FORM FENCE IS RETIRED (2026-09-11; shared QUESTION_FENCE_RETIRED_AT). "A question fence" in
// the table above is a sign-off only for a thread dispatched BEFORE the retirement, whose worker still
// speaks that grammar. A thread dispatched after it asks only through `mcp__ntwine__ask`, so a fence it
// writes with no registered row behind it is prose — a bare rest — and the nudge fires. Driven through
// the REAL tailer rather than a hand-built telemetry, because the gate lives in the tailer's `get` and a
// fake `get` would only prove the fake.
for (const [what, spawnedAt, nudged] of [
  ["a legacy thread (dispatched before the retirement)", new Date(Date.parse(QUESTION_FENCE_RETIRED_AT) - 60_000).toISOString(), false],
  ["a new-contract thread (dispatched after the retirement)", new Date(Date.parse(QUESTION_FENCE_RETIRED_AT) + 60_000).toISOString(), true],
] as const) {
  test(`${what} resting on a free-form \`\`\`question fence with no registered question: nudged=${nudged}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "ntwine-signoff-fence-"))
    const logDir = join(dir, "-a-project")
    mkdirSync(logDir, { recursive: true })
    const storage = createStorage(join(dir, "ui.db"), "p")
    const slug = "resting"
    storage.upsertSession({
      slug, session_id: "sid", thread_name: `ntwine-${slug}`, spawned_at: spawnedAt,
      last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
      title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
    } as SessionRow)
    writeFileSync(join(logDir, "sid.jsonl"), [
      JSON.stringify({ type: "user", timestamp: "2026-08-12T00:00:00.000Z", message: { role: "user", content: "go" } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-08-12T00:00:01.000Z", message: { stop_reason: "end_turn", content: [{ type: "text", text: "Two ways forward.\n\n```question\nWhich store?\n\n- A. sqlite\n- B. postgres\n```" }] } }),
    ].map((l) => l + "\n").join(""))
    const tailer = createTailer({
      project: { cwdSlug: "x" } as Project,
      storage,
      bus: new Bus(),
      onChange: () => {},
      now: () => Date.now(),
      paneDead: () => false,
      sessionLogDir: logDir,
    })
    tailer.tick()
    const tele = tailer.get(slug)
    assert.equal(tele?.turn, "idle")
    assert.equal(tele?.pendingQuestion, !nudged, "the gate: the fence is an ask only for the legacy thread")
    const delivered: string[] = []
    const s = createScheduler({
      wakeQuietWindowMs: 0,
      storage,
      tailer,
      resume: async (_slug, message) => { delivered.push(message) },
      log: () => {},
    })
    try {
      await s.tick()
      const nudges = storage.db
        .prepare("SELECT message FROM wake_delivery WHERE thread_slug = ? AND fence_id LIKE 'signoff:%' AND state = 'delivered'")
        .all(slug) as { message: string }[]
      assert.equal(nudges.length, nudged ? 1 : 0)
    } finally { void s.stop(); tailer.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) }
  })
}

// AND A REGISTRATION IS A SIGN-OFF TOO, which is the whole point of the five verbs: `done`, `ask` and
// `watch` each record a ROW, and none of them can write the tailer's `lastFence`. Reading only the fence
// nudged a worker for not writing the sentence it was told to replace with a tool call — the protocol
// reminder teaching the OLD protocol, on exactly the threads that had adopted the new one.
for (const [what, arrange] of [
  ["a registered done", (st: ReturnType<typeof createStorage>, slug: string) => st.markThreadDone(slug, "- **Shipped** it", Date.now())],
  ["a registered question", (st: ReturnType<typeof createStorage>, slug: string) =>
    st.askThreadQuestion({ id: "qst_x", slug, spec: JSON.stringify({ question: "Which store?", kind: "question" }), askedAtMs: Date.now() })],
  ["a registered watch", (st: ReturnType<typeof createStorage>, slug: string) =>
    st.armThreadWatch({ id: "wch_x", slug, kind: "shell", target: "bzvtnt3ig", createdAtMs: Date.now(), expiresAtMs: Date.now() + 7_200_000 })],
] as Array<[string, (st: ReturnType<typeof createStorage>, slug: string) => unknown]>) {
  test(`${what} is already a sign-off, so nothing is injected`, async () => {
    // A watch is a sign-off only for a thread dispatched BEFORE the answer-required cut — see the next
    // test — so that case runs on a legacy thread; `done` and `ask` are sign-offs on every contract.
    const h = nudger({}, what === "a registered watch" ? { spawnedAt: LEGACY_SPAWN } : {})
    try {
      arrange(h.storage, h.slug)
      await h.s.tick()
      assert.deepEqual(h.nudges(), [])
    } finally { h.close() }
  })
}

// A CHAT REPLY AFTER A DONE IS NOT A BARE REST (maintainer 2026-09-24, on "what the fuck are tipup and
// trapline lol" drawing "Rested without a sign-off" under the answer). The human spoke after the done, but
// the worker only talked back — so the done still stands. The control is the same rest with a tool call
// after the done: that reply was work, and it is nudged as ever.
test("a prose-only reply to the human after a registered done is not nudged; one that ran a tool is", async () => {
  const doneAt = Date.parse("2026-08-12T00:00:00.000Z")
  const chat = { lastUserAt: "2026-08-12T00:05:00.000Z", lastAssistantAt: "2026-08-12T00:05:04.000Z" }
  const talked = nudger({ ...chat, lastToolCallAt: "2026-08-11T23:59:59.000Z" })
  const worked = nudger({ ...chat, lastToolCallAt: "2026-08-12T00:05:02.000Z" })
  try {
    for (const h of [talked, worked]) {
      h.storage.markThreadDone(h.slug, "- **Shipped** it", doneAt)
      await h.s.tick()
    }
    assert.deepEqual(talked.nudges(), [])
    assert.equal(worked.nudges().length, 1)
  } finally { talked.close(); worked.close() }
})

// A QUESTION IS A SIGN-OFF ONLY AT THE REST THAT ASKED IT (2026-10-05). Until then any open question
// silenced the nudge at every later rest too, and the web drew the old card under the newest handoff as
// if it were that rest's ask — superseding what the worker actually said (maintainer 2026-10-05). A
// question carried past a human turn or a wake is now the worker's to restate under `questions:` or to
// withdraw, and a later rest that does neither is told so.
const ASKED_EARLIER = Date.parse("2026-08-11T23:00:00.000Z")
const LAST_TURN = "2026-08-11T23:59:00.000Z" // a CI wake or a reply, before the rest at 00:00

test("a question carried from an EARLIER rest is not this rest's sign-off — the worker is told to name it or withdraw it", async () => {
  const h = nudger({ lastUserAt: LAST_TURN })
  try {
    h.storage.askThreadQuestion({ id: "qst_old1", slug: h.slug, spec: JSON.stringify({ question: "SQLite or a JSON file?", kind: "question" }), askedAtMs: ASKED_EARLIER })
    await h.s.tick()
    const nudges = h.nudges()
    assert.equal(nudges.length, 1)
    assert.ok(nudges[0].message.startsWith(SIGNOFF_NUDGE_MARKER), "the nudge's own marker, so it folds like every reminder")
    assert.match(nudges[0].message, /A question you registered at an EARLIER rest is still open/)
    assert.match(nudges[0].message, /- `qst_old1` — SQLite or a JSON file\?/, "named, with its own words")
    assert.match(nudges[0].message, /`questions: \[qst_…\]`/)
    assert.match(nudges[0].message, /`ntwinectl unask <id>`/)
  } finally { h.close() }
})

test("a question asked at THIS rest is still its sign-off, even after an earlier turn", async () => {
  const h = nudger({ lastUserAt: LAST_TURN })
  try {
    h.storage.askThreadQuestion({ id: "qst_new1", slug: h.slug, spec: JSON.stringify({ question: "Which dist-tag?", kind: "question" }), askedAtMs: Date.parse("2026-08-11T23:59:30.000Z") })
    await h.s.tick()
    assert.deepEqual(h.nudges(), [])
  } finally { h.close() }
})

test("a new question does not cover an old one: the nudge lists only the carried question", async () => {
  const h = nudger({ lastUserAt: LAST_TURN })
  try {
    h.storage.askThreadQuestion({ id: "qst_old1", slug: h.slug, spec: JSON.stringify({ question: "SQLite or a JSON file?", kind: "question" }), askedAtMs: ASKED_EARLIER })
    h.storage.askThreadQuestion({ id: "qst_new1", slug: h.slug, spec: JSON.stringify({ question: "Which dist-tag?", kind: "question" }), askedAtMs: Date.parse("2026-08-11T23:59:30.000Z") })
    await h.s.tick()
    const nudges = h.nudges()
    assert.equal(nudges.length, 1)
    assert.match(nudges[0].message, /qst_old1/)
    assert.doesNotMatch(nudges[0].message, /qst_new1/)
  } finally { h.close() }
})

// UNDER THE ANSWER-REQUIRED CONTRACT A WATCH IS NOT A SIGN-OFF (2026-10-01). It says when the worker
// wakes; where the thread sits meanwhile is the fence's answer, so a rest behind a watch with no fence
// queues (board.needsInputQueues) — and is told about the fence that would have kept it out.
test("a registered watch alone is NOT a sign-off for an answer-required thread — the rest is taught the fence", async () => {
  const h = nudger({ bgShells: [{ label: "the suite", startedAt: "2026-08-12T00:00:00.000Z", state: "running", id: "toolu_x", taskId: "bzvtnt3ig" }] as SessionTelemetry["bgShells"] })
  try {
    h.storage.armThreadWatch({ id: "wch_x", slug: h.slug, kind: "shell", target: "bzvtnt3ig", createdAtMs: Date.now(), expiresAtMs: Date.now() + 7_200_000 })
    await h.s.tick()
    const nudges = h.nudges()
    assert.equal(nudges.length, 1)
    assert.match(nudges[0].message, /shells: \[bzvtnt3ig\]\nstatus: working\n/, "the fence to write, the id and the answer in it")
    assert.match(nudges[0].message, /make it `watching`/, "and when it is a watch")
    assert.match(nudges[0].message, /make it `needs_input`/, "and when the human is needed")
  } finally { h.close() }
})

// AND THE MOMENT THE HUMAN ANSWERS, EVERY GUARD ABOVE OPENS. The row leaves `open`, the done row is
// still absent, no watch was ever armed — so on the next tick this thread looked exactly like one that
// had rested saying nothing, and the nudge went out while the answer was still in the outbox. The
// transcript read: the worker's rest, "NTWINE ASKED FOR A SIGN-OFF", then the human's answer (maintainer
// 2026-08-27, on that exact sequence). It also spent one of the two nudges this thread will ever get.
test("an answered question ON ITS WAY to the worker is a sign-off too, until the worker has it", async () => {
  const h = nudger({})
  try {
    h.storage.askThreadQuestion({ id: "qst_x", slug: h.slug, spec: JSON.stringify({ question: "Which store?", kind: "question" }), askedAtMs: Date.now() })
    h.storage.answerThreadQuestion("qst_x", JSON.stringify({ questionId: "qst_x", question: "Which store?", chosen: ["SQLite"] }), Date.now())
    await h.s.tick()
    assert.deepEqual(h.nudges(), [], "answered, not yet delivered — the worker is about to be woken with it")
  } finally { h.close() }
})

// A WAIT ON ANOTHER THREAD'S ANSWER (`message_thread` with `await_reply`) is a registration, not a park: a
// rest after it with no fence is a bare rest, nudged like any other — with the fence that names the thread
// written out for it.
test("a fenceless rest after await_reply is nudged, with the `threads:` fence pre-filled", async () => {
  const h = nudger({})
  try {
    h.storage.armThreadTimer({ id: "tmr_reply", slug: h.slug, prompt: replyWaitPrompt("shell-budgets", "sb"), fireAtMs: Date.now() + 3_600_000, createdAtMs: Date.now() })
    await h.s.tick()
    const nudges = h.nudges()
    assert.equal(nudges.length, 1)
    assert.match(nudges[0]!.message, /waiting on a reply from @shell-budgets/)
    assert.match(nudges[0]!.message, /```awaiting\nthreads: \[@shell-budgets\]\nstatus: watching\nfor: 1h\n```/)
    assert.doesNotMatch(nudges[0]!.message, /tmr_reply`?\s*—/, "the wait is named as its thread, not as a timer")
  } finally { h.close() }
})

// …and a message on its way from another thread does not sign a bare rest off either.
test("a thread message on its way does not sign off a bare rest", async () => {
  const h = nudger({})
  try {
    enqueueThreadMessageWake(h.storage, { slug: h.slug, sessionId: "sid", fromSlug: "sb", message: "Message from @shell-budgets: 742", nowMs: Date.now() + 3_600_000 })
    await h.s.tick()
    const minted = h.storage.db.prepare("SELECT id FROM wake_delivery WHERE thread_slug = ? AND fence_id LIKE 'signoff:%'").all(h.slug)
    assert.equal(minted.length, 1)
  } finally { h.close() }
})

// The failing control for the cases above: with none of them recorded, this very thread IS nudged — so
// they are what silenced it rather than something else about the fixture.
test("…and with no fence and no registration, the same thread IS nudged", async () => {
  const h = nudger({})
  try {
    await h.s.tick()
    assert.equal(h.nudges().length, 1)
  } finally { h.close() }
})

// A thread that is still working has not failed to sign off — it has not finished.
test("a busy thread is never nudged", async () => {
  const h = nudger({ turn: "in-flight" })
  try {
    await h.s.tick()
    assert.deepEqual(h.delivered, [])
  } finally { h.close() }
})

// ONE PER REST falls out of the delivery id being bound to the rest instant — no counter needed for it.
test("one nudge per rest, however many ticks run over it", async () => {
  const h = nudger({})
  try {
    await h.s.tick()
    await h.s.tick()
    await h.s.tick()
    assert.equal(h.delivered.length, 1)
  } finally { h.close() }
})

// THE LOOP THIS ALMOST SHIPPED WITH. ntwine's own delivery lands as a USER record, so it advances both
// `lastActivityAt` and `lastUserAt`. The first design keyed the delivery id on the former and the cap's
// anchor on the latter, which meant the nudge minted a fresh id for a rest that never happened and reset
// its own counter with its own message: 22 deliveries to one thread in four minutes, measured on a real
// stack (the unit tests all passed, because they drove those fields by hand).
//
// The fix is to ask whether the AGENT spoke last, which nothing ntwine says can affect.
test("a thread whose last word is ntwine's own nudge is not nudged again", async () => {
  const h = nudger({
    lastAssistantAt: "2026-08-12T00:00:00.000Z",
    lastUserAt: "2026-08-12T00:00:30.000Z", // the delivery landed AFTER the agent's last word
    lastActivityAt: "2026-08-12T00:00:30.000Z",
  })
  try {
    await h.s.tick()
    assert.deepEqual(h.delivered, [], "the agent has not answered yet — there is nothing new to nudge")
  } finally { h.close() }
})

test("the cap stops a nag loop, and only SIGNING OFF gives the allowance back", async () => {
  let spokeAt = "2026-08-12T00:01:00.000Z"
  let fence: SessionTelemetry["lastFence"]
  const h = nudger({
    lastUserAt: "2026-08-12T00:00:00.000Z",
    get lastAssistantAt() { return spokeAt },
    get lastActivityAt() { return spokeAt },
    get lastFence() { return fence },
  } as Partial<SessionTelemetry>)
  try {
    // Three consecutive fenceless rests by the AGENT; only the first two are nudged.
    await h.s.tick()
    spokeAt = "2026-08-12T00:02:00.000Z"
    await h.s.tick()
    spokeAt = "2026-08-12T00:03:00.000Z"
    await h.s.tick()
    assert.equal(h.delivered.length, 2, "capped at 2 consecutive")
    assert.equal(h.storage.getSession(h.slug)?.signoff_nudges, 2)

    // A user record does NOT restore it — that is exactly what ntwine's own delivery is.
    spokeAt = "2026-08-12T00:04:00.000Z"
    await h.s.tick()
    assert.equal(h.delivered.length, 2, "still capped")

    // Signing off does. It is the only event that proves the nudge worked.
    fence = { kind: "done", body: "", hints: [] }
    await h.s.tick()
    assert.equal(h.storage.getSession(h.slug)?.signoff_nudges, 0, "the allowance is back")
    fence = undefined
    spokeAt = "2026-08-12T00:05:00.000Z"
    await h.s.tick()
    assert.equal(h.delivered.length, 3, "and the next fenceless rest is nudged again")
  } finally { h.close() }
})

// It lands on every live thread at once, so there has to be a way to stop it that is not a code change.
test("the kill switch silences it everywhere", async () => {
  const h = nudger({}, { setting: "off" })
  try {
    await h.s.tick()
    assert.deepEqual(h.delivered, [])
  } finally { h.close() }
})

// A SIGNED-OUT PROVIDER answers in milliseconds, so the auth failure is a real assistant message and
// therefore a real rest — which satisfies every other guard. Measured on a live stack: the bump fired
// ten times in a hundred seconds against a thread whose worker could only ever reply "Not logged in".
// Re-prompting cannot help; the thread already cards its auth fault and the sign-in recovery.
test("an auth-faulted thread is never re-prompted — the nudge cannot fix a signed-out provider", async () => {
  const h = nudger({ authFault: "authentication_rejected" } as never)
  try {
    await h.s.tick()
    assert.deepEqual(h.delivered, [])
  } finally { h.close() }
})

// ---- A FAILED TURN IS NOT A REST ------------------------------------------------------------------
// The loop this file's cap was always meant to stop, reached anyway — twice over, and each half is
// enough on its own. Measured in the field on two real threads before either was fixed: ~5,700 and
// ~5,200 nudges to single sessions, one every ~10s (the scheduler's tick) without pause, until both
// transcripts passed 80 MB and every turn failed with `400 invalid_request` because the conversation
// had outgrown the model's context window. `signoff_nudges` read 0 on both rows throughout, against a
// SIGNOFF_NUDGE_MAX of 2.
//
//   THE CAP WAS NEVER SPENT. Every wake to a live runtime leaves `deliverDue` at the sent-and-confirm
//   branch, which did not settle the nudge, and the confirm that would have settled it later never ran:
//   `deliveryContext` reads a signoff item as SUPERSEDED as soon as the agent's next assistant record
//   lands, and superseding counts nothing. A synthetic API-error record IS an assistant record, so the
//   failing turn that provoked the nudge is also what stopped the nudge being counted.
//
//   AND THE REST WAS NEVER REAL. That same record advances `lastAssistantAt`, so each failure minted a
//   fresh rest instant, hence a fresh delivery id, defeating the per-rest dedupe as well.
test("a nudge to a LIVE runtime is counted against the cap, not just one to an unknown one", async () => {
  let spokeAt = "2026-08-12T00:01:00.000Z"
  const h = nudger({
    lastUserAt: "2026-08-12T00:00:00.000Z",
    get lastAssistantAt() { return spokeAt },
    get lastActivityAt() { return spokeAt },
  } as Partial<SessionTelemetry>, { runtime: "alive" })
  try {
    for (let i = 2; i <= 6; i++) {
      await h.s.tick()
      spokeAt = `2026-08-12T00:0${i}:00.000Z`
    }
    assert.equal(h.delivered.length, 2, "five fenceless rests to a live worker still spend exactly the cap")
    assert.equal(h.storage.getSession(h.slug)?.signoff_nudges, 2)
  } finally { h.close() }
})

// The guard the cap should never have to be the last line of defence for. A thread failing every turn
// cannot answer a reminder — nothing it writes reaches the model — and on a context-window 400 the
// reminder is what keeps the conversation over the limit, so even the two the cap allows are two too
// many. Each row is a REAL synthetic error record folded through the tailer, so what reaches the stub is
// what the fold actually raises — for the category ntwine already classified (a rate limit) and for the
// one it could not see at all (a 400). The fold → `telemetry()` projection is pinned in tailer.test.ts.
for (const [what, rec] of [
  ["a terminal 400 the classifiers do not recognise", {
    error: "invalid_request", apiErrorStatus: 400,
    text: 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Prompt is too long"}}',
  }],
  ["a rate limit, which also never reached the model", {
    error: "rate_limit", apiErrorStatus: 429, text: "You've hit your session limit",
  }],
] as const) {
  test(`${what} is a failed turn, not a rest, so nothing is injected`, async () => {
    const fold = newTailState("resting", "sid", "/x")
    applyRecord(fold, {
      type: "assistant", isApiErrorMessage: true, error: rec.error, apiErrorStatus: rec.apiErrorStatus,
      timestamp: "2026-08-12T00:01:00.000Z",
      message: { model: "<synthetic>", content: [{ type: "text", text: rec.text }] },
    })
    assert.equal(fold.apiFault, true, "the fold raises the general fault off the record")
    let spokeAt = "2026-08-12T00:01:00.000Z"
    const h = nudger({
      lastUserAt: "2026-08-12T00:00:00.000Z",
      get lastAssistantAt() { return spokeAt },
      get lastActivityAt() { return spokeAt },
      apiFault: fold.apiFault,
      limitFault: fold.limitFault,
    } as Partial<SessionTelemetry>, { runtime: "alive" })
    try {
      // Every tick is a fresh failed turn, which is exactly what defeated the per-rest dedupe: the
      // error record is an assistant record, so it moves the rest instant every time.
      for (let i = 2; i <= 21; i++) {
        await h.s.tick()
        spokeAt = `2026-08-12T00:${String(i).padStart(2, "0")}:00.000Z`
      }
      // Asked of the reminder's own namespace: a standing limit fault legitimately draws the limit-resume
      // wake from another source, and that is not what this test is about.
      assert.deepEqual(h.nudges(), [], "twenty consecutive failed turns produce no nudges at all")
      assert.equal(h.storage.getSession(h.slug)?.signoff_nudges, 0)
    } finally { h.close() }
  })
}

// ---- THE TWO-DELIVERY INTERACTION -----------------------------------------------------------------
// Separating the reminder from the Goal (2026-08-12) means a thread WITH a Goal has two sources that
// want one fenceless rest. Until 2026-08-28 both fired on it, as separate deliveries, on the reading
// that "the deliveries serialise, and a fence supersedes whatever is still queued". They serialised in
// the RUNTIME'S queue, not ntwine's: both left in one tick, 5 ms apart, the worker answered the Goal with
// a ```done fence, and then read "you rested without a fence" — the supersession check ran at send,
// before that reply existed — and fenced again. Two Done cards on one thread (`wrong-agent-id-re-fencing`,
// maintainer: "Redundant Dones"). So now ONE source takes a bare rest: the reminder, which mints first
// and already sends a half-finished thread back to the work; the Goal stands down on that rest and takes
// the bare rests the reminder does not (its cap spent — see the test after next).
test("a Goal and the reminder are due for one rest: the reminder goes, the Goal stands down, and a fence ends it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-both-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  const slug = "both"
  storage.upsertSession({
    slug, session_id: "sid", thread_name: `ntwine-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  } as SessionRow)
  // An ordinary armed Goal — the stop hook and nothing else, which is what the Goal panel arms when an
  // operator flips one switch.
  storage.setRecurringPromptBySlug(slug, {
    prompt: "keep going", stopHook: true, heartbeat: false, postCompaction: false,
    intervalMs: null, armedAt: "2026-08-12T00:00:00.000Z",
  })
  let fence: SessionTelemetry["lastFence"]
  const delivered: string[] = []
  const s = createScheduler({
    wakeQuietWindowMs: 0,
    storage,
    tailer: {
      get: () => ({
        turn: "idle", lastActivityAt: "2026-08-12T00:01:00.000Z", lastAssistantAt: "2026-08-12T00:01:00.000Z",
        lastUserAt: "2026-08-12T00:00:00.000Z", subAgents: [], bgShells: [],
        pendingQuestion: false, permPrompt: false, lastFence: fence,
      }),
    } as unknown as Tailer,
    resume: async (_slug, message) => { delivered.push(message) },
    log: () => {},
  })
  try {
    await s.tick()
    // ONE wake for this rest — ntwine's protocol, not the operator's words.
    assert.equal(delivered.length, 1)
    assert.match(delivered[0], /without a fence/, "the reminder is what a bare rest draws")
    assert.doesNotMatch(delivered[0], /^keep going/, "and the Goal stands down on the rest the reminder took")
    // Per REST, not per tick: the reminder is delivered now, and the Goal still does not take the rest
    // it answered. (In production the reminder's own record closes the rest before this could matter;
    // this pins the outbox-side hold that makes it true even when the tailer has not caught up.)
    await s.tick()
    await s.tick()
    assert.equal(delivered.length, 1, "the Goal does not follow the reminder onto the same rest")

    // The agent signs off. Neither source may fire again for this thread, and anything still queued for
    // the old rest is superseded rather than delivered on top of a closed thread.
    fence = { kind: "done", body: "shipped it", hints: [] }
    await s.tick()
    await s.tick()
    assert.equal(delivered.length, 1, "a signed-off thread is not re-prompted by either source")
  } finally { void s.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) }
})

// ARMING A GOAL OVER AN OPEN QUESTION (maintainer 2026-09-02). The arming cancels the question for
// autonomy (router.cancelQuestionsForAutonomy), which turned a rest that had signed off WITH a question
// into what both sources read as a bare one: the reminder took it — "you rested without a fence", to a
// worker whose question ntwine itself had just cancelled — and the Goal stood down for it, while the
// cancellation wake went out beside it as a second delivery. The dismissal-in-flight is a settlement on
// its way (evalQuestionAnswers wakes on exactly this shape when the rest Goal is armed), so it holds
// both sources the way an answer-in-flight already held the reminder, and the wake is the ONE delivery
// the rest draws.
test("a cancellation on its way holds BOTH sources — the wake is the one delivery the rest draws", async () => {
  let lastUserAt = "2026-08-12T00:00:00.000Z"
  let spokeAt = "2026-08-12T00:01:00.000Z"
  const h = nudger({
    get lastUserAt() { return lastUserAt },
    get lastAssistantAt() { return spokeAt },
    get lastActivityAt() { return spokeAt },
  } as Partial<SessionTelemetry>)
  try {
    // The field sequence: the worker registered a question and rested; the operator armed a stop hook
    // in the Goal panel, whose handler cancelled the question and kicked the sweep.
    h.storage.askThreadQuestion({
      id: "qst_cancelled", slug: h.slug,
      spec: JSON.stringify({ question: "SQLite or a JSON file?", kind: "question" }),
      askedAtMs: Date.parse("2026-08-12T00:01:00.000Z"),
    })
    h.storage.setRecurringPromptBySlug(h.slug, {
      prompt: "keep going", stopHook: true, heartbeat: false, postCompaction: false,
      intervalMs: null, armedAt: "2026-08-12T00:02:00.000Z",
    })
    h.storage.dismissThreadQuestion("qst_cancelled", Date.parse("2026-08-12T00:02:00.000Z"))
    await h.s.tick()
    assert.equal(h.delivered.length, 1, "one delivery for this rest")
    assert.match(h.delivered[0], /CANCELLED without an answer/, "and it is the cancellation wake")
    assert.deepEqual(h.nudges(), [], "the reminder held — the worker did not rest bare, it asked")
    // Per rest, not per tick: the settlement spends only when the wake LANDS (a user record), so a slow
    // tailer cannot reopen the rest to either source in the meantime.
    await h.s.tick()
    assert.equal(h.delivered.length, 1, "neither source follows the wake onto the same rest")

    // The wake lands and the worker rests bare again: the hold is spent, and the new rest is an
    // ordinary bare one — the reminder's, per the pass order the tests around this one pin.
    lastUserAt = "2026-08-12T00:03:00.000Z"
    spokeAt = "2026-08-12T00:04:00.000Z"
    await h.s.tick()
    assert.equal(h.delivered.length, 2, "the hold is bounded by the wake landing")
    assert.match(h.delivered[1], /without a fence/)
  } finally { h.close() }
})

// THE FIELD SEQUENCE, END TO END, and the control that keeps the Goal a real trigger. Every rest here is
// the AGENT'S (lastAssistantAt advances; ntwine's own records are not modelled, which is the harder case
// for the hold — see the previous test).
test("the Goal takes only the bare rests the reminder does not, so a worker never reads 'you rested without a fence' after fencing", async () => {
  let spokeAt = "2026-08-12T00:01:00.000Z"
  let fence: SessionTelemetry["lastFence"]
  const h = nudger({
    lastUserAt: "2026-08-12T00:00:00.000Z",
    get lastAssistantAt() { return spokeAt },
    get lastActivityAt() { return spokeAt },
    get lastFence() { return fence },
  } as Partial<SessionTelemetry>)
  const kinds = () => h.delivered.map((m) => m.startsWith("keep going") ? "goal" : m.includes("without a fence") ? "reminder" : "other")
  try {
    h.storage.setRecurringPromptBySlug(h.slug, {
      prompt: "keep going", stopHook: true, heartbeat: false, postCompaction: false,
      intervalMs: null, armedAt: "2026-08-12T00:00:00.000Z",
    })
    // Rest 1, bare (the field thread: its `ask` had just been refused). The reminder alone.
    await h.s.tick()
    assert.deepEqual(kinds(), ["reminder"])

    // The worker answers it with a ```done fence — the reply that used to be followed by a stale
    // "you rested without a fence". Nothing more reaches this thread, however many ticks run.
    spokeAt = "2026-08-12T00:02:00.000Z"
    fence = { kind: "done", body: "shipped it", hints: [] }
    await h.s.tick()
    await h.s.tick()
    assert.deepEqual(kinds(), ["reminder"], "a fenced reply draws nothing — no Goal for the rest before it, none for this one")

    // CONTROL: the same thread ignoring the protocol. The fence gave the reminder's allowance back, so
    // two more bare rests draw it twice; the THIRD is one the reminder cannot take, and that is the
    // Goal's — the operator's words do reach a worker that keeps resting bare.
    fence = undefined
    spokeAt = "2026-08-12T00:03:00.000Z"
    await h.s.tick()
    spokeAt = "2026-08-12T00:04:00.000Z"
    await h.s.tick()
    assert.deepEqual(kinds(), ["reminder", "reminder", "reminder"])
    spokeAt = "2026-08-12T00:05:00.000Z"
    await h.s.tick()
    assert.deepEqual(kinds(), ["reminder", "reminder", "reminder", "goal"], "the reminder's cap is spent; the Goal takes the rest")
    // The Goal's trailer does not carry the protocol — the reminder is the one place it lives.
    assert.doesNotMatch(h.delivered[3], /```question/)
  } finally { h.close() }
})

// ---- AND AN ARMED GOAL DOES NOT SWITCH IT OFF -----------------------------------------------------
// It did, for one day (2026-08-13 → 2026-08-14), for the subset of Goals the panel then called Autonomous
// mode — on the reading that this reminder buys a queue A HUMAN triages, and a self-driving thread is the
// operator saying nobody is triaging this one. The switch is gone (2026-08-16) and every Goal is now that
// kind, so the argument would apply to ALL of them if it held. Two facts killed it, and this test is the
// guard against re-deriving it:
//
//   THE REMINDER STOPPED BEING A MENU OF WAYS TO STOP. It now OPENS by sending a half-finished thread back
//   to the work, which is the Goal's own instruction — so the "two deliveries pulling opposite ways" the
//   suppression was built on no longer describes anything.
//
//   IT IS THE ONLY DELIVERY THAT NAMES THE PARK. The Goal's trailer names ```done and deliberately not
//   ```awaiting (see restPromptMessage — a budget decision), so silencing this left the threads most
//   likely to be holding background work with no way to learn how to park on it. Measured over five
//   consecutive bare rests with the suppression in: five Goal bumps, no reminder, the park never
//   mentioned once.
//
// The 2026-08-28 hold runs the OTHER way — the Goal stands down on the rest the reminder takes — and
// this test is also the guard against getting that direction wrong: Goal first with the reminder held
// would starve the reminder on exactly the worker that rests bare after every Goal, which is the
// measured five-rests-no-park above by another route.
test("an armed Goal does not silence the reminder — the reminder is what lands on the rest", async () => {
  const h = nudger({})
  try {
    // The at-rest trigger driving, which is the exact row the reverted gate keyed on.
    h.storage.setRecurringPromptBySlug(h.slug, {
      prompt: "keep going", stopHook: true, heartbeat: false, postCompaction: false,
      intervalMs: null, armedAt: "2026-08-12T00:00:00.000Z",
    })
    await h.s.tick()
    const reminder = h.delivered.find((m) => m.includes("without a fence"))
    assert.ok(reminder, "the reminder fires")
    assert.ok(!h.delivered.some((m) => m.startsWith("keep going")), "and the Goal stands down on the rest it took")
    // The park is the thing the Goal's trailer cannot supply, so it is what the assertion is really
    // about. Matched on the FENCE rather than on whatever tool registers it, so a change to the
    // registration mechanism cannot silently turn this into a test of nothing.
    assert.match(reminder, /```awaiting/)
  } finally { h.close() }
})

// ---- A REST WITH LIVE BACKGROUND WORK (2026-10-02) ------------------------------------------------
// Over 2026-09-29..10-01, ~20 of 46 nudges went to a worker resting behind a running shell, sub-agent or
// Workflow, and each answered with a correct ```awaiting fence 2–3s later — a turn and sixty lines of
// "unfinished work" prose to produce one fence. Two changes, pinned here: a running direct child (a
// Workflow is one) already parks, so it draws no nudge at all; a running shell does NOT park — a
// forgotten dev server would hide its thread forever — so it draws a SHORT nudge naming the shell, with
// its fence written out. A rest with nothing running keeps the long protocol.
//
// THESE ARE THE LEGACY CONTRACT'S RULES (a thread dispatched before NEEDS_INPUT_REQUIRED_AT), so each test
// below that leans on "a child parks" pins a legacy spawn. Under `needs_input:` a child no longer parks on
// its own, and the short variant asks for the fence behind one too — pinned at the end of this section.
const shell = (over: Record<string, unknown> = {}) => ({ label: "nub run typecheck", startedAt: "2026-08-12T00:00:00.000Z", state: "running", id: "toolu_shell1", taskId: "bzvtnt3ig", ...over })
const child = (over: Record<string, unknown> = {}) => ({ label: "scout the tailer", startedAt: "2026-08-12T00:00:00.000Z", state: "running", id: "toolu_agent1", taskId: "a01b2d20b32feab11", ...over })

test("a rest behind a running shell gets the short variant: the shell by its runtime id, and its fence written out", async () => {
  const h = nudger({ bgShells: [shell()] } as Partial<SessionTelemetry>, { spawnedAt: LEGACY_SPAWN })
  try {
    await h.s.tick()
    assert.equal(h.nudges().length, 1)
    const msg = h.nudges()[0].message
    assert.ok(msg.startsWith("**This message is from ntwine, not from the user.**"), "the transcript collapses it on this marker")
    assert.match(msg, /^- `bzvtnt3ig` — nub run typecheck$/m, "led by the shell, named by the id the runtime showed the worker")
    assert.match(msg, /```awaiting\nshells: \[bzvtnt3ig\]\nfor: 1h\n---\n/, "the fence, ready to copy")
    assert.match(msg, /```done instead/, "and the way out when the work is in fact finished")
    // NOT the long protocol: none of its sections, and nowhere near its length.
    assert.doesNotMatch(msg, /DECIDE RATHER THAN ASK|THE FENCE IS NOT WHAT YOU OWE|STILL OWED|DO NOT REPEAT YOURSELF/)
    assert.ok(msg.split("\n").length < 20, `short: ${msg.split("\n").length} lines`)
  } finally { h.close() }
})

test("the fence the short variant hands over is one the real park check honours", async () => {
  const { signoffNudgeMessage } = await import("@ntwine/shared")
  const { parseSignalFence } = await import("./tailer.ts")
  const { hasDeclaredBackgroundPark } = await import("./board.ts")
  const shells = [shell(), shell({ id: "toolu_shell2", taskId: "b7xq2pp0k", label: "vite dev" })]
  const msg = signoffNudgeMessage({ shells: shells.map((s) => ({ id: s.taskId, label: s.label })), subAgents: [] })
  // The worker's reply: the fence exactly as handed over.
  const fence = parseSignalFence(`Waiting on both.\n\n${msg.slice(msg.indexOf("```awaiting"), msg.indexOf("```", msg.indexOf("```awaiting") + 3) + 3)}`)
  assert.equal(fence?.kind, "awaiting")
  const tele = { lastFence: fence, bgShells: shells, subAgents: [], lastAssistantAt: "2026-08-12T00:00:00.000Z" } as unknown as SessionTelemetry
  assert.equal(hasDeclaredBackgroundPark(tele, Date.parse("2026-08-12T00:01:00.000Z")), true)
  // Negative control: the same fence once one of the shells has exited is refused.
  assert.equal(hasDeclaredBackgroundPark({ ...tele, bgShells: [shells[0]] } as SessionTelemetry, Date.parse("2026-08-12T00:01:00.000Z")), false)
})

test("the short variant offers armed timers and watched PRs as lines to add, never pre-filled into the fence", async () => {
  const { signoffNudgeMessage } = await import("@ntwine/shared")
  const msg = signoffNudgeMessage({
    shells: [{ id: "bzvtnt3ig", label: "nub run test" }],
    subAgents: [],
    timers: [{ id: "tmr_a1b2c3d4e5f6", label: "re-check the deploy" }],
    prs: [{ id: "acme/app#391", label: "acme/app#391" }],
  })
  const fence = msg.slice(msg.indexOf("```awaiting"), msg.indexOf("```", msg.indexOf("```awaiting") + 3))
  assert.doesNotMatch(fence, /timers:|prs:/, "a shell wait and a PR wait are different waits")
  assert.match(msg, /`timers: \[tmr_a1b2c3d4e5f6\]`, `prs: \[acme\/app#391\]`/)
  // A shell with no id falls back to its label, QUOTED — the park check answers to a label, and a bare
  // one with a comma or colon would break the YAML list.
  const bare = signoffNudgeMessage({ shells: [{ label: "sleep 600, then poll: CI" }], subAgents: [] })
  assert.match(bare, /shells: \["sleep 600, then poll: CI"\]/)
})

test("a stale shell is not live work: the rest gets the long protocol", async () => {
  const h = nudger({ bgShells: [shell({ state: "stale" })] } as Partial<SessionTelemetry>)
  try {
    await h.s.tick()
    assert.equal(h.nudges().length, 1)
    assert.match(h.nudges()[0].message, /DECIDE RATHER THAN ASK/)
  } finally { h.close() }
})

for (const [what, agents] of [
  ["a running sub-agent", [child()]],
  ["a running Workflow", [child({ label: "Workflow: review", workflow: true })]],
  ["a running sub-agent beside a running shell", [child()]],
] as Array<[string, unknown[]]>) {
  test(`${what} already parks the rest, so it is not nudged — and the allowance is neither spent nor given back`, async () => {
    const h = nudger({ subAgents: agents, bgShells: what.includes("shell") ? [shell()] : [] } as Partial<SessionTelemetry>, { spawnedAt: LEGACY_SPAWN })
    try {
      h.storage.countSignoffNudge(h.slug, "signoff:2026-08-11T00:00:00.000Z")
      await h.s.tick()
      await h.s.tick()
      assert.deepEqual(h.nudges(), [])
      assert.equal(h.storage.getSession(h.slug)?.signoff_nudges, 1, "a child is not a sign-off")
    } finally { h.close() }
  })
}

test("a Workflow's own agents and a retired child's grandchildren do not park, and are never offered as `agents:`", async () => {
  // depth 2 — not a direct child, so neither the queue excusal nor the park check answers to it.
  const h = nudger({ subAgents: [child({ id: "wf-agent-1", taskId: undefined, depth: 2, parentId: "toolu_gone" })] } as Partial<SessionTelemetry>, { spawnedAt: LEGACY_SPAWN })
  try {
    await h.s.tick()
    assert.equal(h.nudges().length, 1)
    assert.doesNotMatch(h.nudges()[0].message, /wf-agent-1|agents: \[/)
  } finally { h.close() }
})

test("under the answer-required contract a running child no longer parks: the rest gets the short variant, its fence answering status", async () => {
  const h = nudger({ subAgents: [child()], bgShells: [shell()] } as Partial<SessionTelemetry>)
  try {
    await h.s.tick()
    assert.equal(h.nudges().length, 1)
    const msg = h.nudges()[0].message
    assert.match(msg, /```awaiting\nshells: \[bzvtnt3ig\]\nagents: \[a01b2d20b32feab11\]\nstatus: working\nfor: 1h\n```/, "a quiet park, the fence alone")
    assert.match(msg, /make it `needs_input`/, "and when the human is needed")
    assert.doesNotMatch(msg, /keeps you out of the queue on its own/, "no promise the contract withdrew")
    // The fence it hands over is one the needs_input park check honours while the work runs.
    const { parseSignalFence } = await import("./tailer.ts")
    const { liveActivityOf, needsInputParkHolds } = await import("./awaiting.ts")
    const open = msg.indexOf("```awaiting")
    const fence = parseSignalFence(`${msg.slice(open, msg.indexOf("```", open + 3) + 3)}`)
    assert.equal(fence?.kind, "awaiting")
    const live = liveActivityOf({ bgShells: [shell()], subAgents: [child()] }, new Set(), new Set())
    const spoke = Date.parse("2026-08-12T00:00:00.000Z")
    assert.equal(needsInputParkHolds(fence!.hints, live, spoke, spoke + 60_000), true)
    // Negative control: once the child has returned, the same fence no longer holds.
    assert.equal(needsInputParkHolds(fence!.hints, liveActivityOf({ bgShells: [shell()], subAgents: [] }, new Set(), new Set()), spoke, spoke + 60_000), false)
  } finally { h.close() }
})

test("the short variant spends the same consecutive allowance as the long one", async () => {
  let spokeAt = "2026-08-12T00:01:00.000Z"
  const h = nudger({
    lastUserAt: "2026-08-12T00:00:00.000Z",
    bgShells: [shell()],
    get lastAssistantAt() { return spokeAt },
    get lastActivityAt() { return spokeAt },
  } as Partial<SessionTelemetry>)
  try {
    await h.s.tick()
    spokeAt = "2026-08-12T00:02:00.000Z"
    await h.s.tick()
    spokeAt = "2026-08-12T00:03:00.000Z"
    await h.s.tick()
    assert.equal(h.nudges().length, 2, "capped at 2 consecutive")
    assert.ok(h.nudges().every((n) => n.message.includes("shells: [bzvtnt3ig]")))
  } finally { h.close() }
})

// ---- A GOAL THREAD BEHIND A CHILD (2026-10-02 review) ----------------------------------------------
// A child parks the thread out of the queue, but NOT out of the Goal: evalRestPrompts deliberately ignores
// children and stands down only for an ```awaiting fence or for this reminder taking the rest. With the
// reminder silent behind every child, a self-driving thread waiting on a Workflow got the operator's
// "keep going" on every fenceless rest and nothing that named the park (reproduced: five rests, five Goal
// prompts). So a Goal thread is still asked behind a child — in the SHORT form, with the child's own
// `agents:` fence written out — and the Goal yields to it exactly as it yields to the long reminder.
test("a Goal thread resting behind a running child gets the short variant with its `agents:` fence, and the Goal stands down", async () => {
  const h = nudger({ subAgents: [child()] } as Partial<SessionTelemetry>, { spawnedAt: LEGACY_SPAWN })
  try {
    h.storage.setRecurringPromptBySlug(h.slug, {
      prompt: "keep going until the migration is done", stopHook: true, heartbeat: false, postCompaction: false,
      intervalMs: null, armedAt: "2026-08-11T00:00:00.000Z",
    })
    await h.s.tick()
    assert.equal(h.nudges().length, 1, "the reminder takes the rest")
    assert.ok(!h.delivered.some((m) => m.startsWith("keep going")), "and the Goal stands down on it")
    const msg = h.nudges()[0].message
    assert.match(msg, /^- `a01b2d20b32feab11` — sub-agent: scout the tailer$/m)
    assert.match(msg, /```awaiting\nagents: \[a01b2d20b32feab11\]\nfor: 1h\n---\n/)
    assert.doesNotMatch(msg, /shells:/)
    assert.match(msg, /only this fence holds your Goal/)
    assert.doesNotMatch(msg, /DECIDE RATHER THAN ASK/)
    // The fence it hands over is one the real park check honours while the child runs.
    const { parseSignalFence } = await import("./tailer.ts")
    const { hasDeclaredBackgroundPark } = await import("./board.ts")
    const open = msg.indexOf("```awaiting")
    const fence = parseSignalFence(`Waiting.\n\n${msg.slice(open, msg.indexOf("```", open + 3) + 3)}`)
    const tele = { lastFence: fence, bgShells: [], subAgents: [child()], lastAssistantAt: "2026-08-12T00:00:00.000Z" } as unknown as SessionTelemetry
    assert.equal(hasDeclaredBackgroundPark(tele, Date.parse("2026-08-12T00:01:00.000Z")), true)
  } finally { h.close() }
})

// ---- A FENCE ID YAML WOULD RETYPE (2026-10-02 review) ----------------------------------------------
// The waiting variant is copied verbatim, so an id has to survive the fence's YAML parse as the same
// string. A 9-char base36 runtime id that reads as a number (`1234e5678` → Infinity, `0x1a2b3c4` →
// 27440068) came back as that number, and the park check — which matches strings — refused it.
test("an id YAML would read as a number is quoted in the fence, and the park check honours it", async () => {
  const { signoffNudgeMessage, fenceScalar } = await import("@ntwine/shared")
  const { parseSignalFence } = await import("./tailer.ts")
  const { hasDeclaredBackgroundPark } = await import("./board.ts")
  assert.equal(fenceScalar("bzvtnt3ig"), "bzvtnt3ig", "an ordinary id stays bare")
  assert.equal(fenceScalar("acme/app#391"), "acme/app#391")
  for (const id of ["1234e5678", "0x1a2b3c4", "123456789", "true", "null"]) {
    const sh = shell({ taskId: id })
    const msg = signoffNudgeMessage({ shells: [{ id, label: sh.label }], subAgents: [] })
    const open = msg.indexOf("```awaiting")
    const fence = parseSignalFence(`Waiting.\n\n${msg.slice(open, msg.indexOf("```", open + 3) + 3)}`)
    const tele = { lastFence: fence, bgShells: [sh], subAgents: [], lastAssistantAt: "2026-08-12T00:00:00.000Z" } as unknown as SessionTelemetry
    assert.equal(hasDeclaredBackgroundPark(tele, Date.parse("2026-08-12T00:01:00.000Z")), true, `${id} parks`)
  }
})

// ---- THE INSTANT A CHILD RETURNS (2026-10-02 review) -----------------------------------------------
// The fold retires a child on the `queue-operation` record that ENQUEUES its <task-notification>; the
// USER record that re-invokes the parent lands a beat later. In between, the thread reads idle, agent
// spoke last, no live child — a bare rest by every other guard — and the nudge was minted for the OLD
// rest, then landed after the worker's own reply to the child (1 of 25 real returns). Driven through the
// REAL tailer folding a transcript shaped like the real one, because the window lives in the fold.
test("a rest behind a child is not nudged in the window between the child's notification and the parent's wake", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-signoff-return-"))
  const logDir = join(dir, "-a-project")
  mkdirSync(logDir, { recursive: true })
  const storage = createStorage(join(dir, "ui.db"), "p")
  const slug = "resting"
  // On the wall clock, because the child's liveness is read off its output file's real mtime.
  const T0 = Date.now() - 10_000
  const at = (s: number) => new Date(T0 + s * 1000).toISOString()
  const childOut = join(dir, "a01b2d20b32feab11.output")
  writeFileSync(childOut, "")
  storage.upsertSession({
    // A legacy spawn: under `needs_input:` a running child no longer parks, so "not nudged while it runs"
    // would not hold — the window this pins is the one after it returns, which both contracts share.
    slug, session_id: "sid", thread_name: `ntwine-${slug}`, spawned_at: LEGACY_SPAWN,
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  } as SessionRow)
  const file = join(logDir, "sid.jsonl")
  const rec = (o: unknown) => JSON.stringify(o) + "\n"
  writeFileSync(file, [
    rec({ type: "user", timestamp: at(0), message: { role: "user", content: "go" } }),
    rec({ type: "assistant", timestamp: at(1), message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "Agent", id: "toolu_child", input: { description: "scout the tailer", run_in_background: true, subagent_type: "general-purpose" } }] } }),
    rec({ type: "user", timestamp: at(1.5), message: { content: [{ type: "tool_result", tool_use_id: "toolu_child", content: [{ type: "text", text: `Async agent launched successfully.\nagentId: a01b2d20b32feab11 (internal ID - do not mention to user.)\noutput_file: ${childOut}\nDo NOT Read or tail this file.` }] }] } }),
    rec({ type: "assistant", timestamp: at(2), message: { stop_reason: "end_turn", content: [{ type: "text", text: "Dispatched the scout; I will pick its findings up when it returns." }] } }),
  ].join(""))
  let nowMs = T0 + 5_000
  const tailer = createTailer({
    project: { cwdSlug: "x" } as Project, storage, bus: new Bus(), onChange: () => {},
    now: () => nowMs, paneDead: () => false, sessionLogDir: logDir,
  })
  const s = createScheduler({ wakeQuietWindowMs: 0, storage, tailer, now: () => nowMs, resume: async () => {}, log: () => {} })
  const nudges = () => (storage.db.prepare("SELECT fence_id FROM wake_delivery WHERE fence_id LIKE 'signoff:%'").all() as { fence_id: string }[]).map((r) => r.fence_id)
  try {
    tailer.tick(); await s.tick()
    assert.equal(tailer.get(slug)?.subAgents.filter((a) => a.state === "running").length, 1, "the child is out")
    assert.deepEqual(nudges(), [], "a running child parks the rest")
    // The child returns: ONLY the enqueue record has been written, as at the real instant.
    writeFileSync(file, rec({
      type: "queue-operation", operation: "enqueue", timestamp: at(47), sessionId: "sid",
      content: "<task-notification>\n<task-id>a01b2d20b32feab11</task-id>\n<tool-use-id>toolu_child</tool-use-id>\n<status>completed</status>\n<summary>Agent finished</summary>\n</task-notification>",
    }), { flag: "a" })
    nowMs = T0 + 47_200
    tailer.tick(); await s.tick()
    const tele = tailer.get(slug)
    assert.equal(tele?.turn, "idle", "the window: the parent has not been woken yet")
    assert.equal(tele?.subAgents.filter((a) => a.state === "running").length, 0, "and the child is already retired")
    assert.deepEqual(nudges(), [], "its notification is about to wake the parent, so the old rest is not nudged")
    // Bounded: a notification that never wakes the parent leaves the rest to be asked about after all.
    nowMs = T0 + 47_000 + 61_000
    tailer.tick(); await s.tick()
    assert.deepEqual(nudges(), [`signoff:${at(2)}`])
  } finally { void s.stop(); tailer.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) }
})

// And the same window at SEND: a nudge a Goal thread was handed behind its running child, still undelivered
// when the child returns, is dropped rather than landing after the parent's reply to that child.
test("a nudge still undelivered when the child returns is superseded at send", async () => {
  const T0 = Date.parse("2026-08-12T00:00:00.000Z")
  let nowMs = T0 + 5_000
  let retired: unknown[] = []
  let children: unknown[] = [child()]
  const dir = mkdtempSync(join(tmpdir(), "ntwine-signoff-send-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  const slug = "resting"
  storage.upsertSession({
    slug, session_id: "sid", thread_name: `ntwine-${slug}`, spawned_at: new Date(T0).toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  } as SessionRow)
  storage.setRecurringPromptBySlug(slug, { prompt: "keep going", stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null, armedAt: "2026-08-11T00:00:00.000Z" })
  const sent: string[] = []
  let fail = true
  const s = createScheduler({
    wakeQuietWindowMs: 0, storage, now: () => nowMs, retryBaseMs: 1_000,
    tailer: {
      get: () => ({
        turn: "idle", lastActivityAt: new Date(T0).toISOString(), lastAssistantAt: new Date(T0).toISOString(),
        bgShells: [], pendingQuestion: false, permPrompt: false,
        subAgents: children, retiredSubAgents: retired,
      }),
    } as unknown as Tailer,
    resume: async (_slug, message) => {
      if (fail) { fail = false; throw new Error("runtime busy") }
      sent.push(message)
    },
    log: () => {},
  })
  const state = () => (storage.db.prepare("SELECT state FROM wake_delivery WHERE fence_id LIKE 'signoff:%'").get() as { state: string } | undefined)?.state
  try {
    await s.tick()
    assert.ok(state() && state() !== "delivered", `minted behind the running child, first send failed (${state()})`)
    children = []
    retired = [{ id: "toolu_agent1", taskId: "a01b2d20b32feab11", label: "scout the tailer", status: "completed", finishedAt: new Date(T0 + 30_000).toISOString() }]
    nowMs = T0 + 30_200
    await s.tick()
    assert.equal(state(), "superseded")
    assert.ok(!sent.some((m) => m.includes("without a fence")))
  } finally { void s.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) }
})
