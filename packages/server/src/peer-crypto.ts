import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto"

// THE CHANNEL BETWEEN TWO PAIRED NTWINE SERVERS (plans/thread-handoff.md § 4).
//
// Moving a thread sends its transcript to another machine, and a transcript holds whatever passed
// through the agent's tools — secrets included. Nothing in ntwine authenticated one server to another
// before this, and nothing encrypted anything (the claim key only signs). So this is a deliberately
// small construction on node:crypto alone, with no dependency and no negotiation:
//
// - Each machine holds one X25519 key. Pairing (below) is how two machines learn each other's.
// - Every request is ONE message shaped like the Noise K pattern (`-> e, es, ss`): the sender's static
//   key and a fresh ephemeral key head the body, and the AEAD key is HKDF over both DH results. Only a
//   machine holding a paired static key can produce a request the receiver opens (`ss`), the key is
//   fresh per request (`es`), and the response is sealed under a sibling key that only the receiver
//   could also derive, so the sender knows who answered.
// - AES-256-GCM with the header as associated data, and a nonce of zero: every key encrypts exactly
//   one message in each direction, because each request brings its own ephemeral key.
//
// What it does NOT give: forward secrecy against theft of the RECEIVER's static key (the one-way K
// pattern cannot). Whoever holds a recorded transfer and that machine's `peer.key` could read it — and
// could just as well read the transcripts on that same disk, where they sit in the clear. Replay is the
// caller's job (a timestamp window and a cache of request ids, peer-service.ts), because only the caller
// keeps state across requests.

const KEY_BYTES = 32
const TAG_BYTES = 16
const ZERO_NONCE = Buffer.alloc(12)
/** `ntwP` + protocol version 1. Anything else is refused before any key is touched. */
export const ENVELOPE_MAGIC = Buffer.from([0x6e, 0x74, 0x77, 0x50, 0x01])
export const ENVELOPE_HEADER_BYTES = ENVELOPE_MAGIC.length + KEY_BYTES * 2
const LABEL = "ntwine-peer-v1"

export interface PeerKeyPair {
  privateKey: KeyObject
  /** The raw 32-byte X25519 public key. */
  publicKey: Buffer
}

export function generatePeerKey(): PeerKeyPair {
  const { privateKey } = generateKeyPairSync("x25519")
  return { privateKey, publicKey: rawPublicKey(privateKey) }
}

/** PKCS#8 DER, the form `peer.key` stores. */
export function exportPeerKey(key: PeerKeyPair): Buffer {
  return key.privateKey.export({ format: "der", type: "pkcs8" })
}

/** Undefined for anything that is not an X25519 private key — the caller decides how loud to be. */
export function peerKeyFromPkcs8(der: Buffer): PeerKeyPair | undefined {
  try {
    const privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" })
    if (privateKey.asymmetricKeyType !== "x25519") return undefined
    return { privateKey, publicKey: rawPublicKey(privateKey) }
  } catch {
    return undefined
  }
}

function rawPublicKey(privateKey: KeyObject): Buffer {
  const jwk = createPublicKey(privateKey).export({ format: "jwk" })
  if (typeof jwk.x !== "string") throw new Error("X25519 key has no public half")
  return Buffer.from(jwk.x, "base64url")
}

/** A raw public key as a KeyObject. Throws on anything that is not 32 bytes. */
export function publicKeyObject(raw: Buffer): KeyObject {
  if (raw.length !== KEY_BYTES) throw new Error("not an X25519 public key")
  return createPublicKey({ key: { kty: "OKP", crv: "X25519", x: raw.toString("base64url") }, format: "jwk" })
}

/** A machine's id: the first 16 bytes of SHA-256 over its public key, hex. */
export function peerIdOf(publicKey: Buffer): string {
  return createHash("sha256").update(publicKey).digest("hex").slice(0, 32)
}

/** The id in groups a person can compare across two screens: "3f9a 21c0 7b2e 9d11". */
export function peerFingerprint(id: string): string {
  return id.slice(0, 16).replace(/(.{4})(?=.)/g, "$1 ")
}

/**
 * X25519, refusing the all-zero output a low-order public key produces — the one way a malicious
 * peer could force a known shared secret. Node computes the DH without that check.
 */
function dh(privateKey: KeyObject, publicRaw: Buffer): Buffer {
  const out = diffieHellman({ privateKey, publicKey: publicKeyObject(publicRaw) })
  if (out.every((byte) => byte === 0)) throw new PeerCryptoError("degenerate key exchange")
  return out
}

export class PeerCryptoError extends Error {}

interface ChannelKeys {
  request: Buffer
  response: Buffer
}

function channelKeys(es: Buffer, ss: Buffer, header: Buffer, recipient: Buffer): ChannelKeys {
  const ikm = Buffer.concat([es, ss])
  // The salt binds the whole header (sender static, ephemeral) AND the recipient, so a request sealed
  // for one machine cannot be re-addressed to another that happens to share the sender.
  const salt = createHash("sha256").update(LABEL).update(header).update(recipient).digest()
  const derive = (info: string) => Buffer.from(hkdfSync("sha256", ikm, salt, `${LABEL} ${info}`, KEY_BYTES))
  return { request: derive("request"), response: derive("response") }
}

function seal(key: Buffer, aad: Buffer, plaintext: Buffer): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, ZERO_NONCE)
  cipher.setAAD(aad)
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([body, cipher.getAuthTag()])
}

