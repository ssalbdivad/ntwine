// CI test for the two things the Claude broker was missing next to the codex app-server: an EAGER boot
// reattach (`warmUp`), and a named cause for a daemon death.
//
// Driven by the FAKE claude CLI against a REAL forked daemon over a real socket — the ntwine restart is
// simulated the way it actually happens (the bridge's clients go away; the detached daemon does not),
// so the assertion is about the real reconnect path, not a stand-in for it.
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID, createHash } from "node:crypto"
import { test } from "node:test"
import assert from "node:assert/strict"
import Database from "../sqlite.ts"
import { createInteractionStore } from "../interaction-store.ts"
import { createClaudeAgentBrokerBridge } from "./claude-agent-broker-bridge.ts"
import { runClaudeBroker } from "./claude-agent-broker.ts"
import { ntwineIpcPath } from "./ipc-path.ts"
import { brokerLastKnownPath, claudeBrokerRecordPath, liveBrokerRecords, readBrokerRecord } from "./claude-broker-host.ts"
import { claudeBrokerDiagnosticLogPath, readClaudeBrokerExit } from "./claude-broker-diagnostics.ts"

const fakeCli = fileURLToPath(new URL("./claude-agent-sdk.fixtures/fake-claude-cli.mjs", import.meta.url))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function rmEventually(dir: string, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    try { rmSync(dir, { recursive: true, force: true }); return } catch (error) {
      if (Date.now() > deadline) throw error
      await sleep(50)
    }
  }
}

async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timeout")
    await sleep(50)
  }
}

function fakeExe(dir: string, scenario: string): string {
  const exe = join(dir, `fake-claude--${scenario}.mjs`)
  copyFileSync(fakeCli, exe); chmodSync(exe, 0o700)
  return exe
}

// THE test for warmUp, with its own control in the same run.
//
// A tool-permission escalation is raised while ntwine is DOWN: ntwine #1 never answers it, then goes away
// without touching the daemon. The daemon holds the canUseTool promise and re-delivers it to whoever
// attaches next — but before warmUp() nothing ever attached, so the card never appeared and the thread
// sat blocked on a promise nobody could answer until a human sent it a follow-up.
test("warmUp reattaches a live daemon at boot and routes a permission raised while ntwine was down", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-warm-"))
  const exe = fakeExe(dir, "permission")
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }
  const sessionId = randomUUID()
  const slug = "warm-thread"
  const scope = { projectId: "proj-warm", threadSlug: slug, sessionId }

  // ntwine #1: no dashboard store, and a decision hook that NEVER answers — the escalation is raised and
  // left hanging, exactly as it would be if ntwine died between the request and the human seeing it.
  let escalations = 0
  const first = createClaudeAgentBrokerBridge({
    stateDir: dir, executablePath: exe, env,
    decidePermission: () => { escalations++; return new Promise(() => {}) },
  })
  const store = createInteractionStore(new Database(":memory:"))
  let second: ReturnType<typeof createClaudeAgentBrokerBridge> | undefined
  try {
    await first.spawnDispatch({ threadSlug: slug, sessionId, cwd: dir, prompt: "do the thing", permissionMode: "default" })
    await waitFor(() => escalations > 0)
    // ntwine #1 goes away. close() drops the sockets and deliberately leaves the daemon running — that IS
    // the restart, and it is why the broker exists.
    first.close()
    await sleep(300)
    assert.ok(readBrokerRecord(claudeBrokerRecordPath(dir, sessionId)), "the detached daemon outlived ntwine #1")

    // ntwine #2 boots. Constructed exactly as context.ts constructs it, ownedSessions included.
    second = createClaudeAgentBrokerBridge({
      stateDir: dir, executablePath: exe, env,
      interactions: store, projectId: "proj-warm",
      ownedSessions: () => [{ threadSlug: slug, sessionId, cwd: dir }],
    })
    // CONTROL: constructing the bridge is not enough. This is the pre-warmUp behavior — the daemon is
    // alive and holding the request, and the dashboard shows nothing at all.
    await sleep(1_000)
    assert.equal(store.listPending(scope).length, 0, "without warmUp the escalation is still unrouted")
    assert.equal(second.binding(slug, sessionId), undefined, "without warmUp the bridge holds no session")

    await second.warmUp()
    await waitFor(() => store.listPending(scope).length > 0)
    const [rec] = store.listPending(scope)
    assert.equal(rec.payload.kind, "permission-approval", "the re-delivered escalation became an approval card")
    assert.equal(rec.provider.kind, "claude")
    assert.ok(second.binding(slug, sessionId), "warmUp holds the session live, so the board can see the turn")
  } finally {
    second?.releaseSession(slug, sessionId, "session-deleted")
    second?.close()
    first.close()
    try { const r = readBrokerRecord(claudeBrokerRecordPath(dir, sessionId)); if (r) process.kill(r.daemonPid, "SIGKILL") } catch {}
    await rmEventually(dir)
  }
})

