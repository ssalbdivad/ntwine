import { randomBytes, timingSafeEqual, createHmac } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

/**
 * Single-use access codes, and the longer-lived sessions they mint.
 *
 * The split is the whole point. Before this, one standing secret was printed at launch and traded for a
 * year-long cookie: every copy of it — scrollback, shell history, an email — stayed valid forever, and
 * it only rotated on the restart that is least convenient to perform. Separating the two fixes that:
 *
 *   CODE     single-use, short-lived, authorizes exactly ONE exchange. Safe to show on a screen.
 *   SESSION  what the code mints. Lasts 30 days, signed, and independently revocable.
 *
 * A leaked code is worthless the moment it is used (or five minutes pass), and a leaked session can be
 * revoked without disturbing anything else. GitHub minting the session instead of a code is policy on
 * top of that split; per-device names and sign-out are built here.
 *
 * REVOCATION IS A DENYLIST, not a session table. A session still verifies from its own signature with
 * no lookup — that is what makes it cheap and restart-proof — and the directory holds only the ids an
 * operator has actually signed out, plus a label per device so the list means something. A board with
 * nothing revoked pays nothing.
 */

/** Long enough that guessing is hopeless, short enough that the QR stays a small version. */
const CODE_BYTES = 16
const SESSION_BYTES = 32
/** Short enough to read off a terminal and type back into `--sign-out`; still 2^48 of space. */
const SESSION_ID_BYTES = 6
export const DEFAULT_CODE_TTL_MS = 5 * 60_000
/**
 * How long a signed-in device stays signed in. A photographed QR is a real vector, so codes expire on a
 * human timescale (DEFAULT_CODE_TTL_MS); this is the session one.
 *
 * 30 days, down from 365 on 2026-10-08. A session cookie crossed a compromised frizz.sh relay for over
 * two weeks (2026-09-21 to 2026-10-08), and a year-long cookie copied there would have stayed good for
 * a year. A month bounds what any copied cookie is worth, at the cost of one QR scan a month per device.
 */
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60_000

/**
 * The generation of remote sessions this code accepts. Raising it signs out every device that signed in
 * before, on every board, once, at the next start: see advanceSessionEpoch. That is the whole response
 * to a leak of session cookies — bump this and release — with nothing for an operator to run.
 *
 *   1  2026-10-08  the frizz.sh relay was serving a backdoored build that copied every visitor's
 *                  `frizz_session` cookie (2026-09-21 to 2026-10-08).
 *
 * Never lower it. A board that recorded a higher epoch than its code knows (a downgrade) is left alone.
 */
export const SESSION_EPOCH = 1

export interface AccessCode {
  code: string
  createdAt: number
  expiresAt: number
}

interface StoredCode extends AccessCode {
  consumedAt?: number
}

export interface AccessStoreOptions {
  codeTtlMs?: number
  sessionTtlMs?: number
  /** Injectable so tests can advance time without sleeping. */
  now?: () => number
  /** Injectable so tests get deterministic values; production uses randomBytes. */
  randomToken?: (bytes: number) => string
  /**
   * HMAC key for sessions. Supply a PERSISTED one so sessions outlive a restart.
   *
   * Defaulting to a fresh random key means every restart silently signs out every device — and a
   * board restarts often (artifact updates, crashes, an ordinary ctrl-C), so in practice a 30-day
   * cookie would last until the next one. Rotating this key is what revocation looks like.
   */
  signingKey?: Buffer
  /**
   * Make and persist a replacement for `signingKey`; signOutAll() calls it. Without one the new key is
   * held in memory only, so the next start goes back to the old key and the old sessions with it.
   */
  rotateSigningKey?: () => Buffer
  /** Called when a code is successfully consumed, so a launcher can repaint its QR. */
  onConsumed?: (code: string) => void
  /** Where sign-outs and device labels live. In-memory by default, which forgets them on restart. */
  sessions?: SessionDirectory
}

export type RedeemResult =
  | { ok: true; session: string; expiresAt: number; id: string }
  | { ok: false; reason: "unknown" | "expired" | "already-used" }

