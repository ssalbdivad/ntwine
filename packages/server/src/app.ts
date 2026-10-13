import { Hono } from "hono"
import { cors } from "hono/cors"
import { streamSSE } from "hono/streaming"
import { mkdirSync, writeFileSync } from "node:fs"
import { Readable } from "node:stream"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { mountRouter } from "@ntwine/rpc/server"
import { DEFAULT_PORT, ATTACHMENT_MAX_BASE64_CHARS, attachmentExtension, isAllowedAttachmentName, type ServerEvent, ntwineRoute } from "@ntwine/shared"
import { createRouter } from "./router.ts"
import type { AppContext } from "./context.ts"
import { allowedLocalCorsOrigin, isTrustedLocalHttpRequest } from "./local-origin.ts"
import { compress, negotiateEncoding, shouldCompress } from "./compression.ts"
import { withDispatchCaller } from "./dispatch-caller.ts"
import { localImageHeaders, localImageStream, resolveLocalImage } from "./local-image.ts"
import { resolveProjectIconResponse } from "./project-icon.ts"
import { resolveLocalVisualization } from "./local-visualization.ts"
import { workDirOf } from "./project.ts"
import { CALLER_HEADER, requestOriginFrom, withRequestOrigin } from "./audit.ts"
import { LAUNCH_ROUTE_PATH, LAUNCH_ROUTE_PROTOCOL, LAUNCH_TOKEN_HEADER, parseLaunchRouteRequest, routeLaunch } from "./launch-routing.ts"
import { resolveProject } from "./project.ts"
import { ProjectServedElsewhereError, projectServedElsewhere } from "./project-serving.ts"

export { resolveLocalImage } from "./local-image.ts"
export { resolveLocalVisualization } from "./local-visualization.ts"

// The API surface routed to app.fetch: /rpc/* (typed procedures), /events (the single SSE
// board channel), /health. The terminal WebSocket and static/Vite assets are handled by the
// node http server in index.ts, not here.
export interface AppOptions {
  port?: number
  ownerProof?: string
  controlToken?: string
  /**
   * The machine-wide owner's token, when this server runs under the stable launcher. A second
   * `ntwine` typed in any folder holds it (it is in the address record that names this server), where
   * `controlToken` is known only to a launcher that can find the hosting project's own record.
   */
  machineToken?: string
  requestOwnerStop?: () => void
  /** Test seam for the launch route: the project resolver, and the home whose registry it reads. */
  launchRouting?: { open?: (dir: string) => { id: string; dir: string; name: string }; home?: string }
}

