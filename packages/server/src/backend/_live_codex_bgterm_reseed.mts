// LIVE PROBE: does a codex background exec's row survive an Ntwine restart that rejoins the same app-server?
//   nub packages/server/src/backend/_live_codex_bgterm_reseed.mts
//   CODEX_BIN=/path/to/codex overrides the binary (default: the provisioned 0.158.0 pin, then PATH).
//
// The row comes only from the bridge's `liveExecs` level, which is folded off `item/started`. That
// notification goes to whichever client is attached when the exec starts, and the app-server outlives
// Ntwine (the native listener is detached), so after a restart the exec keeps running in its PTY while
// the new bridge has never heard of it. The fix re-seeds the level from `thread/backgroundTerminals/list`
// on a rejoin of the same process (codex-app-server.ts seedLiveExecs). This drives the REAL thing:
//
//   Q1. A real yielded exec becomes a live exec on bridge A (the precondition).
//   Q2. Closing bridge A — an Ntwine restart — leaves the exec's OS process running.
//   Q3. A fresh bridge B on the same database and state dir rejoins the SAME listener and lists the
//       exec, with the same processId, without any new turn. Before the fix this was [].
//   Q4. When that exec then ends on its own (the probe SIGKILLs its OS process), does the row clear on
//       bridge B? Over the native listener subscriptions are per-connection, so an idle thread the
//       rejoin did not rebind never hears its exec end: the first version of the fix seeded the row and
//       then held it for the full 30 s after the command was gone. The rejoin now rebinds (and so
//       re-subscribes) exactly the threads that own a live exec.
//
//   RESEED_CONTROL=1 skips the restart and asks Q4 of bridge A instead — the control that says an exec
//   ending after its turn clears the row on the connection that saw it start (it does).
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createCodexAppServerBridge } from "./codex-app-server.ts"
import { stopCodexAppServerDaemon } from "./codex-app-server-host.ts"
import { createStorage } from "../storage.ts"

const UNIQ = 733
const control = process.env.RESEED_CONTROL === "1"
const PIN = join(homedir(), ".ntwine/runtimes/codex/0.158.0/vendor/aarch64-apple-darwin/bin/codex")
const codexBin = process.env.CODEX_BIN ?? (existsSync(PIN) ? PIN : "codex")
const projectId = "cxreseed"
const stateDir = mkdtempSync(join(tmpdir(), "cxreseed-state-"))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "cxreseed-repo-")))
execFileSync("git", ["init", "-q", cwd])
writeFileSync(join(cwd, "README.md"), "scratch\n")

let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// Only ever this run's own processes, identified by a unique duration that survives exec as real argv.
const livePids = (): number[] => {
  try {
    return execFileSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8" }).split("\n")
      .filter((line) => new RegExp(`(^|\\s)sleep ${UNIQ}(\\s|$)`).test(line.trim().replace(/^\d+\s+/, "")))
      .map((line) => Number(line.trim().split(/\s+/)[0]))
  } catch { return [] }
}

const storage = createStorage(join(stateDir, "ui.db"), "p")
const interactions = {
  // The thread runs danger-full-access with approvalPolicy "never"; these are the no-op shapes the
  // bridge's constructor requires.
  create: () => { throw new Error("no interactions in this probe") },
  acknowledgeProviderResponse: () => undefined,
  cancelForSession: () => undefined,
} as never
const diagnostics: unknown[] = []
const newBridge = () => createCodexAppServerBridge({
  projectId, projectDir: cwd, db: storage.db, stateDir, codexBin, interactions,
  diagnostic: (event) => diagnostics.push(event),
})

