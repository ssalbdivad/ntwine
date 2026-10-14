// The pure pieces both TRIGGERS of the recurring prompt share: the parser that reads a worker's opt-out,
// and the two trailers that offer it. They are tested together because they are ONE contract — the
// wording delivered and the wording recognized have to agree, and nothing else in the system checks it.
import { test } from "node:test"
import assert from "node:assert/strict"
import { ALLDONE_SENTINEL, DEFAULT_RECURRING_PROMPT, SetOwnThreadRecurringPromptInput, SetThreadRecurringPromptInput, saysAllDone, restPromptMessage, schedulePromptMessage, formatIntervalLabel, parseRecurringPrompt , humanGapNote, stripHumanGapNote, wakeTimeHeader, stripWakeTimeHeader, formatElapsed } from "./index.ts"

// THE DEFAULT TEXT IS THE ONE GOAL MOST THREADS EVER RUN: the Goal panel prefills an unarmed thread's
// with it, so almost nobody types their own. Its BIAS is therefore a product decision rather than a
// wording choice, and it is deliberately lopsided (maintainer 2026-08-14: bias "strongly towards
// continuing with its work if there is incomplete work, unless there is a pressing or imminent decision
// that is needed from the human"). It used to read as two equal branches — keep going, or ask — which is
// not what a delivery that lands on an ALREADY-STOPPED thread is for.
//
// MAINTAINER-AUTHORED, VERBATIM (2026-08-24: "when did this get so fcking wordy?"). The text had grown
// to 92 words of guards; the maintainer replaced it with their own wording and said "Use my suggestion
// verbatim", so the pin is byte equality — any drift is someone editing the maintainer's own words. The
// guards it dropped (the task is the ceiling, a write-up is an ending) live in the worker contract and
// the fence-less-rest nudge; see the comment on DEFAULT_RECURRING_PROMPT for the history and the
// incident that put them here.
test("the default Goal is the maintainer's own wording, byte for byte", () => {
  assert.equal(
    DEFAULT_RECURRING_PROMPT,
    "If additional work remains on the original task, keep going. Make decisions autonomously.",
  )
  // Two standing constraints on ANY future wording, asserted so an edit that breaks them fails with the
  // reason rather than only the byte pin: no question-fence invitation (the stop hook fires over an
  // unanswered question fence unconditionally, so pointing at one teaches an exit this trigger does not
  // honour), and no backticked fence names (this text renders as markdown in the panel and the
  // transcript, where a lone ``` opens a code block that swallows everything after it).
  assert.doesNotMatch(DEFAULT_RECURRING_PROMPT, /question fence/)
  assert.doesNotMatch(DEFAULT_RECURRING_PROMPT, /```/)
  // …and it teaches no stopping protocol of its own: `restPromptMessage` appends the ```done exit to
  // every delivery, whatever the operator has typed over this.
  assert.match(restPromptMessage(DEFAULT_RECURRING_PROMPT), /```done/)
  assert.deepEqual(parseRecurringPrompt(restPromptMessage(DEFAULT_RECURRING_PROMPT)), {
    kind: "rest",
    prompt: DEFAULT_RECURRING_PROMPT,
  })
})

test("saysAllDone: the sentinel opts out on its own line, however the worker dressed it", () => {
  assert.equal(saysAllDone("ALLDONE"), true)
  assert.equal(saysAllDone("Checked CI, nothing to do.\n\nALLDONE"), true)
  assert.equal(saysAllDone("**ALLDONE**"), true)
  assert.equal(saysAllDone("`ALLDONE`"), true)
  assert.equal(saysAllDone("- ALLDONE"), true)
  assert.equal(saysAllDone("ALLDONE."), true)
  assert.equal(saysAllDone("done\r\nALLDONE\r\n"), true, "CRLF transcripts must parse the same")
})

// The expensive failure is the FALSE POSITIVE, and it is expensive precisely because the opt-out is
// PERMANENT: a run stalls, nothing errors, and nobody finds out until someone looks. Both trailers name
// the token, which invites a worker to discuss it — so only a whole line ever counts.
test("saysAllDone: the sentinel embedded in prose does NOT opt out", () => {
  assert.equal(saysAllDone("I'll reply ALLDONE when there's nothing left."), false)
  assert.equal(saysAllDone("Nothing yet, so no ALLDONE from me."), false)
  assert.equal(saysAllDone("ALLDONEISH"), false)
  assert.equal(saysAllDone("all done"), false, "the sentinel is exact, not a phrase match")
  assert.equal(saysAllDone("alldone"), false, "…and it is the shouted token, not the lowercase word")
  assert.equal(saysAllDone(""), false)
  assert.equal(saysAllDone(undefined), false)
})

// Both trailers carry the same two obligations, so both are held to them: name the exact sign-off the
// scheduler reads, and WARN. Naming it without the warning is how a worker learns to end its own run for
// tidiness; warning without naming it leaves the opt-out undiscoverable.
for (const [label, message] of [
  ["restPromptMessage", restPromptMessage("  keep fixing the failing tests  ")],
  ["schedulePromptMessage", schedulePromptMessage("  keep fixing the failing tests  ", 600)],
] as const) {
  test(`${label}: the operator's words come first, then an offer AND a warning`, () => {
    assert.ok(message.startsWith("keep fixing the failing tests"), "the operator's text leads, verbatim and trimmed")
    assert.ok(message.includes("```done"), "the trailer names the exact sign-off the scheduler reads")
    assert.match(message, /ONLY when the work is genuinely finished/, "and warns, in the same breath as the offer")
    // The trailer does NOT carry the sign-off protocol: ntwine's reminder is its own delivery now
    // (scheduler SOURCE 9), and a copy here would be exactly the repetition it was separated to avoid.
    assert.doesNotMatch(message, /```question/)
    // The RETIRED sentinel must not appear: it is still HONOURED for sessions that predate the change
    // (scheduler `saidDone`), and advertising it would teach it to workers that have no need of it.
    assert.equal(message.includes(ALLDONE_SENTINEL), false, "the legacy sentinel is honoured, never advertised")
    assert.equal(saysAllDone(message), false)
    // De-emphasized: one parenthetical line, not a section. A trailer that grows starts competing with
    // the operator's actual instruction for the worker's attention.
    //
    // The ceiling briefly moved to 400 when this trailer carried the sign-off protocol; it is back at
    // 240 now that ntwine's reminder is its own delivery.
    const trailer = message.slice(message.indexOf("("))
    assert.ok(trailer.length < 240, `trailer should stay a footnote, got ${trailer.length} chars`)
  })
}

// THE ONE DELIVERY ALLOWED TO EXCEED THE FOOTNOTE. The at-rest trigger fires over an unanswered
// ```question fence, so this bump can land on a worker whose own last word was a question to the human —
// and there, silence is the expensive option: it re-asks, and the operator gets the same card twice. The
// clause therefore has to overrule that instinct AND say what to do with the decision instead, which is
// more than the shared note's budget. Every other trailer stays capped above.
test("restPromptMessage says why the bump crosses a pending question", () => {
  const crossing = restPromptMessage("keep going", { overQuestion: true })
  assert.match(crossing, /not waiting\s+to answer it/, "the worker is told why its question is being talked over")
  assert.match(crossing, /Do NOT re-ask it/, "…and the instinct it must overrule is named outright")
  assert.match(crossing, /which way you went/, "a decision the operator cannot see is worse than the question")
  assert.ok(crossing.includes("```done"), "the opt-out survives the longer note")

  // OPT-IN, and the plain trailer is unchanged: a worker bumped mid-work has no question outstanding,
  // and telling it not to re-ask one would be ntwine inventing a state the thread is not in.
  assert.doesNotMatch(restPromptMessage("keep going"), /not waiting|re-ask/)
  assert.equal(restPromptMessage("keep going", {}), restPromptMessage("keep going"))

  // The longer trailer is still a TRAILER: the parser reads the delivery back as an ordinary rest bump,
  // so the chat collapses it into a wake divider like any other rather than dropping to raw prose.
  assert.deepEqual(parseRecurringPrompt(crossing), { kind: "rest", prompt: "keep going" })
})

// The prompt is SHARED now, so the trailer is the only thing that says which trigger fired. That makes
// this distinction load-bearing rather than cosmetic: a worker reading a scheduled delivery has NOT
// necessarily stopped, and must not conclude it has.
test("the two trailers are distinguishable — each says why it arrived, and the scheduled one how often", () => {
  assert.match(schedulePromptMessage("check the deploy", 600), /Goal — sent every 10m/)
  assert.match(restPromptMessage("check the deploy"), /Goal — sent each time you come to rest/)
})

test("formatIntervalLabel renders whole units, in the house duration grammar", () => {
  assert.equal(formatIntervalLabel(45), "45s")
  assert.equal(formatIntervalLabel(90), "2m", "under a minute is seconds; anything else rounds to whole minutes")
  assert.equal(formatIntervalLabel(600), "10m")
  assert.equal(formatIntervalLabel(3600), "1h")
  // An hour and a half is two whole units, never the `1.5 hr` decimal this printed until 2026-08-31 —
  // which was off the grammar AND unparseable, because RECURRING_TRAILER stops the cadence capture at
  // the first `.`. The round trip below is what that decimal used to break.
  assert.equal(formatIntervalLabel(5400), "1h 30m")
  assert.equal(formatIntervalLabel(0), "—")
})

// The round trip the chat depends on: what the composers emit, the parser reads back. They live in one
// file precisely so this holds, and this is the test that proves it rather than assuming it.
test("parseRecurringPrompt reads back exactly what the composers emit", () => {
  const rest = parseRecurringPrompt(restPromptMessage("Keep working the checklist."))
  assert.deepEqual(rest, { kind: "rest", prompt: "Keep working the checklist." })

  const scheduled = parseRecurringPrompt(schedulePromptMessage("Check the deploy.", 600))
  assert.deepEqual(scheduled, { kind: "schedule", every: "10m", prompt: "Check the deploy." })

  const compound = parseRecurringPrompt(schedulePromptMessage("Check the deploy.", 5400))
  assert.deepEqual(compound, { kind: "schedule", every: "1h 30m", prompt: "Check the deploy." })

  // A multi-line operator prompt keeps every line, and only the trailer is stripped.
  const multi = parseRecurringPrompt(restPromptMessage("One.\nTwo.\n\nThree."))
  assert.equal(multi?.prompt, "One.\nTwo.\n\nThree.")
})

test("parseRecurringPrompt declines anything that is not one — text is never lost to a parse", () => {
  assert.equal(parseRecurringPrompt("just a message the human typed"), undefined)
  assert.equal(parseRecurringPrompt(undefined), undefined)
  assert.equal(parseRecurringPrompt(""), undefined)
  // A worker QUOTING the trailer mid-message is not a delivery: the trailer must end the text.
  assert.equal(parseRecurringPrompt("(Recurring prompt — sent each time you come to rest. blah) and then more"), undefined)
  // The trailer alone, with no operator words in front of it, is not a delivery either.
  assert.equal(parseRecurringPrompt(restPromptMessage("x").replace(/^x/, "")), undefined)
})

// PRE-MERGE TRANSCRIPTS. Every thread open on disk when the stop hook and the heartbeat became one
// feature carries the OLD trailers, and those messages are not rewritten. The parser keeps both
// wordings so a whole thread's history does not silently demote from wake dividers to prose — a
// non-match loses no text, but it does lose the rendering.
test("parseRecurringPrompt still reads the PRE-MERGE trailers", () => {
  const legacyRest = "Keep working the checklist.\n\n(Stop hook — sent each time you come to rest. If there is genuinely no further work, reply ALLDONE on its own line to stop these prompts — but be sure, because it permanently stalls this run.)"
  assert.deepEqual(parseRecurringPrompt(legacyRest), { kind: "rest", prompt: "Keep working the checklist." })

  const legacyBeat = "Check the deploy.\n\n(Heartbeat — sent every 10 min. If there is genuinely no further work, reply ALLDONE on its own line to stop these prompts — but be sure, because it permanently stalls this run.)"
  assert.deepEqual(parseRecurringPrompt(legacyBeat), { kind: "schedule", every: "10 min", prompt: "Check the deploy." })
})

// ---- The one field kept alive purely for a stale caller ---------------------------------------------
// `pauseOnQuestions` was the question hold, deleted 2026-08-16 with the panel switch that inverted it.
// The WORKER input still ACCEPTS it, because the caller on that end is a detached daemon holding the
// `ntwine-mcp.mjs` it was spawned with — those outlive a server restart by design, so a strict refusal
// would fail a pre-change worker's `start` on a field its model cannot see it is sending. This is what
// stops the tolerance being deleted as dead code, and what says when it may go.
test("a pre-2026-08-16 worker's `start` still parses, and the hold is dropped rather than stored", () => {
  const parsed = SetOwnThreadRecurringPromptInput.parse({
    slug: "keep-going", prompt: "keep going", stopHook: true, heartbeat: false, pauseOnQuestions: true,
  })
  assert.equal(parsed.stopHook, true)
  assert.equal("pauseOnQuestions" in parsed ? parsed.pauseOnQuestions : undefined, true, "parsed, so the call succeeds")
  // …and nothing downstream reads it: the storage write shape has no such field, so it cannot be stored.

  // The BROWSER input is deliberately NOT tolerant — a stale tab is one reload away, and a schema that
  // accepts a field nobody sends is a field the next reader has to look up.
  assert.throws(() => SetThreadRecurringPromptInput.parse({
    slug: "keep-going", sessionId: "sid", prompt: "keep going", stopHook: true, heartbeat: false, pauseOnQuestions: true,
  }))
})


// WHAT THE HUMAN'S SILENCE COST, told to the worker that cannot measure it.
//
// A broker-run worker is given no clock at all, so an answer arriving after four hours is
// indistinguishable from one arriving after four seconds — and it will resume on a stale premise, re-run
// a build whose result has gone cold, or re-park on a shell that finished while nobody was reading
// (maintainer 2026-08-19: "when the user responds to a message after an hour of silence… is there a
// reason why we can't inject some temporal information in that scenario?").
test("a human reply after a long gap carries the gap; a fast one carries nothing", () => {
  const spoke = "2026-08-19T06:00:00.000Z"
  const at = (mins: number) => Date.parse(spoke) + mins * 60_000

  // BELOW THE FLOOR there is no note: a live back-and-forth does not need a stamp on every turn, and one
  // on each is noise that teaches nothing.
  assert.equal(humanGapNote(at(1), spoke), undefined)
  assert.equal(humanGapNote(at(19), spoke), undefined)

  // ABOVE IT, the elapsed number and the wall clock — the two facts the worker cannot derive.
  const note = humanGapNote(at(192), spoke)
  assert.match(note ?? "", /arrived 3h 12m after your last one/)
  assert.match(note ?? "", /It is now \d{4}-\d{2}-\d{2} \d{2}:\d{2}\./)
  // ATTRIBUTED: it rides on the HUMAN's message, so it must not read as something the human wrote.
  assert.match(note ?? "", /^⏱ ntwine:/)

  // NO ANCHOR, NO GUESS — a thread whose worker has never spoken gets nothing rather than a fabricated
  // elapsed time.
  assert.equal(humanGapNote(at(999), undefined), undefined)
  assert.equal(humanGapNote(at(999), "not-a-date"), undefined)
})

// The note is appended to the WORKER's copy only, but the chat renders the worker's transcript — so the
// display projection is the only thing standing between ntwine's clock line and the operator's own bubble
// ("can we make these invisible? they're showing up in my own user messages", 2026-08-20). Producer and
// stripper are pinned to each other here: a wording change on one that the other does not follow fails
// this test instead of silently reappearing over the human's words.
test("the gap note is stripped back off for display, and only when ntwine wrote it", () => {
  const spoke = "2026-08-19T06:00:00.000Z"
  const note = humanGapNote(Date.parse(spoke) + 192 * 60_000, spoke)
  assert.ok(note)

  // ROUND TRIP: exactly how router.ts appends it, gone without a trace.
  assert.equal(stripHumanGapNote(`ship it\n\n${note}`), "ship it")
  // A note is the LAST thing on the record, so a multi-line message keeps every line of its own.
  assert.equal(stripHumanGapNote(`one\n\ntwo\n\n${note}`), "one\n\ntwo")

  // AND NOTHING ELSE. The text this rides on is the human's own, so prose that merely quotes or
  // describes the note stays in the bubble intact — including the report that produced this fix.
  const quoting = `why does "${note}" show up in my own messages?`
  assert.equal(stripHumanGapNote(quoting), quoting)
  const truncated = "ship it\n\n⏱ ntwine: the message above arrived 3h12m after your last one."
  assert.equal(stripHumanGapNote(truncated), truncated)
  assert.equal(stripHumanGapNote("ship it"), "ship it")
})

// THE SAME PAIRING, FOR THE OTHER CLOCK LINE. `wakeTimeHeader` is appended to EVERY wake for the worker's
// benefit — it has no clock of its own — and every wake is recorded as a user turn, so left alone it
// prints at the foot of the card a human reads. On the one wake that carries the human's OWN words (an
// answer to a registered question) it is worse than clutter: the answers reader treats a trailing line as
// a continuation of the last answer, so it lands INSIDE the chip holding what they chose.
test("the wake clock line is stripped back off for display, and only when ntwine wrote it", () => {
  const spoke = "2026-08-27T06:00:00.000Z"
  const header = wakeTimeHeader(Date.parse(spoke) + 249 * 60_000, spoke)
  assert.match(header, /you last spoke/)

  // ROUND TRIP: exactly how scheduler.withClock appends it, gone without a trace — with and without the
  // elapsed clause, which is absent whenever the thread has no assistant record to measure from.
  assert.equal(stripWakeTimeHeader(`Answers to earlier questions:\n1. “Q?” → A\n\n${header}`), "Answers to earlier questions:\n1. “Q?” → A")
  assert.equal(stripWakeTimeHeader(`ship it\n\n${wakeTimeHeader(Date.parse(spoke))}`), "ship it")

  // AND NOTHING ELSE: prose that merely quotes one, or a stamp mid-message, stays put.
  const quoting = `why does "${header}" show up in my own messages?`
  assert.equal(stripWakeTimeHeader(quoting), quoting)
  assert.equal(stripWakeTimeHeader(`${header}\n\nship it`), `${header}\n\nship it`)
  assert.equal(stripWakeTimeHeader("ship it"), "ship it")
})

test("formatElapsed reads in the house duration grammar", () => {
  assert.equal(formatElapsed(45_000), "45s")
  assert.equal(formatElapsed(90_000), "1m")
  assert.equal(formatElapsed(60 * 60_000), "1h")
  assert.equal(formatElapsed(192 * 60_000), "3h 12m")
  assert.equal(formatElapsed(48 * 60 * 60_000), "2d")
  assert.equal(formatElapsed(50 * 60 * 60_000), "2d 2h")
  // A clock that has gone backwards is never reported as a negative age.
  assert.equal(formatElapsed(-5), "an unknown time")
})
