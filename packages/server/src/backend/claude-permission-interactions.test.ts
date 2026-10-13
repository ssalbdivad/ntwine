// CI tests for the AskUserQuestion → agent-question mapping and, above all, for the ANSWER CONTRACT:
// the answers object is keyed by the FULL QUESTION TEXT and its value is exactly an advertised option
// label. Claude's own result mapper looks answers up by that key; an index-keyed or paraphrased answer
// parses fine and then silently reads to the model as "the user did not answer the questions", which
// is the bug this path exists to remove. These assertions therefore pin bytes, not shapes.
//
// The live proof that the real binary agrees is _live_broker_ask.mts (a real session, a real card, and
// the model repeating the chosen label back). These tests pin the mapping so it cannot drift after.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  CLAUDE_ASK_USER_QUESTION_TOOL,
  buildClaudeQuestionInteraction,
  claudeFirstApprovalHint,
  claudeQuestionDecisionFor,
  parseClaudeAskUserQuestion,
  tildePath,
} from "./claude-permission-interactions.ts"
import type { ClaudePermissionRequest } from "./claude-agent-sdk-protocol.ts"

const OWNER = { projectId: "p1", threadSlug: "ask-thread", sessionId: "s1", cwd: "/tmp/repo" }

function requestFor(input: unknown): ClaudePermissionRequest {
  return {
    requestId: "perm-1",
    toolUseId: "toolu_ask_1",
    toolName: CLAUDE_ASK_USER_QUESTION_TOOL,
    input: input as ClaudePermissionRequest["input"],
    suggestions: [],
  }
}

const CHANNEL_INPUT = {
  questions: [{
    question: "Which release channel should we ship on?",
    header: "Channel",
    options: [
      { label: "Stable", description: "Battle tested" },
      { label: "Beta", description: "Ships weekly" },
    ],
    multiSelect: false,
  }],
}

test("a well-formed AskUserQuestion input parses with its provider text VERBATIM", () => {
  const spec = parseClaudeAskUserQuestion(CHANNEL_INPUT)
  assert.ok(spec)
  assert.equal(spec.questions.length, 1)
  assert.equal(spec.questions[0].question, "Which release channel should we ship on?")
  assert.equal(spec.questions[0].header, "Channel")
  assert.deepEqual(spec.questions[0].options.map((o) => o.label), ["Stable", "Beta"])
  assert.equal(spec.questions[0].multiSelect, false)
})

test("the card is an agent-question with one select field per question, valued by the exact labels", () => {
  const spec = parseClaudeAskUserQuestion(CHANNEL_INPUT)!
  const request = buildClaudeQuestionInteraction(spec, requestFor(CHANNEL_INPUT), OWNER)
  assert.ok(request)
  assert.equal(request.payload.kind, "agent-question")
  assert.equal(request.provider.kind, "claude")
  // "agent", the same source kind codex's request-user-input uses, so one web card renders both.
  assert.equal(request.source.kind, "agent")
  assert.deepEqual(request.allowedDecisions.map((d) => [d.id, d.semantic]), [["answer", "answer"], ["decline", "decline"]])
  assert.equal(request.payload.kind === "agent-question" && request.payload.title, "Channel")
  const fields = request.payload.kind === "agent-question" ? request.payload.fields : []
  // Two fields per question: the options, and the free-text half the shared card's box writes into.
  assert.deepEqual(fields.map((f) => [f.id, f.input]), [["q0", "select"], ["q0_notes", "multiline"]])
  // Neither half is `required`: picking an option OR typing is a complete answer, exactly as on a
  // ```question fence. "at least one of the two" is enforced where the decision is built.
  assert.equal(fields[0].required, false)
  assert.equal(fields[0].description, "Which release channel should we ship on?")
  // The VALUE is the provider's exact label (that is what the answer must echo); the option's
  // description is folded into the display label because the card renders only `option.label`.
  const options = fields[0].input === "select" ? fields[0].options : []
  assert.deepEqual(options.map((o) => o.value), ["Stable", "Beta"])
  assert.deepEqual(options.map((o) => o.label), ["Stable — Battle tested", "Beta — Ships weekly"])
})

