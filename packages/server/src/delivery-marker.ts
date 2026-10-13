// ── The invisible delivery marker ──────────────────────────────────────────────────────────────────
//
// WHY THIS EXISTS, AND WHAT OF IT STILL RUNS. ntwine used to steer a Claude worker by pasting into a
// human-facing TUI composer, and that channel REWROTE the bytes on the way through. Measured against a
// live claude 2.1.219 TUI, driven by ntwine's own paste sequence: the paste transport turned LF into CR,
// then the TUI's paste handler turned CR/CRLF back into LF and expanded every TAB into four spaces — so
// a tab-bearing send and a CRLF-bearing send both arrived as different bytes than ntwine sent. Confirming
// delivery by comparing those bytes was therefore inference, and every mangling class ntwine had not yet
// met stranded a send as "unconfirmed" while the agent had already read and acted on it.
//
// This replaced the inference with IDENTITY. Every follow-up ntwine pasted carried a marker encoding its
// deliveryId, so the correlator recognised its own send by looking the id up rather than by comparing
// prose. That was immune to any rewrite of the surrounding text, and it stayed correct when the TUI
// glued several sends into one submission — each constituent brought its own marker along.
//
// The broker path needs no marker: ntwine hands the SDK a `uuid` with every input and the SDK echoes it
// back on the record that materializes it, so delivery-ledger.ts resolves the send from that id (see its
// IDENTITY section) and nothing emits a marker any more. What still runs here is the READ side —
// decodeDeliveryMarkers for a record that predates the cutover, and above all stripDeliveryMarkers,
// which transcript.ts applies to every record so a marker in an older transcript can neither reach a
// human's eyes nor perturb a text comparison.
//
// ── Why zero-width, and why these three codepoints ────────────────────────────────────────────────
// The marker had to survive the channel and had to stay invisible to the human reading their own
// terminal. Measured on the same live TUI: U+200B / U+200C / U+2060 round-tripped BYTE-INTACT through
// the paste transport and the composer into the JSONL, and the terminal rendered the line with no
// visible artefact. They are also deliberately NOT matched by JavaScript's `\s`, so a marker can never
// be mistaken for the whitespace the ledger's text comparison collapses.
//
// The cost was honest and bounded: the model saw 34 invisible codepoints at the end of each steer. ntwine
// owns every surface that renders this text, so the marker is stripped from the transcript before the
// human ever sees it (see stripDeliveryMarkers).
//
// ── Why this cannot resolve the wrong send ────────────────────────────────────────────────────────
//  1. The tag is a 32-bit hash of the deliveryId, so two DIFFERENT sends colliding inside one ledger
//     (≤20 items) is a ~1-in-10^7 event — and the correlator does not gamble on it anyway: it refuses
//     the marker path for any tag held by more than one outstanding item and falls back to text.
//  2. A marker only ever resolves an item whose evidence is CONTEMPORANEOUS, exactly as text evidence
//     does. A replayed transcript cannot resurrect an old send.
//  3. A marker is never SYNTHESISED from anything the human typed — it is emitted only by ntwine's own
//     injection path, so a human pasting prose into the terminal cannot forge one.

const ZERO = "​" // ZERO WIDTH SPACE      → bit 0
const ONE = "‌" // ZERO WIDTH NON-JOINER → bit 1
const EDGE = "⁠" // WORD JOINER           → delimiter

const TAG_BITS = 32

// Every codepoint this module may ever emit — the strip set. Kept separate from the marker grammar so
// stripping stays total: a truncated or half-mangled marker still leaves no visible residue behind.
const MARKER_CHARS = new RegExp(`[${ZERO}${ONE}${EDGE}]`, "g")
const MARKER_RE = new RegExp(`${EDGE}[${ZERO}${ONE}]{${TAG_BITS}}${EDGE}`, "g")

// FNV-1a over the deliveryId. Any stable 32-bit digest would do; this one is dependency-free and its
// avalanche is far better than the id's own leading hex, which for a v4 UUID is not uniformly random
// across the generators ntwine has used.
export function deliveryTag(deliveryId: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < deliveryId.length; i++) {
    hash ^= deliveryId.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

export function encodeDeliveryMarker(deliveryId: string): string {
  const bits = deliveryTag(deliveryId).toString(2).padStart(TAG_BITS, "0")
  let out = EDGE
  for (const bit of bits) out += bit === "1" ? ONE : ZERO
  return out + EDGE
}

// Every well-formed tag in `text`, in order. A malformed or truncated marker yields nothing — the
// caller then falls back to text correlation, which is the pre-marker behaviour.
export function decodeDeliveryMarkers(text: string): number[] {
  const out: number[] = []
  for (const match of text.matchAll(MARKER_RE)) {
    const bits = match[0].slice(EDGE.length, -EDGE.length)
    let value = 0
    for (const ch of bits) value = ((value << 1) | (ch === ONE ? 1 : 0)) >>> 0
    out.push(value >>> 0)
  }
  return out
}

// Remove every marker codepoint. Used on transcript text so the human never sees a marker, and on the
// ledger's own comparisons so a marked record still matches an unmarked item. It was used on a third
// surface too — the composer captures the submit-confirmer read, to recognise ntwine's own unsent text
// in the worker's terminal — until delivery-confirm.ts went with the rest of that apparatus (8a57e29).
// Cheap-exits on the overwhelmingly common marker-free string.
export function stripDeliveryMarkers(text: string): string {
  if (!text.includes(EDGE) && !text.includes(ZERO) && !text.includes(ONE)) return text
  return text.replace(MARKER_CHARS, "")
}

// Non-global twin: `MARKER_RE` carries /g for matchAll, and /g + .test() is a lastIndex footgun.
const MARKER_ONCE = new RegExp(MARKER_RE.source)

export function hasDeliveryMarker(text: string): boolean {
  return MARKER_ONCE.test(text)
}
