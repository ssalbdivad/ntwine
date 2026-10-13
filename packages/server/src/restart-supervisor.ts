// The durable launcher owns the browser-facing port.  A disposable Ntwine control-plane child binds
// only a private loopback port, which means a browser can still ask the owner to recover it after a
// crash.  This intentionally contains no source-watch logic: stable and legacy launchers can share it.
import { request as requestHttp, createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http"
import { connect } from "node:net"
import { pipeline } from "node:stream"
import {
  AccessStore,
  describeDevice,
  secretsMatch,
  type AccessCode,
  type SessionDirectory,
} from "./access-codes.ts"
import {
  allowedLocalCorsOrigin,
  authoritySendsFetchMetadata,
  bindHostIsExposed,
  FORWARDED_HEADERS,
  isTrustedLocalHttpRequest,
  LOOPBACK_BIND_HOST,
  parseLocalHost,
  unlistedHostName,
  rejectWebSocketUpgrade,
  type LocalAuthorityPolicy,
} from "./local-origin.ts"
import { localImageHeaders, localImageStream, resolveLocalImage } from "./local-image.ts"
import { recoveryPage, unauthorizedPage, unlistedHostPage } from "./supervisor-pages.ts"
import { CALLER_HEADER, encodeCallerStamp, type CallerVia } from "./audit.ts"
import { adoptLegacyRoute, NTWINE_ROUTE_PREFIX, ntwineRoute } from "@ntwine/shared"

export const SUPERVISOR_CONTROL_PREFIX = "/_ntwine/control"
export const SUPERVISOR_RESTART_PATH = `${SUPERVISOR_CONTROL_PREFIX}/restart`
export const SUPERVISOR_UPDATE_RESTART_PATH = `${SUPERVISOR_CONTROL_PREFIX}/update-restart`
export const SUPERVISOR_STATUS_PATH = `${SUPERVISOR_CONTROL_PREFIX}/status`
export const SUPERVISOR_ACCESS_CODE_PATH = `${SUPERVISOR_CONTROL_PREFIX}/access-code`
/** List the devices holding a session, and sign one (or all) of them out. */
export const SUPERVISOR_SESSIONS_PATH = `${SUPERVISOR_CONTROL_PREFIX}/sessions`
/**
 * Sign out the device making the request, and only that one. Reachable from the tunnel, unlike
 * SUPERVISOR_SESSIONS_PATH: see handleControl for why this one is safe to expose.
 */
export const SUPERVISOR_SIGN_OUT_PATH = `${SUPERVISOR_CONTROL_PREFIX}/sign-out`
/**
 * Settings → Remote access: read (GET) or change (POST) how the board is reached from outside.
 * LOOPBACK ONLY, like minting a link — see handleControl.
 */
export const SUPERVISOR_REMOTE_PATH = `${SUPERVISOR_CONTROL_PREFIX}/remote`
export const SUPERVISOR_CONTROL_PROTOCOL = 1

/**
 * What POST SUPERVISOR_SIGN_OUT_PATH answers.
 *
 * - `signed-out`: this device's session is on the persisted denylist and its cookie is cleared.
 * - `cookie-cleared`: the session predates per-device ids, so there was nothing to put on the denylist;
 *   this browser forgot it, which is all that can be done without rotating the key.
 * - `no-remote-session`: the request carried no session to end — the operator's own tab on loopback,
 *   a board with no public origin, or a cookie that was already dead. Nothing was changed.
 */
export type SignOutThisDeviceResult =
  | { protocol: 1; result: "signed-out"; id: string }
  | { protocol: 1; result: "cookie-cleared" }
  | { protocol: 1; result: "no-remote-session" }

export type RestartControlState = "ready" | "restarting" | "failed"

export interface RemoteControlReply {
  status: number
  body: unknown
}

/**
 * The launcher's remote-access setup, offered to the browser. It lives in the LAUNCHER (src/remote-setup.ts),
 * which owns the transport — a relay socket or a cloudflared child — so the proxy only routes to it. A
 * launch that wires none (`pnpm dev`, which runs no transport at all) answers 404, and the browser shows
 * nothing.
 */
export interface RemoteControlHandler {
  get(): Promise<RemoteControlReply>
  post(body: unknown): Promise<RemoteControlReply>
}

export interface RestartResult {
  // A durable update must acknowledge before it begins draining/re-execing the process which owns
  // the response socket.  "restarting" is therefore an accepted action, not a failed request.
  state: "ready" | "restarting" | "failed"
  message?: string
}

export interface RestartSupervisorProxyOptions {
  /** Public Ntwine port held for the supervisor's whole lifetime. */
  port: number
  /** Bind address for the public port. Defaults to loopback; `--host` moves it onto the network. */
  host?: string
  /** DNS names a browser may use as this server's authority once `host` is not loopback. */
  allowedHosts?: readonly string[]
  /** Serialized origin of a reverse proxy fronting this port (`--public-origin`), if the operator named one. */
  publicOrigin?: string
  /**
   * Shared secret every request arriving AS `publicOrigin` must carry. Loopback is never gated.
   *
  /** Fired when an access code is redeemed, so a launcher can repaint a now-spent QR. */
  onCodeConsumed?: () => void
  /**
   * Persisted HMAC key for sessions. Without one, every restart signs out every device — which made a
   * nominally year-long cookie (30 days since 2026-10-08) last only until the next artifact update.
   */
  sessionKey?: Buffer
  /**
   * Write and return a replacement for `sessionKey`, for "sign every device out". Without one the new
   * key lives in memory only and the next start revives every session it was meant to end.
   */
  rotateSessionKey?: () => Buffer
  /**
   * Where sign-outs are remembered. Supply a PERSISTED one, or a signed-out device comes back on the
   * next restart — and a board restarts on every artifact update and every ordinary ctrl-C.
   */
  sessionDirectory?: SessionDirectory
  /** The current disposable child. Undefined means it is starting, stopped, or failed. */
  childPort: () => number | undefined
  /** Must coalesce work itself or return the same in-flight promise for repeat requests. */
  restart: () => Promise<RestartResult>
  /** Build/validate/promote a new immutable artifact, then restart the child. Omitted for legacy mode. */
  updateRestart?: () => Promise<RestartResult>
  /**
   * Is a NEWER artifact actually available right now? Distinct from `updateRestart`, which only says
   * the verb is WIRED — a distinction the UI needs and could not previously make, so a fully current
   * production Ntwine still advertised "Update Ntwine" and reinstalled its own version on click.
   *
   * Must be a CHEAP cached read: this runs on every status poll, so it may never touch the network.
   * Omitting it means "assume available", which keeps ntwine-dev (where an update rebuilds from source
   * and is always meaningful) behaving exactly as before.
   */
  updateAvailable?: () => boolean
  /**
   * The version of the RUNNING application server. A child-only update changes this while its
   * launcher remains alive, so stable launchers supply a getter. Omitted by ntwine-dev and legacy
   * supervisors, preserving their versionless status payload and UI.
   */
  version?: string | (() => string | undefined)
  /**
   * The stable launcher's own package version. This is diagnostic only: it neither gates the update
   * action nor participates in badge comparison, which are both application-server concerns.
   */
  launcherVersion?: string
  /**
   * The target APPLICATION SERVER version `updateAvailable` is reporting. Same contract as
   * `updateAvailable`: a cheap CACHED read, refreshed off the status path. Undefined while the
   * registry has not answered yet or nothing newer exists.
   */
  updateVersion?: () => string | undefined
  /**
   * Is this Ntwine a DEVELOPMENT build — launched from a source checkout by `ntwine-dev` (src/index.ts)
   * or `pnpm dev` (server/src/dev.ts), rather than the published `ntwine` bin (src/production.ts)?
   *
   * It exists because the web client cannot answer this for itself. `import.meta.env.DEV` is a Vite
   * COMPILE-TIME constant, true only under `vite dev` middleware — and ntwine-dev's ordinary route
   * builds an immutable artifact and serves the Vite PRODUCTION bundle, where it is statically
   * `false`. So every dev-only affordance gated on it was dead-code eliminated out of the build the
   * maintainer actually runs all day. The launcher is the only thing that truly knows, so it says so
   * here, on the status the client already polls.
   */
  dev?: boolean
  /**
   * Status is intentionally available without a child, for a useful recovery UI.
   *
   * While an UPDATE is in flight this answer is reported as-is (see `status()` below), so a delegate
   * that wires `updateRestart` must itself say "restarting" from the moment it starts draining the
   * old child — the proxy cannot see that moment, only the promise around the whole action.
   */
  status?: () => { state: RestartControlState; message?: string; artifactDigest?: string }
}

function responseJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  res.end(JSON.stringify(value))
}

