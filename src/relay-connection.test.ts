import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { generateClaimIdentity, parseFrame, RELAY_KEEPALIVE_PING, serializeFrame } from "@ntwine/shared";
import { connectRelay, defaultBackoff, signRelayHandshake, type RelaySocket } from "./relay-connection.ts";

/** A socket a test drives by hand: it records what was sent and fires events on demand. */
function fakeSocket() {
  const listeners: Record<string, Array<(e?: unknown) => void>> = {};
  const sent: string[] = [];
  let closed = false;
  const socket: RelaySocket = {
    send: (d) => void sent.push(d),
    close: () => { closed = true; },
    addEventListener: (type: string, listener: (e?: unknown) => void) => {
      (listeners[type] ??= []).push(listener);
    },
  } as RelaySocket;
  return {
    socket, sent,
    get closed() { return closed; },
    fire(type: string, event?: unknown) { for (const l of listeners[type] ?? []) l(event); },
  };
}

function harness(overrides: Partial<Parameters<typeof connectRelay>[0]> = {}) {
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const urls: string[] = [];
  const timers: Array<() => void> = [];
  const status: string[] = [];
  return {
    sockets, urls, timers, status,
    async start(identity: CryptoKeyPair) {
      const conn = connectRelay({
        name: "ada",
        identity,
        relayOrigin: "https://ntwine.app",
        boardOrigin: "http://127.0.0.1:1",
        publicOrigin: "https://ada.ntwine.app",
        socketFactory: (url) => { urls.push(url); const s = fakeSocket(); sockets.push(s); return s.socket; },
        onStatus: (s, d) => void status.push(d ? `${s}:${d}` : s),
        setTimer: (fn) => { timers.push(fn); return timers.length; },
        clearTimer: () => {},
        backoff: () => 1,
        ...overrides,
      });
      // connectRelay signs asynchronously before the socket exists. Ed25519 keygen and signing are
      // real work, so a fixed number of microtask ticks is not enough under a loaded runner — wait on
      // the condition against a clock instead, or the socket is simply missing and the test reads as a
      // bug in the connection loop.
      const deadline = Date.now() + 5_000;
      while (sockets.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1));
      if (sockets.length === 0) throw new Error("connectRelay never opened a socket");
      return conn;
    },
    /**
     * The nth socket, waited for rather than assumed — the same rule as `start` above, and for the
     * same reason: a retry timer calls `open()`, which SIGNS before it builds a socket, so the new
     * socket is a signature away rather than a tick away.
     *
     * A bare `setTimeout(1)` between retries is what made the backoff test flaky (~1 run in 3). On a
     * loaded runner the next socket had not appeared yet, so the test fired open/close at the socket it
     * had ALREADY replaced: `dropped()` returns early for a stale socket, so nothing scheduled a retry,
     * and the following `timers.pop()` ran that iteration's SETTLE timer instead — which resets the
     * counter. It read as "the backoff never climbed: [0,1,0]", i.e. as a bug in the code under test.
     */
    async socketAt(index: number) {
      const deadline = Date.now() + 5_000;
      while (sockets.length <= index && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1));
      const socket = sockets[index];
      if (!socket) throw new Error(`socket ${index} never opened`);
      return socket;
    },
  };
}

test("the board dials out carrying a signed handshake in the URL", async () => {
  // In the URL rather than a first message, so the relay can judge it BEFORE upgrading — an unproven
  // socket then never occupies the name's Durable Object.
  const identity = await generateClaimIdentity();
  const h = harness();
  const conn = await h.start(identity);
  try {
    assert.equal(h.urls.length, 1);
    const url = new URL(h.urls[0]!);
    assert.equal(url.protocol, "wss:");
    assert.equal(url.pathname, "/_relay/connect");
    const raw = url.searchParams.get("h")!;
    const decoded = JSON.parse(atob(raw.replace(/-/g, "+").replace(/_/g, "/"))) as { name: string; sig: string };
    assert.equal(decoded.name, "ada");
    assert.ok(decoded.sig.length > 0);
  } finally { conn.stop(); }
});

test("a ping is answered, so a dead board is noticed rather than assumed live", async () => {
  const identity = await generateClaimIdentity();
  const h = harness();
  const conn = await h.start(identity);
  try {
    h.sockets[0]!.fire("open");
    h.sockets[0]!.fire("message", { data: serializeFrame({ t: "ping", id: "p1" }) });
    const reply = parseFrame(h.sockets[0]!.sent[0]!);
    assert.deepEqual(reply, { t: "pong", id: "p1" });
  } finally { conn.stop(); }
});

