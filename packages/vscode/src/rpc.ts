// NTWINE'S RPC SURFACE, from the extension host — the same procedures the page calls, over plain fetch.
//
// The wire is packages/rpc/src/server.ts: a query is `GET <prefix>/<proc>?input=<url-encoded JSON>`, a
// mutation is `POST` with a JSON body, and the answer is `{ result }` or `{ error, retryable? }`.
// `retryable: true` means the server refused at a contention gate before anything took effect, so the
// identical request may be sent again; any other failure is ambiguous and must not be.
//
// Always PROJECT-ID-addressed: `/_ntwine/<projectId>/rpc/<proc>`. An unprefixed path is whichever project
// launched the server, and a slug can be renamed out from under a long-lived client.
//
// The origin gate (server app.ts) admits a request with no Origin only when it carries
// `sec-fetch-site: same-origin`, which a browser never lets a cross-site page send — exactly what the
// worker MCP shim sends (cc-worker/bin/ntwine-mcp.mjs), and what this sends.

import type { DispatchInput, DispatchPreferences } from "@ntwine/shared"
import type { Api } from "../../web/src/api/contract.ts"

export type Procedure = keyof Api
export type ProcedureInput<P extends Procedure> = Parameters<Api[P]>[0]
export type ProcedureOutput<P extends Procedure> = Awaited<ReturnType<Api[P]>>

export type RpcErrorKind = "unreachable" | "unanswered" | "refused" | "failed"

export class RpcError extends Error {
  constructor(
    message: string,
    /**
     * `unreachable`: the request never got there (nothing listening). `unanswered`: it went out and no
     * answer came back — it timed out, or the connection dropped mid-request — so it may have taken
     * effect. `refused`: the server said no (4xx). `failed`: it tried and failed (5xx).
     */
    readonly kind: RpcErrorKind,
    readonly retryable = false,
    readonly status?: number,
  ) {
    super(message)
    this.name = "RpcError"
  }
}

export class NtwineRpc {
  constructor(readonly origin: string) {}

  path(projectId: string, procedure: Procedure): string {
    return `/_ntwine/${encodeURIComponent(projectId)}/rpc/${procedure}`
  }

  query<P extends Procedure>(projectId: string, procedure: P, input?: ProcedureInput<P>, timeoutMs = 15_000): Promise<ProcedureOutput<P>> {
    const search = input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`
    return this.#call(`${this.path(projectId, procedure)}${search}`, { method: "GET" }, timeoutMs)
  }

  mutation<P extends Procedure>(projectId: string, procedure: P, input?: ProcedureInput<P>, timeoutMs = 30_000): Promise<ProcedureOutput<P>> {
    return this.#call(
      this.path(projectId, procedure),
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input ?? {}) },
      timeoutMs,
    )
  }

  async #call<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
    let response: Response
    try {
      response = await fetch(`${this.origin}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), "sec-fetch-site": "same-origin" },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause?.code
      if ((error as Error).name === "TimeoutError") throw new RpcError(`ntwine did not answer within ${Math.round(timeoutMs / 1000)}s`, "unanswered")
      // A connection ntwine took and then dropped (a restart mid-request) is as ambiguous as a timeout.
      if (cause === "ECONNRESET" || cause === "UND_ERR_SOCKET" || cause === "EPIPE") throw new RpcError(`ntwine dropped the request (${cause})`, "unanswered")
      throw new RpcError(`ntwine isn't reachable (${cause ?? (error as Error).message})`, "unreachable")
    }
    const text = await response.text()
    let body: { result?: unknown; error?: unknown; retryable?: unknown } | undefined
    try {
      body = text ? JSON.parse(text) : undefined
    } catch {
      body = undefined
    }
    if (response.ok && body && "result" in body) return body.result as T
    const message = typeof body?.error === "string" ? body.error : text.trim().slice(0, 300) || `HTTP ${response.status}`
    throw new RpcError(message, response.status >= 500 ? "failed" : "refused", body?.retryable === true, response.status)
  }
}

/** The backoff the page's follow-up path uses between attempts at a `retryable` refusal (eagerComposerSubmission.ts). */
export const RETRY_DELAYS_MS: readonly number[] = [300, 800, 1800, 3500]

/**
 * Run `attempt` until it succeeds, retrying only a `retryable` refusal, on the page's schedule. The
 * caller keeps every resend idempotent (a follow-up's `deliveryId` is the same on each try).
 */
export async function withRetry<T>(attempt: () => Promise<T>, delays: readonly number[] = RETRY_DELAYS_MS, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await attempt()
    } catch (error) {
      if (!(error instanceof RpcError) || !error.retryable || i >= delays.length) throw error
      await sleep(delays[i]!)
    }
  }
}

/** What the human was doing, for the words an unanswered request needs: whether to check before trying again. */
export type RpcAction = "ask" | "send" | "read"

const UNANSWERED: Record<RpcAction, string> = {
  // No retry and no idempotency key: a dispatch that went unanswered may still have started its thread.
  ask: "ntwine didn't answer in time. Check ntwine before asking again: it may have started the thread.",
  send: "ntwine didn't answer in time. Check the thread before sending again: the message may have arrived.",
  read: "ntwine didn't answer in time. Try again.",
}

/**
 * Words for a failure, for a notification. A signed-out provider is the one the human can fix in a
 * click, so it says where; an unreachable server says ntwine is not running, which is almost always why.
 * An unanswered one is NOT that — ntwine is up and slow, and what to do depends on what was asked of it.
 */
export function describeRpcError(error: unknown, action: RpcAction = "read"): string {
  if (error instanceof RpcError && error.kind === "unreachable") return "ntwine isn't running."
  if (error instanceof RpcError && error.kind === "unanswered") return UNANSWERED[action]
  const message = error instanceof Error ? error.message : String(error)
  const auth = /^AUTH_REQUIRED:(claude|codex)$/u.exec(message)
  if (auth) return `Sign in to ${auth[1] === "claude" ? "Claude" : "Codex"} in ntwine first.`
  return message
}

/**
 * The backend, model and effort a new thread starts with: the operator's saved profile, filled the way
 * the page's prompt box fills it (packages/web/src/lib/dispatchPreferences.ts `resolveDispatchPreferences`)
 * — Claude with nothing saved is `opus` at `high`, an ACP agent has no effort axis, and a Codex profile
 * with no saved model is left to the server, which knows the installed model list.
 */
export function dispatchProfile(preferences: DispatchPreferences): Pick<DispatchInput, "backend" | "model" | "effort"> {
  const backend = preferences.backend
  const saved = preferences[backend] ?? {}
  const model = saved.model ?? (backend === "claude" ? "opus" : undefined)
  const effort = backend === "acp" ? undefined : saved.effort ?? (backend === "claude" ? "high" : undefined)
  return { backend, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
}
