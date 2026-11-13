import { execFileSync } from "node:child_process"
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync, writeSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { SECRET_MAX_READS, SECRET_TTL_MS } from "@ntwine/shared"

/**
 * Where a SECRET answer goes instead of the database — the value the human pasted into a masked card
 * (`ntwinectl secret`): a one-time code, a token, a password.
 *
 * NOT A FILE. The path the worker is given is a NAMED PIPE (a FIFO, 0600 in a 0700 dir under the
 * project's state dir), and the value lives only in this process's memory. Each reader that opens the
 * pipe gets the value written into it — through the kernel, never onto disk. So:
 *
 *   - nothing persists: no plaintext for a backup, a sync client or a later `grep` to find;
 *   - it is READ UP TO SECRET_MAX_READS TIMES, then the path is gone. It was single use until
 *     2026-11-12, and that turned every failed consumer into another paste: one Vercel token was pasted
 *     four times in one thread, because a repo lock, a filtered-away error and a malformed file each
 *     spent a read, and then the consumer exited 0 having stored nothing. The cap still bounds a loop;
 *   - it is RELEASED when the worker removes the path (`rm`, after the command worked), when the thread
 *     signs off with `done` (releaseThreadSecrets), or when it EXPIRES, SECRET_TTL_MS after the answer,
 *     read or not. A server start clears every pipe a previous process left (no writer can stand behind
 *     one, so a reader would block forever).
 *
 * THE COST OF RE-READS is how long the value sits in memory. Single use dropped it at the first read,
 * usually seconds after the answer; now it stays until `rm`, `done`, the cap or the TTL. The ceiling is
 * the same 15 minutes it always was for an unread value, and the reader it is open to is the same: this
 * uid, through a 0600 pipe in a 0700 dir. The TTL counts from the answer and never restarts on a read.
 *
 * The worker's command is unchanged from the plaintext-file version this replaced (2026-10-08): it reads
 * the value inside the command that uses it, `--otp "$(cat '<path>')"`, and the transcript carries only
 * the path.
 *
 * HOW THE WRITE FINDS ITS READER. Node has no blocking-free way to wait for a FIFO's reader, and a
 * blocking open would hold a libuv thread until one came. So a timer tries a NON-BLOCKING write-open
 * every POLL_MS: with no reader it fails with ENXIO and nothing happens; with one it succeeds, the value
 * (far below a pipe's buffer) goes in whole, and the close gives the reader its EOF. So OPENING the path
 * spends the value, read or not — a reader blocks in its open until this writer arrives, and is present
 * for the write — while looking at it (`ls`, `test -p`) does not. A reader gone between the open and the
 * write raises EPIPE, and the read is not counted.
 *
 * ONE INODE PER READ. After a delivery the next read must not land in the SAME pipe: a non-blocking
 * write-open succeeds while any reader holds it, so a slow `cat` that has not yet seen its EOF would get
 * the value a second time, concatenated. So each delivery renames a FRESH fifo over the path before it
 * closes its writer: readers already on the old inode get that write and then EOF, and every open after
 * the rename waits on the new one. The rename is atomic, so the path never stops existing between reads.
 *
 * WINDOWS HAS NO FIFOs. There the value is a 0600 file, removed at the same TTL, at `done` and at the
 * next start — the weaker shape, kept so the tool works rather than refusing. Nothing sees a file's
 * reads, so the cap does not apply there.
 */

const POLL_MS = 100

interface Served {
  timer: NodeJS.Timeout
}

/** Every pipe this process is serving, by path. The value lives only in the timer's closure. */
const served = new Map<string, Served>()

function secretsRoot(stateDir: string): string {
  return join(stateDir, "secrets")
}

/** The path a secret question's value is served at. Deterministic, so `ask` can name it at registration.
 *  Both segments are ntwine-minted (a validated thread slug and a `qst_` id), never worker text. */
export function secretFilePath(stateDir: string, slug: string, questionId: string): string {
  return join(secretsRoot(stateDir), slug, questionId)
}

function stop(path: string): void {
  const entry = served.get(path)
  if (entry) clearInterval(entry.timer)
  served.delete(path)
  rmSync(path, { force: true })
  rmSync(join(dirname(path), `.${basename(path)}.next`), { force: true })
  // The thread's directory goes with its last pipe, so a finished secret leaves no trace at all.
  try {
    rmdirSync(dirname(path))
  } catch {}
}

