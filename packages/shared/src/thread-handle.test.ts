import assert from "node:assert/strict"
import test from "node:test"
import { addressSegments, isReplyWaitFor, replyWaitOf, replyWaitPrompt, subAgentAddress, subAgentChain, subAgentHandle, threadHandle, threadMentions } from "./thread-handle.ts"
import { isAwaitingItemKind, splitAwaitingFrontmatter } from "./index.ts"

test("a name shows as the kebab-case handle it is addressed by", () => {
  assert.equal(threadHandle("Shell budgets"), "shell-budgets")
  assert.equal(threadHandle("Focus mode"), "focus-mode")
  assert.equal(threadHandle("Mentions"), "mentions")
  // Every word lowercases whole, and a word is never split at its capitals.
  assert.equal(threadHandle("ArkType perf"), "arktype-perf")
  assert.equal(threadHandle("API keys"), "api-keys")
  assert.equal(threadHandle("Codex MCP"), "codex-mcp")
  // Punctuation separates words and diacritics fold away; an existing handle is its own handle.
  assert.equal(threadHandle("Zod 4.5"), "zod-4-5")
  assert.equal(threadHandle("Café menu"), "cafe-menu")
  assert.equal(threadHandle("shell-budgets"), "shell-budgets")
})

test("a session title of up to five words gets a handle; a sentence does not", () => {
  assert.equal(threadHandle("Test fixture secret word"), "test-fixture-secret-word")
  assert.equal(threadHandle("Zon4.5 features and z.properties documentation audit"), undefined)
  assert.equal(threadHandle("  "), undefined)
})

test("mentions are read off free text, not off email addresses", () => {
  assert.deepEqual(threadMentions("ask @shell-budgets about it, then reconcile with @focus-mode."), ["shell-budgets", "focus-mode"])
  assert.deepEqual(threadMentions("@arktype-perf first"), ["arktype-perf"])
  // A handle written before the kebab switch is still read whole.
  assert.deepEqual(threadMentions("@shellBudgets first"), ["shellBudgets"])
  assert.deepEqual(threadMentions("mail david@pullfrog.com"), [])
})

test("a dash straight after a mention is punctuation, not part of it", () => {
  assert.deepEqual(threadMentions("ask @shell-budgets- then"), ["shell-budgets"])
  assert.deepEqual(threadMentions("ask @shell-budgets -- then @focus-mode_"), ["shell-budgets", "focus-mode"])
})

test("a sub-agent mention runs through its thread's handle, and a full stop after a mention is not part of it", () => {
  assert.deepEqual(threadMentions("ask @port-the-parser.cache-keys, then @port-the-parser.wave-2.impl-w3."), ["port-the-parser.cache-keys", "port-the-parser.wave-2.impl-w3"])
  assert.deepEqual(threadMentions("done with @shell-budgets. Next"), ["shell-budgets"])
})

test("a sub-agent is named by the thread rule and addressed under its thread", () => {
  assert.equal(subAgentHandle("Cache keys"), "cache-keys")
  assert.equal(subAgentHandle("fix:r1"), "fix-r1")
  assert.equal(subAgentHandle("Fresh-context review of the whole effort diff"), undefined, "a sentence has no handle")
  assert.deepEqual(addressSegments("@port-the-parser.cache-keys"), ["port-the-parser", "cache-keys"])
  const agents = [
    { id: "wf", label: "Wave 2" },
    { id: "w3", label: "impl:W3", parentId: "wf" },
    { id: "long", label: "Fresh-context review of the whole effort diff" },
    { id: "under-long", label: "Cache keys", parentId: "long" },
    { id: "orphan", label: "Orphan", parentId: "gone" },
  ]
  assert.deepEqual(subAgentChain(agents, "w3"), ["wave-2", "impl-w3"])
  assert.equal(subAgentAddress("port-the-parser", subAgentChain(agents, "w3")!), "port-the-parser.wave-2.impl-w3")
  assert.equal(subAgentChain(agents, "under-long"), undefined, "a parent with no handle leaves a hole")
  assert.equal(subAgentChain(agents, "orphan"), undefined, "a parent that has returned leaves a hole")
})

// A REPLY WAIT names its thread in its prompt, and both sides read it back from there.
test("replyWaitOf reads back the thread a reply-wait prompt names, and nothing from any other timer", () => {
  assert.deepEqual(replyWaitOf(replyWaitPrompt("shell-budgets", "sb")), { handle: "shell-budgets", slug: "sb" })
  assert.deepEqual(replyWaitOf(replyWaitPrompt("shell-budgets", "sb", "beta")), { handle: "shell-budgets", slug: "sb", project: "beta" })
  assert.equal(isReplyWaitFor(replyWaitPrompt("shell-budgets", "sb", "beta"), "sb"), false, "a wait on another project's `sb` is not one on ours")
  assert.equal(isReplyWaitFor(replyWaitPrompt("shell-budgets", "sb"), "sb"), true)
  assert.equal(replyWaitOf("Re-run the suite and report"), undefined)
})

// `threads:` is the awaiting fence's list of awaited threads, parsed like `prs:`.
// `@` is a character YAML reserves, so the list is read verbatim: a bare `@handle` must not cost the fence
// its other lines.
test("splitAwaitingFrontmatter: `threads:` is a structural key producing `thread` hints, `@` and all", () => {
  const { hints, body } = splitAwaitingFrontmatter("threads: [@shell-budgets, \"@focus-mode\", tea-recipes]\nshells: [b1x]\nstatus: watching\nfor: 1h\n---\nAsked which file owns the cap.")
  assert.deepEqual(hints, [
    { kind: "shell", value: "b1x" },
    { kind: "status", value: "watching" },
    { kind: "for", value: "1h" },
    { kind: "thread", value: "@shell-budgets" },
    { kind: "thread", value: "@focus-mode" },
    { kind: "thread", value: "tea-recipes" },
  ])
  assert.equal(body, "Asked which file owns the cap.")
  // A block list and a bare value read the same way.
  assert.deepEqual(splitAwaitingFrontmatter("threads:\n  - @shell-budgets\nfor: 1h").hints, [{ kind: "for", value: "1h" }, { kind: "thread", value: "@shell-budgets" }])
  assert.deepEqual(splitAwaitingFrontmatter("threads: @shell-budgets\nfor: 1h").hints, [{ kind: "for", value: "1h" }, { kind: "thread", value: "@shell-budgets" }])
  assert.equal(isAwaitingItemKind("thread"), true)
})
