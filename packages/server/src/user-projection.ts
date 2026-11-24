import {
  DISPATCH_TASK_BANNER_MARKER,
  GITHUB_DISPATCH_UI_BOUNDARY,
  isInjectedNoise,
  isParkCorrection,
  isWakeDelivery,
  parseAgentMessage,
  parseCardAction,
  parseCrossSessionMessage,
  parseGithubWakeSteer,
  parseMergedWake,
  parseSpinoffChildPrompt,
  parseSpinoffRequest,
  splitWakeDeliveries,
  stripFollowUpRiders,
  stripWakeDeliveryToken,
  stripWakeTimeHeader,
  stripWakeTrailer,
  type CardAction,
  type GithubWakeSteer,
  type TranscriptMessage,
} from "@ntwine/shared"
import { stripDeliveryMarkers } from "./delivery-marker.ts"
import { parseSignalFence } from "./tailer.ts"
import { isMoveArrivalWake, stripMovedNote } from "./thread-move.ts"

export function normalizeNewlines(s: string): string {
  // Also drop ntwine's invisible delivery marker (delivery-marker.ts). Every path that turns a raw record
  // into rendered text funnels through here, so stripping once makes the marker unobservable to the
  // human — in the drawer, in search, in copied text — while the correlator upstream still reads it off
  // the RAW record. A no-op (single `includes`) for the overwhelming majority of text, which is unmarked.
  return stripDeliveryMarkers(s).replace(/\r\n?/g, "\n")
}

