// SPINOFFS: the child's composed prompt and the chat's reading of it back, the context Ntwine assembles
// for it, and the request an older build delivered to the parent's worker, which the chat still reads.
import { test } from "node:test"
import assert from "node:assert/strict"
import { DispatchInput, isInjectedNoise, SpinoffInput, parseSpinoffChildPrompt, parseSpinoffRequest, spinoffChildPrompt, spinoffContext, spinoffForkPrompt } from "./index.ts"

const id = "spn_0123456789abcdef"

// The envelope an older build (before 2026-10-07) delivered to the parent's worker, as its transcripts hold it.
const delivered = (instructions: string) => [
  `<spinoff-request id="${id}">`,
  "The human asked to spinoff a NEW thread from this conversation. Their instructions for it:",
  "<instructions>",
  instructions,
  "</instructions>",
  "",
  "Do this now, before anything else:",
  "</spinoff-request>",
].join("\n")

test("a delivered spinoff request still reads back as the human's instructions, multi-line text intact", () => {
  const instructions = "fix this\nand add a test"
  const message = delivered(instructions)
  assert.deepEqual(parseSpinoffRequest(message), { id, instructions })
  // The transcript drops "plumbing" by prefix; the request is the human's and must survive that filter
  // (a `<ntwine-…>` tag did not, and the request vanished from the parent's timeline).
  assert.equal(isInjectedNoise(message), false)
})

test("a mid-message envelope is just the human talking", () => {
  const message = delivered("investigate perf")
  assert.equal(parseSpinoffRequest(`look at this:\n${message}`), null)
  assert.equal(parseSpinoffRequest("fix this"), null)
})

test("a first-day request, asked of one message, still reads as a spinoff", () => {
  const legacy = [
    `<spin-off-request id="${id}">`,
    "The human selected one message in this conversation and asked for a NEW thread spun off from it.",
    "",
    "Their instructions for the new thread:",
    "<instructions>",
    "fix this",
    "</instructions>",
    "",
    "The message they selected:",
    "<selected-message>",
    "The cache keys on the raw id.",
    "</selected-message>",
    "",
    "Do this now, before anything else:",
    "</spin-off-request>",
  ].join("\n")
  assert.deepEqual(parseSpinoffRequest(legacy), { id, instructions: "fix this" })
  // The tags must agree: one envelope's open with the other's close is not a request.
  assert.equal(parseSpinoffRequest(legacy.replace("</spin-off-request>", "</spinoff-request>")), null)
})

test("the child's prompt carries the human's words verbatim and a link back, above the parent's brief", () => {
  const prompt = spinoffChildPrompt({ parentSlug: "cache-bug", parentTitle: "Cache [bug]", instructions: "fix this\nsoon", brief: "The resolver keys on…" })
  assert.equal(prompt.split("\n")[0], "A spinoff of [Cache bug](/thread/cache-bug), at the user's request. Their instructions:")
  assert.match(prompt, /\n> fix this\n> soon\n/)
  assert.ok(prompt.endsWith("The resolver keys on…"))
})

test("a parent with a handle is named by it, which the child's prose and read_thread both resolve", () => {
  const prompt = spinoffChildPrompt({ parentSlug: "cache-bug", parentTitle: "Cache bug", parentHandle: "cache-bug", instructions: "fix this", brief: "The resolver keys on…" })
  assert.equal(prompt.split("\n")[0], "A spinoff of @cache-bug, at the user's request. Their instructions:")
  assert.match(prompt, /\nContext from @cache-bug:\n/)
})

