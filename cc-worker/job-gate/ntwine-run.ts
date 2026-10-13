#!/usr/bin/env node
// ntwine-run — run a heavy command through the host-wide job gate (gate.ts has the design and the
// state format).
//
//   ntwine-run -- <cmd> [args…]   wait for a slot, run the command, record its peak memory
//   ntwine-run status [--json]    the running and queued jobs, and the host reading the gate sees
//
// The PreToolUse hook (hook.ts) inserts `ntwine-run --hook --` in front of heavy commands; nobody has to
// type it. The wrapper is transparent: the job inherits cwd, stdio and environment, its exit code
// (or the signal that killed it) is the wrapper's, and SIGINT/SIGTERM/SIGHUP reach its whole tree.
//
// FAIL OPEN. If the gate itself cannot work — an unreadable state dir, a lock it cannot take — the
// command runs at once, ungated, with one line saying so. The gate may delay a command; it must never
// be the reason one fails.
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { constants } from "node:os"
import { classify } from "./classify.ts"
import {
  appendTelemetry, decide, estimateMB, heapCapMB, hwmMB, memAvailableMB, readHistory, readPressure, readSettings,
  readStat, readState, recordHistory, repoKey, scanProcs, sessionOf, signatureOf, treeOf, treeRssMB, updateState,
  type Decision, type HistoryEntry, type Job, type Settings,
} from "./gate.ts"

const say = (line: string) => process.stderr.write(`ntwine-run: ${line}\n`)

/** The house duration grammar: `40s`, `3m 05s`, `1h 12m`. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`
}

const gbLabel = (mb: number) => `${(mb / 1024).toFixed(1)}GB`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ───────────────────────────── the systemd memory scope

/**
 * Whether `systemd-run --user --scope` works here, cached for 10m in the state dir so a dead user
 * manager is noticed promptly and a live one costs one probe per 10m, not one per job.
 */
function scopeAvailable(dir: string): boolean {
  const path = join(dir, "scope-probe.json")
  try {
    const cached = JSON.parse(readFileSync(path, "utf8"))
    if (Date.now() - cached.at < 10 * 60_000) return cached.ok === true
  } catch {}
  const probe = spawnSync("systemd-run", ["--user", "--scope", "--quiet", "--collect", "--", "true"], { stdio: "ignore", timeout: 5_000 })
  const ok = probe.status === 0
  try { writeFileSync(path, JSON.stringify({ ok, at: Date.now() })) } catch {}
  return ok
}

// ───────────────────────────── run

interface Admission { decision: Decision; memAvailableMB: number; pressure: { kind: string; value: number | null }; heavyRunning: number }

