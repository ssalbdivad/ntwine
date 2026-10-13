// WHO SENT A `dispatch` — the board, or a worker's `spawn_thread` (2026-10-06).
//
// The router checks a WORKER's spawn for another project's checkout (spawn-project.ts) and leaves what the
// human types alone. It told the two apart by `spawnedFrom`, which the shim started sending at bd36deae —
// but a worker's MCP shim is spawned once per session and lives as long as it, so every session started
// before that commit kept dispatching without it, unchecked. @pullfrog-status (session started 16:21, the
// guard landed 16:44) spawned @superset-impl into Home that evening with the Ntwine checkout in its brief:
// the exact case the guard exists for, missed because the caller was too old to say it was a worker.
//
// The transport says it regardless of the shim's age. Only two clients POST `dispatch`: the board, from a
// browser, and the shim (cc-worker/bin/ntwine-mcp.mjs), whose node fetch sends no `Origin` and
// `user-agent: node`. A browser attaches `Origin` to every POST (Fetch spec, even same-origin) and every
// browser's user agent opens `Mozilla/` — app.test.ts keeps a no-Origin same-origin PWA path open, so a
// request counts as a worker's only when BOTH say so: a browser misread as a worker would have the human's
// own words refused. The RPC layer hands a procedure only its input, so app.ts records the caller here for
// the length of the request.

import { AsyncLocalStorage } from "node:async_hooks"

export type DispatchCaller = "browser" | "worker"

const callers = new AsyncLocalStorage<DispatchCaller>()

/** Run `next` with the caller of this request recorded: no `Origin` and no browser user agent is a worker's shim. */
export function withDispatchCaller<T>(headers: { origin: string | undefined; userAgent: string | undefined }, next: () => T): T {
  const browser = headers.origin !== undefined || /\bMozilla\//u.test(headers.userAgent ?? "")
  return callers.run(browser ? "browser" : "worker", next)
}

/** The caller of the `dispatch` request being handled; undefined outside one (a test calling the handler). */
export const dispatchCaller = (): DispatchCaller | undefined => callers.getStore()
