// WHERE A REST OUT OF THE QUEUE SITS (maintainer 2026-10-05) — the fence's `status:` answer and the board's
// band verdict, ThreadView.waitStatus. `working` is Running and spins, `watching` is Snoozed and still,
// `needs_input` is the queue. The decision is NEEDS_INPUT_REQUIRED_AT's paragraph in @ntwine/shared; the
// verdict is board.deriveWaitStatus; needs-input.test.ts pins the queue rule the older `needs_input:` line
// set, which the alias still drives.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { activeBandThread, agentParked, awaitingNeedsInput, awaitingStatus, hasLiveOps, isSnoozed, NEEDS_INPUT_REQUIRED_AT, needsInputRequired, sectionOf, splitAwaitingFrontmatter, type AwaitingHint, type GithubWatchStatus, type ThreadView } from "@ntwine/shared"
import { createBoard, deriveAwaitingBackground, deriveNeedsYou, deriveWaitStatus, type RegisteredWatch } from "./board.ts"
import { GITHUB_STATUS_SETTING, type GithubStatusBook } from "./awaiting.ts"
import { Bus } from "./bus.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import type { Project } from "./project.ts"
import type { SessionTelemetry, Tailer } from "./tailer.ts"

const CUT = Date.parse(NEEDS_INPUT_REQUIRED_AT)
const NEW_SPAWN = new Date(CUT + 60_000).toISOString()
const LEGACY_SPAWN = new Date(CUT - 86_400_000).toISOString()
const AT = new Date(CUT + 3_600_000).toISOString() // the rest
const NOW = Date.parse(AT) + 5 * 60_000

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug: "t", session_id: "s", thread_name: "ntwine-t", spawned_at: NEW_SPAWN, last_read_at: null,
    unread: 0, exited: 0, archived: 0, rested_at: AT, title_auto: 0, title: null,
    state: "open", meta: null, seen_at: null, transcript_id: null, ...over,
  }
}
const LIVE_AGENT = { id: "toolu_agent", taskId: "a01b2d20", label: "poll the release feed", startedAt: AT, state: "running" as const }
const LIVE_SHELL = { id: "toolu_shell", taskId: "bzvtnt3ig", label: "nub run bench", startedAt: AT, state: "running" as const }
const DEV_SERVER = { id: "toolu_dev", taskId: "bdevsrv01", label: "nub run dev", startedAt: AT, state: "running" as const }
function tele(over: Partial<SessionTelemetry> = {}): SessionTelemetry {
  return { turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, lastAssistantAt: AT, ...over } as SessionTelemetry
}
const fence = (...hints: AwaitingHint[]) => ({ lastFence: { kind: "awaiting" as const, body: "", hints } })
const status = (value: string): AwaitingHint => ({ kind: "status", value })
const FOR_2H: AwaitingHint = { kind: "for", value: "2h" }
const PR = "acme/app#391"
const ci = (over: Partial<GithubWatchStatus> = {}): GithubWatchStatus => ({
  checks: "running", running: 3, passed: 9, failed: 0, skipped: 0, gated: 0, gating: [], failing: [],
  merge: "mergeable", state: "open", polledAt: AT, ...over,
})

// The board's own order — the queue rule first, then the card fact, then the band — with each input named.
function place(r: SessionRow, t: SessionTelemetry, extra: { github?: GithubStatusBook; prs?: string[]; timers?: string[]; watches?: RegisteredWatch[]; runtime?: "turn-idle" | "exited" | "running"; inFlight?: boolean; now?: number } = {}) {
  const runtime = extra.runtime ?? "turn-idle"
  const now = extra.now ?? NOW
  const prs = new Set(extra.prs ?? [])
  const timers = new Set(extra.timers ?? [])
  const github = extra.github ?? {}
  const watches = extra.watches ?? []
  const needsYou = deriveNeedsYou(r, t, runtime, false, now, undefined, true, false, github, prs, timers, watches, 0, extra.inFlight ?? false)
  const card = deriveAwaitingBackground(r, t, runtime, false, now, undefined, false, github, prs, timers, watches, 0)
  return { needsYou, waitStatus: deriveWaitStatus(t, runtime, needsYou, card, extra.inFlight ?? false, now, github, prs, watches, needsInputRequired(r.spawned_at)) }
}