export function createApp(ctx: AppContext, options: AppOptions = {}) {
  const app = new Hono()
  const port = options.port ?? DEFAULT_PORT

  // The API is a local control plane, not a public CORS service. Validate Host and require every present
  // Origin to name that SAME canonical loopback hostname + actual port, so an unrelated service on another
  // loopback family cannot borrow Ntwine's browser authority. Reject all forwarded authority (Ntwine does not
  // run behind a trusted proxy) and every non-local/mismatched Origin. Missing Origin is allowed
  // only for the read-only CLI health probe or a browser-forbidden `Sec-Fetch-Site: same-origin` request
  // (same-origin GET/fetch requests may omit Origin). Browser WebSockets use the stricter mandatory
  // same-origin policy in local-origin.ts.
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin")
    const allowMissingOrigin = origin === undefined && (
      (c.req.method === "GET" && c.req.path === ntwineRoute("/health")) ||
      (c.req.method === "POST" && c.req.path === ntwineRoute("/control/stop")) ||
      (c.req.method === "POST" && c.req.path === ntwineRoute(LAUNCH_ROUTE_PATH)) ||
      c.req.header("sec-fetch-site") === "same-origin"
    )
    if (!isTrustedLocalHttpRequest({
      host: c.req.header("host"),
      origin,
      forwarded: c.req.header("forwarded"),
      "x-forwarded-for": c.req.header("x-forwarded-for"),
      "x-forwarded-host": c.req.header("x-forwarded-host"),
      "x-forwarded-port": c.req.header("x-forwarded-port"),
      "x-forwarded-proto": c.req.header("x-forwarded-proto"),
    }, port, allowMissingOrigin)) {
      return c.text("Forbidden", 403)
    }
    await next()
  })

  app.use(
    cors({
      origin: (origin) => allowedLocalCorsOrigin(origin, port),
      // Expose the boot-id header so the client can read it off /rpc responses. Today the web app is
      // same-origin to the API (Vite middleware in dev, static in prod) so this is moot — but if it is
      // ever served cross-origin, without this the browser hides x-ntwine-boot and the RPC restart-detection
      // channel silently dies (SSE frames still carry the id, so detection degrades rather than breaks).
      exposeHeaders: ["x-ntwine-boot"],
    }),
  )

  // Stamp the server boot id on every /rpc response — a second, always-warm channel (besides the SSE
  // board frames) for the client to notice a restart even when the board is quiet but RPCs are flowing.
  // `ntwineRoute`, not a bare "/rpc/*": every route around this one moved under `/_ntwine` and this
  // middleware did not, so it matched nothing and the header was never sent — while the CORS
  // `exposeHeaders` above kept advertising it. Verified absent on the live server before the fix.
  app.use(`${ntwineRoute("/rpc")}/*`, async (c, next) => {
    c.header("x-ntwine-boot", ctx.bootId)
    await next()
  })

  // Whether a `dispatch` came from the board or a worker's `spawn_thread`, read off the request itself so
  // a worker whose shim predates `spawnedFrom` is still checked (dispatch-caller.ts).
  app.use(ntwineRoute("/rpc/dispatch"), (c, next) =>
    withDispatchCaller({ origin: c.req.header("origin"), userAgent: c.req.header("user-agent") }, next))
  // …and whether a deadline change came from the human's drawer: only the human may move a deadline the
  // human set, and a worker's shim is told to use its own verb (router setThreadDeadline).
  app.use(ntwineRoute("/rpc/setThreadDeadline"), (c, next) =>
    withDispatchCaller({ origin: c.req.header("origin"), userAgent: c.req.header("user-agent") }, next))
  app.use(ntwineRoute("/rpc/setRunningDeadlines"), (c, next) =>
    withDispatchCaller({ origin: c.req.header("origin"), userAgent: c.req.header("user-agent") }, next))
  // Attribute every procedure this request runs to whoever sent it, for the audit trail (audit.ts). An
  // AsyncLocalStorage rather than a handler argument: procedures receive only `{ input }`, and only a
  // handful of them record anything. The launcher's proxy says who called in CALLER_HEADER; a request
  // without one reached this server directly, and `remoteAddress` is that caller (see pipeToApp).
  app.use(`${ntwineRoute("/rpc")}/*`, (c, next) =>
    withRequestOrigin(
      requestOriginFrom({
        caller: c.req.header(CALLER_HEADER),
        userAgent: c.req.header("user-agent"),
        socketRemote: (c.env as { remoteAddress?: string } | undefined)?.remoteAddress,
      }),
      next,
    ),
  )

  // Compress RPC responses. The board payload for a busy project is ~780 KB of JSON and every page
  // load fetches it; the server produces it in ~11 ms and then spends far longer pushing it up a home
  // connection through a tunnel, which is what made a remote board feel slow. Brotli q4 takes it to
  // ~150 KB for ~6 ms of CPU. Scoped to /rpc/* on purpose: the SSE stream must never be buffered by a
  // compressor. See compression.ts for the measurements behind the level choice.
  app.use(`${ntwineRoute("/rpc")}/*`, async (c, next) => {
    await next()
    const encoding = negotiateEncoding(c.req.header("accept-encoding"))
    if (!encoding || !c.res.body) return
    const body = new Uint8Array(await c.res.arrayBuffer())
    if (!shouldCompress(c.res.headers, body.byteLength)) {
      // arrayBuffer() consumed the stream, so the response has to be rebuilt either way.
      c.res = new Response(body, { status: c.res.status, headers: c.res.headers })
      return
    }
    const headers = new Headers(c.res.headers)
    headers.set("content-encoding", encoding)
    headers.set("vary", "Accept-Encoding")
    // The old length describes the uncompressed body and would truncate the response.
    headers.delete("content-length")
    c.res = new Response(compress(body, encoding), { status: c.res.status, headers })
  })

  // Launcher identity probe: a bare `{ok:true}` cannot distinguish two workspace servers that race
  // for a port or a stale lock whose PID was reused. Keep this small and non-secret; all fields are
  // already visible in the board keyframe/client URL.
  app.get(ntwineRoute("/health"), (c) => c.json({
    ok: true as const,
    projectId: ctx.project.id,
    // The folder the project IS — for the Home workspace, its agents' folder rather than the state
    // directory holding its board, matching what registeredTenantHealth answers before it is open.
    projectDir: workDirOf(ctx.project),
    bootId: ctx.bootId,
    ...(options.ownerProof ? { ownerProof: options.ownerProof } : {}),
  }))

  // Cross-platform owner stop channel. The raw capability is never returned by /health; the CLI
  // reads it from the 0600 owner record and health proves only its project-bound SHA-256 digest.
  app.post(ntwineRoute("/control/stop"), (c) => {
    const supplied = c.req.header("x-ntwine-launch-token")
    if (!options.controlToken || !supplied || supplied !== options.controlToken) return c.text("Forbidden", 403)
    if (!options.requestOwnerStop) return c.text("Owner control unavailable", 503)
    const stop = setTimeout(options.requestOwnerStop, 25)
    stop.unref()
    return c.json({ accepted: true as const }, 202)
  })

  // Where a `ntwine` typed in some folder lands (launch-routing.ts). A launcher asks instead of
  // deciding, so the rule about folders changes with a server release. Token-bound like the stop
  // channel, because answering can register the folder as a project: only the OS user who started
  // Ntwine can read either token, and that user's launcher did exactly this itself until now.
  app.post(ntwineRoute(LAUNCH_ROUTE_PATH), async (c) => {
    const supplied = c.req.header(LAUNCH_TOKEN_HEADER)
    const held = [options.controlToken, options.machineToken].filter((token): token is string => !!token)
    if (!supplied || !held.includes(supplied)) return c.text("Forbidden", 403)
    const request = parseLaunchRouteRequest(await c.req.json().catch(() => undefined))
    if ("error" in request) return c.json({ error: request.error }, 400)
    const home = options.launchRouting?.home
    // A project another server has open would not open here either, so the launch lands on the
    // dashboard and its notice names that server, rather than on a board that fails to load.
    const open = options.launchRouting?.open ?? ((dir: string) => {
      const project = resolveProject(dir, home)
      const other = projectServedElsewhere(project.stateDir, project.id)
      if (other !== undefined) throw new ProjectServedElsewhereError(project.name, other)
      return project
    })
    try {
      return c.json({ protocol: LAUNCH_ROUTE_PROTOCOL, ...routeLaunch(request.dir, open, home) })
    } catch (error) {
      // The folder is gone, or cannot be read at all: nothing to classify.
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
    }
  })

  // Pictures AND videos (a ```lightbox gallery plays both), in byte ranges — see local-image.ts.
  app.get(ntwineRoute("/local-image"), (c) => {
    const r = resolveLocalImage(c.req.query("path"), c.req.header("range"))
    if (r.status === 416) return c.body(null, 416, { "content-range": `bytes */${r.size}`, "accept-ranges": "bytes" })
    if (r.status === 400 || r.status === 404) return c.text(String(r.status), r.status)
    // Hono answers a HEAD by running this handler and dropping the body, so open no file for one.
    const stream = c.req.method === "HEAD" ? null : localImageStream(r)
    if (!stream) return c.body(null, r.status, localImageHeaders(r))
    return c.body(Readable.toWeb(stream) as ReadableStream<Uint8Array>, r.status, localImageHeaders(r))
  })

  // MACHINE-SCOPED, not this project's: the rail draws every project on the machine, so it asks for
  // icons by project id and the answer must not depend on which board's app happens to answer. There
  // is no `<slug>` segment in the URL for exactly that reason, which also means it lands here on the
  // launching project's app (splitTenantRequest finds no known slug and falls through).
  //
  // Cached hard on the client — a 404 included. Forty squares is forty requests on a cold load and
  // none at all thereafter, and the icons of a project on this machine do not change under anyone.
  app.get(ntwineRoute("/project-icon"), (c) => {
    const r = resolveProjectIconResponse(c.req.query("id"))
    if (r.status !== 200) return c.text(String(r.status), r.status)
    return c.body(Uint8Array.from(r.body), 200, {
      "content-type": r.contentType,
      "cache-control": "private, max-age=300",
      // An SVG icon is a file out of somebody's repository. It renders through <img>, where scripting
      // is already off; this makes that unconditional rather than a property of how it is embedded.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "x-content-type-options": "nosniff",
    })
  })

  app.get(ntwineRoute("/local-visualization"), (c) => {
    const row = ctx.storage.getSession(c.req.query("slug") ?? "")
    const r = resolveLocalVisualization(ctx.project.dir, row?.session_id, c.req.query("file"))
    if (r.status !== 200) return c.text(String(r.status), r.status)
    return c.html(r.body, 200, {
      "cache-control": "private, no-store",
      "content-security-policy": r.contentSecurityPolicy,
      "x-content-type-options": "nosniff",
    })
  })

  // Attachment intake for drag-and-dropped / pasted / picked files (images AND every document, office,
  // data and archive format in @ntwine/shared ATTACHMENT_EXTENSIONS): the file lands on DISK (outside
  // the repo, under the project's state dir) and the client inserts the returned absolute path into
  // the message text.
  // Workers open it with their Read/file tool; the chat renders images via /local-image and non-image
  // files as an openable chip (both roots include the attachments dir). JSON base64 keeps the route
  // dependency-free. The extension allowlist + the char cap are the only trust gates; the on-disk name
  // is timestamped and stripped of every client path segment.
  app.post(ntwineRoute("/attach"), async (c) => {
    let body: { name?: string; data?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "invalid json" }, 400)
    }
    const name = body.name ?? ""
    if (!isAllowedAttachmentName(name)) return c.json({ error: "unsupported file type" }, 400)
    if (typeof body.data !== "string" || body.data.length > ATTACHMENT_MAX_BASE64_CHARS) return c.json({ error: "bad payload" }, 400)
    const ext = `.${attachmentExtension(name)}` // allowlist-validated, lowercased
    const buf = Buffer.from(body.data, "base64")
    const dir = join(ctx.project.stateDir, "attachments")
    mkdirSync(dir, { recursive: true })
    // Timestamped + random-suffixed, sanitized name — never trust the client's path segments, and never
    // let two same-named files dropped in the same millisecond collide (the second would overwrite the
    // first and the message would carry a duplicate path).
    const base = name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40) || "file"
    const path = join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}-${base}${ext}`)
    writeFileSync(path, buf)
    return c.json({ path })
  })

  // Delta SSE: the first frame is a FULL board keyframe (so a fresh client renders without a round-trip)
  // carrying the seq it corresponds to + the boot id; every subsequent bus event is a per-thread delta
  // (or a notify). A 10s heartbeat keeps the pipe warm.
  //
  // Ordering guarantee: we SUBSCRIBE FIRST and buffer, capture the keyframe, then flush. A publish that
  // fires while we assemble the keyframe (e.g. a cold-start rebuild that itself publishes) is therefore
  // never lost — buffered deltas are all ≤ the keyframe's seq (the keyframe reflects the latest committed
  // state), so the client's dup-guard drops them. Without this, a lost delta would force an immediate
  // resync on connect.
  app.get(ntwineRoute("/events"), (c) =>
    streamSSE(c, async (stream) => {
      let id = 0
      const send = (event: unknown) => stream.writeSSE({ data: JSON.stringify(event), id: String(id++) })

      let flushed = false
      const buffer: ServerEvent[] = []
      const unsubscribe = ctx.bus.subscribe((event) => {
        if (flushed) void send(event).catch(() => {})
        else buffer.push(event)
      })

      try {
        const board = await ctx.board.snapshot()
        await send({ type: "board", board, seq: ctx.board.currentSeq(), bootId: ctx.bootId })
      } catch {
        // board not ready — a buffered/live bus publish will deliver the first delta instead
      }
      flushed = true
      for (const event of buffer) void send(event).catch(() => {})
      buffer.length = 0

      const heartbeat = setInterval(() => void stream.writeSSE({ event: "heartbeat", data: "" }).catch(() => {}), 10000)

      await new Promise<void>((resolve) =>
        stream.onAbort(() => {
          unsubscribe()
          clearInterval(heartbeat)
          resolve()
        }),
      )
    }),
  )

  mountRouter(app, ntwineRoute("/rpc"), createRouter(ctx))
  return app
}