function open(key: Buffer, aad: Buffer, sealed: Buffer): Buffer {
  if (sealed.length < TAG_BYTES) throw new PeerCryptoError("truncated message")
  const decipher = createDecipheriv("aes-256-gcm", key, ZERO_NONCE)
  decipher.setAAD(aad)
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES))
  try {
    // Nothing decrypted is returned before final() has checked the tag.
    return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final()])
  } catch {
    throw new PeerCryptoError("message failed authentication")
  }
}

/** What the sender keeps to read the answer. */
export interface SentRequest {
  body: Buffer
  openResponse(sealed: Buffer): Buffer
}

/** Seal one request from `sender` to the machine whose public key is `recipient`. */
export function sealRequest(sender: PeerKeyPair, recipient: Buffer, plaintext: Buffer): SentRequest {
  const ephemeral = generatePeerKey()
  const header = Buffer.concat([ENVELOPE_MAGIC, sender.publicKey, ephemeral.publicKey])
  const keys = channelKeys(dh(ephemeral.privateKey, recipient), dh(sender.privateKey, recipient), header, recipient)
  return {
    body: Buffer.concat([header, seal(keys.request, header, plaintext)]),
    openResponse: (sealed) => open(keys.response, responseAad(header), sealed),
  }
}

/** The sender's public key out of a request body, before anything is decrypted — or undefined. */
export function requestSender(body: Buffer): Buffer | undefined {
  if (body.length < ENVELOPE_HEADER_BYTES + TAG_BYTES) return undefined
  if (!body.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC)) return undefined
  return Buffer.from(body.subarray(ENVELOPE_MAGIC.length, ENVELOPE_MAGIC.length + KEY_BYTES))
}

export interface ReceivedRequest {
  sender: Buffer
  plaintext: Buffer
  sealResponse(plaintext: Buffer): Buffer
}

/**
 * Open a request addressed to `recipient`. `isPaired` is asked about the sender's key BEFORE any DH,
 * so a stranger's request costs a header read and nothing else. Throws PeerCryptoError on anything
 * that is not a request this machine can authenticate.
 */
export function openRequest(recipient: PeerKeyPair, body: Buffer, isPaired: (sender: Buffer) => boolean): ReceivedRequest {
  const sender = requestSender(body)
  if (!sender) throw new PeerCryptoError("not an ntwine peer request")
  if (!isPaired(sender)) throw new PeerCryptoError("unknown sender")
  const header = Buffer.from(body.subarray(0, ENVELOPE_HEADER_BYTES))
  const ephemeral = Buffer.from(body.subarray(ENVELOPE_MAGIC.length + KEY_BYTES, ENVELOPE_HEADER_BYTES))
  const keys = channelKeys(dh(recipient.privateKey, ephemeral), dh(recipient.privateKey, sender), header, recipient.publicKey)
  const plaintext = open(keys.request, header, body.subarray(ENVELOPE_HEADER_BYTES))
  return { sender, plaintext, sealResponse: (reply) => seal(keys.response, responseAad(header), reply) }
}

function responseAad(header: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${LABEL} response`), header])
}

// ---- the plaintext inside an envelope: a JSON head and an optional binary tail ----

/** `[u32 BE length][JSON][blob]` — the bundle rides as raw bytes, never base64 inside the JSON. */
export function frameMessage(head: unknown, blob?: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(head), "utf8")
  const length = Buffer.alloc(4)
  length.writeUInt32BE(json.length)
  return Buffer.concat([length, json, blob ?? Buffer.alloc(0)])
}

export function unframeMessage(plaintext: Buffer): { head: unknown; blob: Buffer } {
  if (plaintext.length < 4) throw new PeerCryptoError("truncated frame")
  const length = plaintext.readUInt32BE(0)
  if (4 + length > plaintext.length) throw new PeerCryptoError("truncated frame")
  let head: unknown
  try {
    head = JSON.parse(plaintext.subarray(4, 4 + length).toString("utf8"))
  } catch {
    throw new PeerCryptoError("malformed frame")
  }
  return { head, blob: plaintext.subarray(4 + length) }
}

// ---- pairing: a short code shown on one machine and typed on the other ----

/** Crockford base32: no I, L, O or U, so a typed code survives the usual misreadings. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
export const PAIR_CODE_CHARS = 12

/** 60 bits as `XXXX-XXXX-XXXX`. */
export function generatePairCode(): string {
  const bytes = randomBytes(PAIR_CODE_CHARS)
  const chars = [...bytes].map((byte) => CODE_ALPHABET[byte & 31])
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)].map((group) => group.join("")).join("-")
}

/** What a human typed, in the form the code was minted in — or undefined when it cannot be one. */
export function normalizePairCode(typed: string): string | undefined {
  const cleaned = typed.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1")
  if (cleaned.length !== PAIR_CODE_CHARS || [...cleaned].some((char) => !CODE_ALPHABET.includes(char))) return undefined
  return cleaned
}

function pairKey(code: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(code, "utf8"), "ntwine-pair-v1", "", KEY_BYTES))
}

/**
 * The MAC over one pairing message. `role` keeps the two directions apart, so the answer can never be
 * replayed as a request; the response's MAC covers the request too, binding the two keys together.
 */
export function pairMac(code: string, role: "request" | "response", ...parts: string[]): string {
  const hmac = createHmac("sha256", pairKey(code)).update(`ntwine-pair-v1 ${role}`)
  for (const part of parts) hmac.update("\0").update(part)
  return hmac.digest("hex")
}

export function macsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8")
  const right = Buffer.from(b, "utf8")
  return left.length === right.length && timingSafeEqual(left, right)
}
