// LIVE end-to-end gate for the worker ENVIRONMENT contract (worker-env.ts): a REAL dispatched broker
// worker inherits the operator's environment and is denied only frizz's own control plane. Run:
//   nub packages/server/src/backend/_live_broker_env_inherit.mts
//
// WHY A LIVE PROBE: worker-env.test.ts pins what inheritWorkerEnvironment RETURNS, which is the easy
// half. The half that only a real dispatch can show is that the value survives every gate between frizz
// and the running claude process — the broker's `env:`, the daemon fork, buildEnvironment inside the
// daemon, and the SDK's own spawn. Until 2026-08-02 buildEnvironment THREW on any key outside its
// allowlist, and the failure mode was invisible from a unit test: the daemon died during startup before
// publishing its record, so the operator saw only every dispatch timing out "did not become ready".
// This probe is what would notice that regression coming back.
//
// The two assertions are deliberately opposed, so a filter that is too tight AND one that is too loose
// both fail here:
//   · an ordinary operator variable (a toolchain path, a proxy) MUST arrive
//   · FRIZZ_* MUST NOT — a worker dispatched to work on frizz would otherwise read the broker's daemon
//     payload and the launch identity, and the cc-worker hooks would see the SERVER's thread id
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createContext } from "../context.ts"
import { resolveProject } from "../project.ts"
import { claudeBrokerRecordPath, readBrokerRecord } from "./claude-broker-host.ts"

process.env.FRIZZ_CLAUDE_BROKER_BRIDGE = "1"
// Set in FRIZZ's process, never passed through workerEnv — inheritance is the only way these can arrive.
const INHERITED_VALUE = "inherited-from-the-operator-shell"
process.env.FRIZZ_LIVE_PROBE_TOOLCHAIN = "must-not-cross" // frizz-prefixed on purpose: the denied case
process.env.LIVE_PROBE_TOOLCHAIN = INHERITED_VALUE       // an ordinary operator variable: the allowed case

const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const repo = mkdtempSync(join(tmpdir(), "brk-envinherit-repo-"))
execFileSync("git", ["init", "-q", repo]); execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"])
// A throwaway home for Frizz's own state. resolveProject REGISTERS the directory it resolves, and
// under the real home that is the operator's project list: every run left a dead card on their rail.
const frizzHome = mkdtempSync(join(tmpdir(), "brk-envinherit-home-"))
const project = resolveProject(repo, frizzHome)
const reportFile = join(repo, "env.txt")

let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let daemonPid: number | undefined

try {
  const ctx = await createContext({ project, claudeBin })
  const { slug, sessionId } = await ctx.dispatcher.dispatch({
    prompt: `Run exactly this one Bash command and then stop: ` +
      `printf '%s|%s|%s' "\${LIVE_PROBE_TOOLCHAIN:-MISSING}" "\${FRIZZ_LIVE_PROBE_TOOLCHAIN:-DENIED}" "\${FRIZZ_CLAUDE_BROKER:-DENIED}" > ${reportFile}`,
  }, { backend: "claude" })
  ok("dispatched a broker thread (the daemon started — the old allowlist THREW here)", !!slug && !!sessionId)
  daemonPid = readBrokerRecord(claudeBrokerRecordPath(project.stateDir, sessionId))?.daemonPid

  const deadline = Date.now() + 180_000
  while (!existsSync(reportFile) && Date.now() < deadline) await sleep(1_000)

  const raw = existsSync(reportFile) ? readFileSync(reportFile, "utf8").trim() : "(no file)"
  const [inherited, frizzProbe, frizzBroker] = raw.split("|")
  ok("an ordinary operator variable REACHES the worker", inherited === INHERITED_VALUE, `worker read ${JSON.stringify(inherited)}`)
  ok("a FRIZZ_* variable does NOT reach the worker", frizzProbe === "DENIED", `worker read ${JSON.stringify(frizzProbe)}`)
  ok("the broker daemon payload does NOT reach the worker", frizzBroker === "DENIED", `worker read ${JSON.stringify(frizzBroker)?.slice(0, 80)}`)

  await ctx.tailer.stop()
  ctx.stopSubscriptions(); await ctx.scheduler.stop(); await ctx.board.stop()
  ctx.claudeBroker?.releaseSession(slug, sessionId, "session-deleted"); ctx.storage.close()
} catch (err) {
  failures++; console.log(`\nERROR: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
} finally {
  try { if (daemonPid) process.kill(daemonPid, "SIGKILL") } catch {}
  rmSync(repo, { recursive: true, force: true })
  try { rmSync(frizzHome, { recursive: true, force: true }) } catch {}
  try { rmSync(join(process.env.HOME ?? "", ".claude", "projects", project.cwdSlug), { recursive: true, force: true }) } catch {}
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
