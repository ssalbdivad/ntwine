import { test } from "node:test"
import assert from "node:assert/strict"
import { SCHEDULE_NOT_FOUND_COPY, SCHEDULE_PRESENCE_COPY, SCHEDULE_SPACING_COPY, cutPhrase, locatePhrase } from "@ntwine/shared"
import type { ClaudeOneShotRequest } from "./backend/claude-oneshot.ts"
import { createScheduleInterpreter, interpreterClock, interpreterSystemPrompt } from "./schedule-interpreter.ts"
import type { ThreadScheduleRow } from "./schedule-store.ts"

// The interpreter's VALIDATION around the model (schedule-interpreter.ts): the model is scripted here, so
// these pin what Ntwine does with each kind of answer — accept, retry once with the reason, or refuse with
// the human's copy. What a real model makes of real phrasings is recorded by a live run instead
// (ARCHITECTURE.md § Scheduled threads; the five phrasings were read for real on 2026-10-05).

// Monday 2026-10-05 14:32 in New York.
const NOW = Date.parse("2026-10-05T18:32:00Z")
const TZ = "America/New_York"

function scripted(...answers: (string | Error)[]) {
  const requests: ClaudeOneShotRequest[] = []
  const complete = async (request: ClaudeOneShotRequest) => {
    requests.push(request)
    const next = answers.shift()
    if (next === undefined) throw new Error("no scripted answer left")
    if (next instanceof Error) throw next
    return next
  }
  return { requests, interpreter: createScheduleInterpreter({ complete, now: () => NOW }) }
}

const monday = (extra: Record<string, unknown> = {}) => JSON.stringify({
  phrase: "every Monday at 9am",
  rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0",
  dtstart: "2026-10-12T09:00",
  condition: null,
  title: "Triage issues",
  ...extra,
})

test("the clock and the zone ride in the user message, so the system prompt is the same for every read", async () => {
  // A static system prompt is what lets the completer start the next read's CLI ahead of time (its options,
  // the system prompt among them, are fixed when it starts) and lets a caching model reuse the prefix.
  const { interpreter, requests } = scripted(monday(), monday())
  await interpreter.interpret({ text: "every Monday at 9am triage", tz: TZ })
  await interpreter.interpret({ text: "every Monday at 9am triage", tz: "Asia/Tokyo" })
  assert.equal(requests[0]!.system, interpreterSystemPrompt())
  assert.equal(requests[1]!.system, requests[0]!.system)
  assert.doesNotMatch(requests[0]!.system, /2026-10-05T14:32|America\/New_York/)
  assert.match(requests[0]!.prompt, /^Now: Monday, October 5, 2026, 2:32pm \(2026-10-05T14:32\) in the America\/New_York time zone\./)
  assert.match(requests[1]!.prompt, /^Now: Tuesday, October 6, 2026, 3:32am \(2026-10-06T03:32\) in the Asia\/Tokyo time zone\./)
  assert.match(interpreterClock(NOW, TZ), /local wall-clock time in that zone/)
})

test("the system prompt teaches intent before rules: time words alone are not a schedule", () => {
  const system = interpreterSystemPrompt()
  assert.ok(system.indexOf("DECIDE FIRST") < system.indexOf("rrule: one RFC 5545"), "intent comes before the rule grammar")
  for (const kind of [/describe the past, a deadline/, /pick out what the task covers, once/, /software the task builds/, /one later time and no repetition/, /tie the repeat to an event/, /inside quotes or code/]) {
    assert.match(system, kind)
  }
  // The first run is today's slot when one is still ahead: without this line both models started rules a
  // day or a week late (the schedule extraction benchmark, 2026-10-06; see schedule-interpreter.ts THE MODEL).
  assert.match(system, /Today counts: at 2:32pm on a Monday, "daily at 3pm" first runs today at 3pm/)
})

