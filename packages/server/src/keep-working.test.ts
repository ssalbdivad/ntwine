import { test } from "node:test"
import assert from "node:assert/strict"
import { KEEP_WORKING_MESSAGE, RETRY_MESSAGE, STEPS_DONE_MESSAGE, type TranscriptMessage } from "@ntwine/shared"
import { parseTranscript } from "./transcript.ts"
import { projectAcpTranscript } from "./backend/acp-transcript.ts"
import { projectDeliveryLedger } from "./delivery-ledger.ts"
import { handoffOf } from "./router.ts"

// THE HUMAN'S KEEP WORKING (shared KEEP_WORKING_MESSAGE) is tagged on every route a user turn reaches the
// chat by, so the browser draws their marker instead of a bubble of worker-facing words, and the readers
// that look for what the human last asked skip it.

const AT = "2026-10-14T12:00:00.000Z"
const userRecord = (content: string) => JSON.stringify({ type: "user", timestamp: AT, message: { role: "user", content } })
const enqueueRecord = (content: string) => JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: AT, content })
const assistantText = (text: string) => JSON.stringify({ type: "assistant", timestamp: AT, message: { id: "m1", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] } })

test("Claude: the send is tagged under both record shapes, and the envelope pasted inside a message is not", () => {
  for (const record of [userRecord(KEEP_WORKING_MESSAGE), enqueueRecord(KEEP_WORKING_MESSAGE)]) {
    const users = parseTranscript([userRecord("Add the login flow"), assistantText("Try it on :5173."), record].join("\n")).filter((m) => m.role === "user")
    assert.equal(users.at(-1)!.keepWorking, true)
    assert.equal(users.at(-1)!.text, KEEP_WORKING_MESSAGE, "the stored text is never narrowed")
    assert.equal(users[0].keepWorking, undefined)
  }
  const pasted = parseTranscript([userRecord("Add the login flow"), assistantText("ok"), userRecord(`what does this do?\n${KEEP_WORKING_MESSAGE}`)].join("\n"))
  assert.equal(pasted.at(-1)!.keepWorking, undefined)
})

test("ACP: the send is tagged, and a synthetic record carrying the same words is not the human's", () => {
  const users = projectAcpTranscript([
    { kind: "user-message", at: AT, text: "Add the login flow", synthetic: false },
    { kind: "user-message", at: AT, text: KEEP_WORKING_MESSAGE, synthetic: false },
    { kind: "user-message", at: AT, text: KEEP_WORKING_MESSAGE, synthetic: true },
  ].map((r) => JSON.stringify(r)).join("\n")).filter((m) => m.role === "user")
  assert.deepEqual(users.map((m) => m.keepWorking), [undefined, true, undefined])
})

// A send the transcript has not recorded yet is drawn from the delivery ledger, and must be the marker
// there too, not a bubble that turns into one when the record lands.
test("a send still on the wire is tagged as the record it will become", () => {
  const item = { id: "d1", text: KEEP_WORKING_MESSAGE, at: AT, updatedAt: AT, state: "sending" as const }
  const [projected] = projectDeliveryLedger([], [item as Parameters<typeof projectDeliveryLedger>[1][number]])
  assert.equal(projected.keepWorking, true)
  assert.equal(projected.queued, true)
})

// The click only sends the worker back to its wait, so the handoff it queues with once the work is done
// answers the ask before it. Quoting the click there would put "keep working" over a finished result.
test("the queue card quotes the ask before a Keep working, over the handoff that follows it", () => {
  const msg = (role: "user" | "assistant", text: string, extra: Partial<TranscriptMessage> = {}) => ({ role, text, tools: [], parts: [], at: AT, ...extra }) as TranscriptMessage
  const handoff = handoffOf([
    msg("user", "Add the login flow"),
    msg("assistant", "Try it on :5173.\n\n```awaiting\nshells: [b1]\nstatus: needs_input\n```"),
    msg("user", KEEP_WORKING_MESSAGE, { keepWorking: true }),
    msg("assistant", "```awaiting\nshells: [b1]\nstatus: working\n```"),
    msg("assistant", "**Done** — the e2e suite is green."),
  ])
  assert.equal(handoff.asked, "Add the login flow")
  assert.equal(handoff.text, "**Done** — the e2e suite is green.")
})

// Every other button's send (shared parseCardAction) rides the same projection, and unlike Keep working it
// IS the human's turn: the reply under a Done answers the Done, so the queue card opens at it and draws it
// as the marker (web CardActionMarker) off the envelope it quotes.
test("a steps Done or a Retry is tagged as its card action and quoted as the human's turn", () => {
  const users = parseTranscript([userRecord("Publish it"), assistantText("Approve the npm sign-in."), userRecord(STEPS_DONE_MESSAGE), assistantText("Published."), userRecord(RETRY_MESSAGE)].join("\n")).filter((m) => m.role === "user")
  assert.deepEqual(users.map((m) => [m.cardAction, m.keepWorking]), [[undefined, undefined], ["steps-done", undefined], ["retry", undefined]])
  const keep = parseTranscript(userRecord(KEEP_WORKING_MESSAGE)).find((m) => m.role === "user")!
  assert.deepEqual([keep.cardAction, keep.keepWorking], ["keep-working", true])
  const msg = (role: "user" | "assistant", text: string, extra: Partial<TranscriptMessage> = {}) => ({ role, text, tools: [], parts: [], at: AT, ...extra }) as TranscriptMessage
  const handoff = handoffOf([msg("user", "Publish it"), msg("assistant", "Approve the npm sign-in."), msg("user", STEPS_DONE_MESSAGE, { cardAction: "steps-done" }), msg("assistant", "**Fixed** — published.")])
  assert.equal(handoff.asked, STEPS_DONE_MESSAGE)
})
