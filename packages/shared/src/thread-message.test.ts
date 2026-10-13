// A MESSAGE FROM ANOTHER THREAD: the text the scheduler delivers, and the chat's reading of it back into
// sender, body and wait state — without the instructions the recipient worker reads.
import { test } from "node:test"
import assert from "node:assert/strict"
import { parseThreadMessage, threadMessageBody } from "./index.ts"

test("round-trips sender, body and wait state, dropping the worker's instructions", () => {
  const message = "Keys are normalized.\n\n---\n\nA rule the sender wrote stays in the body."
  for (const awaitsReply of [false, true]) {
    for (const answersWait of [false, true]) {
      const parsed = parseThreadMessage(threadMessageBody({ fromHandle: "port-the-parser", message, awaitsReply, answersWait }))
      assert.deepEqual(parsed, { from: "port-the-parser", answersWait, awaitsReply, body: message })
    }
  }
})

test("names the sender's project when it is another one", () => {
  const parsed = parseThreadMessage(threadMessageBody({ fromHandle: "nub-ci", message: "Green.", fromProject: "nub" }))
  assert.equal(parsed?.project, "nub")
})

test("leaves anything else alone", () => {
  assert.equal(parseThreadMessage("Message from @x about something:\n\nhi"), undefined)
  assert.equal(parseThreadMessage("quoting: Message from @x, another Ntwine thread in this project:\n\nhi"), undefined)
})