// Display-only projection for the FIRST user turn of a generated GitHub dispatch — a RETIRED envelope:
// the GitHub picker that generated it was removed on 2026-10-14, and this stays for the threads it had
// already started, as LEGACY_TASK_MARKER below does for the pre-banner prompt. Deliberately
// require the complete server-generated envelope, including the exact versioned marker, so ordinary
// HTML comments and code examples stay literal. `text` itself is never changed: workers, persistence,
// search, and transcript logic retain the full machine-facing prompt below the boundary.
export function githubDispatchDisplayText(text: string): string | undefined {
  const cut = text.indexOf(`\n\n${GITHUB_DISPATCH_UI_BOUNDARY}\n\n`)
  if (cut === -1) return undefined
  const head = text.slice(0, cut)
  const match = head.match(/^THREAD: [a-z0-9][a-z0-9-]*\n\n(Investigate this issue and make recommendations\n\n(?:Issue|PR) #\d+: [^\n]+\nRepository: [^\n]+\nURL: \S+)$/)
  return match?.[1]
}

// The retired first-prompt envelope. Until 2026-07-26 composePrompt put an explanation line and a bare
// `TASK:` marker BELOW the banner, and that marker — not the banner — was the display cut. Recognizing
// the exact retired preamble (rather than just hunting for `\nTASK:\n` below the banner) is what keeps a
// NEW dispatch whose task legitimately contains a "TASK:" line from being truncated at it.
const LEGACY_TASK_MARKER = "\nTASK:\n"
const LEGACY_BANNER_PREAMBLE =
  "Everything ABOVE this line is ntwine system orientation. Everything BELOW the `TASK:` marker is the human operator's own prompt, verbatim."

// Display-only projection for the FIRST user turn of an ntwine dispatch: strip ntwine's own envelope
// (scratchpad orientation + project instructions + the YOUR TASK banner) so the bubble is the human
// operator's prompt and nothing else. Everything below DISPATCH_TASK_BANNER_MARKER is verbatim theirs.
//
// This is the ONLY place the envelope is cut, which is the point: a broker thread's first prompt
// arrives as a `queue-operation` enqueue record, a pre-broker thread's as an ordinary `user` record, and a
// resumed one as a `queued_command` attachment. The old cut lived inline in the plain-`user` arm alone,
// so under the broker the whole composed prompt — orientation, instructions, banner and all — rendered
// in the chat bubble. Returns undefined when `text` carries no envelope (any turn but the first).
export function ntwineDispatchDisplayText(text: string): string | undefined {
  const cut = text.indexOf(DISPATCH_TASK_BANNER_MARKER)
  if (cut === -1) {
    // Pre-banner dispatches carried the bare marker with no banner at all.
    const legacy = text.indexOf(LEGACY_TASK_MARKER)
    return legacy === -1 ? undefined : text.slice(legacy + LEGACY_TASK_MARKER.length).trim()
  }
  const below = text.slice(cut + DISPATCH_TASK_BANNER_MARKER.length)
  if (below.startsWith(LEGACY_BANNER_PREAMBLE)) {
    const legacy = below.indexOf(LEGACY_TASK_MARKER)
    if (legacy !== -1) return below.slice(legacy + LEGACY_TASK_MARKER.length).trim()
  }
  return below.trim()
}

// Where cc-worker/hooks/agent-dispatch.mjs's auto-appended helper epilogue begins in a SUB-AGENT's
// dispatch prompt. The hook adds it to every Agent call a worker makes, so the child's first turn is the
// worker's task and then two paragraphs of ntwine's rules for helpers. A reader opening the child — its
// drawer, `read_thread thread.child` — wants what it was sent to do; the rules are the same every time.
const SUBAGENT_EPILOGUE_MARK = "\n---\n[ORCHESTRATION EPILOGUE"

/** The first turn of a sub-agent without ntwine's helper epilogue, or undefined when it carries none. */
export function subAgentDispatchDisplayText(text: string): string | undefined {
  const cut = text.indexOf(SUBAGENT_EPILOGUE_MARK)
  return cut === -1 ? undefined : text.slice(0, cut).trimEnd()
}

// The display projection for ONE user turn — undefined when the stored text is already what to show.
// Three independent reasons a user record can carry machine-facing text, composed in order:
//   • ntwine's own dispatch envelope (FIRST turn only — orientation + instructions above the banner);
//   • a generated GitHub dispatch, retired but still on old threads (FIRST turn only — the envelope is what opens the thread). It sits
//     BELOW ntwine's banner, so it is peeled from the remainder, not from the raw record;
//   • the scheduler's wake-delivery token, which rides ANY turn a wake lands on. That's the case the
//     old `out.length === 0` gate missed entirely: a wake is by definition a later turn, so its token
//     reached the pre-wrap user bubble and rendered as literal `<!-- ntwine-wake:… -->`;
//   • the clock note ntwine appends to a human follow-up after a long gap. The router adds it to the
//     worker's copy ONLY — but the chat renders this transcript, not the ledger the router wrote, so the
//     note showed up inside the operator's own bubble underneath their own words.
// `text` is never narrowed — the outbox acks a delivery by finding that token in the worker's own
// record, the queued-bubble map keys on the raw enqueued content, and persistence/search keep the full
// machine-facing prompt.
export function userDisplayText(text: string, first: boolean): string | undefined {
  let projected = text
  if (first) {
    projected = ntwineDispatchDisplayText(projected) ?? projected
    projected = githubDispatchDisplayText(projected) ?? projected
    projected = subAgentDispatchDisplayText(projected) ?? projected
  }
  projected = stripMovedNote(projected)
  projected = stripWakeDeliveryToken(projected)
  // The token comes off FIRST and the clock second, because that is the order they were appended in
  // (scheduler.withClock, then context's delivery token) and each is anchored to end-of-text.
  projected = stripWakeTimeHeader(projected)
  projected = stripFollowUpRiders(projected)
  // And ntwine's own agent-facing trailer LAST, once the two riders above have uncovered it. The dividers
  // never render it, but a divider only happens for a delivery the browser's parsers RECOGNIZE — and a
  // tab is a build behind whenever ntwine restarts under it, so a wake in a shape its bundle predates
  // falls through to the raw-text card and prints "STILL ARMED … drop it with `mcp__ntwine__watch_pr`" at
  // the operator. Stripping it HERE — on the side that composed it, and can never be behind itself —
  // makes that impossible for a tab of any age and for wake shapes not written yet.
  projected = stripWakeTrailer(projected)
  return projected === text ? undefined : projected
}

export type SessionPeerInput = { name?: string; socket?: string }

export function sessionPeerOf(session: SessionPeerInput): NonNullable<TranscriptMessage["sessionPeer"]> {
  return { ...(session.name ? { name: session.name } : {}), ...(session.socket ? { socket: session.socket } : {}) }
}

export type UserProjection = {
  displayText?: string
  spinoff?: { id: string; instructions: string }
  spinoffOrigin?: { instructions: string; brief: string }
  keepWorking?: true
  cardAction?: CardAction
  wake?: true
  wakeSteer?: GithubWakeSteer
  peerFrom?: string
  peerUnnamed?: true
  sessionPeer?: TranscriptMessage["sessionPeer"]
}

// The full presentation projection for one user turn: its display text, plus whether NTWINE wrote it.
// Both derive from the same raw record, and every site that pushes a user message needs both — keeping
// them in one helper is what stops a new push site from shipping the display projection while silently
// dropping the wake flag (which would put a scheduler steer back in the human's own bubble).
export function userProjection(text: string, first: boolean): UserProjection {
  // A SIDEWAYS message — another top-level session's SendMessage into this one — is settled first for
  // the same reason as the upward one below: none of it is the human's, and its wrapper is not prose.
  const session = parseCrossSessionMessage(text)
  if (session) return { displayText: session.body, sessionPeer: sessionPeerOf(session) }
  // An UPWARD agent-to-agent message — a background child calling `SendMessage({to:"main"})` — is not
  // the human's text at all, so it is settled FIRST and returns on its own. Its body, not the
  // `<agent-message>` wrapper, is what a reader wants, and none of the projections below apply: the
  // dispatch/wake strippers target envelopes this text never carries. `peerDispatchId` is deliberately not
  // set here — only the delivery record names the sender, so the attachment arm resolves and adds it.
  const peer = parseAgentMessage(text)
  if (peer) return { displayText: peer.body, peerFrom: peer.from }
  const displayText = userDisplayText(text, first)
  // A CARD ACTION (shared parseCardAction) — Continue, Done, Retry, Restart worker: the human's send, but
  // a button's, worded for the worker, so the chat draws it as their one-line marker rather than a bubble.
  // Keep working also keeps its own flag, which the human-turn readers skip.
  const cardAction = parseCardAction(displayText ?? text)
  if (cardAction) return { ...(displayText ? { displayText } : {}), cardAction, ...(cardAction === "keep-working" ? { keepWorking: true as const } : {}) }
  // A SPINOFF REQUEST an older build delivered to the parent's worker (parseSpinoffRequest). It is the
  // human's (they asked for it), but its text was ntwine's errand for the worker, so the chat draws the
  // human's instructions as the same spinoff card a request drawn from its row gets (withSpinoffCards).
  const spinoff = parseSpinoffRequest(displayText ?? text)
  if (spinoff) return { displayText: spinoff.instructions, spinoff }
  // …and a SPINOFF CHILD's opening turn is the mirror image: the human's instructions with the context
  // below them (spinoffChildPrompt). The context is not the human speaking, so the chat
  // draws the two as the thread's spinoff header rather than one giant user bubble (maintainer
  // 2026-09-30: "this kind of context can't be included as a user message"). FIRST turn only, and read
  // below the dispatch envelope, where the composed prompt starts. `displayText` is the instructions —
  // never empty (the parser refuses empty instructions) — because every reader that quotes a thread's
  // request takes the first user turn with non-empty display text.
  if (first) {
    const origin = parseSpinoffChildPrompt(displayText ?? text)
    if (origin) return { displayText: origin.instructions, spinoffOrigin: origin }
  }
  if (!isWakeDelivery(text)) return { ...(displayText ? { displayText } : {}) }
  // Parse the steer HERE, not in the browser. The formatter that composed this text and the parser
  // reading it are the same build on this side, so they cannot disagree; a browser tab is routinely a
  // build behind (see TranscriptMessage.wakeSteer), and when it is, the chat used to lose the divider
  // and dump the raw agent-facing steer into the transcript instead. `displayText ?? text` because the
  // delivery token has to be off before the steer will parse, and that is exactly what the projection
  // above stripped. A steer this build cannot read stays absent and the client falls back to its own
  // parse — never worse than before.
  const steer = parseGithubWakeSteer(displayText ?? text)
  return { ...(displayText ? { displayText } : {}), wake: true as const, ...(steer ? { wakeSteer: steer } : {}) }
}

// Push ONE user record as the message(s) it actually carries.
//
// Normally that is one message and this is `out.push` with a projection. But the runtime merges
// deliveries that land while the worker is mid-turn into a single record (see splitWakeDeliveries), and
// a merged record must not render as one blob: its parts are separate ntwine messages that happened to
// arrive together, and each has its own presentation — a recurring prompt collapses to a divider, a
// relay is plumbing the chat drops, a GitHub wake gets its card. Every segment therefore takes the
// SAME route a lone delivery takes, `isInjectedNoise` included, so a coalesced thread reads exactly
// like one where the same messages arrived a second apart.
//
// A sourceId is the chat's per-message handle — the scroll anchor, `data-ntwine-msg`, and the React key
// — so two rendered messages must never share one. The lone delivery keeps the record's bare sourceId
// (it is the same one message it always was, and these anchors should not churn); anything beyond it
// takes a `#u<i>` suffix. The `u` namespace matters: when this record ALSO drew completion dividers
// they already claimed `#0`, `#1`, … and the collision is silent on the server — it surfaces only as a
// React duplicate-key warning in the browser, which is where this was actually caught.
export function pushUserRecord(out: TranscriptMessage[], sourceId: string, text: string, at: string | undefined, dropCorrection: CorrectionSink, shareId = true): void {
  for (const [i, segment] of splitWakeDeliveries(text).entries()) {
    if (isInjectedNoise(segment)) continue
    if (dropCorrection(segment)) continue
    const projection = userProjection(segment, out.length === 0)
    const id = i === 0 && shareId ? sourceId : `${sourceId}#u${i}`
    out.push({ sourceId: id, role: "user", text: segment, ...projection, tools: [], parts: [], ...(at !== undefined ? { at } : {}) })
  }
}

// A FENCE CORRECTION IS NOT A MESSAGE (see isParkCorrection): the record carrying it never renders, and
// the one mark it leaves on the chat is that the fence it refused stops drawing.
//
// It is a per-fold closure because ONE delivery reaches the JSONL through up to three carriers — the
// `queue-operation enqueue`, the `queued_command` attachment, and the plain user record — and every one
// of them has to be dropped or the correction simply renders through the carrier that was missed. That
// is also why the MARK is deduped by text: the attachment routinely lands well after the worker has
// already replied (measured p50 20.9s, max 9.6min), so a second walk from there would reach past the
// refused fence and mark the worker's re-fence, which is the good one.
//
// A CORRECTION MERGED WITH OTHER WAKES is still a correction (see parseMergedWake): the scheduler sends
// everything waiting for a thread as one message, and a refused fence is very often waiting beside the
// shell whose exit refused it. Its lead is then a section down, so the prefix test alone missed it and
// the refused fence kept its hourglass card. The mark is taken from the section; the record is dropped
// only when corrections are ALL it carries — its other wakes still have to render, and the chat leaves
// the correction's section out when it draws them.
export type CorrectionSink = (text: string) => boolean
export function createCorrectionSink(out: TranscriptMessage[]): CorrectionSink {
  const marked = new Set<string>()
  const refuse = (correction: string) => {
    if (marked.has(correction)) return
    marked.add(correction)
    markFenceRefused(out)
  }
  return (text: string) => {
    // A MOVED THREAD'S ARRIVAL TURN (thread-move.ts) is dropped by the same sink, because every carrier of
    // a delivery — the enqueue, the queued_command attachment, the user record — already asks it. The move
    // draws as its own divider; the wake is the worker's alone. It marks no fence.
    if (isMoveArrivalWake(text)) return true
    if (isParkCorrection(text)) {
      refuse(text)
      return true
    }
    const merged = parseMergedWake(text)
    if (!merged) return false
    const corrections = merged.filter((part) => isParkCorrection(part.body))
    for (const part of corrections) refuse(part.body)
    return corrections.length === merged.length
  }
}

// The rest a correction answers is the newest assistant PROSE message, because that is the only fence
// the scheduler ever corrects: SOURCE 12 reads `tele.lastFence`, minted at `tele.lastAssistantAt`, and
// only ever speaks while the thread is idle. So the walk steps over dividers and tool-only messages
// (neither carries a fence), takes the first message that has prose, and stops — at a user turn it stops
// without marking anything, because a correction never reaches back past one.
//
// A fence that does not parse as `awaiting` leaves the message untouched rather than falling through to
// an older one. The correction is about THIS rest; if its fence cannot be read, nothing is refused.
function markFenceRefused(out: TranscriptMessage[]): void {
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]
    if (m.role === "user") return
    if (m.kind || !m.text.trim()) continue
    if (parseSignalFence(m.text)?.kind === "awaiting") m.fenceRefused = true
    return
  }
}
