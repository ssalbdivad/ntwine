// HOSTILE live workload for the Claude broker — the gate that would have caught the 2026-07-27
// thread kill before an operator did.
//   nub packages/server/src/backend/_live_broker_hostile.mts
//
// WHY THIS EXISTS. Every end-to-end check written during the t3code spike used a TOY prompt: "reply
// with exactly HELLO-OK", "write a marker file", "count to 5". All of them passed. Then a real
// orchestrator thread died on first contact with reality, because a real agent had run a Bash command
// containing an ANSI escape — a shape no toy prompt ever produces. The strict protocol validators
// threw, and the daemon's pump treated that as the session ending.
//
// The lesson is not "add one test for ANSI escapes". It is that a happy-path e2e prompt proves almost
// nothing about a provider integration, because the whole risk lives in the VALUES the provider sends
// back, and a toy prompt only ever produces clean ones. So this drives a REAL claude session through
// the shapes that actually break validators, and asserts the only thing that finally matters: the
// session is still alive and still answering afterwards.
//
// Every case below is either a shape that HAS broken ntwine or one sitting directly on a bound in
// claude-agent-sdk-protocol.ts. When you add a bound, add a case.
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createClaudeAgentBrokerBridge } from "./claude-agent-broker-bridge.ts"
import { readClaudeBrokerDiagnostics } from "./claude-broker-diagnostics.ts"

const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const stateDir = mkdtempSync(join(tmpdir(), "hostile-state-"))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "hostile-repo-"))); execFileSync("git", ["init", "-q", cwd])
let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Written as escape sequences so the file itself stays clean text — the agent produces the real bytes.
const CASES: Array<{ name: string; instruction: string }> = [
  {
    name: "ANSI escapes in a Bash command (the exact 2026-07-27 thread killer)",
    instruction: String.raw`Run this with Bash exactly: printf '\033[31mRED\033[0m\n'`,
  },
  {
    name: "a control byte in a command argument",
    instruction: String.raw`Run this with Bash exactly: printf 'a\001b\002c\n'`,
  },
  {
    name: "output far past the 128KB event-text bound",
    instruction: String.raw`Run this with Bash exactly: head -c 400000 /dev/zero | tr '\0' 'x'`,
  },
  {
    name: "binary-ish bytes that are not valid UTF-8",
    instruction: String.raw`Run this with Bash exactly: head -c 2048 /dev/urandom | base64 | head -c 400; printf '\n'`,
  },
  {
    name: "unicode the validators care about (bidi, zero-width, astral, combining)",
    instruction: String.raw`Run this with Bash exactly: printf 'RTL:‮reversed‬ ZW:a​b astral:\U0001F600 comb:é\n'`,
  },
  {
    name: "a very long single-line command (bounds the argv/JSON size)",
    instruction: `Run this with Bash exactly: echo "${"y".repeat(6000)}" | wc -c`,
  },
]

const slug = "hostile-live"
const sessionId = randomUUID()
const bridge = createClaudeAgentBrokerBridge({
  stateDir, executablePath: claudeBin,
  env: Object.fromEntries(["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "CLAUDE_CODE_OAUTH_TOKEN"].filter((k) => process.env[k]).map((k) => [k, process.env[k]!])),
})

/** The only assertion that finally matters: is the session still there and still answering? */
async function stillAlive(token: string, timeoutMs = 180_000): Promise<boolean> {
  await bridge.followUp({ threadSlug: slug, sessionId, cwd, text: `Reply with exactly ${token} and nothing else. Do not use any tools.` })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!bridge.isDaemonAlive(sessionId)) return false
    if (readClaudeBrokerDiagnostics(stateDir, sessionId).some((r) => r.diagnostic.kind === "lifecycle" && r.diagnostic.phase === "crashed")) return false
    // Find the transcript by SCANNING for the session id rather than recomputing claude's cwd slug —
    // the slug derivation is claude's, not ntwine's, and getting it subtly wrong makes this helper
    // report a dead session that is in fact perfectly healthy. (It did exactly that on first run.)
    if (transcriptText().includes(token)) return true
    await sleep(2_000)
  }
  return false
}

function transcriptText(): string {
  const root = join(homedir(), ".claude", "projects")
  try {
    for (const dir of readdirSync(root)) {
      const file = join(root, dir, `${sessionId}.jsonl`)
      try { return readFileSync(file, "utf8") } catch { /* not this project dir */ }
    }
  } catch { /* no claude projects dir */ }
  return ""
}

try {
  await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd, prompt: "Reply with exactly READY and stop. Do not use any tools." })
  await sleep(12_000)
  ok("session started", bridge.isDaemonAlive(sessionId))

  for (const [index, testCase] of CASES.entries()) {
    await bridge.followUp({
      threadSlug: slug, sessionId, cwd,
      text: `${testCase.instruction}\n\nThen reply with only the word NEXT. If the command fails, say so and continue — do not stop.`,
    })
    // Give the turn room; these are deliberately big/ugly.
    await sleep(30_000)
    const crashed = readClaudeBrokerDiagnostics(stateDir, sessionId)
      .filter((r) => r.diagnostic.kind === "lifecycle" && r.diagnostic.phase === "crashed")
    ok(
      `case ${index + 1}: ${testCase.name}`,
      bridge.isDaemonAlive(sessionId) && crashed.length === 0,
      crashed.length ? `daemon CRASHED: ${JSON.stringify(crashed.at(-1)?.diagnostic)}` : bridge.isDaemonAlive(sessionId) ? "" : "daemon died with no crash record",
    )
    if (!bridge.isDaemonAlive(sessionId)) break // everything after this is meaningless
  }

  ok("the session still answers after every hostile case", await stillAlive("STILL-HERE"))

  const stream = readClaudeBrokerDiagnostics(stateDir, sessionId)
  const streamErrors = stream.filter((r) => r.diagnostic.kind === "stderr" && /event stream error/.test(r.diagnostic.message))
  console.log(`      event-stream mapping errors tolerated (session survived each): ${streamErrors.length}`)
  for (const e of streamErrors.slice(0, 3)) console.log(`        ${(e.diagnostic as { message: string }).message.slice(0, 160)}`)
} catch (error) {
  failures++
  console.log("FAIL  harness threw —", error)
} finally {
  try { bridge.releaseSession(slug, sessionId, "session-deleted") } catch {}
  try { bridge.close() } catch {}
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
