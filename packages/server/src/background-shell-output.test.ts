import assert from "node:assert/strict"
import { appendFileSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { backgroundShellLineCount, readBackgroundShellOutput, resetBackgroundShellLineCounts, vetHarnessOutputPath } from "./background-shell-output.ts"

test("background shell output reads a bounded, presentation-safe tail", () => {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-shell-output-"))
  try {
    const path = join(dir, "task.output")
    // 37 bytes; the window is the last 24, which hold no line break — one long overprinted line is kept
    // whole rather than dropped.
    writeFileSync(path, `discard-me\n12345\u001b[31mred\u001b[0m\rprogress`)
    assert.deepEqual(readBackgroundShellOutput(path, { maxBytes: 24 }), {
      output: "345red\nprogress",
      truncated: true,
      end: 37,
      reset: false,
      more: false,
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("background shell output degrades safely when the task file is unavailable", () => {
  assert.deepEqual(readBackgroundShellOutput("/definitely/missing/ntwine-shell-output"), { output: "", truncated: false, reset: false, more: false }, "no cursor: the next read is a first read again")
  // A caller mid-stream keeps its cursor, so a vanished log never sends it back to byte 0.
  assert.equal(readBackgroundShellOutput("/definitely/missing/ntwine-shell-output", { from: 4096 }).end, 4096)
})

// ── READING BY OFFSET — the agent-terminal drawer's poll ──────────────────────────────────────────

function withShellFile(run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-shell-delta-"))
  try {
    run(join(dir, "task.output"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("a delta read returns only what arrived since `from`, and `end` is where the next one starts", () => {
  withShellFile((path) => {
    writeFileSync(path, "one\ntwo\n")
    const first = readBackgroundShellOutput(path)
    assert.deepEqual(first, { output: "one\ntwo\n", truncated: false, end: 8, reset: false, more: false })
    appendFileSync(path, "three\n")
    assert.deepEqual(readBackgroundShellOutput(path, { from: first.end }), { output: "three\n", truncated: false, end: 14, reset: false, more: false })
    assert.deepEqual(readBackgroundShellOutput(path, { from: 14 }), { output: "", truncated: false, end: 14, reset: false, more: false }, "nothing new is an empty read, not a re-send")
  })
})

test("a file SHORTER than `from` was truncated or replaced: the read says reset and starts over", () => {
  withShellFile((path) => {
    writeFileSync(path, "a long first run of output\n")
    const before = readBackgroundShellOutput(path)
    writeFileSync(path, "fresh\n")
    assert.deepEqual(readBackgroundShellOutput(path, { from: before.end }), { output: "fresh\n", truncated: false, end: 6, reset: true, more: false })
  })
})

test("a delta read stops at its cap with `more`, and the next one picks up exactly there", () => {
  withShellFile((path) => {
    writeFileSync(path, "0123456789abcdef")
    const a = readBackgroundShellOutput(path, { from: 0, deltaBytes: 10 })
    assert.deepEqual(a, { output: "0123456789", truncated: false, end: 10, reset: false, more: true })
    const b = readBackgroundShellOutput(path, { from: a.end, deltaBytes: 10 })
    assert.deepEqual(b, { output: "abcdef", truncated: false, end: 16, reset: false, more: false })
  })
})

test("raw keeps colour and the bare \\r a terminal redraws with; the default still strips both", () => {
  withShellFile((path) => {
    writeFileSync(path, "\u001b[32mtick\u001b[0m 1\r10%\r20%\n")
    assert.equal(readBackgroundShellOutput(path, { raw: true }).output, "\u001b[32mtick\u001b[0m 1\r10%\r20%\n")
    assert.equal(readBackgroundShellOutput(path).output, "tick 1\n10%\n20%\n")
  })
})

test("a first read that starts mid-file opens after the first line break, never mid-line", () => {
  withShellFile((path) => {
    writeFileSync(path, "line one is long\nline two\nline three\n")
    // The window's last 24 bytes begin at "ong\n" — the tail of line one — which is dropped.
    assert.deepEqual(readBackgroundShellOutput(path, { maxBytes: 24 }), { output: "line two\nline three\n", truncated: true, end: 37, reset: false, more: false })
  })
})

test("`end` never splits a multi-byte character — the rest is read next time", () => {
  withShellFile((path) => {
    const e = Buffer.from("é") // 2 bytes
    const smile = Buffer.from("🙂") // 4 bytes
    writeFileSync(path, Buffer.concat([Buffer.from("a"), e.subarray(0, 1)]))
    const first = readBackgroundShellOutput(path, { from: 0 })
    assert.deepEqual(first, { output: "a", truncated: false, end: 1, reset: false, more: false }, "half an é is held back")
    appendFileSync(path, Buffer.concat([e.subarray(1), smile.subarray(0, 3)]))
    const second = readBackgroundShellOutput(path, { from: first.end })
    assert.deepEqual(second, { output: "é", truncated: false, end: 3, reset: false, more: false }, "three quarters of 🙂 are held back")
    appendFileSync(path, smile.subarray(3))
    assert.equal(readBackgroundShellOutput(path, { from: second.end }).output, "🙂")
    // A delta CAP landing mid-character backs off the same way.
    writeFileSync(path, Buffer.concat([Buffer.from("ab"), smile]))
    assert.deepEqual(readBackgroundShellOutput(path, { from: 0, deltaBytes: 4 }), { output: "ab", truncated: false, end: 2, reset: false, more: true })
  })
})

// ── THE LIVE COUNTER on a shell row ──────────────────────────────────────────────────────────────

function withOutputFile(run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ntwine-shell-lines-"))
  resetBackgroundShellLineCounts()
  try {
    run(join(dir, "task.output"))
  } finally {
    resetBackgroundShellLineCounts()
    rmSync(dir, { recursive: true, force: true })
  }
}

test("the line counter counts what the drawer shows — terminators, a trailing partial line, and bare \\r", () => {
  withOutputFile((path) => {
    writeFileSync(path, "")
    assert.equal(backgroundShellLineCount(path), 0, "a shell that has printed nothing reads as 0, not as absent")
    writeFileSync(path, "one\n")
    resetBackgroundShellLineCounts()
    assert.equal(backgroundShellLineCount(path), 1)
    writeFileSync(path, "one\ntwo")
    resetBackgroundShellLineCounts()
    assert.equal(backgroundShellLineCount(path), 2, "output ending mid-line still shows that line")
    // readBackgroundShellOutput rewrites a bare \r to \n, so an overprinting progress bar renders as
    // several lines in the drawer — the counter beside it has to agree.
    writeFileSync(path, "10%\r20%\r30%")
    resetBackgroundShellLineCounts()
    assert.equal(backgroundShellLineCount(path), 3)
    writeFileSync(path, "a\r\nb\r\n")
    resetBackgroundShellLineCounts()
    assert.equal(backgroundShellLineCount(path), 2, "CRLF is ONE break, not two")
  })
})

test("the line counter advances incrementally as a live shell appends", () => {
  withOutputFile((path) => {
    writeFileSync(path, "first\nsecond\n")
    assert.equal(backgroundShellLineCount(path), 2)
    appendFileSync(path, "third\n")
    assert.equal(backgroundShellLineCount(path), 3, "the second call must read only the delta and still total correctly")
    assert.equal(backgroundShellLineCount(path), 3, "a poll with no new bytes re-reports the same total")
    appendFileSync(path, "partial")
    assert.equal(backgroundShellLineCount(path), 4)
    appendFileSync(path, " more\n")
    assert.equal(backgroundShellLineCount(path), 4, "finishing the partial line does not add a second one")
  })
})

// The delta boundary landing between the \r and the \n of one CRLF is the one way an incremental
// counter double-counts, and it needs two separate appends to reproduce at all.
test("the line counter does not double-count a CRLF split across two polls", () => {
  withOutputFile((path) => {
    writeFileSync(path, "alpha\r")
    assert.equal(backgroundShellLineCount(path), 1)
    appendFileSync(path, "\nbeta\r")
    assert.equal(backgroundShellLineCount(path), 2, "the \\n closing a counted \\r is not a break of its own")
    appendFileSync(path, "\ngamma")
    assert.equal(backgroundShellLineCount(path), 3)
  })
})

test("the line counter recovers when the output file is truncated or rotated under it", () => {
  withOutputFile((path) => {
    writeFileSync(path, "one\ntwo\nthree\n")
    assert.equal(backgroundShellLineCount(path), 3)
    writeFileSync(path, "fresh\n")
    assert.equal(backgroundShellLineCount(path), 1, "a shrunk file is re-counted rather than reported off the stale total")
  })
})

// The rotation a size check alone cannot see: the replacement file is LARGER than what it replaced.
test("the line counter re-counts when a LARGER file replaces the one at that path", () => {
  withOutputFile((path) => {
    writeFileSync(path, "one\ntwo\n")
    assert.equal(backgroundShellLineCount(path), 2)
    rmSync(path)
    writeFileSync(path, "a\nb\nc\nd\ne\n")
    assert.equal(backgroundShellLineCount(path), 5, "a new inode at the same path is a new file, whatever its size")
  })
})

test("the line counter reports nothing — never zero — for a file it cannot read", () => {
  assert.equal(backgroundShellLineCount("/definitely/missing/ntwine-shell-output"), undefined)
})

// ── THE HARNESS-PATH GUARD ────────────────────────────────────────────────────────────────────────
// The path a shell's output is read from comes out of an ACK — text in a tool_result — and one ack shape
// is the output of a FOREGROUND command, so its path is whatever that command printed. Only the harness's
// own task-log shape may be opened.

test("vetHarnessOutputPath: only a real file shaped tasks/<taskId>.output passes", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ntwine-vet-")))
  try {
    const tasks = join(root, "claude-1000", "-proj", "sid", "tasks")
    mkdirSync(tasks, { recursive: true })
    const good = join(tasks, "b1.output")
    writeFileSync(good, "tick 1\n")
    assert.equal(vetHarnessOutputPath(good, "b1"), good)
    // No task id known yet (a Monitor's derived path, an ack that named no id): the shape alone decides.
    assert.equal(vetHarnessOutputPath(good, undefined), good)

    assert.equal(vetHarnessOutputPath("/etc/passwd", undefined), undefined, "an arbitrary file is refused")
    // A symlink in the right place is judged by what it POINTS AT.
    const secret = join(root, "id_rsa")
    writeFileSync(secret, "PRIVATE KEY")
    const link = join(tasks, "b9.output")
    symlinkSync(secret, link)
    assert.equal(vetHarnessOutputPath(link, "b9"), undefined, "a tasks/ symlink to a secret resolves to the secret and fails")
    symlinkSync("/etc/passwd", join(tasks, "b8.output"))
    assert.equal(vetHarnessOutputPath(join(tasks, "b8.output"), "b8"), undefined)
    // A directory with the right name is not a log.
    mkdirSync(join(tasks, "b2.output"))
    assert.equal(vetHarnessOutputPath(join(tasks, "b2.output"), "b2"), undefined)
    // The right shape, the wrong task: never another shell's log.
    const other = join(tasks, "b3.output")
    writeFileSync(other, "x")
    assert.equal(vetHarnessOutputPath(other, "b1"), undefined)
    // `..` resolves before the shape check: `tasks/../x.output` is not in `tasks`.
    writeFileSync(join(tasks, "..", "x.output"), "x")
    assert.equal(vetHarnessOutputPath(join(tasks, "..", "x.output"), "x"), undefined)
    // A name outside the harness's id alphabet.
    writeFileSync(join(tasks, "a b.output"), "x")
    assert.equal(vetHarnessOutputPath(join(tasks, "a b.output"), undefined), undefined)
    // Missing entirely.
    assert.equal(vetHarnessOutputPath(join(tasks, "gone.output"), "gone"), undefined)
    // A second hard link: the right shape here, another file's bytes. Realpath cannot see through it, so a
    // log with more than one name is refused — the harness never links its own.
    const elsewhere = join(root, "claude-1000", "-other", "their-sid", "tasks")
    mkdirSync(elsewhere, { recursive: true })
    writeFileSync(join(elsewhere, "b4.output"), "theirs")
    linkSync(join(elsewhere, "b4.output"), join(tasks, "b4.output"))
    assert.equal(vetHarnessOutputPath(join(tasks, "b4.output"), "b4"), undefined)
    assert.equal(vetHarnessOutputPath(join(elsewhere, "b4.output"), "b4"), undefined, "…under either name")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
