// Ad hoc proof for the USAGE-LIMIT LATCH fix, exercised against real modules end to end — a real
// transcript, the real tailer fold, the real predicate, a real forked broker daemon, and real child
// processes. No mocks anywhere on the path under test.
//
// THE BUG (measured live 2026-07-30, five threads). A `claude` process that takes a usage-limit 429
// LATCHES: every later input is refused by the process itself, in ~1s, with a byte-identical synthetic
// record naming the same reset clock, until that reset arrives. Nothing delivered over the existing
// session clears it — not a "continue", not a rotated credential. Meanwhile ntwine's account-headroom
// auto-resume trigger reads the ACCOUNT (which a credential rotator had just made healthy), so it kept
// firing a resume into that deaf process every 2 minutes for half an hour, writing 184 limit records
// into one worker's transcript and never recovering the thread.
//
// THE FIX, and what this harness asserts:
//   1. the real tailer folds the real synthetic record into a `limitFault`;
//   2. `needsFreshProcessForLimit` says "restart" while the stated reset is still ahead, and "don't"
//      once it has passed (the case that always worked — the live process's own latch expired with it);
//   3. `deliverClaudeBrokerWake` carrying that verdict actually SWAPS the process: a new daemon, a new
//      generation, and a second `claude` started with `--resume <same session>` so the transcript
//      survives;
//   4. the NEGATIVE control — the same wake without the verdict must reconnect and change nothing.
//
// Usage: nub scripts/verify-limit-fresh-process.mjs   (exit 0 = all green)
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createStorage } from "../packages/server/src/storage.ts"
import { createTailer } from "../packages/server/src/tailer.ts"
import { Bus } from "../packages/server/src/bus.ts"
import { createClaudeAgentBrokerBridge } from "../packages/server/src/backend/claude-agent-broker-bridge.ts"
import { claudeBrokerRecordPath, readBrokerRecord } from "../packages/server/src/backend/claude-broker-host.ts"
import { deliverClaudeBrokerWake, needsFreshProcessForLimit } from "../packages/server/src/context.ts"

const results = []
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const root = mkdtempSync(join(tmpdir(), "verify-limit-fresh-"))
const exe = join(root, "fake-claude--basic.mjs")
copyFileSync(new URL("../packages/server/src/backend/claude-agent-sdk.fixtures/fake-claude-cli.mjs", import.meta.url), exe)
chmodSync(exe, 0o700)

const SLUG = "latched-thread"
const SESSION = randomUUID()
const project = { id: randomUUID(), dir: root, cwdSlug: root.replace(/[/.]/g, "-"), stateDir: root }

// ---- the REAL transcript: the exact synthetic record claude writes when a window is exhausted -------
const logDir = join(root, "logs")
mkdirSync(logDir, { recursive: true })
const jsonl = join(logDir, `${SESSION}.jsonl`)
// 10:06 PDT, reset stated as 11:20am — the real incident's numbers.
const FAULT_AT = "2026-07-30T17:06:32.756Z"
const RESET_MS = Date.parse("2026-07-30T18:20:00.000Z")
writeFileSync(jsonl, [
  JSON.stringify({ type: "user", timestamp: "2026-07-30T17:00:00.000Z", sessionId: SESSION, message: { role: "user", content: "keep going" } }),
  JSON.stringify({
    type: "assistant", timestamp: FAULT_AT, sessionId: SESSION,
    message: { model: "<synthetic>", stop_reason: "stop_sequence", role: "assistant", content: [{ type: "text", text: "You've hit your session limit · resets 11:20am (America/Los_Angeles)" }] },
    error: "rate_limit", apiErrorStatus: 429, isApiErrorMessage: true,
  }),
].join("\n") + "\n")

const storage = createStorage(join(root, "ui.db"))
storage.upsertSession({
  slug: SLUG, session_id: SESSION, thread_name: `ntwine-${SLUG}`, spawned_at: FAULT_AT,
  last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
  title: "latched", state: "open", meta: null, seen_at: null, transcript_id: null,
})
storage.setBackend(SLUG, "claude")
storage.setClaudeRuntime(SLUG, "broker")

const tailer = createTailer({
  project, storage, bus: new Bus(), onChange: () => {},
  sessionLogDir: logDir,
  paneDead: () => false, capturePane: () => "",
  tailCache: null,
})

const bridge = createClaudeAgentBrokerBridge({
  stateDir: root, executablePath: exe,
  env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
})

