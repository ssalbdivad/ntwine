import { noteServerBootId } from "./boot.ts"
import { store } from "../store.ts"
import { PROCEDURES, type Api, type ProcType, type RpcCallOpts } from "./contract.ts"
import { NTWINE_ROUTE_PREFIX } from "@ntwine/shared"
import { apiBase, isUnboundHome } from "../lib/base-path.ts"
import { noteRpcMutation } from "../lib/humanActs.ts"

export type { Api, ProcType, RpcCallOpts } from "./contract.ts"
export { PROCEDURES } from "./contract.ts"

export const CONTROL_PLANE_RESTARTING_MESSAGE = "Ntwine is updating and restarting. Your draft is preserved; wait until it is ready before sending or changing settings."

// A failure the caller may safely REPLAY, because the request provably took no effect: either the
// server refused it at a contention gate upstream of any side effect (`retryable` in the error
// envelope — see RetryableDeliveryError), or it was refused here before it ever reached the wire.
// The absence of this marker means AMBIGUOUS — the request may well have landed — so an unmarked
// failure must be surfaced, never re-sent.
export function isRetryableRpcError(error: unknown): boolean {
  return (error as { retryableRpc?: unknown } | null)?.retryableRpc === true
}

// The server wrote this follow-up into its delivery ledger before the failure and still holds it — as a
// failed bubble with Retry / Edit / Dismiss (`kept` in the envelope; server/src/router.ts
// keepFailedFollowUp). The words are no longer only the browser's to lose.
export function isKeptDeliveryError(error: unknown): boolean {
  return (error as { deliveryKept?: unknown } | null)?.deliveryKept === true
}

function markRetryable(error: Error): Error {
  Object.defineProperty(error, "retryableRpc", { value: true, enumerable: false })
  return error
}

export function assertMutationAllowedDuringControlPlaneTransition(type: ProcType): void {
  if (type === "mutation" && store.controlPlaneState === "restarting") {
    // Nothing was sent, so this is the safest replay there is: a send caught by a build promotion
    // should wait the promotion out, not be handed back to the operator as a failure.
    throw markRetryable(new Error(CONTROL_PLANE_RESTARTING_MESSAGE))
  }
}

// Parse one RPC envelope without leaking a browser JSON SyntaxError into the UI. During local HMR the
// web bundle can update before the long-running server process; a brand-new route then returns Hono's
// plain-text 404 ("404 Not Found"), which `res.json()` misleadingly reported as "Unexpected
// non-whitespace character after JSON". Name that operational fix directly.
export async function parseRpcResponse(res: Response, name: string): Promise<unknown> {
  const body = await res.text()
  let json: { result?: unknown; error?: unknown; retryable?: unknown; kept?: unknown }
  try {
    json = JSON.parse(body) as { result?: unknown; error?: unknown; retryable?: unknown; kept?: unknown }
  } catch {
    if (res.status === 404 || res.status === 405) {
      throw new Error("Ntwine server restart required — this control is newer than the running server")
    }
    // SAY THE STATUS. A non-JSON body is always something OTHER than the RPC answering, and which
    // something is the entire diagnosis — 403 is the local-origin gate refusing (a stale tab, a
    // host/origin mismatch), 5xx is the server failing, 200-with-HTML is a dev restart window serving
    // the SPA shell. Reporting all of them as "invalid response" sent one debugging session down the
    // wrong path entirely (2026-08-15: a 403 read as a schema problem and cost half an hour).
    if (res.status === 403) {
      throw new Error(`RPC ${name} was refused (403) — the page's origin does not match the server it is talking to. Reload from the URL ntwine is actually serving.`)
    }
    throw new Error(`RPC ${name} returned a non-JSON response (HTTP ${res.status})`)
  }
  if (!res.ok) {
    const error = new Error(typeof json.error === "string" ? json.error : `RPC ${name} failed`)
    if (json.kept === true) Object.defineProperty(error, "deliveryKept", { value: true, enumerable: false })
    throw json.retryable === true ? markRetryable(error) : error
  }
  return json.result
}

// WHICH PROJECT A PLAIN `rpc` CALL IS FOR, and the one place that decides it.
//
// The page says (`apiBase()`): its board's project, the drawer's, or the pick All projects is bound to. A
// page that names none and has none bound — `/all` or `/` before its pick, or with nothing to pick — makes
// `apiBase()` answer the unprefixed `/_ntwine`, the project that LAUNCHED the server, so a call there that
// needed a project would read or write a stranger's state and look like it worked. Here that call throws
// instead. (Upstream's routeCall, 759c3255, written for its Console; a call that NAMES its project goes
// through `projectRpc` and never reaches this.)

/**
 * Procedures that read ONE project's state but name no thread in their input, so nothing in the call
 * says which project they are for (packages/server/src/router.ts reads `ctx.project`, its storage, its
 * settings or its roots for each).
 *
 * `settingsGet`/`settingsSet`/`settingsReset` are deliberately NOT here: the keys a page that names no
 * project reads (`notifications`, the file opener) are machine-level (server/settings.ts),
 * and any project answers them the same way.
 */