function proxyHeaders(
  req: IncomingMessage,
  childPort: number,
  callerStamp: string,
  vouchSameOrigin = false,
): Record<string, string | string[] | undefined> {
  const headers = { ...req.headers }
  // Who called, as judged HERE — the child cannot tell once Host and Origin are rewritten below. Any
  // copy the client sent is replaced, never forwarded, so a visitor cannot forge their own attribution.
  headers[CALLER_HEADER] = callerStamp
  // The child retains Ntwine's strict local-origin policy. Translate public browser authority to the
  // private child authority; no external proxy authority is ever trusted.
  headers.host = `127.0.0.1:${childPort}`
  if (typeof headers.origin === "string") headers.origin = `http://127.0.0.1:${childPort}`
  // Whatever a fronting proxy claimed about the caller has already been judged here, and the child
  // refuses these outright — it has no --public-origin policy of its own and must not grow one, since
  // the rewrite above means it can no longer see who really called. Forwarding them 403s every request.
  for (const name of FORWARDED_HEADERS) delete headers[name]
  // The browser could not stamp this one (see RestartSupervisorProxy.vouchesSameOrigin), and the
  // proxy has already checked what the stamp would have proved. Supply it so the child's own
  // missing-Origin rules keep working instead of refusing the app's every read.
  if (vouchSameOrigin) headers["sec-fetch-site"] = "same-origin"
  delete headers.connection
  return headers
}

export const ACCESS_CODE_PARAM = "ntwine_code"
const SESSION_COOKIE = "ntwine_session"
// The two names before the Frizz -> Ntwine rename (2026-10-13). A device signed in then, or a link
// minted then, still works: the cookie is read under either name and moved to the new one on the next
// page load (adoptLegacySession), and the code is redeemed under either.
const LEGACY_ACCESS_CODE_PARAM = "frizz_code"
const LEGACY_SESSION_COOKIE = "frizz_session"

/** The remote session this request carries, under today's cookie name or the pre-rename one. */
function sessionCookie(header: string | undefined): string | undefined {
  return readCookie(header, SESSION_COOKIE) ?? readCookie(header, LEGACY_SESSION_COOKIE)
}
/** Loopback spellings the token gate must never challenge — the operator's own tab on the box. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"])

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=")
    if (eq === -1) continue
    if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim()
  }
  return undefined
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value
  return first?.trim() || undefined
}

/** A peer on this machine: IPv4 loopback, IPv6 loopback, or IPv4 loopback mapped into IPv6. */
function isLoopbackAddress(address: string | null): boolean {
  if (!address) return false
  const v4 = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address
  return v4.startsWith("127.") || address === "::1"
}