// ---- THE GRAMMAR ---------------------------------------------------------------------------------

test("`status:` is one structural line with three words, read case- and hyphen-blind", () => {
  for (const word of ["working", "watching", "needs_input"] as const) {
    const fence = splitAwaitingFrontmatter(`shells: [bzvtnt3ig]\nstatus: ${word}\nfor: 2h`)
    assert.deepEqual(fence.hints.find((h) => h.kind === "status"), { kind: "status", value: word })
    assert.equal(fence.body, "", "a quiet park is the fence alone")
    assert.equal(awaitingStatus(fence), word)
    assert.equal(awaitingNeedsInput(fence), word === "needs_input", "the queue reads the same answer")
  }
  assert.equal(awaitingStatus(splitAwaitingFrontmatter("shells: [x]\nstatus: Needs-Input\nfor: 2h")), "needs_input")
  assert.equal(awaitingStatus(splitAwaitingFrontmatter("shells: [x]\nstatus: WATCHING\nfor: 2h")), "watching")
})

test("a word ntwine cannot read is no answer, so the fence's own derivation stands", () => {
  const fence = splitAwaitingFrontmatter("prs: [acme/app#1]\nstatus: busy\nfor: 2h")
  assert.deepEqual(fence.hints.find((h) => h.kind === "status"), { kind: "status", value: "busy" })
  assert.equal(awaitingStatus(fence), "watching")
  assert.equal(awaitingNeedsInput(fence), false)
  // …unless the older line answers beside it.
  assert.equal(awaitingNeedsInput(splitAwaitingFrontmatter("shells: [x]\nstatus: busy\nneeds_input: false\nfor: 2h")), false)
})

test("the older `needs_input:` line is an alias: true is the queue, false leaves the place to ntwine", () => {
  const yes = splitAwaitingFrontmatter("shells: [x]\nneeds_input: true\nfor: 2h")
  assert.equal(awaitingStatus(yes), "needs_input")
  const no = splitAwaitingFrontmatter("shells: [x]\nneeds_input: false\nfor: 2h")
  assert.equal(awaitingStatus(no), null, "no place was named — deriveWaitStatus reads the work")
  assert.equal(awaitingNeedsInput(no), false, "but it still answers the queue")
  // `status:` wins over the older line when both are written.
  assert.equal(awaitingStatus(splitAwaitingFrontmatter("shells: [x]\nneeds_input: true\nstatus: watching\nfor: 2h")), "watching")
})

test("steps and questions wait on the human, so they are `needs_input` whatever the line says", () => {
  const steps = splitAwaitingFrontmatter("steps:\n  - Run `npm login`\nstatus: watching")
  assert.equal(awaitingStatus(steps), "needs_input")
  assert.equal(awaitingNeedsInput(steps), true)
  const asked = splitAwaitingFrontmatter("questions: [qst_ab12cd34]\nstatus: working")
  assert.equal(awaitingStatus(asked), "needs_input")
})

test("the hint cap counts items only, so a full fence keeps its answer and its duration", () => {
  // Eight items is AWAITING_HINT_MAX. Until 2026-10-05 the cap counted every line, so the scalars after
  // the eighth item were dropped — a fence the correction could never satisfy, however it was re-sent.
  const shells = Array.from({ length: 9 }, (_, i) => `b${i}`).join(", ")
  const fence = splitAwaitingFrontmatter(`prs: [${shells}]\nstatus: working\nfor: 2h\ntitle: Nine shards`)
  const { hints } = fence
  assert.equal(hints.filter((h) => h.kind === "pr").length, 8, "the items are still capped")
  assert.equal(awaitingStatus(fence), "working", "the written line survives the cap and overrides the derived watching")
  assert.deepEqual(hints.find((h) => h.kind === "for"), { kind: "for", value: "2h" })
  assert.deepEqual(hints.find((h) => h.kind === "title"), { kind: "title", value: "Nine shards" })
})

