// LIVE PROBE: the CODEX × end to end, through ntwine's OWN stack rather than raw JSON-RPC.
//   nub packages/server/src/backend/_live_codex_shell_stop.mts
//
// The two probes before this settled the protocol (`_live_codex_bgterm.mts`: terminate really kills the
// OS process, codex tells its agent nothing, `thread/inject_items` reaches the model) and the id
// (`_live_codex_bgterm_match.mts`: the rollout ntwine folds carries NO handle, so `processId` has to come
// off the app-server item stream). This one drives the wiring built on top of them:
//
//   bridge.backgroundExecs()  →  tailer.codexBgShellViews  →  board bgShells (id + stoppable)
//   router.stopBackgroundOp   →  bridge.terminateBackgroundExec  →  terminate + inject_items
//
// and asserts the four things that decide whether the × may ship on a codex row:
//
//   Q1. Does a real background exec become a board row with an id and `stoppable`?
//   Q2. Does stopping it through the ROUTER kill the real OS process?
//   Q3. Does the row then leave the board?
//   Q4. Did the worker actually get told — asked in a later turn, without restating what happened?
import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createCodexAppServerBridge } from "./codex-app-server.ts"
import { createCodexBackend } from "./codex.ts"
import { createTailer, defaultLogDir, type Tailer } from "../tailer.ts"
import { createStorage } from "../storage.ts"
import { createBoard } from "../board.ts"
import { Bus } from "../bus.ts"
import { cwdSlug, type Project } from "../project.ts"

const UNIQ = 641
const stateDir = mkdtempSync(join(tmpdir(), "cxstop-state-"))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "cxstop-repo-")))
execFileSync("git", ["init", "-q", cwd])
writeFileSync(join(cwd, "README.md"), "scratch\n")

