import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { KEEP_WORKING_MESSAGE, RESTART_WORKER_MESSAGE, RETRY_MESSAGE, STEPS_DONE_MESSAGE, type TranscriptMessage } from "@ntwine/shared"
import { CardActionMarker } from "./CardActionMarker.tsx"
import { cardActionOf } from "../lib/cardActions.ts"

// A BUTTON'S SEND is drawn as the human's one-line marker, never as a bubble of the worker's words.
// ChatView's Message cannot load under node (it pulls in CSS), so its branch is pinned at the predicate it
// calls and the marker it returns.

const user = (over: Partial<TranscriptMessage>): TranscriptMessage => ({ role: "user", text: "", tools: [], parts: [], ...over })
const words = (html: string) => html.replace(/<[^>]+>/g, "")

test("each button's send is read as its card action, served or optimistic", () => {
  // The server's tags.
  assert.equal(cardActionOf(user({ text: KEEP_WORKING_MESSAGE, keepWorking: true })), "keep-working")
  assert.equal(cardActionOf(user({ text: STEPS_DONE_MESSAGE, cardAction: "steps-done" })), "steps-done")
  // An optimistic copy carries only the raw text.
  assert.equal(cardActionOf(user({ text: STEPS_DONE_MESSAGE, queued: true })), "steps-done")
  assert.equal(cardActionOf(user({ text: RETRY_MESSAGE })), "retry")
  assert.equal(cardActionOf(user({ text: RESTART_WORKER_MESSAGE })), "restart-worker")
  // A typed "Done", and the envelope pasted inside a message of the human's own, are just their message.
  assert.equal(cardActionOf(user({ text: "Done" })), undefined)
  assert.equal(cardActionOf(user({ text: `what is this?\n${STEPS_DONE_MESSAGE}` })), undefined)
})

test("the marker says what the human did, in fixed words", () => {
  const marker = (kind: Parameters<typeof CardActionMarker>[0]["kind"]) => words(renderToStaticMarkup(createElement(CardActionMarker, { kind })))
  assert.deepEqual(
    [marker("keep-working"), marker("steps-done"), marker("retry"), marker("restart-worker")],
    ["Told it to continue", "Marked the steps done", "Retried", "Restarted the agent"],
  )
  assert.match(renderToStaticMarkup(createElement(CardActionMarker, { kind: "steps-done", dimmed: true })), /opacity-50/)
})
