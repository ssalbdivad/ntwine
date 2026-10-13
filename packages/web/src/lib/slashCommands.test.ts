import assert from "node:assert/strict"
import { test } from "node:test"
import type { ThreadSkill } from "@ntwine/shared"
import { mergeSlashItems } from "../hooks/useUserCommands.ts"
import { draftStart, insertSlashCommand, matchSlashItems, slashQueryAt, slashSegments } from "./slashCommands.ts"

const items: ThreadSkill[] = [
  { name: "ntwine-stack", description: "Boot a stack", source: "project" },
  { name: "ntwine:gh", description: "gh playbook", source: "plugin" },
  { name: "context", description: "Show current context usage", source: "builtin", command: true },
]
// The operator's own `~/.agents/commands/armstrong.md`, as the menu receives it.
const withUserCommand = mergeSlashItems(items, [{ name: "armstrong", description: "Senator Armstrong reviews", body: "review it", source: "global", path: "/h/.agents/commands/armstrong.md" }])

test("the menu opens on a `/` at any word boundary, with the caret inside its token", () => {
  assert.deepEqual(slashQueryAt("/con", 4), { start: 0, query: "con" })
  assert.deepEqual(slashQueryAt("then run /fri and report", 13), { start: 9, query: "fri" })
  assert.deepEqual(slashQueryAt("line one\n/", 10), { start: 9, query: "" })
})

test("a path, a URL or a slash inside a word never opens it", () => {
  assert.equal(slashQueryAt("see /tmp/fo", 11), undefined)
  assert.equal(slashQueryAt("and/or", 6), undefined)
  assert.equal(slashQueryAt("https://x", 9), undefined)
  assert.equal(slashQueryAt("/con", null), undefined, "a blurred box has no caret, so no menu")
  assert.equal(slashQueryAt("/con done", 9), undefined, "the caret has left the token")
  assert.equal(slashQueryAt("```\n/fri", 8), undefined, "a fenced block is code, where nothing runs")
  assert.deepEqual(slashQueryAt("```\nx\n```\n/fri", 14), { start: 10, query: "fri" })
})

test("a built-in command is offered only where it runs — as the draft's first token", () => {
  assert.deepEqual(matchSlashItems(items, "", true).map((s) => s.name), ["ntwine-stack", "ntwine:gh", "context"])
  assert.deepEqual(matchSlashItems(items, "", false).map((s) => s.name), ["ntwine-stack", "ntwine:gh"])
  assert.deepEqual(matchSlashItems(items, "gh", false).map((s) => s.name), ["ntwine:gh"], "substring reaches a namespaced skill")
})

test("completion replaces the whole token in place and leaves one space", () => {
  assert.deepEqual(insertSlashCommand("run /ntw now", 4, 8, "ntwine-stack"), { prose: "run /ntwine-stack now", caret: 18 })
  assert.deepEqual(insertSlashCommand("/co", 0, 3, "context"), { prose: "/context ", caret: 9 })
  assert.deepEqual(insertSlashCommand("x /ntXXX", 2, 5, "ntwine:gh"), { prose: "x /ntwine:gh ", caret: 13 }, "the tail past the caret goes too")
})

test("only names the thread can run are tinted, commands only at the start", () => {
  const segs = (text: string) => slashSegments(text, items, 0, draftStart(text)).map((s) => `${s.kind}:${s.text}`)
  assert.deepEqual(segs("/context please"), ["command:/context", "text: please"])
  assert.deepEqual(segs("  /context"), ["text:  ", "command:/context"])
  assert.deepEqual(segs("use /context"), ["text:use /context"], "mid-sentence a command is plain text to Claude")
  assert.deepEqual(segs("use /ntwine-stack, then /ntwine:gh."), ["text:use ", "command:/ntwine-stack", "text:, then ", "command:/ntwine:gh", "text:."])
  assert.deepEqual(segs("/nope and /tmp/ntwine-stack"), ["text:/nope and /tmp/ntwine-stack"])
})

test("a run's offset decides whether its command opens the draft", () => {
  assert.deepEqual(slashSegments("/context", items, 5, 0).map((s) => s.kind), ["text"])
  assert.deepEqual(slashSegments("/context", items, 5, 5).map((s) => s.kind), ["command"])
})

test("a user command is offered and tinted mid-prompt, where Ntwine expands it", () => {
  assert.deepEqual(matchSlashItems(withUserCommand, "arm", false).map((s) => s.name), ["armstrong"])
  const text = "only finish when sure /armstrong"
  assert.deepEqual(slashSegments(text, withUserCommand, 0, draftStart(text)).map((s) => `${s.kind}:${s.text}`), ["text:only finish when sure ", "command:/armstrong"])
})