/** One device that redeemed a link. `label` is for the human reading `frizz --sessions`. */
export interface SessionRecord {
  id: string
  label: string
  createdAt: number
  /** When the session stops verifying on its own. Absent on records written before 2026-10-08. */
  expiresAt?: number
  revokedAt?: number
}

/**
 * Where sign-outs are remembered.
 *
 * Injected rather than assumed to be a file, so the store can be driven in a test without a temp
 * directory and so a future backend (a tenant DB) needs no change here.
 */
export interface SessionDirectory {
  record(record: SessionRecord): void
  isRevoked(id: string): boolean
  list(): SessionRecord[]
  /** False when the id is unknown or already revoked, so a caller can say which. */
  revoke(id: string): boolean
  /** Returns how many live sessions were signed out; one already past its expiry is not counted. */
  revokeAll(): number
}

export function memorySessionDirectory(seed: SessionRecord[] = []): SessionDirectory {
  const records = new Map<string, SessionRecord>(seed.map((r) => [r.id, r]))
  return {
    record: (r) => void records.set(r.id, r),
    isRevoked: (id) => records.get(id)?.revokedAt !== undefined,
    // Reverse FIRST, then sort. Array.sort is stable, so two devices that redeemed in the same
    // millisecond — which two taps on one page reliably are — keep newest-inserted-first instead of
    // falling back to insertion order and reading as oldest first.
    list: () => [...records.values()].reverse().sort((a, b) => b.createdAt - a.createdAt),
    revoke(id) {
      const found = records.get(id)
      if (!found || found.revokedAt !== undefined) return false
      found.revokedAt = Date.now()
      return true
    },
    revokeAll() {
      let n = 0
      const now = Date.now()
      for (const r of records.values()) {
        if (r.revokedAt !== undefined) continue
        r.revokedAt = now
        // Marked either way, so the list reads the same; counted only if it could still sign in.
        if (r.expiresAt === undefined || r.expiresAt > now) n++
      }
      return n
    },
  }
}

/**
 * Turn a User-Agent into something an operator can recognise in a list.
 *
 * Deliberately coarse. The label exists so "sign out the phone" is answerable, and a precise version
 * string would only make the list harder to scan — this is not analytics, and it is the only thing the
 * board ever records about a visitor's browser.
 */
export function describeDevice(userAgent: string | undefined): string {
  const ua = userAgent ?? ""
  if (!ua.trim()) return "unknown device"
  const os =
    /iPhone/i.test(ua) ? "iPhone"
    : /iPad/i.test(ua) ? "iPad"
    : /Android/i.test(ua) ? "Android"
    : /Mac OS X|Macintosh/i.test(ua) ? "macOS"
    : /Windows/i.test(ua) ? "Windows"
    : /Linux/i.test(ua) ? "Linux"
    : "unknown device"
  // Order matters: Edge and Chrome both claim Safari, and Chrome claims Safari too.
  const browser =
    /Edg\//i.test(ua) ? "Edge"
    : /OPR\/|Opera/i.test(ua) ? "Opera"
    : /Firefox\//i.test(ua) ? "Firefox"
    : /Chrome\//i.test(ua) ? "Chrome"
    : /Safari\//i.test(ua) ? "Safari"
    : ""
  return browser ? `${browser} on ${os}` : os
}

function defaultRandomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url")
}

