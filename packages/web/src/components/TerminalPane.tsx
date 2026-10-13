import { useEffect, useRef, useState, type ReactNode } from "react"
import type { Terminal } from "@xterm/xterm"
import type { TermClientMsg } from "@ntwine/shared"
import { queuedTerminalInputBytes, terminalCloseKind, terminalExitCode, terminalReconnectDelay } from "../lib/terminalConnection.ts"
import { apiBase } from "../lib/base-path.ts"
import { mountXterm } from "../lib/xtermSetup.ts"

// One xterm + WebSocket per thread terminal. Remounts on id change (keyed by the parent, on the run
// too), so mount = attach and unmount = detach. The pty is owned by the server (thread-terminals.ts)
// and shared across viewers — a ws close releases only THIS viewer's hold — so reattach cheaply
// replays the buffered screen state.
//
// RENDERER: the built-in DOM renderer, NOT @xterm/addon-webgl. The WebGL addon desynced its
// canvas backing store from xterm's dpr-scaled cell geometry whenever the effective
// devicePixelRatio wasn't the integer it captured at load (a non-100% browser zoom, or the
// window dragged between a Retina panel and an external 1× monitor): the backing store stayed at
// 2× while the render service computed geometry at 1×, so — WebGL's origin being bottom-left —
// every row got packed into the bottom-left quarter at half scale, leaving the top of the pane
// blank. That was the "terminal never worked" bug: the WS attaches, the bytes stream, and the
// xterm BUFFER is fully correct (proven), but the WebGL layer paints it into a quarter of the
// canvas. The DOM renderer positions rows with plain CSS and renders correctly at every dpr. It
// also drops the WebGL addon's teardown crash (its dispose reached back into an already-disposed
// render service and took the whole React tree down on a Terminal→Chat tab switch). For an
// agent's TUI the DOM renderer's throughput is more than enough; revisit WebGL only with an
// explicit devicePixelRatio-resync if profiling ever demands it.
//
// `exitedStatus` replaces the exited status line. A thread terminal passes one: its process finishing is
// the whole story (with a code worth showing), and "Resume" — which focuses an agent's composer — has
// nothing to resume there.
//
// `focusOnMount: false` leaves focus where it is: a finished run has nothing to type into (the terminal
// drawer focuses its follow-up line instead), and a queue card is one of many on the page.
//
// `base` names the project whose pty this is. It defaults to the page's (`apiBase()`), which is right in
// a terminal's own drawer; a queue card on the cross-project page draws another project's terminal and
// passes that project's, since the page's base there names the FOCUSED project's terminal server.
export function TerminalPane({ id, exitedStatus, base, focusOnMount = true }: { id: string; exitedStatus?: (exitCode: number | null) => ReactNode; base?: string; focusOnMount?: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const [connection, setConnection] = useState<"connecting" | "open" | "reconnecting" | "exited">("connecting")
  const [exitCode, setExitCode] = useState<number | null>(null)
  const [inputOverflow, setInputOverflow] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    // The xterm itself — font, theme and its live recolour, the fit, the degenerate-host guard and the
    // resize observer — is built by lib/xtermSetup.ts, shared with the agent-terminal log pane. What is
    // HERE is the pty: the socket, input, reconnects. A grid change is sent to the pty as a resize.
    const mounted = mountXterm(host, {}, (cols, rows) => {
      send({ t: "resize", cols, rows })
    })
    const term = mounted.term
    termRef.current = term
    // Mounting TerminalPane is explicit user intent (or a persisted explicit choice after a server
    // reload). Focus immediately; input typed before the socket opens is queued below, never dropped.
    if (focusOnMount) term.focus()

    const proto = location.protocol === "https:" ? "wss" : "ws"
    const url = `${proto}://${location.host}${base ?? apiBase()}/term/${id}`
    let ws: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    let pageSuspended = false
    let connectedOnce = false
    let terminalExited = false
    let failures = 0
    const pendingInput: string[] = []
    let pendingInputBytes = 0

    const send = (m: TermClientMsg): boolean => {
      if (ws?.readyState !== WebSocket.OPEN) return false
      try {
        ws.send(JSON.stringify(m))
        return true
      } catch {
        return false
      }
    }

    const flushInput = () => {
      while (pendingInput.length > 0) {
        const d = pendingInput[0]
        if (!send({ t: "input", d })) return
        pendingInput.shift()
        pendingInputBytes -= new TextEncoder().encode(d).byteLength
      }
    }

    const connect = () => {
      if (disposed || pageSuspended || ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return
      clearTimeout(reconnectTimer)
      reconnectTimer = undefined
      setConnection(connectedOnce ? "reconnecting" : "connecting")
      const sock = new WebSocket(url)
      ws = sock
      sock.binaryType = "arraybuffer"

      sock.onopen = () => {
        if (disposed || ws !== sock) return
        connectedOnce = true
        // Attached — say so now, not on the first byte. A command that prints nothing (`sleep 600`) sent
        // no message, so its drawer read "Connecting to terminal…" for as long as it ran. A socket the
        // server closes straight after opening goes to "reconnecting" through onclose as before; the
        // backoff still resets only on real traffic (onmessage), so such a socket cannot spin.
        setConnection("open")
        send({ t: "resize", cols: term.cols, rows: term.rows })
        flushInput()
      }
      sock.onmessage = (e) => {
        if (disposed || ws !== sock) return
        failures = 0
        setConnection("open")
        if (typeof e.data === "string") term.write(e.data)
        else term.write(new Uint8Array(e.data as ArrayBuffer))
      }
      sock.onerror = () => {} // close owns recovery
      sock.onclose = (event) => {
        if (disposed || ws !== sock) return
        ws = null
        if (terminalCloseKind(event.code, event.reason) === "exited") {
          terminalExited = true
          // Nothing is reading keystrokes any more, so a cursor block under the last line only says
          // otherwise (DECTCEM hide; a restart mounts a fresh pane with its own cursor).
          term.write("\x1b[?25l")
          setExitCode(terminalExitCode(event.reason))
          setConnection("exited")
          return
        }
        failures++
        setConnection(connectedOnce ? "reconnecting" : "connecting")
        reconnectTimer = setTimeout(connect, terminalReconnectDelay(failures))
      }
    }

    connect()

    const dataSub = term.onData((d) => {
      if (send({ t: "input", d })) return
      const nextBytes = queuedTerminalInputBytes(pendingInputBytes, d)
      if (nextBytes === null) {
        setInputOverflow(true)
        return
      }
      pendingInput.push(d)
      pendingInputBytes = nextBytes
    })

    // Browser/app chords must not steal native TUI keys. Copy remains native only when xterm has a
    // selection; paste uses the browser's paste event so bracketed/multiline paste reaches xterm.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true
      const key = event.key.toLowerCase()
      if ((event.metaKey || (event.ctrlKey && event.shiftKey)) && key === "v") return false
      if ((event.metaKey || event.ctrlKey) && key === "c" && term.hasSelection()) return false
      return true
    })

    const reconnectNow = () => {
      if (disposed || pageSuspended || terminalExited) return
      if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return
      clearTimeout(reconnectTimer)
      reconnectTimer = undefined
      connect()
    }
    window.addEventListener("online", reconnectNow)
    window.addEventListener("focus", reconnectNow)
    const onVisibility = () => {
      if (!document.hidden) reconnectNow()
    }
    document.addEventListener("visibilitychange", onVisibility)
    // React cleanup is not guaranteed during a hard navigation or BFCache transition. Close the
    // attach on pagehide so Cmd-R / direct navigation cannot strand a live viewer socket; pages restored
    // from BFCache reconnect through the same path without losing the xterm buffer or pending input.
    const onPageHide = () => {
      pageSuspended = true
      clearTimeout(reconnectTimer)
      reconnectTimer = undefined
      const sock = ws
      ws = null
      if (!sock) return
      sock.onopen = null
      sock.onmessage = null
      sock.onerror = null
      sock.onclose = null
      sock.close()
    }
    const onPageShow = () => {
      pageSuspended = false
      reconnectNow()
    }
    window.addEventListener("pagehide", onPageHide)
    window.addEventListener("pageshow", onPageShow)

    return () => {
      clearTimeout(reconnectTimer)
      disposed = true
      window.removeEventListener("online", reconnectNow)
      window.removeEventListener("focus", reconnectNow)
      window.removeEventListener("pagehide", onPageHide)
      window.removeEventListener("pageshow", onPageShow)
      document.removeEventListener("visibilitychange", onVisibility)
      dataSub.dispose()
      if (ws) {
        ws.onopen = null
        ws.onmessage = null
        ws.onerror = null
        ws.onclose = null
        ws.close()
      }
      // The observer, the theme subscription, and the terminal — deferred one task (lib/xtermSetup.ts).
      mounted.dispose()
    }
  }, [id, base])

  return (
    <div className="relative flex-1 min-h-0 bg-bg">
      <div ref={hostRef} className="absolute inset-0 p-2" />
      {connection === "exited" && !inputOverflow && exitedStatus ? (
        // An exitedStatus that renders nothing asks for NO bar (the terminal's own header states the
        // outcome), not for the generic "Session exited" one below.
        exitedNode(exitedStatus(exitCode))
      ) : (connection !== "open" || inputOverflow) && (
        <div role="status" aria-live="polite" className="absolute bottom-0 inset-x-0 flex items-center justify-between px-3 py-1.5 bg-panel border-t border-border text-xs">
          <span className="text-muted">
            {inputOverflow
              ? "Offline input limit reached — additional input was not sent."
              : connection === "connecting"
                ? "Connecting to terminal…"
                : connection === "reconnecting"
                  ? "Terminal disconnected — reconnecting…"
                  : "Session exited."}
          </span>
          {connection === "exited" && (
            <button
              className="text-fg hover:underline"
              onClick={() => document.getElementById("followup-input")?.focus()}
            >
              Resume →
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function exitedNode(content: ReactNode): ReactNode {
  if (content == null) return null
  return (
    <div role="status" aria-live="polite" className="absolute bottom-0 inset-x-0 flex items-center justify-between px-3 py-1.5 bg-panel border-t border-border text-xs">
      {content}
    </div>
  )
}