// ---- THE DERIVATION (maintainer 2026-10-24) -----------------------------------------------------------
// A fence that writes no `status:` is answered by what it says: words for the user queue it, its own work
// alone is Working, and anything waiting on the world is Waiting. A written line overrides all three.

const derived = (text: string) => awaitingStatus(splitAwaitingFrontmatter(text))

test("prose under the `---` derives needs_input, whatever it names", () => {
  assert.equal(derived("shells: [bzvtnt3ig]\n---\nThe dev server is up on :5173; try the new sidebar."), "needs_input")
  assert.equal(derived("prs: [acme/app#391]\n---\nCI is green; the PR is ready for your review."), "needs_input")
})

test("only shells, agents and timers derive working", () => {
  assert.equal(derived("shells: [bzvtnt3ig]"), "working")
  assert.equal(derived("agents: [a01b2d20]\ntimers: [tmr_a1]"), "working")
})

test("one outside item derives watching, beside the thread's own work or alone", () => {
  for (const outside of ["prs: [acme/app#391]", "threads: [@release-bot]", "commands: [cmw_ab12]", "terminals: [@nub-run-dev]"]) {
    assert.equal(derived(outside), "watching", outside)
    assert.equal(derived(`shells: [bzvtnt3ig]\nagents: [a01b2d20]\n${outside}`), "watching", `${outside} beside a shell and an agent`)
  }
})

test("a written status overrides the derivation, prose included", () => {
  assert.equal(derived("prs: [acme/app#391]\nstatus: working"), "working")
  assert.equal(derived("shells: [bzvtnt3ig]\nstatus: watching"), "watching")
  assert.equal(derived("shells: [bzvtnt3ig]\nstatus: watching\n---\nPolling the release feed."), "watching")
})

test("a fence that names nothing derives nothing", () => {
  assert.equal(derived("for: 2h"), null)
  assert.equal(awaitingNeedsInput(splitAwaitingFrontmatter("for: 2h")), null)
})

test("the three shapes land in their bands with no `status:` or `for:` written", () => {
  const shell = tele({ bgShells: [LIVE_SHELL], ...fence({ kind: "shell", value: "bzvtnt3ig" }) })
  assert.deepEqual(place(row(), shell), { needsYou: false, waitStatus: "working" })
  const pr = tele(fence({ kind: "pr", value: PR }))
  assert.deepEqual(place(row(), pr, { prs: [PR] }), { needsYou: false, waitStatus: "watching" })
  const prose = tele({ bgShells: [LIVE_SHELL], lastFence: { kind: "awaiting", body: "Try the dev server now.", hints: [{ kind: "shell", value: "bzvtnt3ig" }] } })
  assert.deepEqual(place(row(), prose), { needsYou: true, waitStatus: undefined })
})

test("a legacy thread's fence with no answer line is not derived", () => {
  // Dispatched before the cut: the shell park is read as it always was (a shell alone is a watch), not
  // as the derived `working` a new-contract thread gets.
  const t = tele({ bgShells: [LIVE_SHELL], ...fence({ kind: "shell", value: "bzvtnt3ig" }, FOR_2H) })
  assert.deepEqual(place(row({ spawned_at: LEGACY_SPAWN }), t), { needsYou: false, waitStatus: "watching" })
  assert.deepEqual(place(row(), t), { needsYou: false, waitStatus: "working" })
})

// ---- THE VERDICT ---------------------------------------------------------------------------------

test("`watching` on a named shell is out of the queue and Snoozed — the reported watcher", () => {
  assert.deepEqual(place(row(), tele({ bgShells: [LIVE_SHELL], ...fence({ kind: "shell", value: "bzvtnt3ig" }, FOR_2H, status("watching")) })), { needsYou: false, waitStatus: "watching" })
})

