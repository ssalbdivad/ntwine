import { spawnSync } from "node:child_process";

export interface CommandProbe {
  (command: string): boolean;
}

export interface LaunchPrerequisiteOptions {
  nodeVersion?: string;
  command?: CommandProbe;
}

/**
 * The Node releases ntwine actually runs on, MEASURED rather than derived from dependency manifests.
 *
 * ntwine's database is `node:sqlite`, unflagged in v22.13.0 and v23.4.0. Below those the module does not
 * exist at all — the import fails with "No such built-in module" — so the floor is simply the release
 * that shipped it. Verified by running the driver's own suite (`sqlite.test.ts`) on 22.12, 22.13,
 * 22.14, 23.4, 23.6, 24 and 26: every release from 22.13 up passes it whole, and 22.12 is the only
 * failure. Anything newer than the highest line listed is assumed good.
 *
 * Hence a floor PER RELEASE LINE rather than one number: a plain `>=22.13` would also advertise
 * 23.0-23.3, where `node:sqlite` does not exist either.
 *
 * This was 22.14 until the database moved off better-sqlite3, whose prebuild is built with
 * `NAPI_VERSION=10` (available only from 22.14/23.6) while the package declared `engines: ">=22"`. On
 * an older Node that addon did not fail to load, it SEGFAULTED inside `napi_module_register_by_symbol`.
 * A built-in module has no prebuild, no ABI and no floor that can shift under a lockfile update, so
 * the migration deleted that whole class of failure — and, unusually, LOWERED the floor by a release.
 *
 * `package.json`'s `engines.node` mirrors this table and a test asserts they stay equal. They have
 * drifted twice, in both directions: `>=26` against an enforced 22.12 (an EBADENGINE warning about a
 * floor nothing checked), then `>=22.12.0` against a runtime that segfaulted there. The published
 * package ships COMPILED JS, so the source workflow's Node is never the consumer's Node.
 */
export const SUPPORTED_NODE_LINES = [
  { major: 22, minor: 13 },
  { major: 23, minor: 4 },
] as const;

/**
 * Node-API version → the release lines that first ship it, from the matrix at nodejs.org/api/n-api.html.
 *
 * Kept even though the database no longer needs it: @parcel/watcher is still a native addon. The test
 * beside it re-derives the requirement from what it actually builds against, so if it raises its
 * Node-API version the suite fails there instead of a user's board dying at boot.
 */
export const NODE_API_AVAILABILITY: Record<number, ReadonlyArray<{ major: number; minor: number }>> = {
  8: [{ major: 16, minor: 0 }],
  9: [{ major: 18, minor: 17 }, { major: 20, minor: 3 }, { major: 21, minor: 0 }],
  10: [{ major: 22, minor: 14 }, { major: 23, minor: 6 }],
};

/** The lowest release overall, for the message and for anything that just wants one number. */
export const MINIMUM_NODE = SUPPORTED_NODE_LINES[0];

/** The `engines.node` range this table describes, so the manifest is never hand-maintained. */
export function supportedNodeRange(): string {
  const highest = SUPPORTED_NODE_LINES[SUPPORTED_NODE_LINES.length - 1]!;
  return SUPPORTED_NODE_LINES.map((line) =>
    line === highest
      ? `>=${line.major}.${line.minor}.0`
      : `^${line.major}.${line.minor}.0`
  ).join(" || ");
}

/** Is this Node one ntwine is known to run on? See SUPPORTED_NODE_LINES for how "known" was decided. */
export function nodeVersionIsSupported(major: number, minor: number): boolean {
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) return false;
  const line = SUPPORTED_NODE_LINES.find((entry) => entry.major === major);
  if (line) return minor >= line.minor;
  // Below every line we know about, or between two of them, is unsupported; above them all is fine.
  return major > SUPPORTED_NODE_LINES[SUPPORTED_NODE_LINES.length - 1]!.major;
}

export interface ProviderReadiness {
  claude: boolean;
  codex: boolean;
}

/**
 * The executables every ntwine launch shells out to, with the reason each one is needed. `git` is
 * reached before any prerequisite check used to run (`resolveWorkspace` execs `git rev-parse`), so a
 * machine missing it was diagnosed by whichever caller happened to fail first, in that caller's
 * vocabulary — "ntwine-dev must be run inside a Git repository". Say what is actually wrong, and say it
 * before the work starts.
 *
 * `tmux` was here too, for "terminal panes and interactive provider logins". Neither is true any more:
 * agents run in the broker/app-server over pipes, and so does sign-in. Requiring it kept ntwine
 * off Windows, where tmux has no native build, for a dependency nothing used.
 */
// Nothing here any more. Git was the only entry, and a project is no longer defined as a Git
// repository — the root comes from marker walk-up and the id from `.ntwine/.id` (project-root.ts), so
// a plain directory never shells out to git at all. Kept as the seam for the next hard dependency.
const REQUIRED_EXECUTABLES: readonly { name: string; need: string }[] = [];

export function assertRequiredExecutables(command: CommandProbe = commandIsAvailable): void {
  for (const { name, need } of REQUIRED_EXECUTABLES) {
    if (command(name)) continue;
    throw new Error(
      `required executable \`${name}\` is not available on PATH; ${need}. ` +
        `Install ${name} (\`brew install ${name}\` on macOS, \`apt install ${name}\` on Debian/Ubuntu) ` +
        `and relaunch ntwine`
    );
  }
}

export function commandIsAvailable(command: string): boolean {
  // Avoid a shell and any persistent side effects.
  const versionArg = "--version";
  const result = spawnSync(command, [versionArg], {
    stdio: "ignore",
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

/**
 * Prerequisites shared by every local ntwine launch. Provider CLIs are deliberately not included:
 * a workstation may use one backend while the other is unavailable.
 *
 * The Node floor here is a genuine minimum, not a proxy for the older Node-26 gate: it is the lowest
 * release that ships `node:sqlite` (see `SUPPORTED_NODE_LINES`). It is complementary
 * to `assertArtifactHostCompatible`, which only enforces that a reused artifact's Node major equals
 * the host's — that equality check cannot catch a host whose Node is simply below what the
 * dependencies need, which is precisely what this floor reports cleanly.
 */
export function assertLaunchPrerequisites(
  options: LaunchPrerequisiteOptions = {}
): void {
  const version = options.nodeVersion ?? process.versions.node;
  const [major, minor] = version.split(".").map(Number);
  if (!nodeVersionIsSupported(major!, minor!))
    throw new Error(
      `Node.js ${supportedNodeRange()} is required (found ${version}); ` +
        `ntwine's database is Node's built-in node:sqlite, which older releases do not ship. ` +
        `Install a newer Node release and relaunch ntwine`
    );
  assertRequiredExecutables(options.command ?? commandIsAvailable);
}

/** Non-blocking provider capability snapshot for callers that can selectively expose backends. */
export function providerReadiness(
  command: CommandProbe = commandIsAvailable
): ProviderReadiness {
  return { claude: command("claude"), codex: command("codex") };
}
