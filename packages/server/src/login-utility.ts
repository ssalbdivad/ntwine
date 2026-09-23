import { randomBytes } from "node:crypto"
import pty from "node-pty"
import type { Backend } from "@frizz/shared"
import { resolveClaudeExecutableAbsolute } from "./backend/claude-broker-host.ts"
import { resolveCodexExecutable } from "./backend/codex-executable.ts"

// A restricted, short-lived provider ACCOUNT utility — the terminal behind the sign-in modal's
// primary "Sign in" action. This is NOT the agent-thread terminal: it never resumes or mutates a
// worker, inherits no project prompt, and accepts no arbitrary shell command — the pty runs exactly
// the provider's own login argv (`claude auth login`) and nothing else, spawned WITHOUT an
// intervening shell.
//
// Runs on node-pty DIRECTLY. It used to run inside a tmux pane, which was the last piece of frizz that
// genuinely needed tmux — every agent transport had already moved to the broker/app-server (pipes and
// JSON-RPC, no PTY at all), so a whole terminal multiplexer was being required at launch for one
// sign-in flow. node-pty was already a direct dependency (the /term transport uses it) and works on
// Windows through ConPTY, which tmux cannot.
//
// tmux also gave multi-viewer attach for free, so that is rebuilt here deliberately and minimally:
// ONE pty per attempt, a bounded replay buffer, and a subscriber set. Two browser tabs on the sign-in
// modal must see the SAME OAuth flow — spawning a pty per viewer would start a second one and race
// them against a single credential store.
//
// Addressing: each attempt gets an opaque, server-issued, slug-SHAPED id ("login-<16 hex>", 64 random
// bits). Being slug-shaped lets the attempt ride the existing hardened /term/<slug> transport (same
// input/output/viewer bounds) — index.ts resolves an attempt id BEFORE consulting the session
// registry, and no registry row ever exists for one, so the board/tailer/adoption never see it.
//
// Ephemerality: login output (OAuth URLs, pasted codes) lives only in this process's memory — the
// replay buffer and the bounded WS byte stream — never in a transcript, SQLite, scratchpads, or
// server logs. Teardown kills the pty AND drops the buffer on cancel, success, timeout or shutdown.

const ATTEMPT_LIFETIME_MS = 10 * 60 * 1000 // a browser-OAuth round trip, generously bounded

// Enough to carry an OAuth URL plus the surrounding prompt to a tab that opens late, and small enough
// that a chatty CLI cannot grow the process. Trimmed from the FRONT so the newest output always
// survives — a viewer needs the current prompt, not the banner.
const REPLAY_CAP_BYTES = 256 * 1024

export interface LoginAttemptStatus {
  // "running" = the login CLI is still interactive; "exited" = it finished (either way — the caller
  // re-reads the credential state for the verdict).
  state: "running" | "exited"
  // The provider this attempt signs into; undefined once the attempt is gone/never existed.
  backend?: Backend
  // Set when the CLI never started: the name did not resolve to an executable, or the pty refused to
  // spawn it. The attempt is born "exited" and the same text is its whole replay, so the pane shows
  // WHY instead of a blank terminal (Windows audit 2026-09-11, finding 7).
  error?: string
}

/** A live viewer of one attempt's pty. Returned by `attach`; `close()` detaches only this viewer. */
export interface LoginAttachment {
  /** Everything the pty has emitted so far, so a tab that opens late still sees the OAuth URL. */
  replay(): string
  /** Live output. Returns an unsubscribe. */
  onData(listener: (chunk: string) => void): () => void
  /** Keystrokes from this viewer (the pasted OAuth code). */
  write(data: string): void
  resize(cols: number, rows: number): void
  /** The pty exited — the CLI finished, either way. A terminal command thread (command-threads.ts)
   *  rides this same shape and passes its exit code; the sign-in CLI's code means nothing and is omitted. */
  onExit(listener: (exitCode?: number) => void): () => void
  close(): void
}

