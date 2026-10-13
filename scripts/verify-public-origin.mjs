// Drives the REAL board through a REAL TLS origin, to prove `--public-origin` works end to end.
//
// Why this exists rather than a live Cloudflare Tunnel: pointing a public tunnel at a board that runs
// shell commands as you, with no login, is not something a verification run should do to a maintainer's
// machine. So this replays the origin-facing hop instead. The header set below is not invented — it was
// MEASURED from a real `cloudflared tunnel --url` quick tunnel on 2026-08-03 by pointing it at an echo
// server and reading what actually arrived: Host and Origin verbatim from the browser (Host carries NO
// port), `x-forwarded-for` + `x-forwarded-proto: https`, the `cf-*` set, and — because an https origin
// is potentially trustworthy — the real `Sec-Fetch-*` stamps, including `sec-fetch-site: same-origin`
// on the app's own reads. TLS here is real, so the browser genuinely reports a secure context.
//
// Usage — start a board with the matching origin first, then run this:
//   nub src/index.ts --dev --no-app --port 5902 --public-origin https://frizz.local.test:8443 /path/to/repo
//   nub scripts/verify-public-origin.mjs 5902 8443
import { launchHeadless } from "./lib/headless-browser.mjs"
import { createServer } from "node:https"
import { request as httpRequest } from "node:http"
import { connect as netConnect } from "node:net"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const HOSTNAME = "frizz.local.test"
const originPort = Number(process.argv[2] ?? 5902)
const frontPort = Number(process.argv[3] ?? 8443)
const ORIGIN = `https://${HOSTNAME}:${frontPort}`

/** Exactly what a real cloudflared adds on top of the browser's own headers. */
const CLOUDFLARED_ADDS = {
  "x-forwarded-for": "2607:fb90:b280:2a67:a46b:4e8c:41d1:b4a3",
  "x-forwarded-proto": "https",
  "cf-connecting-ip": "2607:fb90:b280:2a67:a46b:4e8c:41d1:b4a3",
  "cf-ipcountry": "US",
  "cf-ray": "a2577ed7b9367592-SEA",
  "cf-visitor": '{"scheme":"https"}',
  "cf-worker": "trycloudflare.com",
}

const certDir = mkdtempSync(join(tmpdir(), "frizz-public-origin-"))
execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes",
  "-keyout", join(certDir, "key.pem"), "-out", join(certDir, "cert.pem"),
  "-days", "1", "-subj", `/CN=${HOSTNAME}`, "-addext", `subjectAltName=DNS:${HOSTNAME}`,
], { stdio: "ignore" })

const withCf = (headers) => ({ ...headers, ...CLOUDFLARED_ADDS })
const front = createServer(
  { key: readFileSync(join(certDir, "key.pem")), cert: readFileSync(join(certDir, "cert.pem")) },
  (req, res) => {
    const up = httpRequest(
      { host: "127.0.0.1", port: originPort, method: req.method, path: req.url, headers: withCf(req.headers) },
      (ur) => { res.writeHead(ur.statusCode ?? 502, ur.headers); ur.pipe(res) },
    )
    up.once("error", () => { if (!res.headersSent) res.writeHead(502); res.end("origin unreachable") })
    req.pipe(up)
  },
)
// A tunnel carries the board socket and every terminal, so the upgrade path is not optional here.
front.on("upgrade", (req, socket, head) => {
  const up = netConnect(originPort, "127.0.0.1")
  up.once("connect", () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`]
    for (const [name, value] of Object.entries(withCf(req.headers))) {
      for (const entry of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${entry}`)
    }
    up.write(`${lines.join("\r\n")}\r\n\r\n`)
    if (head.length) up.write(head)
    socket.pipe(up).pipe(socket)
  })
  up.once("error", () => socket.destroy())
  socket.once("error", () => up.destroy())
})
await new Promise((ready) => front.listen(frontPort, "127.0.0.1", ready))

const failures = []
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures.push(name)
}

const browser = await launchHeadless({ args: ["--ignore-certificate-errors", `--host-resolver-rules=MAP ${HOSTNAME} 127.0.0.1`] })
try {
  const page = await browser.newPage()
  const errors = []
  page.on("pageerror", (error) => errors.push(String(error)))
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()) })

  await page.setViewport({ width: 1280, height: 800 })
  const response = await page.goto(`${ORIGIN}/`, { waitUntil: "networkidle2", timeout: 30_000 })
  console.log(`navigation: ${response.status()} ${response.url()}`)
  await new Promise((settle) => setTimeout(settle, 4_000))

  const probe = await page.evaluate(async () => {
    const out = {
      origin: location.origin,
      secureContext: window.isSecureContext,
      clipboard: typeof navigator.clipboard,
      notification: typeof Notification !== "undefined" ? Notification.permission : "absent",
      title: document.title,
      shell: document.body.innerText.slice(0, 60).replace(/\s+/g, " "),
    }
    const read = await fetch("/_frizz/rpc/board?input=%7B%7D")
    out.rpcRead = read.status
    out.ws = await new Promise((resolve) => {
      const socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}/_frizz/ws`)
      socket.onopen = () => resolve("open")
      socket.onerror = () => resolve("error")
      socket.onclose = (event) => resolve(`closed:${event.code}`)
      setTimeout(() => resolve("timeout"), 4_000)
    })
    return out
  })
  console.log(JSON.stringify(probe, null, 2))

  check("board served at the declared proxy origin", probe.origin === ORIGIN, probe.origin)
  // The whole UX argument for a tunnel over a LAN address: https is a secure context, so the copy
  // buttons and desktop notifications that die over plain http to a LAN IP come back.
  check("secure context restored", probe.secureContext === true)
  check("clipboard API available", probe.clipboard === "object", probe.clipboard)
  check("Notification API available", probe.notification !== "absent", probe.notification)
  check("RPC read accepted", probe.rpcRead === 200, String(probe.rpcRead))
  check("board WebSocket connected", probe.ws === "open", probe.ws)
  // Asserted BEFORE the write probe below, whose deliberately invalid body logs its own console error.
  check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "))

  // A deliberately empty body: 400 proves the request cleared the origin gate and reached validation.
  // 403 would mean the gate refused a write the browser had correctly stamped with an Origin.
  const rpcWrite = await page.evaluate(async () => (await fetch("/_frizz/rpc/setThreadSnooze", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  })).status)
  check("RPC write cleared the origin gate", rpcWrite !== 403, String(rpcWrite))

  await page.screenshot({ path: join(tmpdir(), "frizz-public-origin-desktop.png") })
  await page.setViewport({ width: 420, height: 880 })
  await new Promise((settle) => setTimeout(settle, 1_200))
  await page.screenshot({ path: join(tmpdir(), "frizz-public-origin-narrow.png") })
  console.log(`shots: ${join(tmpdir(), "frizz-public-origin-desktop.png")} ${join(tmpdir(), "frizz-public-origin-narrow.png")}`)
} finally {
  await browser.close()
  front.closeAllConnections()
  await new Promise((closed) => front.close(closed))
  rmSync(certDir, { recursive: true, force: true })
}

if (failures.length) {
  console.log(`\nFAILED: ${failures.join(", ")}`)
  process.exit(1)
}
console.log("\nALL CHECKS PASSED")
