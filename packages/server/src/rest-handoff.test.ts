import { test } from "node:test"
import assert from "node:assert/strict"
import type { TranscriptMessage } from "@ntwine/shared"
import { describeHandoff } from "./periodic-status.ts"
import { restHandoff } from "./rest-handoff.ts"

const storage = { listThreadQuestions: () => [], getThreadDone: () => undefined }
const reply = (text: string): TranscriptMessage[] => [
  { role: "user", text: "go", tools: [], parts: [], at: "2026-11-18T19:00:00Z" } as unknown as TranscriptMessage,
  { role: "assistant", text, tools: [], parts: [] } as unknown as TranscriptMessage,
]
const report = "The second core failure is fixed locally as e415905a8, not pushed. Two speed tests assert compiled code and the jitless pass runs with compilation off; their titles now carry the excluded phrase. CI stays red until the size work lands, which I'll ask about then."

test("a write-up beside a park on running work is a report: the items' status, flagged, never 'needs you'", () => {
  const h = restHandoff(storage as never, "t", reply(`${report}\n\n\`\`\`awaiting\nagents: [a1]\nprs: [acme/app#1]\n\`\`\``))
  assert.deepEqual(h.signoff, { kind: "awaiting", status: "watching", waitsOn: ["agent a1", "pr acme/app#1"], steps: [], writeUp: true })
  const told = describeHandoff(h)
  assert.match(told, /status watching: it is waiting on something outside the thread \(a review, a release, a reply\)\./)
  assert.match(told, /write-up is a report, not by itself a request/)
  assert.doesNotMatch(told, /review or act on now|NOT needed\./)
})

test("prose under the fence's --- still tells the writer the developer is needed", () => {
  const h = restHandoff(storage as never, "t", reply(`${report}\n\n\`\`\`awaiting\nagents: [a1]\n---\nTry the dev server now.\n\`\`\``))
  assert.equal(h.signoff?.kind === "awaiting" && h.signoff.status, "needs_input")
  assert.equal(h.signoff?.kind === "awaiting" && h.signoff.writeUp, undefined)
  assert.match(describeHandoff(h), /review or act on now/)
})