console.log(`[probe] codex ${codexBin}`)
console.log(`[probe] state ${stateDir}`)
let bridgeA: ReturnType<typeof newBridge> | undefined
let bridgeB: ReturnType<typeof newBridge> | undefined
try {
  ok("control: nothing matching is running before the turn", livePids().length === 0, JSON.stringify(livePids()))
  const slug = "codex-reseed-live"
  const sessionId = randomUUID()
  bridgeA = newBridge()
  await bridgeA.startDisposableSession({ threadSlug: slug, sessionId, cwd, sandbox: "danger-full-access", approvalPolicy: "never", ephemeral: false } as never)
  await bridgeA.startTurn({
    threadSlug: slug, sessionId, cwd,
    text: [`Start the long-running command \`sleep ${UNIQ}\` and hand it off to the background.`,
      "Use the exec tool's code mode: start the command, then call `yield_control()` so control returns to me immediately while it keeps running.",
      "Do NOT wait for it and do NOT poll it. Reply with only the handle it gave you."].join(" "),
  } as never)

  // ---- Q1 ------------------------------------------------------------------------------------------
  let execsA = bridgeA.backgroundExecs(slug, sessionId)
  const armed = Date.now() + 240_000
  while (Date.now() < armed && !(execsA.length > 0 && livePids().length > 0)) { await sleep(1_000); execsA = bridgeA.backgroundExecs(slug, sessionId) }
  const settled = Date.now() + 240_000
  while (Date.now() < settled && bridgeA.turnLiveness(slug, sessionId)?.bridgeTurn === true) await sleep(1_000)
  execsA = bridgeA.backgroundExecs(slug, sessionId)
  console.log(`[probe] bridge A execs: ${JSON.stringify(execsA)}; pids ${JSON.stringify(livePids())}`)
  ok("Q1 bridge A tracks a live background exec", execsA.length > 0)
  if (execsA.length === 0 || livePids().length === 0) throw new Error("preconditions unmet — the model did not background the command")
  const processId = execsA[0]!.processId
  if (control) {
    for (const pid of livePids()) { try { process.kill(pid, "SIGKILL") } catch { /* gone */ } }
    let cleared = false
    for (let i = 0; i < 30 && !cleared; i++) {
      await sleep(1_000)
      cleared = !bridgeA.backgroundExecs(slug, sessionId).some((exec) => exec.processId === processId)
    }
    console.log(`INFO  CONTROL after the exec ended on its own, bridge A (no restart) ${cleared ? "CLEARED the row" : "still holds the row after 30s"}`)
    throw new Error("control run ends here")
  }

  // ---- Q2 ------------------------------------------------------------------------------------------
  await bridgeA.shutdown()
  bridgeA = undefined
  await sleep(1_000)
  ok("Q2 the exec's OS process outlives the bridge", livePids().length > 0, JSON.stringify(livePids()))

  // ---- Q3 ------------------------------------------------------------------------------------------
  bridgeB = newBridge()
  await bridgeB.warmUp()
  const connected = diagnostics.filter((event) => (event as { event?: string }).event === "connected").length
  ok("Q3 bridge B connected (a second `connected` diagnostic)", connected >= 2, `connected ×${connected}`)
  ok("Q3 bridge B rejoined the SAME listener rather than a fresh one",
    !diagnostics.some((event) => (event as { event?: string }).event === "daemon-replaced"))
  const execsB = bridgeB.backgroundExecs(slug, sessionId)
  console.log(`[probe] bridge B execs after the rejoin: ${JSON.stringify(execsB)}`)
  ok("Q3 bridge B lists the still-running exec after the rejoin", execsB.some((exec) => exec.processId === processId),
    `expected processId ${processId}`)
  ok("Q3 the rejoin's rebind left the exec running", livePids().length > 0, JSON.stringify(livePids()))
  ok("Q3 the command came back with it", execsB.find((exec) => exec.processId === processId)?.command?.includes(`sleep ${UNIQ}`) === true)

  // ---- Q4 ------------------------------------------------------------------------------------------
  for (const pid of livePids()) { try { process.kill(pid, "SIGKILL") } catch { /* gone */ } }
  let cleared = false
  for (let i = 0; i < 30 && !cleared; i++) {
    await sleep(1_000)
    cleared = !bridgeB.backgroundExecs(slug, sessionId).some((exec) => exec.processId === processId)
  }
  ok("Q4 the row clears on bridge B once the exec ends on its own", cleared, cleared ? "" : "still held after 30s — its item/completed never reached this connection")
} catch (error) {
  failures++
  console.log(`FATAL: ${(error as Error).message}`)
} finally {
  for (const pid of livePids()) { try { process.kill(pid, "SIGKILL") } catch { /* gone */ } }
  try { await bridgeA?.shutdown() } catch { /* already down */ }
  try { await bridgeB?.shutdown() } catch { /* already down */ }
  try { await stopCodexAppServerDaemon(stateDir, projectId) } catch { /* nothing to stop */ }
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