export const PROJECT_SCOPED_PROCEDURES: ReadonlySet<string> = new Set([
  "board",
  "dispatch",
  "repairThread",
  "openLocalFile",
  "localMarkdown",
  "localFile",
  "resolveLocalPaths",
  "githubStatus",
  "claudeModels",
  "acpAgents",
  "acpAgentModels",
])

/** Machine-wide procedures whose input carries a REAL slug that is not this page's thread. */
const MACHINE_SLUG_PROCEDURES: ReadonlySet<string> = new Set(["threadLocate"])

/** Where a plain `rpc` call named `name` goes. Pure apart from reading the page's path; unit-tested. */
export function routeCall(name: string, input: unknown, pathname?: string): string {
  if (isUnboundHome(pathname)) {
    const slug = input && typeof input === "object" ? (input as { slug?: unknown }).slug : undefined
    if (typeof slug === "string" && !MACHINE_SLUG_PROCEDURES.has(name)) {
      throw new Error(`RPC ${name}: "${slug}" names no project, and this page has none bound`)
    }
    if (PROJECT_SCOPED_PROCEDURES.has(name)) throw new Error(`RPC ${name} needs a project, and this page has none bound`)
  }
  return apiBase(pathname)
}

async function call(base: string, name: string, type: ProcType, input?: unknown, opts?: RpcCallOpts): Promise<unknown> {
  // The old child may remain healthy while its durable owner is building a replacement. Do not let
  // a mutation race that handoff; local draft state remains editable and every query stays available.
  assertMutationAllowedDuringControlPlaneTransition(type)
  if (type === "query") {
    const url = new URL(`${base}/rpc/${name}`, location.origin)
    if (input !== undefined) url.searchParams.set("input", JSON.stringify(input))
    const res = await fetch(url.toString(), { signal: opts?.signal })
    noteServerBootId(res.headers.get("x-ntwine-boot")) // notice a server restart on any RPC roundtrip
    return parseRpcResponse(res, name)
  }
  // Before the send, so a board push that lands while the request is in flight already knows the human
  // moved this thread (lib/humanActs.ts).
  noteRpcMutation(name, input)
  const res = await fetch(`${base}/rpc/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input ?? {}),
    signal: opts?.signal,
  })
  noteServerBootId(res.headers.get("x-ntwine-boot"))
  const result = await parseRpcResponse(res, name)
  // And the thread it ANSWERS with: a dispatch names its new thread only in its result, and that thread is
  // the human's as much as one they replied to — the project list draws it at once rather than holding it
  // back as an arrival (lib/heldLayout.ts).
  noteRpcMutation(name, result)
  return result
}

/** A typed client whose every call goes to `base(name, input)`, read at CALL time. */
function createRpc(base: (name: string, input: unknown) => string): Api {
  return new Proxy({} as Api, {
    get(_target, name: string) {
      const type = (PROCEDURES as Record<string, ProcType | undefined>)[name]
      if (!type) return undefined
      // Async, so a call `base` refuses is a rejected promise like any other failure, not a throw.
      return async (input?: unknown, opts?: RpcCallOpts) => call(base(name, input), name, type, input, opts)
    },
  })
}

/** THIS PAGE's project — whichever one the address bar names, or the launching project unprefixed. */
export const rpc = createRpc((name, input) => routeCall(name, input))

const projectClients = new Map<string, Api>()

/**
 * A client pinned to ONE project, whatever page it is called from.
 *
 * `rpc` above answers "which project" from the address at call time — the PAGE project (base-path.ts
 * projectSlug: the page's project at `/`, the drawer's project under `/all/<slug>`, the launching one on
 * an unprefixed `/thread/<t>/full`). That is right for a drawer or /full, which show one thread of that
 * project, and silently wrong on the queue in All projects, which shows every project's cards at once:
 * a thread action taken there for another project's `fix-auth` lands on the page project's
 * `fix-auth` instead (slugs are unique only within a project). That page makes every per-thread call
 * through one of these. (Until 2026-09-28 the default was also right on a project's own board, which
 * showed one project.)
 *
 * ADDRESSED BY ID, NOT SLUG. The server resolves either, but a slug changes when a project is renamed,
 * and a stale one falls through to the launching project's app — which answers every procedure with a
 * plain 404 that reads as "restart required". The id is what the worker MCP server uses for the same
 * reason.
 */
export function projectRpc(projectId: string): Api {
  let client = projectClients.get(projectId)
  if (!client) {
    const base = projectApiBase(projectId)
    client = createRpc(() => base)
    projectClients.set(projectId, client)
  }
  return client
}

const baseClients = new Map<string, Api>()

/** A client pinned to an API base captured earlier — how a follow-up replayed after a reload reaches
 *  the project it was first sent to (lib/pendingSends.ts), whichever page the reload landed on. */
export function rpcAtBase(base: string): Api {
  let client = baseClients.get(base)
  if (!client) {
    client = createRpc(() => base)
    baseClients.set(base, client)
  }
  return client
}

/** `apiBase()` for a project named explicitly — its `/_ntwine/<id>` routes (`/rpc`, `/attach`, …). */
export function projectApiBase(projectId: string): string {
  return `${NTWINE_ROUTE_PREFIX}/${encodeURIComponent(projectId)}`
}
