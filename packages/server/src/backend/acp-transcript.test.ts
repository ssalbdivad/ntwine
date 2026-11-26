import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  PR_WATCH_SPENT_TRAILER,
  humanGapNote,
  mergedWakeMessage,
  parseMergedWake,
  wakeDeliveryToken,
  wakeTimeHeader,
} from "@ntwine/shared"
import { AcpTranscriptWriter, acpTranscriptPath, createAcpBackend, parseAcpLine, projectAcpTranscript, type AcpRecord } from "./acp-transcript.ts"
import { newTailState } from "../tailer.ts"

// One recorded turn, in the shape the bridge writes it (an opencode turn that wrote a file, ran a
// command, then answered), followed by a follow-up whose turn is still open.
const T = (s: number) => `2026-09-15T22:00:${String(s).padStart(2, "0")}.000Z`
const RECORDS: AcpRecord[] = [
  { kind: "acp-session", at: T(0), agent: { id: "opencode", name: "OpenCode", version: "1.18.29" }, acpSessionId: "ses_1", cwd: "/tmp/p", model: "opencode/big-pickle" },
  { kind: "user-message", at: T(1), text: "Create hello.txt and cat it.", synthetic: false },
  { kind: "turn-start", at: T(1) },
  { kind: "reasoning", at: T(2), text: "The user wants a file, then a cat." },
  { kind: "assistant-text", at: T(2), text: "I'll write the file first.", final: false, messageId: "m1" },
  { kind: "tool-call", at: T(3), id: "call_w", name: "write", input: { filePath: "/tmp/p/hello.txt", content: "hi" }, acp: { kind: "edit", title: "hello.txt", locations: ["/tmp/p/hello.txt"] } },
  { kind: "tool-result", at: T(4), id: "call_w", text: "Wrote file successfully." },
  { kind: "tool-call", at: T(4), id: "call_b", name: "bash", input: { command: "cat hello.txt", workdir: "/tmp/p" }, acp: { kind: "execute", title: "cat hello.txt" } },
  { kind: "tool-result", at: T(5), id: "call_b", text: "hi" },
  { kind: "assistant-text", at: T(6), text: "Done: the file", final: false, messageId: "m2" },
  { kind: "assistant-text", at: T(6), text: " contains `hi`.", final: true, messageId: "m2" },
  { kind: "context-usage", at: T(6), tokens: 14120, window: 200000 },
  { kind: "turn-end", at: T(6), finalText: "Done: the file contains `hi`.", successful: true },
  { kind: "user-message", at: T(9), text: "Now delete it.", synthetic: false },
  { kind: "turn-start", at: T(9) },
]
const RAW = RECORDS.map((r) => JSON.stringify(r)).join("\n") + "\n"

test("acp-transcript: parseAcpLine strips the transcript-only fields and skips the header", () => {
  assert.deepEqual(parseAcpLine(JSON.stringify(RECORDS[0])), [])
  assert.deepEqual(parseAcpLine(JSON.stringify(RECORDS[4])), [{ kind: "assistant-text", at: T(2), text: "I'll write the file first.", final: false }])
  assert.deepEqual(parseAcpLine(JSON.stringify(RECORDS[5])), [{ kind: "tool-call", at: T(3), id: "call_w", name: "write", input: { filePath: "/tmp/p/hello.txt", content: "hi" } }])
  assert.deepEqual(parseAcpLine("not json"), [])
  assert.deepEqual(parseAcpLine('{"kind":"something-new","at":"x"}'), [], "an unknown record kind is skipped, never thrown")
})

test("acp-transcript: the fold reaches idle with the final preview after the first turn, and in-flight after the follow-up", () => {
  const backend = createAcpBackend({ stateDir: "/tmp/state" })
  assert.equal(backend.transcriptPath("abc"), acpTranscriptPath("/tmp/state", "abc"))
  const s = newTailState("t", "s", "/x")
  const lines = RAW.split("\n")
  for (const line of lines.slice(0, 13)) backend.foldLine(s, line)
  assert.equal(s.model, "opencode/big-pickle", "the header pins the model the agent reported")
  assert.equal(s.turn, "idle")
  assert.equal(s.lastAssistant, "Done: the file contains `hi`.")
  assert.equal(s.lastAssistantAt, T(6))
  assert.equal(s.lastUserAt, T(1))
  assert.equal(s.firstUserText, "Create hello.txt and cat it.")
  for (const line of lines.slice(13)) backend.foldLine(s, line)
  assert.equal(s.turn, "in-flight")
  assert.equal(s.lastUserAt, T(9))
})