test("a dropped connection comes back by itself", async () => {
  // A laptop sleeps, changes network and loses Wi-Fi constantly. A relay connection that did not
  // return on its own would mean a board permanently unreachable after the first suspend.
  const identity = await generateClaimIdentity();
  const h = harness();
  const conn = await h.start(identity);
  try {
    h.sockets[0]!.fire("open");
    h.sockets[0]!.fire("close");
    assert.ok(h.status.some((s) => s.startsWith("disconnected")));
    assert.ok(h.status.some((s) => s.startsWith("retrying")));
    // Three timers are armed by now: the keepalive beat and the settle timer that `open` schedules
    // (the settle is what resets the backoff only once a connection has LASTED), then the retry.
    // The retry is the latest of the three.
    assert.equal(h.timers.length, 3, "the keepalive, the settle timer and the retry were not all scheduled");

    h.timers[h.timers.length - 1]!();
    for (let i = 0; i < 50 && h.sockets.length < 2; i++) await new Promise((r) => setImmediate(r));
    assert.equal(h.sockets.length, 2, "it did not dial again");
  } finally { conn.stop(); }
});

test("stop() ends it for good — no reconnect after a deliberate shutdown", async () => {
  const identity = await generateClaimIdentity();
  const h = harness();
  const conn = await h.start(identity);
  conn.stop();
  h.sockets[0]!.fire("close");
  assert.equal(h.timers.length, 0, "a stopped connection scheduled a retry");
  assert.equal(h.sockets[0]!.closed, true);
});

test("a socket that was already replaced cannot tear down the live one", async () => {
  const identity = await generateClaimIdentity();
  const h = harness();
  const conn = await h.start(identity);
  try {
    h.sockets[0]!.fire("close");
    h.timers[0]!();
    for (let i = 0; i < 50 && h.sockets.length < 2; i++) await new Promise((r) => setImmediate(r));
    const retriesBefore = h.timers.length;
    h.sockets[0]!.fire("close"); // the stale socket, closing late
    assert.equal(h.timers.length, retriesBefore, "a stale close scheduled another retry");
  } finally { conn.stop(); }
});

test("backoff climbs, stops climbing, and is jittered", () => {
  // Jitter matters more than the curve: a relay restart disconnects every board in the same instant,
  // and without it they would all come back in the same instant too.
  assert.ok(defaultBackoff(0, () => 0) < defaultBackoff(3, () => 0));
  assert.equal(defaultBackoff(6, () => 0), defaultBackoff(20, () => 0), "it must stop climbing");
  assert.ok(defaultBackoff(20, () => 0) <= 30_000);
  assert.notEqual(defaultBackoff(4, () => 0), defaultBackoff(4, () => 0.99), "no jitter applied");
});

test("the handshake is signed over name, key and time together", async () => {
  const identity = await generateClaimIdentity();
  const a = await signRelayHandshake("ada", identity, 1000);
  const b = await signRelayHandshake("ada", identity, 1001);
  const c = await signRelayHandshake("eve", identity, 1000);
  assert.notEqual(a.sig, b.sig, "the timestamp is not covered");
  assert.notEqual(a.sig, c.sig, "the name is not covered");
});

test("a socket that opens and is dropped at once still backs off", async () => {
  // MEASURED AGAINST THE LIVE RELAY, 2026-08-26: the board reconnected roughly twice a second,
  // forever, because every attempt reached "open" before dying and the counter reset there. A board
  // that cannot STAY connected has to back off like one that cannot connect at all.
  const identity = await generateClaimIdentity();
  const delays: number[] = [];
  const h = harness({ backoff: (attempt) => { delays.push(attempt); return 1; } });
  const conn = await h.start(identity);
  try {
    for (let i = 0; i < 4; i++) {
      const socket = await h.socketAt(i);
      socket.fire("open");
      socket.fire("close");
      // Run the reconnect timer, but never the settle timer — the connection never lasted.
      h.timers.pop()?.();
    }
    assert.deepEqual(delays, [0, 1, 2, 3], `the backoff never climbed: ${JSON.stringify(delays)}`);
  } finally { conn.stop(); }
});

