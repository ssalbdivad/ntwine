import { test } from "node:test"
import assert from "node:assert/strict"
import type { ChatMessage } from "../hooks.ts"
import { transcriptMessageRows, transcriptMessageRowsFull, type TranscriptRowEntry, type TranscriptRowRules } from "./virtualTranscript.ts"

// transcriptMessageRows resumes from the entries two calls share (virtualTranscript.ts, "kept
// incrementally"). Every case drives a transcript the way the drawer does — the same message objects, the
// cut and the resting card moving with the thread — and holds each answer, and every earlier one, to the
// pass from scratch.

let clock = 0
const minute = 60_000
const start = Date.UTC(2026, 9, 16, 9, 0, 0)
const at = (stepMinutes = 1) => new Date(start + (clock += stepMinutes) * minute).toISOString()
const agent = (id: string, text: string, over: Partial<ChatMessage> = {}): ChatMessage => ({ sourceId: id, role: "assistant", text, tools: [], at: at(), ...over })
const human = (id: string, text: string, over: Partial<ChatMessage> = {}): ChatMessage => ({ sourceId: id, role: "user", text, tools: [], at: at(), ...over })
const rest = (id: string): ChatMessage => ({ sourceId: id, role: "assistant", kind: "event", boundary: "rest", text: "Agent rested", tools: [], at: at() })

// Stands in for ChatView's messageRendersNothing: blank text draws nothing, and a "WAIT" message is a
// fence-only reply that draws nothing once it is stale (below the cut) or owned (the resting card states
// it) — the two positional flags the real predicate takes. One object for the whole file, as in ChatView,
// where it is a module function.
const rendersNothing: TranscriptRowRules["rendersNothing"] = (m, stale, owned) =>
  m.role === "assistant" && m.kind !== "event" && (!m.text.trim() || (m.text.startsWith("WAIT") && (stale || owned)))
// Depends on both sides, as messageGap does, so a row whose previous RENDERED row changes would show it.
const gapBetween: TranscriptRowRules["gapBetween"] = (previous, next) => (previous.role === "user" && next.role !== "user" ? 22 : 14) + (next.kind === "event" ? 3 : 0)

interface Version {
  entries: TranscriptRowEntry[]
  /** ChatView's awaitingCut: `messages.length` while running, else the last assistant index. */
  cut: number
  resting?: boolean
}
const entriesOf = (messages: readonly ChatMessage[]): TranscriptRowEntry[] => messages.map((message, messageIndex) => ({ message, messageIndex }))
const running = (messages: readonly ChatMessage[]): Version => ({ entries: entriesOf(messages), cut: messages.length })
const rested = (messages: readonly ChatMessage[], resting = true): Version => {
  let cut = -1
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === "assistant" && messages[i]!.kind !== "event") { cut = i; break }
  return { entries: entriesOf(messages), cut, resting }
}

function assertTracksFull(versions: readonly Version[], rules: Pick<TranscriptRowRules, "rendersNothing" | "gapBetween"> = { rendersNothing, gapBetween }): void {
  const answers: { version: Version; output: unknown }[] = []
  for (const version of versions) {
    const full = { awaitingCut: version.cut, restingShown: version.resting ?? false, ...rules }
    const output = transcriptMessageRows(version.entries, full)
    assert.deepEqual(output, transcriptMessageRowsFull(version.entries, full))
    answers.push({ version, output })
  }
  // A resumed run slices the previous rows; it must never write into an answer a render still holds.
  for (const { version, output } of answers) {
    assert.deepEqual(output, transcriptMessageRowsFull(version.entries, { awaitingCut: version.cut, restingShown: version.resting ?? false, ...rules }))
  }
}

// The streaming case the cache exists for: the cut sits past the tail and moves with every append, which
// must leave every earlier entry's flags (all stale) and so its row exactly as it was.
test("a running thread appends message by message", () => {
  const list = [human("h1", "Fix the table"), agent("a1", "Looking.")]
  const versions = [running(list)]
  for (let i = 0; i < 8; i++) {
    list.push(i % 3 === 2 ? agent(`w${i}`, "WAIT for CI") : agent(`a${i + 2}`, `step ${i}`))
    versions.push(running(list))
  }
  assertTracksFull(versions)
})

// The tail message streams: the server finalizes it as a NEW object under the same sourceId, so the walk
// resumes one entry from the end and the key is reused, not suffixed.
test("the tail message replaced as it streams", () => {
  const base = [human("h1", "Go"), agent("a1", "Reading")]
  const v1 = [...base, agent("a2", "Half a sen")]
  const v2 = [...base, { ...v1[2]!, text: "Half a sentence, then the rest." }]
  const v3 = [...v2, agent("a3", "")]
  assertTracksFull([running(v1), running(v2), running(v3)])
})

