export type { AppRouter } from "./router.ts"

import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { readFileSync, existsSync, statSync } from "node:fs"
import { basename, dirname, join, resolve, extname, posix, sep } from "node:path"
import { adoptLegacyRoute, DEFAULT_PORT, NTWINE_ROUTE_PREFIX } from "@ntwine/shared"
import {
ContextStartupError,
  createContext,
  projectContextCleanups,
  initGithub,
  type AppContext,
  type ContextOptions,
  type ContextStartupFence,
  type ContextStartupPhase,
} from "./context.ts"
import { createApp, type AppOptions } from "./app.ts"
import { compress, negotiateEncoding, shouldCompress, type ContentEncoding } from "./compression.ts"
import { createTerminalServer } from "./terminal.ts"
import { createAppSocketServer, makeTranscriptReader } from "./app-socket.ts"
import { createEditorBridge, listEditorProjects } from "./editor-bridge.ts"
import { captureLaunchEnvironment } from "./backend/worker-env.ts"
import {
  createRetryableCleanup,
  createShutdownBarrier,
  DEFAULT_SHUTDOWN_PHASE_TIMEOUT_MS,
  type ShutdownBarrier,
  type ShutdownBarrierOptions,
  type ShutdownDiagnostic,
} from "./shutdown.ts"
import { openableFileRoots, projectLaunchTarget, resolveProject, type Project, workDirOf } from "./project.ts"
import { resolveWatchableLocalFile } from "./local-file.ts"
import { watchLocalFile } from "./local-file-watch.ts"
import {
  acquireProjectLaunchOwner,
  currentProcessGeneration,
  projectLaunchTokenProof,
  registerProjectLaunchDelegate,
  removeProjectStatus,
  writeProjectStatus,
  type ProjectLaunchDelegateLease,
  type ProjectLaunchLease,
  type ProcessGeneration,
} from "./project-launch.ts"
import { serverAddressPathForStateDir } from "./ntwine-paths.ts"
import { pidIsAlive } from "./project-identity.ts"
import { createBootProgressPublisher } from "./boot-progress.ts"
import { log as ntwineLog } from "./logging.ts"
import { describeRuntime, resolveRuntimes, type ResolvedRuntimes, type ResolveRuntimesOptions } from "./runtimes.ts"
import { createTenantMap } from "./tenants.ts"
import { openNtwineDatabase, type NtwineDatabase, type OpenNtwineDatabaseOptions } from "./ntwine-db.ts"
import { startTenantPrime, type TenantPrimeRun } from "./tenant-prime.ts"
import { startWakeLockLoop, type WakeLockLoop } from "./wake-lock.ts"
import { startIdleWorktreeSweep, type WorktreeSweepLoop } from "./worktree-sweep.ts"
import { threadFoldersInUse } from "./router.ts"
import { findWorkspaceById, findWorkspaceBySegment, isHomeWorkspace, listWorkspaces, projectForEntry } from "./home-workspace.ts"
import { registryPath } from "./project-registry.ts"
import { announceProjectListChanges } from "./projects-changed.ts"
import { backfillRegistry } from "./project-registry.ts"
import { claimProjectServing, projectServedElsewhere } from "./project-serving.ts"
import { deleteProjectState, stopProjectWorkers } from "./project-teardown.ts"

export const SERVER_SHUTDOWN_TIMEOUT_MS = 4_000
export const SERVER_FORCE_EXIT_MS = 5_000

export type ServerStartupPhase =
  | "launch ownership"
  | "runtimes"
  | "database"
  | "context"
  | "GitHub initialization"
  | "application"
  | "terminal transport"
  | "application socket"
  | "board producer"
  | "tailer producer"
  | "permission producer"
  | "delivery confirmer"
  | "profile producer"
  | "wake scheduler"
  | "Vite"
  | "HTTP server"
  | "HTTP listen"
  | "status publication"
  | "signal handlers"

type HttpServer = ReturnType<typeof createServer>

/** Where Vite's HMR client connects, on the board's own port. Reserved under `/_ntwine/` like every route. */
const VITE_HMR_PATH = "/_ntwine/vite-hmr"

/** Vite's own sockets, by path and the subprotocol its client always sends. */
function isViteHmrUpgrade(req: IncomingMessage): boolean {
  const protocol = req.headers["sec-websocket-protocol"]
  return (protocol === "vite-hmr" || protocol === "vite-ping")
    && new URL(req.url ?? "/", "http://ntwine.invalid").pathname === VITE_HMR_PATH
}
type TerminalServer = ReturnType<typeof createTerminalServer>
type AppSocketServer = ReturnType<typeof createAppSocketServer>

/** Everything one project serves: its HTTP app and its two live transports. */
interface TenantSurfaces {
  app: ReturnType<typeof createApp>
  terminal: TerminalServer
  appSocket: AppSocketServer
}
type ViteServer = import("vite").ViteDevServer

/** Dependency seam for deterministic startup-rollback tests. Production callers must not set it. */
export interface StartServerRuntime {
  /** The unified database (ntwine-db.ts); a rollback test substitutes an in-memory one. */
  openDatabase(options: OpenNtwineDatabaseOptions): NtwineDatabase
  /** The pinned Claude Code and Codex (runtimes.ts); a fixture substitutes stand-ins without a download. */
  resolveRuntimes(options: ResolveRuntimesOptions): Promise<ResolvedRuntimes>
  createContext(options: ContextOptions): AppContext | Promise<AppContext>| Promise<AppContext>
  initGithub(ctx: AppContext): Promise<void>
  createApp(ctx: AppContext, options: AppOptions): ReturnType<typeof createApp>
  createTerminal(options: Parameters<typeof createTerminalServer>[0]): TerminalServer
  createAppSocket(options: Parameters<typeof createAppSocketServer>[0]): AppSocketServer
  createVite(options: {
    root: string
    server: { middlewareMode: true; ws: { server: HttpServer; path: string } }
    appType: "custom"
  }): Promise<ViteServer>
  createHttpServer(listener: (req: IncomingMessage, res: ServerResponse) => void): HttpServer
  currentProcessGeneration(): ProcessGeneration
  writeStatus(path: string, value: Record<string, unknown>): void
  removeStatus(
    path: string,
    expected: { pid: number; processStart: string; publisherToken: string; ownerToken: string },
  ): boolean
  afterPhase?(phase: ServerStartupPhase): void | Promise<void>
  /**
   * Sub-phase reporter for the "context" phase. `createContext` is a single server phase but does
   * most of the boot work inside it, so a boot-timing harness that only sees server phases reads a
   * multi-second opaque block. Purely observational — never affects construction or rollback.
   */
  afterContextPhase?(phase: ContextStartupPhase): void
  shutdownDeadline?: ShutdownBarrierOptions["deadline"]
}

const defaultStartServerRuntime: StartServerRuntime = {
  openDatabase: openNtwineDatabase,
  resolveRuntimes,
  createContext,
  initGithub,
  createApp,
  createTerminal: createTerminalServer,
  createAppSocket: createAppSocketServer,
  createVite: async (options) => {
    // Vite writes NODE_ENV (and a few more) into process.env. Pin the launch snapshot workers inherit
    // from BEFORE it runs, rather than trusting the import graph to have loaded worker-env.ts first.
    captureLaunchEnvironment()
    const { createServer: createVite } = await import("vite")
    return createVite(options)
  },
  createHttpServer: (listener) => createServer(listener),
  currentProcessGeneration,
  writeStatus: writeProjectStatus,
  removeStatus: removeProjectStatus,
}

export interface ServerShutdownFence {
  /** True until every live resource is drained, exact status is retired, and ownership is released. */
  readonly ownershipRetained: boolean
  /** Current authoritative cleanup attempt. It rejects while the ownership fence must remain. */
  whenSafe(): Promise<void>
  /** Retry idempotent cleanup after a diagnosed failure, then release the retained fence on success. */
  recover(): Promise<void>
}

export class ServerStartupError extends Error {
  readonly phase: ServerStartupPhase
  readonly startupError: unknown
  readonly cleanupError: unknown
  readonly diagnostics: readonly ShutdownDiagnostic[]
  readonly fence: ServerShutdownFence