test("ANSWER CONTRACT: the answers object is keyed by the full question text, not an index", () => {
  const spec = parseClaudeAskUserQuestion(CHANNEL_INPUT)!
  const decision = claudeQuestionDecisionFor(spec, "answer", { q0: "Beta" })
  assert.equal(decision.behavior, "allow")
  assert.deepEqual(decision.behavior === "allow" ? decision.updatedInput : undefined, {
    questions: CHANNEL_INPUT.questions,
    answers: { "Which release channel should we ship on?": "Beta" },
  })
})

test("the questions array is echoed VERBATIM when it fits, not silently rebuilt", () => {
  // Distinguishes the normal path from the minimal-rebuild fallback at the bottom of this file: a
  // field the rebuild drops (`preview`) must survive whenever echoing the provider's own array fits.
  const input = {
    questions: [{
      question: "Which layout?",
      header: "Layout",
      options: [{ label: "Grid", description: "Cards", preview: "<div>grid</div>" }, { label: "List", description: "Rows" }],
      multiSelect: false,
    }],
  }
  const decision = claudeQuestionDecisionFor(parseClaudeAskUserQuestion(input)!, "answer", { q0: "Grid" })
  assert.deepEqual(decision.behavior === "allow" ? decision.updatedInput?.questions : undefined, input.questions)
})

test("a multiSelect question maps to a multi-select field and a \", \"-joined answer", () => {
  const input = {
    questions: [{
      question: "Which extras should we enable?",
      header: "Extras",
      options: [{ label: "Metrics", description: "Emit metrics" }, { label: "Tracing", description: "Emit traces" }],
      multiSelect: true,
    }],
  }
  const spec = parseClaudeAskUserQuestion(input)!
  const request = buildClaudeQuestionInteraction(spec, requestFor(input), OWNER)!
  const fields = request.payload.kind === "agent-question" ? request.payload.fields : []
  assert.equal(fields[0].input, "multi-select")
  const decision = claudeQuestionDecisionFor(spec, "answer", { q0: ["Metrics", "Tracing"] })
  // claude 2.1.220's own schema: "multi-select answers are comma-separated", and its result mapper
  // splits on exactly ", " before checking each part against the advertised labels.
  assert.deepEqual(decision.behavior === "allow" ? decision.updatedInput?.answers : undefined, {
    "Which extras should we enable?": "Metrics, Tracing",
  })
})

test("several questions each get their own field and their own answer key", () => {
  const input = {
    questions: [
      { question: "Which channel?", header: "Channel", options: [{ label: "Stable", description: "" }, { label: "Beta", description: "" }], multiSelect: false },
      { question: "Tag a release now?", header: "Release", options: [{ label: "Yes", description: "" }, { label: "No", description: "" }], multiSelect: false },
    ],
  }
  const spec = parseClaudeAskUserQuestion(input)!
  const request = buildClaudeQuestionInteraction(spec, requestFor(input), OWNER)!
  assert.equal(request.payload.kind === "agent-question" && request.payload.title, "Claude questions")
  const fields = request.payload.kind === "agent-question" ? request.payload.fields : []
  assert.deepEqual(fields.map((f) => f.id), ["q0", "q0_notes", "q1", "q1_notes"])
  const decision = claudeQuestionDecisionFor(spec, "answer", { q0: "Beta", q1: "No" })
  assert.deepEqual(decision.behavior === "allow" ? decision.updatedInput?.answers : undefined, {
    "Which channel?": "Beta",
    "Tag a release now?": "No",
  })
})

