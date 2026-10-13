// The preview's pure half (SchedulePreview.tsx): what a model's rule will do, rebuilt from the rule and the clock —
// its words, its zone, its condition, its next runs — and what the drawer's Change when shows for the words in its
// field, with the last reading kept while new words are read and Save only on a reading of exactly those words.
// The rendered pixels are checked in a real browser, not here.
import assert from "node:assert/strict"
import test from "node:test"
import { SCHEDULE_NOT_FOUND_COPY, type InterpretScheduleResult } from "@ntwine/shared"
import { CHANGE_WHEN_BUDGET_COPY, CHANGE_WHEN_FAILED_COPY, UNPHRASABLE_COPY, changeWhenView, describeRule, schedulePreviewModel, unphrasableRule } from "./SchedulePreview.tsx"
import type { ModelReadOk } from "../lib/scheduleModelRead.ts"

const NY = "America/New_York"
const NOW = Date.parse("2026-10-05T14:32:00-04:00")
const WEEKLY = { rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0", dtstart: "2026-10-12T09:00" }

function answer(words: string, rrule = WEEKLY.rrule, dtstart = WEEKLY.dtstart): ModelReadOk {
  return {
    ok: true, phrase: words, phraseStart: 0, phraseEnd: words.length, prompt: "", whenText: words, rrule,
    dtstart, tz: NY, title: "Post digest", preview: { describe: "", echo: "", nextLine: "", upcoming: [] },
  }
}

test("the model: the rule's words, its zone suffix, the condition, and the next runs from the clock", () => {
  const m = schedulePreviewModel({ title: "Triage issues", ...WEEKLY, tz: NY, condition: "unless it's a holiday" }, NOW, NY)
  assert.ok(m.ok)
  if (!m.ok) return
  assert.equal(m.describe, "every Monday at 9am")
  assert.equal(m.zone, "")
  assert.deepEqual(m.tail, ["unless it's a holiday"])
  assert.deepEqual(m.next, ["Mon Oct 12", "Mon Oct 19", "Mon Oct 26"])
  assert.equal(m.firstAt, "2026-10-12T13:00:00.000Z")
  const away = schedulePreviewModel({ title: "Triage issues", ...WEEKLY, tz: NY }, NOW, "Europe/Berlin")
  assert.ok(away.ok && away.zone === " New York time")
  // A dense rule names its runs a day and puts times on its dates.
  const d = schedulePreviewModel({ title: "Check deploy", rrule: "FREQ=HOURLY;BYMINUTE=0,15,30,45", dtstart: "2026-10-05T14:45", tz: NY }, NOW, NY)
  assert.ok(d.ok)
  if (d.ok) {
    assert.deepEqual(d.tail, ["96 runs a day"])
    assert.equal(d.next[0], "Mon Oct 5, 2:45pm")
  }
})

test("the next runs move on with the clock, with no new read", () => {
  const before = schedulePreviewModel({ title: "Triage issues", ...WEEKLY, tz: NY }, NOW, NY)
  // A week and a day later, the same rule: the first run is the Monday after next.
  const later = schedulePreviewModel({ title: "Triage issues", ...WEEKLY, tz: NY }, NOW + 8 * 86_400_000, NY)
  assert.ok(before.ok && later.ok)
  if (before.ok && later.ok) {
    assert.equal(before.next[0], "Mon Oct 12")
    assert.equal(later.next[0], "Mon Oct 19")
  }
})

test("a rule checkSchedule refuses previews as its own words, with nothing to save", () => {
  const m = schedulePreviewModel({ title: "Triage", rrule: "FREQ=DAILY;UNTIL=20261001;BYHOUR=9;BYMINUTE=0", dtstart: "2026-09-01T09:00", tz: NY }, NOW, NY)
  assert.equal(m.ok, false)
  assert.match(!m.ok ? m.error : "", /never runs again/)
})

test("the human never confirms RRULE text: a rule the house cannot phrase is refused with copy", () => {
  const raw = "FREQ=MONTHLY;BYDAY=MO;BYSETPOS=2,4;BYHOUR=9;BYMINUTE=0"
  assert.equal(unphrasableRule(raw, "2026-10-12T09:00", NY), true, "the house's words for it would be `on the rule FREQ=…`")
  assert.equal(unphrasableRule("FREQ=MONTHLY;BYDAY=2MO;BYHOUR=9;BYMINUTE=0", "2026-10-12T09:00", NY), false)
  assert.equal(describeRule(WEEKLY.rrule, WEEKLY.dtstart, NY), "every Monday at 9am")
  assert.deepEqual(changeWhenView({ view: { status: "answered", result: answer("the second and fourth Monday", raw) }, stale: undefined }), { kind: "copy", copy: UNPHRASABLE_COPY })
})

test("Change when: the field's own answer, a refusal said as copy, a failure and a spent budget", () => {
  const words = "every Monday at 9am"
  assert.deepEqual(changeWhenView({ view: { status: "answered", result: answer(words) }, stale: undefined }), { kind: "model", result: answer(words), fresh: true })
  // The field means nothing but WHEN, so "couldn't find a schedule" is the answer to show, not a reason to keep quiet.
  assert.deepEqual(changeWhenView({ view: { status: "answered", result: { ok: false, error: SCHEDULE_NOT_FOUND_COPY } }, stale: undefined }), { kind: "copy", copy: SCHEDULE_NOT_FOUND_COPY })
  assert.deepEqual(changeWhenView({ view: { status: "answered", result: { ok: false, error: "Couldn't read that just now: overloaded" } }, stale: undefined }), { kind: "copy", copy: CHANGE_WHEN_FAILED_COPY })
  assert.deepEqual(changeWhenView({ view: { status: "failed", message: "network down" }, stale: undefined }), { kind: "copy", copy: CHANGE_WHEN_FAILED_COPY })
  assert.deepEqual(changeWhenView({ view: { status: "budget" }, stale: undefined }), { kind: "copy", copy: CHANGE_WHEN_BUDGET_COPY })
})

test("Change when, stale-while-revalidate: the last reading stays while new words are read, never to be saved", () => {
  const before: InterpretScheduleResult = answer("every Monday at 9am")
  const kept = changeWhenView({ view: { status: "reading" }, stale: before })
  assert.deepEqual(kept, { kind: "model", result: before, fresh: false }, "kept, and `fresh: false` means no Save")
  assert.deepEqual(changeWhenView({ view: { status: "none" }, stale: before }), { kind: "model", result: before, fresh: false }, "waiting out the idle")
  assert.deepEqual(changeWhenView({ view: { status: "reading" }, stale: undefined }), { kind: "reading" }, "nothing before it: the reading line")
  assert.deepEqual(changeWhenView({ view: { status: "none" }, stale: undefined }), { kind: "none" })
  // A refusal of earlier words is not kept: only a reading is.
  assert.deepEqual(changeWhenView({ view: { status: "reading" }, stale: { ok: false, error: SCHEDULE_NOT_FOUND_COPY } }), { kind: "reading" })
  // The new answer replaces it in place.
  const after = answer("every Tuesday at 9am", "FREQ=WEEKLY;BYDAY=TU;BYHOUR=9;BYMINUTE=0", "2026-10-06T09:00")
  assert.deepEqual(changeWhenView({ view: { status: "answered", result: after }, stale: before }), { kind: "model", result: after, fresh: true })
})

test("Change when never flashes its panel: once it is up for an edit, a word not yet read keeps it, reading (finding F2)", () => {
  // Typed at 120ms a key, the panel ("Reading when it runs…", Cancel, Save) opened at every word's end — a read out —
  // and vanished at the next letter — words not asked about yet — five times before the first answer, and the
  // section under it jumped each time. A panel already up for the edit stays, as the reading line.
  assert.deepEqual(changeWhenView({ view: { status: "reading" }, stale: undefined, shown: false }), { kind: "reading" })
  assert.deepEqual(changeWhenView({ view: { status: "none" }, stale: undefined, shown: true }), { kind: "reading" }, "the next letter: still up")
  assert.deepEqual(changeWhenView({ view: { status: "expired" }, stale: undefined, shown: true }), { kind: "reading" })
  // A refusal of earlier words was up: the new words keep the panel too, as the reading line.
  assert.deepEqual(changeWhenView({ view: { status: "none" }, stale: { ok: false, error: SCHEDULE_NOT_FOUND_COPY }, shown: true }), { kind: "reading" })
  // Nothing up yet and nothing asked: still nothing — the panel does not open on a first letter mid-word.
  assert.deepEqual(changeWhenView({ view: { status: "none" }, stale: undefined, shown: false }), { kind: "none" })
})