test("the child's first prompt reads back into the human's instructions and its context", () => {
  const brief = "The resolver keys on the raw id.\n\n> a quoted line in the brief stays in the brief\n\n- src/resolver.ts"
  for (const parentHandle of ["cache-bug", undefined]) {
    const prompt = spinoffChildPrompt({ parentSlug: "cache-bug", parentTitle: "Cache bug", parentHandle, instructions: "fix this\n\nand add a test", brief })
    assert.deepEqual(parseSpinoffChildPrompt(prompt), { instructions: "fix this\n\nand add a test", brief })
    // The dispatch envelope is stripped before this runs, but trailing/leading whitespace is not a reason to miss.
    assert.deepEqual(parseSpinoffChildPrompt(`\n${prompt}\n`), { instructions: "fix this\n\nand add a test", brief })
  }
  // …and so does an older child's, whose context line said the parent's worker had gathered it.
  const older = spinoffChildPrompt({ parentSlug: "cache-bug", parentTitle: "Cache bug", parentHandle: "cache-bug", instructions: "fix this", brief }).replace("Context from @cache-bug:", "The context @cache-bug gathered for you:")
  assert.deepEqual(parseSpinoffChildPrompt(older), { instructions: "fix this", brief })
  // …and one written before 2026-10-08, when the request was "the human's".
  const human = spinoffChildPrompt({ parentSlug: "cache-bug", parentTitle: "Cache bug", parentHandle: "cache-bug", instructions: "fix this", brief }).replace("at the user's request", "at the human's request")
  assert.notEqual(human, spinoffChildPrompt({ parentSlug: "cache-bug", parentTitle: "Cache bug", parentHandle: "cache-bug", instructions: "fix this", brief }))
  assert.deepEqual(parseSpinoffChildPrompt(human), { instructions: "fix this", brief })
  const humanFork = spinoffForkPrompt({ parentSlug: "cache-bug", parentTitle: "Cache bug", parentHandle: "cache-bug", instructions: "fix this" }).replace("at the user's request", "at the human's request")
  assert.deepEqual(parseSpinoffChildPrompt(humanFork), { instructions: "fix this", brief: "" })
  // Anything else is just a prompt: a brief a worker wrote itself, a human quoting the header mid-message.
  assert.equal(parseSpinoffChildPrompt("Evaluate whether the feature is a good idea."), null)
  assert.equal(parseSpinoffChildPrompt("see: A spinoff of @cache-bug, at the human's request. Their instructions:\n\n> x\n\nThe context @cache-bug gathered for you:\n\ny"), null)
})

// THE SUMMARY ROUTE's context (server router.ts summarySpinoff): the parent's request and handoff,
// quoted, then where to read the rest — and, across projects, where the parent lives.
test("the context Ntwine assembles quotes the parent's request and handoff, then says how to read more", () => {
  const context = spinoffContext({
    parentSlug: "cache-bug", parentTitle: "Cache bug", parentHandle: "cache-bug", readAs: "cache-bug",
    request: "Why does the resolver miss?", handoff: "Fixed the key.\n\n```done\nShipped.\n```",
  })
  assert.equal(context, [
    "@cache-bug's original request:",
    "",
    "> Why does the resolver miss?",
    "",
    "@cache-bug's latest handoff:",
    "",
    "> Fixed the key.",
    ">",
    "> ```done",
    "> Shipped.",
    "> ```",
    "",
    "@cache-bug was not told about this thread and does not wait on it. Read more of its conversation with the `read_thread` tool on `cache-bug`.",
  ].join("\n"))
  // Nothing stored yet (a parent with no transcript): only the pointer back.
  const bare = spinoffContext({ parentSlug: "cache-bug", parentTitle: "Cache [bug]", readAs: "cache-bug" })
  assert.equal(bare, "[Cache bug](/thread/cache-bug) was not told about this thread and does not wait on it. Read more of its conversation with the `read_thread` tool on `cache-bug`.")
  // Across projects, the child is told the parent's checkout is not its own.
  const elsewhere = spinoffContext({ parentSlug: "cache-bug", parentTitle: "Cache bug", parentHandle: "cache-bug", readAs: "cache-bug", project: { name: "arktype", dir: "/home/u/arktype" } })
  assert.match(elsewhere, /^@cache-bug is in the arktype project \(`\/home\/u\/arktype`\), not this one: its paths are relative to that checkout/)
  // And it reads back out of the child's prompt whole.
  const prompt = spinoffChildPrompt({ parentSlug: "cache-bug", parentTitle: "Cache bug", parentHandle: "cache-bug", instructions: "load test it", brief: context })
  assert.deepEqual(parseSpinoffChildPrompt(prompt), { instructions: "load test it", brief: context })
})

test("ids and inputs are validated at the schema", () => {
  // A worker whose MCP server predates 2026-10-07 may still send a `spinoff` id; it is stripped, and the
  // spawn goes through as a plain one.
  const stale = DispatchInput.safeParse({ prompt: "x", spinoff: id, spinoffFrom: "parent" })
  assert.equal(stale.success, true)
  assert.equal(stale.success && "spinoff" in stale.data, false)
  const base = { slug: "parent", sessionId: "sid" }
  assert.equal(SpinoffInput.safeParse({ ...base, instructions: "   " }).success, false)
  assert.equal(SpinoffInput.safeParse({ ...base, instructions: "fix this" }).success, true)
  // No message is picked any more, so a client that still sends one is out of date and refused.
  assert.equal(SpinoffInput.safeParse({ ...base, instructions: "fix this", sourceId: "m1" }).success, false)
})