  constructor(options: {
    phase: ServerStartupPhase
    startupError: unknown
    cleanupError?: unknown
    diagnostics: readonly ShutdownDiagnostic[]
    fence: ServerShutdownFence
  }) {
    const startupMessage = options.startupError instanceof Error ? options.startupError.message : String(options.startupError)
    const cleanupMessage = options.cleanupError instanceof Error ? `; rollback failed: ${options.cleanupError.message}` : ""
    super(`Ntwine server startup failed during ${options.phase}: ${startupMessage}${cleanupMessage}`, {
      cause: options.startupError,
    })
    this.name = "ServerStartupError"
    this.phase = options.phase
    this.startupError = options.startupError
    this.cleanupError = options.cleanupError
    this.diagnostics = [...options.diagnostics]
    this.fence = options.fence
  }
}

export interface StartOptions {
  dev?: boolean
  port?: number
  claudeBin?: string // injectable dispatch executable (used by tests / a stand-in); skips provisioning
  codexBin?: string // same seam for the Codex app-server executable
  // The dev supervisor owns signals itself and asks the child to close explicitly. Standalone/prod
  // callers keep the historical signal behavior by leaving this enabled.
  installSignalHandlers?: boolean
  // A supervised generation is a launch validator, not an API-only fallback: broken Vite config or
  // startup must fail before the child announces ready so the old parent watcher can await a fix.
  requireDevWeb?: boolean
  /** Verified immutable web artifact for stable mode; avoids reading web/dist from the checkout. */
  webDistDir?: string
  shutdownTimeoutMs?: number
  shutdownDiagnostic?: (event: ShutdownDiagnostic) => void
  /** Internal: a supervisor-verified pinned project and its delegated owner token. */
  project?: Project
  launchOwnerToken?: string
  /** Internal: the machine-wide owner's token under the stable launcher; see AppOptions.machineToken. */
  machineOwnerToken?: string
  /** Internal token-bound path used by a supervised child to ask its durable owner to stop. */
  requestOwnerStop?: () => void
  /** Internal deterministic fixture seam; never configured by production launchers. */
  runtime?: Partial<StartServerRuntime>
}

export interface StartedServer {
  httpServer: HttpServer
  ctx: AppContext
  port: number
  close(): Promise<void>
  readonly shutdownFence: ServerShutdownFence
}

// Everything Ntwine serves is under the reserved prefix now, so this is one test instead of a list
// that had to grow with every new route — and a prefixed request that missed the old allowlist fell
// through to the SPA shell with a 200, i.e. a blank page rather than an error.
const isApiUrl = (url: string) => url === NTWINE_ROUTE_PREFIX || url.startsWith(`${NTWINE_ROUTE_PREFIX}/`)

/**
 * The liveness record this process publishes: pid, owner tokens and the PORT.
 *
 * Written for the LAUNCHING project only — it is a record of a launch, not of a board, and the tokens
 * in it belong to the launch lease. So it is also the one file a worker in any OTHER open project can
 * read the port out of, which is why the path is handed to every tenant's context rather than being
 * rebuilt from whichever project happens to be asking.
 */
const serverLockPathFor = (project: Project): string => join(project.stateDir, "server.lock")

/** Who currently holds the machine address, if the file is there and readable. */
function readServerAddressHolder(path: string): { pid: number; port: number } | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; port?: unknown }
    if (typeof value?.pid !== "number") return undefined
    return { pid: value.pid, port: typeof value.port === "number" ? value.port : -1 }
  } catch {
    return undefined
  }
}

/**
 * Split `/_ntwine/<project>/rest` into its project segment and the request the tenant's own app should
 * see.
 *
 * A project segment and a route name share this position, so `/_ntwine/rpc/board` and
 * `/_ntwine/nub/rpc/board` look alike until you know which projects exist. The registry settles it, and
 * cannot be ambiguous: it refuses to mint a slug that shadows one of Ntwine's own route names.
 *
 * The segment is a slug OR a project id. The browser uses the slug, because it is what the operator
 * reads in the URL bar; a worker's ntwine MCP server uses the ID, because it is handed the segment once
 * at spawn and then holds it for hours in a detached daemon — a rename would silently strand it.
 *
 * An unprefixed `/_ntwine/rpc/…` stays the LAUNCHING project, so a client that has not learned about
 * project segments yet keeps working.
 */
export function splitTenantRequest(
  url: string,
  isKnownSlug: (slug: string) => boolean,
): { slug: string; rest: string } | undefined {
  if (!isApiUrl(url)) return undefined
  const after = url.slice(NTWINE_ROUTE_PREFIX.length)
  const match = /^\/([^/?#]+)(.*)$/u.exec(after)
  if (!match) return undefined
  const [, first = "", rest = ""] = match
  if (!isKnownSlug(first)) return undefined
  return { slug: first, rest: `${NTWINE_ROUTE_PREFIX}${rest || "/"}` }
}

/**
 * Answer `/_ntwine/<slug>/health` for a registered project WITHOUT opening it.
 *
 * The launcher's join probe asks this exact question to decide whether to use the Ntwine already
 * running on this machine or start a second one (`src/index.ts` joinRunningNtwine). Letting it route
 * through routeToTenant made "is this machine's Ntwine serving my project" cost a full tenant
 * activation — createContext plus the board/tailer/scheduler cold prime, measured at 34.5s against a
 * live server on 2026-08-12 and at 1.5-7.5s in plans/singleton-ntwine.md §6b. The probe gives up long
 * before that, so which server the operator got was decided by a race, and LOSING it starts a rival
 * server: two Ntwinees, two schedulers, one board fired twice.
 *
 * §4b of that plan specifies this shape directly — assert the machine identity, then confirm the
 * specific project is REGISTERED. The registry is the authority on which projects this Ntwine serves
 * and answering from it is one file read.
 *
 * An already-open project falls through to its own app instead, because that is what carries
 * `ownerProof` and it costs nothing to reach. A merely-registered project holds no launch lease to
 * prove, so it reports none — and nothing asks it to: the join probe omits `ownerProof` precisely
 * because a client holds no lease either.
 */
export function registeredTenantHealth(
  method: string,
  url: string,
  bootId: string,
  lookup: (segment: string) => { id: string; path: string } | undefined,
  isOpen: (projectId: string) => boolean,
): { ok: true; projectId: string; projectDir: string; bootId: string } | undefined {
  if (method !== "GET") return undefined
  const split = splitTenantRequest(url, (segment) => lookup(segment) !== undefined)
  if (!split) return undefined
  const health = `${NTWINE_ROUTE_PREFIX}/health`
  if (split.rest !== health && !split.rest.startsWith(`${health}?`)) return undefined
  const entry = lookup(split.slug)
  if (!entry || isOpen(entry.id)) return undefined
  return { ok: true, projectId: entry.id, projectDir: entry.path, bootId }
}

/**
 * The `<slug>` a PAGE url names, when that project does not exist.
 *
 * `/project/<slug>…` — a project's board, its thread, its status list — and `/all/<slug>/thread/<t>` — a
 * thread drawer on All projects — are the SPA's own routes, so the server just hands back the app and lets
 * the client sort it out. For a slug nobody has, the client cannot: every call it makes is answered by
 * the launching project's app with a 404 it has no way to interpret, the board never arrives, and the
 * page sits on its boot spinner saying "connecting…" while the event stream retries forever. Measured
 * on a real stack (2026-08-11) — the operator's only way out is the home crumb, if they spot it.
 *
 * A renamed project, a deleted one, a stale bookmark and a typo all land here, so the server answers
 * instead: the registry is the authority on which projects exist, and it is one file read away.
 */
export function unknownProjectPage(
  pathname: string,
  isKnownSlug: (slug: string) => boolean,
): string | undefined {
  // `/project/<slug>` is a project's board again (2026-10-06, the upstream scheme the fork had retired on
  // 2026-09-28), and `/all/<slug>` a drawer's prefix on All projects; nothing else names a project.
  const match = /^\/(?:project|all)\/([^/?#]+)/u.exec(pathname)
  if (!match) return undefined
  const slug = decodeURIComponent(match[1] ?? "")
  return slug && !isKnownSlug(slug) ? slug : undefined
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
}

// Bridge a node req/res through Hono's fetch handler (Web Request/Response). Streams the body so
// SSE stays live. Adapted from gent's dev server. Exported for pipe-to-app.test.ts, which drives it
// against a real node http server + real fetch to pin the POST-body-truncation regression.
export async function pipeToApp(
  app: ReturnType<typeof createApp>,
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
  controller: AbortController,
) {
  const url = `http://127.0.0.1:${port}${req.url ?? "/"}`
  // Abort when the RESPONSE closes before it finished — a real client disconnect or a mid-stream SSE
  // hangup — NOT when the request stream ends. Modern node (observed on v26.5.0) fires `close` on the
  // IncomingMessage the instant a handler finishes consuming the request body, so keying the abort on
  // `req`'s close aborted EVERY POST the moment `c.req.json()` drained it — before the response body was
  // written — and every mutation came back as a 0-byte `application/json` chunked reply (dispatch,
  // followUp, completeThread, settings: the whole write surface, dead). `res` closes only after
  // `res.end()` flushes (writableFinished) on the happy path, and closes early with the body still
  // unfinished exactly when the peer went away — which is the disconnect this abort exists to catch.
  res.on("close", () => { if (!res.writableFinished) controller.abort() })
  const response = await app.fetch(
    new Request(url, {
      method: req.method,
      headers: Object.fromEntries(
        Object.entries(req.headers)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : (v as string)]),
      ),
      body: req.method !== "GET" && req.method !== "HEAD" ? (req as unknown as BodyInit) : undefined,
      // @ts-expect-error duplex is required by node's fetch when streaming a request body
      duplex: "half",
      signal: controller.signal,
    }),
    // The peer this server actually accepted, for a request the launcher's proxy did not stamp — the
    // only place it is known once the request becomes a Web Request (app.ts, the audit attribution).
    { remoteAddress: req.socket?.remoteAddress },
  )
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
  if (response.body) {
    const reader = response.body.getReader()
    // CANCELLING THIS READER IS THE ONLY WAY TO STOP A STREAMING HANDLER ON NODE. Hono wires
    // `c.req.raw.signal` → `stream.abort()` only on old Bun (helper/streaming/sse.ts); everywhere else
    // a handler learns its consumer is gone solely through the response stream's `cancel`. Aborting the
    // request controller alone therefore told /events nothing: its `stream.onAbort` never fired, so its
    // 10s heartbeat and bus subscription ran forever and THIS promise never settled — which is exactly
    // why the "http requests" phase could never drain and every Ctrl-C reported a phase timeout and a
    // blocked storage close. Cancel on abort, so shutdown (and a vanished client) really ends the stream.
    const cancel = () => { void reader.cancel().catch(() => undefined) }
    if (controller.signal.aborted) cancel()
    else controller.signal.addEventListener("abort", cancel, { once: true })
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done || !res.writable || controller.signal.aborted) break
        res.write(value)
      }
    } catch {
      // client went away mid-stream
    }
  }
  res.end()
}