// The dangerous failure mode of an eager reattach: forking. adoptOrForkBroker cold-starts a
// `{kind:"new"}` session when no daemon is live, which at boot would silently mint a fresh empty
// session on a real thread's id — over its transcript, with nobody asking. warmUp must only ever adopt.
test("warmUp never forks a daemon for a session whose daemon is gone", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-nofork-"))
  const exe = fakeExe(dir, "permission")
  const sessionId = randomUUID()
  const bridge = createClaudeAgentBrokerBridge({
    stateDir: dir, executablePath: exe,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    ownedSessions: () => [{ threadSlug: "ghost", sessionId, cwd: dir }],
  })
  try {
    await bridge.warmUp()
    await sleep(500)
    assert.equal(bridge.isDaemonAlive(sessionId), false, "no daemon was started")
    assert.equal(bridge.binding("ghost", sessionId), undefined, "no session was bound")
    assert.equal(existsSync(claudeBrokerRecordPath(dir, sessionId)), false, "no record was published")
  } finally {
    bridge.close()
    await rmEventually(dir)
  }
})

test("warmUp is a no-op without an ownedSessions resolver, and never throws", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-noop-"))
  const bridge = createClaudeAgentBrokerBridge({
    stateDir: dir, executablePath: fakeExe(dir, "permission"),
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
  })
  try {
    await bridge.warmUp() // must resolve, not reject — a boot never fails on the broker
  } finally {
    bridge.close()
    await rmEventually(dir)
  }
})

// A boot must survive an ownedSessions resolver that throws (a half-open DB during shutdown) and a
// state dir that has no broker directory at all (a project that has never dispatched one).
test("warmUp swallows a throwing resolver and an absent record directory", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-hostile-"))
  const exe = fakeExe(dir, "permission")
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }
  const throwing = createClaudeAgentBrokerBridge({
    stateDir: dir, executablePath: exe, env,
    ownedSessions: () => { throw new Error("db closed") },
  })
  try { await throwing.warmUp() } finally { throwing.close() }
  assert.deepEqual(liveBrokerRecords(join(dir, "does-not-exist")), [], "an absent record dir reads as none")
  await rmEventually(dir)
})

// ---- death attribution -------------------------------------------------------------------------

test("a broker records WHY it exited — ntwine asked for it", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-exit-"))
  const exe = fakeExe(dir, "basic")
  const sessionId = randomUUID()
  const socketPath = ntwineIpcPath(`cbx-${createHash("sha256").update(randomUUID()).digest("hex").slice(0, 16)}`)
  const broker = runClaudeBroker({
    socketPath, cwd: dir, sessionId, executablePath: exe, permissionMode: "default",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    diagnosticLogPath: claudeBrokerDiagnosticLogPath(dir, sessionId),
  })
  try {
    await sleep(400)
    assert.equal(readClaudeBrokerExit(dir, sessionId, broker.generation), null, "a living daemon has recorded no death")
    await broker.close()
    const exit = readClaudeBrokerExit(dir, sessionId, broker.generation)
    assert.ok(exit, "the daemon recorded its exit")
    assert.equal(exit.exit.reason, "ntwine-requested")
    assert.equal(exit.daemonPid, process.pid)
    assert.equal(exit.generation, broker.generation, "the record names the generation that died")
    // The defect this argument exists for: the log is per SESSION, so it still holds this death after the
    // next daemon starts. Asked about a DIFFERENT generation it must answer "nothing recorded", not hand
    // back its predecessor's cause and timestamp dressed as the current one.
    assert.equal(
      readClaudeBrokerExit(dir, sessionId, randomUUID()), null,
      "another generation's death is not this daemon's death",
    )
    assert.equal(
      readClaudeBrokerExit(dir, sessionId, ""), null,
      "an unidentified daemon gets no answer rather than a guess",
    )
  } finally {
    try { rmSync(socketPath, { force: true }) } catch {}
    await rmEventually(dir)
  }
})

