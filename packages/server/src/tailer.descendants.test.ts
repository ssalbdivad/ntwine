// DESCENDANT resolution: a sub-agent's sub-agent, and so on down.
//
// The property under test is the one the drill-in drawer needs and could not previously have: a
// dispatch tool_use id that appears NOWHERE in this thread's own transcript — because a CHILD ran the
// Agent tool, not the thread — still resolves to the right transcript. Every fixture here is shaped
// from the real bytes a three-level broker run wrote to disk (`_live_broker_depth.mts`, 2026-07-28);
// the sidecar bodies are that run's verbatim, only the ids shortened.
//
// The counterpart property matters just as much and is asserted alongside every positive case: an id
// ntwine genuinely cannot place must keep returning undefined (the router maps that to "gone", the drawer
// states it plainly). This path may add resolutions; it may never invent one.
import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage } from "./storage.ts"
import { Bus } from "./bus.ts"
import type { Project } from "./project.ts"
import { createTailer } from "./tailer.ts"
import type { ClaudeRuntimeTask } from "./backend/claude-runtime-ingest.ts"

const SESSION = "11111111-2222-3333-4444-555555555555"
const SLUG = "descendants"

function assistant(content: unknown[]): string {
  return JSON.stringify({ type: "assistant", timestamp: "2026-07-28T18:24:00.000Z", message: { id: "m1", stop_reason: "end_turn", content } })
}

/**
 * A session whose transcript dispatches ONE direct child, plus a flat `subagents/` dir holding that
 * child and its own descendants — exactly claude's layout: every descendant of every depth writes into
 * the ROOT session's dir, beside a `agent-<id>.meta.json` sidecar naming its dispatch tool_use id.
 */