test("acp-transcript: the drawer projection — user bubble, reasoning, one assistant message with ordered parts, tool statuses", () => {
  const msgs = projectAcpTranscript(RAW, "acp:s")
  assert.deepEqual(msgs.map((m) => [m.role, m.kind ?? "message"]), [
    ["user", "message"], ["assistant", "reasoning"], ["assistant", "message"], ["user", "message"],
  ])
  assert.equal(msgs[0]!.text, "Create hello.txt and cat it.")
  assert.equal(msgs[0]!.sourceId, "acp:s:1")
  assert.equal(msgs[1]!.text, "The user wants a file, then a cat.")
  const a = msgs[2]!
  assert.deepEqual(a.parts.map((p) => p.kind), ["text", "tools", "text"])
  assert.equal(a.text, "I'll write the file first.\n\nDone: the file contains `hi`.", "two partial flushes of message m2 render as one text part")
  assert.deepEqual(a.tools.map((t) => [t.name, t.status, t.detail, t.output]), [
    ["write", "completed", "/tmp/p/hello.txt", "Wrote file successfully."],
    ["bash", "completed", "cat hello.txt", "hi"],
  ])
  assert.equal(a.tools[1]!.command, "cat hello.txt")
  assert.equal(a.tools[0]!.command, undefined)
  assert.deepEqual(a.tools[0]!.edit, { file: "/tmp/p/hello.txt", old: "", new: "hi" })
  assert.match(a.tools[0]!.input ?? "", /hello\.txt/)
  assert.equal(msgs[3]!.text, "Now delete it.")
})

test("acp-transcript: Antigravity edit_file and run_command inputs expose edit and command fields", () => {
  const recs: AcpRecord[] = [
    { kind: "user-message", at: T(1), text: "edit and run", synthetic: false },
    { kind: "turn-start", at: T(1) },
    { kind: "tool-call", at: T(2), id: "c1", name: "Edit app.ts", input: { Path: "/tmp/p/app.ts", Target: "old", Replacement: "new" }, acp: { kind: "edit", title: "Edit app.ts", locations: ["/tmp/p/app.ts"] } },
    { kind: "tool-result", at: T(3), id: "c1", text: "ok" },
    { kind: "tool-call", at: T(4), id: "c2", name: "Create worktree", input: { CommandLine: "git worktree add .ntwine/worktrees/feat -b feat" }, acp: { kind: "execute", title: "Create worktree" } },
    { kind: "tool-result", at: T(5), id: "c2", text: "ok" },
    { kind: "turn-end", at: T(6), finalText: "done", successful: true },
  ]
  const msgs = projectAcpTranscript(recs.map((r) => JSON.stringify(r)).join("\n"))
  const tools = msgs[1]!.tools
  assert.deepEqual(tools[0]!.edit, { file: "/tmp/p/app.ts", old: "old", new: "new" })
  assert.equal(tools[1]!.command, "git worktree add .ntwine/worktrees/feat -b feat")
})

test("acp-transcript: a provider error closes the assistant message with the error attached; a synthetic user record is a wake", () => {
  const recs: AcpRecord[] = [
    { kind: "user-message", at: T(1), text: "go", synthetic: false },
    { kind: "turn-start", at: T(1) },
    { kind: "provider-error", at: T(2), error: { message: "Authentication required", code: "-32000" } },
    { kind: "turn-end", at: T(2), successful: false },
    { kind: "user-message", at: T(3), text: "Goal: keep going", synthetic: true },
  ]
  const msgs = projectAcpTranscript(recs.map((r) => JSON.stringify(r)).join("\n"))
  assert.equal(msgs.length, 3)
  assert.equal(msgs[1]!.providerError?.message, "Authentication required")
  assert.equal(msgs[2]!.wake, true)
})

test("acp-transcript: the writer creates the file under <stateDir>/acp on construction and appends one JSON line per record", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "acp-transcript-"))
  const w = new AcpTranscriptWriter(acpTranscriptPath(stateDir, "sess-1"))
  assert.equal(readFileSync(w.path, "utf8"), "")
  w.append(RECORDS[0]!)
  w.append(RECORDS[1]!)
  const lines = readFileSync(w.path, "utf8").trim().split("\n")
  assert.equal(lines.length, 2)
  assert.equal(JSON.parse(lines[1]!).text, "Create hello.txt and cat it.")
})