let failures = 0
const ok = (label: string, cond: boolean, detail = "") => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// pid + ppid + the full argv, so a SURVIVOR can be attributed rather than just counted. The model can
// legitimately start the command more than once (a first attempt that did not yield, then the real
// background handoff), and only the one the app-server actually reported is this kill's business.
const liveProcs = (): { pid: number; ppid: number; cmd: string }[] => {
  try {
    return execFileSync("ps", ["-axww", "-o", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n")
      .filter((l) => l.includes(`sleep ${UNIQ}`) && !l.includes("grep"))
      .map((l) => {
        const t = l.trim()
        const [pid, ppid, ...rest] = t.split(/\s+/)
        return { pid: Number(pid), ppid: Number(ppid), cmd: rest.join(" ") }
      })
  } catch { return [] }
}
const livePids = (): number[] => liveProcs().map((p) => p.pid)

const project: Project = { dir: cwd, id: "cxlive", name: "cxlive", label: "o/cxlive", stateDir, cwdSlug: cwdSlug(cwd) }
const storage = createStorage(join(stateDir, "ui.db"), "p")

console.log(`[probe] state ${stateDir}`)
console.log(`[probe] repo  ${cwd}`)

const codexBackend = createCodexBackend()
let bridge!: ReturnType<typeof createCodexAppServerBridge>
let tailer!: Tailer
try {
  bridge = createCodexAppServerBridge({
    projectId: project.id,
    projectDir: cwd,
    db: storage.db,
    stateDir,
    interactions: {
      // The probe approves nothing and needs nothing approved (the thread runs danger-full-access with
      // approvalPolicy "never"); these are the no-op shapes the bridge's constructor requires.
      create: () => { throw new Error("no interactions in this probe") },
      acknowledgeProviderResponse: () => undefined,
      cancelForSession: () => undefined,
    } as never,
  })
  tailer = createTailer({
    project, storage, bus: new Bus(),
    backendFor: () => codexBackend,
    onChange: () => {},
    paneDead: () => false,
    codexBackgroundExecs: (slug, sessionId) => bridge.backgroundExecs(slug, sessionId),
  })
  const board = createBoard(project, storage, new Bus(), tailer, "probe", {
    codexTurnLiveness: (slug, sessionId) => bridge.turnLiveness(slug, sessionId),
  })

  const slug = "codexshell-live"
  const sessionId = randomUUID()
  storage.upsertSession({
    slug, session_id: sessionId, thread_name: `ntwine-${slug}`, spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 1,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null,
  })
  storage.setBackend(slug, "codex")
  storage.setCodexRuntime(slug, "app-server")

  console.log(`[probe] CONTROL — pids matching "sleep ${UNIQ}": ${JSON.stringify(livePids())}`)
  ok("control: nothing matching is running before the turn", livePids().length === 0)

  // NOT ephemeral: Q4 reads the worker's own rollout to see whether ntwine's notice reached the model, and
  // an ephemeral thread writes no rollout at all — the check then reads an empty string and "fails" for
  // a reason that has nothing to do with the notice.
  await bridge.startDisposableSession({ threadSlug: slug, sessionId, cwd, sandbox: "danger-full-access", approvalPolicy: "never", ephemeral: false } as never)
  await bridge.startTurn({
    threadSlug: slug, sessionId, cwd,
    text: [`Start the long-running command \`sleep ${UNIQ}\` and hand it off to the background.`,
      "Use the exec tool's code mode: start the command, then call `yield_control()` so control returns to me immediately while it keeps running.",
      "Do NOT wait for it and do NOT poll it. Reply with only the handle it gave you."].join(" "),
  } as never)

  const settleTurn = async (ms = 240_000) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (bridge.turnLiveness(slug, sessionId)?.bridgeTurn !== true) return true
      await sleep(1_000)
    }
    return false
  }

  // ---- Q1: does it become a board row ntwine can act on? ------------------------------------------
  let shell: { id?: string; label: string; stoppable?: boolean; outputUnavailable?: boolean } | undefined
  const armed = Date.now() + 240_000
  while (Date.now() < armed) {
    tailer.tick()
    shell = tailer.get(slug)?.bgShells?.find((s) => s.state === "running")
    if (shell?.id && livePids().length > 0) break
    await sleep(1_500)
  }
  await settleTurn()
  console.log(`[probe] board row: ${JSON.stringify(shell)}`)
  console.log("[probe] processes matching before the kill:")
  for (const proc of liveProcs()) console.log(`    pid=${proc.pid} ppid=${proc.ppid} ${proc.cmd.slice(0, 110)}`)
  ok("Q1 the codex exec becomes a board shell row with an id", Boolean(shell?.id), JSON.stringify(shell ?? null))
  ok("Q1 the row is marked stoppable", shell?.stoppable === true)
  ok("Q1 the row declines a drill-in (codex keeps the output in its own session)", shell?.outputUnavailable === true)
  ok("Q1 the label is the COMMAND, not the launcher's argv", shell?.label === `sleep ${UNIQ}`, shell?.label ?? "")
  if (!shell?.id || livePids().length === 0) throw new Error("preconditions unmet — no live codex shell to stop")

  // ---- Q2/Q3: the kill, through the same bridge call the router makes ---------------------------
  // Sampled BEFORE the call. Reading it after leaves the assertion comparing the post-kill world with
  // itself, which passes or fails for reasons that have nothing to do with the kill.
  const beforeKill = liveProcs().map((proc) => proc.pid)
  const result = await bridge.terminateBackgroundExec({
    threadSlug: slug, sessionId, processId: shell.id,
    notice: `[ntwine] The operator stopped your background command "sleep ${UNIQ}" from the Ntwine dashboard. It is no longer running and will never report a result — do not wait on it or poll it again.`,
  })
  console.log(`[probe] terminateBackgroundExec => ${JSON.stringify(result)}`)
  ok("Q2 the bridge reports the exec terminated", result.terminated)
  ok("Q2 the notice landed", result.noticeFailed === null, result.noticeFailed ?? "")

  let after = livePids()
  for (let i = 0; i < 20 && after.length >= beforeKill.length; i++) { await sleep(500); after = livePids() }
  console.log("[probe] processes matching after the kill:")
  for (const proc of liveProcs()) console.log(`    pid=${proc.pid} ppid=${proc.ppid} ${proc.cmd.slice(0, 110)}`)
  // The app-server names the PTY, not an OS pid, so the assertion is that the kill REMOVED processes —
  // and that whatever the model left behind from an earlier non-yielding attempt is not counted against
  // it. A run where nothing at all disappeared is the real failure.
  ok("Q2 the kill removed the exec's OS process", after.length < beforeKill.length,
    `before ${JSON.stringify(beforeKill)} after ${JSON.stringify(after)}`)

  let cleared = false
  for (let i = 0; i < 10 && !cleared; i++) {
    tailer.tick()
    cleared = !(tailer.get(slug)?.bgShells ?? []).some((s) => s.id === shell!.id)
    if (!cleared) await sleep(1_000)
  }
  ok("Q3 the row leaves the board", cleared)
  // The BOARD's own view, not just the tailer's — this is what the client renders the × off.
  const snapshot = await board.rebuild()
  const thread = snapshot.threads.find((t) => t.id === slug)
  ok("Q3 the board snapshot lists no live shell either", (thread?.bgShells ?? []).length === 0, JSON.stringify(thread?.bgShells ?? []))

  // ---- Q4: was the worker told? -----------------------------------------------------------------
  await settleTurn()
  await bridge.startTurn({
    threadSlug: slug, sessionId, cwd,
    text: "In one sentence: what is the state of the background command you started, and how do you know? Do not run any tools — answer only from what you have been told.",
  } as never)
  await sleep(20_000)
  const codexThreadId = bridge.binding(slug, sessionId)?.codexThreadId
  console.log(`[probe] codex thread id: ${codexThreadId ?? "(none)"}`)
  const rollout = codexThreadId
    ? execFileSync("/bin/zsh", ["-lc", `grep -rl ${JSON.stringify(codexThreadId)} "$HOME/.codex/sessions" --include='*.jsonl' 2>/dev/null | head -1`], { encoding: "utf8" }).trim()
    : ""
  let account = ""
  if (rollout) {
    const text = execFileSync("tail", ["-40", rollout], { encoding: "utf8" })
    account = text.toLowerCase()
  }
  console.log(`[probe] tail of the worker's own rollout:\n${account.slice(-900)}`)
  ok("Q4 the worker knows the command was stopped", /stopped|terminated|no longer running|killed/.test(account),
    "if this fails the kill was silent — the exact gap the notice exists to close")
} catch (error) {
  failures++
  console.log(`FATAL: ${(error as Error).message}`)
} finally {
  for (const pid of livePids()) { try { process.kill(pid, "SIGKILL") } catch { /* gone */ } }
  try { await bridge?.shutdown() } catch { /* already down */ }
  try { tailer?.stop() } catch { /* not started */ }
  rmSync(stateDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