test("a connection that HOLDS resets the backoff, so a long-lived board starts fresh next time", async () => {
  const identity = await generateClaimIdentity();
  const delays: number[] = [];
  const h = harness({ backoff: (attempt) => { delays.push(attempt); return 1; } });
  const conn = await h.start(identity);
  try {
    const first = await h.socketAt(0);
    first.fire("open");
    first.fire("close");
    h.timers.pop()?.();

    // This one stays up: fire the settle timer before it drops.
    const second = await h.socketAt(1);
    second.fire("open");
    const settle = h.timers.pop();
    settle?.();
    second.fire("close");
    h.timers.pop()?.();
    assert.deepEqual(delays, [0, 0], `a connection that lasted did not reset the backoff: ${JSON.stringify(delays)}`);
  } finally { conn.stop(); }
});

test("the board beats a keepalive in the relay's exact auto-response bytes", async () => {
  const identity = await generateClaimIdentity();
  const h = harness();
  const conn = await h.start(identity);
  try {
    h.sockets[0]!.fire("open");
    // The keepalive is the FIRST timer `open` arms; the settle timer follows it.
    h.timers[h.timers.length - 2]!();
    assert.equal(h.sockets[0]!.sent[0], RELAY_KEEPALIVE_PING,
      "the ping must be the exact bytes the relay's auto-response matches, or every beat wakes the Durable Object");
  } finally { conn.stop(); }
});

test("a socket that stops answering pings is treated as dead, not believed forever", async () => {
  // A slept laptop or a changed network kills the TCP without a FIN. Nothing ever arrives to say so —
  // the beat going unanswered is the only signal there is, and before it existed a half-dead socket
  // lingered for hours while every visitor timed out.
  const identity = await generateClaimIdentity();
  const h = harness();
  const conn = await h.start(identity);
  try {
    h.sockets[0]!.fire("open");
    const beat = h.timers[h.timers.length - 2]!;
    beat(); // sends the ping, arms the next beat
    h.timers[h.timers.length - 1]!(); // no pong arrived in a whole interval
    assert.ok(h.status.some((s) => s.startsWith("disconnected")), "a silent socket was not dropped");
    assert.ok(h.status.some((s) => s.startsWith("retrying")), "no reconnect was scheduled");
    assert.equal(h.sockets[0]!.closed, true);
  } finally { conn.stop(); }
});

test("a pong keeps the connection alive: the next beat pings again instead of dropping", async () => {
  const identity = await generateClaimIdentity();
  const h = harness();
  const conn = await h.start(identity);
  try {
    h.sockets[0]!.fire("open");
    const first = h.timers[h.timers.length - 2]!;
    first();
    h.sockets[0]!.fire("message", { data: serializeFrame({ t: "pong", id: "keepalive" }) });
    h.timers[h.timers.length - 1]!(); // the next beat
    assert.ok(!h.status.some((s) => s.startsWith("disconnected")), "an answered ping was treated as a miss");
    assert.equal(h.sockets[0]!.sent.filter((m) => m === RELAY_KEEPALIVE_PING).length, 2);
  } finally { conn.stop(); }
});

test("req-cancel aborts the request the relay named, and only that one", async () => {
  // Driven with a REAL local server: the request must actually die at the socket level, or the SSE
  // feed keeps producing chunks that ride up the relay socket and wake the Durable Object each time.
  const closes: string[] = [];
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${req.url}\n\n`);
    req.on("close", () => void closes.push(req.url ?? ""));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };

  const identity = await generateClaimIdentity();
  const h = harness({ boardOrigin: `http://127.0.0.1:${port}` });
  const conn = await h.start(identity);
  try {
    h.sockets[0]!.fire("open");
    h.sockets[0]!.fire("message", { data: serializeFrame({ t: "req", id: "keep", method: "GET", url: `http://127.0.0.1:${port}/keep`, headers: [] }) });
    h.sockets[0]!.fire("message", { data: serializeFrame({ t: "req", id: "drop", method: "GET", url: `http://127.0.0.1:${port}/drop`, headers: [] }) });
    const deadline = Date.now() + 5_000;
    while (h.sockets[0]!.sent.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1));

    h.sockets[0]!.fire("message", { data: serializeFrame({ t: "req-cancel", id: "drop" }) });
    while (closes.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1));
    assert.deepEqual(closes, ["/drop"], "the cancelled request did not die (or the wrong one did)");
  } finally {
    conn.stop();
    server.close();
    await once(server, "close");
  }
});
