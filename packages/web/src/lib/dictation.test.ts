import assert from "node:assert/strict"
import test from "node:test"
import { joinSegments, languageCandidates, spliceDictation } from "./dictation.ts"

// The on-device engine capitalizes the first word of every segment after a pause, and never
// punctuates (measured in Chrome 155 — lib/dictation.ts). A segment after the first is a continuation.
test("segments join as one sentence, with the engine's capitals after a pause taken back", () => {
  assert.equal(joinSegments(["Check the queue card", " Then commit to main ", "Run the type check"]), "Check the queue card then commit to main run the type check")
  assert.equal(joinSegments(["open it", " I think it's fine", " PR checks are green"]), "open it I think it's fine PR checks are green")
  assert.equal(joinSegments(["", "  ", "Hello"]), "Hello")
})

test("spoken text lands at the caret, spaced and capitalized like typing", () => {
  // Empty box: a sentence start keeps a capital.
  assert.deepEqual(spliceDictation("", "fix the rail", ""), { text: "Fix the rail", caret: 12 })
  // Mid-sentence, no trailing space: one space before, and the engine's capital comes off.
  assert.deepEqual(spliceDictation("please", "Check the queue", ""), { text: "please check the queue", caret: 22 })
  // After a full stop, a capital; the text after the caret is spaced off.
  assert.deepEqual(spliceDictation("Done. ", "now ship it", "Thanks"), { text: "Done. Now ship it Thanks", caret: 17 })
  // After a newline, a capital, and no space is added.
  assert.equal(spliceDictation("line one\n", "next line", "").text, "line one\nNext line")
  // Acronyms and "I" keep their capitals mid-sentence.
  assert.equal(spliceDictation("and", "PR is green", "").text, "and PR is green")
  assert.equal(spliceDictation("and", "I'm done", "").text, "and I'm done")
  // Nothing spoken (yet): the draft is untouched and the caret stays put.
  assert.deepEqual(spliceDictation("ab", "", "cd"), { text: "abcd", caret: 2 })
})

test("English speakers whose locale has no pack fall back to en-US; nobody else does", () => {
  assert.deepEqual(languageCandidates(["en-GB", "en"]), ["en-GB", "en", "en-US"])
  assert.deepEqual(languageCandidates(["en-US", "en"]), ["en-US", "en"])
  assert.deepEqual(languageCandidates(["fr-FR", "fr"]), ["fr-FR", "fr"])
})
