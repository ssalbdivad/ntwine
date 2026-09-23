import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import { WebSocket, WebSocketServer, type RawData } from "ws"
import pty from "node-pty"
import { ThreadSlug, type TermClientMsg, FRIZZ_ROUTE_PREFIX } from "@frizz/shared"
import { isTrustedLocalWebSocketRequest, rejectWebSocketUpgrade } from "./local-origin.ts"
import type { LoginAttachment } from "./login-utility.ts"

// The /term/<slug> transport. It serves exactly TWO things, both ptys some other module owns and shares
// across every viewing tab: a provider sign-in attempt (login-utility.ts), and a terminal command thread
// the human started from the prompt box (command-threads.ts).
//
// It used to attach each viewer to a `tmux -L <socket> attach-session -t frizz-<slug>` so an operator
// could watch an agent's TUI. Agents no longer run in panes — the broker drives them over pipes — so
// there is nothing to attach to, and the whole tmux half of this file (socket resolution, per-viewer
// attach ptys, and the refresh-client dance that worked around tmux's resize replay) went with it.

const TERM_PATH = new RegExp(`^${FRIZZ_ROUTE_PREFIX}/term/([^/?]+)$`)


// Keep the raw websocket bounded before JSON parsing, and independently validate the decoded input.
// A terminal paste may reasonably be large, but accepting ws's 100 MiB default would let one local
// client pin the control plane. Grid dimensions are deliberately far above any real xterm viewport
// while staying comfortably inside node-pty's useful range.
export const TERMINAL_MAX_INPUT_BYTES = 1_048_576
export const TERMINAL_MAX_MESSAGE_BYTES = TERMINAL_MAX_INPUT_BYTES + 1_024
export const TERMINAL_MAX_COLS = 1_000
export const TERMINAL_MAX_ROWS = 1_000
export const TERMINAL_MAX_OUTPUT_BUFFER_BYTES = 4 * 1_024 * 1_024
export const TERMINAL_MAX_VIEWERS = 32
export const TERMINAL_MAX_VIEWERS_PER_SLUG = 8
export const TERMINAL_INPUT_RATE_WINDOW_MS = 1_000
export const TERMINAL_MAX_INPUT_FRAMES_PER_WINDOW = 120
export const TERMINAL_MAX_INPUT_BYTES_PER_WINDOW = 2 * TERMINAL_MAX_MESSAGE_BYTES
export const TERMINAL_CLOSE_GRACE_MS = 250
export const TERMINAL_SHUTDOWN_GRACE_MS = 500

export function parseTermClientMsg(raw: string): TermClientMsg | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const msg = value as Record<string, unknown>
  if (msg.t === "input") {
    if (
      Object.keys(msg).length !== 2 ||
      !Object.prototype.hasOwnProperty.call(msg, "d") ||
      typeof msg.d !== "string" ||
      Buffer.byteLength(msg.d, "utf8") > TERMINAL_MAX_INPUT_BYTES
    ) return null
    return { t: "input", d: msg.d }
  }
  if (msg.t === "resize") {
    if (
      Object.keys(msg).length !== 3 ||
      !Object.prototype.hasOwnProperty.call(msg, "cols") ||
      !Object.prototype.hasOwnProperty.call(msg, "rows")
    ) return null
    const cols = msg.cols
    const rows = msg.rows
    if (
      !Number.isFinite(cols) ||
      !Number.isInteger(cols) ||
      !Number.isFinite(rows) ||
      !Number.isInteger(rows) ||
      (cols as number) < 1 ||
      (rows as number) < 1 ||
      (cols as number) > TERMINAL_MAX_COLS ||
      (rows as number) > TERMINAL_MAX_ROWS
    ) {
      return null
    }
    return { t: "resize", cols: cols as number, rows: rows as number }
  }
  return null
}

export function parseTermSlug(url: string | undefined): string | null {
  const path = (url ?? "").split("?")[0]
  const m = path.match(TERM_PATH)
  if (!m) return null
  const parsed = ThreadSlug.safeParse(m[1])
  return parsed.success ? parsed.data : null
}

export interface TerminalServer {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean
  close(): Promise<void>
}

export interface TerminalServerDeps {
  // Resolve a live provider sign-in attempt. Null ⇒ this slug is not attachable.
  resolveLogin?: (slug: string) => LoginAttachment | null
  // Resolve one of this project's terminal command threads. Consulted only when no login attempt
  // claims the slug; the two id spaces (`login-…`, `term-…`) never overlap anyway.
  resolveCommand?: (slug: string) => LoginAttachment | null
  maxOutputBufferBytes?: number
  maxViewers?: number
  maxViewersPerSlug?: number
  inputRateWindowMs?: number
  maxInputFramesPerWindow?: number
  maxInputBytesPerWindow?: number
  closeGraceMs?: number
  shutdownGraceMs?: number
  now?: () => number
  terminateSocket?: (ws: WebSocket) => void
}