test("FREE TEXT rides the SDK's own annotations, with claude's notes-only sentinel in answers", () => {
  // The fence card's free-text box is not an ntwine convention bolted onto a tool call: claude's own
  // AskUserQuestion input schema carries `annotations[questionText].notes`, and its result mapper
  // special-cases the literal "(notes only)" answer. Picking an option AND typing sends both.
  const spec = parseClaudeAskUserQuestion(CHANNEL_INPUT)!
  const withPick = claudeQuestionDecisionFor(spec, "answer", { q0: "Beta", q0_notes: "but check the changelog first" })
  assert.deepEqual(withPick.behavior === "allow" ? withPick.updatedInput?.answers : undefined, {
    "Which release channel should we ship on?": "Beta",
  })
  assert.deepEqual(withPick.behavior === "allow" ? withPick.updatedInput?.annotations : undefined, {
    "Which release channel should we ship on?": { notes: "but check the changelog first" },
  })
  // Typing INSTEAD of picking is a complete answer too — the fence card's single-select semantics,
  // where free text overrides the chip.
  const notesOnly = claudeQuestionDecisionFor(spec, "answer", { q0_notes: "neither — ship nothing yet" })
  assert.deepEqual(notesOnly.behavior === "allow" ? notesOnly.updatedInput?.answers : undefined, {
    "Which release channel should we ship on?": "(notes only)",
  })
  assert.deepEqual(notesOnly.behavior === "allow" ? notesOnly.updatedInput?.annotations : undefined, {
    "Which release channel should we ship on?": { notes: "neither — ship nothing yet" },
  })
  // No notes at all → no annotations key, so a clean pick stays a clean pick.
  const clean = claudeQuestionDecisionFor(spec, "answer", { q0: "Stable" })
  assert.equal(clean.behavior === "allow" ? "annotations" in (clean.updatedInput ?? {}) : true, false)
})

test("declining, cancelling, and an empty answer set all DENY with a reason the model can act on", () => {
  const spec = parseClaudeAskUserQuestion(CHANNEL_INPUT)!
  for (const [decisionId, values] of [["decline", undefined], ["cancel", undefined], ["answer", {}], ["answer", { q0: "" }]] as const) {
    const decision = claudeQuestionDecisionFor(spec, decisionId, values)
    assert.equal(decision.behavior, "deny", `${decisionId} ${JSON.stringify(values)}`)
    assert.match(decision.behavior === "deny" ? decision.message : "", /did not answer/)
  }
})

test("inputs that cannot be represented EXACTLY are rejected rather than approximated", () => {
  // Each of these would produce an answer key or an answer value that does not match the provider's
  // bytes, which claude reads as a freeform answer or as no answer at all.
  const bad: Array<[string, unknown]> = [
    ["no questions array", { questions: "nope" }],
    ["empty questions array", { questions: [] }],
    ["a question with no options", { questions: [{ question: "Q?", header: "H", options: [], multiSelect: false }] }],
    ["a duplicate question text (ambiguous answer key)", {
      questions: [
        { question: "Same?", header: "A", options: [{ label: "x", description: "" }], multiSelect: false },
        { question: "Same?", header: "B", options: [{ label: "y", description: "" }], multiSelect: false },
      ],
    }],
    ["a duplicate option label", { questions: [{ question: "Q?", header: "H", options: [{ label: "x", description: "" }, { label: "x", description: "" }], multiSelect: false }] }],
    ["a question longer than the 256-byte object-key bound", { questions: [{ question: `${"q".repeat(300)}?`, header: "H", options: [{ label: "x", description: "" }], multiSelect: false }] }],
    ["a control character in the question (rejected, never rewritten)", { questions: [{ question: "Whichchannel?", header: "H", options: [{ label: "x", description: "" }], multiSelect: false }] }],
    ["a control character in an option label", { questions: [{ question: "Q?", header: "H", options: [{ label: "Stable", description: "" }], multiSelect: false }] }],
    ["a bidi override in an option label", { questions: [{ question: "Q?", header: "H", options: [{ label: "Sta‮le", description: "" }], multiSelect: false }] }],
    ["a newline in an option label (not a single-line option value)", { questions: [{ question: "Q?", header: "H", options: [{ label: "St\nable", description: "" }], multiSelect: false }] }],
    ["a reserved question text", { questions: [{ question: "__proto__", header: "H", options: [{ label: "x", description: "" }], multiSelect: false }] }],
  ]
  for (const [label, input] of bad) assert.equal(parseClaudeAskUserQuestion(input), null, label)
})

