// A FORKED SPINOFF CHILD READS FROM ITS FORK POINT (fork-point.ts). On a Claude thread Spinoff forks the
// parent's session (router.ts forkSpinoff), and the child's transcript opens on a COPY of the parent's
// conversation with nothing marking it inherited. These pin that every reader of a forked row starts at
// the record carrying its `fork_anchor` — the scan itself, the tailer's fold, the chat's projection, the
// edge recovery — each beside a negative control reading the same bytes WITHOUT the anchor, so the
// harness is shown able to see the parent's state leak through.
import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

// Every Claude transcript reader resolves `~/.claude/projects/<cwdSlug>/`; point it at a sandbox BEFORE
// anything reads it (os.homedir() reads $HOME on every call).
const HOME = mkdtempSync(join(tmpdir(), "ntwine-fork-home-"))
process.env.HOME = HOME
process.on("exit", () => rmSync(HOME, { recursive: true, force: true }))

import { parseSpinoffChildPrompt, spinoffChildPrompt, spinoffForkPrompt } from "@ntwine/shared"
import { __clearForkPointsForTests, forkPointOf, isInheritedSessionMetadata } from "./fork-point.ts"
import { createTailer } from "./tailer.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import { Bus } from "./bus.ts"
import type { Project } from "./project.ts"
import { __clearTranscriptCacheForTests, readLatestThreadTranscriptPage, readThreadTranscript, readTranscript, withSpinoffCards } from "./transcript.ts"
import { discoverTranscriptId } from "./discover.ts"
import { composePrompt } from "./dispatch.ts"

const ANCHOR = "7b4a5c1e-0000-4000-8000-00000000f0f0"
const PARENT_SID = "11111111-1111-4111-8111-111111111111"
const CHILD_SID = "22222222-2222-4222-8222-222222222222"
const ts = (n: number) => `2026-09-30T10:00:${String(n).padStart(2, "0")}.000Z`
const rec = (o: Record<string, unknown>) => JSON.stringify({ sessionId: CHILD_SID, ...o })
const user = (n: number, text: string, uuid = `u${n}`) => rec({ type: "user", timestamp: ts(n), uuid, parentUuid: `p${n}`, message: { role: "user", content: text } })
const say = (n: number, text: string, stop = "end_turn") =>
  rec({ type: "assistant", timestamp: ts(n), uuid: `a${n}`, message: { id: `msg_${n}`, role: "assistant", stop_reason: stop, content: [{ type: "text", text }] } })
const toolUse = (n: number, id: string, name: string, input: unknown) =>
  rec({ type: "assistant", timestamp: ts(n), uuid: `a${n}`, message: { id: `msg_${n}`, role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] } })
const toolResult = (n: number, id: string, text: string) =>
  rec({ type: "user", timestamp: ts(n), uuid: `r${n}`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] } })
const aiTitle = (title: string) => rec({ type: "ai-title", aiTitle: title })

// The PARENT's conversation as the fork copies it: a task, a background shell, a background sub-agent, a
// handoff with a done fence, and Claude's title for it.
const PARENT_HISTORY = [
  user(1, `${"x".repeat(10)} the parent's own task: remember PAPAYA-7731 and fix the cache bug`),
  toolUse(2, "toolu_sh", "Bash", { command: "sleep 9999", run_in_background: true, description: "wait on the deploy" }),
  toolResult(3, "toolu_sh", "Command running in background with ID: bParent. Output is being written to: /tmp/tasks/bParent.output."),
  toolUse(4, "toolu_ag", "Agent", { description: "audit the cache", run_in_background: true, subagent_type: "ntwine:high" }),
  toolResult(5, "toolu_ag", "Async agent launched successfully.\nagentId: aParent\noutput_file: /tmp/aParent.output\nDo not read this file."),
  say(6, "Fixed the cache bug.\n\n```done\nThe cache now invalidates on write.\n```"),
  aiTitle("Cache invalidation fix"),
]
const CHILD_INSTRUCTIONS = "evaluate whether the fix holds up under load"
const CHILD_PROMPT = composePrompt(CHILD_SID, spinoffForkPrompt({ parentSlug: "parent", parentTitle: "Parent", parentHandle: "cacheFix", instructions: CHILD_INSTRUCTIONS }))
// What the CLI writes around the child's own first record (measured on 2.1.284, fork-point.ts header).
const FORK_HEAD = [
  rec({ type: "queue-operation", operation: "enqueue", timestamp: ts(9), content: CHILD_PROMPT }),
  rec({ type: "queue-operation", operation: "dequeue", timestamp: ts(9) }),
]
const FORK_POINT = [
  rec({ type: "attachment", uuid: "h1", timestamp: ts(9), attachment: { type: "hook_success" } }),
  user(10, CHILD_PROMPT, ANCHOR),
  // The CLI re-appends the INHERITED title below the fork point.
  aiTitle("Cache invalidation fix"),
]
const CHILD_WORKING = [toolUse(11, "toolu_read", "Read", { file_path: "/p/cache.ts" })]

