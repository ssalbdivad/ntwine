import assert from "node:assert/strict";
import { test } from "node:test";
import type { CloudConfig } from "./cloud.ts";
import { createRemoteControlHandler, parseRemoteChoice } from "./remote-setup.ts";

const probes = {
  cloudflared: async () => ({ version: null }),
  tailscale: async () => ({ installed: false, dnsName: null }),
};

function harness() {
  let config: CloudConfig | null = null;
  const applied: Array<CloudConfig | null> = [];
  const handler = createRemoteControlHandler({
    port: 9393,
    current: () => config,
    apply: async (next) => {
      applied.push(next);
      config = next;
    },
    claim: async (name) => ({ hostname: `${name || "mk7w2qp9x4n3f6tbz5vh"}.frizz.sh`, claim: name || "mk7w2qp9x4n3f6tbz5vh", serve: "relay" }),
    issueLink: () => (config ? { url: `https://${config.hostname}/?ntwine_code=abc`, expiresAt: 1 } : null),
    probes,
  });
  return { handler, applied };
}

test("a browser choice becomes the same config the R pane would write, and comes back with a scannable link", async () => {
  const { handler, applied } = harness();
  const reply = await handler.post({ kind: "tailscale", origin: "https://Mini.tail.ts.net/" });
  assert.equal(reply.status, 200);
  assert.deepEqual(applied, [{ hostname: "mini.tail.ts.net", serve: "external", provider: "tailscale" }]);
  const body = reply.body as { current: { kind: string; origin: string }; link: { url: string; qrSvg: string } };
  assert.deepEqual(body.current, { kind: "tailscale", origin: "https://mini.tail.ts.net" });
  assert.match(body.link.qrSvg, /^<svg [^>]*viewBox="0 0 \d+ \d+"/);

  // A fresh link changes nothing else.
  const fresh = await handler.post({ link: true });
  assert.equal(fresh.status, 200);
  assert.equal(applied.length, 1);

  const off = await handler.post({ kind: "off" });
  assert.deepEqual((off.body as { current: unknown; link: unknown }), { protocol: 1, current: { kind: "off" }, link: null });
  assert.equal((await handler.post({ link: true })).status, 409, "no link to mint while loopback only");
});

test("a bad choice is refused before anything in force is stopped", async () => {
  const { handler, applied } = harness();
  assert.equal((await handler.post({ kind: "other", origin: "not a host" })).status, 422);
  assert.equal((await handler.post({ kind: "cloudflare", hostname: "board.example.com", tunnel: " " })).status, 422);
  assert.equal((await handler.post({ kind: "nope" })).status, 400);
  assert.deepEqual(applied, []);
  assert.equal(typeof parseRemoteChoice(null), "string");
});

test("a browser claim of a custom name shows its GitHub code through GET, and cancel abandons it", async () => {
  const told: string[] = [];
  const handler = createRemoteControlHandler({
    port: 9393,
    current: () => null,
    apply: async () => {},
    // Stands in for the device flow: show a code, then wait for GitHub until the signal aborts.
    claim: (name, signIn) =>
      new Promise((_resolve, reject) => {
        signIn.onDeviceCode({ userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresAt: Date.now() + 60_000 });
        signIn.signal.addEventListener("abort", () => reject(new Error(`the claim of ${name} was cancelled`)));
      }),
    issueLink: () => null,
    probes,
    onDeviceCode: (prompt) => told.push(prompt.userCode),
  });
  // Negative control: nothing pending, nothing shown.
  assert.equal(((await handler.get()).body as { signIn: unknown }).signIn, null);
  const pending = handler.post({ kind: "ntwine", name: "ada" });
  await new Promise((resolve) => setImmediate(resolve));
  const reading = (await handler.get()).body as { applying: boolean; signIn: unknown };
  assert.equal(reading.applying, true);
  assert.deepEqual(reading.signIn, { verificationUri: "https://github.com/login/device", userCode: "ABCD-1234" });
  assert.deepEqual(told, ["ABCD-1234"], "the terminal is told too");
  assert.equal(((await handler.post({ cancel: true })).body as { cancelled: boolean }).cancelled, true);
  const settled = await pending;
  assert.equal(settled.status, 422);
  assert.match((settled.body as { error: string }).error, /cancelled/);
  assert.equal(((await handler.get()).body as { signIn: unknown }).signIn, null);
});
