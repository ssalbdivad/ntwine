// End-to-end proof that a REAL ntwine launcher shuts down gracefully and leaves nothing behind.
//
// Boots the actual dev supervisor + forked control-plane child on a fully-ISOLATED stack (temp HOME,
// unique port, wakers/reaper off), puts REAL load on it (an open /events SSE board
// stream, an open /ws application socket, in-flight RPC calls), then delivers a signal to the whole
// process group exactly the way Ctrl-C does — and asserts:
//
//   • the launcher exits 0 within the bound,
//   • its output contains NO timeout / error / stack-trace noise,
//   • every process in the launcher's process group is gone afterwards (exact PID accounting).
//
//   nub scripts/verify-graceful-shutdown.mjs [--port=4952] [--mode=sigint|sigterm|double-sigint]
//
// --mode=double-sigint sends a second SIGINT 150ms after the first (the impatient operator).
// --mode=wedged-double-sigint SIGSTOPs the control-plane child first, so it CANNOT drain, then sends a
// second SIGINT: escalation must reclaim it promptly instead of waiting out the 15s child stop bound.
// --mode=orphan-kill SIGKILLs ONLY the launcher, so nothing can ask the control-plane child to stop:
// the child must notice its lost IPC channel and reap itself rather than outliving its launcher.
import { spawn } from "node:child_process"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const repoDir = resolve(scriptsDir, "..")

const args = process.argv.slice(2)
const opt = (k, d) => {
  const hit = args.find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.slice(k.length + 3) : d
}

