import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")
const renderText = () => {
  const render = source.match(/const renderText = \([\s\S]*?\n {2}\}/)?.[0]
  assert.ok(render, "renderText must exist")
  return render
}

// An ```awaiting fence that is not a LIVE wait never draws as a card. Two ways it stops being live: ntwine
// REFUSED the park (the flag the server sets when it folds the correction out of the transcript,
// transcript.ts markFenceRefused), which draws nothing at all, or the worker has SPOKEN since, which
// settles by construction whatever the fence named — and keeps its prose as a muted note, because since
// sub-agent check-ins that prose is the orchestration's progress history (2026-10-06).
test("a fence that is not a live wait is skipped before it ever reaches a card", () => {
  assert.match(
    renderText(),
    /if \(fseg\.fenceKind === "awaiting" && \(m\.fenceRefused \|\| restingCardShown\)\) continue/,
    "a refused fence and one the resting card states draw nothing",
  )
  assert.match(
    renderText(),
    /if \(fseg\.fenceKind === "awaiting" && staleAwaiting\) \{\n\s*if \(fseg\.body\.trim\(\)\) push\(<SettledAwaitingNote[^\n]*\n\s*continue/,
    "a settled fence draws its body as a note, never a card, and nothing when it has no body",
  )
  // SKIPPED, not returned as null from the card: the block list is interleaved with explicit spacers, so
  // a slot that renders nothing still spends one.
  assert.ok(
    renderText().indexOf("staleAwaiting") < renderText().indexOf("<FenceCard"),
    "the skip must come before the push, so no block slot is spent on a fence that draws nothing",
  )
  // …and `done` is untouched: a finished thread stays finished, whatever ntwine thought of its last park
  // and however long ago it was written.
  assert.doesNotMatch(renderText(), /(fenceRefused|staleAwaiting)[^\n]*"done"/)
})

// A LIVE FENCE THE RESTING CARD STATES IS SKIPPED THE SAME WAY. FenceCard returns null when the thread is
// at rest on the fence (the resting card opens on its body), but a null child is not a skipped block: the
// block list is interleaved with spacers, so the slot still spent its 14px — a gap dangling under the
// prose, above the resting card, on every rested awaiting thread (maintainer 2026-08-28, with a
// screenshot). So the owning surfaces pass `restingCardShown` and the block never reaches the card.
test("a fence the resting card states never reaches the card either", () => {
  // Every surface that owns a thread passes the flag for the LAST agent message only — the one whose
  // fence the resting card is about — so the memo boundary holds for every other row.
  const chat = source
  assert.equal(chat.match(/restingCardShown=\{(?:row\.)?messageIndex === lastAgentIdx && restingShown\}/g)?.length, 2, "both thread-view columns pass it")
  // …and the emptiness walk agrees, or a fence-only last message keeps its spacer and its rest divider.
  const helper = source.match(/export function rendersNothingIn[\s\S]*?\n}/)?.[0]
  assert.ok(helper, "rendersNothingIn must exist")
  assert.match(helper, /restingCardShown = false/, "it takes the resting-card reason")
  assert.match(helper, /entry\.messageIndex === awaitingCut\) owned\.add\(entry\.message\)/, "…and folds the last message in, apart from the settled set")
  assert.equal(chat.match(/rendersNothingIn\([a-zA-Z]+, awaitingCut, restingShown\)/g)?.length, 2, "every rendersNothingIn call passes it")
  // The virtualized list's rows come from lib/virtualTranscript transcriptMessageRows (incremental since
  // 2026-10-16), which takes the cut and the reason itself and folds them in exactly as rendersNothingIn
  // does — pinned there, against the pass from scratch, in virtualTranscript.incremental.test.ts.
  assert.match(chat, /transcriptMessageRows\(activityMessages, \{ awaitingCut, restingShown, rendersNothing: messageRendersNothing,/, "the virtualized rows take both")
})

// THE TAIL MOUNTS WITH THE TRANSCRIPT, NOT BEFORE IT. The board lands first, so the board's queue card
// used to paint its resting/done/rested card under the "Loading…" line and then shove it down ~1s later
// when the messages mounted above it — the layout shift the maintainer refreshed into (2026-08-28). That
// card went with the single-project board (2026-09-28); the thread view's half of the rule stays.
test("the thread view holds its tail cards until the transcript window has loaded", () => {
  // The thread view's eager branch is what renders while ITS window loads (count === 0 on both production
  // callers), and it drew the same ladder alone at the top of an empty pane. Same hold, both halves of it —
  // the spacer gate and the ladder — or the slot opens before the rung.
  assert.match(source, /const tailReady = !q\.isLoading/)
  // Two placements — above the queued sends for a card rung, after them for the typing dots — and both
  // wait for the transcript.
  assert.match(source, /\{tailReady && !typingLast && runtimeStatusRung\(runtimeStatus\) !== null && \(/, "the plain path's spacer gate waits for the transcript")
  assert.match(source, /\{tailReady && !typingLast && \(\n\s*<RuntimeStatusLadder/, "…and so does the ladder it opens for")
  assert.match(source, /\{tailReady && typingLast && \(\n\s*<>\n\s*<VSpace[^\n]*\/>\n\s*<RuntimeStatusLadder/, "…and so does the typing-dots placement")
})

// THE CARD NEVER LEARNS ABOUT STALENESS. It used to: a `stale` branch stripped the frame and printed the
// body as free-standing prose. A settled body now draws through SettledAwaitingNote instead, never the
// card, so a prop that can only mean "draw a settled card" would be a card shape that does not exist.
test("FenceCard has no settled branch to fall into", () => {
  const card = source.match(/export function FenceCard\([\s\S]*?\n}/)?.[0]
  assert.ok(card, "FenceCard must exist")
  assert.doesNotMatch(card, /\bstale\b/, "a settled fence never reaches the card, so it takes no `stale` prop")
})

// The fence's prose has been BLOCK markdown since frontmatter landed (2026-08-17), but every body kept
// the `md-inline` class, which styles only code/strong/em/links — so a `<ul>` arrived with Tailwind's
// preflight reset still on it and a handoff's bullet list rendered as flat unmarked lines.
test("every awaiting-fence body renders through the block markdown sheet", () => {
  const card = source.match(/export function FenceCard\([\s\S]*?\n}/)?.[0]
  assert.ok(card, "FenceCard must exist")
  // Comments off first — the note explaining WHY the class moved names the old one, and an unstripped
  // match would be satisfied by that sentence rather than by the code.
  const code = card.replace(/^\s*\/\/.*$/gm, "")
  assert.doesNotMatch(code, /md-inline/, "a fence body is block markdown — md-inline gives its lists no markers")
})

// WHETHER A MESSAGE RENDERS AT ALL IS NOW POSITIONAL, and that is the part with teeth. The contract
// invites a worker to rest on the fence ALONE, so a whole message can be one awaiting fence and no prose
// — 99 of the 6,999 awaiting fences in this machine's transcripts are that shape. Once settled, such a
// message draws nothing, and every surface that walks the transcript has to agree: a predicate that still
// reports it visible spends an adjacency spacer on an empty slot and saves a rest divider with nothing
// under it, which is the exact bug the refused-fence strip was added for.
test("the empty-message predicates take the settled case", () => {
  // (messageHasRenderableText, the project board's queue-card twin of this predicate, went with that
  // card on 2026-09-28.)
  for (const fn of ["messageRendersNothing"]) {
    const re = new RegExp(`export function ${fn}\\(m: ChatMessage, staleAwaiting\\?: boolean, cardOwned\\?: boolean\\)`)
    assert.match(source, re, `${fn} must accept the message's staleness`)
  }
  const blank = source.match(/function blankText\([\s\S]*?\n}/)?.[0]
  assert.ok(blank, "blankText must exist")
  const code = blank.replace(/^\s*\/\/.*$/gm, "")
  assert.match(code, /if \(!m\.fenceRefused && !staleAwaiting && !cardOwned\) \{\n\s*if \(!text\.includes\("```awaiting"\)\) return !text\.trim\(\)/, "a settled fence must reach the fence-aware test, as a refused one does")
  // …and a LIVE fence that names questions with no prose is as empty: renderText draws nothing for it.
  assert.match(code, /awaitingDefersToQuestions\(s\.hints\) && !awaitingProseBlock\(s\.body\)/)
  // …and a settled fence with a BODY still renders (its note), as does one that handed the human steps
  // (its card); one with neither is blank, and so is any the resting card owns or a refusal took.
  assert.match(code, /m\.fenceRefused \|\| cardOwned \|\| \(!settledFenceDraws\(s\.hints\) && !s\.body\.trim\(\)\)/)
})

// A FENCE THAT NAMES QUESTIONS DRAWS NO CARD (maintainer 2026-10-08: "if there are questions that are
// getting rendered, we don't even need to bother rendering the awaiting card"). Its prose stays as the
// message's own text, and the branch sits before the card push so no slot is spent on a card.
test("a fence that names questions renders its prose and no card", () => {
  const render = renderText()
  const branch = render.indexOf('if (fseg.fenceKind === "awaiting" && awaitingDefersToQuestions(fseg.hints))')
  assert.ok(branch >= 0, "the branch must exist")
  assert.ok(branch < render.indexOf("<FenceCard"), "it must come before the card push")
  assert.match(render.slice(branch), /^[^]*?const prose = awaitingProseBlock\(fseg\.body\)\n\s*if \(prose\) push\(<ProseHtml [^\n]*\/>\)\n\s*continue/)
})

// A SETTLED STEPS FENCE KEEPS ITS CARD (2026-10-08, maintainer: "We need to continue showing the to do
// instructions even after they are complete & the thread has moved on"). Drawn with NO thread, so it
// carries no live rows and no Done; settledSteps.e2e.test.ts drives it in the real drawer.
test("a settled fence that handed the human steps keeps its card, with no thread behind it", () => {
  const render = renderText()
  const keep = render.indexOf("settledFenceDraws(fseg.hints)")
  assert.ok(keep >= 0, "the exception must exist")
  assert.ok(keep < render.indexOf("(m.fenceRefused || restingCardShown)) continue"), "…ahead of the skip it excepts")
  assert.ok(keep < render.indexOf("<SettledAwaitingNote"), "…and ahead of the settled note, which it replaces")
  assert.match(render, /staleAwaiting && !m\.fenceRefused && !restingCardShown && settledFenceDraws\(fseg\.hints\)/, "never for a refused fence, nor one the resting card states")
  assert.match(render, /push\(<AwaitingBackgroundCard key=\{`[^`]+`\} fence=\{\{ body: fseg\.body, hints: fseg\.hints \}\} \/>\)/, "no `thread`, so no rows and no verb")
  assert.match(source, /function settledFenceDraws\(hints: readonly AwaitingHint\[\]\): boolean \{\n\s*return awaitingSteps\(hints\)\.length > 0\n\}/)
})

// ONE CUT, SHARED. The renderer marks a fence settled by comparing its index against the last assistant
// message; so must the spacer walk, or a message renders on one path and not the other. `rendersNothingIn`
// is how the position reaches a row builder that only takes `(message) => boolean`, and it keys on the
// message OBJECT because coalescing replaces that object when it absorbs a tool tail.
test("every transcript surface cuts staleness at the same index", () => {
  const scan = source.match(/export function lastAssistantIndex[\s\S]*?\n}/)?.[0]
  assert.ok(scan, "lastAssistantIndex must exist")
  // SAID, not "is the last assistant ROW". A `kind:"event"` line — rest, wake, compaction, sub-agent
  // completion — carries role:"assistant" and no utterance. Counting one puts the cut AFTER the fence it
  // protects, and since every rested thread ends with an "Agent rested" event that made EVERY live fence
  // read as settled: card and hourglass stripped off the one wait still open. That is the defect behind
  // the "light gray lines" reports, and restyling the body twice could never have fixed it.
  assert.match(scan, /messages\[i\]\.kind !== "event"/, "a synthetic event row is not the agent speaking")
  // Nobody re-derives it by hand — a second copy of the scan is how two surfaces' cuts drift apart.
  assert.equal(
    source.match(/for \(let i = messages\.length - 1; i >= 0; i--\) if \(messages\[i\]\.role === "assistant"/g)?.length,
    1,
    "the last-assistant scan must exist exactly once, inside lastAssistantIndex",
  )
  const helper = source.match(/export function rendersNothingIn[\s\S]*?\n}/)?.[0]
  assert.ok(helper, "rendersNothingIn must exist")
  assert.match(helper, /new WeakSet<ChatMessage>\(\)/, "it keys on the message object the entry holds")
  assert.match(helper, /entry\.messageIndex < awaitingCut/, "…cut at the same index the renderer uses")
  // NO AWAITING CARD WHILE THE THREAD RUNS (maintainer 2026-09-24, on a screenshot of a park card above a
  // spinning worker: "When the agent is running, an awaiting card should never be shown at all"). The cut
  // sits past every message while running, so each fence in the window is stale; at rest it is the last
  // assistant message, which the resting card at the tail keys on too. This replaced the 2026-08-28 rule
  // that kept the card at the last REST while the worker ran past it (lib/restAnchor, deleted with it).
  assert.equal(source.match(/const awaitingCut = running \? (?:presentationMessages|messages)\.length : lastAgentIdx/g)?.length, 2, "both columns cut past every message while running")
  assert.doesNotMatch(source, /lastRest\(|restAnchor\.ts|restedAt/, "the rest anchor is gone; nothing keeps a card at a rest the worker ran past")
  assert.equal(source.match(/staleAwaiting=\{awaitingCut >= 0 && (?:row\.)?messageIndex < awaitingCut\}/g)?.length, 2, "the renderer cuts at the same index")
  assert.doesNotMatch(source, /staleAwaiting=\{lastAgentIdx/, "no surface may still cut at the last message")
  // Both transcript columns go through it; a bare `messageRendersNothing` handed to a row builder is the
  // regression — it cannot see position, so it reports a settled fence-only message as visible.
  assert.doesNotMatch(source, /\n\s+messageRendersNothing,\n/, "no row builder may take the position-blind predicate")
})

// ONE AWAITING CARD, EVERY RUNTIME (2026-09-04). A live fence whose thread is NOT at rest on it — mid-turn
// on a follow-up the human sent, woken by the very shell it named, or bg-snoozed — reaches FenceCard
// rather than the tail's resting card. It used to draw a SECOND card there, agreeing with the resting one
// by hand: its own heading rule ("Awaiting", never "Background shells running"), its own glyph (a radar
// for a PR wait), its own empty-body placeholder, its own wrap rule, and its own PR chips. So steering a
// worker re-shaped the card under the human (maintainer 2026-09-04: "I'll steer an agent with a new
// message, and it'll re-render the awaiting card in a totally different fucking way. This doesn't make
// any sense at all"). Now there is one component, and the ONLY thing that may vary with the runtime is
// the Snooze, which that component withholds itself where there is no rest to park.
test("the awaiting fence renders the resting card itself, not a second card beside it", () => {
  const card = source.match(/export function FenceCard\([\s\S]*?\n}/)?.[0]
  assert.ok(card, "FenceCard must exist")
  const code = card.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  // THE FENCE IS PASSED IN, not read off the thread: the board holds `lastFence` only while the fence is
  // the worker's last word, and the tailer clears it on the very user record that bumps the thread — so a
  // card reading the thread alone lost the shell row at the bump while the PR and timer rows (rows in
  // their own registries) survived (maintainer 2026-08-28: "it hides the background shell for some
  // reason").
  assert.match(code, /return <AwaitingBackgroundCard thread=\{fenceThread\} fence=\{\{ body, hints \}\} \/>/, "the resting card itself, stating this fence")
  // Nothing about the awaiting card may be built HERE — a heading, a glyph, a prose call, a chip. Every
  // one of those was a place the two cards could disagree, and one of them is how each difference got in.
  assert.doesNotMatch(code, /Hourglass|Radar|TerminalSquare/, "the glyph is the card's, and it follows the card's title")
  assert.doesNotMatch(code, /awaitingFenceTitle|AWAITING_FALLBACK_TITLE|parkTitle/, "the heading is the card's")
  assert.doesNotMatch(code, /awaitingPresentationLine|awaitingProseBlock|prWatchRefs|WatchedRef/, "the prose and the PR chips are the card's")
  assert.doesNotMatch(code, /AwaitingWaitTable|AwaitingParkButton/, "…and so is the wait table and any verb under it")
  assert.doesNotMatch(code, /awaitingItemLabels|awaitingForLabel|itemLabels|forLabel/, "no label line of ids and a duration")
})

// …and the pieces the fence card used to own are now the resting card's, once each.
test("the resting card owns the heading, the glyph, the prose and the chips", () => {
  const cardSource = readFileSync(new URL("./AwaitingBackgroundCard.tsx", import.meta.url), "utf8")
  // To the END of the file, not to the first column-0 `}`: the props type closes on one of those, so a
  // lazy match would stop at the signature and every assertion below would pass on the type alone.
  const at = cardSource.indexOf("export function AwaitingBackgroundCard(")
  const card = at >= 0 ? cardSource.slice(at) : undefined
  assert.ok(card, "AwaitingBackgroundCard must exist")
  const code = card.replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  // The fence it STATES is a parameter, defaulting to the thread's own — that default is the at-rest
  // case, and the parameter is what lets one card also state a fence the board has already dropped.
  assert.match(code, /const stated = fence \?\? \(thread\?\.lastFence\?\.kind === "awaiting" \? thread\.lastFence : undefined\)/)
  assert.match(code, /awaitingBackgroundLabel\(work, hints\)/, "the heading reads the stated fence's hints")
  assert.match(code, /icon=\{steps\.length > 0 \? ListTodo : shellsAlone\(work\) \? TerminalSquare : Hourglass\}/, "three titles, three glyphs, and no fourth — steps are the one wait on the reader")
  assert.match(code, /const prose = awaitingProseBlock\(stated\?\.body\)/)
  assert.match(code, /const unrowed = unrowedWatchRefs\(work, hints\)/, "a PR the table already rows gets no chip — one PR, one place")
  // THE VERBS ARE THE ONLY THINGS THE RUNTIME MAY CHANGE, and each is withheld rather than re-styled: a
  // thread that has left the rest its steps were posted at has nobody waiting on the steps' Done
  // (2026-10-03), and "Ask for update" needs a parked rest the human owns. (The card's own Snooze was
  // removed 2026-10-14.)
  assert.match(code, /const restOwned = thread !== undefined && steps\.length === 0 && showsRestingCard\(thread\) && threadLifecycleAvailability\(thread\)\.snooze/)
  assert.doesNotMatch(code, /AwaitingSnooze|snoozeAwaitingBackground/, "the card carries no snooze")
  assert.match(code, /const stepsLive = thread !== undefined && restingOnSteps\(thread, steps\)/)
  // Nothing else may key on the runtime. A second `showsRestingCard` call inside this card is how a
  // heading, a glyph or a truncation rule would start varying with it again.
  assert.equal(code.match(/showsRestingCard\(/g)?.length, 1, "the runtime reaches the verbs once")
  assert.equal(code.match(/restingOnSteps\(/g)?.length, 1, "…and the steps' Done once")
  assert.doesNotMatch(code, /\.runtime\b/, "and nothing in the card reads the runtime directly")
})

