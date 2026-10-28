// A FAKE NTWINE for the end-to-end run — just enough of the server for the extension to find it, connect
// and call it, on 127.0.0.1 with the real server's origin gates:
//
//   GET  /_ntwine/health                      { ok, bootId }
//   /_ntwine/<projectId>/rpc/<proc>           dispatchPreferencesGet, dispatch, board, followUp, reviewTarget
//   WS   /_ntwine/editor                      hello → welcome (naming every editor feature, as the real one does)
//                                            + projects; compose → composed; results, editor and features
//                                            frames recorded
//   GET  /                                   a fake PAGE that speaks the sidebar's embed contract
//                                            (embed-protocol.ts): says ntwine:ready, answers ntwine:compose
//
// plus a control surface for the suite running inside VS Code, which cannot reach this process any
// other way:
//
//   GET  /__e2e/log                          every frame and RPC call received so far, and any refused
//   POST /__e2e/open      {path, line?, …}   send `open` to the newest editor socket; answers its `result`
//   POST /__e2e/focus     {path}             send `focus` the same way
//   POST /__e2e/review    {title, checkouts} send `review` the same way (a browser tab's Review changes)
//   POST /__e2e/review-target {target}       what `reviewTarget` answers (the sidebar's Review changes)
//   POST /__e2e/projects  {projects}         push a `projects` frame
//   POST /__e2e/drop                         close the editor socket (1001), as a restart would
//   POST /__e2e/page-post {message, page?}   have the page post `message` to its parent (the sidebar), or
//                                            the page at path `page` (a thread's editor tab, framing
//                                            `/all/<project>/thread/<slug>`); every received entry says
//                                            which page heard it
//   POST /__e2e/page-answer {answer}         how the page answers a compose: "ok", "refuse" or "silent"
//   POST /__e2e/press     {chord}            press a key chord in the editor's window as a keyboard does
//                                            (the harness's Workbench, over the Chrome DevTools Protocol)
//   POST /__e2e/workbench {expression}       evaluate an expression in the workbench page — what the
//                                            title row shows
//   POST /__e2e/click     {selector}         click an element of the workbench with a real mouse
//   POST /__e2e/shot      {path}             save a screenshot of the whole workbench to `path`
//   POST /__e2e/features  {features, ready}  what the next welcome names, and whether the page says it is
//                                            ready — `[]` and false is an ntwine from before the sidebar
//
// and two the fake page itself calls: POST /__e2e/page-event (what it received, recorded in `page`) and
// GET /__e2e/page-next (the messages it was told to post).
//
// It is a stand-in for the seams the extension touches, not for the server: the REAL mode of
// scripts/e2e.ts runs the same suite against a real ntwine. What it does take from the server is the
// judgement of a frame — the server's own schema and ceilings — so a frame ntwine would refuse is
// refused here too (closed 4401) and listed in `refused`.

import { randomUUID } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { WebSocket, WebSocketServer } from "ws"
import { EditorClientMessageSchema } from "@ntwine/shared"
import { writeFileSync } from "node:fs"
import { EDITOR_CLOSE, EDITOR_FEATURES, type EditorClientMessage, type EditorProject, type EditorReviewTarget, type EditorServerMessage } from "@ntwine/shared/editor-protocol"
import { EDITOR_MAX_FRAME_BYTES, EDITOR_MAX_PAYLOAD_BYTES } from "../../server/src/editor-bridge.ts"

export const FAKE_THREAD = {
  id: "fake-thread",
  sessionId: "fake-session",
  title: "Fake thread",
  titleAuto: false,
  kind: "session",
  state: "open",
  needsYou: true,
  runtime: "turn-idle",
  statusLine: "Waiting on you",
}

export const FAKE_PREFERENCES = { backend: "claude", claude: { model: "sonnet", effort: "low" }, codex: {} }

export interface FakeLog {
  frames: EditorClientMessage[]
  /** Frames the real server would have refused, and why. */
  refused: string[]
  rpc: { projectId: string; procedure: string; input: unknown }[]
  origins: (string | undefined)[]
  /** The fake page: every load of it (the request's path and query), and every message it received from its parent. */
  page: { loads: string[]; received: { origin: string; data: unknown; page?: string }[] }
}

/**
 * The fake page. It does what the real page's embed mode promises and nothing else: says it is ready,
 * answers each compose as the control surface says, and posts whatever the suite queues — so the suite
 * can drive the extension's side of the wire inside a real VS Code. It records what reached it at its
 * own origin, which is the proof the relay posted it there.
 */