function isControlRequest(req: IncomingMessage): boolean {
  const url = new URL(req.url ?? "/", "http://ntwine.invalid")
  return url.pathname === SUPERVISOR_RESTART_PATH
    || url.pathname === SUPERVISOR_UPDATE_RESTART_PATH
    || url.pathname === SUPERVISOR_STATUS_PATH
    || url.pathname === SUPERVISOR_ACCESS_CODE_PATH
    || url.pathname === SUPERVISOR_SESSIONS_PATH
    || url.pathname === SUPERVISOR_SIGN_OUT_PATH
    || url.pathname === SUPERVISOR_REMOTE_PATH
}

// `/_ntwine/local-image` AND `/_ntwine/<project>/local-image` — the client builds it from `apiBase()`,
// which carries the project slug on every prefixed board. Matching only the unprefixed spelling meant
// a prefixed board's inline screenshots were answered with the recovery HTML during a restart while an
// unprefixed one's still rendered.
function isLocalImageRequest(req: IncomingMessage): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false
  const { pathname } = new URL(req.url ?? "/", "http://ntwine.invalid")
  return LOCAL_IMAGE_PATH.test(pathname)
}
// Anchored on the reserved namespace, so only Ntwine's own route matches — never some project file
// that happens to end in the same segment.
const LOCAL_IMAGE_PATH = new RegExp(`^${NTWINE_ROUTE_PREFIX}(?:/[^/]+)?/local-image$`)

/**
 * Read a small JSON control body.
 *
 * Capped, because this endpoint is reachable before any session check and an unbounded read is a way
 * to spend the board's memory from outside it. A malformed body is `null` rather than a throw: the
 * caller answers 400 with something an operator can act on.
 */
