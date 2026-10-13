import assert from "node:assert/strict"
import type { IncomingMessage } from "node:http"
import test from "node:test"
import {
  allowedLocalCorsOrigin,
  authoritySendsFetchMetadata,
  bindHostIsExposed,
  isTrustedLocalHttpRequest,
  isTrustedLocalWebSocketRequest,
  machineHostNames,
  normalizeAllowedHosts,
  normalizeBindHost,
  normalizePublicOrigin,
  parseLocalHost,
  parseLocalHttpOrigin,
  unlistedHostName,
} from "./local-origin.ts"

const PORT = 49_177

function upgradeRequest(host: string | undefined, origin: string | undefined, extra: Record<string, string> = {}) {
  return {
    headers: { ...(host ? { host } : {}), ...(origin ? { origin } : {}), ...extra },
    socket: { localPort: PORT },
  } as unknown as IncomingMessage
}

test("local origin parser accepts only canonical loopback URL serializations on the expected port", () => {
  for (const [origin, hostname] of [
    [`http://127.0.0.1:${PORT}`, "127.0.0.1"],
    [`http://localhost:${PORT}`, "localhost"],
    [`http://[::1]:${PORT}`, "::1"],
  ] as const) {
    assert.equal(parseLocalHttpOrigin(origin, PORT)?.hostname, hostname)
    assert.equal(allowedLocalCorsOrigin(origin, PORT), origin)
  }

  for (const origin of [
    undefined,
    "null",
    `https://localhost:${PORT}`,
    `http://localhost.evil:${PORT}`,
    `http://127.0.0.1.evil:${PORT}`,
    `http://127.0.0.1:${PORT + 1}`,
    `http://127.1:${PORT}`,
    `http://2130706433:${PORT}`,
    `http://0177.0.0.1:${PORT}`,
    `HTTP://LOCALHOST:${PORT}`,
    `http://localhost:${PORT}/`,
    `http://user@localhost:${PORT}`,
    `http://localhost.:${PORT}`,
    `http://localhоst:${PORT}`,
    `http://%6cocalhost:${PORT}`,
    `http://[0:0:0:0:0:0:0:1]:${PORT}`,
    `http://[::ffff:127.0.0.1]:${PORT}`,
    `http://localhost:0${PORT}`,
    `http://localhost:${PORT}, http://evil.example`,
  ]) {
    assert.equal(parseLocalHttpOrigin(origin, PORT), null, String(origin))
  }
})

test("local Host parser rejects DNS suffixes, port aliases, userinfo, and canonicalization tricks", () => {
  for (const [host, hostname] of [
    [`127.0.0.1:${PORT}`, "127.0.0.1"],
    [`localhost:${PORT}`, "localhost"],
    [`[::1]:${PORT}`, "::1"],
  ] as const) {
    assert.equal(parseLocalHost(host, PORT)?.hostname, hostname)
  }
  for (const host of [
    `localhost.evil:${PORT}`,
    `127.0.0.1.evil:${PORT}`,
    `127.0.0.1:${PORT + 1}`,
    `127.1:${PORT}`,
    `2130706433:${PORT}`,
    `0177.0.0.1:${PORT}`,
    `user@localhost:${PORT}`,
    `localhost:${PORT}/path`,
    `localhost.:${PORT}`,
    `localhоst:${PORT}`,
    `%6cocalhost:${PORT}`,
    `[0:0:0:0:0:0:0:1]:${PORT}`,
    `[::ffff:127.0.0.1]:${PORT}`,
    `localhost:0${PORT}`,
    `localhost:${PORT}, evil.example`,
  ]) {
    assert.equal(parseLocalHost(host, PORT), null, host)
  }
})

