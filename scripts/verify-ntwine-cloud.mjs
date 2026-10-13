#!/usr/bin/env nub
/**
 * `ntwine up` end-to-end, minus the Cloudflare edge.
 *
 * `up` is the one command the operator is told to run, and until this script it had never been driven
 * at all — every part of it was verified in isolation and the wiring between them was believed. The two
 * failure modes it exists to prevent are the two that actually happened on the live board:
 *
 *   - a board running WITHOUT `--public-origin`, so every tunnelled request is a 403 and restarting
 *     cloudflared alone changes nothing;
 *   - cloudflared outliving or predeceasing the board, which is the "Cloudflare error 1033" state.
 *
 * Everything here is loopback. `cloudflared` is replaced on PATH by a recorder that logs its argv and
 * then waits, because what `up` owns is the SPAWN and the LIFETIME, not the tunnel protocol — the real
 * named tunnel is exercised by cloudflared itself, and the edge's header contract is replayed by
 * scripts/verify-access-codes.mjs. Nothing is exposed to the internet and no Cloudflare state is touched.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.VERIFY_PORT ?? 47311);
// There is ONE way to launch: the bare command with flags. `up` was a second spelling of this and is
// gone; `--cloud` is what it always set, and what the durable re-exec re-enters through.
const LAUNCH_ARGS = ["--port", String(PORT), "--dev", "--no-app", "--cloud"];

/**
 * Which of the two hostname shapes to drive. Both end in a running cloudflared, but by DIFFERENT
 * command lines, and getting that wrong means the tunnel never connects while the board looks healthy.
 *
 *   byo   (default) a tunnel the operator made: `run <name>`, ingress from a local config file
 *   claim            a name from the registrar:  `run --token <token>`, ingress held by Cloudflare
 */
const MODE = process.env.VERIFY_MODE === "claim" ? "claim" : "byo";
const RUN_TOKEN = "run-token-from-the-registrar";
const HOSTNAME = "e2e.frizz.sh";
const ORIGIN = `https://${HOSTNAME}`;

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
};

const home = mkdtempSync(join(tmpdir(), "ntwine-up-"));
const argvLog = join(home, "cloudflared.argv");
const pidLog = join(home, "cloudflared.pid");
let launcher = null;
let workspace = null;
let registrarServer = null;
let registrarOrigin = null;

/** cloudflared's stand-in: records how it was invoked, then waits to be killed like the real one. */
function installFakeCloudflared() {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const path = join(bin, "cloudflared");
  writeFileSync(
    path,
    `#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(argvLog)}\nprintf '%s' "$$" > ${JSON.stringify(pidLog)}\nwhile true; do sleep 1; done\n`,
    { mode: 0o755 },
  );
  return bin;
}

async function waitFor(label, predicate, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Every request the tunnel would make: the public Host and Origin, plus cloudflared's measured set. */
const tunnelHeaders = (extra = {}) => ({
  host: HOSTNAME,
  origin: ORIGIN,
  "x-forwarded-proto": "https",
  "x-forwarded-host": HOSTNAME,
  "sec-fetch-site": "same-origin",
  ...extra,
});

/**
 * Raw node:http, NOT fetch. `Host` is a forbidden header name in undici, so `fetch` silently drops it
 * and every request goes out as loopback — which makes the gate answer 200 and reads as "no gate".
 * Spoofing Host is the entire point here, so the request has to be built by hand.
 */
const request = (path, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: PORT, path, method: "GET", headers, setHost: false },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });

/**
 * The proxy answers 503 with `retry-after: 2` while the disposable child is restarting — a real,
 * documented transient, and one the source watcher provokes constantly. Retrying through it is not
 * loosening the assertion: every check below still demands its exact status, just not during a recycle.
 */
const settled = async (path, headers, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  let last = await request(path, headers);
  while (last.status === 503 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    last = await request(path, headers);
  }
  return last;
};

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

