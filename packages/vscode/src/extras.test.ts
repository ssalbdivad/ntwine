import { test } from "node:test"
import assert from "node:assert/strict"
import { EMBED_MAX_COMMAND } from "@ntwine/shared/embed-protocol"
import { countsPhrase, extrasMessage, listedProblems, MAX_PROBLEMS, plainTerminalText, problemsText, terminalCommandText, type FileProblem } from "./extras.ts"
import { QUOTE_MAX_BYTES, QUOTE_MAX_LINES } from "./message.ts"

const problem = (line: number, severity: number, message: string, extra: Partial<FileProblem> = {}): FileProblem => ({ line, character: 4, severity, message, ...extra })

test("the problems chip reads as the Problems panel does: the file and its counts, then errors first, by line", () => {
  const text = problemsText("src/a.ts", [
    problem(20, 1, "'x' is declared but never used.", { source: "ts", code: 6133 }),
    problem(11, 0, "Cannot find name 'foo'.", { source: "ts", code: 2304 }),
    problem(3, 3, "A hint, never listed."),
    problem(30, 0, "Unexpected any.", { source: "eslint", code: { value: "no-explicit-any" } }),
    problem(1, 2, "An info\nover two lines."),
  ])
  assert.equal(text, [
    "Problems in src/a.ts: 2 errors, 1 warning, 1 info",
    "12:5 error Cannot find name 'foo'. ts(2304)",
    "31:5 error Unexpected any. eslint(no-explicit-any)",
    "21:5 warning 'x' is declared but never used. ts(6133)",
    "2:5 info An info over two lines.",
  ].join("\n"))
})

test("a file with only hints, or none, has no problems chip", () => {
  assert.equal(problemsText("a.ts", []), undefined)
  assert.equal(problemsText("a.ts", [problem(1, 3, "unused")]), undefined)
  assert.deepEqual(listedProblems([problem(1, 3, "unused")]), [])
})

test("past MAX_PROBLEMS the rest are counted, not dropped silently", () => {
  const many = Array.from({ length: MAX_PROBLEMS + 7 }, (_, i) => problem(i, 0, `Error ${i}`))
  const lines = problemsText("a.ts", many)!.split("\n")
  assert.equal(lines.length, 1 + MAX_PROBLEMS + 1)
  assert.equal(lines.at(-1), "… and 7 more")
  assert.match(lines[0]!, /57 errors$/u)
})

test("counts name only what there is", () => {
  assert.equal(countsPhrase({ errors: 1, warnings: 0, infos: 2 }), "1 error, 2 infos")
  assert.equal(countsPhrase({ errors: 0, warnings: 3, infos: 0 }), "3 warnings")
})

test("terminal output is text: colours, titles and shell integration's marks gone, a redrawn line as last drawn", () => {
  const raw = "\u001b]633;C\u0007\u001b[32mPASS\u001b[0m src/a.test.ts\r\n" +
    "\u001b]0;title\u001b\\progress 10%\rprogress 100%\r\n" +
    "typo\b\bpo!\r\n\u001b]633;D;1\u0007"
  assert.equal(plainTerminalText(raw), "PASS src/a.test.ts\nprogress 100%\ntypo!")
})

test("the last command reads as a terminal shows it, with how it exited", () => {
  assert.equal(terminalCommandText({ command: "nub run test", output: "\u001b[31m1 failing\u001b[0m\r\n", exitCode: 1 }), "$ nub run test\n1 failing\n(exit code 1)")
  assert.equal(terminalCommandText({ command: "ls", output: "" }), "$ ls")
  assert.equal(terminalCommandText({ command: "  ", output: "x" }), undefined)
})

test("a long output keeps its END, where a failure says what failed, and says what it left out", () => {
  const output = Array.from({ length: QUOTE_MAX_LINES * 2 }, (_, i) => `line ${i}`).join("\n")
  const text = terminalCommandText({ command: "build", output, exitCode: 2 })!
  const lines = text.split("\n")
  assert.equal(lines[0], "$ build")
  assert.match(lines[1]!, /^… \d+ earlier lines$/u)
  assert.equal(lines.at(-2), `line ${QUOTE_MAX_LINES * 2 - 1}`)
  assert.equal(lines.at(-1), "(exit code 2)")
  assert.ok(lines.length <= QUOTE_MAX_LINES)
  // Wide lines: the byte cap binds before the line cap does.
  const wide = Array.from({ length: 300 }, (_, i) => `${i} ${"x".repeat(400)}`).join("\n")
  const fitted = terminalCommandText({ command: "dump", output: wide })!
  assert.ok(Buffer.byteLength(fitted, "utf8") <= QUOTE_MAX_BYTES)
  assert.ok(fitted.endsWith(`299 ${"x".repeat(400)}`))
})

test("the menu is told counts and a one-line command, and only what there is to offer", () => {
  assert.deepEqual(extrasMessage({}), { type: "ntwine:editor-extras" })
  assert.deepEqual(extrasMessage({ problems: { label: "a.ts", counts: { errors: 0, warnings: 0, infos: 0 } } }), { type: "ntwine:editor-extras" })
  assert.deepEqual(
    extrasMessage({ problems: { label: "a.ts", counts: { errors: 2, warnings: 0, infos: 1 } }, terminal: { command: "nub run\n  test", exitCode: 0 } }),
    { type: "ntwine:editor-extras", problems: { label: "a.ts", errors: 2, warnings: 0, infos: 1 }, terminal: { command: "nub run test", exitCode: 0 } },
  )
  // VS Code before 1.93: a terminal is open, its commands unknown.
  assert.deepEqual(extrasMessage({ terminal: {} }), { type: "ntwine:editor-extras", terminal: {} })
  assert.equal(extrasMessage({ terminal: { command: "x".repeat(1000) } }).terminal!.command!.length, EMBED_MAX_COMMAND)
})

test("shell integration's command events are used from VS Code 1.93 on; before, they are a proposal that throws", async () => {
  const { hasShellExecutions } = await import("./extras-feed.ts")
  assert.equal(hasShellExecutions("1.90.0"), false)
  assert.equal(hasShellExecutions("1.92.2"), false)
  assert.equal(hasShellExecutions("1.93.0"), true)
  assert.equal(hasShellExecutions("1.140.0-insider"), true)
  assert.equal(hasShellExecutions("2.0.0"), true)
})
