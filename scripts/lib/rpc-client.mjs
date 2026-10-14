// The ONE node-side client for ntwine's RPC surface. Every harness and verify script must use this
// instead of hand-rolling `fetch`.
//
// Two pieces of knowledge live here and nowhere else, because getting either wrong produces a
// PLAUSIBLE-LOOKING WRONG ANSWER rather than an error — which is exactly how a harness ends up
// "proving" something it never tested:
//
//   1. TRANSPORT SPLIT. A `query` is GET with the input JSON-encoded into `?input=`; a `mutation` is
//      POST with a JSON body. POSTing a query does not throw — it 404s, and a harness that only
//      checks `status === 200` on the happy path reads the miss as "no data".
//   2. ENVELOPE. Every response is `{ result }` or `{ error }` — never the payload bare. Reading
//      `body.slug` off the envelope yields `undefined` for a call that actually SUCCEEDED.
//
// Both were gotten wrong at once while verifying the codex daemon fix (2026-07-23): the harness
// reported FAIL on a dispatch that had in fact worked. The app's browser client has always known
// this (packages/web/src/api) — the node side just had no shared copy to import.
//
// Loopback `Origin` is required or the server 403s a cross-origin write.
//
//   3. THE `/_ntwine` PREFIX (c34a7e2). Everything ntwine serves lives under it, and every other
//      top-level path is a project slug that falls through to the SPA shell — with a 200 and an HTML
//      body. So an unprefixed `/rpc/board` does not 404 either: it reads back as "rpc board failed
//      (200): <!doctype html>", and an unprefixed `/health` probe resolves TRUE against the shell
//      before the server is anywhere near ready. Build every URL through NTWINE_ROUTE_PREFIX.

const NTWINE_ROUTE_PREFIX = "/_ntwine"

export class RpcError extends Error {
  constructor(method, status, message) {
    super(`rpc ${method} failed (${status}): ${message}`)
    this.name = "RpcError"
    this.method = method
    this.status = status
  }
}

/** A client bound to one running ntwine server, optionally its project id/slug. Results are UNWRAPPED. */
export function createRpcClient(baseUrl, project) {
  const origin = new URL(baseUrl).origin
  const prefix = project ? `${NTWINE_ROUTE_PREFIX}/${encodeURIComponent(project)}` : NTWINE_ROUTE_PREFIX

  const send = async (method, init, url) => {
    const res = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), origin } })
    const text = await res.text()
    let envelope
    try {
      envelope = JSON.parse(text)
    } catch {
      throw new RpcError(method, res.status, text.slice(0, 200) || "non-JSON response")
    }
    if (!res.ok || envelope?.error !== undefined) {
      throw new RpcError(method, res.status, typeof envelope?.error === "string" ? envelope.error : text.slice(0, 200))
    }
    return envelope?.result
  }

  const query = (method, input) => {
    const url = new URL(`${prefix}/rpc/${method}`, baseUrl)
    if (input !== undefined) url.searchParams.set("input", JSON.stringify(input))
    return send(method, {}, url)
  }

  return {
    origin,
    /** GET /_ntwine/rpc/<method>?input=… — for router `query` procedures. */
    query,
    /**
     * The address of a thread's DRAWER on the one page — `/all/<project slug>/thread/<slug>` — for the
     * project this client addresses. Until 2026-09-28 a script opened the launching project's drawer at
     * the bare `/thread/<slug>`, which now lands on `/`; the project's slug is read off its own board
     * (`projectSlug`), because a script that knows only a port has no other way to name it.
     */
    async threadUrl(slug) {
      const board = await query("board")
      if (!board?.projectSlug) throw new RpcError("board", 200, "the board names no projectSlug, so no drawer address can be built")
      return `${origin}/all/${encodeURIComponent(board.projectSlug)}/thread/${encodeURIComponent(slug)}`
    },
    /** POST /_ntwine/rpc/<method> — for router `mutation` procedures. */
    mutate(method, input) {
      return send(
        method,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input ?? {}) },
        new URL(`${prefix}/rpc/${method}`, baseUrl),
      )
    },
    /** Resolves once /_ntwine/health answers with the health JSON, or gives up after `timeoutMs`. */
    async waitForHealth(timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        // `.ok` alone is not readiness: the SPA shell answers 200 to anything it does not recognize,
        // so the probe must see the health BODY before it believes the server is up.
        try {
          const res = await fetch(new URL(`${prefix}/health`, baseUrl))
          if (res.ok && (await res.json())?.ok !== undefined) return true
        } catch {}
        if (Date.now() > deadline) return false
        await new Promise((r) => setTimeout(r, 150))
      }
    },
  }
}
