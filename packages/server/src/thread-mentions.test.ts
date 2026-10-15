// ONE THREAD READING OR MESSAGING ANOTHER BY HANDLE — the resolver, and both RPCs against the real
// router over real SQLite. Delivery itself (the wake outbox → the recipient's runtime) is pinned in
// scheduler.test.ts, "thread message: …".
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AWAITING_FOR_MAX_MS, type BoardSnapshot, type Settings } from "@ntwine/shared"
import type { BoardManager } from "./board.ts"
import { INBOX_DIRNAME } from "./agent-inbox.ts"
import { createRouter } from "./router.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import type { AppContext } from "./context.ts"
import type { Project } from "./project.ts"
import type { Tailer } from "./tailer.ts"
import { createWakeDeliveryStore } from "./wake-store.ts"
import { knownHandles, resolveSubAgent, resolveThreadHandle, subAgentAddresses, THREAD_MESSAGE_HOURLY_CAP } from "./thread-mentions.ts"
import type { NamedThread } from "./thread-names.ts"
import { createTerminalRunner } from "./thread-terminals.ts"

const named = (slug: string, name: string, open = true, at = 0): NamedThread => ({ slug, name, open, at })

test("a handle resolves in any spelling, including one whose last word is short", () => {
  const threads = [named("a", "Shell budgets"), named("b", "Dev ops"), named("c", "ArkType perf")]
  for (const h of ["shell-budgets", "@shell-budgets", "@shellbudgets", "shell_budgets", "ShellBudget"]) {
    assert.equal(resolveThreadHandle(h, threads)?.slug, "a", h)
  }
  assert.equal(resolveThreadHandle("arktype-perf", threads)?.slug, "c")
  assert.equal(resolveThreadHandle("c", threads)?.slug, "c", "a raw slug resolves too")
  // …and so does the slug folded, for a thread whose shown name drifted from its dispatch title.
  assert.equal(resolveThreadHandle("@tea-recipe", [named("tea-recipes", "Test fixture with secret word")])?.slug, "tea-recipes")
  // A name always outranks another thread's slug.
  assert.equal(resolveThreadHandle("@focus-mode", [named("focus-mode", "Old thing"), named("x", "Focus mode")])?.slug, "x")
  assert.equal(resolveThreadHandle("@nothing", threads), undefined)
})

test("a camelCase handle written before the kebab switch still resolves", () => {
  const threads = [named("a", "Shell budgets"), named("c", "ArkType perf")]
  assert.equal(resolveThreadHandle("@shellBudgets", threads)?.slug, "a")
  assert.equal(resolveThreadHandle("arkTypePerf", threads)?.slug, "c")
  assert.equal(resolveThreadHandle("@teaRecipes", [named("tea-recipes", "Test fixture with secret word")])?.slug, "tea-recipes")
})

test("a short last word folds the same with or without its hyphen: dev-ops, devOps and devops agree", () => {
  // "Dev ops" is two words whose last is too short to lose its plural, while `devops` is one that does;
  // folding every spelling from the handle with its punctuation squeezed out keeps them one key.
  const threads = [named("b", "Dev ops")]
  for (const h of ["@dev-ops", "@devOps", "@devops", "dev-op"]) assert.equal(resolveThreadHandle(h, threads)?.slug, "b", h)
})

test("an open thread outranks a finished one carrying the same name", () => {
  const threads = [named("old", "Focus mode", false, 5), named("new", "Focus mode", true, 1)]
  assert.equal(resolveThreadHandle("focus-mode", threads)?.slug, "new")
  assert.deepEqual(knownHandles(threads), ["@focus-mode", "@focus-mode (done)"])
})