test("hostile display text is scrubbed for the CARD while the answer keeps the provider's bytes", () => {
  const input = {
    questions: [{
      // Unsafe text in the DESCRIPTION is display-only, so it is scrubbed rather than rejected — the
      // description never becomes an answer key or an answer value.
      question: "Which channel?",
      header: "Channel",
      options: [{ label: "Stable", description: "safe --token=hunter2 desc" }, { label: "Beta", description: "" }],
      multiSelect: false,
    }],
  }
  const spec = parseClaudeAskUserQuestion(input)!
  const request = buildClaudeQuestionInteraction(spec, requestFor(input), OWNER)
  assert.ok(request, "a scrubbable description must not sink the card")
  const fields = request.payload.kind === "agent-question" ? request.payload.fields : []
  const options = fields[0].input === "select" ? fields[0].options : []
  assert.ok(!options[0].label.includes(""), "control bytes never reach the card")
  assert.equal(options[0].value, "Stable", "the answer value stays the provider's exact label")
  const decision = claudeQuestionDecisionFor(spec, "answer", { q0: "Stable" })
  assert.deepEqual(decision.behavior === "allow" ? decision.updatedInput?.answers : undefined, { "Which channel?": "Stable" })
})

test("an oversized option preview degrades to a minimal echo instead of failing the decision", () => {
  // `preview` carries HTML mockups and the protocol's per-string cap is 16 KB. Echoing the original
  // would throw at the far end and fail the permission callback, taking the turn with it; the answer
  // still has to land, so the questions array is rebuilt minimally and the preview is dropped.
  const input = {
    questions: [{
      question: "Which layout?",
      header: "Layout",
      options: [
        { label: "Grid", description: "Cards", preview: "x".repeat(20_000) },
        { label: "List", description: "Rows" },
      ],
      multiSelect: false,
    }],
  }
  const spec = parseClaudeAskUserQuestion(input)!
  const decision = claudeQuestionDecisionFor(spec, "answer", { q0: "Grid" })
  assert.equal(decision.behavior, "allow")
  const updated = decision.behavior === "allow" ? decision.updatedInput : undefined
  assert.deepEqual(updated?.answers, { "Which layout?": "Grid" })
  const questions = updated?.questions as Array<Record<string, unknown>>
  assert.equal(questions.length, 1)
  assert.deepEqual(questions[0].options, [{ label: "Grid", description: "Cards" }, { label: "List", description: "Rows" }])
  assert.equal(JSON.stringify(updated).includes("x".repeat(100)), false, "the oversized preview is gone")
})

// The permission card leads with the cwd, `~`-shortened so it stays narrow. The remainder after the
// home prefix opens with `\` on Windows, and the old `/`-only check showed those in full (Windows
// audit 2026-09-11, finding 14).
test("tildePath collapses the home prefix under either separator, and never a sibling that merely shares the prefix", () => {
  assert.equal(tildePath("/Users/op/code/ntwine", "/Users/op"), "~/code/ntwine")
  assert.equal(tildePath("/Users/op", "/Users/op"), "~")
  assert.equal(tildePath("/Users/operator/x", "/Users/op"), "/Users/operator/x", "a longer sibling is not under home")
  assert.equal(tildePath("C:\\Users\\op\\code\\ntwine", "C:\\Users\\op"), "~\\code\\ntwine")
  assert.equal(tildePath("C:\\Users\\op", "C:\\Users\\op"), "~")
  assert.equal(tildePath("C:\\Users\\operator\\x", "C:\\Users\\op"), "C:\\Users\\operator\\x")
  assert.equal(tildePath("/elsewhere/op", "/Users/op"), "/elsewhere/op")
})