export interface ShutdownSignalHandlerOptions {
  close: () => Promise<void>
  exit: (code: number) => void
  error?: (line: string) => void
  forceAfterMs?: number
  scheduleForce?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
}

/** One handler is shared by SIGINT and SIGTERM so a second signal cannot start a competing close. */
export function createShutdownSignalHandler(options: ShutdownSignalHandlerOptions): () => void {
  let started = false
  return () => {
    if (started) return
    started = true
    const scheduleForce = options.scheduleForce ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    const forceAfterMs = options.forceAfterMs ?? SERVER_FORCE_EXIT_MS
    let decided = false
    let force: ReturnType<typeof setTimeout> | undefined
    const decide = (code: number) => {
      if (decided) return
      decided = true
      if (force) clearTimeout(force)
      options.exit(code)
    }
    force = scheduleForce(() => {
      options.error?.(`[ntwine] shutdown force deadline exceeded after ${forceAfterMs}ms`)
      decide(1)
    }, forceAfterMs)
    if (decided) clearTimeout(force)
    else force.unref?.()
    void options.close().then(
      () => decide(0),
      (error) => {
        options.error?.(`[ntwine] shutdown failed: ${error instanceof Error ? error.stack ?? error.message : error}`)
        decide(1)
      },
    )
  }
}

/**
 * Cache-Control for the two kinds of file in web/dist, and they are NOT the same kind.
 *
 * Vite content-hashes everything it emits under `assets/`, so a given URL's bytes can never change —
 * `immutable` is exactly true there, and it is the whole difference between a reload that transfers
 * the bundle again and one that transfers nothing. Until 2026-09-04 this handler sent `content-type`
 * and no validator of any kind, so a reload with the browser cache ENABLED re-fetched the whole app.
 * Measured that day in headless Chrome against a real 558-thread board, document + static bytes on a
 * reload: 1,568,997 -> 1,200, and DOMContentLoaded 34.5 -> 14.2 ms. The 1,200 is three 304s for the
 * files that are NOT hashed; every byte under /assets/ comes from disk.
 *
 * index.html is the opposite case and must never get that treatment: it is the document that NAMES
 * the current hashes, so an immutably-cached copy strands the browser on the old build's asset URLs.
 * Ntwine updates itself by promoting a new artifact and restarting, which means "restart and reload"
 * has to be enough to land on the new app — caching the shell would break exactly that. `no-cache`
 * says "store it, but revalidate before every use": the reload still costs ~300 bytes when nothing
 * changed (a 304 off the ETag below) and picks up a new build the moment there is one. Verified by
 * swapping a new entry chunk in under a running server and reloading the same page in the same
 * browser, which executed the new bytes rather than the cached ones.
 */
const STATIC_CACHE_IMMUTABLE = "public, max-age=31536000, immutable"
const STATIC_CACHE_REVALIDATE = "no-cache"

/**
 * Encoded static bodies, keyed by file + mtime + size + encoding.
 *
 * Brotli takes the cold load from 1,568,997 to 473,271 bytes — 70% — which is what a Ntwine reached
 * through the relay from a remote origin actually pays, the same reason /rpc is compressed (app.ts).
 * It is NOT free-but-pointless locally either: measured 2026-09-04 against one server with the only
 * variable being the client's accept-encoding, median cold FCP was 260 ms with brotli and 280 ms with
 * `identity`. Decompressing 1.3 MB costs the browser less than reading it off a loopback socket does.
 *
 * Cached because brotli q4 over a ~1.3 MB entry chunk is tens of milliseconds that would otherwise be
 * paid on every cold load. The key space is bounded by the files in one dist directory, and the byte
 * budget bounds a long-lived server that has served several promoted artifacts.
 */
const staticEncodedCache = new Map<string, Uint8Array>()
const STATIC_ENCODED_CACHE_MAX_BYTES = 32 * 1024 * 1024
let staticEncodedCacheBytes = 0

function encodedStatic(key: string, encoding: ContentEncoding, raw: Uint8Array): Uint8Array {
  const hit = staticEncodedCache.get(key)
  if (hit) return hit
  const out = compress(raw, encoding)
  if (staticEncodedCacheBytes + out.byteLength > STATIC_ENCODED_CACHE_MAX_BYTES) {
    staticEncodedCache.clear()
    staticEncodedCacheBytes = 0
  }
  staticEncodedCache.set(key, out)
  staticEncodedCacheBytes += out.byteLength
  return out
}