// The members this transport uses on its source; a login attempt's shared pty is adapted onto it.
export interface TerminalSource {
  onData(listener: (chunk: string) => void): { dispose(): void }
  onExit(listener: (event: { exitCode: number }) => void): { dispose(): void }
  resize(cols: number, rows: number): void
  write(data: string): void
  /**
   * Release THIS viewer's hold. A no-op for a login attempt: there is no per-viewer process, and the
   * shared pty belongs to the login utility while another tab may still be watching.
   */
  kill(): void
}

// Present a login attempt's SHARED pty as a per-viewer source. Detaching disposes only this viewer's
// listeners — never the pty, which another tab may still be watching and which the login utility owns.
// The replay is delivered as the first data event so a tab opened after the OAuth URL was printed
// still sees it, without this transport needing its own scrollback.
function adaptLoginSource(attachment: LoginAttachment): TerminalSource {
  return {
    onData(listener) {
      const unsubscribe = attachment.onData(listener)
      const replay = attachment.replay()
      if (replay) queueMicrotask(() => listener(replay))
      return { dispose: unsubscribe }
    },
    onExit(listener) {
      // The sign-in utility reports "the CLI finished" without a code; 0 keeps the close reason
      // well-formed (the caller re-reads credential state for the real verdict, never this number). A
      // command thread passes its real code, which the drawer shows.
      const unsubscribe = attachment.onExit((exitCode) => listener({ exitCode: exitCode ?? 0 }))
      return { dispose: unsubscribe }
    },
    resize: (cols, rows) => attachment.resize(cols, rows),
    write: (data) => attachment.write(data),
    // Deliberately does NOT kill the login pty: closing one tab must not abandon an OAuth flow another
    // tab is still driving, and the utility owns that lifecycle (cancel / success / timeout / stop).
    kill: () => attachment.close(),
  }
}


