// LEGACY (legacy-frizz.ts; deleted with it). TEXT WRITTEN BEFORE THE RENAME: every recognizer that reads
// stored transcript text must read a message exactly as it reads today's, when the only difference is the
// product's name.
// Each case writes today's message with its real writer, respells it the way pre-rename code wrote it
// (frizzWording), and asserts the parser's verdict is identical — and that the respelling changed the
// text, so a case cannot pass by never exercising the old spelling.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  commandWatchCancelledWakeMessage,
  eitherBrand,
  frizzWording,
  humanGapNote,
  isInjectedNoise,
  isWakeDelivery,
  limitModelSwitchSteer,
  mergedWakeMessage,
  parseCommandWatchWake,
  parseLimitModelSwitchWake,
  parseMergedWake,
  parseRecurringPrompt,
  parseThreadMessage,
  signoffNudgeMessage,
  stripHumanGapNote,
  stripWakeDeliveryToken,
  threadMessageBody,
  wakeDeliveryToken,
} from "./index.ts"

const now = Date.parse("2026-10-13T12:00:00Z")
const gap = humanGapNote(now, "2026-10-13T08:00:00Z")!

const cases: { name: string; text: string; read: (text: string) => unknown }[] = [
  { name: "wake delivery token", text: `Wake up.\n\n${wakeDeliveryToken("w_1")}`, read: (t) => [isWakeDelivery(t), stripWakeDeliveryToken(t)] },
  { name: "limit model switch", text: limitModelSwitchSteer("5h", "sonnet"), read: parseLimitModelSwitchWake },
  { name: "command watch cancelled", text: commandWatchCancelledWakeMessage({ id: "cmw_ab12", command: "npm test", reason: "gone" }), read: parseCommandWatchWake },
  { name: "message from another thread", text: threadMessageBody({ fromHandle: "port-the-parser", message: "Keys are normalized.", awaitsReply: true }), read: parseThreadMessage },
  { name: "merged wake", text: mergedWakeMessage([{ reason: "Timer", message: "First." }, { reason: "Goal", message: "Second." }], now), read: parseMergedWake },
  { name: "sign-off nudge", text: signoffNudgeMessage(), read: parseRecurringPrompt },
  { name: "human gap note", text: `Carry on.${gap}`, read: stripHumanGapNote },
  { name: "injected notice", text: "[ntwine] Your previous turn was interrupted.", read: isInjectedNoise },
]

for (const { name, text, read } of cases) {
  test(`${name}: the pre-rename spelling reads as today's`, () => {
    const old = frizzWording(text)
    assert.notEqual(old, text, "the case must carry the product's name")
    const verdict = read(text)
    assert.ok(verdict !== undefined && verdict !== null && verdict !== false, "today's text must be recognized")
    assert.deepEqual(read(old), typeof verdict === "string" ? frizzWording(verdict) : verdict)
  })
}

test("eitherBrand widens only the product's name, in each of its casings", () => {
  const re = eitherBrand(/^Ntwine said `ntwinectl` to NTWINE_THREAD$/)
  assert.equal(re.source, "^(?:Ntwine|Frizz) said `(?:ntwine|frizz)ctl` to (?:NTWINE|FRIZZ)_THREAD$")
  assert.ok(re.test("Frizz said `frizzctl` to FRIZZ_THREAD"))
  assert.ok(!re.test("Frizz said `ntwinectl` to SOMETHING_THREAD"))
})