test("`working` spins only while something it names MOVES", () => {
  // A named shell moves.
  assert.deepEqual(place(row(), tele({ bgShells: [LIVE_SHELL], ...fence({ kind: "shell", value: "bzvtnt3ig" }, FOR_2H, status("working")) })), { needsYou: false, waitStatus: "working" })
  // A live sub-agent moves, named or not.
  assert.deepEqual(place(row(), tele({ subAgents: [LIVE_AGENT], ...fence({ kind: "agent", value: "a01b2d20" }, FOR_2H, status("working")) })), { needsYou: false, waitStatus: "working" })
  // A park on its own timers alone is Working, whatever `status:` says: the worker comes back on its own
  // clock, and nothing outside the thread can stall it (2026-10-22).
  assert.deepEqual(place(row(), tele(fence({ kind: "timer", value: "tmr_a1" }, FOR_2H, status("working"))), { timers: ["tmr_a1"] }), { needsYou: false, waitStatus: "working" })
  assert.equal(place(row(), tele(fence({ kind: "timer", value: "tmr_a1" }, FOR_2H, status("watching"))), { timers: ["tmr_a1"] }).waitStatus, "working")
  // A timer beside a wait on the world is still Waiting: the PR is what has to move.
  assert.equal(place(row(), tele(fence({ kind: "timer", value: "tmr_a1" }, { kind: "pr", value: PR }, FOR_2H, status("watching"))), { timers: ["tmr_a1"], prs: [PR] }).waitStatus, "watching")
})

test("`working` on a PR spins while its checks run, and reads as a watch once they settle or gate", () => {
  const park = tele(fence({ kind: "pr", value: PR }, FOR_2H, status("working")))
  assert.equal(place(row(), park, { prs: [PR], github: { [PR]: ci() } }).waitStatus, "working")
  assert.equal(place(row(), park, { prs: [PR], github: { [PR]: ci({ checks: "passing", running: 0 }) } }).waitStatus, "watching")
  // Held at GitHub's "Approve and run" gate: nothing moves until a maintainer presses the button.
  assert.equal(place(row(), park, { prs: [PR], github: { [PR]: ci({ running: 0, gated: 2 }) } }).waitStatus, "watching")
  // Never polled: ntwine does not know, and not-knowing is not motion.
  assert.equal(place(row(), park, { prs: [PR] }).waitStatus, "watching")
})

// A TERMINAL the worker started (`ntwinectl terminal start`, 2026-10-15) parks like a named shell: it holds
// while it runs, and lets go the moment it is at a prompt or over — the wake the worker rests for.
test("a terminal named under `threads:` (or `terminals:`) parks while it runs, and queues at a prompt, after an exit, or when nothing carries the name", () => {
  // The project's terminals, whoever started them: any thread may wait on any terminal.
  const lives = (outcome: "running" | "prompt" | "failed") => ({ terminals: [{ id: "term-1", handle: "nub-run-dev", outcome, at: AT }] })
  const park = (answer: string, kind: "thread" | "terminal" = "thread") => fence({ kind, value: "@nub-run-dev" }, FOR_2H, status(answer))
  assert.deepEqual(place(row(), tele({ ...lives("running"), ...park("working") })), { needsYou: false, waitStatus: "working" })
  assert.deepEqual(place(row(), tele({ ...lives("running"), ...park("watching") })), { needsYou: false, waitStatus: "watching" })
  assert.deepEqual(place(row(), tele({ ...lives("running"), ...park("working", "terminal") })), { needsYou: false, waitStatus: "working" }, "the first spelling still reads")
  // Named by its slug, any casing, reads the same.
  assert.equal(place(row(), tele({ ...lives("running"), ...fence({ kind: "thread", value: "TERM-1" }, FOR_2H, status("working")) })).needsYou, false)
  assert.equal(place(row(), tele({ ...lives("prompt"), ...park("working") })).needsYou, true, "at a prompt: only its driver can answer it")
  assert.equal(place(row(), tele({ ...lives("failed"), ...park("working") })).needsYou, true, "over")
  assert.equal(place(row(), tele(park("working"))).needsYou, true, "no terminal and no reply wait carries the name")
})