// ---- the first approval each agent needs is held back with a note ----------------------------------

// What real claude 2.1.287 sends for `rm -rf $W/$t` under bypassPermissions (read off a live canUseTool).
const SAFETY_CHECK: ClaudePermissionRequest = {
  requestId: "perm-rm",
  toolUseId: "toolu_rm",
  toolName: "Bash",
  input: { command: "W=/tmp/w; for t in A B; do rm -rf $W/$t; done" },
  decisionReason: "Dangerous rm operation on possibly-empty variable path: $W/$t in `rm -rf $W/$t` (rewrite it as \"${W:?}\"/\"${t:?}\" or use a literal path)",
  decisionReasonType: "safetyCheck",
  ruleForced: false,
  suggestions: [],
}

test("the note names the cause, quotes claude's own reason, and says how to reach the operator anyway", () => {
  const hint = claudeFirstApprovalHint(SAFETY_CHECK, "bypassPermissions", 5 * 60_000)
  assert.ok(hint)
  assert.match(hint, /needs the operator's explicit approval/)
  assert.match(hint, /within 5 minutes is denied/)
  assert.match(hint, /Why it needs approval: one of Claude Code's own safety checks/)
  assert.ok(hint.includes(`Claude Code's reason: ${SAFETY_CHECK.decisionReason}`), "claude's reason carries the fix; it must reach the agent verbatim")
  assert.match(hint, /make the identical call again and it goes to the operator/)
})

test("each documented cause reads as its own sentence, and an unknown or missing one still reads true", () => {
  const causeOf = (decisionReasonType: string | undefined) =>
    /Why it needs approval: (.*)/.exec(claudeFirstApprovalHint({ ...SAFETY_CHECK, decisionReason: undefined, decisionReasonType }, "auto", 60_000) ?? "")?.[1]
  assert.match(causeOf("subcommandResults") ?? "", /one part of this compound command/)
  assert.match(causeOf("workingDir") ?? "", /outside the directories/)
  assert.match(causeOf("sandboxOverride") ?? "", /outside the sandbox/)
  assert.match(causeOf("classifier") ?? "", /classifier/)
  assert.equal(causeOf("other"), causeOf(undefined))
  assert.match(causeOf(undefined) ?? "", /will not run it without a person's go-ahead/)
  const withPath = claudeFirstApprovalHint({ ...SAFETY_CHECK, blockedPath: "/etc/hosts" }, "auto", 60_000) ?? ""
  assert.match(withPath, /Blocked path: \/etc\/hosts/)
})

test("an escalation someone asked for goes straight to the operator: ask rules, hooks, restrictive modes", () => {
  assert.equal(claudeFirstApprovalHint({ ...SAFETY_CHECK, decisionReasonType: "rule" }, "bypassPermissions", 60_000), null)
  assert.equal(claudeFirstApprovalHint({ ...SAFETY_CHECK, decisionReasonType: "hook" }, "bypassPermissions", 60_000), null)
  assert.equal(claudeFirstApprovalHint({ ...SAFETY_CHECK, ruleForced: true }, "bypassPermissions", 60_000), null, "an ask rule riding beside a safety check is still an ask rule")
  for (const mode of ["default", "acceptEdits", "plan", "dontAsk"]) {
    assert.equal(claudeFirstApprovalHint(SAFETY_CHECK, mode, 60_000), null, `${mode} is a mode the operator chose to be asked in`)
  }
  assert.equal(claudeFirstApprovalHint(requestFor(CHANNEL_INPUT), "bypassPermissions", 60_000), null, "a question is not an authorization")
  assert.ok(claudeFirstApprovalHint(SAFETY_CHECK, "auto", 60_000))
  assert.ok(claudeFirstApprovalHint(SAFETY_CHECK, undefined, 60_000), "a daemon that predates recording its mode was dispatched permissive")
})