test("HTTP requires the present Origin to match Host and narrowly opts missing Origin into compatibility", () => {
  assert.equal(isTrustedLocalHttpRequest({ host: `127.0.0.1:${PORT}` }, PORT), false)
  assert.equal(isTrustedLocalHttpRequest({ host: `127.0.0.1:${PORT}` }, PORT, true), true)
  for (const [host, origin] of [
    [`127.0.0.1:${PORT}`, `http://127.0.0.1:${PORT}`],
    [`localhost:${PORT}`, `http://localhost:${PORT}`],
    [`LOCALHOST:${PORT}`, `http://localhost:${PORT}`],
    [`[::1]:${PORT}`, `http://[::1]:${PORT}`],
  ]) {
    assert.equal(isTrustedLocalHttpRequest({ host, origin }, PORT), true, `${host} / ${origin}`)
  }
  for (const [host, origin] of [
    [`127.0.0.1:${PORT}`, `http://localhost:${PORT}`],
    [`127.0.0.1:${PORT}`, `http://[::1]:${PORT}`],
    [`localhost:${PORT}`, `http://127.0.0.1:${PORT}`],
    [`localhost:${PORT}`, `http://[::1]:${PORT}`],
    [`[::1]:${PORT}`, `http://127.0.0.1:${PORT}`],
    [`[::1]:${PORT}`, `http://localhost:${PORT}`],
  ]) {
    assert.equal(isTrustedLocalHttpRequest({ host, origin }, PORT), false, `${host} / ${origin}`)
  }
  assert.equal(isTrustedLocalHttpRequest({ host: `localhost.evil:${PORT}` }, PORT, true), false)
  assert.equal(isTrustedLocalHttpRequest({ host: `127.0.0.1:${PORT}`, origin: "http://evil.example" }, PORT), false)
  assert.equal(isTrustedLocalHttpRequest({ host: [`127.0.0.1:${PORT}`], origin: `http://127.0.0.1:${PORT}` }, PORT), false)
  assert.equal(isTrustedLocalHttpRequest({ host: `127.0.0.1:${PORT}`, origin: [`http://127.0.0.1:${PORT}`] }, PORT), false)
  for (const name of [
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-port",
    "x-forwarded-proto",
  ] as const) {
    assert.equal(isTrustedLocalHttpRequest({
      host: `127.0.0.1:${PORT}`,
      origin: `http://127.0.0.1:${PORT}`,
      [name]: name === "forwarded" ? "" : "attacker-controlled",
    }, PORT), false, name)
  }
})

test("WebSocket policy requires a present exact same-origin Host across IPv4, localhost, and IPv6", () => {
  for (const [host, origin] of [
    [`127.0.0.1:${PORT}`, `http://127.0.0.1:${PORT}`],
    [`localhost:${PORT}`, `http://localhost:${PORT}`],
    [`[::1]:${PORT}`, `http://[::1]:${PORT}`],
  ]) {
    assert.equal(isTrustedLocalWebSocketRequest(upgradeRequest(host, origin)), true, origin)
  }
  assert.equal(isTrustedLocalWebSocketRequest(upgradeRequest(`127.0.0.1:${PORT}`, undefined)), false)
  assert.equal(isTrustedLocalWebSocketRequest(upgradeRequest(`127.0.0.1:${PORT}`, `http://localhost:${PORT}`)), false)
  assert.equal(isTrustedLocalWebSocketRequest(upgradeRequest(`localhost.evil:${PORT}`, `http://localhost.evil:${PORT}`)), false)
  assert.equal(isTrustedLocalWebSocketRequest(upgradeRequest(
    `127.0.0.1:${PORT}`,
    `http://127.0.0.1:${PORT}`,
    { "x-forwarded-proto": "https" },
  )), false)
})

// ── --host: what an EXPOSED bind may accept as its browser authority ────────────────────────────────

const EXPOSED = { exposed: true, allowedHosts: [] as string[] }