/** Drop every value this process still serves for one thread: the worker signed off, so whatever it
 *  did not `rm` itself is finished with. */
export function releaseThreadSecrets(stateDir: string, slug: string): number {
  const dir = join(secretsRoot(stateDir), slug)
  let released = 0
  for (const path of [...served.keys()]) {
    if (dirname(path) !== dir) continue
    stop(path)
    released++
  }
  return released
}

/** Serve the value at its path — from memory, up to `maxReads` times — until the worker removes the
 *  path, the thread signs off, or the TTL passes. Returns the path. */
export function serveSecret(
  stateDir: string,
  slug: string,
  questionId: string,
  value: string,
  opts: { now?: () => number; ttlMs?: number; maxReads?: number; platform?: NodeJS.Platform } = {},
): string {
  const now = opts.now ?? Date.now
  const expiresAt = now() + (opts.ttlMs ?? SECRET_TTL_MS)
  const root = secretsRoot(stateDir)
  const dir = join(root, slug)
  const path = secretFilePath(stateDir, slug, questionId)
  // Replacing a value this process is still serving: stop the old one BEFORE making the directory, since
  // stopping removes a directory its last pipe leaves empty.
  stop(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // mkdir's mode only applies to directories it CREATES, and the umask narrows it further; a root left
  // by an older build or a hand-made one is tightened here rather than trusted.
  chmodSync(root, 0o700)
  chmodSync(dir, 0o700)

  if ((opts.platform ?? process.platform) === "win32") {
    writeFileSync(path, value, { mode: 0o600 })
    const timer = setInterval(() => {
      if (now() >= expiresAt || !existsSync(path)) stop(path)
    }, 1_000)
    timer.unref()
    served.set(path, { timer })
    return path
  }

  execFileSync("mkfifo", ["-m", "600", path])
  const bytes = Buffer.from(value, "utf8")
  const maxReads = opts.maxReads ?? SECRET_MAX_READS
  // The next inode is made beside the path and renamed over it (ONE INODE PER READ, above). A dotted
  // name, so it is never mistaken for a value's path; clearSecrets sweeps one a crash left.
  const next = join(dir, `.${questionId}.next`)
  let reads = 0
  const timer = setInterval(() => {
    // The worker removing the path is how it says it is finished with an unread value.
    if (now() >= expiresAt || !existsSync(path)) return stop(path)
    let fd: number
    try {
      fd = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK)
    } catch {
      return // ENXIO: nobody is reading yet.
    }
    let delivered = false
    let renewed = false
    try {
      delivered = writeSync(fd, bytes) === bytes.length
      if (delivered) reads++
      // Swap in a fresh pipe BEFORE closing, so no open can slip onto the inode this write is ending.
      if (delivered && reads < maxReads) {
        rmSync(next, { force: true })
        execFileSync("mkfifo", ["-m", "600", next])
        renameSync(next, path)
        renewed = true
      }
    } catch {
      // EPIPE: the reader left before the write. Keep the value for the next one. (A swap that failed
      // after a delivery lands below: with no fresh inode, the value is not served again.)
    } finally {
      closeSync(fd)
    }
    if (delivered && !renewed) stop(path)
  }, POLL_MS)
  timer.unref()
  served.set(path, { timer })
  return path
}

/** Remove everything under the secrets dir — at a server start, where no pipe can have a writer behind
 *  it any more, and where a plaintext file from before the pipes (2026-10-08) must not linger. Pipes
 *  THIS process is serving are left alone, so a second context on the same state dir cannot cut one off. */
export function clearSecrets(stateDir: string): number {
  const root = secretsRoot(stateDir)
  let removed = 0
  let threads: string[]
  try {
    threads = readdirSync(root)
  } catch {
    return 0
  }
  for (const thread of threads) {
    const dir = join(root, thread)
    let entries: string[]
    try {
      if (!lstatSync(dir).isDirectory()) {
        rmSync(dir, { force: true })
        continue
      }
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(dir, entry)
      if (served.has(path)) continue
      rmSync(path, { force: true })
      removed++
    }
    try {
      if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
  return removed
}
