import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { PeerView } from "@ntwine/shared"
import { ntwinePaths } from "./ntwine-paths.ts"
import {
  exportPeerKey,
  generatePairCode,
  generatePeerKey,
  normalizePairCode,
  peerFingerprint,
  peerIdOf,
  peerKeyFromPkcs8,
  type PeerKeyPair,
} from "./peer-crypto.ts"

// WHICH MACHINES THIS ONE TRUSTS, and the key it proves itself with (plans/thread-handoff.md § 4).
//
// Both files sit beside `identity.key` in the state root, 0600. They are machine-wide: the server is a
// singleton serving every project, and a pairing is between two machines, not two projects.

export function peerKeyPath(home = homedir()): string {
  return join(ntwinePaths({ home }).state, "peer.key")
}

export function peersFilePath(home = homedir()): string {
  return join(ntwinePaths({ home }).state, "peers.json")
}

/**
 * Load this machine's peer key, or make it on first use.
 *
 * The same policy as the claim key (src/identity.ts), for the same reason: a key that silently changed
 * would make every paired machine refuse this one with nothing to say why. So an unreadable key is an
 * error naming the file, never a quiet replacement.
 */
export function loadOrCreatePeerKey(home = homedir()): PeerKeyPair {
  const path = peerKeyPath(home)
  let stored: Buffer | undefined
  try {
    stored = readFileSync(path)
  } catch {
    stored = undefined
  }
  if (stored !== undefined) {
    const key = peerKeyFromPkcs8(stored)
    if (key) return key
    throw new Error(`${path} is not a usable ntwine machine key. Machines paired with this one know it by that key, so it is not replaced automatically: restore it from a backup, or delete it and pair again.`)
  }
  const key = generatePeerKey()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, exportPeerKey(key), { mode: 0o600, flag: "wx" })
  return key
}

export interface PeerRecord {
  id: string
  name: string
  url: string
  /** Raw X25519 public key, base64url. */
  publicKey: string
  pairedAt: string
  lastSeenAt?: string
  lastError?: string
}

export interface PeerListenerConfig {
  enabled: boolean
  port: number
}

export const DEFAULT_PEER_PORT = 9394

interface PeersFile {
  v: 1
  peers: PeerRecord[]
  listener?: PeerListenerConfig
}

export interface PeerStore {
  list(): PeerRecord[]
  get(id: string): PeerRecord | undefined
  byPublicKey(publicKey: Buffer): PeerRecord | undefined
  /** Add or replace (same machine paired again) the record for this key. */
  upsert(record: Omit<PeerRecord, "id">): PeerRecord
  update(id: string, patch: Partial<Pick<PeerRecord, "name" | "url" | "lastSeenAt" | "lastError">>): PeerRecord | undefined
  remove(id: string): boolean
  listener(): PeerListenerConfig
  setListener(config: PeerListenerConfig): void
}

/** Read through on every call: the file is tiny, and a second process (a test, a CLI) may write it. */
export function openPeerStore(path = peersFilePath()): PeerStore {
  const read = (): PeersFile => {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PeersFile>
      if (parsed && parsed.v === 1 && Array.isArray(parsed.peers)) return { v: 1, peers: parsed.peers.filter(isPeerRecord), ...(parsed.listener ? { listener: parsed.listener } : {}) }
    } catch {
      // absent or unreadable: no peers. Unlike the key, nothing is lost that pairing cannot rebuild.
    }
    return { v: 1, peers: [] }
  }
  const write = (file: PeersFile) => {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, path)
  }
  return {
    list: () => read().peers,
    get: (id) => read().peers.find((peer) => peer.id === id),
    byPublicKey: (publicKey) => {
      const encoded = publicKey.toString("base64url")
      return read().peers.find((peer) => peer.publicKey === encoded)
    },
    upsert: (record) => {
      const file = read()
      const id = peerIdOf(Buffer.from(record.publicKey, "base64url"))
      const next: PeerRecord = { ...record, id }
      file.peers = [...file.peers.filter((peer) => peer.id !== id), next]
      write(file)
      return next
    },
    update: (id, patch) => {
      const file = read()
      const index = file.peers.findIndex((peer) => peer.id === id)
      if (index < 0) return undefined
      const next = { ...file.peers[index]!, ...patch }
      for (const key of Object.keys(patch) as (keyof typeof patch)[]) if (patch[key] === undefined) delete next[key]
      file.peers[index] = next
      write(file)
      return next
    },
    remove: (id) => {
      const file = read()
      const before = file.peers.length
      file.peers = file.peers.filter((peer) => peer.id !== id)
      if (file.peers.length === before) return false
      write(file)
      return true
    },
    listener: () => read().listener ?? { enabled: false, port: DEFAULT_PEER_PORT },
    setListener: (config) => {
      const file = read()
      file.listener = config
      write(file)
    },
  }
}