const lines = (ls: string[]) => ls.map((l) => l + "\n").join("")

// ---- the shared prompt ---------------------------------------------------------------------------------

test("fork prompt: the child's header projects the human's words with no brief, and names the parent", () => {
  const prompt = spinoffForkPrompt({ parentSlug: "parent", parentTitle: "Parent", parentHandle: "cacheFix", instructions: "one\ntwo" })
  assert.deepEqual(parseSpinoffChildPrompt(prompt), { instructions: "one\ntwo", brief: "" })
  assert.match(prompt, /@cacheFix's conversation, copied/)
  assert.match(prompt, /NEW thread/)
  // A parent with no handle is linked, and still parses.
  const linked = spinoffForkPrompt({ parentSlug: "parent-x", parentTitle: "A [bracketed] title", instructions: "go" })
  assert.match(linked, /^A spinoff of \[A bracketed title\]\(\/thread\/parent-x\)/)
  assert.deepEqual(parseSpinoffChildPrompt(linked), { instructions: "go", brief: "" })
  // The summary route's prompt is untouched by the second shape.
  assert.deepEqual(parseSpinoffChildPrompt(spinoffChildPrompt({ parentSlug: "p", parentTitle: "P", parentHandle: "a", instructions: "i", brief: "b" })), { instructions: "i", brief: "b" })
})

// ---- the scan ------------------------------------------------------------------------------------------

test("fork point: pending until the anchor record lands, then the offset of its line, found incrementally", () => {
  __clearForkPointsForTests()
  const dir = mkdtempSync(join(tmpdir(), "ntwine-fork-point-"))
  try {
    const path = join(dir, "child.jsonl")
    writeFileSync(path, lines([...FORK_HEAD, ...PARENT_HISTORY]))
    assert.equal(forkPointOf(path, ANCHOR), undefined, "the copy alone has no fork point")
    // A record that QUOTES the anchor (its parentUuid) is not the anchor.
    appendFileSync(path, lines([rec({ type: "attachment", uuid: "q", parentUuid: ANCHOR, attachment: { type: "x" } })]))
    assert.equal(forkPointOf(path, ANCHOR), undefined, "a quote is not the record")
    const before = Buffer.byteLength(lines([...FORK_HEAD, ...PARENT_HISTORY, rec({ type: "attachment", uuid: "q", parentUuid: ANCHOR, attachment: { type: "x" } }), FORK_POINT[0]!]))
    appendFileSync(path, lines(FORK_POINT))
    const point = forkPointOf(path, ANCHOR)
    assert.deepEqual(point, { offset: before, inheritedAiTitle: "Cache invalidation fix" })
    assert.equal(forkPointOf(path, "not-the-anchor"), undefined)
    // The re-appended copy of the parent's title is recognized; the child's own is not.
    assert.equal(isInheritedSessionMetadata(aiTitle("Cache invalidation fix"), point!), true)
    assert.equal(isInheritedSessionMetadata(aiTitle("Load test of the cache fix"), point!), false)
    assert.equal(isInheritedSessionMetadata(say(12, "Cache invalidation fix"), point!), false, "only a title RECORD")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- the tailer ----------------------------------------------------------------------------------------

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug: "child", session_id: CHILD_SID, thread_name: "ntwine-child", spawned_at: ts(8), last_read_at: null, unread: 0, exited: 0,
    archived: 0, rested_at: null, title_auto: 1, title: null, state: "open", meta: null, seen_at: null, transcript_id: null, ...over,
  }
}

function tailHarness(forked: boolean) {
  __clearForkPointsForTests()
  const root = mkdtempSync(join(tmpdir(), "ntwine-fork-tail-"))
  const logDir = join(root, "-a-project")
  mkdirSync(logDir, { recursive: true })
  const storage = createStorage(join(logDir, "ui.db"), "p")
  storage.upsertSession(row())
  storage.setBackend("child", "claude")
  storage.setClaudeRuntime("child", "broker")
  if (forked) assert.equal(storage.setForkAnchor("child", CHILD_SID, ANCHOR), true)
  const clock = { ms: Date.parse(ts(9)) }
  const bus = new Bus()
  const notifies: unknown[] = []
  bus.subscribe((e) => { if (e.type === "notify") notifies.push(e) })
  const tailer = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage, bus, onChange: () => {}, now: () => clock.ms, paneDead: () => false, sessionLogDir: logDir, tailCache: null,
  })
  const path = join(logDir, `${CHILD_SID}.jsonl`)
  return { storage, tailer, clock, path, notifies, close: () => { storage.close(); rmSync(root, { recursive: true, force: true }) } }
}