/** Does the client already hold this exact representation? */
function staticIsFresh(req: IncomingMessage, etag: string, mtimeMs: number): boolean {
  const ifNoneMatch = req.headers["if-none-match"]
  if (ifNoneMatch) {
    return ifNoneMatch.split(",").some((candidate) => {
      const tag = candidate.trim()
      return tag === "*" || tag.replace(/^W\//, "") === etag
    })
  }
  const ifModifiedSince = req.headers["if-modified-since"]
  if (!ifModifiedSince) return false
  const since = Date.parse(ifModifiedSince)
  // HTTP dates carry whole seconds, so compare at that resolution — otherwise a file whose mtime has
  // a fractional part always looks newer than the copy the client just told us it has.
  return Number.isFinite(since) && Math.floor(mtimeMs / 1000) <= Math.floor(since / 1000)
}

// Serve a built asset from web/dist, falling back to index.html for SPA routes. Path is
// normalized + confined to distDir so a request can't escape the root.
export function serveStatic(distDir: string, req: IncomingMessage, res: ServerResponse) {
  // A URL path is POSIX whatever the host is. The platform `normalize` turns "/" into "\" on
  // Windows, so the root test below missed, the root resolved to distDir ITSELF, and reading a
  // directory threw — every load of the projects page (`/`, `/?add=…`, `/?unknown=…`) answered
  // "not found" while `/project/<slug>` and every asset were fine (2026-09-09). `join` still
  // converts the separators for the filesystem.
  //
  // Backslashes are folded into slashes FIRST. POSIX normalization would leave a `..\` segment
  // alone, and the native `join` on Windows would then walk it, so `/..\web-dist-x\secret` escaped
  // the root while still sharing its prefix (pullfrog on #34).
  const rel = posix.normalize((req.url ?? "/").split("?")[0].replace(/\\/g, "/")).replace(/^(\.\.[/\\])+/, "")
  let file = join(distDir, rel === "/" ? "index.html" : rel)
  // Separator-aware: `web-dist-private` starts with `web-dist` and is still outside it.
  if (!file.startsWith(distDir + sep)) file = join(distDir, "index.html")
  if (!existsSync(file)) file = join(distDir, "index.html") // SPA fallback
  try {
    const stats = statSync(file)
    // The policy follows the file we RESOLVED, never the URL that was asked for. A request for a
    // hashed asset that no longer exists lands on the SPA fallback above, and answering that with
    // `immutable` would pin the app shell forever under an /assets/ URL — the stale-build bug, with
    // no way out but a manual cache clear.
    const cacheControl = file.startsWith(join(distDir, "assets") + sep) ? STATIC_CACHE_IMMUTABLE : STATIC_CACHE_REVALIDATE
    const etag = `"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}"`
    const headers: Record<string, string> = {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": cacheControl,
      etag,
      "last-modified": stats.mtime.toUTCString(),
      // Sent on every static response, not just the compressed ones: a shared cache in front of a
      // tunnelled Ntwine must not hand a brotli body to a client that asked for identity.
      vary: "Accept-Encoding",
    }
    if (staticIsFresh(req, etag, stats.mtimeMs)) {
      res.writeHead(304, headers)
      res.end()
      return
    }
    let body: Uint8Array = readFileSync(file)
    const accept = req.headers["accept-encoding"]
    const encoding = negotiateEncoding(Array.isArray(accept) ? accept.join(",") : accept)
    if (encoding && shouldCompress(new Headers({ "content-type": headers["content-type"]! }), body.byteLength)) {
      body = encodedStatic(`${encoding}:${file}:${etag}`, encoding, body)
      headers["content-encoding"] = encoding
    }
    headers["content-length"] = String(body.byteLength)
    res.writeHead(200, headers)
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end("not found")
  }
}

export async function startServer(opts: StartOptions = {}): Promise<StartedServer> {
  const runtime: StartServerRuntime = { ...defaultStartServerRuntime, ...opts.runtime }
  const port = opts.port ?? DEFAULT_PORT
  const project = opts.project ?? resolveProject()
  const launchTarget = projectLaunchTarget(project)
  let ownedLaunch: ProjectLaunchLease | undefined
  let delegatedLaunch: ProjectLaunchDelegateLease | undefined
  const ownerToken = opts.launchOwnerToken
  if (ownerToken) delegatedLaunch = registerProjectLaunchDelegate(launchTarget, ownerToken)
  else ownedLaunch = acquireProjectLaunchOwner(launchTarget, "server")
  const effectiveOwnerToken = ownerToken ?? ownedLaunch!.token

  let startupPhase: ServerStartupPhase = "launch ownership"
  // The one database every project shares (ntwine-db.ts). Opened in its own boot phase before the
  // launching context, handed to every tenant through contextOptions, and closed by the storage phase
  // of shutdown — after the launching project's storage, which is the last tenant standing by then.
  let ntwineDb: NtwineDatabase | undefined
  // The resolved Claude Code and Codex executables (the "runtimes" phase); read lazily by the tenant
  // map's contextOptions, which is built before the phase runs.
  let runtimes: ResolvedRuntimes | undefined
  // Named, incremental boot progress for whatever launcher is waiting on /health (boot-progress.ts).
  const bootProgress = createBootProgressPublisher(project.stateDir)
  let ctx: AppContext | undefined
  // The background pass that opens the REST of the registered projects once this one is serving, so
  // their queue badges and their schedulers exist without the operator clicking into each square.
  // Started at the very end of boot; stopped and awaited by the "other projects" shutdown phase.
  let tenantPrime: TenantPrimeRun | undefined
  // Holds the OS's idle-sleep request while any open project has work running (wake-lock.ts).
  let wakeLock: WakeLockLoop | undefined
  // Settings → Remove idle worktrees after: one machine-wide pass over every registered project's
  // `.ntwine/worktrees`, shortly after boot and daily after (worktree-sweep.ts).
  let worktreeSweep: WorktreeSweepLoop | undefined
  // The standing announcement that tells every open tab the project list changed
  // (projects-changed.ts). Armed at the end of boot; disarmed by the "other projects" shutdown phase.
  let stopProjectAnnouncements: (() => void) | undefined
  // One process, N projects (tenants.ts). The launching project is adopted below once its own boot
  // phases have built it; anything opened later goes through activate(), which is where the
  // AppContext-seam error boundary lives.
  /**
   * Every project this process has open, claimed in its state folder (project-serving.ts) — opening
   * one a DIFFERENT live server has open is refused, naming that server.
   *
   * Two tailers on one SQLite file is the survivable half — two SCHEDULERS is not: both would
   * independently decide the same recurring prompt or timer was due and dispatch it twice into the
   * same worker. The launch lease guarded only the folder a server runs on, and the installed Ntwine
   * runs on its own folder now, so every project it opens needs a claim of its own. A claim whose
   * server has gone never blocks, so this only ever refuses the board that is genuinely taken.
   */
  const servingClaims = new Map<string, { release(): void }>()
  const claimServing = (candidate: Project, launched = false): void => {
    servingClaims.get(candidate.id)?.release()
    servingClaims.set(candidate.id, claimProjectServing(
      { projectId: candidate.id, projectDir: candidate.dir, stateDir: candidate.stateDir, name: candidate.name },
      { launched },
    ))
  }
  const releaseServing = (projectId: string): void => {
    servingClaims.get(projectId)?.release()
    servingClaims.delete(projectId)
  }

  // What every context answers "which projects are open here" with — the map below, read lazily so
  // the launching project's own context (built before the map is populated) sees the same live list.
  const activeTenants: NonNullable<AppContext["activeTenants"]> = () =>
    tenants.active().map(({ project: open, ctx: openCtx }) => ({ project: open, board: openCtx.board, storage: openCtx.storage, ctx: openCtx }))
  // Open one registered project by id, the way its first request would (routeToTenant below) — for a
  // `spawn_thread` aimed at a project nothing has opened yet (router spawnTarget).
  const openProject: NonNullable<AppContext["openProject"]> = async (projectId) => {
    const entry = findWorkspaceById(projectId)
    return entry ? tenants.activate(projectForEntry(entry)) : undefined
  }
  // The editor windows connected over `/_ntwine/editor` (editor-bridge.ts): ONE for the machine, like
  // this server, handed to every project's context so any project's file link can reach any window.
  // Its upgrade is answered before tenant routing below; it has no boot phase because it holds nothing
  // until a window connects, which cannot happen before the server is accepting.
  const editors = createEditorBridge({
    bootId: () => ctx?.bootId ?? "",
    listProjects: () => listEditorProjects(listWorkspaces(), activeTenants()),
    // On every open project's bus, because a page hears only its own project's.
    publish: (event) => {
      for (const open of tenants.active()) open.ctx.bus.publish(event)
    },
    // Where a thread needing the human is heard, for the one window that shows it (editor-bridge.ts § attention).
    openProjects: () => tenants.active().map(({ project: open, ctx: openCtx }) => ({ id: open.id, dir: workDirOf(open), bus: openCtx.bus, board: openCtx.board })),
  })
  /**
   * Take one project apart while the rest keep serving — the resource half of deleting a project.
   *
   * It lives here rather than in the router because the tenant map does, and the ORDER is the reason
   * it is one function: a worker is stopped through its own tenant's broker, so it has to go before
   * the tenant closes, and `ui.db` has to be released before the directory holding it is unlinked.
   *
   * It refuses the launching project for the reason AppContext.launchProjectId spells out: this
   * process publishes exactly one `server.lock`, that project's, and the boot phases below own its
   * teardown. The router never asks — it refuses deleting that project's data and forgets its card
   * without a teardown; this is the backstop.
   */
  const teardownProject: NonNullable<AppContext["teardownProject"]> = async (projectId, options) => {
    if (projectId === project.id) return { closed: false, stoppedWorkers: 0 }
    const open = tenants.get(projectId)
    const stoppedWorkers = open && options?.stopWorkers ? await stopProjectWorkers(open) : 0
    const closed = await tenants.deactivate(projectId)
    // A project that never opened still has rows and a state directory, so neither is conditional on
    // `closed`. Rows first: the directory holds nothing the database refers to, and a purge that
    // fails leaves a project the operator can still see and retry rather than a ghost with no files.
    if (options?.deleteState) {
      ntwineDb?.purgeProject(projectId)
      deleteProjectState(projectId)
    }
    return { closed, stoppedWorkers }
  }
  const tenants = createTenantMap<TenantSurfaces>({
    createContext: async (contextOptions) => {
      const opening = contextOptions.project
      if (!opening) return runtime.createContext(contextOptions)
      claimServing(opening)
      try {
        return await runtime.createContext(contextOptions)
      } catch (error) {
        releaseServing(opening.id)
        throw error
      }
    },
    afterDeactivate: (closed) => releaseServing(closed.id),
    // serverLockPath is the LAUNCHING project's: it is the only `server.lock` this process publishes
    // (see "status publication"), so it is the only file a tenant's worker can read the port out of.
    contextOptions: {
      get claudeBin() { return runtimes?.claude.bin ?? opts.claudeBin },
      get codexBin() { return runtimes?.codex.bin ?? opts.codexBin },
      get codexVersion() { return runtimes?.codex.version === "unknown" ? undefined : runtimes?.codex.version },
      serverLockPath: serverLockPathFor(project),
      activeTenants,
      openProject,
      teardownProject,
      launchProjectId: project.id,
      editors,
      get database() { return ntwineDb?.db },
    },
    // Each project's app carries ITS OWN owner proof, so /health stays honest per project rather than
    // answering for whichever one happened to launch the server. The socket is per project for a
    // blunter reason: it is a live feed of ONE board, so sharing the launcher's would push its
    // threads into every other project's UI.
    createApp: (tenantCtx) => ({
      app: runtime.createApp(tenantCtx, appOptionsFor(tenantCtx)),
      terminal: runtime.createTerminal(terminalOptionsFor(tenantCtx)),
      appSocket: runtime.createAppSocket(appSocketOptionsFor(tenantCtx)),
    }),
    closeApp: async (surfaces) => {
      await surfaces.appSocket.close()
      await surfaces.terminal.close()
    },
    // The same producers boot starts for the launching project, in the same order. The tailer's cold
    // prime is what makes this affordable to do lazily — it is bounded per tick, so activating a
    // large board no longer blocks the event loop for seconds.
    startProducers: async (tenantCtx) => {
      await tenantCtx.board.start()
      await tenantCtx.tailer.start()
      if (process.env.NTWINE_WAKERS_OFF !== "1") await tenantCtx.scheduler.start()
      // detectGithub reads THIS project's directory, so the cache is per project too. The
      // githubStatus handler live-detects and back-fills when it is missing, which is why the gap
      // hides while `gh` is authed — but unauthed it has nothing to fall back to and reports the
      // project as not being in a repo at all. Boot does this for the launching project; do not make
      // it block, for the same reason boot does not.
      void runtime.initGithub(tenantCtx).catch(() => undefined)
    },
  })
  const appOptionsFor = (c: AppContext) => ({
    port,
    ownerProof: projectLaunchTokenProof(projectLaunchTarget(c.project), effectiveOwnerToken),
    controlToken: effectiveOwnerToken,
    ...(opts.machineOwnerToken ? { machineToken: opts.machineOwnerToken } : {}),
    requestOwnerStop,
  })
  const terminalOptionsFor = (c: AppContext) => ({
    resolveCommand: (slug: string) => c.terminalRunner.attach(slug),
  })
  const appSocketOptionsFor = (c: AppContext) => ({
    bus: c.bus,
    bootId: c.bootId,
    transcriptChange: c.transcriptChange,
    boardSnapshot: () => c.board.snapshot(),
    currentSeq: () => c.board.currentSeq(),
    readTranscript: makeTranscriptReader(
      c.project,
      c.storage,
      c.backendFor,
      (slug, id) => c.tailer.subAgent(slug, id),
      // Same reason, same lesson: an upward report's title has to be resolved by BOTH producers or one
      // of them shows the child's profile cell where the other shows its work.
      (slug, taskId) => c.tailer.subAgentByTaskId?.(slug, taskId),
      // The /ws producer is the one the live UI actually renders, so a dead owner has to reach it
      // too — projecting only the RPC is the exact half-fix the × already had to correct once.
      (slug) => c.tailer.ownerGone?.(slug) ?? false,
      c.sessionPeerThread,
    ),
    // A reader's live watch on the file it shows. Gated as the read is (one set of openable roots for
    // both readers, plus the Markdown reader's canonical-extension check) and watched by CANONICAL
    // path, so a symlinked `.md` and its target are one watch.
    watchFile: (path: string, onChange: () => void) =>
      watchLocalFile(resolveWatchableLocalFile(path, openableFileRoots(c.project)), onChange),
  })
  let githubInit: Promise<void> | undefined
  let terminal: TerminalServer | undefined
  let appSocket: AppSocketServer | undefined
  let vite: ViteServer | undefined
  let httpServer: HttpServer | undefined
  let accepting = false
  let statusPath: string | undefined
  let statusIdentity: {
    pid: number
    processStart: string
    publisherToken: string
    ownerToken: string
  } | undefined
  const requestControllers = new Set<AbortController>()
  const requestTasks = new Set<Promise<void>>()
  const diagnostics: ShutdownDiagnostic[] = []
  let httpClose: Promise<void> | null = null
  let closing: Promise<void> | null = null
  let activeSafety: Promise<void> | null = null
  let recovery: Promise<void> | null = null
  let finalized = false
  let finalization: Promise<void> | null = null
  let upstreamContextFence: ContextStartupFence | undefined
  let removeSignalHandlers = () => {}
  let ownerStopHandler = opts.requestOwnerStop
  let ownerStopPending = false

  const diagnostic = (event: ShutdownDiagnostic) => {
    diagnostics.push(event)
    if (opts.shutdownDiagnostic) opts.shutdownDiagnostic(event)
    else {
      ntwineLog.warn(
        "shutdown",
        `${event.phase}: ${event.message}${event.error instanceof Error ? ` — ${event.error.message}` : ""}`,
      )
    }
  }

  const requestOwnerStop = () => {
    if (ownerStopHandler) ownerStopHandler()
    else ownerStopPending = true
  }

  const stopHttp = (): Promise<void> => {
    accepting = false
    for (const controller of requestControllers) controller.abort()
    if (httpClose) return httpClose
    const server = httpServer
    const attempt = new Promise<void>((resolveClose, rejectClose) => {
      if (!server?.listening) return resolveClose()
      server.close((error) => error ? rejectClose(error) : resolveClose())
      server.closeAllConnections()
    })
    httpClose = attempt
    void attempt.catch(() => {
      if (httpClose === attempt) httpClose = null
    })
    return attempt
  }

  const cleanupHttp = createRetryableCleanup(async () => {
    const closingHttp = stopHttp()
    await Promise.all([closingHttp, Promise.allSettled([...requestTasks]).then(() => undefined)])
  })
  const cleanupTerminal = createRetryableCleanup(async () => { await terminal?.close() })
  const cleanupAppSocket = createRetryableCleanup(async () => { await appSocket?.close() })
  const cleanupEditorBridge = createRetryableCleanup(() => editors.close())
  const cleanupWakeLock = createRetryableCleanup(() => wakeLock?.stop())
  const cleanupWorktreeSweep = createRetryableCleanup(async () => { await worktreeSweep?.stop() })
  // The per-project half, from context.ts, so one project can be torn down without the server —
  // `() => ctx` rather than `ctx` because these are built before the context exists.
  const tenant = projectContextCleanups(() => ctx)
  // Every project opened BESIDES the launching one. The launching project is torn down by the phases
  // below — it was adopted into the map, so draining the map wholesale would close it twice.
  const cleanupExtraTenants = createRetryableCleanup(async () => {
    // Settle the background priming pass FIRST (tenant-prime.ts). A project it opened after this drain
    // would be a SQLite handle and a tailer nothing ever stops; stopping it cuts the wait between
    // projects short, so this costs a boot-time shutdown nothing.
    tenantPrime?.stop()
    await tenantPrime?.done
    stopProjectAnnouncements?.()
    for (const { project: opened } of tenants.active()) {
      if (opened.id !== project.id) await tenants.deactivate(opened.id)
    }
  })
  const cleanupTailer = createRetryableCleanup(tenant.tailer)
  const cleanupTerminalRunner = createRetryableCleanup(tenant.terminalRunner)
  const cleanupSubscriptions = createRetryableCleanup(tenant.subscriptions)
  const cleanupScheduler = createRetryableCleanup(tenant.scheduler)
  const cleanupBoard = createRetryableCleanup(tenant.board)
  const cleanupBridge = createRetryableCleanup(tenant.bridge)
  const cleanupVite = createRetryableCleanup(async () => { await vite?.close() })
  const cleanupGithub = createRetryableCleanup(async () => { await githubInit })
  const cleanupStorage = createRetryableCleanup(async () => {
    await tenant.storage()
    ntwineDb?.close()
  })

  const createLifecycleBarrier = (): ShutdownBarrier => createShutdownBarrier({
    timeoutMs: opts.shutdownTimeoutMs ?? SERVER_SHUTDOWN_TIMEOUT_MS,
    // A wedged producer (e.g. an in-flight wake delivery shelling out to git) must not stall the
    // authoritative drain until the supervisor's 15s SIGKILL. This bounds+names each phase so the
    // child's post-deadline ownership wait settles promptly instead of hanging to the hard kill.
    phaseTimeoutMs: DEFAULT_SHUTDOWN_PHASE_TIMEOUT_MS,
    diagnostic,
    deadline: runtime.shutdownDeadline,
    phases: [
      {
        name: "http requests",
        run: cleanupHttp,
      },
      {
        name: "terminal transport",
        run: cleanupTerminal,
      },
      {
        name: "application socket",
        run: cleanupAppSocket,
      },
      // Beside the application socket: a live transport, cut so every window reconnects to the next server.
      { name: "editor bridge", run: cleanupEditorBridge },
      // Before the tenants close: it reads their tailers, and a stopping server holds nothing awake.
      { name: "wake lock", run: cleanupWakeLock },
      // Before the tenants close too: a pass in flight reads their boards.
      { name: "idle worktree sweep", run: cleanupWorktreeSweep },
      { name: "other projects", run: cleanupExtraTenants },
      { name: "tailer producer", run: cleanupTailer },
      // Hang up every thread terminal, so a dev server started from Ntwine stops with it.
      { name: "thread terminals", run: cleanupTerminalRunner },
      { name: "context subscriptions", run: cleanupSubscriptions },
      { name: "wake scheduler", run: cleanupScheduler },
      { name: "board producer and watcher", run: cleanupBoard },
      {
        name: "Codex app-server bridge",
        run: cleanupBridge,
      },
      {
        name: "Vite",
        requiredForStorage: false,
        requiredForCompletion: true,
        run: cleanupVite,
      },
      {
        name: "GitHub initialization",
        requiredForStorage: false,
        requiredForCompletion: true,
        run: cleanupGithub,
      },
    ],
    closeStorage: cleanupStorage,
  })

  let lifecycle = createLifecycleBarrier()

  const finalizeOwnership = (): Promise<void> => {
    if (finalized) return Promise.resolve()
    if (finalization) return finalization
    const attempt = (async () => {
      removeSignalHandlers()
      if (statusPath && statusIdentity) runtime.removeStatus(statusPath, statusIdentity)
      // Identity-checked, so a second ntwine that has since taken the machine address keeps its own
      // record and only the process that actually published this one retires it.
      if (statusPath && statusIdentity) {
        try { runtime.removeStatus(serverAddressPathForStateDir(dirname(statusPath)), statusIdentity) } catch {}
      }
      // The launching project's serving claim, once its storage has closed: it is the one tenant the
      // map never deactivates. A failure here must not keep the launch lease below from releasing.
      try {
        releaseServing(project.id)
      } catch (error) {
        ntwineLog.warn("server", `could not record that ${project.name} closed: ${error instanceof Error ? error.message : error}`)
      }
      // Ownership is always the final resource. A thrown status cleanup leaves this exact fence live.
      delegatedLaunch?.release()
      ownedLaunch?.release()
      finalized = true
    })()
    finalization = attempt
    void attempt.catch(() => {
      if (finalization === attempt) finalization = null
    })
    return attempt
  }

  const attachSafety = (
    barrier: ShutdownBarrier,
    contextSafety = upstreamContextFence?.whenSafe() ?? Promise.resolve(),
  ): Promise<void> => {
    const safety = Promise.all([barrier.whenDrained(), contextSafety]).then(() => finalizeOwnership())
    activeSafety = safety
    void safety.catch(() => undefined)
    return safety
  }

  const beginClose = (): Promise<void> => {
    if (closing) return closing
    const safety = attachSafety(lifecycle)
    closing = lifecycle.close().then(() => safety)
    return closing
  }

  const shutdownFence: ServerShutdownFence = {
    get ownershipRetained() {
      return !finalized
    },
    whenSafe() {
      if (finalized) return Promise.resolve()
      return activeSafety ?? Promise.reject(new Error("Ntwine server shutdown has not started"))
    },
    recover() {
      if (finalized) return Promise.resolve()
      if (recovery) return recovery
      accepting = false
      lifecycle = createLifecycleBarrier()
      const contextSafety = upstreamContextFence?.recover() ?? Promise.resolve()
      const safety = attachSafety(lifecycle, contextSafety)
      const attempt = lifecycle.close().then(() => safety)
      recovery = attempt
      void attempt.catch(() => {
        if (recovery === attempt) recovery = null
      })
      return attempt
    },
  }

  const cleanup = createShutdownSignalHandler({
    close: beginClose,
    exit: (code) => process.exit(code),
    error: (line) => console.error(line),
  })

  const phase = async <T>(
    name: ServerStartupPhase,
    operation: () => T | Promise<T>,
    commit?: (value: T) => void,
  ): Promise<T> => {
    startupPhase = name
    bootProgress(name)
    const value = await operation()
    // Publish a newly-created resource to the rollback ledger before an injected post-phase failure.
    commit?.(value)
    await runtime.afterPhase?.(name)
    return value
  }

  try {
    // The launch lease above fences the folder this server runs on against another launch; the claim
    // fences the PROJECT against another server that has it open as one of many, which is refused here
    // as a boot failure that names that server.
    await phase("launch ownership", () => claimServing(project, true))
    // The executables every backend below will run. First boot on a machine downloads the pins (a few
    // hundred MB, once per pin), and the launcher's readout follows it through bootProgress; after
    // that the phase is a marker read. An explicit executable skips it; a failure falls back to PATH
    // with a warning rather than refusing to boot (runtimes.ts).
    runtimes = await phase("runtimes", () => runtime.resolveRuntimes({
      claudeBin: opts.claudeBin,
      codexBin: opts.codexBin,
      log: (level, message) => ntwineLog[level]("server", message),
      onProgress: (backend, message) => bootProgress(`runtimes: ${backend} ${message}`),
    }))
    for (const backend of ["claude", "codex"] as const) ntwineLog.info("server", `runtimes: ${describeRuntime(backend, runtimes[backend])}`)
    // A provisioned Claude Code must not update itself out from under the pin. Every worker, and every
    // `claude auth status` / `claude auth login` Ntwine runs, inherits the server's environment.
    if (runtimes.claude.source === "provisioned") process.env.DISABLE_AUTOUPDATER = "1"
    // Committed through the ledger callback, like the context below: an injected failure right after
    // this phase throws before the assignment would run, and the rollback must still find the handle.
    ntwineDb = await phase("database", () => runtime.openDatabase({ stateDir: project.stateDir }), (value) => { ntwineDb = value })
    ctx = await phase(
      "context",
      () => runtime.createContext({
        claudeBin: runtimes!.claude.bin,
        codexBin: runtimes!.codex.bin,
        codexVersion: runtimes!.codex.version === "unknown" ? undefined : runtimes!.codex.version,
        project,
        database: ntwineDb!.db,
        serverLockPath: serverLockPathFor(project),
        activeTenants,
        openProject,
        teardownProject,
        launchProjectId: project.id,
        editors,
        startup: {
          afterPhase: (p) => {
            bootProgress(`context: ${p}`)
            runtime.afterContextPhase?.(p)
          },
          cleanupTimeoutMs: opts.shutdownTimeoutMs ?? SERVER_SHUTDOWN_TIMEOUT_MS,
          cleanupDiagnostic: diagnostic,
          cleanupDeadline: runtime.shutdownDeadline,
        },
      }),
      (value) => { ctx = value },
    )
    tenants.adopt(project, ctx)
    // Recover the projects this machine already has state for. Without it a machine that has been
    // running Ntwine for months reaches its first project list with ONE project, and the only way to fill it is
    // to visit every repository in a terminal — the chore one server per machine exists to end.
    try {
      const recovered = backfillRegistry()
      if (recovered > 0) ntwineLog.info("server", `registry: recovered ${recovered} project(s) from existing state`)
    } catch (error) {
      ntwineLog.warn("server", `registry backfill skipped: ${error instanceof Error ? error.message : error}`)
    }

    // Resolve GitHub detection in the background. The original promise is retained and drained on
    // rollback so even an injected/hung initializer cannot outlive ownership silently.
    startupPhase = "GitHub initialization"
    githubInit = runtime.initGithub(ctx)
    void githubInit.catch(() => undefined)
    await runtime.afterPhase?.("GitHub initialization")

    const app = await phase("application", () => runtime.createApp(ctx!, appOptionsFor(ctx!)))
    terminal = await phase(
      "terminal transport",
      () => runtime.createTerminal(terminalOptionsFor(ctx!)),
      (value) => { terminal = value },
    )
    appSocket = await phase(
      "application socket",
      () => runtime.createAppSocket(appSocketOptionsFor(ctx!)),
      (value) => { appSocket = value },
    )
    // Re-adopt with the surfaces attached. The early adopt registered the context so the map is never
    // missing the launching project; these did not exist yet at that point, and routing is closed
    // until `accepting` flips below, so nothing can observe the gap.
    tenants.adopt(project, ctx, { app, terminal, appSocket })
    await phase("board producer", () => ctx!.board.start())
    // The tailer's FIRST pass is the one boot step that can legitimately take minutes on a cold board
    // of thousands of threads. Report its position so a waiting launcher can tell "working" from
    // "wedged" instead of guessing with a stopwatch.
    await phase("tailer producer", () => ctx!.tailer.start((done, total) => {
      bootProgress(`tailer producer ${done}/${total}`)
    }))
    if (process.env.NTWINE_WAKERS_OFF !== "1") {
      await phase("wake scheduler", () => ctx!.scheduler.start())
    } else {
      await phase("wake scheduler", () => undefined)
    }

    statusPath = serverLockPathFor(ctx.project)
    const webRoot = resolve(import.meta.dirname, "..", "..", "web")
    const distDir = opts.webDistDir ? resolve(opts.webDistDir) : join(webRoot, "dist")
    startupPhase = "Vite"
    // Never listens: it only carries the HMR upgrades the board's upgrade handler hands to Vite.
    const viteUpgrades = createServer()
    if (opts.dev) {
      try {
        // HMR rides the board's OWN port: Vite takes its upgrades from `viteUpgrades`, which the
        // upgrade handler below feeds every VITE_HMR_PATH socket, and its client then connects to the
        // origin that served the page. So it reaches through the supervisor proxy and anything in
        // front of it — a phone on a frizz.sh name gets hot reload, behind the same session gate as
        // the board socket — and the tab reconnects to the next child after every recycle, because
        // the public port never moves. (A side port, childPort + 39000, did neither: a phone cannot
        // reach it, and it followed the child's random port, so the first recycle orphaned the tab.)
        vite = await runtime.createVite({
          root: webRoot,
          server: { middlewareMode: true, ws: { server: viteUpgrades, path: VITE_HMR_PATH } },
          appType: "custom",
        })
      } catch (error) {
        if (opts.requireDevWeb) throw error
        ntwineLog.warn(
          "server",
          `vite dev middleware unavailable — serving API only: ${error instanceof Error ? error.message : error}`,
        )
      }
    }
    await runtime.afterPhase?.("Vite")

    /**
     * Route a `/_ntwine/<slug>/…` request at the project that owns it, opening that project on first
     * use. This is the lazy activation §4 settles on: nothing is opened before something addresses it,
     * and the first request for a board pays the (now bounded) activation.
     *
     * In practice the background priming pass usually gets there first (tenant-prime.ts) — this stays
     * the path that opens a project registered since boot, and the one that guarantees a project is
     * open by the time its first request is answered rather than a beat later.
     *
     * Undefined for an unknown slug or a project that will not open — the caller falls through to the
     * launching project's app, which answers 404 rather than leaking another project's data.
     */
    const routeToTenant = async (
      url: string,
    ): Promise<{ surfaces: TenantSurfaces; url: string } | undefined> => {
      const split = splitTenantRequest(url, (segment) => findWorkspaceBySegment(segment) !== undefined)
      if (!split) return undefined
      const entry = findWorkspaceBySegment(split.slug)
      if (!entry) return undefined
      const existing = tenants.appFor(entry.id)
      // The open app is only the answer while it was built at the path the registry NOW records: a
      // renamed checkout is re-registered at its new path by the next `ntwine` run or add from the page, and the
      // tenant that opened at the old one has to be reopened there (tenants.activate does that). The
      // launching project is exempt — its context is owned by the boot phases, not the map, and it is
      // the one directory this process is standing in. An entry's path is where its agents run, which
      // for the Home workspace is the home folder rather than the directory holding its board.
      const open = tenants.get(entry.id)?.project
      if (existing && (entry.id === project.id || (open && workDirOf(open) === entry.path))) {
        return { surfaces: existing, url: split.rest }
      }
      if (!(await tenants.activate(projectForEntry(entry)))) return undefined
      const built = tenants.appFor(entry.id)
      return built ? { surfaces: built, url: split.rest } : undefined
    }

    accepting = true
    httpServer = await phase("HTTP server", () => runtime.createHttpServer((req, res) => {
      if (req.url) req.url = adoptLegacyRoute(req.url)
      if (!accepting) {
        res.writeHead(503, { connection: "close" })
        res.end("server shutting down")
        return
      }
      const url = req.url ?? "/"
      if (isApiUrl(url)) {
        // Before routeToTenant, because routing there is what would open the project. A launcher
        // deciding whether to join this server must not pay — or time out on — an activation.
        const registered = registeredTenantHealth(
          req.method ?? "GET",
          url,
          ctx!.bootId,
          (segment) => findWorkspaceBySegment(segment),
          (projectId) => tenants.get(projectId) !== undefined,
        )
        if (registered) {
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify(registered))
          return
        }
        const controller = new AbortController()
        requestControllers.add(controller)
        let task!: Promise<void>
        // The tenant's own app sees its ordinary routes: the `<slug>` segment is stripped, so nothing
        // downstream needs to know it was ever addressed by one.
        task = routeToTenant(url)
          .then((routed) => {
            if (routed) req.url = routed.url
            return pipeToApp(routed?.surfaces.app ?? app, req, res, port, controller)
          })
          .catch(() => {
            if (!res.headersSent) res.writeHead(controller.signal.aborted ? 503 : 500)
            res.end()
          })
          .finally(() => {
            requestControllers.delete(controller)
            requestTasks.delete(task)
          })
        requestTasks.add(task)
        return
      }
      // A page for a project that does not exist goes to `/`, which the page sends on to the view this
      // browser showed last (or a board that exists; web routes.tsx LastViewRedirect). The slug rides
      // along so the page can say what happened rather than appearing to have swallowed the URL.
      const missing = unknownProjectPage(url.split("?")[0] ?? "", (slug) => findWorkspaceBySegment(slug) !== undefined)
      if (missing !== undefined) {
        res.writeHead(302, { location: `/?unknown=${encodeURIComponent(missing)}` })
        res.end()
        return
      }
      if (vite) {
        vite.middlewares(req, res, () => {
          try {
            const html = readFileSync(join(webRoot, "index.html"), "utf8")
            void vite!.transformIndexHtml(url, html).then((out) => {
              res.writeHead(200, { "content-type": "text/html" })
              res.end(out)
            })
          } catch {
            res.writeHead(404)
            res.end("web not built")
          }
        })
        return
      }
      if (existsSync(distDir)) {
        serveStatic(distDir, req, res)
        return
      }
      res.writeHead(503)
      res.end("web assets unavailable (dev vite failed to load, no dist build)")
    }), (value) => { httpServer = value })
    httpServer.keepAliveTimeout = 5000
    httpServer.headersTimeout = 10000
    httpServer.on("upgrade", (req, socket, head) => {
      if (req.url) req.url = adoptLegacyRoute(req.url)
      if (!accepting) {
        socket.destroy()
        return
      }
      // Vite's HMR socket rides this port too (see createVite above): hand it over before routing, which
      // would read the path's second segment as a project.
      if (vite && isViteHmrUpgrade(req)) {
        viteUpgrades.emit("upgrade", req, socket, head)
        return
      }
      // The editor socket is machine-wide and answered here, BEFORE routing: a project prefix would only
      // open a project for nothing. `editor` is a reserved slug, so no project can shadow the path.
      if (editors.handleUpgrade(req, socket, head)) return
      // A `/_ntwine/<slug>/ws` upgrade has to reach THAT project's socket, so this resolves the tenant
      // exactly as the request path does — asynchronously, because the project may not be open yet.
      // The socket simply waits; there is nothing to answer with until we know whose feed it wants.
      void routeToTenant(req.url ?? "/")
        .then((routed) => {
          const surfaces = routed?.surfaces
          if (routed) req.url = routed.url
          const term = surfaces?.terminal ?? terminal!
          const ws = surfaces?.appSocket ?? appSocket!
          if (term.handleUpgrade(req, socket, head)) return
          if (ws.handleUpgrade(req, socket, head)) return
          socket.destroy()
        })
        .catch(() => socket.destroy())
    })

    await phase("HTTP listen", () => new Promise<void>((resolveListen, rejectListen) => {
      const server = httpServer!
      const onError = (error: Error) => rejectListen(error)
      server.once("error", onError)
      server.listen(port, "127.0.0.1", () => {
        server.off("error", onError)
        resolveListen()
      })
    }))

    const processGeneration = runtime.currentProcessGeneration()
    statusIdentity = {
      pid: processGeneration.pid,
      processStart: processGeneration.processStart,
      publisherToken: ctx.bootId,
      ownerToken: effectiveOwnerToken,
    }
    await phase("status publication", () => {
      const status = {
        ...statusIdentity!,
        projectId: project.id,
        projectDir: project.dir,
        port,
        bootId: ctx!.bootId,
      }
      runtime.writeStatus(statusPath!, status)
      // …and the SAME record at the machine's one fixed address. A worker's ntwine MCP server re-reads
      // this on every call, so an "Update & Restart" — which moves the port, and may even move which
      // project is the launcher — reaches every live detached worker without any of them restarting.
      //
      // CLAIMED ONLY IF NOBODY LIVE HOLDS IT. One machine runs one ntwine, but "one" is an intent, not
      // an invariant: a second server really can boot (a stray `ntwine` in another repo, a supervised
      // child racing its parent). Overwriting a live holder's record is the half that bites — the
      // removal is already identity-checked, so the intruder's own clean exit then RETIRES the address
      // out from under a server that is still serving, and every live worker loses the one path that
      // was supposed to survive a restart. Observed exactly once, 2026-08-08 16:45→16:51: the file was
      // present, then gone, while its publisher on port 50020 was still listening.
      //
      // Degrading is survivable (the shim then scans project locks and finds the live one), but the
      // point of this file is to be the ANSWER, so a live holder keeps it.
      try {
        // Derived from THIS project's state dir, never from homedir(): a test or a sandbox stack must
        // publish inside its own sandbox, not over the real machine's address. See ntwine-paths.ts.
        const addressPath = serverAddressPathForStateDir(ctx!.project.stateDir)
        const held = readServerAddressHolder(addressPath)
        if (held && held.pid !== status.pid && pidIsAlive(held.pid)) {
          ntwineLog.warn(
            "server",
            `machine server address is held by a live ntwine (pid ${held.pid}, port ${held.port}); leaving it — this server is reachable at its project lock`,
          )
        } else {
          runtime.writeStatus(addressPath, status)
        }
      } catch (error) {
        ntwineLog.warn("server", `could not publish the machine server address: ${error instanceof Error ? error.message : error}`)
      }
    })
    // The launcher owns what the operator sees; this is the control plane's PRIVATE port behind the
    // supervisor proxy, and printing it beside the real one left two addresses on screen with no way
    // to tell which to open. It belongs in the log.
    ntwineLog.info(
      "server",
      `control plane listening on 127.0.0.1:${port} (${opts.dev ? "dev" : "prod"}) — project ${ctx.project.name}`,
    )

    startupPhase = "signal handlers"
    if (!opts.requestOwnerStop) {
      ownerStopHandler = cleanup
      if (ownerStopPending) cleanup()
    }
    if (opts.installSignalHandlers !== false) {
      process.on("SIGINT", cleanup)
      process.on("SIGTERM", cleanup)
      removeSignalHandlers = () => {
        process.off("SIGINT", cleanup)
        process.off("SIGTERM", cleanup)
        removeSignalHandlers = () => {}
      }
    }
    await runtime.afterPhase?.("signal handlers")
    // The port is listening and /health answers: the launcher no longer needs the progress signal.
    bootProgress.done()

    // From here on, a change to the project list reaches every tab on every open project's stream —
    // the tab that made it is the only one that would otherwise re-read the list.
    stopProjectAnnouncements = announceProjectListChanges({
      registryPath: registryPath(),
      buses: () => tenants.active().map((open) => open.ctx.bus),
    })

    // …and now open the OTHER registered projects, in the background, so the rail can badge every
    // square with its queue size instead of only the ones the operator has clicked into. Deliberately
    // after bootProgress.done(): this must never be something a launcher waits on. See tenant-prime.ts
    // for why opening them all is affordable, and for the serialization.
    if (process.env.NTWINE_TENANT_PRIME_OFF !== "1") {
      tenantPrime = startTenantPrime({
        // Home included: its queue badges and its scheduler should exist before anyone clicks into it,
        // exactly like a project's.
        list: () => listWorkspaces(),
        isOpen: (projectId) => tenants.get(projectId) !== undefined,
        toProject: (entry) => projectForEntry(entry),
        activate: (candidate) => tenants.activate(candidate),
        servedElsewhere: (candidate) => projectServedElsewhere(candidate.stateDir, candidate.id),
      })
    }

    // Every open project, read on each poll, so one tenant-prime opens later is covered from then on.
    if (process.env.NTWINE_WAKE_LOCK_OFF !== "1") {
      wakeLock = startWakeLockLoop(() => tenants.active().map(({ ctx: open }) => ({
        sessions: () => open.storage.allSessions(),
        telemetry: (slug: string) => open.tailer.get(slug),
      })))
    }

    if (process.env.NTWINE_WORKTREE_SWEEP_OFF !== "1") {
      const settingsOf = ctx!
      worktreeSweep = startIdleWorktreeSweep({
        days: () => settingsOf.getSettings().removeIdleWorktreesDays ?? 7,
        // Home included: a thread working there can work in any repository's worktree.
        projects: () => listWorkspaces().map((entry) => ({
          id: entry.id,
          name: entry.name ?? basename(entry.path),
          dir: tenants.get(entry.id) ? workDirOf(tenants.get(entry.id)!.project) : entry.path,
          stale: entry.stale,
          open: tenants.get(entry.id) !== undefined,
          // Home's folder is the home folder: a source of threads, never a repository to sweep.
          ...(isHomeWorkspace(entry.id) ? { notARepo: true } : {}),
        })),
        inUse: async () => (await Promise.all(tenants.active().map(({ ctx: open }) => threadFoldersInUse(open)))).flat(),
      })
    }

    return { httpServer, ctx, port, close: beginClose, shutdownFence }
  } catch (startupError) {
    accepting = false
    bootProgress.done()
    let cleanupError: unknown
    let reportedStartupError = startupError
    if (startupError instanceof ContextStartupError) {
      upstreamContextFence = startupError.fence
      for (const event of startupError.diagnostics) {
        if (!diagnostics.includes(event)) diagnostics.push(event)
      }
      reportedStartupError = startupError.startupError
      cleanupError = startupError.cleanupError
      // The context already exhausted its bounded rollback. Drain the outer ledger without awaiting
      // its unbounded context fence; attachSafety releases ownership automatically if that fence later
      // proves safe, while the structured startup error returns promptly now.
      attachSafety(lifecycle)
      try {
        await lifecycle.close()
      } catch (error) {
        cleanupError = new AggregateError([startupError.cleanupError, error], "context and server rollback both failed")
      }
    } else {
      try {
        await beginClose()
      } catch (error) {
        cleanupError = error
      }
    }
    throw new ServerStartupError({
      phase: startupPhase,
      startupError: reportedStartupError,
      cleanupError,
      diagnostics,
      fence: shutdownFence,
    })
  }
}