function isPeerRecord(value: unknown): value is PeerRecord {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return typeof record.id === "string" && typeof record.name === "string" && typeof record.url === "string"
    && typeof record.publicKey === "string" && typeof record.pairedAt === "string"
}

export function peerView(record: PeerRecord): PeerView {
  return {
    id: record.id,
    name: record.name,
    url: record.url,
    fingerprint: peerFingerprint(record.id),
    pairedAt: record.pairedAt,
    ...(record.lastSeenAt ? { lastSeenAt: record.lastSeenAt } : {}),
    ...(record.lastError ? { lastError: record.lastError } : {}),
  }
}

// ---- request ids already answered: the replay cache, kept across a restart ----

/** Beside `peers.json` (and so in the state root in production), 0600 like it. */
export function seenRequestsPath(peersFile: string): string {
  return join(dirname(peersFile), "peer-seen.json")
}

export interface SeenRequests {
  /**
   * True when `id` is already recorded and not yet expired. Otherwise records it until `untilMs` — on
   * disk before returning, so a request is never acted on before its id would survive a crash — and
   * returns false. Throws when it cannot write: the caller refuses rather than act unrecorded.
   */
  seenOrRecord(id: string, untilMs: number, nowMs?: number): boolean
}

/**
 * The replay cache lived in memory until 2026-11-12, so a restart reopened the whole timestamp window:
 * a body recorded minutes earlier was answered, and acted on, again. The harmful case is an `import`
 * the destination REFUSED (say, a diverged branch): the origin saw the refusal and kept running the
 * thread; after the human fixed the cause and the destination restarted, the same recorded body
 * imported it — two live copies. So the ids are written through to a small file, every entry carrying
 * its own expiry, and pruned to the window on load and on every write. The file holds only ids that
 * authenticated as a paired machine's, a handful per move, so rewriting it whole (tmp + rename, as
 * `peers.json` is written) stays cheap.
 */
export function openSeenRequests(path: string, nowMs = Date.now()): SeenRequests {
  const seen = new Map<string, number>()
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { v?: unknown; ids?: unknown }
    if (parsed?.v === 1 && parsed.ids && typeof parsed.ids === "object") {
      for (const [id, until] of Object.entries(parsed.ids)) if (typeof until === "number" && until > nowMs) seen.set(id, until)
    }
  } catch {
    // Absent is the first run. Unreadable is a corrupt file; starting empty only reopens the window this
    // cache closes, and the clock window still bounds it.
  }
  const prune = (now: number) => {
    for (const [id, until] of seen) if (until <= now) seen.delete(id)
  }
  return {
    seenOrRecord: (id, untilMs, now = Date.now()) => {
      prune(now)
      if (seen.has(id)) return true
      const next = new Map(seen).set(id, untilMs)
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify({ v: 1, ids: Object.fromEntries(next) })}\n`, { mode: 0o600 })
      renameSync(tmp, path)
      seen.set(id, untilMs)
      return false
    },
  }
}

// ---- pairing codes: held in memory only, single use, short lived ----

export const PAIR_CODE_TTL_MS = 10 * 60_000
/** Wrong guesses a code survives. Past it the code is burned, so guessing it costs a new code each try. */
export const PAIR_CODE_MAX_FAILURES = 5

interface LiveCode {
  code: string
  expiresAt: number
}

export interface PairCodes {
  mint(nowMs?: number): { code: string; expiresAt: number }
  /** The live codes, normalized, for the MAC check — never more than a few. */
  live(nowMs?: number): string[]
  /** Spend a code that verified. False when it was spent or expired in between. */
  consume(code: string, nowMs?: number): boolean
  /** A request that matched no code. Burns every live code once the limit is reached. */
  fail(): void
}

export function createPairCodes(): PairCodes {
  let codes: LiveCode[] = []
  let failures = 0
  const prune = (now: number) => {
    codes = codes.filter((entry) => entry.expiresAt > now)
    if (codes.length === 0) failures = 0
  }
  return {
    mint: (now = Date.now()) => {
      prune(now)
      const code = generatePairCode()
      const entry = { code: normalizePairCode(code)!, expiresAt: now + PAIR_CODE_TTL_MS }
      // One live code at a time: pairing is one person at two keyboards, and every extra live code is
      // one more thing a guess can match.
      codes = [entry]
      failures = 0
      return { code, expiresAt: entry.expiresAt }
    },
    live: (now = Date.now()) => {
      prune(now)
      return codes.map((entry) => entry.code)
    },
    consume: (code, now = Date.now()) => {
      prune(now)
      const before = codes.length
      codes = codes.filter((entry) => entry.code !== code)
      return codes.length < before
    },
    fail: () => {
      failures += 1
      if (failures >= PAIR_CODE_MAX_FAILURES) {
        codes = []
        failures = 0
      }
    },
  }
}