test("tailer: a forked row folds nothing of the copied parent, before or after its own first record", () => {
  const h = tailHarness(true)
  try {
    // The CLI has written the copy but not yet the child's prompt.
    writeFileSync(h.path, lines([...FORK_HEAD, ...PARENT_HISTORY]))
    h.tailer.tick()
    const early = h.tailer.get("child")
    assert.equal(early?.lastFence, undefined, "no parent fence")
    assert.equal(early?.aiTitle, undefined, "no parent title")
    assert.deepEqual(early?.bgShells, [], "no parent shells")
    assert.deepEqual(early?.subAgents, [], "no parent sub-agents")
    assert.equal(early?.lastAssistant, undefined, "no parent preview")
    assert.equal(h.storage.getSession("child")?.rested_at ?? null, null, "not rested on the parent's handoff")

    // The child's own prompt lands, the CLI re-appends the parent's title, and the child starts working.
    appendFileSync(h.path, lines([...FORK_POINT, ...CHILD_WORKING]))
    h.clock.ms = Date.parse(ts(11)) + 500
    h.tailer.tick()
    const after = h.tailer.get("child")
    assert.equal(after?.turn, "in-flight", "the child's own turn")
    assert.equal(after?.lastFence, undefined)
    assert.equal(after?.aiTitle, undefined, "the re-appended parent title is dropped")
    assert.deepEqual(after?.bgShells, [])
    assert.deepEqual(after?.subAgents, [])
    assert.equal(after?.firstUserText, CHILD_PROMPT.slice(0, after?.firstUserText?.length), "the conversation starts on the child's prompt")

    // The child's OWN title and its own rest are its own.
    appendFileSync(h.path, lines([aiTitle("Load test of the cache fix"), toolResult(12, "toolu_read", "…"), say(13, "Holds up.\n\n```done\nIt holds.\n```")]))
    h.clock.ms = Date.parse(ts(13)) + 5_000
    h.tailer.tick()
    const rested = h.tailer.get("child")
    assert.equal(rested?.aiTitle, "Load test of the cache fix")
    assert.equal(rested?.turn, "idle")
    assert.match(rested?.lastFence?.body ?? "", /It holds\./)
  } finally {
    h.close()
  }
})

test("tailer (negative control): the same bytes WITHOUT the anchor hand the child its parent's state", () => {
  const h = tailHarness(false)
  try {
    writeFileSync(h.path, lines([...FORK_HEAD, ...PARENT_HISTORY, ...FORK_POINT]))
    h.tailer.tick()
    const polluted = h.tailer.get("child")
    assert.equal(polluted?.aiTitle, "Cache invalidation fix")
    assert.equal(polluted?.bgShells.length, 1, "the parent's shell reads as the child's")
    assert.equal(polluted?.subAgents.length, 1, "the parent's sub-agent reads as the child's")
    assert.match(polluted?.firstUserText ?? "", /PAPAYA-7731/)
  } finally {
    h.close()
  }
})