function fixture(runtimeTasks?: readonly ClaudeRuntimeTask[]) {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-descendants-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  const subagents = join(dir, SESSION, "subagents")
  mkdirSync(subagents, { recursive: true })

  // The THREAD's own transcript knows only about its direct child — this is the whole point: the
  // grandchild's dispatch is not in here, so no fold over this file could ever produce it.
  writeFileSync(join(dir, `${SESSION}.jsonl`), `${assistant([
    { type: "tool_use", id: "toolu_child", name: "Agent", input: { description: "LEVEL-ONE", subagent_type: "general-purpose", run_in_background: true } },
  ])}\n`)

  const sidecar = (agentId: string, body: unknown) => writeFileSync(join(subagents, `agent-${agentId}.meta.json`), JSON.stringify(body))
  const transcript = (agentId: string, lines: string[]) => writeFileSync(join(subagents, `agent-${agentId}.jsonl`), `${lines.join("\n")}\n`)

  sidecar("aChild", { agentType: "general-purpose", description: "LEVEL-ONE", toolUseId: "toolu_child", spawnDepth: 1 })
  transcript("aChild", [assistant([{ type: "tool_use", id: "toolu_grand", name: "Agent", input: { description: "LEVEL-TWO", run_in_background: true } }])])

  sidecar("aGrand", { agentType: "general-purpose", description: "LEVEL-TWO", toolUseId: "toolu_grand", parentAgentId: "aChild", spawnDepth: 2 })
  transcript("aGrand", [assistant([{ type: "tool_use", id: "toolu_great", name: "Agent", input: { description: "LEVEL-THREE", run_in_background: true } }])])

  sidecar("aGreat", { agentType: "general-purpose", description: "LEVEL-THREE", toolUseId: "toolu_great", parentAgentId: "aGrand", spawnDepth: 3 })
  transcript("aGreat", [assistant([{ type: "text", text: "LEAF-DONE" }])])

  storage.upsertSession({
    slug: SLUG, session_id: SESSION, thread_name: `ntwine-${SLUG}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: SLUG, state: "open", meta: null, seen_at: null, transcript_id: null,
  })
  storage.setBackend(SLUG, "claude")
  storage.setClaudeRuntime(SLUG, "broker")

  const tailer = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage, bus: new Bus(), sessionLogDir: dir,
    onChange: () => {}, paneDead: () => false,
    ...(runtimeTasks ? { runtimeTasks: () => runtimeTasks } : {}),
  })
  tailer.tick()
  return { tailer, storage, dir, subagents }
}

/**
 * Retire the direct child exactly as the harness does — a `queue-operation` record carrying the
 * <task-notification> XML. Shaped from the real bytes of the notification that produced this bug (nub
 * session 5258ebe4, 2026-07-29): `status: completed` and a summary saying "finished", written the moment
 * the child STOPPED, while the five grandchildren it had just dispatched were all still running.
 */
function notifyChild(dir: string, status: string): void {
  appendFileSync(join(dir, `${SESSION}.jsonl`), `${JSON.stringify({
    type: "queue-operation",
    operation: "enqueue",
    timestamp: "2026-07-28T18:30:00.000Z",
    content: [
      "<task-notification>",
      "<task-id>aChild</task-id>",
      "<tool-use-id>toolu_child</tool-use-id>",
      `<status>${status}</status>`,
      '<summary>Agent "LEVEL-ONE" finished</summary>',
      "<note>A task-notification fires each time this agent stops with no live background children of its own.",
      "The user can send it another message and resume it, so the same task-id may notify more than once.</note>",
      "<result>I've launched the fan-out; I'll continue once it reports.</result>",
      "</task-notification>",
    ].join("\n"),
  })}\n`)
}

/**
 * A DESCENDANT's own terminal notification. Same carrier as notifyChild — the harness enqueues it on
 * the ROOT session, whatever depth the agent that stopped was at — shaped from the real bytes of a
 * depth-2 completion (nub session 0bb9560b, 2026-07-30):
 *
 *   {"type":"queue-operation","operation":"enqueue","timestamp":"2026-07-30T19:25:12.191Z",
 *    "content":"<task-notification>\n<task-id>a26ab44059b4cf3db</task-id>
 *               \n<tool-use-id>toolu_015DGTcSSZbXspTk4LRjH3mq</tool-use-id>
 *               \n<status>completed</status>…"}
 *
 * The timestamp defaults to NOW because that is the only realistic relation to the fixture's transcript
 * files: on disk a notification is written a beat after the record it reports, on the same clock.
 */
function notifyDescendant(dir: string, agentId: string, toolUseId: string, at = new Date().toISOString()): void {
  appendFileSync(join(dir, `${SESSION}.jsonl`), `${JSON.stringify({
    type: "queue-operation",
    operation: "enqueue",
    timestamp: at,
    content: [
      "<task-notification>",
      `<task-id>${agentId}</task-id>`,
      `<tool-use-id>${toolUseId}</tool-use-id>`,
      "<status>completed</status>",
      `<summary>Agent "${agentId}" finished</summary>`,
      "<result>Here is the review.</result>",
      "</task-notification>",
    ].join("\n"),
  })}\n`)
}

// Order matters: the tailer and the db have to let go of the fixture before it is removed, because
// Windows refuses to delete a file another handle still has open (POSIX unlinks it regardless, so the
// wrong order is invisible on macOS and Linux and an EPERM on Windows).
function cleanup(f: { tailer: { stop(): void }; storage: { close(): void }; dir: string }) {
  f.tailer.stop()
  f.storage.close()
  rmSync(f.dir, { recursive: true, force: true })
}

test("descendants: a GRANDCHILD resolves, though its dispatch is in the child's transcript and not the thread's", () => {
  const f = fixture()
  try {
    // Precondition, so a passing assertion below cannot be the direct-child path in disguise. The
    // grandchild IS surfaced now (see the nesting tests below) — but only ever as a DESCENDANT, at
    // depth 2, which is the sidecar path. Nothing the fold does to this thread's transcript can
    // produce it, and `depth` is exactly the witness of which path it came from.
    const surfaced = f.tailer.get(SLUG)?.subAgents.find((view) => view.id === "toolu_grand")
    assert.equal(surfaced?.depth, 2, "the grandchild is deliberately NOT a tracked direct child of this thread")

    const grand = f.tailer.subAgent(SLUG, "toolu_grand")
    assert.ok(grand, "the grandchild's dispatch id resolves")
    assert.equal(grand.outputFile, join(f.subagents, "agent-aGrand.jsonl"))
    assert.equal(grand.taskId, "aGrand", "the sidecar filename supplies the provider's stopTask handle")
  } finally {
    cleanup(f)
  }
})

test("descendants: depth costs nothing — a GREAT-grandchild resolves the same way", () => {
  const f = fixture()
  try {
    const great = f.tailer.subAgent(SLUG, "toolu_great")
    assert.ok(great, "a depth-3 descendant resolves")
    assert.equal(great.outputFile, join(f.subagents, "agent-aGreat.jsonl"))
  } finally {
    cleanup(f)
  }
})

test("descendants: an id that resolves to nothing stays UNRESOLVED — never a guessed parent", () => {
  const f = fixture()
  try {
    assert.equal(f.tailer.subAgent(SLUG, "toolu_never_dispatched"), undefined,
      "an unknown id must degrade to gone, not to some nearby descendant")
  } finally {
    cleanup(f)
  }
})

test("descendants: a junk or half-written sidecar is skipped, never thrown on", () => {
  const f = fixture()
  try {
    writeFileSync(join(f.subagents, "agent-aTorn.meta.json"), '{"toolUseId":"toolu_to') // truncated mid-write
    writeFileSync(join(f.subagents, "agent-aList.meta.json"), "[1,2,3]") // valid JSON, wrong shape
    writeFileSync(join(f.subagents, "agent-aNull.meta.json"), "null")
    // The good ones still resolve, and the bad ones simply do not.
    assert.ok(f.tailer.subAgent(SLUG, "toolu_grand"), "a torn neighbour must not cost a healthy sidecar")
    assert.equal(f.tailer.subAgent(SLUG, "toolu_torn"), undefined)
  } finally {
    cleanup(f)
  }
})

// ── SURFACING: the descendants have to REACH the board, not just resolve on a drill-in ────────────
//
// Resolving a grandchild answers "what is behind this id"; these answer "what does the operator SEE".
// Before this, `subAgents` was direct children only, so a worker that fanned out THROUGH a sub-agent
// showed one row and the entire branch under it was invisible on every surface at once.

test("nesting: the whole tree is surfaced, depth-first under the child it hangs off", () => {
  const f = fixture()
  try {
    const views = f.tailer.get(SLUG)?.subAgents ?? []
    assert.deepEqual(views.map((v) => [v.id, v.depth, v.parentId]), [
      ["toolu_child", undefined, undefined], // a direct child is unchanged — no depth, no parent
      ["toolu_grand", 2, "toolu_child"],
      ["toolu_great", 3, "toolu_grand"],
    ], "each descendant follows its parent, carrying the parent's DISPATCH id as the join key")
    // The row has to be renderable on its own: a label, a real dispatch instant, and the cell it runs as.
    const grand = views[1]
    assert.equal(grand?.label, "LEVEL-TWO")
    assert.equal(grand?.subagentType, "general-purpose")
    assert.ok(grand?.startedAt && !Number.isNaN(Date.parse(grand.startedAt)), "a real ISO instant, off the sidecar's own mtime")
  } finally {
    cleanup(f)
  }
})

test("nesting: a QUIET descendant leaves the list — silence alone retires the row", () => {
  const f = fixture()
  try {
    // Both descendants go quiet. A direct child would linger as `stale` until its task-notification;
    // a descendant must not, or every grandchild that ever ran would pin a phantom row forever.
    rmSync(join(f.subagents, "agent-aGreat.jsonl"))
    rmSync(join(f.subagents, "agent-aGrand.jsonl"))
    assert.deepEqual(f.tailer.get(SLUG)?.subAgents.map((v) => v.id), ["toolu_child"],
      "the thread keeps its own child and drops the quiet branch")
  } finally {
    cleanup(f)
  }
})

test("nesting: a quiet descendant with something LIVE under it keeps its row", () => {
  const f = fixture()
  try {
    // Only the middle level goes quiet; the leaf is still appending. Dropping the middle row would
    // leave the live great-grandchild indented under the wrong agent, so it stays — marked stale.
    rmSync(join(f.subagents, "agent-aGrand.jsonl"))
    const views = f.tailer.get(SLUG)?.subAgents ?? []
    assert.deepEqual(views.map((v) => [v.id, v.state]), [
      ["toolu_child", "running"],
      ["toolu_grand", "stale"],
      ["toolu_great", "running"],
    ])
  } finally {
    cleanup(f)
  }
})

// A descendant is RUNNING-only on the board, so for one the stale misreading was worse than a grey
// dot: a grandchild blocked in a wait it sized itself (`timeout: 3600000`, say) left the tree at minute
// 15 while it was still working. It is live until that call's declared bound, the same as a direct child.
test("nesting: a descendant blocked in a Bash wait it sized itself keeps its row until 15 minutes past the deadline", () => {
  // One fixture per reading: the subtree is memoized per second, so a second reading inside the same
  // fixture would only read the first one back.
  const grand = (call: { [key: string]: unknown }, issuedMinutesAgo: number) => {
    const f = fixture()
    try {
      rmSync(join(f.subagents, "agent-aGreat.jsonl")) // the leaf is gone, so nothing below keeps aGrand shown
      const issued = new Date(Date.now() - issuedMinutesAgo * 60_000)
      const path = join(f.subagents, "agent-aGrand.jsonl")
      writeFileSync(path, `${JSON.stringify({ type: "assistant", timestamp: issued.toISOString(), message: { id: "m-wait", stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_wait", name: "Bash", input: call }] } })}\n`)
      utimesSync(path, issued, issued) // the call is the last thing it wrote
      f.tailer.tick()
      return f.tailer.get(SLUG)?.subAgents.find((v) => v.id === "toolu_grand")?.state
    } finally {
      cleanup(f)
    }
  }
  const wait = { command: "until grep -q '^DONE' gates.log; do sleep 15; done", timeout: 3_600_000 }
  assert.equal(grand(wait, 20), "running", "20 minutes into the hour it declared, it is still on the board")
  assert.equal(grand(wait, 80), undefined, "20 minutes past that hour with nothing written, it leaves")
  assert.equal(grand({ command: "cargo build" }, 20), undefined, "a call that names no timeout keeps the plain clock")
})

test("nesting: a branch whose ROOT child is gone is over, whatever its own mtimes say", () => {
  const f = fixture()
  try {
    // Dismiss the direct child exactly as a terminal signal would. Its descendants' transcripts are
    // untouched and still fresh — the only thing that changed is that this thread stopped tracking the
    // child, and that alone must take the whole branch off the board.
    // `dismissOp` is optional on the interface only so a narrow test stub need not supply it (see
    // tailer.ts); this fixture holds the real tailer, which always does.
    assert.equal(f.tailer.dismissOp!(SLUG, "toolu_child"), true)
    assert.deepEqual(f.tailer.get(SLUG)?.subAgents.map((v) => v.id), [],
      "no orphan rows survive their root child")
  } finally {
    cleanup(f)
  }
})

// ── RESTED roots: the child stopped, its own fan-out did not ──────────────────────────────────────
//
// The bug these pin, in the maintainer's words: "Subagent spun up a bunch of sub-subagents, then seemed
// to rest, but when it rested, it totally disappeared from the UI." `status: completed` is what the
// harness sends when a sub-agent merely STOPS — its own notification says so, and says the same task-id
// may notify again — so retiring the row on it took the whole live branch off the board with it.

test("rested: a child that stops while its own fan-out runs KEEPS the branch on the board", () => {
  const f = fixture()
  try {
    // Precondition: the branch is live and rooted in a live child.
    assert.deepEqual(f.tailer.get(SLUG)?.subAgents.map((v) => [v.id, v.state]), [
      ["toolu_child", "running"],
      ["toolu_grand", "running"],
      ["toolu_great", "running"],
    ])

    notifyChild(f.dir, "completed")
    f.tailer.tick()

    const views = f.tailer.get(SLUG)?.subAgents ?? []
    assert.deepEqual(views.map((v) => [v.id, v.state, v.depth]), [
      ["toolu_child", "rested", undefined], // stopped — but still the anchor its descendants hang off
      ["toolu_grand", "running", 2],
      ["toolu_great", "running", 3],
    ], "the notification retires the RUN, not the branch")
    // The row has to render on its own terms: its label, its cell, and its real DISPATCH instant (the
    // duration under the prompt box reads "how long this branch has been going", not "since it stopped").
    assert.equal(views[0]?.label, "LEVEL-ONE")
    assert.equal(views[0]?.subagentType, "general-purpose")
    assert.equal(views[0]?.startedAt, "2026-07-28T18:24:00.000Z")
    // And it is emphatically NOT live work: nothing keyed on "running" may be held back by it.
    assert.equal(views.filter((v) => v.state === "running" && (v.depth ?? 1) === 1).length, 0)
    // Its drawer still resolves — the row is retired, so the lookup answers from the retained ring.
    assert.equal(f.tailer.subAgent(SLUG, "toolu_child")?.state, "done")
  } finally {
    cleanup(f)
  }
})

test("rested: the anchor retires itself — when the fan-out goes quiet the whole branch leaves", () => {
  const f = fixture()
  try {
    notifyChild(f.dir, "completed")
    f.tailer.tick()
    assert.equal(f.tailer.get(SLUG)?.subAgents.length, 3, "still anchored while the descendants append")

    // Both descendants fall silent. A rested root has no live work left to hold up, so it must not
    // linger: this is the property that makes admitting a retired row safe at all.
    rmSync(join(f.subagents, "agent-aGreat.jsonl"))
    rmSync(join(f.subagents, "agent-aGrand.jsonl"))
    assert.deepEqual(f.tailer.get(SLUG)?.subAgents ?? [], [], "no phantom survives its own fan-out")
  } finally {
    cleanup(f)
  }
})

test("rested: KILLED never anchors — the operator's dismiss ends the branch, whatever the mtimes say", () => {
  // `stopped` is the recovery notification a new session emits for ops the dead process left behind; the
  // fold maps it to `killed`. The owning process is gone, so nothing under it may keep the row alive.
  const swept = fixture()
  try {
    notifyChild(swept.dir, "stopped")
    swept.tailer.tick()
    assert.deepEqual(swept.tailer.get(SLUG)?.subAgents ?? [], [], "a swept orphan takes its branch with it")
  } finally {
    cleanup(swept)
  }

  // And the × on a rested row means the same thing. It is no longer live, so dismissOp re-stamps the
  // retained row `killed` — the one status that stops anchoring — instead of silently doing nothing.
  const dismissed = fixture()
  try {
    notifyChild(dismissed.dir, "completed")
    dismissed.tailer.tick()
    assert.equal(dismissed.tailer.get(SLUG)?.subAgents[0]?.state, "rested")
    assert.equal(dismissed.tailer.dismissOp!(SLUG, "toolu_child"), true, "the × acts on a rested row")
    assert.deepEqual(dismissed.tailer.get(SLUG)?.subAgents ?? [], [])
    assert.equal(dismissed.tailer.dismissOp!(SLUG, "toolu_child"), false, "and is a no-op the second time")
    assert.ok(dismissed.tailer.subAgent(SLUG, "toolu_child"), "dismissing never costs the drawer its transcript")
  } finally {
    cleanup(dismissed)
  }
})

// ── a descendant's OWN rest event ─────────────────────────────────────────────────────────────────
//
// The bug these pin, reported by the maintainer: "when I click into the sub-sub-agents, a lot of them
// have rested or stopped, even though they're still showing up as running actively in my UI … they've
// also been running for a weirdly long time."
//
// Descendant liveness used to be silence and nothing else, so a rested grandchild read `running` for
// the whole 15-minute staleness window with its duration counting up from spawn. The rest signal was
// there the whole time: when a descendant stops, its <task-notification> is enqueued on the ROOT
// session — the transcript this fold already reads — carrying the task-id that IS its agent id.
// trackCompletions parsed the record and dropped it, because a descendant is never in `subAgents`.
// Measured on the live board (session 0bb9560b): 36 of 38 depth-2 descendants had one sitting in the
// root transcript, each landing 0-13s after that descendant's own last write; the 2 without one were
// the 2 genuinely still running.

test("rest: a notified descendant leaves the board AT ONCE, though its transcript still stats fresh", () => {
  const f = fixture()
  try {
    // Precondition: freshly-written transcripts, so silence retires nothing here. This is exactly the
    // state in which the old reading held the row for 15 more minutes.
    assert.deepEqual(f.tailer.get(SLUG)?.subAgents.map((v) => v.id), ["toolu_child", "toolu_grand", "toolu_great"])

    notifyDescendant(f.dir, "aGreat", "toolu_great")
    notifyDescendant(f.dir, "aGrand", "toolu_grand")
    f.tailer.tick()

    assert.deepEqual(f.tailer.get(SLUG)?.subAgents.map((v) => v.id), ["toolu_child"],
      "both descendants reported themselves finished — nothing under the child is live")
    // And the drawer says so too, rather than inviting a steer into a finished agent.
    assert.equal(f.tailer.subAgent(SLUG, "toolu_grand")?.state, "done")
    assert.equal(f.tailer.subAgent(SLUG, "toolu_great")?.state, "done")
  } finally {
    cleanup(f)
  }
})

test("rest: only the LEAF notifies — its parent is still working, so the parent keeps its row", () => {
  const f = fixture()
  try {
    notifyDescendant(f.dir, "aGreat", "toolu_great")
    f.tailer.tick()
    assert.deepEqual(f.tailer.get(SLUG)?.subAgents.map((v) => [v.id, v.state]), [
      ["toolu_child", "running"],
      ["toolu_grand", "running"],
    ], "one descendant's completion says nothing about its parent's")
  } finally {
    cleanup(f)
  }
})

test("rest: a notified ANCESTOR keeps its row while something under it still runs", () => {
  const f = fixture()
  try {
    // The middle level rests holding a live leaf — the same shape as the RESTED-root case one level
    // down. Dropping its row would leave the live great-grandchild indented under the wrong agent.
    notifyDescendant(f.dir, "aGrand", "toolu_grand")
    f.tailer.tick()
    assert.deepEqual(f.tailer.get(SLUG)?.subAgents.map((v) => [v.id, v.state]), [
      ["toolu_child", "running"],
      ["toolu_grand", "stale"],
      ["toolu_great", "running"],
    ])
  } finally {
    cleanup(f)
  }
})

test("rest: a RESUMED descendant reads running again — the notification is measured, not trusted", () => {
  const f = fixture()
  try {
    // "The same task-id may notify more than once" — the harness says so in the notification itself.
    // The leaf notifies normally and stays quiet, so it settles. Its parent's notification is stamped
    // well in the past and its transcript then written AFTER: that is a descendant which stopped, was
    // sent another message, and is working again. On the live board this was one descendant in 36 —
    // it wrote again 172s past its own notification while the other 35 never wrote again at all.
    notifyDescendant(f.dir, "aGreat", "toolu_great")
    notifyDescendant(f.dir, "aGrand", "toolu_grand", new Date(Date.now() - 120_000).toISOString())
    writeFileSync(join(f.subagents, "agent-aGrand.jsonl"), `${assistant([{ type: "text", text: "picked it back up" }])}\n`)
    f.tailer.tick()

    const views = f.tailer.get(SLUG)?.subAgents ?? []
    assert.deepEqual(views.map((v) => [v.id, v.state]), [["toolu_child", "running"], ["toolu_grand", "running"]],
      "the resumed descendant is live again; the leaf that stayed quiet after its own notify is not")
    assert.equal(f.tailer.subAgent(SLUG, "toolu_grand")?.state, "running")
  } finally {
    cleanup(f)
  }
})

test("rest: a write inside the grace window is the notification's own beat, not a resume", () => {
  const f = fixture()
  try {
    // The two instants come off different clocks — a record's ISO timestamp against a file's mtime —
    // and the notification is written just AFTER the work it reports. A bare `mtime > notified` would
    // call this settled descendant resumed on sub-second skew.
    notifyDescendant(f.dir, "aGrand", "toolu_grand", new Date(Date.now() - 2_000).toISOString())
    notifyDescendant(f.dir, "aGreat", "toolu_great", new Date(Date.now() - 2_000).toISOString())
    f.tailer.tick()
    assert.deepEqual(f.tailer.get(SLUG)?.subAgents.map((v) => v.id), ["toolu_child"])
  } finally {
    cleanup(f)
  }
})

test("rest: the branch retires even after its ROOT child has already rested", () => {
  const f = fixture()
  try {
    // A rested child still anchors its subtree, so this is the ordering that actually happens on a busy
    // thread: the direct child stops first, then its fan-out reports in one by one. The fold must keep
    // correlating notifications with no live entry left to match — the guard that returned early on an
    // empty live map is exactly what would have stranded the branch for the full staleness window.
    notifyChild(f.dir, "completed")
    f.tailer.tick()
    assert.equal(f.tailer.get(SLUG)?.subAgents.length, 3, "anchored while the fan-out runs")

    notifyDescendant(f.dir, "aGreat", "toolu_great")
    notifyDescendant(f.dir, "aGrand", "toolu_grand")
    f.tailer.tick()
    assert.deepEqual(f.tailer.get(SLUG)?.subAgents ?? [], [],
      "the last live descendant reported in, so the rested anchor has nothing left to hold")
  } finally {
    cleanup(f)
  }
})

test("descendants: the provider's terminal task says DONE; silence alone only says stale", () => {
  const finished: ClaudeRuntimeTask[] = [
    { taskId: "aGrand", terminal: true, outcome: "completed", seenInLevel: true, updatedAt: Date.now() },
  ]
  const done = fixture(finished)
  try {
    assert.equal(done.tailer.subAgent(SLUG, "toolu_grand")?.state, "done",
      "the task table is authoritative when it holds the row — its task id IS the agent id")
  } finally {
    cleanup(done)
  }

  const quiet = fixture()
  try {
    // No task table at all: a freshly-written transcript is "running", and nothing may call it done.
    assert.equal(quiet.tailer.subAgent(SLUG, "toolu_grand")?.state, "running")
    rmSync(join(quiet.subagents, "agent-aGrand.jsonl"))
    assert.equal(quiet.tailer.subAgent(SLUG, "toolu_grand")?.state, "stale",
      "a transcript that no longer stats is stale — never a completion nothing reported")
  } finally {
    cleanup(quiet)
  }
})

// ── THE SUBTREE A STOP HAS TO NAME ──────────────────────────────────────────────────────────────
//
// `stopTask` ends exactly one task and its registry is flat and session-wide, so stopping a sub-agent
// reaches none of its own fan-out. That flatness also routes a completion to the SESSION rather than
// to whoever dispatched it, so the survivors report into the ROOT thread under an agent the operator
// watched die (nub session a0c5fba3, 2026-07-31: the × marked `adabd4aeedf52ef6c` stopped at 19:54:22
// and its two children wrote on until 19:56:09 and 19:56:44). These pin the enumeration that fixes it.

test("subtree: a stop on the direct child names every live descendant, deepest first", () => {
  const f = fixture()
  try {
    assert.deepEqual(f.tailer.subAgentDescendantTasks?.(SLUG, "toolu_child"), ["aGreat", "aGrand"],
      "deepest first, so no still-running parent can spawn into the gap between two sequential stops")
  } finally {
    cleanup(f)
  }
})

test("subtree: it is keyed on the DISPATCH id and asks the subtree below it, not the whole dir", () => {
  const f = fixture()
  try {
    assert.deepEqual(f.tailer.subAgentDescendantTasks?.(SLUG, "toolu_grand"), ["aGreat"],
      "stopping the grandchild reaches only what hangs off IT")
    assert.deepEqual(f.tailer.subAgentDescendantTasks?.(SLUG, "toolu_great"), [],
      "a leaf has no subtree")
  } finally {
    cleanup(f)
  }
})

test("subtree: a SETTLED descendant is not stopped again, and an unknown id resolves to nothing", () => {
  // Running-only, for the same reason the surfaced tree is: a sidecar is written once and never
  // deleted, so admitting a finished one would fire a stop at every grandchild that ever ran.
  const f = fixture()
  try {
    notifyDescendant(f.dir, "aGreat", "toolu_great")
    f.tailer.tick()
    assert.deepEqual(f.tailer.subAgentDescendantTasks?.(SLUG, "toolu_child"), ["aGrand"],
      "the great-grandchild reported terminal, so it is no longer a stop target")
    assert.deepEqual(f.tailer.subAgentDescendantTasks?.(SLUG, "toolu_nobody"), [],
      "an id no sidecar claims resolves to nothing rather than guessing at a subtree")
  } finally {
    cleanup(f)
  }
})

// D3 from the rename audit, closed. Claude Code pins a session's transcript to the bucket for the cwd
// it was BORN in, so renaming the checkout leaves the transcript — AND the `<sessionId>/subagents/` tree
// beside it — in a bucket ntwine no longer derives. On the real board that is 610 sidecar files, 310 MB.
// The claim was that the sibling sweep (discover.ts) covers this for free, because `sessionDirOf` builds
// the sidecar dir from `state.path` and the sweep rebinds `state.path`. That was a CODE READING and the
// auditor flagged it as the surface most worth running. It could not be settled against the real board
// (every registered thread with stranded sidecars is archived, so the tailer never tails it), so it is
// settled here: the whole tree one bucket over, resolved through the drawer's own lookup.
function strandedFixture() {
  const root = mkdtempSync(join(tmpdir(), "ntwine-stranded-sidecars-"))
  const born = join(root, "-Users-me-projects-fray") // where the session was born, and still writes
  const derived = join(root, "-Users-me-projects-ntwine") // what ntwine derives from the CURRENT path
  mkdirSync(born, { recursive: true })
  mkdirSync(derived, { recursive: true })
  const storage = createStorage(join(root, "ui.db"), "p")
  const subagents = join(born, SESSION, "subagents")
  mkdirSync(subagents, { recursive: true })

  writeFileSync(join(born, `${SESSION}.jsonl`), `${assistant([
    { type: "tool_use", id: "toolu_child", name: "Agent", input: { description: "LEVEL-ONE", subagent_type: "general-purpose", run_in_background: true } },
  ])}\n`)
  writeFileSync(join(subagents, "agent-aChild.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "LEVEL-ONE", toolUseId: "toolu_child", spawnDepth: 1 }))
  // The child dispatches a GRANDCHILD, whose dispatch appears ONLY here — never in the thread's own
  // transcript. That is the sidecar-resolved path, the one that actually joins `sessionDirOf(state)` to
  // a file on disk, so it is what proves the rebind carried the whole tree.
  writeFileSync(join(subagents, "agent-aChild.jsonl"), `${assistant([{ type: "tool_use", id: "toolu_grand", name: "Agent", input: { description: "LEVEL-TWO", run_in_background: true } }])}\n`)
  writeFileSync(join(subagents, "agent-aGrand.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "LEVEL-TWO", toolUseId: "toolu_grand", parentAgentId: "aChild", spawnDepth: 2 }))
  writeFileSync(join(subagents, "agent-aGrand.jsonl"), `${assistant([{ type: "text", text: "LEAF-DONE" }])}\n`)

  storage.upsertSession({
    slug: SLUG, session_id: SESSION, thread_name: `ntwine-${SLUG}`, spawned_at: "2026-07-01T00:00:00.000Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: SLUG, state: "open", meta: null, seen_at: null, transcript_id: null,
  })
  storage.setBackend(SLUG, "claude")
  storage.setClaudeRuntime(SLUG, "broker")

  const tailer = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage, bus: new Bus(), sessionLogDir: derived, // ntwine looks HERE; nothing of this session is here
    onChange: () => {}, paneDead: () => false,
    now: () => Date.parse("2026-07-01T01:00:00.000Z"), // past the discovery grace window
  })
  tailer.tick()
  tailer.tick()
  return { tailer, storage, root, derived, subagents }
}

test("descendants: a sub-agent tree stranded in the PRE-RENAME bucket still resolves through the drawer", () => {
  const f = strandedFixture()
  try {
    // The precondition that makes the assertion mean something: the bucket ntwine derives holds nothing.
    assert.deepEqual(readdirSync(f.derived), [], "the current-path bucket is empty — the pre-fix derivation had nowhere to look")

    // The DESCENDANT is the witness: nothing in this thread's own transcript mentions `toolu_grand`, so
    // the only way to place it is the sidecar index under `sessionDirOf(state)` — which exists solely in
    // the pre-rename bucket. `depth` 2 confirms it came from that path and not the tracked-child one.
    const surfaced = f.tailer.get(SLUG)?.subAgents.find((view) => view.id === "toolu_grand")
    assert.equal(surfaced?.depth, 2, "the grandchild is placed as a DESCENDANT, via the stranded sidecar index")

    const grand = f.tailer.subAgent(SLUG, "toolu_grand")
    assert.ok(grand, "the grandchild resolves even though its whole tree is one bucket over")
    assert.equal(grand.outputFile, join(f.subagents, "agent-aGrand.jsonl"), "resolved into the BORN bucket, not the derived one")
    assert.equal(grand.taskId, "aGrand", "the sidecar filename supplies the provider's stopTask handle")

    // This path may add resolutions; it may never invent one — the same counterpart the rest of this
    // file asserts, restated for the widened lookup.
    assert.equal(f.tailer.subAgent(SLUG, "toolu_nobody"), undefined, "an id no sidecar claims still resolves to nothing")
  } finally {
    cleanup({ ...f, dir: f.root })
  }
})

// ---- A DIRECT CHILD WITH NO ACK-NAMED PATH STILL HAS A CLOCK (2026-08-26) ----
//
// `outputFile` is parsed out of the launch ack's PROSE (launchOutputFile), so a harness wording change
// silently un-resolves it — and `entryStale` used to return false on EVERY clock without one, meaning
// such a child could never go stale and parked its thread forever (board.hasLiveOwnWork). Audited
// 2026-08-02 and left in place; measured at 61 of 4068 dispatches (1.50%).
//
// The comment that recorded the hole also named the fix, and this is it: fall back to the SIDECAR INDEX,
// which maps the dispatch tool_use id to the descendant's own `agent-<id>.jsonl`. This fixture is the
// exact shape — its transcript dispatches `toolu_child` with no ack at all, so `outputFile` is unset and
// the sidecar is the only thing that can place the file.
//
// It is also the case that reverted the OTHER candidate fix (a clock on the dispatch instant): a direct
// child with no ack-named path whose own transcript IS being appended to is genuinely running, and must
// keep reading that way. Both halves are asserted here.
test("a direct child with no ack-named outputFile goes stale off its sidecar transcript, and stays running while that transcript is fresh", () => {
  const f = fixture()
  try {
    const child = () => f.tailer.get(SLUG)?.subAgents.find((v) => v.id === "toolu_child")
    // The transcript this fixture just wrote is seconds old, so the child is running — and the reading
    // comes from the sidecar path, since nothing ever gave this dispatch an outputFile.
    assert.equal(f.tailer.subAgent(SLUG, "toolu_child")?.outputFile, undefined, "the fixture's dispatch carries no launch ack")
    assert.equal(child()?.state, "running", "a freshly-written child transcript reads as running")
    assert.ok(child()?.lastActivityAt, "…and its last-activity instant resolves off the same path")

    // Age the child's own transcript past SUBAGENT_STALE_MS. Before the sidecar fallback this changed
    // nothing at all: with no path there was no clock, and the row read "running" forever.
    const aged = new Date(Date.now() - 20 * 60_000)
    utimesSync(join(f.subagents, "agent-aChild.jsonl"), aged, aged)
    f.tailer.tick()
    assert.equal(child()?.state, "stale", "20 minutes without an append is stale, via the sidecar path")

    // This path may add a clock; it may never invent one. A child whose sidecar names no transcript at
    // all keeps the old, deliberately-biased-to-running behaviour.
    rmSync(join(f.subagents, "agent-aChild.meta.json"))
    f.tailer.tick()
    assert.equal(child()?.state, "running", "no sidecar, no clock — never stale on a guess")
  } finally {
    cleanup(f)
  }
})