const startups = () => {
  try {
    return readFileSync(join(root, "capture.jsonl"), "utf8").split("\n").filter(Boolean)
      .map((l) => JSON.parse(l)).filter((r) => r.kind === "startup")
  } catch { return [] }
}
const waitForStartups = async (n, ms = 10_000) => {
  const deadline = Date.now() + ms
  while (startups().length < n && Date.now() < deadline) await sleep(50)
  return startups().length
}
const recordOf = () => readBrokerRecord(claudeBrokerRecordPath(root, SESSION))
const wake = (freshProcess) => deliverClaudeBrokerWake({
  bridge, slug: SLUG, cwd: root,
  row: { session_id: SESSION, model: "opus", effort: "xhigh", permission_mode: "auto" },
  deliveryMessage: "⏳ The session usage limit that interrupted you has reset. Continue exactly where you left off.",
  freshProcess,
})

try {
  // ---- 1. the REAL tailer folds the REAL record ----------------------------------------------------
  tailer.tick()
  const fault = tailer.get(SLUG)?.limitFault
  check("the tailer folds the synthetic 429 into a limitFault", fault?.window === "session", `window=${fault?.window}`)
  check("…carrying the provider's stated reset clock", fault?.resetClock?.hour === 11 && fault?.resetClock?.minute === 20,
    JSON.stringify(fault?.resetClock))

  // ---- 2. the REAL predicate ------------------------------------------------------------------------
  check("BEFORE the stated reset → a fresh process is required",
    needsFreshProcessForLimit(fault, RESET_MS - 60_000) === true)
  check("AFTER the stated reset → the live process is fine (the case that always worked)",
    needsFreshProcessForLimit(fault, RESET_MS + 60_000) === false)
  check("a thread with a LIVE sub-agent is exempt (the completion invariant)",
    needsFreshProcessForLimit(fault, RESET_MS - 60_000, true) === false)
  check("no fault at all → never restarts anything",
    needsFreshProcessForLimit(undefined, RESET_MS - 60_000) === false)

  // ---- 3./4. the REAL bridge, REAL daemon, REAL child processes -------------------------------------
  await bridge.spawnDispatch({ threadSlug: SLUG, sessionId: SESSION, cwd: root, prompt: "start the work", permissionMode: "auto" })
  const first = recordOf()
  check("a broker daemon is running for the thread", !!first, `pid=${first?.daemonPid}`)
  check("…and it started a claude", (await waitForStartups(1)) === 1)

  // NEGATIVE CONTROL: an ordinary wake must reconnect, never restart. Without this the assertions below
  // would pass just as well against code that restarts on EVERY follow-up.
  await wake(false)
  check("CONTROL: a wake with no fresh-process verdict keeps the same daemon",
    recordOf()?.daemonPid === first.daemonPid && recordOf()?.generation === first.generation)
  check("CONTROL: …and spawns no second claude", startups().length === 1)

  // The real thing: the verdict the wiring computes from the real fault.
  await wake(needsFreshProcessForLimit(fault, RESET_MS - 60_000))
  const second = recordOf()
  check("the limit wake SWAPS the process", !!second && second.daemonPid !== first.daemonPid,
    `${first.daemonPid} → ${second?.daemonPid}`)
  check("…under a new generation, so ntwine knows the runtime changed", second?.generation !== first.generation)
  check("…keeping the thread's session identity", second?.sessionId === SESSION)
  check("…and a second claude actually started", (await waitForStartups(2)) === 2)
  const replacement = startups()[1]
  check("…cold-resuming the on-disk transcript, so no work is lost",
    replacement?.argv?.includes("--resume") && replacement?.argv?.includes(SESSION),
    JSON.stringify(replacement?.argv?.slice(0, 8)))
  check("…where the original was a fresh start (proving these are two different processes)",
    !startups()[0]?.argv?.includes("--resume"))
} finally {
  try { bridge.releaseSession(SLUG, SESSION, "session-deleted") } catch {}
  try { bridge.close() } catch {}
  try { const r = recordOf(); if (r) process.kill(r.daemonPid, "SIGKILL") } catch {}
  try { tailer.stop() } catch {}
  try { storage.close() } catch {}
  await sleep(300)
  try { rmSync(root, { recursive: true, force: true }) } catch {}
}

const failed = results.filter((ok) => !ok).length
console.log(`\n${failed === 0 ? "ALL GREEN" : `${failed} FAILED`} — ${results.length} checks`)
process.exit(failed === 0 ? 0 : 1)
