import { z } from "zod"
import { ThreadSlug } from "./thread-slug.ts"

// MOVING A THREAD TO ANOTHER MACHINE (plans/thread-handoff.md).
//
// Two ntwine servers pair once and then hand a resting thread from one to the other: its rows, its
// transcript, its scratch notes and its uncommitted work. Exactly one machine owns a thread at a time;
// the one it left keeps a read-only stub that says where it went. These are the shapes the browser and
// the server agree on. The wire protocol between the two servers is the server's business
// (peer-protocol.ts) and never reaches the browser.

/** A machine's id: the first 16 bytes of SHA-256 over its X25519 peer key, as hex. */
export const PeerId = z.string().regex(/^[0-9a-f]{32}$/)
export type PeerId = z.infer<typeof PeerId>

/** Where a paired machine is reached: an http(s) origin, no path. */
export const PeerAddress = z.string().trim().min(1).max(300)

/** A paired machine, as Settings lists it. */
export const PeerView = z.object({
  id: PeerId,
  name: z.string(),
  /** The address this machine sends to. Empty when the other machine had none to offer at pairing. */
  url: z.string(),
  /** A short, human-comparable form of the id ("3f9a 21c0"). */
  fingerprint: z.string(),
  pairedAt: z.string(),
  lastSeenAt: z.string().optional(),
  /** The last send's failure, cleared by the next success. */
  lastError: z.string().optional(),
})
export type PeerView = z.infer<typeof PeerView>

export const PeerListener = z.object({
  enabled: z.boolean(),
  port: z.number().int(),
  /** Why it is not listening although enabled — a port taken, an address that would not bind. */
  error: z.string().optional(),
})
export type PeerListener = z.infer<typeof PeerListener>

export const PeersState = z.object({
  self: z.object({
    name: z.string(),
    id: PeerId,
    fingerprint: z.string(),
    /** The addresses another machine could use for this one, best first. May be empty. */
    addresses: z.array(z.string()),
  }),
  listener: PeerListener,
  peers: z.array(PeerView),
})
export type PeersState = z.infer<typeof PeersState>

/** The single-use code this machine shows so another machine can pair with it. */
export const PeerPairCode = z.object({
  code: z.string(),
  expiresAt: z.string(),
  addresses: z.array(z.string()),
})
export type PeerPairCode = z.infer<typeof PeerPairCode>

export const PeerPairJoinInput = z.object({
  url: PeerAddress,
  code: z.string().trim().min(1).max(40),
}).strict()
export type PeerPairJoinInput = z.infer<typeof PeerPairJoinInput>

export const PeerIdInput = z.object({ id: PeerId }).strict()
export type PeerIdInput = z.infer<typeof PeerIdInput>

export const PeerSetAddressInput = z.object({ id: PeerId, url: PeerAddress }).strict()
export type PeerSetAddressInput = z.infer<typeof PeerSetAddressInput>

export const PeerListenerInput = z.object({
  enabled: z.boolean(),
  port: z.number().int().min(1024).max(65535).optional(),
}).strict()
export type PeerListenerInput = z.infer<typeof PeerListenerInput>

export const PeerPingResult = z.object({ name: z.string(), ms: z.number() })
export type PeerPingResult = z.infer<typeof PeerPingResult>

export const ThreadMoveInput = z.object({ slug: ThreadSlug, peerId: PeerId }).strict()
export type ThreadMoveInput = z.infer<typeof ThreadMoveInput>
export const ThreadMoveSlugInput = z.object({ slug: ThreadSlug }).strict()
export type ThreadMoveSlugInput = z.infer<typeof ThreadMoveSlugInput>

/**
 * What a move would do, checked on both machines before anything changes. `refusal` set means it
 * cannot run now, and says why in the human's words.
 */
export const ThreadMovePreview = z.object({
  peer: z.object({ id: PeerId, name: z.string() }),
  refusal: z.string().optional(),
  /** The destination's checkout of the project, when it has one. */
  destination: z.object({ project: z.string(), dir: z.string() }).optional(),
  /** Which checkout the thread works in, relative to the project ("." is the main checkout). */
  checkout: z.object({ rel: z.string(), branch: z.string().nullable() }).optional(),
  /** Uncommitted files that move with the thread. */
  wipPaths: z.array(z.string()).default([]),
  /** Uncommitted files in a shared main checkout that are not this thread's edits, so stay here. */
  leftBehind: z.array(z.string()).default([]),
  /** Commits the destination does not have yet, by count (from the bundle). */
  bytes: z.number().int().optional(),
})
export type ThreadMovePreview = z.infer<typeof ThreadMovePreview>

export const ThreadMoveResult = z.object({
  peer: z.object({ id: PeerId, name: z.string() }),
  slug: ThreadSlug,
  /** Anything the human should know about what did not come along. */
  notes: z.array(z.string()).default([]),
})
export type ThreadMoveResult = z.infer<typeof ThreadMoveResult>

/** Stamped on a thread's row on the machine it LEFT (`moved_to`) and the one it ARRIVED at (`moved_from`). */
export const ThreadMoveStamp = z.object({
  peerId: PeerId,
  peerName: z.string(),
  at: z.string(),
  moveId: z.string(),
  /**
   * The move was sent and its answer never came back (the connection dropped). The thread may or may not
   * be on the other machine, so it runs on neither until the human retries the move (which the other
   * machine answers idempotently) or keeps it here.
   */
  pending: z.boolean().optional(),
})
export type ThreadMoveStamp = z.infer<typeof ThreadMoveStamp>

/**
 * ONE MOVE IN A THREAD'S HISTORY, kept on its session row (`move_log`, JSON) and carried along with it, so
 * every machine it has been on can draw where in the conversation it changed hands ("Moved from A to B").
 * `at` is the moment the machine it left packed it up, on that machine's clock: the same clock as every
 * message before it, so the divider can only land after them.
 */
export interface MoveLogEntry {
  from: string
  to: string
  at: string
  moveId: string
}

/** The longest history a row keeps: the newest moves, which are the ones anyone scrolls to. */
const MOVE_LOG_MAX = 50

/** A row's `move_log`, read defensively: it arrived from another machine, so anything malformed is dropped. */
export function moveLogOf(raw: unknown): MoveLogEntry[] {
  if (typeof raw !== "string" || !raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const text = (value: unknown, max: number) => typeof value === "string" && value.length > 0 && value.length <= max
  return parsed
    .filter((entry): entry is MoveLogEntry => !!entry && typeof entry === "object" &&
      text(entry.from, 200) && text(entry.to, 200) && text(entry.at, 40) && !Number.isNaN(Date.parse(entry.at)) && text(entry.moveId, 64))
    .map(({ from, to, at, moveId }) => ({ from, to, at, moveId }))
    .slice(-MOVE_LOG_MAX)
}

/** `raw` with `entry` added, as stored JSON. A move already recorded (a retry) is not recorded twice. */
export function appendMoveLog(raw: unknown, entry: MoveLogEntry): string {
  const log = moveLogOf(raw).filter((existing) => existing.moveId !== entry.moveId)
  return JSON.stringify([...log, entry].slice(-MOVE_LOG_MAX))
}

/** The refusal every verb that would run a moved-away thread answers with. */
export function movedAwayRefusal(peerName: string): string {
  return `This thread moved to ${peerName}. Continue it there.`
}
