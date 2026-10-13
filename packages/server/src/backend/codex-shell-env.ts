import { frizzCliEnv, withFrizzCliOnPath, type FrizzCli } from "./types.ts"

/**
 * The PER-THREAD shell environment for one codex thread's `thread/start` (and every `thread/resume`)
 * config: what lets `frizzctl`, run from that thread's own shell, find the server and know WHO IS
 * CALLING.
 *
 * WHY IT RIDES THE THREAD'S CONFIG AND NOT THE APP-SERVER'S ENVIRONMENT. The app-server is
 * per-PROJECT and serves every codex thread in it, so its process environment cannot name a thread —
 * the same fact that kept `FRIZZ_THREAD_SLUG` off the MCP mount until codexThreadMcpConfig. And the
 * app-server is long-lived (up to six hours idle, unbounded while a client keeps reattaching), so a
 * variable added to its environment reaches only daemons spawned AFTER the update that added it: a
 * thread started on a surviving daemon would be told to run a command its shell cannot find. The
 * config bag is sent with every start and every resume, so it reaches both.
 *
 * MEASURED on codex-cli 0.161.0, `_live_codex_shell_identity.mts` (30 readings, 2026-10-11):
 *   - a `shell_environment_policy.set` entry in the bag reaches that thread's shell commands, two
 *     threads on one app-server each seeing their own value, with concurrent turns;
 *   - a `spawn_agent` child's shell INHERITS it, so a sub-agent acts as its parent's thread;
 *   - it adds to the process environment rather than replacing it;
 *   - it is NOT stored in the rollout: a resume without the bag has none of it. Every resume Frizz
 *     issues carries the bag (threadConfig).
 *
 * THE DOTTED SPELLING, one key per variable, is one of three that worked and the only one that
 * cannot clobber a `shell_environment_policy` table the operator wrote in `~/.codex/config.toml`.
 *
 * PATH IS SET WHOLE, because a `set` entry replaces the variable: it is the app-server's own PATH
 * with the command's directory in front. Codex still prepends two entries of its own and a login
 * shell reorders the rest (measured: our directory landed 5th, 19th and 26th), which is why the
 * command has a name nothing else on a machine claims — position cannot be relied on, presence can.
 *
 * WHAT THIS CANNOT DO: a thread narrowed to `workspace-write` or `read-only` has no network, loopback
 * included (curl exit 7 on both a TCP listener and a unix socket), so the command runs and cannot
 * reach the server. Every thread Frizz creates is `danger-full-access`; the command says so plainly
 * when it finds itself in the other case.
 */
export function codexThreadShellConfig(
  cli: FrizzCli | undefined,
  slug: string,
  appServerEnv: NodeJS.ProcessEnv,
  nodeBin: string = process.execPath,
  platform: NodeJS.Platform = process.platform,
): Record<string, unknown> {
  if (!cli) return {}
  const vars: Record<string, string> = frizzCliEnv(cli, slug, nodeBin)
  const pathKey = Object.keys(appServerEnv).find((k) => (platform === "win32" ? k.toUpperCase() === "PATH" : k === "PATH"))
  const path = pathKey ? appServerEnv[pathKey] : undefined
  if (pathKey && path) Object.assign(vars, withFrizzCliOnPath({ [pathKey]: path }, cli, platform))
  const config: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(vars)) config[`shell_environment_policy.set.${name}`] = value
  return config
}
