// Drives the REAL proxy through a REAL TLS origin in a REAL browser, to prove the single-use code
// flow end to end: redeem, keep the session, and watch the spent code die in a fresh browser.
//
// The child here is a stub on purpose — this exercises the GATE, not the Frizz control plane, and a
// stub makes the failure unambiguous when it fails. The x-forwarded-* headers match what a real
// cloudflared sends (measured 2026-08-03), so the origin policy is exercised as it is in production.
//
//   nub scripts/verify-access-codes.mjs
import { launchHeadless } from "./lib/headless-browser.mjs"
import { createServer as createHttps } from "node:https"
import { createServer as createHttp, request as httpRequest } from "node:http"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RestartSupervisorProxy } from "../packages/server/src/restart-supervisor.ts"

const HOST = "frizz.local.test", FRONT = 8446, ORIGIN = `https://${HOST}:${FRONT}`
const fails = []
const check = (n, ok, d) => { console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? ` — ${d}` : ""}`); if (!ok) fails.push(n) }

// Stub child: stands in for the Frizz control plane; this test is about the GATE.
const child = createHttp((req, res) => { res.writeHead(200, {"content-type":"text/html"}); res.end("<title>board</title><h1>board</h1>") })
await new Promise((r) => child.listen(0, "127.0.0.1", r))
const childPort = child.address().port

let consumed = 0
const proxy = new RestartSupervisorProxy({
  port: 5906, publicOrigin: ORIGIN, childPort: () => childPort,
  onCodeConsumed: () => { consumed++ }, restart: async () => ({ state: "ready" }),
})
await proxy.listen()

const dir = mkdtempSync(join(tmpdir(), "frizz-codes-"))
execFileSync("openssl", ["req","-x509","-newkey","rsa:2048","-nodes","-keyout",join(dir,"k.pem"),"-out",join(dir,"c.pem"),
  "-days","1","-subj",`/CN=${HOST}`,"-addext",`subjectAltName=DNS:${HOST}`], { stdio: "ignore" })
const CF = { "x-forwarded-for": "203.0.113.7", "x-forwarded-proto": "https" }
const front = createHttps({ key: readFileSync(join(dir,"k.pem")), cert: readFileSync(join(dir,"c.pem")) }, (req, res) => {
  const up = httpRequest({ host:"127.0.0.1", port:5906, method:req.method, path:req.url, headers:{...req.headers, ...CF} },
    (ur) => { res.writeHead(ur.statusCode ?? 502, ur.headers); ur.pipe(res) })
  up.once("error", () => { if (!res.headersSent) res.writeHead(502); res.end("x") })
  req.pipe(up)
})
await new Promise((r) => front.listen(FRONT, "127.0.0.1", r))

const browser = await launchHeadless({ args: ["--ignore-certificate-errors", `--host-resolver-rules=MAP ${HOST} 127.0.0.1`] })
try {
  const page = await browser.newPage()
  const bare = await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" })
  check("no code -> 401", bare.status() === 401, String(bare.status()))

  const link = proxy.issueAccessCode()
  const url = proxy.accessUrl(link.code)
  const redeemed = await page.goto(url, { waitUntil: "domcontentloaded" })
  check("code redeems and lands on the board", redeemed.status() === 200, String(redeemed.status()))
  check("the code is stripped from the URL", !page.url().includes("frizz_code"), page.url())
  check("consumption fired once", consumed === 1, String(consumed))

  const again = await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" })
  check("session persists on a later plain visit", again.status() === 200, String(again.status()))

  // A DIFFERENT browser replaying the spent code must be refused.
  const other = await browser.createBrowserContext()
  const p2 = await other.newPage()
  const replay = await p2.goto(url, { waitUntil: "domcontentloaded" })
  check("spent code is refused in a fresh browser", replay.status() === 401, String(replay.status()))
  check("and it says why", (await p2.content()).includes("already been used"))
  check("replay did not re-fire consumption", consumed === 1, String(consumed))
} finally {
  await browser.close()
  front.closeAllConnections(); await new Promise((r) => front.close(r))
  await proxy.close().catch(() => {})
  child.closeAllConnections(); await new Promise((r) => child.close(r))
  rmSync(dir, { recursive: true, force: true })
}
console.log(fails.length ? `\nFAILED: ${fails.join(", ")}` : "\nALL CHECKS PASSED")
process.exit(fails.length ? 1 : 0)
