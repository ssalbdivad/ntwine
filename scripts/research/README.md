# `codex app-server --listen unix://PATH` transport probes

Evidence for whether ntwine's hand-rolled Codex daemon (`backend/codex-app-server-daemon.ts` +
`codex-app-server-host.ts`) can be replaced by the app-server's own unix-socket listener. Run against
codex-cli 0.144.6 on 2026-07-23. Each script spawns its OWN app-server on a temp socket and SIGKILLs
only that pid; none of them touch a live board.

`native-listen-restart.mjs` and `native-listen-detached.mjs` run REAL, BILLED codex turns (tiny ones,
in a throwaway temp cwd). The other two are free.

## What they established

**The listener speaks WebSocket, and a competent client completes the upgrade.** `GET /` over the unix
socket, no subprotocol, no `Origin`, no token — `--ws-auth`/`--ws-token-file` are for non-loopback
listeners and a unix listener needs neither. The one requirement is that the client must NOT offer
`permessage-deflate`: node's `ws` sends `Sec-WebSocket-Extensions: permessage-deflate` by default and
the server's tungstenite rejects it with

    WARN codex_app_server_transport::transport::unix_socket: failed to upgrade control socket
    websocket connection: WebSocket protocol error: Missing, duplicated or incorrect header
    sec-websocket-extensions

`new WebSocket(url, { perMessageDeflate: false })` upgrades cleanly (`101`, `sec-websocket-accept`
present, `tungstenite::handshake::server: Server handshake done.`).

An earlier investigation reported `httparse error: invalid token` and concluded the listener's
WebSocket was broken. That probe connected with a RAW newline-JSON socket client (`net.createConnection`)
and never sent an HTTP upgrade at all — tungstenite was parsing `{"id":1,...` as an HTTP request line.
The listener was never at fault.

**`initialize` is per-CONNECTION, not per-process.** A second and third connection each initialize
successfully and get the real `userAgent`; only a repeat `initialize` on the SAME connection is
rejected (`-32600 Already initialized`). ntwine's daemon caches and replays the handshake because it
multiplexes one process behind one stdio pipe — the native listener needs none of that.

**The process outlives its clients.** Hard-terminating every attached WebSocket leaves the app-server
running with the socket still accepting; a later connection attaches normally.

**A turn survives its originating client's death and the reattached client sees it finish.** A turn
started on connection A, with A hard-killed 6s in, ran to completion; connection C attached mid-turn,
resumed the thread, and received the live stream through `turn/completed` (`status: "completed"`,
`durationMs: 27666`).

**Events are DROPPED, not queued, while nobody is attached — but the two things ntwine's queue exists to
protect are recoverable from authoritative server state, and one of them is actively re-delivered.**

- A turn that completed ENTIRELY while detached replays nothing. But `thread/resume` reports
  `thread.status = {"type":"idle"}` and `thread/turns/list` reports that turn as
  `status: "completed"` with a `completedAt`. Reconciling from that state is strictly more reliable
  than ntwine's queue, which silently overflows past `MAX_QUEUED_LINES`/`MAX_QUEUED_BYTES`.
- A pending approval is RE-ISSUED. With an `item/commandExecution/requestApproval` outstanding, the
  client was killed without answering; `thread/resume` on a new connection reported
  `thread.status = {"type":"active","activeFlags":["waitingOnApproval"]}` and the server re-sent the
  same approval request (same `itemId`, same `startedAtMs`) to the new subscriber.

The one genuine loss is transcript CONTENT emitted during the detached window (`item/*` deltas), which
a migration must backfill from `thread/turns/list` rather than from a replayed stream.