function harness(tailerOver: Partial<Tailer> = {}, id = "m", name = "test") {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-mentions-rpc-"))
  const project: Project = { dir, id, name, label: name, stateDir: dir, cwdSlug: name }
  const storage = createStorage(join(dir, "ui.db"), "p")
  const snapshot: BoardSnapshot = { projectDir: dir, projectName: "test", projectLabel: "test", threads: [], errors: [], warnings: [] }
  const board: BoardManager = {
    snapshot: async () => snapshot, currentSeq: () => 0, rebuild: async () => snapshot,
    refresh: () => snapshot, start: async () => {}, stop: async () => {},
  }
  const tailer: Tailer = {
    get: () => undefined, foreignIds: () => [], subAgent: () => undefined,
    forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
    ...tailerOver,
  }
  let kicks = 0
  const ctx = {
    project, storage, board, tailer,
    scheduler: { kick: () => { kicks++ } },
    getSettings: () => ({ permissionMode: "auto" }) as unknown as Settings,
  } as unknown as AppContext
  return {
    dir, storage, ctx, project, board, router: createRouter(ctx), kicks: () => kicks,
    close: () => { storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

function row(slug: string, title: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug, session_id: `sid-${slug}`, thread_name: `ntwine-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0,
    title, state: "open", meta: null, seen_at: null, transcript_id: null, ...over,
  }
}

test("readThread answers by handle, and a miss lists the handles that exist", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("me", "Mentions"))
    h.storage.upsertSession(row("sb", "Shell budgets"))
    h.storage.setStatus("sb", "sid-sb", "Moving the cap into one module")
    const hit = await h.router.readThread.handler({ input: { slug: "me", handle: "@shell-budgets" } })
    assert.equal(hit.found, true)
    assert.equal(hit.handle, "shell-budgets")
    assert.equal(hit.slug, "sb")
    assert.equal(hit.status, "Moving the cap into one module")
    const miss = await h.router.readThread.handler({ input: { slug: "me", handle: "@shel-budget" } })
    assert.equal(miss.found, false)
    assert.deepEqual(miss.known, ["@shell-budgets"], "the caller is not offered to itself")
  } finally { h.close() }
})

// A TERMINAL THREAD is read by its handle too (plans/terminal-threads.md): what it runs, how its run ended,
// and its screen. A real runner over the same SQLite, with rows a boot would find — no pty is started.
test("readThread reads a terminal by its handle, an open thread of the same name wins, and a miss lists terminals", async () => {
  const h = harness()
  const terminals = createTerminalRunner({ storage: h.storage, onChange: () => {} })
  ;(h.ctx as { terminalRunner: unknown }).terminalRunner = terminals
  const router = createRouter(h.ctx)
  try {
    h.storage.upsertSession(row("me", "Mentions"))
    const at = Date.now()
    h.storage.insertThreadTerminal({ slug: "term-a", startedBy: "human", handle: "nub-test", command: "nub test", cwd: h.dir, shell: false, createdAtMs: at })
    h.storage.recordTerminalExit("term-a", { exitedAtMs: at + 1, exitCode: 1, stopped: false })
    const read = await router.readThread.handler({ input: { slug: "me", handle: "@nub-test" } })
    assert.deepEqual(read, { found: true, handle: "nub-test", slug: "term-a", state: "resting", terminal: { command: "nub test", cwd: h.dir, outcome: "failed", exitCode: 1, startedBy: "human", screen: "" } })
    // A thread already called "Nub test" was named first; the terminal is reached by its slug.
    h.storage.upsertSession(row("nt", "Nub test"))
    assert.equal((await router.readThread.handler({ input: { slug: "me", handle: "@nub-test" } })).slug, "nt")
    assert.equal((await router.readThread.handler({ input: { slug: "me", handle: "term-a" } })).slug, "term-a")
    const miss = await router.readThread.handler({ input: { slug: "me", handle: "@nub-tst" } })
    assert.deepEqual(miss.known, ["@nub-test", "@nub-test (terminal)"])
  } finally { terminals.shutdown(); h.close() }
})

test("messageThread queues a signed message for the other thread, and refuses self, done and a loop", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("me", "Mentions"))
    h.storage.upsertSession(row("sb", "Shell budgets"))
    h.storage.upsertSession(row("fm", "Focus mode", { state: "archived", archived: 1 }))
    const sent = await h.router.messageThread.handler({ input: { slug: "me", handle: "shell-budgets", message: "Which file owns the cap?" } })
    assert.deepEqual(sent, { sent: true, handle: "shell-budgets", from: "mentions" })
    assert.equal(h.kicks(), 1, "the scheduler is kicked so it goes out now, not on the next poll")
    const queued = createWakeDeliveryStore(h.storage.scope).list()
    assert.equal(queued.length, 1)
    assert.equal(queued[0]!.slug, "sb")
    assert.match(queued[0]!.fenceId, /^thread-message:/)
    assert.match(queued[0]!.message, /^Message from @mentions, another ntwine thread/)
    assert.match(queued[0]!.message, /Which file owns the cap\?/)

    const self = await h.router.messageThread.handler({ input: { slug: "me", handle: "@mentions", message: "hi" } })
    assert.equal(self.sent, false)
    const done = await h.router.messageThread.handler({ input: { slug: "me", handle: "focus-mode", message: "hi" } })
    assert.equal(done.sent, false)
    assert.match(done.refusal ?? "", /is done/)

    for (let i = 1; i < THREAD_MESSAGE_HOURLY_CAP; i++) {
      assert.equal((await h.router.messageThread.handler({ input: { slug: "me", handle: "sb", message: `m${i}` } })).sent, true)
    }
    const capped = await h.router.messageThread.handler({ input: { slug: "me", handle: "sb", message: "one more" } })
    assert.equal(capped.sent, false)
    assert.match(capped.refusal ?? "", /cap/)
    assert.equal(createWakeDeliveryStore(h.storage.scope).list().length, THREAD_MESSAGE_HOURLY_CAP)
  } finally { h.close() }
})

test("await_reply registers a wait on the asker that the ANSWER cancels, and the answer says so", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("me", "Mentions"))
    h.storage.upsertSession(row("sb", "Shell budgets"))
    // A `for` from an older worker's MCP server is accepted and ignored: the fence's `for:` is the timeout.
    const asked = await h.router.messageThread.handler({ input: { slug: "me", handle: "shell-budgets", message: "Which file owns the cap?", awaitReply: true, for: "30m" } })
    assert.equal(asked.sent, true)
    assert.match(asked.timerId ?? "", /^tmr_/)
    const waits = h.storage.listThreadTimers("me", { armedOnly: true })
    assert.equal(waits.length, 1, "the asker holds one armed wait")
    assert.match(waits[0]!.prompt, /^Waiting on @shell-budgets to reply \(thread `sb`\)/)
    assert.ok(Math.abs(waits[0]!.fire_at - Date.now() - AWAITING_FOR_MAX_MS) < 5_000, "the registration lives as long as the longest park on it")
    assert.match(createWakeDeliveryStore(h.storage.scope).list()[0]!.message, /@mentions is WAITING on your answer/)

    // An unrelated thread messaging the asker does not end the wait; the one it waits on does.
    h.storage.upsertSession(row("fm", "Focus mode"))
    const other = await h.router.messageThread.handler({ input: { slug: "fm", handle: "mentions", message: "fyi" } })
    assert.equal(other.answered, undefined)
    assert.equal(h.storage.listThreadTimers("me", { armedOnly: true }).length, 1)
    const reply = await h.router.messageThread.handler({ input: { slug: "sb", handle: "@mentions", message: "src/shell-budget.ts" } })
    assert.equal(reply.answered, true)
    assert.equal(h.storage.listThreadTimers("me", { armedOnly: true }).length, 0, "the answer settled the wait")
    const delivered = createWakeDeliveryStore(h.storage.scope).list().find((d) => d.slug === "me" && /shell-budget\.ts/.test(d.message))
    assert.match(delivered?.message ?? "", /this answers the message you were waiting on/)
  } finally { h.close() }
})

// `activity` lists a reply wait as the THREAD it waits on, by the `@handle` a `threads:` line names.
test("activity lists a reply wait as its thread, by handle", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("me", "Mentions"))
    h.storage.upsertSession(row("sb", "Shell budgets"))
    const asked = await h.router.messageThread.handler({ input: { slug: "me", handle: "sb", message: "q", awaitReply: true } })
    const read = await h.router.listOwnThreadActivity.handler({ input: { slug: "me" } })
    assert.deepEqual(read.activity.map((i) => [i.kind, i.id]), [["thread", "@shell-budgets"]])
    assert.match(read.activity[0]!.label, new RegExp(asked.timerId!))
  } finally { h.close() }
})

// ACROSS PROJECTS: a handle the caller's project does not carry resolves in the other projects the server
// has open (All projects' prompt box offers them), and the caller's own project wins a shared handle.
function twoProjects() {
  const a = harness({}, "pa", "alpha")
  const b = harness({}, "pb", "beta")
  const open = () => [a, b].map((h) => ({ project: h.project, board: h.board, ctx: h.ctx }))
  Object.assign(a.ctx, { activeTenants: open })
  Object.assign(b.ctx, { activeTenants: open })
  return { a, b, close: () => { a.close(); b.close() } }
}

test("readThread reaches another open project's thread, says whose it is, and prefers its own project's", async () => {
  const { a, b, close } = twoProjects()
  try {
    a.storage.upsertSession(row("me", "Mentions"))
    b.storage.upsertSession(row("sb", "Shell budgets"))
    b.storage.setStatus("sb", "sid-sb", "Moving the cap")
    const hit = await a.router.readThread.handler({ input: { slug: "me", handle: "@shell-budgets" } })
    assert.equal(hit.found, true)
    assert.equal(hit.slug, "sb")
    assert.equal(hit.status, "Moving the cap")
    assert.equal(hit.project, "beta")

    a.storage.upsertSession(row("mine", "Shell budgets"))
    const own = await a.router.readThread.handler({ input: { slug: "me", handle: "@shell-budgets" } })
    assert.equal(own.slug, "mine")
    assert.equal(own.project, undefined, "the caller's own project wins a handle both carry")

    const miss = await a.router.readThread.handler({ input: { slug: "me", handle: "@nothing" } })
    assert.equal(miss.found, false)
  } finally { close() }
})

// NAMES ARE UNIQUE ACROSS OPEN PROJECTS (thread-names.ts), because the caller's own project wins a handle
// both carry: a thread here named like another project's open thread hides it from every thread here.
// Seen 2026-10-09 — an ntwine thread named "Issues audit" beside arktype's open `@issues-audit` answered
// that handle itself, so the arktype thread and its sub-agents could not be reached from ntwine.
test("a thread cannot take another open project's thread name, so the other's handle stays reachable", async () => {
  const { a, b, close } = twoProjects()
  try {
    b.storage.upsertSession(row("begin-a-full-audit-of-open", "Issues audit"))
    a.storage.upsertSession(row("why-does-issues-audit-have-no-give", "why does issues audit…", { title_auto: 1 }))
    const refused = await a.router.setOwnThreadTitle.handler({ input: { slug: "why-does-issues-audit-have-no-give", title: "Issues audit" } })
    assert.equal(refused.accepted, false)
    assert.match(refused.refusal ?? "", /already named "Issues audit" \(@issues-audit in project beta\)/)
    await assert.rejects(
      a.router.renameThread.handler({ input: { slug: "why-does-issues-audit-have-no-give", title: "issues-audit" } }),
      /“Issues audit” is already another open thread's name in beta/,
    )
    const read = await a.router.readThread.handler({ input: { slug: "why-does-issues-audit-have-no-give", handle: "@issues-audit" } })
    assert.equal(read.slug, "begin-a-full-audit-of-open")
    assert.equal(read.project, "beta")

    // NEGATIVE CONTROL: a finished thread's name is free again, in any project.
    b.storage.setState("begin-a-full-audit-of-open", "archived")
    const taken = await a.router.setOwnThreadTitle.handler({ input: { slug: "why-does-issues-audit-have-no-give", title: "Issues audit" } })
    assert.equal(taken.accepted, true)
  } finally { close() }
})

test("messageThread delivers into another project's thread, and its answer settles the wait", async () => {
  const { a, b, close } = twoProjects()
  try {
    a.storage.upsertSession(row("me", "Mentions"))
    b.storage.upsertSession(row("sb", "Shell budgets"))
    // The same slug in the SENDER's project: a message from it must not settle the cross-project wait.
    a.storage.upsertSession(row("sb", "Other thing"))
    const asked = await a.router.messageThread.handler({ input: { slug: "me", handle: "shell-budgets", message: "Which file?", awaitReply: true } })
    assert.equal(asked.sent, true)
    assert.equal(asked.project, "beta")
    assert.equal(createWakeDeliveryStore(a.storage.scope).list().length, 0, "nothing lands in the sender's project")
    const delivered = createWakeDeliveryStore(b.storage.scope).list()
    assert.equal(delivered.length, 1)
    assert.equal(delivered[0]!.slug, "sb")
    assert.match(delivered[0]!.message, /^Message from @mentions, another ntwine thread in the alpha project/)
    assert.equal(b.kicks(), 1, "the recipient's scheduler is kicked")
    const waits = a.storage.listThreadTimers("me", { armedOnly: true })
    assert.match(waits[0]!.prompt, /^Waiting on @shell-budgets to reply \(thread `sb` in beta\)/)

    assert.equal((await a.router.messageThread.handler({ input: { slug: "sb", handle: "mentions", message: "hi" } })).answered, undefined)
    assert.equal(a.storage.listThreadTimers("me", { armedOnly: true }).length, 1, "a same-slug thread here is not the one waited on")
    const reply = await b.router.messageThread.handler({ input: { slug: "sb", handle: "@mentions", message: "src/cap.ts" } })
    assert.equal(reply.sent, true)
    assert.equal(reply.project, "alpha")
    assert.equal(reply.answered, true)
    assert.equal(a.storage.listThreadTimers("me", { armedOnly: true }).length, 0, "the answer settled the wait")
  } finally { close() }
})

// A THREAD'S SUB-AGENTS BY ADDRESS — `port-the-parser.cache-keys`, resolved against the thread's directory
// (live first, then finished newest first; tailer subAgentDirectory).
const DIRECTORY = [
  { id: "toolu_keys", label: "Cache keys", state: "stale" },
  { id: "toolu_keys2", label: "cache-keys", state: "running" },
  { id: "toolu_wave", label: "Wave 2", state: "running" },
  { id: "aW3", label: "impl:W3", parentId: "toolu_wave", state: "running" },
  { id: "toolu_review", label: "Review", state: "done", outcome: "completed" },
  { id: "toolu_old_review", label: "Review", state: "done", outcome: "completed" },
  { id: "toolu_essay", label: "Fresh-context review of the whole effort diff", state: "done" },
]

test("a sub-agent address walks the thread's directory, one segment per level", () => {
  assert.equal(resolveSubAgent(["wave-2", "impl-w3"], DIRECTORY)?.id, "aW3")
  assert.equal(resolveSubAgent(["impl-w3"], DIRECTORY), undefined, "a workflow's agent is not the thread's own child")
  assert.equal(resolveSubAgent(["nothing"], DIRECTORY), undefined)
})

test("a reused name means the running child, else the newest finished one; the id always names one", () => {
  assert.equal(resolveSubAgent(["cache-keys"], DIRECTORY)?.id, "toolu_keys2", "running beats a quiet live sibling")
  assert.equal(resolveSubAgent(["review"], DIRECTORY)?.id, "toolu_review", "directory order puts the newest first")
  assert.equal(resolveSubAgent(["toolu_old_review"], DIRECTORY)?.id, "toolu_old_review")
  assert.equal(resolveSubAgent(["toolu_essay"], DIRECTORY)?.id, "toolu_essay", "a child with no handle is still reachable by id")
})

test("a miss is answered with the addresses that exist, finished ones tagged, sentences left out", () => {
  assert.deepEqual(subAgentAddresses("port-the-parser", DIRECTORY), [
    "@port-the-parser.cache-keys",
    "@port-the-parser.cache-keys",
    "@port-the-parser.wave-2",
    "@port-the-parser.wave-2.impl-w3",
    "@port-the-parser.review (done)",
    "@port-the-parser.review (done)",
  ])
})

test("readThread on a thread.subAgent address answers from the child's own transcript, finished ones too", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-subagent-read-"))
  const transcript = join(dir, "agent-aReview.jsonl")
  writeFileSync(transcript, [
    JSON.stringify({ type: "user", timestamp: "2026-09-30T02:00:00.000Z", message: { role: "user", content: "Review the parser port.\n\n---\n[ORCHESTRATION EPILOGUE — auto-appended by the ntwine worker dispatch hook] You are a helper sub-agent." } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-09-30T02:09:00.000Z", message: { id: "m1", stop_reason: "end_turn", content: [{ type: "text", text: "The port is sound; one cache key collides." }] } }),
  ].join("\n") + "\n")
  const h = harness({
    subAgentDirectory: (slug) => (slug === "pp" ? [
      { id: "toolu_keys", label: "Cache keys", depth: 1, state: "running" },
      { id: "toolu_review", label: "Review", depth: 1, state: "done", outcome: "completed", finishedAt: "2026-09-30T02:10:00.000Z" },
    ] : []),
    subAgent: (slug, id) => (slug === "pp" && id === "toolu_review" ? { outputFile: transcript, state: "done", direct: false, outcome: "completed" } : undefined),
  })
  try {
    h.storage.upsertSession(row("me", "Mentions"))
    h.storage.upsertSession(row("pp", "Port the parser"))
    const hit = await h.router.readThread.handler({ input: { slug: "me", handle: "@port-the-parser.review" } })
    assert.equal(hit.found, true)
    assert.equal(hit.handle, "port-the-parser.review")
    assert.equal(hit.subAgentOf, "port-the-parser")
    assert.equal(hit.slug, "pp")
    assert.equal(hit.state, "done")
    assert.equal(hit.outcome, "completed")
    assert.equal(hit.request, "Review the parser port.", "ntwine's helper epilogue is not part of what the child was asked")
    assert.equal(hit.latest, "The port is sound; one cache key collides.")
    const drawer = await h.router.subAgentTranscript.handler({ input: { slug: "pp", id: "toolu_review" } })
    assert.equal(drawer.messages[0]!.displayText, "Review the parser port.", "the child's drawer opens on the same task, not on ntwine's rules for helpers")
    assert.match(drawer.messages[0]!.text, /ORCHESTRATION EPILOGUE/, "the raw prompt the child received is kept")

    const miss = await h.router.readThread.handler({ input: { slug: "me", handle: "port-the-parser.nothing" } })
    assert.equal(miss.found, false)
    assert.equal(miss.subAgentOf, "port-the-parser")
    assert.deepEqual(miss.known, ["@port-the-parser.cache-keys", "@port-the-parser.review (done)"])

    const directory = await h.router.subAgentDirectory.handler({ input: { slug: "pp" } })
    assert.equal(directory.threadHandle, "port-the-parser")
    assert.deepEqual(directory.agents.map((a) => a.address), ["port-the-parser.cache-keys", "port-the-parser.review"])
  } finally {
    h.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("messageThread delivers to a running sub-agent's mailbox, and refuses one it cannot reach", async () => {
  const sessionDir = mkdtempSync(join(tmpdir(), "ntwine-subagent-mailbox-"))
  const h = harness({
    subAgentDirectory: (slug) => (slug === "pp" ? [
      { id: "toolu_keys", label: "Cache keys", depth: 1, state: "running" },
      { id: "toolu_review", label: "Review", depth: 1, state: "done", outcome: "completed", finishedAt: "2026-09-30T02:10:00.000Z" },
    ] : []),
    subAgent: (slug, id) => (slug !== "pp" ? undefined
      : id === "toolu_keys" ? { state: "running", taskId: "aKeys", direct: false }
      : id === "toolu_review" ? { state: "done", taskId: "aReview", direct: false, outcome: "completed" }
      : undefined) as ReturnType<Tailer["subAgent"]>,
    liveMailboxes: (slug) => (slug === "pp" ? [{ agentId: "aKeys", sessionDir, label: "Cache keys" }] : []),
  })
  try {
    h.storage.upsertSession(row("me", "Mentions"))
    h.storage.upsertSession(row("pp", "Port the parser"))
    const sent = await h.router.messageThread.handler({ input: { slug: "me", handle: "@port-the-parser.cache-keys", message: "hi" } })
    assert.deepEqual([sent.sent, sent.handle, sent.delivery], [true, "port-the-parser.cache-keys", "mailbox"])
    const box = join(sessionDir, INBOX_DIRNAME, "aKeys")
    const posted = readdirSync(box).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(box, f), "utf8")))
    assert.deepEqual(posted.map((m) => [m.from, m.text]), [["@mentions", "hi"]], "the child's own mailbox, signed by the sender")
    assert.deepEqual(h.storage.listSubAgentSteers("pp", "toolu_keys").map((s) => s.message), ["From @mentions: hi"], "journalled in the child's drawer")
    assert.equal(createWakeDeliveryStore(h.storage.scope).list().length, 0, "never through the thread's own session")

    const awaiting = await h.router.messageThread.handler({ input: { slug: "me", handle: "@port-the-parser.cache-keys", message: "hi", awaitReply: true } })
    assert.equal(awaiting.sent, false)
    assert.match(awaiting.refusal ?? "", /answers in its report/)
    const finished = await h.router.messageThread.handler({ input: { slug: "me", handle: "@port-the-parser.review", message: "hi" } })
    assert.equal(finished.sent, false)
    assert.match(finished.refusal ?? "", /not running.*read-thread/)
    const missing = await h.router.messageThread.handler({ input: { slug: "me", handle: "@port-the-parser.nobody", message: "hi" } })
    assert.equal(missing.sent, false)
    assert.match(missing.refusal ?? "", /@port-the-parser has no sub-agent called nobody/)
    assert.deepEqual(missing.known, ["@port-the-parser.cache-keys", "@port-the-parser.review (done)"])
    assert.equal(readdirSync(box).filter((f) => f.endsWith(".json")).length, 1, "no refusal posted anything")
  } finally { h.close(); rmSync(sessionDir, { recursive: true, force: true }) }
})

test("activity names the thread by its handle and each running sub-agent by its address", async () => {
  const h = harness({
    get: (slug) => (slug === "pp" ? { subAgents: [{ id: "toolu_keys", taskId: "aKeys", label: "Cache keys", state: "running", startedAt: "2026-09-30T02:00:00.000Z" }] } as unknown as ReturnType<Tailer["get"]> : undefined),
    subAgentDirectory: (slug) => (slug === "pp" ? [{ id: "toolu_keys", label: "Cache keys", depth: 1, state: "running" }] : []),
  })
  try {
    h.storage.upsertSession(row("pp", "Port the parser"))
    const read = await h.router.listOwnThreadActivity.handler({ input: { slug: "pp" } })
    assert.equal(read.handle, "port-the-parser")
    assert.deepEqual(read.activity.map((i) => [i.kind, i.id, i.address]), [["agent", "aKeys", "port-the-parser.cache-keys"]])
  } finally { h.close() }
})

test("subAgentAddressFor names a child the thread is dispatching, by the one naming rule", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("pp", "Port the parser"))
    assert.deepEqual(await h.router.subAgentAddressFor.handler({ input: { slug: "pp", label: "Cache keys" } }), { address: "port-the-parser.cache-keys" })
    assert.deepEqual(await h.router.subAgentAddressFor.handler({ input: { slug: "pp", label: "Fresh-context review of the whole effort diff" } }), {}, "a sentence has no handle")
    assert.deepEqual(await h.router.subAgentAddressFor.handler({ input: { slug: "nope", label: "Cache keys" } }), {})
  } finally { h.close() }
})