test("an exposed policy admits IP literals and nothing else by default", () => {
  // The default posture is untouched: without the policy these are all still foreign authorities.
  for (const hostname of ["192.168.1.5", "10.0.0.4", "[2001:db8::5]"]) {
    assert.equal(parseLocalHost(`${hostname}:${PORT}`, PORT), null, hostname)
    assert.equal(parseLocalHost(`${hostname}:${PORT}`, PORT, EXPOSED)?.port, PORT, hostname)
  }
  assert.equal(parseLocalHttpOrigin(`http://192.168.1.5:${PORT}`, PORT), null)
  assert.equal(parseLocalHttpOrigin(`http://192.168.1.5:${PORT}`, PORT, EXPOSED)?.hostname, "192.168.1.5")
  // Loopback keeps working while exposed — the local browser tab is still the common case.
  assert.equal(parseLocalHost(`localhost:${PORT}`, PORT, EXPOSED)?.hostname, "localhost")
  // A DNS NAME is the whole DNS-rebinding vector, so it stays rejected until named explicitly.
  assert.equal(parseLocalHost(`ntwine.local:${PORT}`, PORT, EXPOSED), null)
  assert.equal(parseLocalHost(`ntwine.local:${PORT}`, PORT, { exposed: true, allowedHosts: ["ntwine.local"] })?.hostname, "ntwine.local")
  assert.equal(parseLocalHost(`NTWINE.local:${PORT}`, PORT, { exposed: true, allowedHosts: ["ntwine.local"] })?.hostname, "ntwine.local")
  assert.equal(parseLocalHost(`other.local:${PORT}`, PORT, { exposed: true, allowedHosts: ["ntwine.local"] }), null)
  assert.equal(parseLocalHost(`other.local:${PORT}`, PORT, { exposed: true, allowedHosts: ["*"] })?.hostname, "other.local")
  // An allow-list without exposure changes nothing: the port is still unreachable from off-machine.
  assert.equal(parseLocalHost(`ntwine.local:${PORT}`, PORT, { exposed: false, allowedHosts: ["ntwine.local"] }), null)
  // Every canonicalization trick the loopback parser rejects is still rejected while exposed.
  for (const host of [`192.168.1.5:${PORT + 1}`, `user@192.168.1.5:${PORT}`, `192.168.1.5:${PORT}/x`, `3232235781:${PORT}`]) {
    assert.equal(parseLocalHost(host, PORT, EXPOSED), null, host)
  }
})

test("the machine's own names: the hostname as given, its first label, and that label under .local", () => {
  assert.deepEqual(machineHostNames("pupper"), ["pupper", "pupper.local"])
  assert.deepEqual(machineHostNames("Laptop.local"), ["laptop.local", "laptop"])
  assert.deepEqual(machineHostNames("pupper.home.arpa."), ["pupper.home.arpa", "pupper", "pupper.local"])
  // Nothing to add for a box that calls itself localhost, and an IP is already accepted while exposed.
  assert.deepEqual(machineHostNames("localhost"), [])
  assert.deepEqual(machineHostNames("localhost.localdomain"), ["localhost.localdomain"])
  assert.deepEqual(machineHostNames("192.168.1.5"), [])
  assert.deepEqual(machineHostNames(""), [])
  // They are ordinary allowed hosts: exact matches, never a suffix rule.
  const policy = { exposed: true, allowedHosts: machineHostNames("pupper") }
  assert.equal(parseLocalHost(`pupper:${PORT}`, PORT, policy)?.hostname, "pupper")
  assert.equal(parseLocalHost(`PUPPER.local:${PORT}`, PORT, policy)?.hostname, "pupper.local")
  assert.equal(parseLocalHost(`pupper.evil.com:${PORT}`, PORT, policy), null)
  assert.equal(parseLocalHost(`notpupper:${PORT}`, PORT, policy), null)
})

test("a refused Host is named back only when an unlisted DNS name is all that is wrong with it", () => {
  // The operator who opened an exposed board by the machine's name gets told which flag to add.
  assert.equal(unlistedHostName(`pupper:${PORT}`, PORT, EXPOSED), "pupper")
  assert.equal(unlistedHostName(`Pupper.LAN:${PORT}`, PORT, { exposed: true, allowedHosts: ["ntwine.local"] }), "pupper.lan")
  // Nothing to explain once the name is accepted, by listing or by wildcard.
  assert.equal(unlistedHostName(`pupper:${PORT}`, PORT, { exposed: true, allowedHosts: ["pupper"] }), null)
  assert.equal(unlistedHostName(`pupper:${PORT}`, PORT, { exposed: true, allowedHosts: ["*"] }), null)
  // A loopback-only board never explains: the port is unreachable from off-machine, so a foreign
  // name there is a probe, not an operator.
  assert.equal(unlistedHostName(`pupper:${PORT}`, PORT), null)
  assert.equal(unlistedHostName(`pupper:${PORT}`, PORT, { exposed: false, allowedHosts: [] }), null)
  // An IP literal is already accepted while exposed, and every other malformation stays wordless.
  assert.equal(unlistedHostName(`192.168.1.5:${PORT}`, PORT, EXPOSED), null)
  for (const host of [`pupper:${PORT + 1}`, `user@pupper:${PORT}`, `pupper:${PORT}/x`, "pupper", undefined, `a,b:${PORT}`]) {
    assert.equal(unlistedHostName(host, PORT, EXPOSED), null, String(host))
  }
})

