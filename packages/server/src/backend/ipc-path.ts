// One local IPC endpoint address, spelled the way the running platform can actually bind it.
//
// Ntwine's detached daemons — the Claude session broker, the codex app-server daemon, the codex native
// listener — each talk to the server over a local socket whose path is DERIVED from the identity they
// serve (state dir + session/project id), so a restarted ntwine can find a daemon it did not spawn
// without a registry. That derivation is what this module owns.
//
// POSIX gets a filesystem unix socket under the OS temp dir. The name is hashed short because unix
// socket paths cap at ~104 bytes on macOS/BSD and a project state dir alone is easily longer.
//
// WINDOWS HAS NO AF_UNIX FILESYSTEM SOCKETS. `net.Server.listen()` on a `.sock` path under %TEMP%
// fails with `listen EACCES: permission denied` — measured on Windows Server 2022 / node 26.7.0,
// which is what made every broker-backed session unreachable there: the daemon died on
// `socket-listen-failed` before it could publish its record, and every dispatch timed out with "did
// not become ready". Named pipes live in their own kernel namespace, node's `net` module binds and
// connects them natively, and they have no length limit — so win32 gets `\\.\pipe\<name>` built from
// the same hashed identity, and the POSIX spelling is unchanged byte for byte.
//
// Three consequences of the pipe namespace that callers depend on, all measured on the same box:
//
//   - `existsSync()` is TRUE for a bound pipe and FALSE once its listener closes, so the liveness
//     gates that ask "is the socket still there" keep working unmodified.
//   - `unlinkSync()` throws EINVAL. A pipe is reclaimed by the kernel when its last handle closes, so
//     there is nothing to unlink and nothing to leak; every unlink on this path is already either
//     `try {} catch {}` or gated on win32.
//   - A pipe leaves NO FILE BEHIND, which is why stale-socket-sweep.ts correctly does nothing on
//     win32 — there is no corpse to collect.
import { join } from "node:path"

/**
 * Address a local IPC endpoint by NAME — `ntwine-claude-<key>`, `ntwine-codex-<key>`, … — and get back
 * the platform's spelling of it: `$TMPDIR/<name>.sock` on POSIX, `\\.\pipe\<name>` on Windows.
 *
 * `name` must already be short and collision-resistant (hash the identity into it), because the POSIX
 * spelling inherits the ~104-byte unix socket path limit.
 */
export function ntwineIpcPath(name: string): string {
  if (process.platform === "win32") return `\\\\.\\pipe\\${name}`
  return join(process.env.TMPDIR ?? "/tmp", `${name}.sock`)
}
