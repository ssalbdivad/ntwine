// The prompt box's schedule (ScheduleComposer.tsx), its pure pieces: the vetting that turns a reading the box
// cannot show or save into a refusal, the "Each run" line cut from the words on screen, the created toast's detail,
// and the copy — which says what the human can do, and on a phone names the send button, never a key. The box
// itself is driven in a real browser (composerScheduleLive.e2e.test.ts).
import assert from "node:assert/strict"
import test from "node:test"
import type { ScheduleView } from "@ntwine/shared"
import { CHECKING_COPY, UNDONE_COPY, eachRun, startsNow, toastDetail, vetter } from "./ScheduleComposer.tsx"
import { NO_TASK_COPY } from "../lib/scheduleIntent.ts"
import { UNPHRASABLE_COPY } from "./SchedulePreview.tsx"
import type { ModelReadOk } from "../lib/scheduleModelRead.ts"

const NY = "America/New_York"
const NOW = Date.parse("2026-10-05T14:32:00-04:00")

function ok(text: string, phrase: string, extra: Partial<ModelReadOk> = {}): ModelReadOk {
  const start = text.indexOf(phrase)
  return {
    ok: true, phrase, phraseStart: start, phraseEnd: start + phrase.length,
    prompt: text.slice(start + phrase.length).trim(), whenText: phrase,
    rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0", dtstart: "2026-10-12T09:00", tz: NY,
    title: "Triage issues", preview: { describe: "every Monday at 9am", echo: "", nextLine: "", upcoming: [] },
    ...extra,
  }
}
/** The box's `promptOf` with no chips and no attachments: the cut words, trimmed. */
const promptOf = (cut: string) => cut.trim()

test("vetting: a reading with nothing left to run, or a rule with no words for it, is a refusal", () => {
  const text = "every Monday at 9am triage new issues"
  assert.equal(vetter(text, text, promptOf)(ok(text, "every Monday at 9am")), undefined, "a schedule the box can show and save")
  const bare = "every Monday at 9am"
  assert.equal(vetter(bare, bare, promptOf)(ok(bare, bare)), NO_TASK_COPY, "the phrase is the whole text: nothing for each run to do")
  const raw = ok(text, "every Monday at 9am", { rrule: "FREQ=MONTHLY;BYDAY=MO;BYSETPOS=2,4;BYHOUR=9;BYMINUTE=0" })
  assert.equal(vetter(text, text, promptOf)(raw), UNPHRASABLE_COPY, "never ask the human to confirm RRULE text")
})

test("Each run: the first line of the words on screen with the phrase cut out — for a kept reading too", () => {
  const text = "every Monday at 9am triage new issues\nthen label them"
  const reading = ok(text, "every Monday at 9am")
  assert.equal(eachRun(text, text, reading, promptOf), "triage new issues")
  // The words moved on while the next read is out: the kept reading's phrase is found in them, and the task is
  // the CURRENT task, so the line keeps up with the typing.
  const typed = "Every Monday at 9am triage new issues and close dupes"
  assert.equal(eachRun(typed, text, reading, promptOf), "triage new issues and close dupes")
})

test("the created toast: the rule and its next run, in the house's duration grammar", () => {
  const view = {
    describe: "every Monday at 9am",
    upcoming: ["2026-10-12T13:00:00.000Z"],
    nextLine: "Next: Mon Oct 12 · Mon Oct 19 · Mon Oct 26",
  } as unknown as ScheduleView
  assert.equal(toastDetail(view, NOW), "Every Monday at 9am · next Mon Oct 12, in 6d")
  const soon = { ...view, upcoming: [new Date(NOW + 10 * 60_000).toISOString()] } as unknown as ScheduleView
  assert.equal(toastDetail(soon, NOW), "Every Monday at 9am · first run in 10m")
})

test("the copy says what the human can do; a phone names its send button, never a key", () => {
  assert.equal(CHECKING_COPY, "Checking for a schedule…")
  assert.equal(`${UNDONE_COPY} ${startsNow(false)}`, "Schedule undone. Enter starts it now.")
  assert.equal(startsNow(true), "Send starts it now.")
  for (const line of [CHECKING_COPY, UNDONE_COPY, startsNow(true)]) {
    assert.doesNotMatch(line, /Enter|Esc|Tab|⌘/, `${line}: no key on a phone`)
  }
})
