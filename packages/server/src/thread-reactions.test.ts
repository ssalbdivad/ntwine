import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { humanGapNote, reactionsNote, stripFollowUpRiders, wakeDeliveryToken } from "@ntwine/shared"
import { createStorage } from "./storage.ts"
import { projectClaudeTranscript } from "./transcript.ts"
import { humanMessageText, isHumanMessage } from "./thread-reactions.ts"

test("the reactions line rides the worker's copy and comes back off the human's bubble, gap note and all", () => {
  const note = reactionsNote([
    { emoji: "👍", excerpt: "Fixed the lookup in\n`resolver.ts`" },
    { emoji: "🎉", excerpt: "It says “shipped” now" },
  ])!
  assert.equal(note, "↩ ntwine: since your last turn the human reacted 👍 on “Fixed the lookup in `resolver.ts`”, 🎉 on “It says \"shipped\" now”.")
  // Composed in the router's order: the message, this line, then the gap note last.
  const gap = humanGapNote(Date.parse("2026-11-09T15:00:00.000Z"), "2026-11-09T11:00:00.000Z")!
  assert.equal(stripFollowUpRiders(`ship it\n\n${note}\n\n${gap}`), "ship it")
  assert.equal(stripFollowUpRiders(`ship it\n\n${note}`), "ship it")
  // Prose quoting the line keeps it.
  const quoting = `why does ${note} show up here?`
  assert.equal(stripFollowUpRiders(quoting), quoting)
  assert.equal(reactionsNote([]), undefined)
})

test("a long excerpt is cut to one short line", () => {
  const note = reactionsNote([{ emoji: "👀", excerpt: "word ".repeat(40) }])!
  assert.match(note, /👀 on “(word ){15}word…”\.$/)
})

test("a human reaction is owed to the agent once; an agent's own is born told; removing one deletes it", () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-reactions-"))
  const storage = createStorage(join(dir, "ui.db"), "reactions-a")
  try {
    const base = { slug: "own", sourceId: "claude:120", excerpt: "Fixed it", atMs: 1 }
    assert.equal(storage.setThreadReaction({ ...base, author: "human", emoji: "👍", on: true }), true)
    assert.equal(storage.setThreadReaction({ ...base, author: "human", emoji: "👍", on: true }), false, "adding twice changes nothing")
    assert.equal(storage.setThreadReaction({ ...base, sourceId: "claude:0", author: "agent", emoji: "👀", on: true }), true)
    assert.deepEqual(storage.untoldHumanReactions("own").map((r) => r.emoji), ["👍"])
    storage.markHumanReactionsTold("own", 2)
    assert.deepEqual(storage.untoldHumanReactions("own"), [])
    assert.equal(storage.listThreadReactions("own").length, 2)
    assert.equal(storage.setThreadReaction({ ...base, author: "human", emoji: "👍", on: false }), true)
    assert.deepEqual(storage.listThreadReactions("own").map((r) => [r.author, r.emoji]), [["agent", "👀"]])
  } finally {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// What `ntwinectl react` with no --message lands on: the human's latest TYPED message, through the real
// projection — never ntwine's wake, which is also a user-role record, and never the riders on its tail.
test("the latest human message skips a later wake and reads without its riders", () => {
  const typed = `rename it to Reactions\n\n${reactionsNote([{ emoji: "👍", excerpt: "done" }])}`
  const raw = [
    JSON.stringify({ type: "user", timestamp: "2026-11-09T00:00:00.000Z", message: { content: "orientation\n\nTASK:\nadd reactions" } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-11-09T00:00:05.000Z", message: { id: "m1", content: [{ type: "text", text: "done" }] } }),
    JSON.stringify({ type: "user", timestamp: "2026-11-09T00:01:00.000Z", message: { content: typed } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-11-09T00:01:05.000Z", message: { id: "m2", content: [{ type: "text", text: "renamed" }] } }),
    JSON.stringify({ type: "user", timestamp: "2026-11-09T00:30:00.000Z", message: { content: `⏰ Timer fired.\n\n${wakeDeliveryToken("abc")}` } }),
  ].join("\n")
  const human = projectClaudeTranscript(raw).filter(isHumanMessage)
  assert.equal(humanMessageText(human.at(-1)!), "rename it to Reactions")
  assert.match(human.at(-1)!.sourceId!, /^claude:\d+$/)
})