// ── launcher role ────────────────────────────────────────────────────────────────────────────────────
// Same topology as packages/server/src/dev.ts, but on a caller-chosen port so a verification run can
// never collide with the operator's live boards.
if (process.env.NTWINE_SHUTDOWN_HARNESS === "launcher") {
  const port = Number(process.env.NTWINE_SHUTDOWN_HARNESS_PORT)
  const { projectLaunchTarget, resolveProject } = await import("../packages/server/src/project.ts")
  const { acquireProjectLaunchOwner, projectLaunchEnvironment } = await import("../packages/server/src/project-launch.ts")
  const project = resolveProject()
  const target = projectLaunchTarget(project)
  const launchOwner = acquireProjectLaunchOwner(target, "supervisor")
  const launchEnv = projectLaunchEnvironment(process.env, target, launchOwner.token)
  const { createSupervisorShutdownHandler, startDevSupervisor } = await import("../packages/server/src/dev-supervisor.ts")
  let supervisor
  try {
    supervisor = await startDevSupervisor({
      port,
      cwd: project.dir,
      env: launchEnv,
      stateDir: project.stateDir,
      launchTarget: target,
      launchOwnerToken: launchOwner.token,
      childEntry: resolve(repoDir, "packages/server/src/dev.ts"),
    })
    await supervisor.firstBoot
  } catch (error) {
    launchOwner.release()
    throw error
  }
  console.log(`NTWINE_HARNESS_READY ${JSON.stringify({ port, pid: process.pid })}`)
  const stop = createSupervisorShutdownHandler({
    close: () => supervisor.close(),
    force: () => supervisor.forceStop(),
    release: () => { launchOwner.release() },
    exit: (code) => process.exit(code),
    error: (line) => console.error(line),
  })
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  void supervisor.stopRequested.then(stop)
} else {
  // ── driver role ────────────────────────────────────────────────────────────────────────────────────
  const port = Number(opt("port", "4952"))
  const mode = opt("mode", "sigint")
  const home = mkdtempSync(join(tmpdir(), "ntwine-shutdown-verify-"))
  mkdirSync(join(home, ".ntwine"), { recursive: true })

  const descendants = (root) => {
    const seen = new Set()
    const walk = (pid) => {
      let out = ""
      try {
        out = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
      } catch {
        return
      }
      for (const line of out.split("\n")) {
        const child = Number(line.trim())
        if (!child || seen.has(child)) continue
        seen.add(child)
        walk(child)
      }
    }
    walk(root)
    return [...seen]
  }
  const alive = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  // Plain Node, not a wrapper that re-spawns the real launcher and forwards signals to
  // it, so one Ctrl-C reached the launcher twice and the harness measured the wrapper's exit code
  // rather than the launcher's. Node strips types natively, exactly as the dev supervisor's own
  // fork(dev.ts) relies on, so the launcher runs directly and the signal accounting is honest.
  const child = spawn(process.execPath, [resolve(scriptsDir, "verify-graceful-shutdown.mjs")], {
    cwd: repoDir,
    // Its own process group, so the driver can deliver a signal to the WHOLE group exactly the way a
    // terminal delivers Ctrl-C to its foreground group.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: home,
      NTWINE_SHUTDOWN_HARNESS: "launcher",
      NTWINE_SHUTDOWN_HARNESS_PORT: String(port),
      NTWINE_SANDBOX_TAG: `ntwine-shutdown-verify-${port}-${process.pid}`,
      NTWINE_WAKERS_OFF: "1",
      NTWINE_ORPHAN_REAPER_OFF: "1",
      NTWINE_DIRECT_SUPERVISOR: "1",
    },
  })
  const transcript = []
  const record = (stream) => (chunk) => {
    for (const line of String(chunk).split("\n")) {
      if (line.length === 0) continue
      transcript.push(`[${stream}] ${line}`)
      if (process.env.HARNESS_VERBOSE) console.log(`[${stream}] ${line}`)
    }
  }
  child.stdout.on("data", record("out"))
  child.stderr.on("data", record("err"))

  const exited = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })))
  const fail = async (why) => {
    try { process.kill(-child.pid, "SIGKILL") } catch {}
    console.error(`FAIL: ${why}`)
    console.error(transcript.join("\n"))
    rmSync(home, { recursive: true, force: true })
    process.exit(1)
  }

  const readyDeadline = Date.now() + 180_000
  while (!transcript.some((l) => l.includes("NTWINE_HARNESS_READY"))) {
    if (Date.now() > readyDeadline) await fail("launcher never became ready")
    if (child.exitCode !== null) await fail(`launcher exited early (${child.exitCode})`)
    await new Promise((r) => setTimeout(r, 200))
  }
  const origin = `http://127.0.0.1:${port}`
  console.log(`[verify] launcher ready on ${origin} (pid ${child.pid})`)

  // Real load, held open at the instant the signal lands.
  const sse = await fetch(`${origin}/events`, { headers: { origin, "sec-fetch-site": "same-origin" } })
  const sseReader = sse.body.getReader()
  await sseReader.read()
  // The supervisor's public proxy fronts a private control-plane port. Attach the WebSocket load to the
  // real control-plane server itself so the load is genuinely on the process being shut down.
  const childPortLine = transcript.find((l) => /server on http:\/\/127\.0\.0\.1:(\d+)/.test(l))
  const childPort = Number(childPortLine.match(/server on http:\/\/127\.0\.0\.1:(\d+)/)[1])
  const childOrigin = `http://127.0.0.1:${childPort}`
  const wsmod = await import("../packages/server/node_modules/ws/index.js")
  const WebSocket = wsmod.WebSocket ?? wsmod.default?.WebSocket ?? wsmod.default
  const ws = new WebSocket(`ws://127.0.0.1:${childPort}/ws`, { headers: { origin: childOrigin } })
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j) })
  // Two REAL procedures (router.ts) — a mistyped name answers 404 and proves nothing. The POST matters
  // most: node completes a request WITH A BODY long before its response is written, so a POST is the
  // only shape that catches a disconnect signal wired to the wrong event. `markRead` with an empty
  // body is rejected by its own input schema, which is fine — a complete JSON error body is exactly
  // what proves the response was not truncated. Nothing is mutated.
  const rpcCalls = [
    () => fetch(`${origin}/rpc/board`, { headers: { origin, "sec-fetch-site": "same-origin" } }),
    () => fetch(`${origin}/rpc/markRead`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: "{}",
    }),
  ]
  const callRpc = (i) => rpcCalls[i % rpcCalls.length]().then(async (r) => ({ status: r.status, body: await r.text() }))

  // A shutdown fix that reaches into the response stream can truncate ORDINARY replies into a
  // non-JSON 200, and no shutdown assertion would ever notice. Settle a batch first and parse every
  // body: the request path must still be intact on a healthy server before any signal is sent.
  const healthyRpc = await Promise.all(Array.from({ length: 8 }, (_, i) => callRpc(i)))
  const brokenRpc = healthyRpc.filter((r) => {
    try { JSON.parse(r.body); return false } catch { return true }
  })
  // A second batch is deliberately NOT awaited — these are still in flight when the signal lands. They
  // may legitimately fail (the server is going away); what matters is that they never hang shutdown.
  const rpc = Promise.allSettled(Array.from({ length: 8 }, (_, i) => callRpc(i)))
  console.log(`[verify] load in flight: 1 SSE board stream, 1 app socket, 8 RPC calls (${healthyRpc.length - brokenRpc.length}/8 pre-signal RPCs returned valid JSON)`)

  // The Codex app-server daemon is DELIBERATELY detached and MUST outlive a shutdown — an in-flight
  // Codex turn survives a restart precisely because nothing here kills it. Record it so this harness
  // asserts survival rather than absence, and so the run cleans up its own daemon afterwards.
  const stateDirs = readdirSync(join(home, ".ntwine", "projects"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(home, ".ntwine", "projects", e.name))
  let codexDaemon = null
  for (const stateDir of stateDirs) {
    const dir = join(stateDir, "codex-app-server")
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue
      try {
        const record = JSON.parse(readFileSync(join(dir, file), "utf8"))
        if (typeof record.daemonPid === "number" && alive(record.daemonPid)) codexDaemon = record
      } catch {}
    }
  }
  if (codexDaemon) console.log(`[verify] detached codex app-server daemon pid ${codexDaemon.daemonPid} (must SURVIVE)`)
  else console.log("[verify] no codex app-server daemon was started on this stack")

  // The daemon is still parented to the control-plane child until that child exits, so it shows up in
  // the process-tree walk. It is NOT an owned process to reap — exclude it from the accounting.
  const group = descendants(child.pid).filter((pid) => pid !== codexDaemon?.daemonPid)
  const owned = [child.pid, ...group]
  const launcherPid = JSON.parse(transcript.find((l) => l.includes("NTWINE_HARNESS_READY")).split("NTWINE_HARNESS_READY ")[1]).pid
  const childProcessPid = Number(transcript.find((l) => /control plane ready \(pid (\d+)/.test(l)).match(/control plane ready \(pid (\d+)/)[1])
  console.log(`[verify] launcher process tree before signal: ${owned.join(", ")} (control plane ${childProcessPid})`)

  // The operator's "EPIPE printed over my prompt seconds after I exited" symptom: a launcher that is
  // gone while its control-plane child is still running. Nothing can ask the child to stop, so this
  // pins that the child reaps ITSELF off the severed IPC channel.
  if (mode === "orphan-kill") {
    const t = Date.now()
    process.kill(launcherPid, "SIGKILL")
    const deadline = Date.now() + 20_000
    while (alive(childProcessPid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
    const orphanMs = Date.now() - t
    await new Promise((r) => setTimeout(r, 1000))
    const left = owned.filter(alive)
    const daemonAlive = codexDaemon ? alive(codexDaemon.daemonPid) : null
    console.log(transcript.join("\n"))
    console.log(JSON.stringify({
      mode, orphanMs, ownedPids: owned, survivingPids: left,
      codexDaemonPid: codexDaemon?.daemonPid ?? null, codexDaemonSurvived: daemonAlive,
    }, null, 2))
    rmSync(home, { recursive: true, force: true })
    if (codexDaemon) { try { process.kill(codexDaemon.daemonPid, "SIGTERM") } catch {} }
    if (codexDaemon && daemonAlive !== true) {
      console.error(`FAIL: the detached codex app-server daemon (pid ${codexDaemon.daemonPid}) was killed — it must survive`)
      process.exit(1)
    }
    if (left.length > 0) {
      for (const pid of left) { try { process.kill(pid, "SIGKILL") } catch {} }
      console.error(`FAIL: ${left.length} process(es) outlived their killed launcher: ${left.join(", ")}`)
      process.exit(1)
    }
    console.log(`PASS: control plane reaped itself ${orphanMs}ms after its launcher was SIGKILLed; nothing survived`)
    process.exit(0)
  }

  const signal = mode === "sigterm" ? "SIGTERM" : "SIGINT"
  // The impatient-operator escalation is only meaningful against a control plane that CANNOT drain.
  // SIGSTOP the real control-plane child: it can no longer answer SIGTERM, so the supervisor's normal
  // reclaim would block for CHILD_STOP_TIMEOUT_MS (15s). The second signal must cut that short.
  if (mode === "wedged-double-sigint") {
    process.kill(childProcessPid, "SIGSTOP")
    console.log(`[verify] wedged control-plane child ${childProcessPid} with SIGSTOP`)
  }
  const t0 = Date.now()
  process.kill(-child.pid, signal)
  if (mode === "double-sigint" || mode === "wedged-double-sigint") {
    await new Promise((r) => setTimeout(r, mode === "wedged-double-sigint" ? 800 : 150))
    try { process.kill(-child.pid, "SIGINT") } catch {}
  }

  const raced = await Promise.race([
    exited,
    new Promise((r) => setTimeout(() => r("TIMEOUT"), 20_000)),
  ])
  const shutdownMs = Date.now() - t0
  if (raced === "TIMEOUT") await fail(`launcher did not exit within 20000ms of ${signal}`)
  await rpc.catch(() => {})

  // Give any orphan a moment to surface, then account for every PID exactly.
  await new Promise((r) => setTimeout(r, 1000))
  const survivors = owned.filter(alive)

  const NOISE = [
    /did not quiesce/,
    /did not settle within/,
    /could not safely close storage/,
    /shutdown failed/,
    /late shutdown drain failed/,
    /retaining ownership while the drain completes/,
    /force deadline exceeded/,
    /did not close in \d+ms/,
    /ShutdownTimeoutError/,
    /AggregateError/,
    /EPIPE/,
    /^\[err\]\s+at /,
  ]
  const noisy = transcript.filter((line) => NOISE.some((re) => re.test(line)))

  console.log("─".repeat(90))
  console.log(`SHUTDOWN TRANSCRIPT (${signal}${mode === "double-sigint" ? " ×2" : ""}, port ${port})`)
  console.log("─".repeat(90))
  console.log(transcript.join("\n"))
  console.log("─".repeat(90))

  const codexSurvived = codexDaemon ? alive(codexDaemon.daemonPid) : null
  const result = {
    mode,
    signal,
    shutdownMs,
    codexDaemonPid: codexDaemon?.daemonPid ?? null,
    codexDaemonSurvived: codexSurvived,
    exit: raced,
    noisyLines: noisy,
    ownedPids: owned,
    survivingPids: survivors,
    brokenRpcRepliesBeforeSignal: brokenRpc.length,
  }
  console.log(JSON.stringify(result, null, 2))

  rmSync(home, { recursive: true, force: true })
  const problems = []
  if (brokenRpc.length > 0) {
    problems.push(`${brokenRpc.length} healthy-server RPC reply/replies were not valid JSON: ${JSON.stringify(brokenRpc[0]).slice(0, 300)}`)
  }
  if (codexDaemon && codexSurvived !== true) {
    problems.push(`the detached codex app-server daemon (pid ${codexDaemon.daemonPid}) was killed — it must survive`)
  }
  // This harness owns the daemon it started; reap it by exact PID so verification leaks nothing.
  if (codexDaemon) { try { process.kill(codexDaemon.daemonPid, "SIGTERM") } catch {} }
  const escalating = mode === "wedged-double-sigint"
  if (escalating) {
    // Escalation is a deliberate abandonment: non-zero exit, and it must be PROMPT — well inside the
    // 15s CHILD_STOP_TIMEOUT_MS it exists to cut short — while still reaping every owned process.
    if (raced.code === 0) problems.push("escalated stop exited 0 — a forced stop must report failure")
    if (shutdownMs > 5_000) problems.push(`escalation took ${shutdownMs}ms — it must not wait out the 15s child reclaim`)
    if (!transcript.some((l) => l.includes("second stop signal"))) problems.push("no escalation was reported")
  } else {
    if (raced.code !== 0) problems.push(`launcher exited ${JSON.stringify(raced)} — expected code 0`)
    if (noisy.length > 0) problems.push(`${noisy.length} timeout/error line(s) in shutdown output`)
  }
  if (survivors.length > 0) problems.push(`${survivors.length} process(es) survived: ${survivors.join(", ")}`)
  if (problems.length > 0) {
    console.error(`FAIL: ${problems.join("; ")}`)
    for (const pid of survivors) { try { process.kill(pid, "SIGKILL") } catch {} }
    process.exit(1)
  }
  console.log(`PASS: clean ${signal} shutdown in ${shutdownMs}ms, ${owned.length} owned process(es) all reaped`)
  process.exit(0)
}