test("change when tells the model the text IS a schedule", async () => {
  const existing = { title: "Triage", when_text: "every Monday at 9am", rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0", dtstart: "2026-10-12T09:00", condition: null } as unknown as ThreadScheduleRow
  const { interpreter, requests } = scripted(JSON.stringify({ phrase: "mornings", rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0", dtstart: "2026-10-06T09:00", condition: null, title: "x" }))
  await interpreter.interpret({ text: "mornings", tz: TZ, existing })
  assert.match(requests[0]!.prompt, /so the TEXT is a schedule: answer no_schedule only if it names no time and no repetition/)
  assert.match(requests[0]!.prompt, /Now: Monday, October 5, 2026/)
})

test("an accepted answer cuts the phrase out of the prompt and nothing else, and previews the rule", async () => {
  const { interpreter, requests } = scripted(monday())
  const r = await interpreter.interpret({ text: "every Monday at 9am, triage new issues", tz: TZ })
  assert.equal(requests.length, 1)
  assert.equal(requests[0]!.model, "sonnet")
  assert.ok(r.ok)
  assert.equal(r.prompt, "triage new issues")
  assert.equal(r.phrase, "every Monday at 9am")
  assert.deepEqual([r.phraseStart, r.phraseEnd], [0, 19])
  assert.equal(r.title, "Triage issues")
  assert.equal(r.preview.echo, "Triage issues · every Monday at 9am")
  assert.deepEqual(r.preview.upcoming, ["2026-10-12T13:00:00.000Z", "2026-10-19T13:00:00.000Z", "2026-10-26T13:00:00.000Z"])
})

test("a fenced or chatty answer still parses", async () => {
  const { interpreter } = scripted(`Sure:\n\`\`\`json\n${monday()}\n\`\`\``)
  const r = await interpreter.interpret({ text: "triage new issues every Monday at 9am", tz: TZ })
  assert.ok(r.ok)
  assert.equal(r.prompt, "triage new issues")
})

test("a bad answer is retried ONCE with the reason, then the read FAILED — never \"no schedule\" (finding D)", async () => {
  // Since the box acts on the answer, "couldn't find a schedule" means Enter starts the thread at once, and it is
  // cached for 10m as the model's verdict. An answer that could not be USED is no verdict on the words: it is a
  // read that failed, which the box says ("Couldn't check for a schedule") before the next Enter starts it.
  const { interpreter, requests } = scripted("not json", "still not json")
  const r = await interpreter.interpret({ text: "every Monday at 9am triage", tz: TZ })
  assert.equal(r.ok, false)
  assert.match(!r.ok ? r.error : "", /^Couldn't read that just now\b/)
  assert.equal(requests.length, 2)
  assert.match(requests[1]!.prompt, /Your previous answer was:\nnot json\nIt was rejected: it was not one JSON object\./)
  // The same for each way an answer is unusable twice: cut off, no time of day, a phrase not in the words.
  for (const [text, answer] of [
    ["every Monday at 9am triage new issues", '{"phrase": "every Monday at 9am", "rrule": "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYM'],
    ["every Monday triage new issues", monday({ phrase: "every Monday", rrule: "FREQ=WEEKLY;BYDAY=MO" })],
    ["every  Monday at 9am triage new issues", monday()],
  ] as const) {
    const twice = scripted(answer, answer)
    const unusable = await twice.interpreter.interpret({ text, tz: TZ })
    assert.match(!unusable.ok ? unusable.error : "", /^Couldn't read that just now\b/, text)
  }
})

test("a rule with no time of day is sent back, and the second answer is used", async () => {
  const { interpreter, requests } = scripted(monday({ rrule: "FREQ=WEEKLY;BYDAY=MO" }), monday())
  const r = await interpreter.interpret({ text: "every Monday at 9am triage", tz: TZ })
  assert.ok(r.ok)
  assert.match(requests[1]!.prompt, /must name BYHOUR and BYMINUTE/)
})

test("a phrase that is not in the text is sent back — the cut must be exact", async () => {
  const { interpreter, requests } = scripted(monday({ phrase: "Mondays at nine" }), monday({ phrase: "EVERY MONDAY AT 9AM" }))
  const r = await interpreter.interpret({ text: "every Monday at 9am triage new issues", tz: TZ })
  assert.match(requests[1]!.prompt, /"Mondays at nine" is not in it/)
  assert.ok(r.ok, "case-insensitive match is accepted")
  assert.equal(r.prompt, "triage new issues")
})

test("refusals carry the human's copy, without a retry", async () => {
  const presence = scripted(JSON.stringify({ refuse: "presence" }))
  assert.deepEqual(await presence.interpreter.interpret({ text: "while I'm working, check CI", tz: TZ }), { ok: false, error: SCHEDULE_PRESENCE_COPY })
  const none = scripted(JSON.stringify({ refuse: "no_schedule" }))
  assert.deepEqual(await none.interpreter.interpret({ text: "check CI", tz: TZ }), { ok: false, error: SCHEDULE_NOT_FOUND_COPY })
  assert.equal(presence.requests.length + none.requests.length, 2)
})

test("runs closer than 15m are refused with the spacing copy, not retried", async () => {
  const { interpreter, requests } = scripted(monday({ phrase: "every 5 minutes", rrule: "FREQ=HOURLY;BYMINUTE=0,5,10,15,20,25,30,35,40,45,50,55", dtstart: "2026-10-05T15:00" }))
  const r = await interpreter.interpret({ text: "every 5 minutes check CI", tz: TZ })
  assert.deepEqual(r, { ok: false, error: SCHEDULE_SPACING_COPY })
  assert.equal(requests.length, 1)
})

test("words that are ONLY a schedule ask what each run should do", async () => {
  const { interpreter } = scripted(monday())
  const r = await interpreter.interpret({ text: "every Monday at 9am", tz: TZ })
  assert.equal(r.ok, false)
  assert.match(!r.ok ? r.error : "", /^What should each run do\?/)
})

test("a failed model call is one sentence back, not a throw", async () => {
  const { interpreter } = scripted(new Error("usage limit reached"))
  const r = await interpreter.interpret({ text: "every Monday at 9am triage", tz: TZ })
  assert.deepEqual(r, { ok: false, error: "Couldn't read that just now: usage limit reached" })
})

test("an unknown zone and a switched-off completer answer without a model call", async () => {
  const { interpreter, requests } = scripted(monday())
  assert.equal((await interpreter.interpret({ text: "every Monday at 9am triage", tz: "Mars/Olympus" })).ok, false)
  assert.equal(requests.length, 0)
  const off = createScheduleInterpreter({ now: () => NOW })
  assert.equal((await off.interpret({ text: "every Monday at 9am triage", tz: TZ })).ok, false)
})

test("change when: the whole text is the phrase, the title is kept, and nothing is cut", async () => {
  const existing = { title: "Triage", when_text: "every Monday at 9am", rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0", dtstart: "2026-10-12T09:00", condition: null } as unknown as ThreadScheduleRow
  const { interpreter, requests } = scripted(JSON.stringify({ phrase: "tuesdays at 10", rrule: "FREQ=WEEKLY;BYDAY=TU;BYHOUR=10;BYMINUTE=0", dtstart: "2026-10-06T10:00", condition: null, title: "Something else" }))
  const r = await interpreter.interpret({ text: "Tuesdays at 10", tz: TZ, existing })
  assert.match(requests[0]!.prompt, /It currently runs "every Monday at 9am" — rule FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0/)
  assert.ok(r.ok)
  assert.equal(r.title, "Triage")
  assert.equal(r.whenText, "Tuesdays at 10")
  assert.equal(r.prompt, "")
})

test("the preview names the schedule's zone when the viewer reads it from another", async () => {
  const { interpreter } = scripted(monday(), monday())
  const same = await interpreter.interpret({ text: "every Monday at 9am triage", tz: TZ })
  assert.ok(same.ok)
  assert.doesNotMatch(same.preview.echo, /time/)
  const away = await interpreter.interpret({ text: "every Monday at 9am triage", tz: TZ, viewerTz: "Europe/Berlin" })
  assert.ok(away.ok)
  assert.match(away.preview.echo, /New York time/)
})

test("locatePhrase and cutPhrase tidy only the seam", () => {
  assert.deepEqual(locatePhrase("Triage, every Monday at 9am.", "every monday at 9am"), { start: 8, end: 27 })
  assert.equal(locatePhrase("abc", "  "), undefined)
  assert.equal(cutPhrase("Triage new issues, every Monday at 9am.", { start: 19, end: 38 }), "Triage new issues.")
  assert.equal(cutPhrase("every Monday at 9am — triage new  issues", { start: 0, end: 19 }), "triage new  issues")
  assert.equal(cutPhrase("Look at CI every Monday at 9am and post it", { start: 11, end: 30 }), "Look at CI and post it")
})