// The most common broker death there is: ntwine's own killBroker, an operator `kill`, an OS shutdown.
// The signal handler exits IMMEDIATELY by design and never reaches shutdown(), so before this it left
// no trace whatsoever.
//
// POSIX ONLY, because the breadcrumb is written FROM the signal handler and Windows has no signals to
// handle: `process.kill(pid, "SIGTERM")` there is a TerminateProcess, which ends the daemon without
// running any handler. Measured on Windows Server 2022 / node 26.7.0 against a macOS control — a child
// with a `SIGTERM` listener writes its mark and exits 0 on darwin, and on win32 writes nothing and
// exits 1. So on Windows a killed broker's death is unattributed; the bridge still notices the dead pid
// and cold-resumes the thread, it just cannot say what killed it.
test("a SIGTERMed daemon records signal-SIGTERM, and the bridge reports it", {
  timeout: 30_000,
  skip: process.platform === "win32" && "no POSIX signals on win32 — a kill runs no handler, so there is no breadcrumb to write",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-sig-"))
  const exe = fakeExe(dir, "permission")
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }
  const sessionId = randomUUID()
  const slug = "sig-thread"
  const deaths: string[] = []
  const bridge = createClaudeAgentBrokerBridge({
    stateDir: dir, executablePath: exe, env,
    decidePermission: () => new Promise(() => {}),
    onDiagnostic: (_s, _sid, d) => { if (d.kind === "lifecycle" && d.phase === "crashed") deaths.push(d.message ?? "") },
  })
  try {
    await bridge.spawnDispatch({ threadSlug: slug, sessionId, cwd: dir, prompt: "go", permissionMode: "default" })
    const record = readBrokerRecord(claudeBrokerRecordPath(dir, sessionId))
    assert.ok(record, "the daemon published a record")
    process.kill(record.daemonPid, "SIGTERM")
    await waitFor(() => bridge.isDaemonAlive(sessionId) === false)
    const exit = bridge.daemonExit(sessionId)
    assert.ok(exit, "the killed daemon left a breadcrumb")
    assert.equal(exit.exit.reason, "signal-SIGTERM")
    assert.equal(exit.generation, record.generation, "the breadcrumb names the generation that died")

    // A follow-up now has to COLD-START — the moment the bridge discovers the death — and that is where
    // it attributes it instead of leaving the operator with "the thread went quiet".
    await bridge.followUp({ threadSlug: slug, sessionId, cwd: dir, text: "still there?" })
    await waitFor(() => deaths.length > 0, 5_000)
    assert.match(deaths[0], /signal-SIGTERM/)
    // And the follow-up actually landed somewhere: a NEW daemon generation is serving the thread. The
    // bridge used to keep the corpse in its session map, so the operator's message queued in a socket
    // that never came back and the thread simply never answered.
    const resumed = readBrokerRecord(claudeBrokerRecordPath(dir, sessionId))
    assert.ok(resumed && resumed.generation !== record.generation, "the follow-up cold-resumed a fresh daemon")
    // ...once. A death is a one-time fact, not something to re-announce on every later follow-up.
    const before = deaths.length
    await bridge.followUp({ threadSlug: slug, sessionId, cwd: dir, text: "and again" })
    await sleep(500)
    assert.equal(deaths.length, before, "the same death is reported once, not on every follow-up")
  } finally {
    bridge.releaseSession(slug, sessionId, "session-deleted")
    bridge.close()
    try { const r = readBrokerRecord(claudeBrokerRecordPath(dir, sessionId)); if (r) process.kill(r.daemonPid, "SIGKILL") } catch {}
    await rmEventually(dir)
  }
})

