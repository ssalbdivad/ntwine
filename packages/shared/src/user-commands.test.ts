import assert from "node:assert/strict"
import { test } from "node:test"
import { expandUserCommand, expandUserCommandDraft, userCommandDisplayText } from "./index.ts"

const commit = { name: "commit", body: "commit with a one-line message" }
const fix = { name: "fix", body: "Fix this: $ARGUMENTS. Then run the tests." }

test("$ARGUMENTS is replaced; without it, arguments ride on a line of their own", () => {
  assert.equal(expandUserCommand(fix, "the flaky test"), '<slash-command name="fix" args="the flaky test">\nFix this: the flaky test. Then run the tests.\n</slash-command>')
  assert.equal(expandUserCommand(commit, "say why"), '<slash-command name="commit" args="say why">\ncommit with a one-line message\n\nARGUMENTS: say why\n</slash-command>')
  assert.equal(expandUserCommand(commit, ""), '<slash-command name="commit">\ncommit with a one-line message\n</slash-command>')
})

test("a draft that opens with a known command becomes its prompt", () => {
  assert.ok(expandUserCommandDraft("/commit", [commit])?.includes("one-line message"))
  assert.ok(expandUserCommandDraft("  /fix the build\nand the lint", [fix])?.includes("Fix this: the build\nand the lint."))
  assert.equal(expandUserCommandDraft("/commitx", [commit]), undefined)
  assert.equal(expandUserCommandDraft("/tmp/commit", [commit]), undefined)
})

test("a delivered command reads back as exactly what was typed, whatever its arguments hold", () => {
  for (const args of ["", "the flaky test", 'quote "this" & <that>\nsecond line']) {
    const typed = args ? `/fix ${args}` : "/fix"
    assert.equal(userCommandDisplayText(expandUserCommandDraft(typed, [fix])!), typed)
  }
  // What a send appends after the wrapper (attached context, file paths) stays visible.
  assert.equal(userCommandDisplayText(`${expandUserCommand(commit, "")}\n\n/home/x/shot.png`), "/commit\n\n/home/x/shot.png")
  assert.equal(userCommandDisplayText("an ordinary message"), undefined)
  assert.equal(userCommandDisplayText('<slash-command name="x">\nno close'), undefined)
})

test("a command mid-prompt keeps the prose and rides after it", () => {
  const sent = expandUserCommandDraft("test it, then /commit.", [commit, fix])!
  assert.equal(sent, 'test it, then /commit.\n\n<slash-command name="commit">\ncommit with a one-line message\n</slash-command>')
  assert.equal(userCommandDisplayText(sent), "test it, then /commit.")
  assert.equal(userCommandDisplayText(`${sent}\n\n/home/x/shot.png`), "test it, then /commit.\n\n/home/x/shot.png")
  // Each command once, an unknown name or a path never, and the opening command not twice.
  assert.equal(expandUserCommandDraft("/commit or /commit again", [commit])!.match(/<slash-command/g)!.length, 1)
  const both = expandUserCommandDraft("/fix the build, then /commit and /commit", [fix, commit])!
  assert.equal(both.match(/<slash-command name="commit">/g)!.length, 1)
  assert.equal(userCommandDisplayText(both), "/fix the build, then /commit and /commit")
  assert.equal(expandUserCommandDraft("see /tmp/commit and a/commit and /commits", [commit]), undefined)
  assert.ok(expandUserCommandDraft("then (/commit) it", [commit])?.includes("one-line message"), "in brackets, as the box tints it")
  // Quoted code is not an invocation: inline code, and every fence the composer paints as code.
  assert.equal(expandUserCommandDraft("the file says `/commit` and\n```\n/commit\n```", [commit]), undefined)
  assert.equal(expandUserCommandDraft("~~~\nrun /commit\n~~~", [commit]), undefined)
  assert.equal(expandUserCommandDraft("````md\n```\n/commit\n```\n````", [commit]), undefined)
  assert.equal(expandUserCommandDraft("``` /commit\nx\n```", [commit]), undefined)
  assert.ok(expandUserCommandDraft("```\nx\n```\nthen /commit", [commit])?.includes("one-line message"), "after the fence closes it counts")
})
