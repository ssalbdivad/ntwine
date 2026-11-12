import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  frameMessage,
  generatePairCode,
  generatePeerKey,
  normalizePairCode,
  openRequest,
  pairMac,
  PeerCryptoError,
  sealRequest,
  unframeMessage,
} from "./peer-crypto.ts"

const alice = generatePeerKey()
const bob = generatePeerKey()
const carol = generatePeerKey()
const pairedWithAlice = (sender: Buffer) => sender.equals(alice.publicKey)

describe("the peer envelope", () => {
  it("carries a request and its answer between two paired machines", () => {
    const sent = sealRequest(alice, bob.publicKey, frameMessage({ op: "ping" }, Buffer.from("bundle")))
    const received = openRequest(bob, sent.body, pairedWithAlice)
    assert.deepEqual(received.sender, alice.publicKey)
    assert.deepEqual(unframeMessage(received.plaintext), { head: { op: "ping" }, blob: Buffer.from("bundle") })
    const answer = sent.openResponse(received.sealResponse(Buffer.from("pong")))
    assert.equal(answer.toString(), "pong")
  })

  it("refuses a sender the receiver has not paired with, before any key exchange", () => {
    const sent = sealRequest(carol, bob.publicKey, Buffer.from("hi"))
    let asked: Buffer | undefined
    assert.throws(() => openRequest(bob, sent.body, (sender) => { asked = sender; return false }), { message: "unknown sender" })
    assert.deepEqual(asked, carol.publicKey)
  })

  it("fails authentication on a single flipped byte, in the header or the ciphertext", () => {
    const sent = sealRequest(alice, bob.publicKey, Buffer.from("move this thread"))
    // Byte 40 is inside the ephemeral key; the last byte is the GCM tag.
    for (const at of [40, sent.body.length - 1, sent.body.length - 20]) {
      const tampered = Buffer.from(sent.body)
      tampered[at]! ^= 1
      assert.throws(() => openRequest(bob, tampered, pairedWithAlice), PeerCryptoError, `byte ${at}`)
    }
  })

  it("cannot be opened by a machine it was not sealed for, even one paired with the sender", () => {
    const sent = sealRequest(alice, bob.publicKey, Buffer.from("for bob"))
    assert.throws(() => openRequest(carol, sent.body, pairedWithAlice), { message: "message failed authentication" })
  })

  it("does not let a forged answer through: only the addressed machine can seal the response", () => {
    const sent = sealRequest(alice, bob.publicKey, Buffer.from("q"))
    const other = sealRequest(alice, bob.publicKey, Buffer.from("q"))
    const answerToOther = openRequest(bob, other.body, pairedWithAlice).sealResponse(Buffer.from("a"))
    assert.throws(() => sent.openResponse(answerToOther), PeerCryptoError)
  })

  it("refuses a body that is not an envelope at all", () => {
    assert.throws(() => openRequest(bob, Buffer.from("POST / HTTP/1.1"), pairedWithAlice), { message: "not an ntwine peer request" })
  })
})

describe("pairing codes", () => {
  it("are 60 bits as three groups of four, and survive the usual misreadings when typed back", () => {
    const code = generatePairCode()
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
    assert.equal(normalizePairCode("7k3m 9qwt-x2pb"), "7K3M9QWTX2PB")
    assert.equal(normalizePairCode("OOOO-IIII-LLLL"), "000011111111")
    assert.equal(normalizePairCode("7K3M-9QWT"), undefined)
    assert.equal(normalizePairCode("7K3M-9QWT-X2PU"), undefined)
  })

  it("MAC each direction under its own label, so an answer can never be replayed as a request", () => {
    const hello = JSON.stringify({ name: "mac" })
    assert.notEqual(pairMac("7K3M9QWTX2PB", "request", hello), pairMac("7K3M9QWTX2PB", "response", hello))
    assert.notEqual(pairMac("7K3M9QWTX2PB", "request", hello), pairMac("7K3M9QWTX2PC", "request", hello))
    // Parts are delimited, so moving a boundary changes the MAC.
    assert.notEqual(pairMac("7K3M9QWTX2PB", "response", "ab", "c"), pairMac("7K3M9QWTX2PB", "response", "a", "bc"))
  })
})
