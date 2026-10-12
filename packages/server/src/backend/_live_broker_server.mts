// LIVE end-to-end RUNTIME GATE for the broker CUTOVER through the REAL server wiring (not just the
// bridge). Run:  FRIZZ_CLAUDE_BROKER_BRIDGE=1 nub \
//   packages/server/src/backend/_live_broker_server.mts
//
// Unlike _live_broker_bridge.mts (which drives the bridge directly), this exercises the code I wired
// into the server for the cutover, against real claude:
//   1. ctx.dispatcher.dispatch({backend:"claude"}) → the dispatch.ts BROKER BRANCH (forks the daemon,
//      stamps backend=claude + claude_runtime=broker).
//   2. ctx.board.snapshot() → deriveRuntime's HEADLESS path + the daemon stall-net reader (live, not exited).
//   3. router.followUp.handler → the router's BROKER BRANCH (bridge.followUp, no TUI composer).
//   4. RESTART: tear ctx1 down (daemon SURVIVES) → new ctx2 on the same project → reconcileSessions must
//      NOT mark the row exited, and the board must still read it live — the whole ownerless-reconnect point.
//   5. followUp again through ctx2 → a turn lands on the SAME session across the "restart".
//   6. router.completeThread.handler({terminateLive:true}) → the stop seam kills the ownerless daemon.
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createContext } from "../context.ts"
import { createRouter } from "../router.ts"
import { resolveProject } from "../project.ts"
import { claudeBrokerRecordPath, readBrokerRecord } from "./claude-broker-host.ts"

process.env.FRIZZ_CLAUDE_BROKER_BRIDGE = "1"
const claudeBin = execFileSync("which", ["claude"], { encoding: "utf8" }).trim()
const repo = mkdtempSync(join(tmpdir(), "brk-srv-repo-"))
execFileSync("git", ["init", "-q", repo])
execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"])
// A throwaway home for Frizz's own state. resolveProject REGISTERS the directory it resolves, and
// under the real home that is the operator's project list: every run left a dead card on their rail.
const frizzHome = mkdtempSync(join(tmpdir(), "brk-srv-home-"))
const project = resolveProject(repo, frizzHome)

let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const fileA = join(repo, "a.txt"), fileB = join(repo, "b.txt"), fileC = join(repo, "c.txt")
const waitFor = async (cond: () => boolean, ms = 120_000, label = "condition") => {
  const d = Date.now() + ms
  while (!cond()) { if (Date.now() > d) throw new Error(`timeout waiting for ${label}`); await sleep(750) }
}

// Full canonical context teardown (index.ts order), MINUS anything that kills the broker daemon —
// broker.close() only DETACHES its sockets, exactly what a real frizz process exit does. The daemon lives on.
async function teardown(ctx: Awaited<ReturnType<typeof createContext>>) {
  ctx.tailer.stop()
  ctx.stopSubscriptions()
  await ctx.scheduler.stop()
  await ctx.board.stop()
  ctx.claudeBroker?.close()
  ctx.storage.close()
}

let daemonPid: number | undefined
try {
  // ---- boot ctx1 + dispatch through the real dispatcher (the broker branch) ----------------------
  let ctx = await createContext({ project, claudeBin })
  let router = createRouter(ctx)
  const { slug, sessionId } = await ctx.dispatcher.dispatch(
    { prompt: `Use the Write tool to create the file ${fileA} containing the text ok. Then stop.` },
    { backend: "claude" },
  )
  ok("dispatch returned slug+session", !!slug && !!sessionId, `${slug} / ${sessionId}`)

  const row1 = ctx.storage.getSession(slug)
  ok("row stamped backend=claude, claude_runtime=broker", row1?.backend === "claude" && row1?.claude_runtime === "broker", `${row1?.backend}/${row1?.claude_runtime}`)

  const rec = readBrokerRecord(claudeBrokerRecordPath(project.stateDir, sessionId))
  daemonPid = rec?.daemonPid
  ok("a detached broker daemon is running", !!daemonPid && (() => { try { process.kill(daemonPid!, 0); return true } catch { return false } })(), `pid ${daemonPid}`)

  // board must read a fresh broker row as LIVE (headless path), never "exited"
  const runtimeOf = async (): Promise<string | undefined> =>
    (await ctx.board.snapshot()).threads.find((t) => t.id === slug && t.kind === "session")?.runtime
  const r0 = await runtimeOf()
  ok("board derives the broker row LIVE, not exited", r0 === "running" || r0 === "turn-idle", `runtime=${r0}`)

  // ---- the auto-allowed Write actually ran (permission relay through the daemon) ------------------
  await waitFor(() => existsSync(fileA), 120_000, "file A")
  ok("permission auto-allowed → tool ran (file A written)", existsSync(fileA))

  // ---- followUp through the ROUTER's broker branch -----------------------------------------------
  await router.followUp.handler({ input: { slug, sessionId, message: `Use the Write tool to create the file ${fileB} containing ok2. Then stop.`, deliveryId: "d-1" } })
  await waitFor(() => existsSync(fileB), 120_000, "file B")
  ok("router.followUp ran a 2nd turn on the live session (file B)", existsSync(fileB))

  // ---- RESTART: ctx1 down (daemon survives), ctx2 up on the SAME project --------------------------
  await teardown(ctx)
  await sleep(500)
  ok("broker daemon SURVIVES frizz teardown", !!daemonPid && (() => { try { process.kill(daemonPid!, 0); return true } catch { return false } })())

  ctx = await createContext({ project, claudeBin })
  router = createRouter(ctx)
  const row2 = ctx.storage.getSession(slug)
  ok("reconcileSessions did NOT mark the broker row exited on reboot", row2?.exited === 0, `exited=${row2?.exited}`)
  const r1 = await runtimeOf()
  ok("board STILL derives it live after restart (reconnect)", r1 === "running" || r1 === "turn-idle", `runtime=${r1}`)

  // ---- followUp across the restart → a turn on the SAME surviving session ------------------------
  await router.followUp.handler({ input: { slug, sessionId, message: `Use the Write tool to create the file ${fileC} containing ok3. Then stop.`, deliveryId: "d-2" } })
  await waitFor(() => existsSync(fileC), 120_000, "file C")
  ok("followUp after restart reconnected to the live session (file C)", existsSync(fileC))

  // ---- stop seam: completeThread(terminateLive) kills the ownerless daemon -----------------------
  const res = await router.completeThread.handler({ input: { slug, sessionId, terminateLive: true } })
  ok("completeThread did not demand confirmation with terminateLive", res.needsConfirmation === false)
  await sleep(1_500)
  const dead = !daemonPid || (() => { try { process.kill(daemonPid!, 0); return false } catch { return true } })()
  ok("stop seam killed the ownerless daemon", dead)

  await teardown(ctx)
} catch (err) {
  failures++
  console.log(`\nERROR: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
} finally {
  try { if (daemonPid) process.kill(daemonPid, "SIGKILL") } catch {}
  rmSync(repo, { recursive: true, force: true })
  try { rmSync(frizzHome, { recursive: true, force: true }) } catch {}
  try { rmSync(join(process.env.HOME ?? "", ".claude", "projects", project.cwdSlug), { recursive: true, force: true }) } catch {}
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}