/** Constant-time string compare; a plain `===` leaks a shared prefix to a patient attacker. */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export class AccessStore {
  private readonly codes = new Map<string, StoredCode>()
  private readonly options: Required<
    Omit<AccessStoreOptions, "onConsumed" | "signingKey" | "rotateSigningKey" | "sessions">
  > &
    Pick<AccessStoreOptions, "onConsumed">
  readonly sessions: SessionDirectory
  /** Signing key for sessions. Persisted by the caller; a fresh one signs every device out. */
  private signingKey: Buffer
  private readonly rotateSigningKey: () => Buffer

  constructor(options: AccessStoreOptions = {}) {
    this.signingKey = options.signingKey ?? randomBytes(32)
    this.rotateSigningKey = options.rotateSigningKey ?? (() => randomBytes(32))
    this.sessions = options.sessions ?? memorySessionDirectory()
    this.options = {
      codeTtlMs: options.codeTtlMs ?? DEFAULT_CODE_TTL_MS,
      sessionTtlMs: options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
      now: options.now ?? Date.now,
      randomToken: options.randomToken ?? defaultRandomToken,
      onConsumed: options.onConsumed,
    }
  }

  /** Mint a code to show as a QR or a link. Minting does not invalidate codes already outstanding. */
  issue(): AccessCode {
    this.sweep()
    const now = this.options.now()
    const code: StoredCode = {
      code: this.options.randomToken(CODE_BYTES),
      createdAt: now,
      expiresAt: now + this.options.codeTtlMs,
    }
    this.codes.set(code.code, code)
    return { code: code.code, createdAt: code.createdAt, expiresAt: code.expiresAt }
  }

  /**
   * Trade a code for a session, at most once, ever.
   *
   * The consumed marker is set BEFORE anything else can observe success, and JS runs this method to
   * completion without interleaving, so two browsers racing the same code cannot both win. That
   * atomicity is what makes "single-use" true rather than aspirational — it is the first thing the
   * tests attack.
   */
  redeem(code: string | undefined, device?: string): RedeemResult {
    if (!code) return { ok: false, reason: "unknown" }
    // Classify BEFORE sweeping. Sweeping first deletes the very entry that distinguishes "this link
    // expired" from "no such link", and the difference is the whole diagnostic value of the result.
    // Look up by exact key, then re-compare in constant time: a Map hit already leaks nothing useful
    // (the attacker supplied the key), but the compare keeps the code path uniform for stored secrets.
    const stored = this.codes.get(code)
    if (!stored || !secretsMatch(stored.code, code)) return { ok: false, reason: "unknown" }
    const now = this.options.now()
    if (stored.consumedAt !== undefined) return { ok: false, reason: "already-used" }
    if (now >= stored.expiresAt) {
      this.sweep()
      return { ok: false, reason: "expired" }
    }
    stored.consumedAt = now
    this.sweep()
    this.options.onConsumed?.(code)
    const minted = this.mintSession(now)
    const expiresAt = now + this.options.sessionTtlMs
    this.sessions.record({ id: minted.id, label: device ?? "unknown device", createdAt: now, expiresAt })
    return { ok: true, session: minted.session, expiresAt, id: minted.id }
  }

  /**
   * Sign out EVERY device: `frizz --sign-out all`, and what a session-epoch bump asks of a running board.
   *
   * The denylist alone is not enough for that. It names only the ids it recorded, so a session minted
   * before ids existed (2026-08-25), or while the directory was held in memory, would survive it. A new
   * key kills every outstanding session whatever it carries; the denylist entries are what make
   * `frizz --sessions` stop listing those devices as signed in. Returns how many recorded devices that was.
   */
  signOutAll(): number {
    this.signingKey = this.rotateSigningKey()
    return this.sessions.revokeAll()
  }

  /**
   * A session is `<expiry>.<id>.<nonce>.<hmac>` — signed with a key the caller persists so it survives
   * a restart, and self-describing enough that a stale cookie is rejected without any lookup.
   *
   * The `id` is what makes ONE device signable-out. It is short because an operator types it into
   * `frizz --sign-out <id>`, and it is inside the signed payload so it cannot be swapped for another
   * device's. Rotating the key still revokes everything at once; this is the scalpel beside that axe.
   *
   * A session minted before ids existed has a two-part payload and still verifies — it simply has no id
   * to revoke individually. Adding ids was not meant to sign every device out; when that IS the intent,
   * SESSION_EPOCH does it on purpose, by rotating the key.
   */
  private mintSession(now: number): { session: string; id: string } {
    const expiresAt = now + this.options.sessionTtlMs
    const id = this.options.randomToken(SESSION_ID_BYTES)
    const nonce = this.options.randomToken(SESSION_BYTES)
    const payload = `${expiresAt}.${id}.${nonce}`
    return { session: `${payload}.${this.sign(payload)}`, id }
  }

  /** The expiry a session carries in its own payload. Only called on a session that already verified. */
  private static expiryOf(session: string): number {
    return Number(session.slice(0, session.indexOf(".")))
  }

  /** The id inside a session payload, or null for a legacy two-part one. */
  private static idOf(payload: string): string | null {
    const parts = payload.split(".")
    return parts.length >= 3 ? (parts[1] ?? null) : null
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.signingKey).update(payload).digest("base64url")
  }

  /** Is this cookie a session signed by this board's key, and still in date? */
  verifySession(session: string | undefined): boolean {
    if (!session) return false
    const cut = session.lastIndexOf(".")
    if (cut <= 0) return false
    const payload = session.slice(0, cut)
    const signature = session.slice(cut + 1)
    if (!secretsMatch(signature, this.sign(payload))) return false
    const expiresAt = Number(payload.slice(0, payload.indexOf(".")))
    if (!Number.isFinite(expiresAt) || this.options.now() >= expiresAt) return false
    // The signature proves the id was not tampered with, so the denylist can be trusted to name a real
    // device. Checked LAST: an expired or forged cookie should never reach the directory at all.
    const id = AccessStore.idOf(payload)
    return !(id && this.sessions.isRevoked(id))
  }

  /**
   * Which device this session belongs to, for the audit trail: its record id (what `frizz --sessions`
   * lists and `--sign-out` takes), `"legacy"` for a session minted before ids existed, or null when it
   * does not verify. Never the session itself — the id is the one part of it that is not a credential.
   */
  sessionIdOf(session: string | undefined): string | null {
    if (!session || !this.verifySession(session)) return null
    return AccessStore.idOf(session.slice(0, session.lastIndexOf("."))) ?? "legacy"
  }

  /**
   * Sign out the device HOLDING this session — the "Sign out this device" row, not `--sign-out`.
   *
   * The id comes from the session itself, and only after its signature verifies, so the one thing this
   * can ever revoke is the credential the caller just proved it holds. There is deliberately no
   * parameter naming any other id: signing out SOMEONE ELSE stays loopback-only, because a stolen
   * session must not be able to evict the owner and keep the board.
   *
   * - `revoked`: the id is on the denylist now, so a surviving copy of this cookie is refused too.
   * - `legacy`: a session minted before ids existed verifies but has no id to revoke on its own. The
   *   caller can still clear the cookie; signOutAll(), which rotates the key, is the way to kill a copy.
   * - `no-session`: nothing valid was presented — absent, forged, expired, or already signed out.
   */
  signOutSession(session: string | undefined):
    | { result: "revoked"; id: string }
    | { result: "legacy" }
    | { result: "no-session" } {
    if (!session || !this.verifySession(session)) return { result: "no-session" }
    const id = AccessStore.idOf(session.slice(0, session.lastIndexOf(".")))
    if (!id) return { result: "legacy" }
    // The directory only knows ids it recorded, so a session minted while it was held in memory (a board
    // started without a persisted one) is unknown after a restart even though the key still verifies it.
    // Record it first, or revoke() refuses the unknown id and the sign-out silently does nothing.
    if (!this.sessions.revoke(id)) {
      this.sessions.record({ id, label: "unknown device", createdAt: this.options.now(), expiresAt: AccessStore.expiryOf(session) })
      this.sessions.revoke(id)
    }
    return this.sessions.isRevoked(id) ? { result: "revoked", id } : { result: "no-session" }
  }

  /**
   * Drop codes past their expiry so a long-lived board does not accumulate them forever.
   *
   * A CONSUMED code is deliberately kept until that same expiry rather than deleted on use. Deleting it
   * immediately would make a replay indistinguishable from a typo — both "unknown" — and the difference
   * matters: "already-used" is the message that tells someone their link was used by somebody else.
   * It costs one small entry for at most the code TTL.
   */
  private sweep(): void {
    const now = this.options.now()
    for (const [key, stored] of this.codes) {
      if (now >= stored.expiresAt) this.codes.delete(key)
    }
  }

  /** Outstanding codes that could still be redeemed — neither consumed nor expired. */
  outstanding(): AccessCode[] {
    this.sweep()
    return [...this.codes.values()]
      .filter((stored) => stored.consumedAt === undefined)
      .map(({ code, createdAt, expiresAt }) => ({ code, createdAt, expiresAt }))
  }
}