test("an exposed request still needs Origin to match Host, and forwarded authority is never trusted", () => {
  const host = `192.168.1.5:${PORT}`
  assert.equal(isTrustedLocalHttpRequest({ host, origin: `http://192.168.1.5:${PORT}` }, PORT, false, EXPOSED), true)
  // The cross-site CSRF case the whole gate exists for, now from a LAN browser.
  assert.equal(isTrustedLocalHttpRequest({ host, origin: "http://evil.example" }, PORT, false, EXPOSED), false)
  // Same machine, different authority: still not interchangeable.
  assert.equal(isTrustedLocalHttpRequest({ host, origin: `http://127.0.0.1:${PORT}` }, PORT, false, EXPOSED), false)
  assert.equal(isTrustedLocalHttpRequest({ host, origin: `http://192.168.1.5:${PORT}`, "x-forwarded-host": "x" }, PORT, false, EXPOSED), false)
  assert.equal(allowedLocalCorsOrigin(`http://192.168.1.5:${PORT}`, PORT, EXPOSED), `http://192.168.1.5:${PORT}`)
  assert.equal(allowedLocalCorsOrigin(`http://192.168.1.5:${PORT}`, PORT), undefined)
  assert.equal(
    isTrustedLocalWebSocketRequest(upgradeRequest(host, `http://192.168.1.5:${PORT}`), PORT, EXPOSED),
    true,
  )
  assert.equal(isTrustedLocalWebSocketRequest(upgradeRequest(host, undefined), PORT, EXPOSED), false)
})

test("bind hosts: loopback spellings are private, wildcards are not, and names are refused", () => {
  for (const host of ["127.0.0.1", "::1", "localhost", "[::1]"]) assert.equal(bindHostIsExposed(host), false, host)
  for (const host of ["0.0.0.0", "::", "192.168.1.5"]) assert.equal(bindHostIsExposed(host), true, host)
  assert.equal(normalizeBindHost("localhost"), "127.0.0.1")
  assert.equal(normalizeBindHost(" [::1] "), "::1")
  assert.equal(normalizeBindHost("0.0.0.0"), "0.0.0.0")
  assert.throws(() => normalizeBindHost(""), /requires an address/)
  assert.throws(() => normalizeBindHost("example.com"), /invalid --host address/)
  assert.throws(() => normalizeBindHost("0.0.0.0:5173"), /invalid --host address/)
  assert.deepEqual(normalizeAllowedHosts([" A ", "b,, B ", ""]), ["a", "b"])
})

const TUNNELLED = { publicOrigin: "https://ntwine.example.com" } as const

test("a declared public origin is the one authority admitted at another scheme and another port", () => {
  // The proxy terminates TLS on 443 and dials this server's loopback port, so neither the scheme nor
  // the port a browser saw has anything to do with `expectedPort`. Nothing else gets that latitude.
  assert.equal(parseLocalHttpOrigin("https://ntwine.example.com", PORT, TUNNELLED)?.hostname, "ntwine.example.com")
  assert.equal(parseLocalHttpOrigin("https://ntwine.example.com", PORT, TUNNELLED)?.port, 443)
  assert.equal(parseLocalHttpOrigin("https://ntwine.example.com", PORT), null)
  assert.equal(allowedLocalCorsOrigin("https://ntwine.example.com", PORT, TUNNELLED), "https://ntwine.example.com")

  // Matched WHOLE, against the configured string. A neighbouring name, a scheme downgrade, a bare
  // port, or any suffix trick is a different origin and stays foreign.
  for (const origin of [
    "https://ntwine.example.com.evil",
    "https://evil.ntwine.example.com",
    "http://ntwine.example.com",
    `http://ntwine.example.com:${PORT}`,
    "https://ntwine.example.com:8443",
    "https://ntwine.example.com/",
  ]) {
    assert.equal(parseLocalHttpOrigin(origin, PORT, TUNNELLED), null, origin)
  }

  // cloudflared forwards the browser's Host verbatim, so it arrives with no port at all. The proxy's
  // own port is accepted too; this server's loopback port never is, because a browser never saw it.
  assert.equal(parseLocalHost("ntwine.example.com", PORT, TUNNELLED)?.hostname, "ntwine.example.com")
  assert.equal(parseLocalHost("ntwine.example.com:443", PORT, TUNNELLED)?.hostname, "ntwine.example.com")
  assert.equal(parseLocalHost(`ntwine.example.com:${PORT}`, PORT, TUNNELLED), null)
  assert.equal(parseLocalHost("ntwine.example.com", PORT), null)
  // Loopback keeps working through a tunnel — the operator's own tab on the box is still the norm.
  assert.equal(parseLocalHost(`127.0.0.1:${PORT}`, PORT, TUNNELLED)?.hostname, "127.0.0.1")
})