test("a registered shell watch is the worker naming the shell — until the row runs out", () => {
  const watch: RegisteredWatch = { id: "wch_1", kind: "shell", target: "bzvtnt3ig", createdAt: AT, expiresAt: new Date(NOW + 3_600_000).toISOString() }
  const park = tele({ bgShells: [LIVE_SHELL], ...fence({ kind: "pr", value: PR }, FOR_2H, status("working")) })
  assert.equal(place(row(), park, { prs: [PR], watches: [watch] }).waitStatus, "working")
  assert.equal(place(row(), park, { prs: [PR], watches: [{ ...watch, expiresAt: new Date(NOW - 1).toISOString() }] }).waitStatus, "watching")
})

test("`watching` beside a live sub-agent is honoured — the child is watching the world for its parent", () => {
  const t = tele({ subAgents: [LIVE_AGENT], ...fence({ kind: "agent", value: "a01b2d20" }, FOR_2H, status("watching")) })
  assert.deepEqual(place(row(), t), { needsYou: false, waitStatus: "watching" })
})

test("`needs_input` queues, and a queued rest never carries a band", () => {
  const t = tele({ bgShells: [LIVE_SHELL], ...fence({ kind: "shell", value: "bzvtnt3ig" }, FOR_2H, status("needs_input")) })
  assert.deepEqual(place(row(), t), { needsYou: true, waitStatus: undefined })
})

test("the older `needs_input: false`, and a legacy fence with neither line, get ntwine's reading", () => {
  const legacy = row({ spawned_at: LEGACY_SPAWN })
  // A live sub-agent or moving CI is work; a shell alone cannot say what it is, so it is a watch.
  assert.equal(place(row(), tele({ subAgents: [LIVE_AGENT], ...fence({ kind: "agent", value: "a01b2d20" }, FOR_2H, { kind: "needs_input", value: "false" }) })).waitStatus, "working")
  assert.equal(place(row(), tele({ bgShells: [LIVE_SHELL], ...fence({ kind: "shell", value: "bzvtnt3ig" }, FOR_2H, { kind: "needs_input", value: "false" }) })).waitStatus, "watching")
  assert.equal(place(row(), tele(fence({ kind: "pr", value: PR }, FOR_2H, { kind: "needs_input", value: "false" })), { prs: [PR], github: { [PR]: ci() } }).waitStatus, "working")
  // THE REPORTED THREAD: dispatched before the cut, parked a day on a shell watcher with no answer line.
  assert.deepEqual(place(legacy, tele({ bgShells: [LIVE_SHELL], ...fence({ kind: "shell", value: "bzvtnt3ig" }, { kind: "for", value: "23h" }) })), { needsYou: false, waitStatus: "watching" })
  // A legacy rest on a live sub-agent with no fence at all is still excused, and still working.
  assert.deepEqual(place(legacy, tele({ subAgents: [LIVE_AGENT] })), { needsYou: false, waitStatus: "working" })
})

test("no band off rest, and none while a message is on its way to the worker", () => {
  const t = tele({ bgShells: [LIVE_SHELL], ...fence({ kind: "shell", value: "bzvtnt3ig" }, FOR_2H, status("watching")) })
  assert.equal(place(row(), t, { runtime: "running" }).waitStatus, undefined)
  assert.equal(place(row(), t, { runtime: "exited" }).waitStatus, undefined)
  // An answer the human sent: the row keeps its Running placement until the turn starts, never Snoozed.
  assert.equal(place(row(), t, { inFlight: true }).waitStatus, undefined)
  // A rest with nothing out has nothing to place.
  assert.equal(deriveWaitStatus(tele(), "turn-idle", false, false, false, NOW), undefined)
})

// ---- THE BOARD, END TO END -----------------------------------------------------------------------
// The view the client bands from: deriveWaitStatus has to reach ThreadView through the real assembly, and
// the shared predicates — the sidebar's bands and the rail's running count — have to read it.