test("acp-transcript: a tool-result carrying the target the call lacked names the file, not the tool", () => {
  // opencode's `tool_call` frame has neither rawInput nor locations; the completing tool_call_update
  // has both. Before this the drawer read "edited 1 file: write".
  const raw = [
    JSON.stringify({ kind: "user-message", at: T(0), text: "write it", synthetic: false }),
    JSON.stringify({ kind: "turn-start", at: T(0) }),
    JSON.stringify({ kind: "tool-call", at: T(1), id: "call_w", name: "write", input: {}, acp: { kind: "edit", title: "write", locations: [] } }),
    JSON.stringify({ kind: "tool-result", at: T(2), id: "call_w", text: "Wrote file successfully.", acp: { kind: "completed", locations: ["/repo/second.txt"], input: { filePath: "/repo/second.txt", content: "second" } } }),
    JSON.stringify({ kind: "turn-end", at: T(3), finalText: "done", successful: true }),
  ].join("\n") + "\n"
  const msgs = projectAcpTranscript(raw, "x")
  const call = msgs.find((m) => m.role === "assistant" && m.tools.length)!.tools[0]!
  assert.equal(call.name, "write")
  assert.equal(call.status, "completed")
  assert.equal(call.detail, "/repo/second.txt", "the path arrived with the result and replaced the tool's own name")
  // A call that already knew its target keeps it: a bash command is not overwritten by a location.
  const raw2 = [
    JSON.stringify({ kind: "tool-call", at: T(1), id: "call_b", name: "bash", input: { command: "cat x" }, acp: { kind: "execute", title: "bash", locations: [] } }),
    JSON.stringify({ kind: "tool-result", at: T(2), id: "call_b", text: "hi", acp: { kind: "completed", locations: ["/repo"] } }),
  ].join("\n") + "\n"
  assert.equal(projectAcpTranscript(raw2, "x")[0]!.tools[0]!.detail, "cat x")
})

test("acp-transcript: reasoning chunks in a turn coalesce without fragmenting tool calls, and reset on the next turn", () => {
  // Gemini emits an agent_thought_chunk before nearly every tool batch. Appending to the turn's
  // existing reasoning block must not close the open assistant message, so consecutive tools stay in
  // one collapsible run (matching Codex in transcript.ts).
  const recs: AcpRecord[] = [
    { kind: "user-message", at: T(0), text: "investigate", synthetic: false },
    { kind: "turn-start", at: T(0) },
    { kind: "reasoning", at: T(1), text: "First thought." },
    { kind: "tool-call", at: T(2), id: "c1", name: "read", input: { path: "a.ts" } },
    { kind: "tool-result", at: T(3), id: "c1", text: "ok" },
    { kind: "reasoning", at: T(4), text: "Second thought." },
    { kind: "tool-call", at: T(5), id: "c2", name: "read", input: { path: "b.ts" } },
    { kind: "tool-result", at: T(6), id: "c2", text: "ok" },
    { kind: "reasoning", at: T(7), text: "   \n  " },
    { kind: "assistant-text", at: T(8), text: "All clear.", final: true, messageId: "m1" },
    { kind: "turn-end", at: T(8), finalText: "All clear.", successful: true },
    { kind: "user-message", at: T(10), text: "follow-up", synthetic: false },
    { kind: "turn-start", at: T(10) },
    { kind: "reasoning", at: T(11), text: "Next turn thought." },
    { kind: "tool-call", at: T(12), id: "c3", name: "read", input: { path: "c.ts" } },
  ]
  const msgs = projectAcpTranscript(recs.map((r) => JSON.stringify(r)).join("\n"), "g")
  assert.deepEqual(msgs.map((m) => [m.role, m.kind ?? "message"]), [
    ["user", "message"],
    ["assistant", "reasoning"],
    ["assistant", "message"],
    ["user", "message"],
    ["assistant", "reasoning"],
    ["assistant", "message"],
  ])
  assert.equal(msgs[1]!.text, "First thought.\n\nSecond thought.")
  assert.equal(msgs[2]!.tools.length, 2)
  assert.deepEqual(msgs[2]!.parts.map((p) => p.kind), ["tools", "text"])
  assert.equal(msgs[4]!.text, "Next turn thought.")
  assert.equal(msgs[5]!.tools.length, 1)
})