test("a dead daemon that left no breadcrumb reads as an absent record, never a throw", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-none-"))
  const bridge = createClaudeAgentBrokerBridge({
    stateDir: dir, executablePath: fakeExe(dir, "basic"),
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
  })
  try {
    assert.equal(bridge.daemonExit(randomUUID()), null)
    // A truncated final line is the normal shape of a log whose writer was killed mid-append.
    const sessionId = randomUUID()
    const path = claudeBrokerDiagnosticLogPath(dir, sessionId)
    rmSync(join(dir, "claude-broker"), { recursive: true, force: true })
    const { mkdirSync } = await import("node:fs")
    mkdirSync(join(dir, "claude-broker"), { recursive: true })
    writeFileSync(path, `{"at":"2026-01-01T00:00:00.000Z","daemonPid":1,"generation":"g","exit":{"reason":"idle-timeout"}}\n{"at":"trunc`)
    // The identity a real daemon leaves behind when its record is deleted. Without it the log is a pile
    // of deaths nobody can attribute, and daemonExit correctly declines to guess — asserted just below.
    writeFileSync(brokerLastKnownPath(claudeBrokerRecordPath(dir, sessionId)), JSON.stringify({ daemonPid: 1, generation: "g", sessionId, socketPath: "", createdAt: "2026-01-01T00:00:00.000Z" }))
    const exit = bridge.daemonExit(sessionId)
    assert.equal(exit?.exit.reason, "idle-timeout", "the last INTACT exit line wins over a torn tail")
    // Same log, no surviving identity: the honest answer is "nothing recorded for that daemon", never
    // generation g's cause handed to whoever asked.
    rmSync(brokerLastKnownPath(claudeBrokerRecordPath(dir, sessionId)), { force: true })
    assert.equal(bridge.daemonExit(sessionId), null, "an unattributable log is not an answer")
    assert.deepEqual(readdirSync(join(dir, "claude-broker")).filter((n) => n.endsWith(".json")), [], "a diagnostics log is not a record")
  } finally {
    bridge.close()
    await rmEventually(dir)
  }
})

// ---- the auto-compact ceiling survives the restart that outlives the daemon ------------------------
// The ceiling is a FORK-TIME property — Settings' own help says a running thread keeps the value it was
// forked with — so the board's context denominator cannot be re-derived from Settings when the dial is
// drawn. It comes off the daemon's own record, which is the only thing left after ntwine #1 is gone.
test("a reattach reports the ceiling the DAEMON was forked with, not the one Settings holds now", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrk-ceiling-"))
  const exe = fakeExe(dir, "basic")
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }
  const sessionId = randomUUID()
  const slug = "ceiling-thread"
  const first = createClaudeAgentBrokerBridge({
    stateDir: dir, executablePath: exe, env,
    getSettings: () => ({ autoCompactWindow: 500_000 }),
  })
  let second: ReturnType<typeof createClaudeAgentBrokerBridge> | undefined
  try {
    await first.spawnDispatch({ threadSlug: slug, sessionId, cwd: dir, prompt: "do the thing", permissionMode: "default" })
    const recordPath = claudeBrokerRecordPath(dir, sessionId)
    assert.equal(readBrokerRecord(recordPath)?.compactionWindow, 500_000)
    first.close() // the restart: the sockets go, the detached daemon stays
    await sleep(300)

    // ntwine #2 boots with the drawer moved to 200K. The DAEMON is still the 500K one, and saying 200K
    // would understate the room a running thread has by more than half.
    const adopted: Array<number | undefined> = []
    second = createClaudeAgentBrokerBridge({
      stateDir: dir, executablePath: exe, env,
      getSettings: () => ({ autoCompactWindow: 200_000 }),
      onCompactionWindow: (_sessionId, window) => adopted.push(window),
      ownedSessions: () => [{ threadSlug: slug, sessionId, cwd: dir }],
    })
    await second.warmUp()
    await waitFor(() => adopted.length > 0)
    assert.deepEqual(adopted, [500_000], "the record outranks today's Settings")

    // A daemon forked by a build that predates the field says nothing, and the environment ntwine would
    // compose for it now is then the closest true statement there is — never silently no ceiling at all,
    // which would put the dial back to dividing by the model's whole window.
    const record = readBrokerRecord(recordPath)!
    delete (record as { compactionWindow?: number }).compactionWindow
    writeFileSync(recordPath, JSON.stringify(record))
    second.close()
    await sleep(300)
    const preField: Array<number | undefined> = []
    const third = createClaudeAgentBrokerBridge({
      stateDir: dir, executablePath: exe, env,
      getSettings: () => ({ autoCompactWindow: 200_000 }),
      onCompactionWindow: (_sessionId, window) => preField.push(window),
      ownedSessions: () => [{ threadSlug: slug, sessionId, cwd: dir }],
    })
    second = third
    await third.warmUp()
    await waitFor(() => preField.length > 0)
    assert.deepEqual(preField, [200_000], "a pre-field record falls back to the composed environment")
  } finally {
    second?.releaseSession(slug, sessionId, "session-deleted")
    second?.close()
    first.close()
    try { const r = readBrokerRecord(claudeBrokerRecordPath(dir, sessionId)); if (r) process.kill(r.daemonPid, "SIGKILL") } catch {}
    await rmEventually(dir)
  }
})
