import { existsSync, realpathSync } from "node:fs"
import { readlink } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

// WHERE A RUNNING AGENT SHELL ACTUALLY IS — asked of the OS, because the transcript cannot say.
//
// A shell's start folder was first read off its launch record's `cwd`, adjusted for a leading `cd`
// (tailer.ts shellStartCwd). The first real run showed that reading is wrong exactly when it matters
// (2026-09-29, haiku on an isolated stack). The harness stamps a record's `cwd` when it WRITES the
// record, and it writes a turn's records in a batch. The worker started a shell in the project root,
// then ran `git worktree add … && cd` into the worktree. Every record of that turn, including the first
// shell's launch and the thinking before it, landed stamped with the worktree. So the root shell's row
// said `probe`, the one fact the maintainer asked this surface to get right ("when the agent chooses to
// use a worktree instead of main").
//
// The process knows. The shell holds its own `tasks/<taskId>.output` open as stdout and stderr, which is
// the same fact the liveness probe (tailer.ts probeShellsAlive) asks `lsof` about, and a holder's
// working directory is where the command is running. That includes a `cd` inside the command itself,
// which is the folder a human means by "where it runs". So:
//
//   1. `lsof -F pn -- <paths>` names each path's holders: a `p<pid>` line, then an `n<path>` line per fd.
//   2. The LOWEST pid holding a path is taken as the shell. Its children (a `sleep`, a dev server's
//      workers) inherit the same fds and were spawned after it, and they almost always share its folder.
//      Never THIS process: Ntwine's server opens the same log for the drawer's read and the line counter,
//      and an lsof that sampled one of those reads found the server — whose pid is almost always the lower
//      — so the server's own folder would have been taken for the shell's.
//   3. That pid's cwd: `/proc/<pid>/cwd` on Linux (a readlink, no process spawned);
//      `lsof -a -d cwd -F pn -p <pids>` on macOS, which has no /proc.
//
// Every uncertain step answers `undefined`, and `undefined` leaves the transcript's reading in place:
// no lsof, a path nobody holds (the shell finished before anyone asked), a process gone between the two
// questions, or Windows (whose probe is an exclusive open, which names no holder). A guess is never
// substituted for either reading.
//
// Only a VETTED path is ever asked about (background-shell-output.ts vetHarnessOutputPath). An agent can
// forge a launch ack naming any file, and the folder of whatever process holds some other file is not a
// fact about this shell.

const execFileAsync = promisify(execFile)

export interface ShellCwdProbeOptions {
  platform?: NodeJS.Platform
  exec?: typeof execFileAsync
  /** Linux's cwd reader, injectable for tests on other platforms. */
  readCwd?: (pid: number) => Promise<string>
  /** The pid never taken for a shell — this server's own (see step 2). */
  selfPid?: number
}

/** `lsof -F pn` output → each named path's holder pids, in the order lsof printed them. */
export function parseLsofHolders(stdout: string): Map<string, number[]> {
  const holders = new Map<string, number[]>()
  let pid: number | undefined
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) {
      const n = Number(line.slice(1))
      pid = Number.isInteger(n) && n > 0 ? n : undefined
    } else if (line.startsWith("n") && pid !== undefined) {
      const path = line.slice(1)
      const list = holders.get(path) ?? []
      if (!list.includes(pid)) list.push(pid)
      holders.set(path, list)
    }
  }
  return holders
}

/** Run lsof and return its stdout, or undefined when it could not answer. lsof exits 1 as soon as ANY
 *  path in a batch is unheld, which is an answer; only a failure to run, or a timeout, is not. */
async function lsof(exec: typeof execFileAsync, args: string[]): Promise<string | undefined> {
  try {
    return String((await exec("lsof", args, { encoding: "utf8", timeout: 8000 })).stdout)
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; code?: string | number; killed?: boolean }
    return typeof e.code === "number" && !e.killed ? String(e.stdout ?? "") : undefined
  }
}

export async function probeShellCwds(outputFiles: readonly string[], opts: ShellCwdProbeOptions = {}): Promise<Map<string, string | undefined>> {
  const platform = opts.platform ?? process.platform
  const exec = opts.exec ?? execFileAsync
  const out = new Map<string, string | undefined>()
  for (const file of outputFiles) out.set(file, undefined)
  if (platform === "win32") return out
  // lsof prints the REAL path (macOS: /tmp is /private/tmp), so ask by it and map the answer back.
  const byReal = new Map<string, string>()
  for (const file of outputFiles) {
    if (!existsSync(file)) continue
    try {
      byReal.set(realpathSync(file), file)
    } catch {
      // unreadable ⇒ no reading
    }
  }
  if (byReal.size === 0) return out
  const report = await lsof(exec, ["-F", "pn", "--", ...byReal.keys()])
  if (report === undefined) return out
  const self = opts.selfPid ?? process.pid
  const shellPid = new Map<string, number>()
  for (const [real, holders] of parseLsofHolders(report)) {
    const file = byReal.get(real)
    const pids = holders.filter((pid) => pid !== self)
    if (file && pids.length > 0) shellPid.set(file, Math.min(...pids))
  }
  if (shellPid.size === 0) return out
  const cwdOf = await readCwds([...new Set(shellPid.values())], platform, exec, opts.readCwd)
  for (const [file, pid] of shellPid) out.set(file, cwdOf.get(pid))
  return out
}

async function readCwds(pids: number[], platform: NodeJS.Platform, exec: typeof execFileAsync, readCwd?: (pid: number) => Promise<string>): Promise<Map<number, string>> {
  const cwds = new Map<number, string>()
  if (platform === "linux" || readCwd) {
    const read = readCwd ?? ((pid: number) => readlink(`/proc/${pid}/cwd`))
    await Promise.all(pids.map(async (pid) => {
      try {
        const dir = await read(pid)
        // A process whose folder was deleted reads as "<dir> (deleted)": the folder is not there to open.
        if (dir && !dir.endsWith(" (deleted)")) cwds.set(pid, dir)
      } catch {
        // gone, or not ours to read ⇒ no reading
      }
    }))
    return cwds
  }
  const report = await lsof(exec, ["-a", "-d", "cwd", "-F", "pn", "-p", pids.join(",")])
  if (report === undefined) return cwds
  for (const [dir, holders] of parseLsofHolders(report)) for (const pid of holders) cwds.set(pid, dir)
  return cwds
}