/**
 * The session directory on disk, beside the signing key.
 *
 * A SIGN-OUT THAT DOES NOT SURVIVE A RESTART IS NOT A SIGN-OUT — and a board restarts often, on every
 * artifact update and every ordinary ctrl-C. So the denylist is written through on each change rather
 * than held in memory, and a lost phone stays signed out.
 *
 * Reads are served from memory: `isRevoked` runs on every single request, and hitting the filesystem
 * there would put a stat in the path of every page load and every socket frame.
 */
export function fileSessionDirectory(stateDir: string, now: () => number = Date.now): SessionDirectory {
  const path = join(stateDir, "sessions.json")
  let records: SessionRecord[] = []
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown
    // A hand-edited or truncated file must not take the board down; an unreadable directory means no
    // remembered sign-outs, which is the same position a first run is in.
    if (Array.isArray(parsed)) {
      records = parsed.filter(
        (r): r is SessionRecord =>
          !!r && typeof (r as SessionRecord).id === "string" && typeof (r as SessionRecord).createdAt === "number"
      )
    }
  } catch {
    // Missing on first run, which is the ordinary path.
  }
  const inner = memorySessionDirectory(records)
  const flush = () => {
    try {
      mkdirSync(dirname(path), { recursive: true })
      // Prune what can no longer matter: a revoked session past its own expiry is denied by the expiry
      // check alone, so keeping it would grow the file forever for nothing.
      writeFileSync(path, JSON.stringify(inner.list()), { mode: 0o600 })
    } catch (error) {
      // Best effort. Losing the write costs a remembered sign-out, not correctness of the live board.
      if (process.env.FRIZZ_DEBUG_SESSIONS) console.error("[sessions] flush failed:", error)
    }
  }
  return {
    record(r) { inner.record(r); flush() },
    isRevoked: (id) => inner.isRevoked(id),
    list: () => inner.list(),
    revoke(id) { const ok = inner.revoke(id); if (ok) flush(); return ok },
    revokeAll() { const n = inner.revokeAll(); if (n > 0) flush(); return n },
  }
}

