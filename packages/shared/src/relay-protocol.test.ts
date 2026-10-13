import assert from "node:assert/strict"
import test from "node:test"
import {
  RELAY_MAX_FRAME_BODY,
  RELAY_PROTOCOL_VERSION,
  decodeBody,
  encodeBody,
  parseFrame,
  relayHandshakeInput,
  serializeFrame,
  stripHopByHop,
  type RelayFrame,
} from "./relay-protocol.ts"

test("a frame survives the round trip unchanged", () => {
  const frames: RelayFrame[] = [
    { t: "req", id: "1", method: "GET", url: "https://a.frizz.sh/x", headers: [["accept", "*/*"]] },
    { t: "res", id: "1", status: 200, headers: [["content-type", "text/html"]], body: "aGk=", end: true },
    { t: "res-chunk", id: "1", data: "ZGF0YTogaGkK" },
    { t: "ws-open", id: "2", url: "wss://a.frizz.sh/t", headers: [] },
    { t: "ws-msg", id: "2", data: "aGk=", binary: true },
  ]
  for (const frame of frames) assert.deepEqual(parseFrame(serializeFrame(frame)), frame)
})

test("junk on the wire is rejected rather than trusted", () => {
  // Both ends feed this straight from a socket anyone can open.
  for (const junk of ["", "{", "null", "[]", '"str"', "42", '{"id":"1"}', '{"t":"req"}', '{"t":1,"id":"1"}']) {
    assert.equal(parseFrame(junk), null, JSON.stringify(junk))
  }
})

test("a body of arbitrary bytes survives base64", () => {
  const bytes = new Uint8Array(256).map((_, i) => i)
  assert.deepEqual(decodeBody(encodeBody(bytes)), bytes)
  assert.deepEqual(decodeBody(encodeBody(new Uint8Array())), new Uint8Array())
})

test("hop-by-hop headers are dropped, and content-length with them", () => {
  // They describe one connection, so replaying them onto another is wrong. A stale content-length on
  // a streamed body is worse than wrong: it truncates the response.
  const kept = stripHopByHop([
    ["Content-Type", "text/html"],
    ["Connection", "keep-alive"],
    ["Transfer-Encoding", "chunked"],
    ["Content-Length", "42"],
    ["Upgrade", "websocket"],
    ["X-Ntwine", "keep"],
  ])
  assert.deepEqual(kept, [
    ["Content-Type", "text/html"],
    ["X-Ntwine", "keep"],
  ])
})

test("the single-frame body ceiling stays under a Cloudflare WebSocket message", () => {
  // A message caps at 1 MiB and base64 adds a third, so a frame at the limit must still fit.
  assert.ok(RELAY_MAX_FRAME_BODY * (4 / 3) < 1024 * 1024, "a full frame would exceed 1 MiB encoded")
})

test("the handshake signs a fixed-order string, and every field changes it", () => {
  const base = new TextDecoder().decode(relayHandshakeInput("ada", "PUB", 5))
  assert.equal(base, `frizz-relay:v${RELAY_PROTOCOL_VERSION}:ada:PUB:5`)
  for (const [name, pubkey, at] of [["eve", "PUB", 5], ["ada", "OTHER", 5], ["ada", "PUB", 6]] as const) {
    assert.notEqual(new TextDecoder().decode(relayHandshakeInput(name, pubkey, at)), base)
  }
})