// ---- the chat ------------------------------------------------------------------------------------------

function projectFixture() {
  __clearForkPointsForTests()
  __clearTranscriptCacheForTests()
  const dir = mkdtempSync(join(tmpdir(), "ntwine-fork-chat-"))
  const cwdSlug = `fork-chat-${Math.random().toString(16).slice(2)}`
  const project: Project = { dir, id: "fork-chat", name: "t", label: "t", stateDir: dir, cwdSlug }
  const logDir = join(homedir(), ".claude", "projects", cwdSlug)
  mkdirSync(logDir, { recursive: true })
  const storage = createStorage(join(dir, "ui.db"), "p")
  return { project, storage, logDir, close: () => { storage.close(); rmSync(dir, { recursive: true, force: true }); rmSync(logDir, { recursive: true, force: true }) } }
}

test("chat: a forked child opens on its spinoff header, with none of the parent's conversation above it", () => {
  const f = projectFixture()
  try {
    f.storage.upsertSession(row())
    f.storage.setBackend("child", "claude")
    f.storage.setClaudeRuntime("child", "broker")
    f.storage.setForkAnchor("child", CHILD_SID, ANCHOR)
    writeFileSync(join(f.logDir, `${CHILD_SID}.jsonl`), lines([...FORK_HEAD, ...PARENT_HISTORY]))
    assert.deepEqual(readLatestThreadTranscriptPage(f.project, f.storage, "child").messages, [], "empty until its own first record lands")
    assert.deepEqual(readTranscript(f.project, CHILD_SID, ANCHOR), [])

    appendFileSync(join(f.logDir, `${CHILD_SID}.jsonl`), lines([...FORK_POINT, ...CHILD_WORKING]))
    const page = readLatestThreadTranscriptPage(f.project, f.storage, "child").messages
    assert.equal(page[0]?.role, "user")
    assert.deepEqual(page[0]?.spinoffOrigin, { instructions: CHILD_INSTRUCTIONS, brief: "" }, "the header, with no brief to fold")
    assert.equal(page[0]?.displayText, CHILD_INSTRUCTIONS)
    const all = JSON.stringify(page)
    assert.doesNotMatch(all, /PAPAYA-7731|Fixed the cache bug/, "nothing of the parent's")
    assert.equal(readThreadTranscript(f.project, f.storage, "child")[0]?.spinoffOrigin?.instructions, CHILD_INSTRUCTIONS, "the push reader agrees")
    assert.equal(readTranscript(f.project, CHILD_SID, ANCHOR)[0]?.spinoffOrigin?.instructions, CHILD_INSTRUCTIONS, "and the status readers")

    // Negative control: the file from byte 0 is the parent's conversation.
    __clearTranscriptCacheForTests()
    assert.match(JSON.stringify(readTranscript(f.project, CHILD_SID)), /PAPAYA-7731/)
  } finally {
    f.close()
  }
})