const SESSION_KEY_FILE = "session-key"
const SESSION_EPOCH_FILE = "session-epoch"

function writeSessionKey(path: string, key: Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, key, { mode: 0o600 })
  try {
    // writeFileSync's mode is ignored when the file already exists, so state it again.
    chmodSync(path, 0o600)
  } catch {
    // Best effort: a key readable only by this user is the goal, not a hard gate.
  }
}

/**
 * Load this board's session-signing key, creating it on first use.
 *
 * On disk at 0600 beside the project's other state, because the alternative — a key held only in
 * memory — makes every restart a silent sign-out of every device. Deleting this file is the
 * revocation story: it invalidates every outstanding session at once and the next start writes a
 * fresh one.
 */
export function loadOrCreateSessionKey(stateDir: string): Buffer {
  const path = join(stateDir, SESSION_KEY_FILE)
  try {
    const existing = readFileSync(path)
    // A truncated or empty file would silently produce a weak key; treat it as absent and rewrite.
    if (existing.byteLength >= 32) return existing
  } catch {
    // Missing on first run, which is the ordinary path.
  }
  return rotateSessionKey(stateDir)
}

/** Write a fresh session key over this board's old one. Every session signed by the old key dies. */
export function rotateSessionKey(stateDir: string): Buffer {
  const key = randomBytes(32)
  writeSessionKey(join(stateDir, SESSION_KEY_FILE), key)
  return key
}

/** The session epoch this board last advanced to; 0 for a board that predates epochs. */
export function readSessionEpoch(stateDir: string): number {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, SESSION_EPOCH_FILE), "utf8")) as { epoch?: unknown }
    return Number.isInteger(parsed?.epoch) && (parsed.epoch as number) >= 0 ? (parsed.epoch as number) : 0
  } catch {
    // Missing or unreadable reads as 0. That errs towards one more sign-out, never towards keeping a
    // session the code meant to end.
    return 0
  }
}