test("the board carries the verdict, and the bands and the running count follow it", () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-wait-status-"))
  const project: Project = { dir, id: "p", name: "fixture", label: "fixture", stateDir: dir, cwdSlug: "fixture" }
  const storage = createStorage(join(dir, "ui.db"), "p")
  const fences: Record<string, Partial<SessionTelemetry>> = {
    // The reported shape: a pre-cut worker parked on a shell watcher with no answer line.
    "legacy-watcher": { bgShells: [LIVE_SHELL], ...fence({ kind: "shell", value: "bzvtnt3ig" }, { kind: "for", value: "23h" }) },
    "bench": { bgShells: [LIVE_SHELL], ...fence({ kind: "shell", value: "bzvtnt3ig" }, FOR_2H, status("working")) },
    "poller": { subAgents: [LIVE_AGENT], ...fence({ kind: "agent", value: "a01b2d20" }, FOR_2H, status("watching")) },
    "ready": { bgShells: [LIVE_SHELL], ...fence({ kind: "shell", value: "bzvtnt3ig" }, FOR_2H, status("needs_input")) },
    "ci": fence({ kind: "pr", value: PR }, FOR_2H, status("working")),
  }
  for (const slug of Object.keys(fences)) {
    storage.upsertSession(row({ slug, session_id: `sess-${slug}`, thread_name: `ntwine-${slug}`, spawned_at: slug === "legacy-watcher" ? LEGACY_SPAWN : NEW_SPAWN }))
    storage.setBackend(slug, "claude")
    storage.setClaudeRuntime(slug, "broker")
  }
  storage.armPrWatch({ id: "prw_1", slug: "ci", owner: "acme", repo: "app", number: 391, createdAtMs: Date.parse(AT), expiresAtMs: Date.parse(AT) + 86_400_000 })
  storage.setSetting(GITHUB_STATUS_SETTING, { [PR]: ci() })
  const tailer = {
    // The shells and children report their own instants; the rest is the fence the worker left.
    get: (slug: string) => tele({ turn: "idle", lastActivityAt: AT, ...fences[slug] }),
    foreignIds: () => [], subAgent: () => undefined, forget: () => {},
    start: () => {}, stop: () => {}, tick: () => {},
  } satisfies Tailer
  // The board's own clock, pinned: every park here runs out against it (`for:`, the legacy day cap).
  const board = createBoard(project, storage, new Bus(), tailer, "wait-status", { claudeBrokerDaemonAlive: () => true, now: () => NOW })
  try {
    const views = new Map(board.refresh().threads.map((t) => [t.id, t] as const))
    const view = (slug: string): ThreadView => views.get(slug)!
    const bandOf = (slug: string) => ({ waitStatus: view(slug).waitStatus, section: sectionOf(view(slug)), running: activeBandThread(view(slug)) })
    for (const slug of Object.keys(fences)) assert.equal(view(slug).runtime, "turn-idle", slug)

    // A `watching` rest is the WORKER's park: it stays in the Working band (2026-10-14; it was Snoozed
    // before), and isSnoozed never claims it — Snoozed is the human's band.
    assert.deepEqual(bandOf("legacy-watcher"), { waitStatus: "watching", section: "active", running: true })
    assert.equal(agentParked(view("legacy-watcher")), true)
    assert.equal(isSnoozed(view("legacy-watcher")), false)
    assert.deepEqual(bandOf("bench"), { waitStatus: "working", section: "active", running: true })
    assert.equal(agentParked(view("bench")), false, "a working rest is motion, not a park")
    assert.deepEqual(bandOf("poller"), { waitStatus: "watching", section: "active", running: true })
    assert.equal(agentParked(view("poller")), true)
    assert.equal(hasLiveOps(view("poller")), false, "a watching parent is not motion; its child spins on its own row")
    assert.deepEqual(bandOf("ci"), { waitStatus: "working", section: "active", running: true })
    // The queued rest: in the cue, never counted as running, never banded.
    assert.equal(view("ready").needsYou, true)
    assert.deepEqual(bandOf("ready"), { waitStatus: undefined, section: "active", running: false })
    assert.equal(isSnoozed(view("ready")), false)
  } finally {
    board.stop()
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