test("acp-transcript: wakes and follow-up riders take the shared user projection and correction sink", () => {
  const token = wakeDeliveryToken("19856da8866a4bc9838f43addd66fda36f59d3c666b8201f8ef957db77610890")
  const clock = wakeTimeHeader(Date.parse("2026-11-20T01:55:00.000Z"), "2026-11-20T01:52:00.000Z")
  const merged = `${mergedWakeMessage([
    { reason: "pr-watch acme/app#17 merged", message: `⏰ acme/app#17 was MERGED.\n\n${PR_WATCH_SPENT_TRAILER}` },
    { reason: "awaiting park named 1 dead item(s)", message: "⚠️ Your ```awaiting fence names something that is not running, so it is not a park and your thread stayed in the queue.\n\n- `prs: [acme/app#17]` — NOT REGISTERED" },
  ], Date.parse("2026-11-20T01:55:00.000Z"), "2026-11-20T01:52:00.000Z")}\n\n${token}`
  const loneCorrection = `⚠️ Your \`\`\`awaiting fence names something that is not running, so it is not a park.\n\n${clock}\n\n${token}`
  const gap = humanGapNote(Date.parse("2026-11-20T02:30:00.000Z"), "2026-11-20T01:55:00.000Z")!
  const recs: AcpRecord[] = [
    { kind: "user-message", at: T(0), text: "ship it", synthetic: false },
    { kind: "assistant-text", at: T(1), text: "```awaiting\nprs: [acme/app#17]\n```", final: true, messageId: "m1" },
    { kind: "user-message", at: T(2), text: merged, synthetic: false },
    { kind: "assistant-text", at: T(3), text: "```awaiting\nshells: [b1]\n```", final: true, messageId: "m2" },
    { kind: "user-message", at: T(4), text: loneCorrection, synthetic: false },
    { kind: "user-message", at: T(5), text: `looks good\n\n${gap}`, synthetic: false },
  ]
  const msgs = projectAcpTranscript(recs.map((r) => JSON.stringify(r)).join("\n"), "acp:s")
  // Merged wake: flagged as wake, delivery token + clock stripped from displayText, and its park-correction part refused the awaiting fence above it.
  assert.equal(msgs[1]!.fenceRefused, true)
  assert.equal(msgs[2]!.wake, true)
  assert.doesNotMatch(msgs[2]!.displayText ?? "", /ntwine-wake|⏱/)
  assert.equal(parseMergedWake(msgs[2]!.displayText ?? "")?.length, 2)
  assert.equal(msgs[2]!.text, merged, "raw stored text keeps the delivery token for ack matching")
  // Lone park correction: dropped from the transcript, while still marking the preceding fence refused.
  assert.equal(msgs[3]!.fenceRefused, true)
  assert.equal(msgs.length, 5, "the lone correction record is dropped")
  // Human follow-up with gap note: rider stripped from displayText, never misclassified as a wake.
  assert.equal(msgs[4]!.wake, undefined)
  assert.equal(msgs[4]!.displayText, "looks good")
})

test("acp-transcript: latestReasoning joins partial thoughtId flushes, clears on visible prose, and re-arms on later thought", () => {
  const recs: AcpRecord[] = [
    { kind: "user-message", at: T(0), text: "fix it", synthetic: false },
    { kind: "turn-start", at: T(0) },
    { kind: "reasoning", at: T(1), text: "Inspecting ", thoughtId: "t1" },
    { kind: "reasoning", at: T(2), text: "scope.ts first.", thoughtId: "t1" },
    { kind: "tool-call", at: T(3), id: "c1", name: "read", input: { path: "scope.ts" } },
    { kind: "tool-result", at: T(4), id: "c1", text: "ok" },
    { kind: "assistant-text", at: T(5), text: "Found the config seam.", final: false, messageId: "m1" },
  ]
  const afterProse = projectAcpTranscript(recs.map((r) => JSON.stringify(r)).join("\n"), "lr")
  assert.equal(afterProse[1]!.text, "Inspecting scope.ts first.", "partial flushes with the same thoughtId concatenate without blank lines")
  assert.equal(afterProse[1]!.latestReasoning, undefined, "visible assistant prose clears latestReasoning so stale thinking is not surfaced")

  // A subsequent thought burst after mid-turn prose re-arms latestReasoning while preserving full history.
  const more: AcpRecord[] = [
    ...recs,
    { kind: "reasoning", at: T(6), text: "Checking ", thoughtId: "t2" },
    { kind: "reasoning", at: T(7), text: "ambient callers.", thoughtId: "t2" },
    { kind: "tool-call", at: T(8), id: "c2", name: "read", input: { path: "callers.ts" } },
  ]
  const afterLaterThought = projectAcpTranscript(more.map((r) => JSON.stringify(r)).join("\n"), "lr")
  assert.equal(afterLaterThought[1]!.text, "Inspecting scope.ts first.\n\nChecking ambient callers.")
  assert.equal(afterLaterThought[1]!.latestReasoning, "Checking ambient callers.")
})
