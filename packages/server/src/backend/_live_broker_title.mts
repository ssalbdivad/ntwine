// LIVE title gate for the broker cutover: proves a broker thread dispatched through the REAL server
// (createContext → dispatch broker branch → detached daemon with the wired workerEnv, i.e. the
// cc-worker plugin and its SessionStart hooks LOADED) ends up with Claude's own session title — the
// `ai-title` transcript record — and that the tailer surfaces it as the board's `aiTitle`.
//
// The bug this guards: Claude Code's automatic titling is suppressed on the Agent-SDK transport
// whenever a SessionStart hook is registered, which is always true for a frizz broker worker. With no
// `ai-title` record the board shows "Spinning up a thread…" for SPIN_UP_MS and then falls back to a
// truncation of the raw dispatch prompt, forever. The broker therefore ASKS for the title explicitly
// (claude-agent-broker.ts → seedSessionTitle → generate_session_title with persist).
//
// Run:  nub packages/server/src/backend/_live_broker_title.mts
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import { createContext } from "../context.ts"
import { resolveProject } from "../project.ts"
import { claudeBrokerRecordPath, readBrokerRecord } from "./claude-broker-host.ts"

process.env.FRIZZ_CLAUDE_BROKER_BRIDGE = "1"
const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const repo = mkdtempSync(join(tmpdir(), "brk-title-repo-"))
execFileSync("git", ["init", "-q", repo]); execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"])
// A throwaway home for Frizz's own state. resolveProject REGISTERS the directory it resolves, and
// under the real home that is the operator's project list: every run left a dead card on their rail.
const frizzHome = mkdtempSync(join(tmpdir(), "brk-title-home-"))
const project = resolveProject(repo, frizzHome)

let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let daemonPid: number | undefined

const aiTitlesIn = (path: string): string[] => {
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l) as { type?: string; aiTitle?: string } } catch { return undefined } })
    .filter((r): r is { type: string; aiTitle: string } => r?.type === "ai-title" && typeof r.aiTitle === "string")
    .map((r) => r.aiTitle)
}

try {
  const ctx = await createContext({ project, claudeBin })
  const { slug, sessionId } = await ctx.dispatcher.dispatch({
    prompt: "Add rate limiting to the public search endpoint. Reply with the single word ACK and stop; do not use any tools.",
  }, { backend: "claude" })
  ok("dispatched a broker thread", !!slug && !!sessionId)
  daemonPid = readBrokerRecord(claudeBrokerRecordPath(project.stateDir, sessionId))?.daemonPid

  const transcript = join(homedir(), ".claude", "projects", project.cwdSlug, `${sessionId}.jsonl`)
  const deadline = Date.now() + 180_000
  while (aiTitlesIn(transcript).length === 0 && Date.now() < deadline) await sleep(1_000)
  const titles = aiTitlesIn(transcript)
  ok("the session transcript carries an ai-title record", titles.length > 0, titles.at(-1) ?? `none in ${transcript}`)

  // …and the tailer folds it through to the board row the web reads for the thread title.
  const boardDeadline = Date.now() + 60_000
  let aiTitle: string | undefined
  while (!aiTitle && Date.now() < boardDeadline) {
    ctx.tailer.nudge?.()
    await sleep(1_000)
    aiTitle = ctx.tailer.get(slug)?.aiTitle
  }
  ok("the tailer surfaces it as the board's aiTitle", !!aiTitle, aiTitle ?? "still undefined")
  ok("the title is NOT a truncation of the dispatch prompt", !!aiTitle && !aiTitle.startsWith("Add rate limiting to the public search endpoint. Reply"), aiTitle ?? "")

  await ctx.tailer.stop()
  ctx.stopSubscriptions(); await ctx.scheduler.stop(); await ctx.board.stop(); ctx.claudeBroker?.releaseSession(slug, sessionId, "session-deleted"); ctx.storage.close()
} catch (err) {
  failures++; console.log(`\nERROR: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
} finally {
  try { if (daemonPid) process.kill(daemonPid, "SIGKILL") } catch {}
  rmSync(repo, { recursive: true, force: true })
  try { rmSync(frizzHome, { recursive: true, force: true }) } catch {}
  try { rmSync(join(homedir(), ".claude", "projects", project.cwdSlug), { recursive: true, force: true }) } catch {}
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