test("chat: a request draws its card in the parent's chat from its row, at the instant it was asked", () => {
  const f = projectFixture()
  try {
    f.storage.upsertSession(row({ slug: "parent", session_id: PARENT_SID, thread_name: "ntwine-parent" }))
    f.storage.setBackend("parent", "claude")
    f.storage.setClaudeRuntime("parent", "broker")
    // An older build DELIVERED one request to the worker: it is in the transcript, and draws from there.
    const legacy = `<spinoff-request id="spn_00000000000000bb">\nThe human asked to spinoff a NEW thread from this conversation. Their instructions for it:\n<instructions>\nbriefed\n</instructions>\n\nDo this now, before anything else: …\n</spinoff-request>`
    const parentLines = [user(1, "fix the cache bug"), say(6, "Fixed."), user(15, legacy), say(16, "Spun off."), user(20, "and the docs?"), say(21, "Done too.")].map((l) => l.replace(CHILD_SID, PARENT_SID))
    writeFileSync(join(f.logDir, `${PARENT_SID}.jsonl`), lines(parentLines))
    f.storage.upsertSession(row())
    const asked = Date.parse(ts(10))
    f.storage.insertSpinoff({ id: "spn_00000000000000aa", parentSlug: "parent", instructions: "load test it", createdAtMs: asked, forked: true })
    f.storage.completeSpinoff("spn_00000000000000aa", "child", asked)
    f.storage.insertSpinoff({ id: "spn_00000000000000bb", parentSlug: "parent", instructions: "briefed", createdAtMs: Date.parse(ts(14)) })

    // The turn-boundary dividers are the fold's own punctuation; the question is where the card sits.
    const page = readLatestThreadTranscriptPage(f.project, f.storage, "parent").messages.filter((m) => m.kind !== "event")
    const texts = page.map((m) => m.displayText ?? m.text)
    assert.deepEqual(texts, ["fix the cache bug", "Fixed.", "load test it", "briefed", "Spun off.", "and the docs?", "Done too."])
    const card = page[2]!
    assert.deepEqual(card.spinoff, { id: "spn_00000000000000aa", instructions: "load test it" })
    assert.equal(card.sourceId, "spinoff:spn_00000000000000aa")
    assert.equal(card.at, ts(10))
    assert.deepEqual(page.filter((m) => m.spinoff).map((m) => m.spinoff!.id), ["spn_00000000000000aa", "spn_00000000000000bb"], "the delivered request draws once, from its record")
    assert.notEqual(page[3]!.sourceId, "spinoff:spn_00000000000000bb")
    // A window that starts after the requests does not pull them in.
    const later = withSpinoffCards([page[5]!, page[6]!], f.storage, "parent", false)
    assert.equal(later.length, 2)
  } finally {
    f.close()
  }
})

// ---- discovery -------------------------------------------------------------------------------------------

test("discovery: a parent whose transcript went missing never adopts its forked child's file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-fork-discover-"))
  try {
    // The child's head carries the PARENT's scratch sentinel, copied with the parent's opening prompt.
    const copiedOpening = composePrompt(PARENT_SID, "the parent's task")
    writeFileSync(join(dir, `${CHILD_SID}.jsonl`), lines([user(1, copiedOpening), ...FORK_POINT]))
    assert.equal(discoverTranscriptId(dir, PARENT_SID), CHILD_SID, "precondition: the sentinel alone would latch onto the child")
    assert.equal(discoverTranscriptId(dir, PARENT_SID, { exclude: new Set([CHILD_SID]) }), undefined, "a known thread's session is never adopted")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- storage -------------------------------------------------------------------------------------------

test("storage: the anchor survives a resume of the same session and is dropped by a re-dispatch", () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-fork-storage-"))
  try {
    const storage = createStorage(join(dir, "ui.db"), "p")
    storage.upsertSession(row())
    assert.equal(storage.setForkAnchor("child", "some-other-session", ANCHOR), false, "guarded on the session")
    assert.equal(storage.setForkAnchor("child", CHILD_SID, ANCHOR), true)
    storage.upsertSession({ ...storage.getSession("child")!, unread: 1 })
    assert.equal(storage.getSession("child")?.fork_anchor, ANCHOR, "a resume spreads the row back: kept")
    storage.upsertSession(row({ session_id: "44444444-4444-4444-8444-444444444444" }))
    assert.equal(storage.getSession("child")?.fork_anchor ?? null, null, "a fresh session holds no copy")
    storage.insertSpinoff({ id: "spn_00000000000000dd", parentSlug: "child", instructions: "x", createdAtMs: 1, forked: true })
    storage.insertSpinoff({ id: "spn_00000000000000ee", parentSlug: "child", instructions: "y", createdAtMs: 2 })
    assert.deepEqual(storage.spinoffsOf("child").map((r) => [r.id, r.forked]), [["spn_00000000000000dd", 1], ["spn_00000000000000ee", 0]])
    storage.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