// noServer mode: index.ts owns the single http server and routes upgrades here. Returns true
// iff the request was a /term/<slug> upgrade we claimed.
export function createTerminalServer(deps: TerminalServerDeps = {}): TerminalServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: TERMINAL_MAX_MESSAGE_BYTES })
  let closing = false
  let closePromise: Promise<void> | null = null
  const configuredInteger = (value: number | undefined, fallback: number, minimum = 0) =>
    value !== undefined && Number.isSafeInteger(value) && value >= minimum ? value : fallback
  const maxOutputBufferBytes = configuredInteger(
    deps.maxOutputBufferBytes,
    TERMINAL_MAX_OUTPUT_BUFFER_BYTES,
  )
  const maxViewers = configuredInteger(deps.maxViewers, TERMINAL_MAX_VIEWERS)
  const maxViewersPerSlug = configuredInteger(
    deps.maxViewersPerSlug,
    TERMINAL_MAX_VIEWERS_PER_SLUG,
  )
  const inputRateWindowMs = configuredInteger(
    deps.inputRateWindowMs,
    TERMINAL_INPUT_RATE_WINDOW_MS,
    1,
  )
  const maxInputFramesPerWindow = configuredInteger(
    deps.maxInputFramesPerWindow,
    TERMINAL_MAX_INPUT_FRAMES_PER_WINDOW,
  )
  const maxInputBytesPerWindow = configuredInteger(
    deps.maxInputBytesPerWindow,
    TERMINAL_MAX_INPUT_BYTES_PER_WINDOW,
  )
  const closeGraceMs = configuredInteger(deps.closeGraceMs, TERMINAL_CLOSE_GRACE_MS)
  const shutdownGraceMs = configuredInteger(
    deps.shutdownGraceMs,
    TERMINAL_SHUTDOWN_GRACE_MS,
  )
  const now = deps.now ?? Date.now
  const terminateSocket = deps.terminateSocket ?? ((ws: WebSocket) => ws.terminate())
  let viewerCount = 0
  const viewersPerSlug = new Map<string, number>()

  interface Reservation {
    slug: string
    release(): void
  }
  interface Viewer {
    cleanup(): void
    shutdown(): void
  }
  interface PendingUpgrade {
    abort(status?: number, reason?: string): void
  }

  const viewers = new Set<Viewer>()
  const pendingUpgrades = new Set<PendingUpgrade>()

  const reserveViewer = (slug: string): Reservation | null => {
    const slugCount = viewersPerSlug.get(slug) ?? 0
    if (viewerCount >= maxViewers || slugCount >= maxViewersPerSlug) return null
    viewerCount += 1
    viewersPerSlug.set(slug, slugCount + 1)
    let released = false
    return {
      slug,
      release() {
        if (released) return
        released = true
        viewerCount -= 1
        const nextSlugCount = (viewersPerSlug.get(slug) ?? 1) - 1
        if (nextSlugCount <= 0) viewersPerSlug.delete(slug)
        else viewersPerSlug.set(slug, nextSlugCount)
      },
    }
  }

  const rawDataBuffer = (raw: RawData): Buffer => {
    if (Buffer.isBuffer(raw)) return raw
    if (Array.isArray(raw)) return Buffer.concat(raw)
    return Buffer.from(raw)
  }

  // noServer still emits operational errors (for example a malformed extension negotiation). Contain
  // them to this transport; individual socket/PTY failures have their own close paths below.
  wss.on("error", () => {})

  const acceptViewer = (ws: WebSocket, slug: string, reservation: Reservation): void => {
      let term: TerminalSource | undefined
    let cleaned = false
    let closeStarted = false
    let terminated = false
    let forceCloseTimer: ReturnType<typeof setTimeout> | undefined
    let dataSubscription: { dispose(): void } | undefined
    let exitSubscription: { dispose(): void } | undefined
    const inputWindow: Array<{ at: number; bytes: number }> = []
    let inputWindowBytes = 0


    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      reservation.release()
      const ownedDataSubscription = dataSubscription
      dataSubscription = undefined
      const ownedExitSubscription = exitSubscription
      exitSubscription = undefined
      try {
        ownedDataSubscription?.dispose()
      } catch {
        // A node-pty implementation may already have removed its data listener during exit.
      }
      try {
        ownedExitSubscription?.dispose()
      } catch {
        // Likewise, listener disposal is best-effort but is attempted exactly once.
      }
      const ownedTerm = term
      term = undefined
      if (ownedTerm) {
        try {
          ownedTerm.kill()
        } catch {
          // The sign-in PTY may already have exited. It is never an agent worker: no agent runs on a
          // pty, so nothing an agent depends on is reachable from here.
        }
      }
    }

    let viewer: Viewer
    const forceTerminate = () => {
      if (terminated) return
      terminated = true
      cleanup()
      try {
        terminateSocket(ws)
      } catch {
        // The peer may have disappeared without delivering a close event.
      }
      viewers.delete(viewer)
    }
    const beginClose = (code: number, reason: string) => {
      if (closeStarted) return
      closeStarted = true
      cleanup()
      if (ws.readyState === WebSocket.CLOSED) {
        viewers.delete(viewer)
        return
      }
      forceCloseTimer = setTimeout(forceTerminate, closeGraceMs)
      forceCloseTimer.unref?.()
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(code, reason)
        }
      } catch {
        forceTerminate()
      }
    }
    viewer = {
      cleanup,
      shutdown() {
        closeStarted = true
        cleanup()
        forceTerminate()
      },
    }
    viewers.add(viewer)

    ws.once("close", () => {
      clearTimeout(forceCloseTimer)
      cleanup()
      viewers.delete(viewer)
    })
    ws.on("error", () => beginClose(1011, "terminal transport failed"))

    if (closing) {
      viewer.shutdown()
      return
    }

    // /term serves a provider sign-in attempt or a terminal command thread — in both, the pty belongs
    // to its owning module and is shared across viewers. An AGENT thread has no terminal to attach to —
    // it runs inside a detached daemon over pipes — so a slug that is neither is simply not attachable.
    let loginAttachment: LoginAttachment | null = null
    try {
      loginAttachment = deps.resolveLogin?.(slug) ?? deps.resolveCommand?.(slug) ?? null
    } catch {
      beginClose(1011, "terminal unavailable")
      return
    }
    if (!loginAttachment) {
      beginClose(1008, "terminal attach denied")
      return
    }

    try {
      // The login utility owns the pty, not this transport: two tabs on the sign-in modal must watch
      // the SAME OAuth flow rather than racing two of them against one credential store.
      term = adaptLoginSource(loginAttachment)
    } catch {
      beginClose(1011, "terminal unavailable")
      return
    }


    const acceptInputSample = (bytes: number): boolean => {
      const at = now()
      const cutoff = at - inputRateWindowMs
      while (inputWindow.length > 0 && inputWindow[0]!.at <= cutoff) {
        inputWindowBytes -= inputWindow.shift()!.bytes
      }
      if (
        inputWindow.length + 1 > maxInputFramesPerWindow ||
        inputWindowBytes + bytes > maxInputBytesPerWindow
      ) {
        return false
      }
      inputWindow.push({ at, bytes })
      inputWindowBytes += bytes
      return true
    }

    try {
      dataSubscription = term.onData((d) => {
        if (cleaned || ws.readyState !== WebSocket.OPEN) return
        if (ws.bufferedAmount + Buffer.byteLength(d, "utf8") > maxOutputBufferBytes) {
          // Release the PTY and viewer reservation immediately. A short close grace lets a healthy
          // peer receive 1013; a wedged peer is forcibly terminated without retaining resources.
          beginClose(1013, "terminal viewer overloaded")
          return
        }
        try {
          ws.send(d, (error) => {
            if (error) beginClose(1011, "terminal transport failed")
          })
        } catch {
          beginClose(1011, "terminal transport failed")
        }
      })
      exitSubscription = term.onExit(({ exitCode }) => {
        if (!cleaned) beginClose(1000, `pty exit ${exitCode}`)
      })
    } catch {
      beginClose(1011, "terminal unavailable")
      return
    }

    ws.on("message", (raw: RawData, isBinary: boolean) => {
      if (cleaned) return
      if (isBinary) {
        beginClose(1003, "terminal text frames required")
        return
      }
      const payload = rawDataBuffer(raw)
      if (!acceptInputSample(payload.byteLength)) {
        beginClose(1013, "terminal input rate limited")
        return
      }
      const msg = parseTermClientMsg(payload.toString("utf8"))
      if (!msg) {
        beginClose(1008, "invalid terminal message")
        return
      }
      const activeTerm = term
      if (!activeTerm) return
      try {
        if (msg.t === "input") activeTerm.write(msg.d)
        else {
          activeTerm.resize(msg.cols, msg.rows)
        }
      } catch {
        // A valid message can still race a dead/detached PTY. Contain that failure to this viewer;
        // the Frizz control plane and every running agent worker must survive.
        beginClose(1011, "terminal unavailable")
      }
    })
  }

  return {
    handleUpgrade(req, socket, head) {
      const slug = parseTermSlug(req.url)
      if (slug === null) return false
      if (closing) {
        rejectWebSocketUpgrade(socket, 503, "Service Unavailable")
        return true
      }
      // A terminal attach is direct keyboard authority over a live agent. Browser upgrades must carry
      // the exact same loopback Origin as Host; missing, cross-origin, forwarded, and DNS-prefix claims
      // are denied before a PTY exists.
      if (!isTrustedLocalWebSocketRequest(req)) {
        rejectWebSocketUpgrade(socket)
        return true
      }

      // Reserve synchronously before websocket negotiation. This counts both established viewers and
      // upgrades in flight, so concurrent handshakes cannot race past either cap before spawning PTYs.
      const reservation = reserveViewer(slug)
      if (!reservation) {
        rejectWebSocketUpgrade(socket, 429, "Too Many Requests")
        return true
      }

      let finished = false
      const finishPending = (): boolean => {
        if (finished) return false
        finished = true
        pendingUpgrades.delete(pending)
        socket.removeListener("close", abandonPending)
        socket.removeListener("error", abandonPending)
        return true
      }
      const abandonPending = () => {
        if (finishPending()) reservation.release()
      }
      const pending: PendingUpgrade = {
        abort(status, reason) {
          if (!finishPending()) return
          reservation.release()
          if (status) rejectWebSocketUpgrade(socket, status, reason)
          else {
            try {
              socket.destroy()
            } catch {
              // The peer already left while its handshake was in flight.
            }
          }
        },
      }
      pendingUpgrades.add(pending)
      socket.once("close", abandonPending)
      socket.once("error", abandonPending)

      try {
        wss.handleUpgrade(req, socket, head, (ws) => {
          if (!finishPending()) {
            try {
              ws.terminate()
            } catch {
              // Shutdown already reclaimed the in-flight upgrade.
            }
            return
          }
          try {
            acceptViewer(ws, slug, reservation)
          } catch {
            reservation.release()
            try {
              ws.terminate()
            } catch {
              // A failed setup owns no PTY and cannot escape the transport boundary.
            }
          }
        })
      } catch {
        pending.abort(400, "Bad Request")
      }
      return true
    },
    close() {
      if (closePromise) return closePromise
      closing = true
      closePromise = (async () => {
        // Reclaim all owned PTYs, reservations, listeners and timers synchronously. Socket close
        // events are advisory during replacement: a bounded server drain prevents a broken peer or
        // mocked transport from keeping the old control-plane process alive indefinitely.
        for (const pending of [...pendingUpgrades]) {
          pending.abort(503, "Service Unavailable")
        }
        for (const viewer of [...viewers]) viewer.shutdown()

        let drainTimer: ReturnType<typeof setTimeout> | undefined
        const boundedServerDrain = new Promise<void>((resolve) => {
          let resolved = false
          const finish = () => {
            if (resolved) return
            resolved = true
            clearTimeout(drainTimer)
            resolve()
          }
          drainTimer = setTimeout(finish, shutdownGraceMs)
          try {
            wss.close(finish)
          } catch {
            finish() // Idempotent shutdown after a failed boot/upgrade.
          }
        })
        await boundedServerDrain
        viewers.clear()
      })()
      return closePromise
    },
  }
}