export interface LoginUtility {
  // Starts (or returns the existing) login attempt for a provider. At most ONE live attempt per
  // provider per frizz server — a second Sign in click attaches to the same terminal rather than
  // racing two OAuth flows against one credential store.
  start(backend: Backend): { attemptId: string }
  /** Non-null iff this slug-shaped id addresses a live attempt (the /term transport's gate). */
  attach(slug: string): LoginAttachment | null
  status(attemptId: string): LoginAttemptStatus
  cancel(attemptId: string): void
  stop(): void
}

interface LiveAttempt {
  id: string
  backend: Backend
  /** Absent when the CLI never started — see LoginAttemptStatus.error. */
  term?: pty.IPty
  timer: NodeJS.Timeout
  /** Bounded, memory-only replay so a late viewer sees the OAuth URL. Dropped on teardown. */
  buffer: string
  bufferBytes: number
  exited: boolean
  error?: string
  dataListeners: Set<(chunk: string) => void>
  exitListeners: Set<() => void>
}

export function createLoginUtility(deps: {
  claudeBin?: string
  codexBin?: string
  // The cwd for the spawned CLI. Login is account-global, but the CLI still wants a valid cwd.
  cwd: string
  lifetimeMs?: number
  /** Injectable so tests never spawn a real provider CLI. */
  spawnPty?: typeof pty.spawn
  /** The environment the CLI runs in AND the PATH a bare name is resolved against. Defaults to this
   *  process's; injectable so a test can point the resolvers at a directory of its own. */
  env?: NodeJS.ProcessEnv
}): LoginUtility {
  const spawnPty = deps.spawnPty ?? pty.spawn
  const env = deps.env ?? process.env
  const lifetimeMs = deps.lifetimeMs ?? ATTEMPT_LIFETIME_MS
  const attempts = new Map<string, LiveAttempt>()

  // No boot-time orphan sweep, unlike the tmux implementation this replaced. A pty is a CHILD of this
  // process, so a crash takes it with us — there is no equivalent of a `remain-on-exit` pane surviving
  // in a detached tmux server with OAuth bytes in its scrollback. That whole class of leak is gone.

  // RESOLVED to an absolute executable before it reaches the pty, never handed over as a bare name.
  // node-pty on Windows passes the command line to CreateProcessW inside ConPTY, whose PATH search
  // finds `claude.exe`/`codex.exe` but never the `.cmd`/`.ps1`/sh shims an npm install writes — so with
  // the runtime pin fallen back to PATH (`source: "path"`: an offline first boot, FRIZZ_RUNTIMES=path,
  // a degraded sweep) the pane spawned nothing and showed a dead terminal. Every other reader of the
  // bare name moved to the resolvers in 517e9c8e; this one had not (Windows audit 2026-09-11,
  // finding 7). Both resolvers THROW on a miss, and start() turns that into the attempt's status.
  function loginArgv(backend: Backend): { file: string; args: string[] } {
    if (backend === "codex") {
      const codex = resolveCodexExecutable(deps.codexBin, { env })
      return { file: codex.file, args: [...codex.args, "login"] }
    }
    return { file: resolveClaudeExecutableAbsolute(deps.claudeBin, env), args: ["auth", "login"] }
  }

  /** An attempt whose CLI never started: born exited, its replay is the reason, and the next Sign in
   *  click replaces it exactly as it replaces any other finished attempt. */
  function failedAttempt(id: string, backend: Backend, cause: unknown): LiveAttempt {
    const reason = cause instanceof Error ? cause.message : String(cause)
    const error = `Could not start the ${backend === "codex" ? "Codex" : "Claude"} sign-in: ${reason}`
    return {
      id, backend, timer: setTimeout(() => teardown(id), lifetimeMs),
      buffer: `${error}\r\n`, bufferBytes: Buffer.byteLength(error) + 2, exited: true, error,
      dataListeners: new Set(), exitListeners: new Set(),
    }
  }

  function teardown(id: string): void {
    const attempt = attempts.get(id)
    if (!attempt) return
    clearTimeout(attempt.timer)
    attempts.delete(id)
    // Drop the OAuth bytes before anything else can read them, then kill.
    attempt.buffer = ""
    attempt.bufferBytes = 0
    attempt.dataListeners.clear()
    for (const listener of attempt.exitListeners) { try { listener() } catch { /* a viewer's teardown must not block ours */ } }
    attempt.exitListeners.clear()
    try {
      attempt.term?.kill()
    } catch {
      // Already gone — teardown is idempotent.
    }
  }

  return {
    start(backend) {
      for (const attempt of attempts.values()) {
        if (attempt.backend !== backend) continue
        // Reuse only a still-running attempt; a finished one is replaced so a second Sign in click
        // after a failed flow starts fresh rather than attaching to a dead pty.
        if (!attempt.exited) return { attemptId: attempt.id }
        teardown(attempt.id)
      }
      const id = `login-${randomBytes(8).toString("hex")}`
      let term: pty.IPty
      try {
        const { file, args } = loginArgv(backend)
        term = spawnPty(file, args, {
          name: process.platform === "win32" ? "xterm-color" : "xterm-256color",
          cwd: deps.cwd,
          env: env as Record<string, string>,
          cols: 120,
          rows: 30,
        })
      } catch (cause) {
        // No executable, or the pty refused it (ConPTY throws synchronously on a spawn failure). The
        // attempt still exists so the modal's status poll reads a definite "exited" with the reason,
        // and a viewer that attaches sees it in the pane rather than nothing at all.
        const failed = failedAttempt(id, backend, cause)
        failed.timer.unref?.()
        attempts.set(id, failed)
        return { attemptId: id }
      }
      const attempt: LiveAttempt = {
        id, backend, term,
        timer: setTimeout(() => teardown(id), lifetimeMs),
        buffer: "", bufferBytes: 0, exited: false,
        dataListeners: new Set(), exitListeners: new Set(),
      }
      attempt.timer.unref?.()
      term.onData((chunk) => {
        attempt.buffer += chunk
        attempt.bufferBytes += Buffer.byteLength(chunk)
        // Trim from the FRONT — the newest output is what a late viewer needs.
        while (attempt.bufferBytes > REPLAY_CAP_BYTES && attempt.buffer.length > 0) {
          const drop = attempt.buffer.slice(0, Math.ceil(attempt.buffer.length / 4))
          attempt.buffer = attempt.buffer.slice(drop.length)
          attempt.bufferBytes -= Buffer.byteLength(drop)
        }
        for (const listener of attempt.dataListeners) { try { listener(chunk) } catch { /* one bad viewer must not stall the others */ } }
      })
      term.onExit(() => {
        attempt.exited = true
        for (const listener of attempt.exitListeners) { try { listener() } catch { /* ignore */ } }
      })
      attempts.set(id, attempt)
      return { attemptId: id }
    },
    attach(slug) {
      const attempt = attempts.get(slug)
      if (!attempt) return null
      return {
        replay: () => attempt.buffer,
        onData: (listener) => {
          attempt.dataListeners.add(listener)
          return () => attempt.dataListeners.delete(listener)
        },
        write: (data) => { if (!attempt.exited) { try { attempt.term?.write(data) } catch { /* the pty died mid-write */ } } },
        resize: (cols, rows) => { if (!attempt.exited) { try { attempt.term?.resize(cols, rows) } catch { /* ignore */ } } },
        onExit: (listener) => {
          if (attempt.exited) { listener(); return () => {} }
          attempt.exitListeners.add(listener)
          return () => attempt.exitListeners.delete(listener)
        },
        close: () => { /* detaching a viewer never touches the pty — another tab may still be watching */ },
      }
    },
    status(attemptId) {
      const attempt = attempts.get(attemptId)
      if (!attempt) return { state: "exited" }
      return { state: attempt.exited ? "exited" : "running", backend: attempt.backend, ...(attempt.error ? { error: attempt.error } : {}) }
    },
    cancel(attemptId) {
      teardown(attemptId)
    },
    stop() {
      for (const id of [...attempts.keys()]) teardown(id)
    },
  }
}
