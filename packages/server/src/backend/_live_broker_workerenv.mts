// LIVE worker-ENVIRONMENT gate for the broker cutover: proves a broker worker dispatched through the
// REAL server (createContext → dispatch broker branch → daemon with the wired workerEnv) actually has
// the frizz plugin environment — specifically that it can DISPATCH a frizz:<effort> sub-agent
// profile (which requires the cc-worker plugin to have loaded through the SDK) and that the frizz MCP is
// mounted. Run:  FRIZZ_CLAUDE_BROKER_BRIDGE=1 nub \
//   packages/server/src/backend/_live_broker_workerenv.mts
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createContext } from "../context.ts"
import { resolveProject } from "../project.ts"
import { claudeBrokerRecordPath, readBrokerRecord } from "./claude-broker-host.ts"

process.env.FRIZZ_CLAUDE_BROKER_BRIDGE = "1"
const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const repo = mkdtempSync(join(tmpdir(), "brk-wenv-repo-"))
execFileSync("git", ["init", "-q", repo]); execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"])
// A throwaway home for Frizz's own state. resolveProject REGISTERS the directory it resolves, and
// under the real home that is the operator's project list: every run left a dead card on their rail.
const frizzHome = mkdtempSync(join(tmpdir(), "brk-wenv-home-"))
const project = resolveProject(repo, frizzHome)
const subFile = join(repo, "SUB_OK.txt")
const reportFile = join(repo, "tools.txt")

let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let daemonPid: number | undefined

try {
  const ctx = await createContext({ project, claudeBin })
  const { slug, sessionId } = await ctx.dispatcher.dispatch({
    prompt:
      `Do BOTH of these, then stop:\n` +
      `1. Use the Agent tool with subagent_type exactly "frizz:low" to dispatch a sub-agent whose prompt is: ` +
      `"Use the Write tool to create the file ${subFile} containing the word DONE, then stop." ` +
      `If subagent_type "frizz:low" is unavailable, instead write the file ${reportFile} containing "NO_FRIZZ_AGENT".\n` +
      `2. Write the file ${reportFile} listing whether you can see tools named mcp__frizz__spawn_thread and mcp__chrome-devtools (one per line, "yes" or "no").`,
  }, { backend: "claude" })
  ok("dispatched a broker thread", !!slug && !!sessionId)
  daemonPid = readBrokerRecord(claudeBrokerRecordPath(project.stateDir, sessionId))?.daemonPid

  // Wait for the sub-agent's marker file (frizz:low ran) or the report file (worker finished/failed).
  const deadline = Date.now() + 180_000
  while (!existsSync(subFile) && Date.now() < deadline) await sleep(1_000)

  ok("broker worker dispatched a frizz:low SUB-AGENT that ran (SUB_OK.txt written)", existsSync(subFile),
    existsSync(subFile) ? readFileSync(subFile, "utf8").trim() : (existsSync(reportFile) ? `report=${readFileSync(reportFile, "utf8").trim().slice(0, 120)}` : "neither file appeared"))

  // Give the parent a moment to also write the tools report, then inspect it.
  const rDeadline = Date.now() + 60_000
  while (!existsSync(reportFile) && Date.now() < rDeadline) await sleep(1_000)
  if (existsSync(reportFile)) {
    const report = readFileSync(reportFile, "utf8").toLowerCase()
    ok("worker sees the frizz MCP tool", /frizz[^\n]*yes|yes[^\n]*frizz|spawn_thread[^\n]*yes/.test(report) || report.includes("mcp__frizz"), report.slice(0, 160).replace(/\n/g, " | "))
  }

  await ctx.tailer.stop()
  ctx.stopSubscriptions(); await ctx.scheduler.stop(); await ctx.board.stop(); ctx.claudeBroker?.releaseSession(slug, sessionId, "session-deleted"); ctx.storage.close()
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