export type SessionEpochAdvance =
  | { advanced: false; epoch: number }
  /** `rotatedKey` is false on a first run: there was no key, so nothing was signed in to sign out. */
  | { advanced: true; from: number; to: number; rotatedKey: boolean }

/**
 * Bring this board's sessions up to `epoch`: if the board last recorded an older one, rotate the
 * signing key so every session minted before it stops verifying, then record the new epoch.
 *
 * Once per epoch, not once per start: the record is what stops a second start rotating again. The key
 * is written BEFORE the record, so a crash between the two rotates once more on the next start rather
 * than recording an epoch whose sessions were never ended. Nothing local is touched — loopback is
 * never gated by a session, so the operator's own tabs and CLI keep working throughout.
 *
 * Callable from either process. The launcher calls it before it loads the key (loadSessionState). A
 * server child calls it too (signOutOlderSessionEpoch), because an in-app update replaces the child and
 * leaves an older launcher running: that launcher reads the rotated file at its next start.
 */
export function advanceSessionEpoch(stateDir: string, epoch: number = SESSION_EPOCH): SessionEpochAdvance {
  const from = readSessionEpoch(stateDir)
  if (from >= epoch) return { advanced: false, epoch: from }
  const keyPath = join(stateDir, SESSION_KEY_FILE)
  const rotatedKey = existsSync(keyPath)
  if (rotatedKey) rotateSessionKey(stateDir)
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(
    join(stateDir, SESSION_EPOCH_FILE),
    JSON.stringify({ epoch, advancedAt: new Date().toISOString() }),
    { mode: 0o600 },
  )
  return { advanced: true, from, to: epoch, rotatedKey }
}

/**
 * The one line an operator reads when an epoch bump signed `count` devices out, or null when it signed
 * out none. Without it, a phone that suddenly needs a new QR looks like a bug.
 *
 * Keyed on the count, not on "the key rotated": every board writes a key on its first start, remote or
 * not, so a loopback-only operator would otherwise be told about devices they never had.
 */
export function sessionEpochNotice(count: number): string | null {
  if (count <= 0) return null
  const devices = count === 1 ? "1 remote device" : `${count} remote devices`
  return `Security update: signed out ${devices} (a phone or browser reaching this board through frizz.sh or a tunnel). Each must sign in again with a fresh link.`
}

/**
 * The run-log record of an epoch advance that ended sessions, or null when there is nothing worth a
 * record (no advance, or a first run that had no key to rotate). `signedOut` of null means the count
 * could not be learned.
 */
export function sessionEpochLogLine(advance: SessionEpochAdvance, signedOut: number | null): string | null {
  if (!advance.advanced || !advance.rotatedKey) return null
  const count = signedOut === null ? "an unknown number of" : String(signedOut)
  return `session epoch ${advance.from} -> ${advance.to}: rotated the session key and signed out ${count} recorded remote device(s); every older remote session is refused`
}

/**
 * Everything a launcher needs to gate its public origin: the key, the persisted directory, and the
 * epoch advance it applied on the way. One call, so the two launchers cannot disagree on the order —
 * the epoch MUST be applied before the key is read, or this start would load the key it just retired.
 */
export function loadSessionState(stateDir: string, epoch: number = SESSION_EPOCH): {
  key: Buffer
  directory: SessionDirectory
  rotateKey: () => Buffer
  advance: SessionEpochAdvance
  /** How many recorded devices the advance signed out; feed it to sessionEpochNotice. */
  signedOut: number
} {
  const advance = advanceSessionEpoch(stateDir, epoch)
  const key = loadOrCreateSessionKey(stateDir)
  const directory = fileSessionDirectory(stateDir)
  // The rotated key already refuses every old session. Marking them in the directory as well is what
  // stops `frizz --sessions` listing those devices as still signed in.
  const signedOut = advance.advanced ? directory.revokeAll() : 0
  return { key, directory, rotateKey: () => rotateSessionKey(stateDir), advance, signedOut }
}
