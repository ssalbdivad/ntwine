// Collect the unix-socket FILES that ntwine's detached daemons leave behind, without ever touching a
// live one. Extracted verbatim from codex-app-server-daemon.ts (which was the only caller) so the
// Claude session broker's sockets get the identical treatment rather than a second, subtly weaker
// implementation.
//
// The leak: a daemon that was SIGKILLed, or that skipped its own cleanup because a SUCCESSOR already
// owned its record, leaves its socket file behind forever. Nothing ever revisits those paths — a host
// only ever considers the one path belonging to the session/project it is connecting for — so they
// accumulate. Measured 2026-07-27 in this machine's $TMPDIR: ~119 dead `ntwine-claude-*.sock` against
// ~4 live ones.
//
// SAFETY IS THE ENTIRE DESIGN, and the danger is the opposite of the obvious one: a naive sweep does
// not merely delete a file, it can delete a LIVE SUCCESSOR's socket — the corpse-deletes-successor bug
// this repo has been bitten by — and merely CONNECTING to a live socket is itself destructive, because
// both daemons treat a new connection as the client taking over (the codex daemon destroys the previous
// socket; the broker reassigns `client` and drains its event backlog into whoever just connected). So:
//
//   1. `lsof -U` names every unix-socket endpoint on the machine. A path ANY process still references
//      is never probed at all — not even connected to.
//   2. Only then is the path probed, and the connection must be REFUSED (ECONNREFUSED/ENOENT — kernel
//      proof that no listener is bound) before anything is unlinked. A probe that CONNECTS means lsof
//      was wrong; that path is left alone.
//   3. No lsof, lsof failing, or an unreadable directory ⇒ sweep NOTHING. Absence of evidence is never
//      taken as evidence of death.
//
// Every step is fire-and-forget and unref'd: this is opportunistic housekeeping and must never hold
// the event loop open or delay the caller.
import { execFile } from "node:child_process"
import { readdirSync, unlinkSync } from "node:fs"
import { connect as connectSocket } from "node:net"
import { join } from "node:path"

export interface StaleSocketSweepOptions {
  /** Directory holding the socket files (their parent dir — $TMPDIR in practice). */
  dir: string
  /** Filename prefix identifying this daemon family, e.g. `ntwine-codex-` / `ntwine-claude-`. */
  prefix: string
  /** Paths that must never be swept regardless of the evidence — typically the caller's own socket. */
  keep?: readonly string[]
}

/** Every seam is injectable so the safety rules can be tested without an `lsof` or a real socket. */
export interface StaleSocketSweepDeps {
  readdir?: (dir: string) => string[]
  /** Report every socket path some process still references, or `null` when there is no evidence. */
  listReferenced?: (prefix: string, done: (referenced: Set<string> | null) => void) => void
  /** Report whether `path` is DEAD — i.e. the kernel refused a connection to it. */
  probe?: (path: string, verdict: (dead: boolean) => void) => void
  unlink?: (path: string) => void
}

/**
 * The paths in `lsof -U -F n` output, one `n`-prefixed line per endpoint. macOS prints the bare path
 * (`n/tmp/x.sock`); Linux lsof (4.95 measured on Ubuntu 24.04, 2026-08-24) appends metadata after the
 * path (`n/tmp/x.sock type=STREAM`), which made every live socket miss the equality check against its
 * candidate path — so the sweep PROBED live listeners, and a probe that connects is itself the harm
 * (both daemons treat a connection as client takeover). Both the raw and the suffix-stripped spelling
 * are returned: over-including can only make the sweep SKIP a candidate, never unlink a live one.
 */
export function parseLsofSocketNames(stdout: string): Set<string> {
  const referenced = new Set<string>()
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("n/")) continue
    const raw = line.slice(1)
    referenced.add(raw)
    const meta = raw.indexOf(" type=")
    if (meta > 0) referenced.add(raw.slice(0, meta))
  }
  return referenced
}

const defaultListReferenced = (prefix: string, done: (referenced: Set<string> | null) => void): void => {
  execFile("lsof", ["-U", "-F", "n"], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
    // lsof absent or silent: we have no evidence, so we touch nothing.
    if (!stdout) return done(null)
    // lsof exits non-zero when it could not stat SOME process. That is routine and its output is still
    // usable — but only if this family appears in it at all; otherwise the run may have died early and
    // a live socket could be missing from the list.
    if (error && !stdout.includes(prefix)) return done(null)
    done(parseLsofSocketNames(stdout))
  }).unref?.()
}

const defaultProbe = (path: string, verdict: (dead: boolean) => void): void => {
  const probe = connectSocket(path)
  probe.unref?.()
  probe.on("connect", () => { probe.destroy(); verdict(false) }) // live after all — lsof was wrong
  probe.on("error", (error: NodeJS.ErrnoException) => {
    probe.destroy()
    verdict(error.code === "ECONNREFUSED" || error.code === "ENOENT")
  })
}

/**
 * Sweep dead `<prefix>*.sock` files out of `dir`. Returns immediately; the work happens on callbacks.
 * Never throws. A no-op on win32, where daemons use named pipes and there is no file to leak.
 */
export function sweepStaleSockets(options: StaleSocketSweepOptions, deps: StaleSocketSweepDeps = {}): void {
  if (process.platform === "win32") return
  const keep = new Set(options.keep ?? [])
  let candidates: string[]
  try {
    candidates = (deps.readdir ?? readdirSync)(options.dir)
      .filter((name) => name.startsWith(options.prefix) && name.endsWith(".sock"))
      .map((name) => join(options.dir, name))
      .filter((path) => !keep.has(path))
  } catch { return }
  if (candidates.length === 0) return
  const probe = deps.probe ?? defaultProbe
  const unlink = deps.unlink ?? ((path: string) => { try { unlinkSync(path) } catch {} })
  ;(deps.listReferenced ?? defaultListReferenced)(options.prefix, (referenced) => {
    if (!referenced) return
    for (const path of candidates) {
      if (referenced.has(path)) continue
      probe(path, (dead) => { if (dead) unlink(path) })
    }
  })
}