test("a declared public origin tolerates forwarded headers only on requests that arrived as it", () => {
  const proxied = { host: "ntwine.example.com", origin: "https://ntwine.example.com" }
  const forwarded = { "x-forwarded-for": "203.0.113.7", "x-forwarded-proto": "https" }
  assert.equal(isTrustedLocalHttpRequest({ ...proxied, ...forwarded }, PORT, false, TUNNELLED), true)
  assert.equal(isTrustedLocalHttpRequest(proxied, PORT, false, TUNNELLED), true)
  // Undeclared, this is exactly the shape Ntwine refuses — naming a proxy is what changes the answer.
  assert.equal(isTrustedLocalHttpRequest({ ...proxied, ...forwarded }, PORT, false), false)

  // The laundering case: a caller on the loopback port cannot borrow the proxy's licence by claiming
  // its headers. Only a request whose own Host IS the declared origin may carry them.
  assert.equal(
    isTrustedLocalHttpRequest({ host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, ...forwarded }, PORT, false, TUNNELLED),
    false,
  )
  // Host and Origin still have to agree, and a foreign Origin is still a foreign Origin.
  assert.equal(isTrustedLocalHttpRequest({ host: "ntwine.example.com", origin: "https://evil.example" }, PORT, false, TUNNELLED), false)
  assert.equal(isTrustedLocalHttpRequest({ host: `127.0.0.1:${PORT}`, origin: "https://ntwine.example.com" }, PORT, false, TUNNELLED), false)

  // The WebSocket gate keeps its mandatory-Origin rule through the tunnel.
  assert.equal(isTrustedLocalWebSocketRequest(upgradeRequest("ntwine.example.com", "https://ntwine.example.com", forwarded), PORT, TUNNELLED), true)
  assert.equal(isTrustedLocalWebSocketRequest(upgradeRequest("ntwine.example.com", undefined, forwarded), PORT, TUNNELLED), false)
  assert.equal(isTrustedLocalWebSocketRequest(upgradeRequest("ntwine.example.com", "https://evil.example"), PORT, TUNNELLED), false)
})

test("an https proxy origin still sends Fetch Metadata, so it never needs the LAN vouch", () => {
  // The vouch exists because Chrome withholds Sec-Fetch-* from a non-trustworthy origin. A tunnel that
  // terminates TLS hands the browser a trustworthy one, so the real signal survives and must be used.
  assert.equal(authoritySendsFetchMetadata(parseLocalHost("ntwine.example.com", PORT, TUNNELLED)!), true)
  assert.equal(authoritySendsFetchMetadata(parseLocalHost(`192.168.1.5:${PORT}`, PORT, EXPOSED)!), false)
  assert.equal(authoritySendsFetchMetadata(parseLocalHost(`127.0.0.1:${PORT}`, PORT)!), true)
  // A plain-http proxy is in the same boat as a LAN address and does need it.
  const insecure = { publicOrigin: "http://ntwine.example.com" } as const
  assert.equal(authoritySendsFetchMetadata(parseLocalHost("ntwine.example.com", PORT, insecure)!), false)
})

test("public origins are validated at launch, where the message can say what is wrong", () => {
  assert.equal(normalizePublicOrigin(" https://ntwine.example.com "), "https://ntwine.example.com")
  assert.equal(normalizePublicOrigin("https://Ntwine.Example.com"), "https://ntwine.example.com")
  assert.equal(normalizePublicOrigin("http://box.local:8080"), "http://box.local:8080")
  assert.throws(() => normalizePublicOrigin(""), /requires a URL/)
  assert.throws(() => normalizePublicOrigin("ntwine.example.com"), /use a full URL/)
  assert.throws(() => normalizePublicOrigin("wss://ntwine.example.com"), /only http and https/)
  assert.throws(() => normalizePublicOrigin("https://ntwine.example.com/board"), /no path/)
  assert.throws(() => normalizePublicOrigin("https://u:p@ntwine.example.com"), /no credentials/)
})
