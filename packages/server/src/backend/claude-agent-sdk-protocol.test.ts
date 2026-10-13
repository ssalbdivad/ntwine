import { test } from "node:test"
import assert from "node:assert/strict"
import {
  CLAUDE_AGENT_SDK_MAX_INPUT_BYTES,
  ClaudeAgentSdkProtocolError,
  boundedJsonObject,
  safeText,
  validateInputMessage,
} from "./claude-agent-sdk-protocol.ts"

const INPUT_ID = "11111111-2222-4333-8444-555555555555"
const ZWJ = String.fromCodePoint(0x200d)
const WOMAN_TECHNOLOGIST = String.fromCodePoint(0x1f469) + ZWJ + String.fromCodePoint(0x1f4bb)
const FAMILY = String.fromCodePoint(0x1f468) + ZWJ + String.fromCodePoint(0x1f469) + ZWJ + String.fromCodePoint(0x1f467)
const RAINBOW_FLAG = String.fromCodePoint(0x1f3f3) + String.fromCodePoint(0xfe0f) + ZWJ + String.fromCodePoint(0x1f308)
const ROCKET = String.fromCodePoint(0x1f680)

// A prompt body is a NARROWER class than every other string that crosses this membrane.
//
// Live incident, 2026-07-31: a broker-backed thread went silent for nine minutes because the operator's
// follow-ups were not arriving and nothing said why. `UNSAFE_TEXT` — the DISPLAY/authority policy —
// rejects the whole \p{Cf} family, and U+200D ZERO WIDTH JOINER is in it, so every multi-part emoji was
// refused. The daemon then SWALLOWED the refusal (`void handle.send(...).catch(() => {})`), so the
// message vanished after ntwine had already answered its RPC with success. Proven with a one-variable
// differential against a real daemon in `_live_broker_input_drop.mts`: one sentence delivered plain and
// the same sentence disappeared with a single emoji appended.
//
// A prompt body is not a rendered tool argument and not a permission `input` — it is the human's own
// words on their way into a user message's `content`. So it gets its own class, and every OTHER string
// keeps the strict policy (asserted at the bottom of this file).
test("a prompt body carries the zero-width joiner every multi-part emoji is built from", () => {
  const accepted = [
    `look at this ${WOMAN_TECHNOLOGIST}`,
    `pride ${RAINBOW_FLAG}`,
    `family ${FAMILY}`,
    `ship it ${ROCKET}`, // an ordinary surrogate PAIR must survive
    `hello${String.fromCodePoint(0x200b)}world`, // zero-width space
    `${String.fromCodePoint(0xfeff)}pasted with a BOM`,
    `co${String.fromCodePoint(0xad)}operate`, // soft hyphen
    `unsafe${String.fromCodePoint(0x61c)}input`, // Arabic letter mark
    `क्${String.fromCodePoint(0x200c)}ष`, // Devanagari, where ZWNJ is meaningful orthography
    "line1\nline2\tend", // tab/newline/CR stay legal in a body
    "a\r\nb",
  ]
  for (const text of accepted) {
    // The accepted bytes must be EXACTLY the bytes supplied — never a sanitized copy.
    assert.equal(validateInputMessage({ id: INPUT_ID, text }).text, text, `refused ${JSON.stringify(text)}`)
  }
})

test("a prompt body still refuses what cannot survive the wire", () => {
  // C0 (minus tab/newline/CR), DEL, C1, and the line/paragraph separators.
  for (const code of [0, 8, 11, 12, 27, 31, 127, 0x85, 0x2028, 0x2029]) {
    assert.throws(
      () => validateInputMessage({ id: INPUT_ID, text: `a${String.fromCodePoint(code)}b` }),
      ClaudeAgentSdkProtocolError,
      `U+${code.toString(16).padStart(4, "0").toUpperCase()} was accepted into a prompt body`,
    )
  }
  // A LONE surrogate is not encodable as UTF-8 on the wire. A PAIR is one astral code point and passes
  // (asserted above) — iterating by code point is what tells the two apart.
  assert.throws(() => validateInputMessage({ id: INPUT_ID, text: `a${String.fromCharCode(0xd800)}b` }), ClaudeAgentSdkProtocolError)
  assert.throws(() => validateInputMessage({ id: INPUT_ID, text: `a${String.fromCharCode(0xdc00)}b` }), ClaudeAgentSdkProtocolError)
  // The byte cap is unchanged, and refuses rather than truncating.
  assert.equal(validateInputMessage({ id: INPUT_ID, text: "x".repeat(CLAUDE_AGENT_SDK_MAX_INPUT_BYTES) }).text.length, CLAUDE_AGENT_SDK_MAX_INPUT_BYTES)
  assert.throws(() => validateInputMessage({ id: INPUT_ID, text: "x".repeat(CLAUDE_AGENT_SDK_MAX_INPUT_BYTES + 1) }), /exceeds/)
})

test("the display and authority validators keep the STRICT policy the prompt body relaxed", () => {
  // This is the half that must not move. `safeText` renders provider-authored strings back to the
  // operator, so an invisible bidi/format character there is a spoofing surface; `boundedJsonObject`
  // validates a permission `input`, which decides what the provider is authorized to execute.
  assert.equal(safeText(`a${ZWJ}b`, "event.text").includes(ZWJ), false, "safeText let a format char through")
  assert.throws(
    () => boundedJsonObject({ command: `printf ${String.fromCodePoint(27)}[31m` }, "permission.input"),
    (error: unknown) => error instanceof ClaudeAgentSdkProtocolError && /unsafe text/.test((error as Error).message),
    "control bytes in a permission input are still rejected — that strictness is deliberate",
  )
})
