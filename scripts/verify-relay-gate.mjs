#!/usr/bin/env nub
/**
 * A relayed terminal against the REAL access gate.
 *
 * `verify-relay-e2e.mjs` proves the frames reach a socket server. It cannot prove the thing that
 * matters most about a terminal on the public internet: that ntwine's own gate stands in front of it.
 * Its board is a toy that accepts every upgrade, so a relay forwarding NO identity at all passes there
 * and fails against the real thing — in whichever direction is worse.
 *
 * So this puts the real `RestartSupervisorProxy` in the path, with a public origin declared, and asks
 * it the only two questions worth asking: is an unauthenticated terminal REFUSED, and does a visitor
 * holding a redeemed session get through? No relay and no workerd — the seam under test is the board's
 * authority boundary, and adding a runtime either side of it would only make a failure harder to read.
 */
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { RestartSupervisorProxy } from "@ntwine/server/restart-supervisor";
import { serveRelayWebSocket } from "../src/relay-agent.ts";

const PUBLIC_ORIGIN = "https://ada.ntwine.app";
const checks = [];
const check = (name, ok, detail = "") => {
  checks.push(ok);
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

/** Drive one relayed upgrade and report what the board did with it. */
function attempt(headers, options) {
  return new Promise((resolve) => {
    const out = [];
    const session = serveRelayWebSocket(
      { t: "ws-open", id: "w1", url: `${PUBLIC_ORIGIN}/terminal`, headers },
      { ...options, send: (frame) => { out.push(frame); if (frame.t === "ws-ack") { clearTimeout(timer); resolve({ ok: frame.ok, session }); } } },
    );
    const timer = setTimeout(() => resolve({ ok: null, session }), 15_000);
  });
}

let child = null;
let proxy = null;
try {
  // A stand-in board: the real proxy's child, serving one terminal. What it does with the socket is
  // beside the point — whether the upgrade reaches it at all is the whole test.
  const wss = new WebSocketServer({ noServer: true });
  child = createServer((_, res) => { res.writeHead(200); res.end("board"); });
  let reached = 0;
  child.on("upgrade", (req, socket, head) => {
    reached++;
    wss.handleUpgrade(req, socket, head, (ws) => ws.on("message", (raw) => ws.send(`pty:${String(raw)}`)));
  });
  child.listen(0, "127.0.0.1");
  await once(child, "listening");
  const childPort = child.address().port;

  // The real boundary, with a public origin declared — which is what arms the access gate at all.
  const port = 47590;
  proxy = new RestartSupervisorProxy({
    port,
    publicOrigin: PUBLIC_ORIGIN,
    childPort: () => childPort,
    restart: async () => ({ state: "ready" }),
  });
  await proxy.listen();
  const boardOrigin = `http://127.0.0.1:${port}`;
  check("the real supervisor proxy is serving with a public origin", true, PUBLIC_ORIGIN);

  // 1. NO IDENTITY AT ALL — what the relay agent used to send.
  const bare = await attempt([], { origin: boardOrigin, publicOrigin: PUBLIC_ORIGIN });
  check("a terminal with no visitor identity is refused", bare.ok === false, `ack ok=${bare.ok}`);
  bare.session.close();

  // 2. THE VISITOR'S HEADERS, BUT NO REDEEMED SESSION. This is the one that matters: the board must
  //    see a PUBLIC arrival and demand the code, not read loopback and wave a shell through.
  const before = reached;
  const uninvited = await attempt(
    [["host", "ada.ntwine.app"], ["origin", PUBLIC_ORIGIN]],
    { origin: boardOrigin, publicOrigin: PUBLIC_ORIGIN },
  );
  check("a visitor without a redeemed access code is refused", uninvited.ok === false, `ack ok=${uninvited.ok}`);
  check("and the upgrade never reached the board behind the gate", reached === before, `${reached - before} got through`);
  uninvited.session.close();

  // 3. A REDEEMED SESSION. Mint a code the way the launcher does, trade it for the cookie a browser
  //    would hold, and present that.
  const code = proxy.issueAccessCode();
  // RAW node:http, because `fetch` SILENTLY DROPS a Host header — it is forbidden in undici. The
  // redemption would then arrive as loopback, the gate would never engage, and the 403 that comes back
  // reads as a broken gate rather than as a broken probe.
  const redeem = await new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: `/?ntwine_code=${encodeURIComponent(code.code)}`,
        headers: { host: "ada.ntwine.app", origin: PUBLIC_ORIGIN },
        setHost: false,
      },
      (res) => { res.resume(); resolve({ status: res.statusCode, setCookie: res.headers["set-cookie"] ?? [] }); },
    );
    req.on("error", reject);
    req.end();
  });
  const cookie = redeem.setCookie.map((c) => c.split(";")[0]).join("; ");
  check("an access code is traded for a session cookie", cookie.includes("ntwine_session="), `HTTP ${redeem.status}`);

  const invited = await attempt(
    [["host", "ada.ntwine.app"], ["origin", PUBLIC_ORIGIN], ["cookie", cookie]],
    { origin: boardOrigin, publicOrigin: PUBLIC_ORIGIN },
  );
  check("a visitor holding a redeemed session opens a terminal", invited.ok === true, `ack ok=${invited.ok}`);
  invited.session.close();
} catch (error) {
  check("harness completed", false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  await proxy?.close().catch(() => undefined);
  child?.closeAllConnections?.();
  child?.close();
}

const failed = checks.filter((ok) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