// The cut leaves the tail when the thread rests, lands on the last assistant message and owns its fence
// (the resting card), then moves again: a reply runs the thread, and the next rest cuts further down.
test("a rest boundary moving as the thread rests, is answered and rests again", () => {
  const turn1 = [human("h1", "Ship it"), agent("a1", "Building."), agent("w1", "WAIT for CI")]
  const restedOnce = [...turn1, rest("r1")]
  const answered = [...restedOnce, human("h2", "CI is green")]
  const turn2 = [...answered, agent("a2", "Merging."), agent("w2", "WAIT for the merge")]
  const restedTwice = [...turn2, rest("r2")]
  assertTracksFull([
    running(turn1),
    rested(restedOnce),
    rested(restedOnce, false), // the resting card stops stating it (a snooze, a watch) — the fence draws again
    running(answered),
    running(turn2),
    rested(restedTwice),
    rested([...restedTwice, agent("a3", "Done.")]), // a late message moves the cut past the fence
  ])
})

// A human turn arriving at the tail, typed first as a queued send (which never renders) and then landing
// as an ordinary bubble that changes the gap charged to the agent's next row.
test("a human turn arriving, queued and then landed", () => {
  const base = [human("h1", "Start"), agent("a1", "On it.")]
  const queued = [...base, human("q1", "also the header", { queued: true })]
  const landed = [...base, human("q1", "also the header")]
  assertTracksFull([running(base), running(queued), running(landed), running([...landed, agent("a2", "Got it.")])])
})

// A filtered list's entries keep their transcript index, so the indices skip; a coalesced tool run starts
// before its newest batch moved. Both feed the time break, which must come out of the resumed clock exactly.
test("time breaks across a pause, a day change, a coalesced run and a legacy row", () => {
  const m0 = human("h1", "Morning")
  const m1 = agent("a1", "Hi")
  const runStarted = at()
  const m2 = agent("t1", "ran tools") // at walks forward from runStartedAt
  const m3 = agent("a2", "Back after a pause", { at: at(25) })
  const legacy = agent("a3", "no timestamp", { at: undefined })
  const m4 = agent("a4", "Next day", { at: at(24 * 60) })
  const entries: TranscriptRowEntry[] = [
    { message: m0, messageIndex: 0 },
    { message: m1, messageIndex: 2 },
    { message: m2, messageIndex: 5, runStartedAt: runStarted },
  ]
  const grown = [...entries, { message: m3, messageIndex: 9 }, { message: legacy, messageIndex: 10 }]
  const later = [...grown, { message: m4, messageIndex: 11 }]
  const last = transcriptMessageRows(later, { awaitingCut: 12, restingShown: false, rendersNothing, gapBetween })
  assert.deepEqual(last.map((row) => row.timeBreak), ["day", null, null, "time", null, "day"])
  // The same run object, re-dated: what it started at is part of the prefix too.
  const redated = later.map((entry) => (entry.message === m2 ? { ...entry, runStartedAt: new Date(Date.parse(m1.at!) + 21 * minute).toISOString() } : entry))
  assertTracksFull([{ entries, cut: 6 }, { entries: grown, cut: 11 }, { entries: later, cut: 12 }, { entries: redated, cut: 12 }])
})

// The two corners the prefix cannot see: a render key used above (the copy is suffixed) and one message
// object listed twice (the stale set keys on the object). Each falls back to the pass from scratch, and the
// calls after it must still match.
test("a repeated legacy key and a repeated message object", () => {
  const legacyAt = at()
  const twin = (): ChatMessage => ({ role: "assistant", text: "same words", tools: [], at: legacyAt })
  const base = [human("h1", "Go"), twin()]
  const withTwin = [...base, twin()]
  assertTracksFull([running(base), running(withTwin), running([...withTwin, agent("a9", "after")])])

  const shared = agent("w1", "WAIT for review")
  const once = [human("h2", "Review"), shared, agent("a1", "Meanwhile")]
  const twice: TranscriptRowEntry[] = [...entriesOf(once), { message: shared, messageIndex: 7 }]
  // The object sits both below the cut and at it, so the full pass marks it stale wherever it appears —
  // its copy at the cut included, which by position alone would draw.
  assertTracksFull([{ entries: entriesOf(once), cut: 2, resting: true }, { entries: twice, cut: 7 }, { entries: [...twice, { message: agent("a2", "more"), messageIndex: 8 }], cut: 9 }])
})

// A page of history loads ABOVE the head: a new first message, and so a pass from scratch, and the live
// tail keeps resuming from that one afterwards.
test("history prepended above the head", () => {
  const live = [agent("a5", "Continuing."), agent("a6", "More.")]
  const earlier = [human("h0", "Start"), agent("a4", "On it."), rest("r0")]
  const loaded = [...earlier, ...live]
  assertTracksFull([running(live), running(loaded), running([...loaded, agent("a7", "Tail.")])])
})

// The rules are part of what the cache resumes on: a different predicate means no shared prefix at all.
test("a different predicate is a pass from scratch", () => {
  const list = [human("h1", "Go"), agent("a1", ""), agent("a2", "Visible")]
  const drawsAll: TranscriptRowRules["rendersNothing"] = () => false
  assertTracksFull([running(list)])
  assertTracksFull([running(list)], { rendersNothing: drawsAll, gapBetween })
})
