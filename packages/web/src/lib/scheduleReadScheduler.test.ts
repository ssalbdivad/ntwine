// When the prompt box asks the model whether its words are a schedule (scheduleReadScheduler.ts): at the end of a
// word or after 500ms of rest, whichever comes first — never per keystroke, never for words with no schedule word.
import assert from "node:assert/strict"
import test from "node:test"
import { hasScheduleTrigger } from "@ntwine/shared"
import { READ_IDLE_MS, classifyEdit, createReadScheduler } from "./scheduleReadScheduler.ts"

/** A scheduler on a hand-driven clock, recording what it asked for and what it cancelled. */
function harness() {
  const asked: string[] = []
  let cancelled = 0
  let clock = 0
  const timers: { at: number; run: () => void; id: number }[] = []
  let ids = 0
  const scheduler = createReadScheduler({
    request: (text) => asked.push(text),
    cancel: () => { cancelled++ },
    wanted: (text) => text.trim() !== "" && hasScheduleTrigger(text),
    timers: {
      set: (run, ms) => {
        const id = ++ids
        timers.push({ at: clock + ms, run, id })
        return id
      },
      clear: (handle) => {
        const at = timers.findIndex((t) => t.id === handle)
        if (at >= 0) timers.splice(at, 1)
      },
    },
  })
  const advance = (ms: number) => {
    clock += ms
    for (const t of [...timers].sort((a, b) => a.at - b.at)) {
      if (t.at > clock) continue
      timers.splice(timers.indexOf(t), 1)
      t.run()
    }
  }
  /** Type `text` one key at a time onto `from`, `gap` ms apart, as the box reports it. */
  const type = (from: string, text: string, gap = 60) => {
    let before = from
    for (const ch of text) {
      const after = before + ch
      scheduler.changed(after, classifyEdit(before, after, after.length, "insertText"))
      before = after
      advance(gap)
    }
    return before
  }
  return { scheduler, asked, cancelled: () => cancelled, advance, type, pending: () => timers.length }
}

test("a word's end asks at once; keys inside a word ask nothing until the typing rests", () => {
  const h = harness()
  h.type("", "every Mon")
  // "every " ended a word with a schedule word in it: asked once, at the space.
  assert.deepEqual(h.asked, ["every "])
  h.advance(READ_IDLE_MS - 61)
  assert.deepEqual(h.asked, ["every "], "mid-word, inside the idle: nothing more")
  h.advance(1)
  assert.deepEqual(h.asked, ["every ", "every Mon"], "the idle asked about the text as it stands")
})

test("punctuation and a newline end a word; a colon inside a clock does not", () => {
  for (const [from, key] of [["every Monday", ","], ["every Monday", "."], ["every Monday", "\n"], ["every Monday", "?"]] as const) {
    assert.equal(classifyEdit(from, from + key, from.length + 1), "boundary", JSON.stringify(key))
  }
  assert.equal(classifyEdit("every day at 10", "every day at 10:", 16), "midword", "10: is a clock being typed")
  assert.equal(classifyEdit("every day at", "every day at:", 13), "boundary")
  assert.equal(classifyEdit("every Monda", "every Monday", 12), "midword")
})

test("a paste, an undo, a cut or a multi-character change is wholesale and asks at once", () => {
  assert.equal(classifyEdit("", "every Monday at 9am triage", 26, "insertFromPaste"), "wholesale")
  assert.equal(classifyEdit("every Monday x", "every Monday", 12, "historyUndo"), "wholesale")
  assert.equal(classifyEdit("every Monday at 9", "every Monday", 12), "wholesale", "two characters gone at once")
  assert.equal(classifyEdit("every Mxnday", "every Monday", 7), "wholesale", "a replaced character")
  const h = harness()
  h.scheduler.changed("every Monday at 9am triage", "wholesale")
  assert.deepEqual(h.asked, ["every Monday at 9am triage"])
})

test("words with no schedule word are never asked about, and drop the read queued behind the one out", () => {
  const h = harness()
  h.type("", "fix the bug ")
  h.advance(READ_IDLE_MS * 2)
  assert.deepEqual(h.asked, [], "no trigger: no read, at the boundary or the idle")
  h.scheduler.changed("fix the bug every", "midword")
  h.advance(READ_IDLE_MS)
  assert.deepEqual(h.asked, ["fix the bug every"])
  const before = h.cancelled()
  h.scheduler.changed("fix the bug ever", "midword")
  assert.equal(h.cancelled(), before + 1, "the trigger went: whatever was queued for it is dropped")
  h.advance(READ_IDLE_MS)
  assert.deepEqual(h.asked, ["fix the bug every"], "and nothing is asked")
})

test("an IME's composition is not text yet; another box's change waits for the idle", () => {
  const h = harness()
  h.scheduler.changed("every Monday ", "composing")
  h.advance(READ_IDLE_MS * 2)
  assert.deepEqual(h.asked, [], "composing: nothing, not even at the idle")
  h.scheduler.changed("every Monday ", "external")
  assert.deepEqual(h.asked, [], "a change this box did not make never asks at once")
  h.advance(READ_IDLE_MS)
  assert.deepEqual(h.asked, ["every Monday "])
})

test("each change re-arms the idle; dispose stops it", () => {
  const h = harness()
  h.scheduler.changed("every Mo", "midword")
  h.advance(READ_IDLE_MS - 1)
  h.scheduler.changed("every Mon", "midword")
  h.advance(READ_IDLE_MS - 1)
  assert.deepEqual(h.asked, [], "the rest is measured from the LAST key")
  h.advance(1)
  assert.deepEqual(h.asked, ["every Mon"])
  h.scheduler.changed("every Mond", "midword")
  h.scheduler.dispose()
  h.advance(READ_IDLE_MS * 2)
  assert.deepEqual(h.asked, ["every Mon"], "nothing after dispose")
  assert.equal(h.pending(), 0)
})

test("typing a whole prompt at speed asks once per finished word with a schedule word, not once per key", () => {
  const h = harness()
  const text = "every Monday at 9am triage new issues"
  h.type("", text, 40)
  h.advance(READ_IDLE_MS)
  // One per space (6 of them) and the idle at the end — never one of the 37 keys inside a word.
  assert.equal(h.asked.length, 7, h.asked.join(" | "))
  assert.ok(h.asked.every((t) => /\s$/.test(t) || t === text), h.asked.join(" | "))
})