async function readJsonBody(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength
    if (size > limit) return null
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export class RestartSupervisorProxy {
  private server: Server | null = null
  private restartInFlight: Promise<RestartResult> | null = null
  /** Which action `restartInFlight` is. An update's prepare phase leaves the child serving; a restart does not. */
  private transition: "restart" | "update" | null = null
  private state: RestartControlState = "ready"
  private message: string | undefined
  private readonly options: RestartSupervisorProxyOptions
  private readonly host: string
  /**
   * The authorities a browser may name for the PUBLIC port. This proxy is the whole boundary: it
   * rewrites Host/Origin to the child's private loopback authority, so the child's own strict gate
   * can never see (or reject) the real browser authority. Everything this class forwards has to be
   * judged here first.
   */
  private policy: LocalAuthorityPolicy
  /** The origin a tunnel or proxy serves this board at; undefined while loopback-only. Live: see setPublicOrigin. */
  private publicOrigin: string | undefined
  private remoteControl: RemoteControlHandler | null = null
  /**
   * Codes and sessions for the public origin, or null when no public origin is declared (loopback-only
   * boards are never gated, so there is nothing to store).
   */
  private readonly access: AccessStore
  /** Both halves of every live upgraded pair, so close() can actually finish. See close(). */
  private readonly upgradedSockets = new Set<import("node:stream").Duplex>()

  constructor(options: RestartSupervisorProxyOptions) {
    this.options = options
    this.host = options.host ?? LOOPBACK_BIND_HOST
    this.publicOrigin = options.publicOrigin
    // Always built, even loopback-only: the origin can be set on a RUNNING board (the R pane), and a
    // store that outlives any one origin is what keeps a phone signed in across a rename.
    this.access = new AccessStore({
      onConsumed: () => options.onCodeConsumed?.(),
      ...(options.sessionKey ? { signingKey: options.sessionKey } : {}),
      ...(options.rotateSessionKey ? { rotateSigningKey: options.rotateSessionKey } : {}),
      ...(options.sessionDirectory ? { sessions: options.sessionDirectory } : {}),
    })
    this.policy = this.buildPolicy()
  }

  /**
   * Change the public origin on a running board — what the R pane does when the operator picks or
   * clears a remote setup. Requests already in flight finish under the policy they started with; the
   * next one is judged by the new origin. Sessions survive the change.
   */
  /** Offer (or withdraw) the launcher's remote-access setup at SUPERVISOR_REMOTE_PATH. */
  setRemoteControl(handler: RemoteControlHandler | null): void {
    this.remoteControl = handler
  }

  setPublicOrigin(origin: string | undefined): void {
    this.publicOrigin = origin
    this.policy = this.buildPolicy()
  }

  private buildPolicy(): LocalAuthorityPolicy {
    return {
      exposed: bindHostIsExposed(this.host),
      allowedHosts: this.options.allowedHosts ?? [],
      ...(this.publicOrigin ? { publicOrigin: this.publicOrigin } : {}),
    }
  }

  /**
   * Mint a single-use code for this board, or null when no public origin is declared.
   *
   * Issuing does NOT invalidate codes already outstanding — pressing the key twice, or two people
   * asking at once, must not silently break the first QR somebody is still walking towards.
   */
  issueAccessCode(): AccessCode | null {
    return this.publicOrigin ? this.access.issue() : null
  }

  /** The full URL to show as a link or a QR. */
  accessUrl(code: string): string | null {
    const origin = this.publicOrigin
    return origin ? `${origin}/?${ACCESS_CODE_PARAM}=${encodeURIComponent(code)}` : null
  }

  async listen(): Promise<void> {
    if (this.server) return
    const server = createServer((req, res) => this.handle(req, res))
    server.keepAliveTimeout = 5_000
    server.headersTimeout = 10_000
    server.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head))
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen)
      server.listen(this.options.port, this.host, () => {
        server.off("error", rejectListen)
        resolveListen()
      })
    })
    this.server = server
  }

  /**
   * Is this request allowed to reach the child at all?
   *
   * Deliberately the WEAKER of the two gates: a missing Origin passes here and the child then applies
   * its own per-route rule for it (only /health, /control/stop and `Sec-Fetch-Site: same-origin` may
   * omit one). What this stops is the thing the child cannot: an Origin naming somebody ELSE being
   * laundered into a valid same-origin one by proxyHeaders below.
   */
  private authorityAccepted(req: IncomingMessage, allowMissingOrigin = true): boolean {
    return isTrustedLocalHttpRequest(req.headers, this.options.port, allowMissingOrigin, this.policy)
  }

  /**
   * Is this an Origin-less request that only LOOKS suspicious because the browser could not send
   * Fetch Metadata to a non-loopback authority? See authoritySendsFetchMetadata.
   *
   * Ntwine's missing-Origin rules ask for `Sec-Fetch-Site: same-origin`, which Chrome never sends over
   * plain HTTP to a LAN address — so without this, `--host` serves the shell and then 403s every RPC
   * the app makes. Narrow on purpose: the Host must already be an authority this proxy accepts, there
   * must be no Origin at all (a present one still has to match, and is rejected above if it does not),
   * and loopback traffic is never touched, so the default posture keeps the real Sec-Fetch signal.
   *
   * The condition is `authoritySendsFetchMetadata`, not "is the bind address exposed", because those
   * two came apart with `--public-origin`: a tunnelled board stays on loopback yet is reached at a
   * name. An https proxy origin is potentially trustworthy, so the real signal survives and this
   * never fires for it; a plain-http one is in the same boat as a LAN address and needs the vouch.
   *
   * What this gives up, stated plainly: on an exposed board a cross-site GET carries no Origin and no
   * Fetch Metadata, so it is indistinguishable from the app's own read and is allowed. The response is
   * still opaque to the caller (no CORS), Ntwine's GET procedures are reads, and every mutation is a POST
   * — which a browser always stamps with an Origin, and which is therefore still refused.
   */
  private vouchesSameOrigin(req: IncomingMessage): boolean {
    if (req.headers.origin !== undefined || req.headers["sec-fetch-site"] !== undefined) return false
    const host = parseLocalHost(req.headers.host, this.options.port, this.policy)
    return !!host && !authoritySendsFetchMetadata(host)
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose())
      server.closeAllConnections()
      // An upgraded socket is DETACHED from the http server, so closeAllConnections() cannot see it
      // and server.close() waits on it forever. Ntwine always has live WebSockets (the board socket and
      // every open terminal), so without this the proxy never finishes closing once a browser has
      // connected. Measured: close() hung indefinitely after a single forwarded upgrade.
      for (const socket of this.upgradedSockets) socket.destroy()
      this.upgradedSockets.clear()
    })
  }

  private status(): { state: RestartControlState; message?: string; artifactDigest?: string; preparing?: boolean; updateRestart: boolean; updateAvailable?: boolean; version?: string; launcherVersion?: string; updateVersion?: string; dev?: boolean } {
    const delegated = this.options.status?.()
    const updateVersion = this.options.updateVersion?.()
    const version = typeof this.options.version === "function" ? this.options.version() : this.options.version
    const owner = { state: this.state, ...(this.message ? { message: this.message } : {}) }
    // A RESTART drains the child the moment it is accepted, so the owner's acknowledged transition
    // is the truth from the first poll and the delegate's lingering "ready" must not leak through it.
    //
    // An UPDATE is different: it has a PREPARE phase — ntwine-dev's source build, the registry
    // launcher's npm install — during which the old child is untouched and serving, and which can
    // run for minutes (a native module compiled from source on a slow box) or stall on a registry.
    // Reporting "restarting" through all of it put every open tab behind the blocking overlay for the
    // whole install (audit 2026-09-11, finding 6). So while an update is in flight the DELEGATE's
    // answer is reported: the owner delegate says "restarting" itself from the moment the drain
    // begins (see the option's doc), and its "ready" is stamped `preparing` — additive, absent
    // otherwise — so a client can say "installing" without treating the ack as already contradicted.
    // A proxy with no delegate has nothing truer to say and keeps reporting the acknowledged transition.
    const reported = this.transition === "update" && delegated
      ? { ...delegated, ...(delegated.state === "ready" ? { preparing: true } : {}) }
      : this.restartInFlight !== null || this.state === "failed"
        ? owner
        : delegated ?? owner
    return {
      ...(delegated ?? {}),
      ...reported,
      // Never infer this from the generic protocol: legacy/static supervisors can recover a child
      // but cannot build and promote the canonical Ntwine artifact.
      updateRestart: typeof this.options.updateRestart === "function",
      // Sent ONLY when the launcher can actually answer it, so an older client — and ntwine-dev, which
      // has no notion of "already current" — keeps today's behaviour on its absence.
      ...(this.options.updateAvailable ? { updateAvailable: this.options.updateAvailable() === true } : {}),
      // The active SERVER version changes on a child-only update. Its absence keeps ntwine-dev and
      // old monolithic supervisors' status payload and versionless UI exactly as they were.
      ...(version ? { version } : {}),
      ...(this.options.launcherVersion ? { launcherVersion: this.options.launcherVersion } : {}),
      ...(updateVersion ? { updateVersion } : {}),
      // Sent only when TRUE, so a published Ntwine's payload is byte-identical to what it sends today
      // and an older client is unaffected. Absent therefore means "not a development build".
      ...(this.options.dev ? { dev: true } : {}),
    }
  }

  private async runAction(action: () => Promise<RestartResult>, transition: "restart" | "update"): Promise<RestartResult> {
    if (this.restartInFlight) return this.restartInFlight
    this.transition = transition
    this.state = "restarting"
    this.message = undefined
    // Yield one turn before running the action. The durable update's artifact build is SYNCHRONOUS
    // (execFileSync through the whole typecheck + web build + bundle), so invoking it inline would
    // block this event loop for tens of seconds — and the 202 ack the caller writes right after
    // this returns would not reach the browser until the build was already over, leaving the client
    // unable to arm its reload before the supervisor re-execs. The state flip above is synchronous,
    // so no status read can observe "ready" in the gap.
    const work = (async () => {
      await new Promise<void>((resume) => setImmediate(resume))
      return action()
    })().then(
      (result) => {
        this.state = result.state
        this.message = result.message
        return result
      },
      (error) => {
        const result: RestartResult = { state: "failed", message: error instanceof Error ? error.message : String(error) }
        this.state = result.state
        this.message = result.message
        return result
      },
    ).finally(() => {
      this.restartInFlight = null
      this.transition = null
    })
    this.restartInFlight = work
    return work
  }

  private async handleControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = new URL(req.url ?? "/", "http://ntwine.invalid").pathname
    // THE SESSION GATE, for the control plane. handle() sends every control path here BEFORE its own
    // session check, so without this the tunnel reached restart, update-restart and status with no
    // session at all: the authority check below keys on Host and Origin, which any non-browser client
    // sets to whatever it likes. Found while building the phone's sign-out (2026-09-30).
    //
    // Checked first, as handle() does for pages, so an unauthenticated caller learns nothing beyond the
    // 401 — no body, no per-path answer. Loopback never trips it (arrivedPublicly is false), so the
    // operator's own tab and every launcher CLI call are untouched. The one exception is sign-out, which
    // verifies the session itself and answers a dead cookie with its own 401 plus a cleared cookie, so
    // the browser stops presenting it.
    if (pathname !== SUPERVISOR_SIGN_OUT_PATH && this.arrivedPublicly(req) && !this.sessionAccepted(req)) {
      res.writeHead(401, { "cache-control": "no-store" })
      res.end()
      return
    }
    const sameOrigin = req.headers["sec-fetch-site"] === "same-origin" || this.vouchesSameOrigin(req)
    // A browser sends no Origin on a GET, so the two READS accept Fetch Metadata in its place. Every
    // POST still has to name this board in its Origin.
    const allowMissingOrigin = (pathname === SUPERVISOR_STATUS_PATH || pathname === SUPERVISOR_REMOTE_PATH)
      && req.method === "GET" && sameOrigin
    if (!this.authorityAccepted(req, allowMissingOrigin)) {
      res.writeHead(403)
      res.end("Forbidden")
      return
    }
    if (pathname === SUPERVISOR_ACCESS_CODE_PATH) {
      // LOOPBACK ONLY, deliberately. Minting is how you let a NEW device in, so it must require
      // presence on the machine — not merely a session, which anyone already through the tunnel has.
      // Otherwise one shared link silently becomes the power to hand out unlimited further links.
      if (this.arrivedPublicly(req)) {
        res.writeHead(403)
        res.end("Forbidden")
        return
      }
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST" })
        res.end()
        return
      }
      const link = this.issueAccessCode()
      const url = link && this.accessUrl(link.code)
      if (!link || !url) {
        responseJson(res, 409, { error: "this board has no public origin, so there is nothing to link to" })
        return
      }
      responseJson(res, 200, { url, expiresAt: link.expiresAt })
      return
    }
    if (pathname === SUPERVISOR_SESSIONS_PATH) {
      // LOOPBACK ONLY, for the same reason minting is: a stolen session must not be able to sign the
      // real owner out and keep the board to itself. Being at the machine — or on it over ssh, which
      // is how a headless box mints a link — is the proof this needs.
      if (this.arrivedPublicly(req)) {
        res.writeHead(403)
        res.end("Forbidden")
        return
      }
      if (!this.publicOrigin) {
        responseJson(res, 409, { error: "this board has no public origin, so nothing is signed in" })
        return
      }
      if (req.method === "GET") {
        responseJson(res, 200, { sessions: this.access.sessions.list() })
        return
      }
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "GET, POST" })
        res.end()
        return
      }
      const body = await readJsonBody(req)
      const id = typeof body?.id === "string" ? body.id : undefined
      if (body?.all === true) {
        // signOutAll, not the denylist alone: it also rotates the key, so a session the directory never
        // recorded (minted before per-device ids, or by a server child's request after an epoch bump)
        // dies too. See signOutOlderSessionEpoch.
        responseJson(res, 200, { signedOut: this.access.signOutAll() })
        return
      }
      if (!id) {
        responseJson(res, 400, { error: "name a device id, or pass all: true" })
        return
      }
      // Reporting the miss matters: an operator who mistypes an id must not be told the lost phone is
      // signed out when nothing happened.
      if (!this.access.sessions.revoke(id)) {
        responseJson(res, 404, { error: `no signed-in device has the id ${id}` })
        return
      }
      responseJson(res, 200, { signedOut: 1 })
      return
    }
    if (pathname === SUPERVISOR_REMOTE_PATH) {
      // LOOPBACK ONLY, and for reads too. Choosing how the board is reached decides who can reach it,
      // so it needs presence on the machine, like minting a link: a session through the tunnel could
      // otherwise point the board at a name of its own choosing, or turn remote access off and strand
      // the phone that did it. Reads are refused as well because they carry the machine's GitHub login
      // and tailnet name, which a phone has no use for.
      if (this.arrivedPublicly(req)) {
        res.writeHead(403)
        res.end("Forbidden")
        return
      }
      const handler = this.remoteControl
      if (!handler) {
        responseJson(res, 404, { protocol: SUPERVISOR_CONTROL_PROTOCOL, error: "this launch cannot change remote access" })
        return
      }
      if (req.method !== "GET" && req.method !== "POST") {
        res.writeHead(405, { allow: "GET, POST" })
        res.end()
        return
      }
      try {
        const reply = req.method === "GET" ? await handler.get() : await handler.post(await readJsonBody(req))
        responseJson(res, reply.status, reply.body)
      } catch (error) {
        responseJson(res, 500, { protocol: SUPERVISOR_CONTROL_PROTOCOL, error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    if (pathname === SUPERVISOR_SIGN_OUT_PATH) {
      // Reachable from the tunnel, unlike SESSIONS above, because it can only ever end the session that
      // is MAKING the request: the id is read out of this request's own cookie after its signature
      // verifies, and there is no body to name another one. So the worst a stolen session can do here is
      // sign ITSELF out — which is what the owner wanted done to it anyway — and the rule that protects
      // the owner ("a stolen session must not be able to evict the owner and keep the board") is
      // untouched: evicting ANY OTHER device still needs loopback.
      //
      // CSRF: it is a POST, so the authority gate above has already demanded an Origin naming this
      // board (allowMissingOrigin is false for every path but a same-origin status read), and the
      // cookie is SameSite=Lax, so a cross-site page neither passes the gate nor carries the session.
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST" })
        res.end()
        return
      }
      this.signOutThisDevice(req, res)
      return
    }
    if (pathname === SUPERVISOR_STATUS_PATH && req.method === "GET") {
      responseJson(res, 200, {
        protocol: SUPERVISOR_CONTROL_PROTOCOL,
        ...this.status(),
        // Sent ONLY when true, so a loopback tab's payload is byte-identical to what it was. The web
        // app cannot tell on its own: the session cookie is HttpOnly, and the page is the same bundle
        // whichever way it was reached. It is a fact about THIS request, never about the board.
        ...(this.carriesRemoteSession(req) ? { remoteSession: true } : {}),
      })
      return
    }
    if ((pathname !== SUPERVISOR_RESTART_PATH && pathname !== SUPERVISOR_UPDATE_RESTART_PATH) || req.method !== "POST") {
      res.writeHead(405, { allow: pathname === SUPERVISOR_STATUS_PATH ? "GET" : "POST" })
      res.end()
      return
    }
    if (pathname === SUPERVISOR_UPDATE_RESTART_PATH && !this.options.updateRestart) {
      responseJson(res, 409, { protocol: SUPERVISOR_CONTROL_PROTOCOL, state: "failed", message: "Update & Restart is available only for a stable immutable Ntwine artifact" })
      return
    }
    if (pathname === SUPERVISOR_UPDATE_RESTART_PATH) {
      // Building and re-executing the durable owner can outlive (and intentionally close) this
      // response. Acknowledge ownership of the transition immediately; /status remains the source
      // of truth until a successor is ready or the candidate fails.
      void this.runAction(this.options.updateRestart!, "update")
      responseJson(res, 202, { protocol: SUPERVISOR_CONTROL_PROTOCOL, state: "restarting" })
      return
    }
    const result = await this.runAction(this.options.restart, "restart")
    responseJson(res, result.state === "ready" ? 202 : 503, { protocol: SUPERVISOR_CONTROL_PROTOCOL, ...result })
  }

  private handleLocalImage(req: IncomingMessage, res: ServerResponse): void {
    const allowMissingOrigin = req.headers.origin === undefined
      && (req.headers["sec-fetch-site"] === "same-origin" || this.vouchesSameOrigin(req))
    if (!this.authorityAccepted(req, allowMissingOrigin)) {
      res.writeHead(403, { "content-type": "text/plain; charset=UTF-8" })
      res.end("Forbidden")
      return
    }

    const url = new URL(req.url ?? "/", "http://ntwine.invalid")
    const result = resolveLocalImage(url.searchParams.get("path") ?? undefined, req.headers.range)
    const origin = typeof req.headers.origin === "string"
      ? allowedLocalCorsOrigin(req.headers.origin, this.options.port, this.policy)
      : undefined
    const sharedHeaders = {
      ...(origin ? { "access-control-allow-origin": origin } : {}),
      "access-control-expose-headers": "x-ntwine-boot",
      vary: "Origin",
    }
    if (result.status === 416) {
      res.writeHead(416, { ...sharedHeaders, "content-range": `bytes */${result.size}`, "accept-ranges": "bytes" })
      res.end()
      return
    }
    if (result.status === 400 || result.status === 404) {
      res.writeHead(result.status, { ...sharedHeaders, "content-type": "text/plain; charset=UTF-8" })
      res.end(String(result.status))
      return
    }
    res.writeHead(result.status, { ...sharedHeaders, ...localImageHeaders(result) })
    const stream = req.method === "HEAD" ? null : localImageStream(result)
    if (!stream) {
      res.end()
      return
    }
    // A media element abandons ranges constantly; `pipeline` closes the file whichever side ends first.
    pipeline(stream, res, () => undefined)
  }

  /**
   * Is this request arriving as the declared public origin rather than over loopback?
   *
   * The token gate keys on this and not on "is the port exposed", because the two are independent:
   * a tunnelled board stays bound to 127.0.0.1 while being reachable from the internet by name.
   */
  private arrivedPublicly(req: IncomingMessage): boolean {
    const declared = this.publicOrigin
    if (!declared) return false
    const host = parseLocalHost(req.headers.host, this.options.port, this.policy)
    return !!host && !LOOPBACK_HOSTNAMES.has(host.hostname)
  }

  /**
   * Bearer check for the public origin. Two ways in: the cookie the exchange below sets, or the
   * one-time `?ntwine_token=` in the URL the operator was handed at launch.
   *
   * Compared with `timingSafeEqual` on equal-length buffers — a plain `===` on a secret leaks its
   * prefix to a patient attacker, and this secret is the only thing between the internet and a shell.
   */
  /**
   * Is this request carrying a session this process minted?
   *
   * Sessions only. A raw `?ntwine_code=` is NOT accepted here — it is redeemed once by exchangeCode()
   * below and traded for a session, so a code that has already been spent cannot keep working just by
   * staying in somebody's URL bar.
   */
  private sessionAccepted(req: IncomingMessage): boolean {
    if (!this.publicOrigin) return true
    return this.access.verifySession(sessionCookie(req.headers.cookie))
  }

  /**
   * What this proxy knows about who sent a request, for the application server's audit trail
   * (audit.ts). The session is named by its record id, never its value, and only once it verifies.
   *
   * `clientIp` is only ever taken from a request that arrived as the public origin, and it is that
   * origin's CLAIM: a relay or tunnel reaches this port from loopback, so the real visitor address
   * exists only in what the relay chose to forward (`cf-connecting-ip` from Cloudflare).
   */
  private callerStamp(req: IncomingMessage): string {
    const remote = req.socket.remoteAddress ?? null
    const via: CallerVia = this.arrivedPublicly(req) ? "public" : isLoopbackAddress(remote) ? "loopback" : "network"
    const host = via === "loopback" ? undefined : firstHeader(req.headers.host)
    const forwarded = firstHeader(req.headers["x-forwarded-for"])?.split(",")[0]?.trim()
    const clientIp = via === "public"
      ? firstHeader(req.headers["cf-connecting-ip"]) ?? firstHeader(req.headers["x-real-ip"]) ?? forwarded
      : undefined
    return encodeCallerStamp({
      via,
      remote,
      ...(host ? { host: host.slice(0, 200) } : {}),
      ...(clientIp ? { clientIp: clientIp.slice(0, 200) } : {}),
      session: this.access.sessionIdOf(sessionCookie(req.headers.cookie)),
    })
  }

  /** Did this request arrive through the public origin carrying a live session? Loopback never does. */
  private carriesRemoteSession(req: IncomingMessage): boolean {
    return this.arrivedPublicly(req) && this.access.verifySession(sessionCookie(req.headers.cookie))
  }

  /**
   * End the session this request carries, and nothing else — see SUPERVISOR_SIGN_OUT_PATH in
   * handleControl for why that makes it safe to reach from the tunnel.
   *
   * A loopback request is a no-op even if it somehow carries a cookie: the operator's own tab has no
   * remote session to end, and loopback is the place `--sign-out` already covers.
   */
  private signOutThisDevice(req: IncomingMessage, res: ServerResponse): void {
    const reply = (status: number, body: SignOutThisDeviceResult, clearCookie: boolean) => {
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        // Same attributes the exchange set, so the browser matches and drops that exact cookie.
        ...(clearCookie ? { "set-cookie": [SESSION_COOKIE, LEGACY_SESSION_COOKIE].map((name) => `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`) } : {}),
      })
      res.end(JSON.stringify(body))
    }
    if (!this.arrivedPublicly(req)) {
      reply(200, { protocol: SUPERVISOR_CONTROL_PROTOCOL, result: "no-remote-session" }, false)
      return
    }
    const outcome = this.access.signOutSession(sessionCookie(req.headers.cookie))
    if (outcome.result === "revoked") {
      reply(200, { protocol: SUPERVISOR_CONTROL_PROTOCOL, result: "signed-out", id: outcome.id }, true)
      return
    }
    if (outcome.result === "legacy") {
      reply(200, { protocol: SUPERVISOR_CONTROL_PROTOCOL, result: "cookie-cleared" }, true)
      return
    }
    // A dead cookie is cleared too: it can never work again, and leaving it only makes the browser keep
    // presenting it. 401 because a public request with no live session is unauthenticated.
    reply(401, { protocol: SUPERVISOR_CONTROL_PROTOCOL, result: "no-remote-session" }, true)
  }

  /**
   * Move a live session from the pre-rename cookie to today's, on a page load: bounce to the same URL
   * setting `ntwine_session` (expiring when the session does, as exchangeCode sets it) and clearing
   * `frizz_session`. Only a top-level GET navigation is redirected — a fetch or a socket carrying the old
   * cookie is simply accepted under it (sessionCookie), since a redirect there would break the call.
   */
  private adoptLegacySession(req: IncomingMessage, res: ServerResponse): boolean {
    if (req.method !== "GET" || firstHeader(req.headers["sec-fetch-mode"]) !== "navigate") return false
    if (readCookie(req.headers.cookie, SESSION_COOKIE) !== undefined) return false
    const session = readCookie(req.headers.cookie, LEGACY_SESSION_COOKIE)
    if (!session || !this.access.verifySession(session)) return false
    const expiresAt = Number(session.slice(0, session.indexOf(".")))
    const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
    res.writeHead(302, {
      location: req.url || "/",
      "set-cookie": [
        `${SESSION_COOKIE}=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`,
        `${LEGACY_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
      ],
      "cache-control": "no-store",
    })
    res.end()
    return true
  }

  /**
   * Trade `?ntwine_code=…` for a cookie, then bounce to the same URL
   * without the secret, so it never lands in history, a Referer header, or a screenshot.
   */
  private exchangeCode(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? "/", "http://ntwine.invalid")
    const code = url.searchParams.get(ACCESS_CODE_PARAM) ?? url.searchParams.get(LEGACY_ACCESS_CODE_PARAM)
    if (code === null) return false

    // The User-Agent is the only thing a board ever records about a visitor's browser, and it exists
    // so `ntwine --sessions` can say "iPhone" instead of an opaque id nobody can match to a device.
    const redeemed = this.access.redeem(code, describeDevice(req.headers["user-agent"]))
    if (!redeemed?.ok) {
      // Say WHICH failure. "This link was already used" and "no such link" send a person to very
      // different next actions, and the store keeps consumed codes precisely so we can tell them apart.
      res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      res.end(unauthorizedPage(redeemed?.reason))
      return true
    }
    const cookie = `${SESSION_COOKIE}=${redeemed.session}`
    // The browser forgets the cookie when the session it carries stops verifying, not a year later.
    const maxAge = Math.max(0, Math.floor((redeemed.expiresAt - Date.now()) / 1000))

    url.searchParams.delete(ACCESS_CODE_PARAM)
    url.searchParams.delete(LEGACY_ACCESS_CODE_PARAM)
    const target = `${url.pathname}${url.search}${url.hash}` || "/"
    // Secure + SameSite=Lax: the origin is https through the tunnel, and Lax still permits the
    // top-level navigation that lands here while refusing cross-site writes.
    res.writeHead(302, {
      location: target,
      "set-cookie": `${cookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`,
      "cache-control": "no-store",
    })
    res.end()
    return true
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    if (req.url) req.url = adoptLegacyRoute(req.url)
    if (isControlRequest(req)) {
      void this.handleControl(req, res)
      return
    }
    // Exchange FIRST: the arriving link carries the credential, so judging before redeeming would
    // reject the very request that is meant to establish the session.
    if (this.arrivedPublicly(req) && this.exchangeCode(req, res)) return
    if (this.arrivedPublicly(req) && this.adoptLegacySession(req, res)) return
    if (this.arrivedPublicly(req) && !this.sessionAccepted(req)) {
      res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      res.end(unauthorizedPage())
      return
    }
    if (!this.authorityAccepted(req)) {
      const name = unlistedHostName(req.headers.host, this.options.port, this.policy)
      if (name) {
        res.writeHead(403, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
        res.end(req.method === "HEAD" ? undefined : unlistedHostPage(name))
        return
      }
      res.writeHead(403, { "content-type": "text/plain; charset=UTF-8" })
      res.end("Forbidden")
      return
    }
    // Keep screenshots responsive even while the disposable child is parsing large transcripts,
    // restarting, or unavailable. The durable owner applies the same local-origin gate itself.
    if (isLocalImageRequest(req)) {
      this.handleLocalImage(req, res)
      return
    }
    const childPort = this.options.childPort()
    if (!childPort) {
      res.writeHead(503, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "retry-after": "2" })
      res.end(recoveryPage(req.url ?? "/"))
      return
    }
    const upstream = requestHttp({
      host: "127.0.0.1",
      port: childPort,
      method: req.method,
      path: req.url,
      headers: proxyHeaders(req, childPort, this.callerStamp(req), this.vouchesSameOrigin(req)),
    }, (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
      upstreamResponse.pipe(res)
    })
    upstream.once("error", () => {
      if (res.headersSent) return res.destroy()
      res.writeHead(503, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      res.end(recoveryPage(req.url ?? "/", "unreachable"))
    })
    req.pipe(upstream)
  }

  private handleUpgrade(req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void {
    if (req.url) req.url = adoptLegacyRoute(req.url)
    // The board socket and every terminal come through here, so the bearer gate has to cover the
    // upgrade too — otherwise the shell is reachable without the secret the HTML path demands. No
    // query-param exchange here: a browser sends the cookie it was given on the page that opened it.
    if (this.arrivedPublicly(req) && !this.sessionAccepted(req)) {
      rejectWebSocketUpgrade(socket, 401, "Unauthorized")
      return
    }
    // A browser always sends Origin on a WebSocket handshake and the child requires one, so this is
    // the strict form of the gate — the child will never get the chance to apply it itself.
    if (!this.authorityAccepted(req, false)) {
      socket.destroy()
      return
    }
    const childPort = this.options.childPort()
    if (!childPort) {
      socket.destroy()
      return
    }
    const upstream = connect(childPort, "127.0.0.1")
    for (const half of [socket, upstream]) {
      this.upgradedSockets.add(half)
      half.once("close", () => this.upgradedSockets.delete(half))
    }
    upstream.once("connect", () => {
      const headers = proxyHeaders(req, childPort, this.callerStamp(req))
      // proxyHeaders drops the hop-by-hop `connection` header (right for the plain-HTTP handle()
      // path). But a WebSocket upgrade REQUIRES it: without `Connection: Upgrade` the child's HTTP
      // parser never emits 'upgrade', answers the SPA with 200, and the handshake fails — silently
      // breaking the terminal and the /ws multiplex through the control-plane proxy. Restore it.
      headers.connection = req.headers.connection ?? "Upgrade"
      const lines = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/${req.httpVersion}`]
      for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) continue
        for (const entry of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${entry}`)
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`)
      if (head.length > 0) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    upstream.once("error", () => socket.destroy())
    socket.once("error", () => upstream.destroy())
  }
}