const FAKE_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Fake ntwine</title></head>
<body><p>Fake ntwine page</p>
<script>
  const event = (body) => fetch("/__e2e/page-event", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, page: location.pathname }) }).then((r) => r.json())
  window.addEventListener("message", async (message) => {
    if (message.source !== window.parent) return
    const data = message.data
    const { answer } = await event({ origin: message.origin, data })
    if (data && data.type === "ntwine:compose" && answer !== "silent") {
      parent.postMessage({ type: "ntwine:composed", id: data.id, ok: answer === "ok", ...(answer === "ok" ? {} : { error: "The fake page refused it." }) }, "*")
    }
  })
  if (!document.body.dataset.mute) parent.postMessage({ type: "ntwine:ready", v: 1 }, "*")
  ;(async () => {
    for (;;) {
      try {
        const { messages } = await (await fetch("/__e2e/page-next?page=" + encodeURIComponent(location.pathname))).json()
        for (const message of messages) parent.postMessage(message, "*")
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  })()
</script>
</body></html>`

/** The editor's window as the harness reaches it (e2e/cdp.ts), for the controls a suite inside it cannot do itself. */
export interface WorkbenchControl {
  press(chord: string): Promise<void>
  evaluate(expression: string): Promise<unknown>
  click(selector: string): Promise<boolean>
  /** The whole workbench as a PNG. */
  shot(): Promise<Buffer>
}

export class FakeNtwine {
  /** Set by the harness once the editor is launched with a debugging port. */
  workbench: WorkbenchControl | undefined
  readonly log: FakeLog = { frames: [], refused: [], rpc: [], origins: [], page: { loads: [], received: [] } }
  #pageOutbox: { message: unknown; page: string }[] = []
  #pageAnswer: "ok" | "refuse" | "silent" = "ok"
  #reviewTarget: EditorReviewTarget = { title: "Fake thread", checkouts: [] }
  #features: string[] = Object.values(EDITOR_FEATURES)
  #pageReady = true
  readonly #server: Server
  readonly #wss = new WebSocketServer({ noServer: true, maxPayload: EDITOR_MAX_PAYLOAD_BYTES })
  readonly #sockets: WebSocket[] = []
  readonly #results = new Map<string, (result: unknown) => void>()
  readonly #heartbeat: NodeJS.Timeout
  port = 0
  readonly projects: EditorProject[]

  constructor(projects: EditorProject[]) {
    this.projects = projects
    this.#server = createServer((request, response) => void this.#http(request, response))
    this.#server.on("upgrade", (request, socket, head) => {
      if (request.url !== "/_ntwine/editor" || request.headers.origin !== this.origin) {
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n")
        return
      }
      this.log.origins.push(request.headers.origin)
      this.#wss.handleUpgrade(request, socket, head, (ws) => this.#accept(ws))
    })
    this.#heartbeat = setInterval(() => this.#broadcast({ t: "hb" }), 15_000)
  }

  async listen(): Promise<this> {
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve))
    this.port = (this.#server.address() as AddressInfo).port
    return this
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`
  }

  async close(): Promise<void> {
    clearInterval(this.#heartbeat)
    for (const ws of this.#sockets) ws.terminate()
    this.#wss.close()
    this.#server.closeAllConnections()
    await new Promise((resolve) => this.#server.close(resolve))
  }

  #send(ws: WebSocket, message: EditorServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
  }

  #broadcast(message: EditorServerMessage): void {
    for (const ws of this.#sockets) this.#send(ws, message)
  }

  #accept(ws: WebSocket): void {
    this.#sockets.push(ws)
    ws.on("close", (code) => {
      this.#sockets.splice(this.#sockets.indexOf(ws), 1)
      if (code === 1009) this.log.refused.push("a frame past the socket's ceiling (1009)")
    })
    ws.on("message", (data) => {
      const text = data.toString()
      const decoded = JSON.parse(text) as { t?: unknown }
      const parsed = EditorClientMessageSchema.safeParse(decoded)
      const oversize = decoded.t !== "compose" && Buffer.byteLength(text, "utf8") > EDITOR_MAX_FRAME_BYTES
      if (!parsed.success || oversize) {
        this.log.refused.push(`${String(decoded.t)}: ${oversize ? "frame too large" : parsed.error?.message}`)
        ws.close(EDITOR_CLOSE.invalidMessage, "invalid frame")
        return
      }
      const frame = decoded as EditorClientMessage
      this.log.frames.push(frame)
      if (frame.t === "hello") {
        this.#send(ws, { t: "welcome", v: 1, bootId: "fake-boot", features: [...this.#features] })
        this.#send(ws, { t: "projects", projects: this.projects })
      } else if (frame.t === "compose") {
        this.#send(ws, { t: "composed", id: frame.id, ok: true })
      } else if (frame.t === "result") {
        this.#results.get(frame.id)?.(frame)
        this.#results.delete(frame.id)
      }
    })
  }

  async #http(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.origin)
    const body = await new Promise<string>((resolve) => {
      let text = ""
      request.on("data", (chunk) => (text += chunk))
      request.on("end", () => resolve(text))
    })
    const json = (status: number, value: unknown) => {
      response.statusCode = status
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify(value))
    }

    if (url.pathname === "/_ntwine/health") return json(200, { ok: true, bootId: "fake-boot" })

    if (url.pathname.startsWith("/__e2e/")) {
      const input = body ? JSON.parse(body) : {}
      switch (url.pathname) {
        case "/__e2e/log":
          return json(200, this.log)
        case "/__e2e/projects":
          this.projects.splice(0, this.projects.length, ...(input.projects as EditorProject[]))
          this.#broadcast({ t: "projects", projects: this.projects })
          return json(200, { ok: true })
        case "/__e2e/drop":
          for (const ws of [...this.#sockets]) ws.close(1001, "restarting")
          return json(200, { ok: true })
        case "/__e2e/page-post":
          this.#pageOutbox.push({ message: input.message, page: typeof input.page === "string" ? input.page : "/" })
          return json(200, { ok: true })
        case "/__e2e/page-answer":
          this.#pageAnswer = input.answer
          return json(200, { ok: true })
        case "/__e2e/review-target":
          this.#reviewTarget = input.target as EditorReviewTarget
          return json(200, { ok: true })
        case "/__e2e/features":
          this.#features = input.features as string[]
          this.#pageReady = input.ready !== false
          return json(200, { ok: true })
        case "/__e2e/press":
        case "/__e2e/click":
        case "/__e2e/shot":
        case "/__e2e/workbench": {
          if (!this.workbench) return json(409, { error: "no workbench: the harness launched the editor without a debugging port" })
          try {
            if (url.pathname === "/__e2e/shot") {
              writeFileSync(String(input.path), await this.workbench.shot())
              return json(200, { ok: true })
            }
            if (url.pathname === "/__e2e/press") {
              await this.workbench.press(String(input.chord))
              return json(200, { ok: true })
            }
            if (url.pathname === "/__e2e/click") return json(200, { clicked: await this.workbench.click(String(input.selector)) })
            return json(200, { value: await this.workbench.evaluate(String(input.expression)) })
          } catch (error) {
            return json(500, { error: (error as Error).message })
          }
        }
        case "/__e2e/page-event":
          this.log.page.received.push(input)
          return json(200, { answer: this.#pageAnswer })
        case "/__e2e/page-next": {
          const page = url.searchParams.get("page") ?? "/"
          const messages = this.#pageOutbox.filter((entry) => entry.page === page).map((entry) => entry.message)
          this.#pageOutbox = this.#pageOutbox.filter((entry) => entry.page !== page)
          return json(200, { messages })
        }
        case "/__e2e/open":
        case "/__e2e/focus":
        case "/__e2e/review": {
          const ws = this.#sockets.at(-1)
          if (!ws) return json(409, { error: "no editor connected" })
          const id = randomUUID()
          const result = new Promise((resolve) => this.#results.set(id, resolve))
          this.#send(ws, url.pathname === "/__e2e/open" ? { t: "open", id, ...input } : url.pathname === "/__e2e/focus" ? { t: "focus", id, path: input.path } : { t: "review", id, title: input.title, checkouts: input.checkouts })
          const answer = await Promise.race([result, new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 20_000))])
          return json(200, answer)
        }
      }
      return json(404, { error: "unknown control" })
    }

    // The page at `/` (the sidebar's) and at a thread's own address (a thread's editor tab frames it).
    if (request.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/all/"))) {
      this.log.page.loads.push(`${url.pathname}${url.search}`)
      response.setHeader("content-type", "text/html; charset=utf-8")
      response.end(this.#pageReady ? FAKE_PAGE : FAKE_PAGE.replace("<body>", '<body data-mute="1">'))
      return
    }

    // The real server's gate (app.ts): no Origin is admitted only with sec-fetch-site: same-origin.
    if (request.headers["sec-fetch-site"] !== "same-origin" && request.headers.origin !== this.origin) {
      response.statusCode = 403
      response.end("Forbidden")
      return
    }
    const rpc = /^\/_ntwine\/([^/]+)\/rpc\/([A-Za-z]+)$/.exec(url.pathname)
    if (!rpc) {
      response.statusCode = 404
      response.end("Not Found")
      return
    }
    const projectId = decodeURIComponent(rpc[1]!)
    const procedure = rpc[2]!
    const input = request.method === "GET" ? (url.searchParams.has("input") ? JSON.parse(url.searchParams.get("input")!) : undefined) : body ? JSON.parse(body) : undefined
    this.log.rpc.push({ projectId, procedure, input })
    if (!this.projects.some((project) => project.id === projectId)) return json(404, { error: `no project ${projectId}` })
    switch (procedure) {
      case "dispatchPreferencesGet":
        return json(200, { result: FAKE_PREFERENCES })
      case "dispatch":
        return json(200, { result: { slug: "asked-thread", sessionId: "asked-session" } })
      case "board":
        return json(200, { result: { projectDir: this.projects[0]?.dir, projectName: "fake", threads: [FAKE_THREAD] } })
      case "followUp":
        return json(200, { result: null })
      case "reviewTarget":
        return json(200, { result: { ...this.#reviewTarget, ...(input?.title ? { title: input.title } : {}) } })
    }
    return json(404, { error: `unknown RPC procedure \`${procedure}\`` })
  }
}
