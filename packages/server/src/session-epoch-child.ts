import { readFileSync } from "node:fs"
import { join } from "node:path"
import { advanceSessionEpoch, SESSION_EPOCH, type SessionEpochAdvance } from "./access-codes.ts"
import { SUPERVISOR_SESSIONS_PATH } from "./restart-supervisor.ts"

/**
 * The server child's half of SESSION_EPOCH.
 *
 * The session gate lives in the LAUNCHER (the `ntwine` package), and an in-app update replaces only this
 * child (the `ntwine-server` package): the launcher, its listener and its in-memory signing key keep
 * running. So a launcher that predates an epoch bump never applies it on its own, and a launcher that
 * knows the bump applies it only at its next start. This closes that gap from the child's side:
 *
 *   1. Advance the epoch on disk. That rotates the key FILE, which every launcher (old or new) reads at
 *      its next start, so every session minted before the bump is dead from then on.
 *   2. Ask the running launcher, over loopback, to sign every device out now — the same request as
 *      `ntwine --sign-out all`. Every launcher since 2026-08-25 answers it by denylisting every recorded
 *      device at once; one built with this change also swaps its in-memory key.
 *
 * What survives on a launcher older than this change, until its next start: a session minted before
 * per-device ids (2026-08-25), which no denylist can name, and every session if the board had no public
 * origin at the moment of the request (that launcher refuses the request then; there was no remote
 * device to reach it anyway). A launcher that already applied the epoch at its own start leaves this
 * a no-op, because the record is shared.
 */
export async function signOutOlderSessionEpoch(options: {
  stateDir: string
  /** The launcher that forked this child: only its own lock file is trusted to name the port. */
  supervisorPid: number
  epoch?: number
  fetcher?: typeof fetch
}): Promise<{ advance: SessionEpochAdvance; signedOut: number | null }> {
  const advance = advanceSessionEpoch(options.stateDir, options.epoch ?? SESSION_EPOCH)
  if (!advance.advanced || !advance.rotatedKey) return { advance, signedOut: 0 }
  const port = supervisorPort(options.stateDir, options.supervisorPid)
  if (port === undefined) return { advance, signedOut: null }
  try {
    const response = await (options.fetcher ?? fetch)(`http://127.0.0.1:${port}${SUPERVISOR_SESSIONS_PATH}`, {
      method: "POST",
      // Node's fetch sends no Origin, and the control plane wants one on a POST: name the loopback
      // authority, as `ntwine --sign-out` does.
      headers: { origin: `http://127.0.0.1:${port}`, "content-type": "application/json" },
      body: JSON.stringify({ all: true }),
      signal: AbortSignal.timeout(5_000),
    })
    // 409 is "no public origin": nothing remote can reach the board right now, and the rotated file
    // covers the next start. Anything else non-2xx is a launcher we could not ask.
    if (response.status === 409) return { advance, signedOut: 0 }
    if (!response.ok) return { advance, signedOut: null }
    const body = (await response.json().catch(() => undefined)) as { signedOut?: unknown } | undefined
    return { advance, signedOut: typeof body?.signedOut === "number" ? body.signedOut : null }
  } catch {
    return { advance, signedOut: null }
  }
}

function supervisorPort(stateDir: string, supervisorPid: number): number | undefined {
  try {
    const status = JSON.parse(readFileSync(join(stateDir, "dev-supervisor.lock"), "utf8")) as { pid?: unknown; port?: unknown }
    if (status.pid !== supervisorPid) return undefined
    return Number.isInteger(status.port) && (status.port as number) > 0 && (status.port as number) <= 65_535
      ? (status.port as number)
      : undefined
  } catch {
    return undefined
  }
}