try {
  // REFUSE TO RUN ON AN OCCUPIED PORT. Ntwine is a singleton: a board left over from an earlier run
  // would be JOINED rather than replaced, and a joining launch arms no public origin and prints no
  // access link. The failure then reads as "publicOrigin was NOT armed", which sends whoever is
  // debugging it into the launcher instead of at the stale process actually responsible.
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", () =>
      reject(new Error(`port ${PORT} is already in use — a previous run's board is still there, and this one would join it instead of starting its own`)),
    );
    probe.listen(PORT, "127.0.0.1", () => probe.close(() => resolve(undefined)));
  });

  // A saved cloud.json is what makes the second launch a single flag, so seed one and assert the
  // launcher reads it rather than prompting.
  mkdirSync(join(home, ".ntwine"), { recursive: true });
  writeFileSync(
    join(home, ".ntwine", "cloud.json"),
    `${JSON.stringify(
      MODE === "claim" ? { hostname: HOSTNAME, claim: "e2e" } : { hostname: HOSTNAME, tunnel: "ntwine-e2e" },
      null,
      2,
    )}\n`,
  );

  // A claimed name renews on every launch, which is where it gets this run's token. Stand up a
  // registrar that answers so the launcher takes the live path rather than the offline fallback.
  if (MODE === "claim") {
    registrarServer = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ hostname: HOSTNAME, token: RUN_TOKEN, leaseExpiresAt: 0, renewed: true }));
      });
    });
    registrarServer.listen(0, "127.0.0.1");
    await once(registrarServer, "listening");
    registrarOrigin = `http://127.0.0.1:${registrarServer.address().port}`;
  }

  const bin = installFakeCloudflared();
  // A THROWAWAY workspace, not the ntwine repo. Ntwine is a singleton: launching `up` against the repo
  // this source lives in joins the board the maintainer already has running on 9494 and verifies
  // nothing (measured twice). A workspace the running server has never seen boots its own.
  workspace = mkdtempSync(join(tmpdir(), "ntwine-up-repo-"));
  spawnSync("git", ["init", "-q"], { cwd: workspace });
  spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: workspace });
  let output = "";
  launcher = spawn(
    "nub",
    // --dev boots source rather than building an artifact (the shared tree does not always typecheck,
    // and an artifact build is not what this script is testing). --no-app keeps a browser window off
    // the maintainer's screen.
    ["--no-env-file", join(repo, "src", "index.ts"), ...LAUNCH_ARGS],
    {
      cwd: workspace,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        NTWINE_WAKERS_OFF: "1",
        ...(registrarOrigin ? { NTWINE_REGISTRAR: registrarOrigin } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  launcher.stdout.on("data", (d) => { output += d.toString(); });
  launcher.stderr.on("data", (d) => { output += d.toString(); });

  // 1. The board comes up at all.
  await waitFor("the board to listen", async () => {
    try {
      return (await request("/health", { host: `127.0.0.1:${PORT}` })).status === 200;
    } catch {
      return false;
    }
  });
  check("the board is listening", true, `127.0.0.1:${PORT}`);

  // 2. THE REGRESSION THAT BIT THE LIVE BOARD. `up` must arm the origin gate from the saved hostname
  //    with no flag typed. An unarmed board answers 403 here, and no amount of restarting cloudflared
  //    would fix it — which is exactly how a "working" setup went silently dead.
  const gated = await settled("/", tunnelHeaders());
  check(
    "a tunnelled request is CHALLENGED (401), not refused (403)",
    gated.status === 401,
    `got ${gated.status}${gated.status === 403 ? " — publicOrigin was NOT armed from cloud.json" : ""}`,
  );

  // 2b. THE CONTROL. A host that is NOT the declared one must be refused outright — otherwise a 401
  //     above could mean "the gate fires for everything", which would prove nothing about arming.
  const foreign = await request("/", { ...tunnelHeaders(), host: "evil.example", origin: "https://evil.example" });
  check("an undeclared host is refused outright", foreign.status === 403, `got ${foreign.status}`);

  // 3. Loopback is never challenged, or the operator locks themselves out of their own machine.
  check("loopback is exempt from the gate", (await settled("/health", { host: `127.0.0.1:${PORT}` })).status === 200);

  // 4. The readout hands over a redeemable link rather than a bare origin.
  const link = await waitFor("the access link", () => /https:\/\/\S*ntwine_code=\S+/.exec(output)?.[0] ?? null);
  const code = new URL(link).searchParams.get("ntwine_code");
  check("the readout prints a single-use link", Boolean(code));

  // 5. The code buys a session cookie, once.
  const redeemed = await request(`/?ntwine_code=${code}`, tunnelHeaders());
  const cookie = (redeemed.headers["set-cookie"]?.[0] ?? "").split(";")[0];
  check(
    "the code redeems to a session and redirects away",
    redeemed.status === 302 && cookie.length > 0,
    `status ${redeemed.status}`,
  );
  check(
    "the redirect strips the secret from the URL",
    !(redeemed.headers.location ?? "").includes("ntwine_code"),
    redeemed.headers.location ?? "",
  );

  const withCookie = await settled("/", tunnelHeaders({ cookie }));
  check("the session then loads the board", withCookie.status === 200, `status ${withCookie.status}`);

  const replay = await request(`/?ntwine_code=${code}`, tunnelHeaders());
  check("a replayed code is refused", replay.status === 401, `status ${replay.status}`);

  // 6. The tunnel was spawned as a child, with the tunnel name from cloud.json.
  const argv = existsSync(argvLog) ? readFileSync(argvLog, "utf8").trim() : "";
  check("the launch spawned cloudflared itself", argv.length > 0, argv);
  // The two shapes take DIFFERENT command lines. A claimed name has no local config and no tunnel
  // name to say — the token is its whole identity.
  check(
    MODE === "claim" ? "it runs the claimed tunnel from its token" : "it runs the tunnel named in cloud.json",
    argv.startsWith("tunnel ") &&
      (MODE === "claim" ? argv.endsWith(`run --token ${RUN_TOKEN}`) : /(^|\s)run\s+ntwine-e2e$/.test(argv)),
    argv,
  );

  // 7. THE 1033 PROPERTY. The two halves share a lifetime: stopping the board must take the tunnel with
  //    it, or the hostname keeps resolving to a board that is no longer there.
  const tunnelPid = Number(readFileSync(pidLog, "utf8").trim());
  check("the tunnel child is running", alive(tunnelPid), `pid ${tunnelPid}`);
  launcher.kill("SIGINT");
  const died = await waitFor("the tunnel to stop with the board", () => !alive(tunnelPid), 20_000).then(
    () => true,
    () => false,
  );
  check("stopping the board stops the tunnel", died, `pid ${tunnelPid}`);
  launcher = null;
} catch (error) {
  check("harness completed", false, error instanceof Error ? error.message : String(error));
} finally {
  // SIGINT and WAIT, rather than SIGKILL outright. The launcher supervises the board in a separate
  // process; killing the launcher without letting it shut down orphans that board, which then holds
  // the port and makes the NEXT run join it instead of starting its own. That is what the port guard
  // above kept catching, and this is the leak it was catching.
  if (launcher) {
    launcher.kill("SIGINT");
    const exited = await Promise.race([
      new Promise((resolve) => launcher.once("exit", () => resolve(true))),
      new Promise((resolve) => setTimeout(() => resolve(false), 15_000)),
    ]);
    if (!exited) launcher.kill("SIGKILL");
  }
  if (registrarServer) registrarServer.close();
  if (existsSync(pidLog)) {
    const pid = Number(readFileSync(pidLog, "utf8").trim());
    if (Number.isFinite(pid) && alive(pid)) process.kill(pid, "SIGKILL");
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  if (workspace) rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed (mode: ${MODE})`);
process.exit(failed.length === 0 ? 0 : 1);
