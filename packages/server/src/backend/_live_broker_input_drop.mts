// LIVE PROBE / REGRESSION: does every follow-up actually reach the agent, emoji included?
//   nub packages/server/src/backend/_live_broker_input_drop.mts
//
// This exists because for a while the answer was NO, silently. The path a broker-backed Claude
// follow-up takes is:
//   router.followUp → bridge.followUp → client.sendInput(...) → daemon → handle.send(message)
// `sendInput` writes a socket frame and returns, the frame carries no reply, and the daemon used to
// `.catch(() => {})` the send. So a message `validateInputMessage` refused was discarded inside the
// daemon with nobody to tell, while ntwine had already answered its RPC with success and opened an
// `enqueued` ledger item that never times out — the operator watched their own message render as
// delivered, forever, and the thread just "went quiet".
//
// The refused class was ordinary text: `UNSAFE_TEXT` rejects \p{Cf}, which contains U+200D ZERO WIDTH
// JOINER, so EVERY multi-part emoji (👩‍💻, 🏳️‍🌈, 👨‍👩‍👧) was undeliverable, along with a pasted BOM, a
// zero-width space and a soft hyphen.
//
// Two things changed: `validateInputMessage` no longer applies the display-grade class to a prompt
// body (so the emoji delivers), and neither layer is allowed to drop a send in silence — the bridge
// validates before the frame so a real refusal fails the operator's own send, and the daemon reports
// what it drops on the diagnostic channel.
//
// The differential this runs, one variable at a time:
//   ALPHA   a plain sentence                    → must be DELIVERED
//   BRAVO   the SAME sentence + one ZWJ emoji   → must be DELIVERED (this is the regression)
//   CHARLIE a plain sentence again              → must be DELIVERED (proves the session stayed healthy,
//                                                 so a BRAVO failure is about BRAVO's bytes)
//
// Recorded before the fix, for comparison: "BRAVO reached the agent: false", sendInput returned
// normally, 0 diagnostics, and the disk showed enqueue=2 / user=2 / assistant=2 for three sends.
import { execFileSync } from "node:child_process"
import { mkdtempSync, openSync, readSync, realpathSync, rmSync, statSync, closeSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { forkBroker, killBroker } from "./claude-broker-host.ts"
import { connectClaudeBroker } from "./claude-broker-client.ts"
import type { ClaudeQueryEvent } from "./claude-agent-sdk-protocol.ts"

const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const stateDir = mkdtempSync(join(tmpdir(), "bdrop-state-"))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "bdrop-repo-")))
execFileSync("git", ["init", "-q", cwd])
const sessionId = randomUUID()
const jsonlPath = join(homedir(), ".claude", "projects", cwd.replace(/\//g, "-"), `${sessionId}.jsonl`)

const t0 = Date.now()
const at = (): string => `t+${String(Date.now() - t0).padStart(6)}ms`

const ID_A = randomUUID()
const ID_B = randomUUID()
const ID_C = randomUUID()

// The one variable: BRAVO is ALPHA's shape with a single ZWJ emoji glued on the end.
const ALPHA = "Reply with exactly ALPHA-SEEN and nothing else."
const BRAVO = "Reply with exactly BRAVO-SEEN and nothing else. \u{1F469}‍\u{1F4BB}"
const CHARLIE = "Reply with exactly CHARLIE-SEEN and nothing else."

console.log(`session   ${sessionId}`)
console.log(`jsonl     ${jsonlPath}`)
console.log(`ALPHA     ${JSON.stringify(ALPHA)}`)
console.log(`BRAVO     ${JSON.stringify(BRAVO)}   ← contains U+200D`)
console.log(`CHARLIE   ${JSON.stringify(CHARLIE)}\n`)

// ── disk tail ─────────────────────────────────────────────────────────────────────────────────────
let offset = 0
let pending = ""
const diskLines: Array<{ ms: number; rec: Record<string, unknown> }> = []
function drainDisk(): void {
  let size = 0
  try { size = statSync(jsonlPath).size } catch { return }
  if (size <= offset) return
  const fd = openSync(jsonlPath, "r")
  const buf = Buffer.alloc(size - offset)
  readSync(fd, buf, 0, buf.length, offset)
  closeSync(fd)
  offset = size
  pending += buf.toString("utf8")
  const lines = pending.split("\n")
  pending = lines.pop() ?? ""
  for (const line of lines) {
    if (!line.trim()) continue
    try { diskLines.push({ ms: Date.now() - t0, rec: JSON.parse(line) as Record<string, unknown> }) } catch { /* partial */ }
  }
}
const diskTimer = setInterval(drainDisk, 25)

// ── the live broker ───────────────────────────────────────────────────────────────────────────────
const env = Object.fromEntries(
  ["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"]
    .filter((k) => process.env[k]).map((k) => [k, process.env[k]!]),
)
const record = await forkBroker({ stateDir, cwd, sessionId, executablePath: claudeBin, env, permissionMode: "bypassPermissions" })

const events: Array<{ ms: number; event: ClaudeQueryEvent }> = []
const diagnostics: Array<{ ms: number; diagnostic: unknown }> = []
let results = 0
const client = connectClaudeBroker(record.socketPath, {
  onEvent: (event) => {
    events.push({ ms: Date.now() - t0, event })
    if (event.kind === "result") results++
    const anyEvent = event as unknown as Record<string, unknown>
    const text = Array.isArray(anyEvent.text) ? (anyEvent.text as string[]).join(" ") : ""
    console.log(`EVENT ${at()} kind=${event.kind} text=${JSON.stringify(text.slice(0, 80))}`)
  },
  onPermissionRequest: (requestId) => client.answerPermission(requestId, { behavior: "allow" }),
  // EVERY diagnostic is captured: if the daemon says anything at all about the dropped input, it
  // would have to arrive here. Silence here is the finding.
  onDiagnostic: (d) => { diagnostics.push({ ms: Date.now() - t0, diagnostic: d }); console.log(`DIAG  ${at()} ${JSON.stringify(d).slice(0, 240)}`) },
})

const waitFor = async (pred: () => boolean, ms: number, what: string): Promise<boolean> => {
  const deadline = Date.now() + ms
  while (!pred()) {
    if (Date.now() > deadline) { console.log(`WAIT  ${at()} TIMEOUT waiting for ${what}`); return false }
    await new Promise((r) => setTimeout(r, 25))
  }
  return true
}
const sawReply = (marker: string): boolean => events.some((e) => {
  const anyEvent = e.event as unknown as Record<string, unknown>
  return Array.isArray(anyEvent.text) && (anyEvent.text as string[]).join(" ").includes(marker)
})
// The provider's own receipt for an accepted input: it writes a `user` (or queued_command) record
// carrying the text. Absence of ANY disk record naming the message is the drop.
const onDisk = (needle: string): boolean => diskLines.some((d) => JSON.stringify(d.rec).includes(needle))

let alphaOk = false
let bravoAnywhere = true
let charlieOk = false
let sendThrew: string | null = null

try {
  console.log(`SEND  ${at()} ALPHA (plain)`)
  client.sendInput({ id: ID_A, text: ALPHA })
  alphaOk = await waitFor(() => sawReply("ALPHA-SEEN"), 180_000, "ALPHA's reply")
  await waitFor(() => results >= 1, 30_000, "ALPHA's turn to settle")

  console.log(`\nSEND  ${at()} BRAVO (same shape + ZWJ emoji)`)
  // Does the CLIENT see anything? sendInput is sync and returns void — capture a throw if it ever does.
  try { client.sendInput({ id: ID_B, text: BRAVO }) } catch (error) { sendThrew = error instanceof Error ? error.message : String(error) }
  // Give it as long as ALPHA took, plus slack. If BRAVO were accepted this is far more than enough.
  await new Promise((r) => setTimeout(r, 45_000))
  drainDisk()
  bravoAnywhere = sawReply("BRAVO-SEEN") || onDisk("BRAVO-SEEN")

  console.log(`\nSEND  ${at()} CHARLIE (plain — is the session still alive?)`)
  client.sendInput({ id: ID_C, text: CHARLIE })
  charlieOk = await waitFor(() => sawReply("CHARLIE-SEEN"), 180_000, "CHARLIE's reply")
  await new Promise((r) => setTimeout(r, 2_000))
  drainDisk()

  console.log("\n──────── ANALYSIS ────────")
  console.log(`ALPHA   delivered:            ${alphaOk}`)
  console.log(`BRAVO   reached the agent:    ${bravoAnywhere}   (reply seen=${sawReply("BRAVO-SEEN")}, any disk record=${onDisk("BRAVO-SEEN")})`)
  console.log(`BRAVO   sendInput threw:      ${sendThrew ?? "NO — returned normally"}`)
  console.log(`BRAVO   diagnostics naming it: ${diagnostics.filter((d) => JSON.stringify(d.diagnostic).includes("input")).length} of ${diagnostics.length} total`)
  console.log(`CHARLIE delivered:            ${charlieOk}   ← session still healthy after the drop`)
  // Asserts the FIXED behaviour: all three land. Before the fix this same run printed
  // "BRAVO reached the agent: false" with disk types enqueue=2/user=2/assistant=2 — the emoji message
  // gone, sendInput returned normally, zero diagnostics.
  const verdict = alphaOk && bravoAnywhere && charlieOk
  console.log(`\nVERDICT: ${verdict ? "OK — every follow-up reached the agent, emoji included" : "REGRESSED — a follow-up did not reach the agent; read the trace above"}`)

  console.log("\n──────── DISK TYPES ────────")
  const types = new Map<string, number>()
  for (const d of diskLines) {
    const k = `${String(d.rec.type)}${d.rec.operation ? `/${String(d.rec.operation)}` : ""}`
    types.set(k, (types.get(k) ?? 0) + 1)
  }
  console.log([...types].map(([k, n]) => `${k}=${n}`).join(" "))
  console.log(`\nkept jsonl: ${jsonlPath}`)
} catch (err) {
  console.log(`ERROR ${err instanceof Error ? err.stack : String(err)}`)
} finally {
  clearInterval(diskTimer)
  try { client.close() } catch {}
  try { killBroker(stateDir, sessionId) } catch {}
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}