async function run(argv: string[], hook: boolean): Promise<never> {
  const startedAt = Date.now()
  // The env off-switch is the HOOK's to read, in the session's own environment. A `NTWINE_GATE=0`
  // written into one call would reach only this wrapper, and a gate an agent can switch off per call
  // is not a gate; the config file still turns it off for everyone.
  let settings: Settings
  try {
    settings = readSettings(process.env, { honorEnvOffSwitch: !hook })
  } catch (error) {
    say(`gate unavailable (${(error as Error).message}); running now`)
    return exec(argv, process.env, null)
  }
  if (!settings.enabled) return exec(argv, process.env, null)

  const classified = classify(argv) ?? { class: "heavy" as const, words: argv }
  let job: Job
  let history: HistoryEntry[] | undefined
  try {
    const signature = signatureOf(repoKey(process.cwd()), classified)
    history = readHistory(settings.dir)[signature]
    const estimate = estimateMB(history, classified.class)
    const self = readStat(process.pid)
    job = {
      id: randomBytes(4).toString("hex"),
      pid: process.pid,
      ...(self && { pidStart: self.start }),
      session: sessionOf(),
      signature,
      cmd: argv.join(" ").slice(0, 300),
      cwd: process.cwd(),
      heavy: estimate >= settings.heavyMB,
      estimateMB: estimate,
      status: "queued",
      enqueuedAt: Date.now(),
    }
  } catch (error) {
    say(`gate unavailable (${(error as Error).message}); running now`)
    return exec(argv, process.env, null)
  }

  // Leaving the queue on a signal: drop the row, then die of the same signal.
  let admitted = false
  const leaveQueue = (signal: NodeJS.Signals) => {
    if (admitted) return
    try { updateState(settings.dir, (state) => { state.jobs = state.jobs.filter((j) => j.id !== job.id) }) } catch {}
    process.removeAllListeners(signal)
    process.kill(process.pid, signal)
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, leaveQueue)

  let admission: Admission | null = null
  let announced = false
  try {
    for (;;) {
      admission = updateState(settings.dir, (state) => {
        // Re-read every round: config.json can retune or switch off the gate under a waiting job.
        const live = readSettings(process.env, { honorEnvOffSwitch: !hook })
        let mine = state.jobs.find((j) => j.id === job.id)
        if (!mine) {
          mine = { ...job }
          state.jobs.push(mine)
        }
        // A run of the same command that finished while this one waited has just measured it: take
        // the new estimate, so a burst of identical suites queued on the default sizes itself after
        // the first one ends.
        history = readHistory(settings.dir)[job.signature]
        mine.estimateMB = job.estimateMB = estimateMB(history, classified.class)
        mine.heavy = job.heavy = job.estimateMB >= live.heavyMB
        const running = state.jobs.filter((j) => j.status === "running")
        const procs = running.length ? scanProcs() : new Map()
        const rssMB: Record<string, number> = {}
        for (const j of running) rssMB[j.id] = j.childPid ? treeRssMB(j.childPid, procs) : 0
        const pressure = readPressure(state, live)
        const host = { memAvailableMB: memAvailableMB(), pressure, rssMB }
        const decision = decide(mine, state.jobs, host, live)
        const heavyRunning = running.filter((j) => j.heavy).length
        if (decision.admit) {
          mine.status = "running"
          mine.admittedAt = Date.now()
          delete mine.waitReason
        } else {
          mine.waitReason = decision.reason
        }
        return { decision, memAvailableMB: host.memAvailableMB, pressure: { kind: pressure.kind, value: pressure.value }, heavyRunning }
      })
      if (admission.decision.admit) break
      if (!announced) {
        say(`queued: ${admission.decision.reason}. It starts on its own when there is room; the wait is not a hang.`)
        announced = true
      }
      await sleep(900 + Math.random() * 300)
    }
  } catch (error) {
    say(`gate unavailable (${(error as Error).message}); running now`)
    try { updateState(settings.dir, (state) => { state.jobs = state.jobs.filter((j) => j.id !== job.id) }) } catch {}
    // Inert from here rather than removed: removing the last listener hands SIGTERM back to its
    // default until exec() installs its own, and a signal in that gap kills this wrapper un-forwarded.
    admitted = true
    return exec(argv, process.env, null)
  }
  admitted = true // leaveQueue stays installed but inert, for the same reason
  const queueWaitMs = Date.now() - job.enqueuedAt
  if (announced) say(`started after ${duration(queueWaitMs)} in the queue`)

  // B3: size the job's own runtimes from what it has been measured to need. Unmeasured jobs are never
  // capped (a cap under their real need is a crash); see heapCapMB.
  const env = { ...process.env }
  let capMB: number | null = null
  let scopeArgs: string[] | null = null
  if (settings.caps) {
    const cap = heapCapMB(history, settings.heapFloorMB)
    if (cap !== null) {
      // A cap the caller already chose is theirs to keep.
      if (!/--max-old-space-size/.test(env.NODE_OPTIONS ?? "")) {
        env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --max-old-space-size=${cap}`.trim()
        capMB = cap
      }
      // Go's soft limit (tsgo, esbuild): it makes the GC work harder near the limit and never kills.
      if (!env.GOMEMLIMIT) env.GOMEMLIMIT = `${cap}MiB`
    }
  }
  // The scope backs the estimate with the kernel: past MemoryHigh the job is reclaimed (slowed) rather
  // than the whole box, past MemoryMax it is OOM-killed. Measured jobs only (a default estimate is a
  // guess, and killing a suite for our guess is worse than the thrash), heavy jobs only (throttling a
  // small one buys nothing), and never tighter than half a GB / a GB of slack over the estimate.
  if (settings.scope && job.heavy && history?.length && process.platform === "linux" && scopeAvailable(settings.dir)) {
    const high = Math.max(Math.ceil(job.estimateMB * 1.25), job.estimateMB + 512)
    const max = Math.max(Math.ceil(job.estimateMB * 1.5), job.estimateMB + 1024)
    scopeArgs = ["systemd-run", "--user", "--scope", "--quiet", "--collect", "-p", `MemoryHigh=${high}M`, "-p", `MemoryMax=${max}M`, "--"]
  }

  return exec(scopeArgs ? [...scopeArgs, ...argv] : argv, env, {
    settings, job, queueWaitMs, admission: admission!, capMB, scope: scopeArgs !== null, startedAt,
  })
}

interface Tracked {
  settings: Settings
  job: Job
  queueWaitMs: number
  admission: Admission
  capMB: number | null
  scope: boolean
  startedAt: number
}

/** Spawn the job, forward signals to its tree, measure its tree's peak RSS, and exit as it exited. */
function exec(argv: string[], env: NodeJS.ProcessEnv, tracked: Tracked | null): Promise<never> {
  return new Promise<never>(() => {
    const t0 = Date.now()
    let child: ChildProcess

    // Forward to every process in the job's tree, not just its root: a package manager does not
    // always pass a signal on, and an orphaned suite keeps its memory.
    //
    // Installed BEFORE the spawn. Once the job exists a signal can arrive at any moment, and with no
    // listener SIGTERM keeps its default, which kills this wrapper and leaves the whole tree running
    // un-signalled. Under load the gap between spawn() returning and a listener installed after it
    // was wide enough to hit (job-gate.test.ts, 2 of 30 runs with every core busy). A JS listener
    // only runs on a later event-loop turn, so `child` is always assigned by the time this does.
    //
    // ROOT FIRST (treeOf's preorder). Leaves first let a parent shell see its child die and carry on
    // before its own signal landed: `a; b` ran `b`, and the job exited 0 of a forwarded SIGTERM
    // (1 of the same 30 runs).
    const forward = (signal: NodeJS.Signals) => {
      if (!child?.pid) return
      const procs = scanProcs()
      for (const pid of treeOf(child.pid, procs)) {
        try { process.kill(pid, signal) } catch {}
      }
    }
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) process.on(signal, () => forward(signal))

    try {
      child = spawn(argv[0], argv.slice(1), { stdio: "inherit", env })
    } catch (error) {
      say(`${argv[0]}: ${(error as Error).message}`)
      return finish(127, null)
    }

    let peakMB = 0
    let rssMB = 0
    let lastWrite = 0
    const poll = () => {
      if (!child.pid) return
      try {
        const procs = scanProcs()
        const tree = treeOf(child.pid, procs)
        rssMB = 0
        for (const pid of tree) rssMB += procs.get(pid)!.rssKB / 1024
        rssMB = Math.round(rssMB)
        peakMB = Math.max(peakMB, rssMB)
        // A process's own high-water mark catches a spike that fell between two polls.
        for (const pid of tree) peakMB = Math.max(peakMB, hwmMB(pid))
        if (tracked && Date.now() - lastWrite > 5_000) {
          lastWrite = Date.now()
          updateState(tracked.settings.dir, (state) => {
            const mine = state.jobs.find((j) => j.id === tracked.job.id)
            if (mine) Object.assign(mine, { childPid: child.pid, rssMB, peakMB })
          })
        }
      } catch {}
    }
    // Fast at first, so a short job still gets a reading and the queue sees its childPid promptly.
    let polls = 0
    const tick = () => {
      poll()
      polls++
      timer = setTimeout(tick, polls < 20 ? 250 : 1_000)
    }
    let timer = tracked ? setTimeout(tick, 50) : undefined
    if (tracked && child.pid) {
      try {
        updateState(tracked.settings.dir, (state) => {
          const mine = state.jobs.find((j) => j.id === tracked.job.id)
          if (mine) mine.childPid = child.pid
        })
      } catch {}
    }

    child.on("error", (error) => {
      clearTimeout(timer)
      say(`${argv[0]}: ${(error as NodeJS.ErrnoException).code === "ENOENT" ? "command not found" : error.message}`)
      finish(127, null)
    })
    child.on("exit", (code, signal) => {
      clearTimeout(timer)
      finish(code, signal)
    })

    function finish(code: number | null, signal: NodeJS.Signals | null) {
      if (tracked) {
        const wallMs = Date.now() - t0
        const oom = tracked.capMB !== null && (code === 134 || signal === "SIGABRT")
        try {
          updateState(tracked.settings.dir, (state) => { state.jobs = state.jobs.filter((j) => j.id !== tracked.job.id) })
        } catch {}
        try {
          // A job killed by a signal in its first seconds says nothing about its memory.
          if (peakMB > 0 && !(signal && wallMs < 5_000)) {
            recordHistory(tracked.settings.dir, tracked.job.signature, {
              peakMB, at: Date.now(), exit: code, ...(tracked.capMB !== null && { capMB: tracked.capMB }), ...(oom && { oom: true }),
            })
          }
          appendTelemetry(tracked.settings.dir, {
            id: tracked.job.id, signature: tracked.job.signature, session: tracked.job.session, cmd: tracked.job.cmd,
            cwd: tracked.job.cwd, heavy: tracked.job.heavy, estimateMB: tracked.job.estimateMB, peakMB,
            queueWaitMs: tracked.queueWaitMs, wallMs, exit: code, signal,
            admit: {
              reason: tracked.admission.decision.reason, memAvailableMB: tracked.admission.memAvailableMB,
              pressure: tracked.admission.pressure, heavyRunning: tracked.admission.heavyRunning,
            },
            ...(tracked.capMB !== null && { capMB: tracked.capMB }),
            ...(tracked.scope && { scope: true }),
          })
        } catch {}
        if (oom) say(`the job exited ${signal ?? code} under --max-old-space-size=${tracked.capMB}; its next run gets a 50% larger heap.`)
      }
      if (signal) {
        process.removeAllListeners(signal)
        process.kill(process.pid, signal)
        setTimeout(() => process.exit(128 + (constants.signals[signal] ?? 1)), 1_000).unref()
        return
      }
      process.exit(code ?? 1)
    }
  })
}

// ───────────────────────────── status

function status(json: boolean) {
  const settings = readSettings()
  const state = readState(settings.dir)
  const procs = scanProcs()
  for (const job of state.jobs) {
    if (job.status === "running" && job.childPid) job.rssMB = treeRssMB(job.childPid, procs)
  }
  // On a copy: status only reads. With no fresh swap-in sample from a waiter, take one over a second.
  const scratch: typeof state = { ...state, vm: state.vm && { ...state.vm } }
  let pressure = readPressure(scratch, settings)
  if (pressure.kind === "unknown" && scratch.vm) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000)
    pressure = readPressure(scratch, settings)
  }
  const host = { memAvailableMB: memAvailableMB(), pressure }
  if (json) {
    process.stdout.write(`${JSON.stringify({ settings, host, state }, null, 2)}\n`)
    return
  }
  const running = state.jobs.filter((j) => j.status === "running")
  const queued = state.jobs.filter((j) => j.status === "queued").sort((a, b) => a.enqueuedAt - b.enqueuedAt)
  const pressureLabel = pressure.kind === "psi" ? `memory pressure ${pressure.value}%` : pressure.kind === "swapin" ? `swap-in ${pressure.value}MB/s` : "swap-in unmeasured"
  console.log(`${settings.enabled ? "" : "OFF · "}${running.length} running, ${queued.length} queued · ${gbLabel(host.memAvailableMB)} available · ${pressureLabel} · reserve ${gbLabel(settings.reserveMB)} · state ${settings.dir}`)
  const now = Date.now()
  for (const j of running) {
    console.log(`running  ${duration(now - (j.admittedAt ?? now)).padEnd(8)} ${j.session.slice(0, 28).padEnd(28)} ${`${gbLabel(j.rssMB ?? 0)}/${gbLabel(j.estimateMB)}`.padEnd(14)} ${j.signature}`)
  }
  for (const j of queued) {
    console.log(`queued   ${duration(now - j.enqueuedAt).padEnd(8)} ${j.session.slice(0, 28).padEnd(28)} ${`est ${gbLabel(j.estimateMB)}`.padEnd(14)} ${j.signature}${j.waitReason ? ` — ${j.waitReason}` : ""}`)
  }
}

// ───────────────────────────── main

const args = process.argv.slice(2)
if (args[0] === "status") {
  status(args.includes("--json"))
} else {
  const hook = args[0] === "--hook"
  const dash = args.indexOf("--")
  const command = dash >= 0 ? args.slice(dash + 1) : args.filter((a) => a !== "--hook")
  if (!command.length) {
    process.stderr.write("usage: ntwine-run -- <command> [args…]\n       ntwine-run status [--json]\n")
    process.exit(2)
  }
  try { mkdirSync(readSettings().dir, { recursive: true }) } catch {}
  await run(command, hook)
}
