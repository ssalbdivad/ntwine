import { createHash } from "node:crypto"
import { existsSync, realpathSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

// WHERE FRIZZ'S MACHINE-GLOBAL STATE LIVES.
//
// `~/.frizz` is not idiomatic anywhere: Linux has had the XDG base directories for a decade, Windows
// has LocalAppData, macOS has Application Support. But an existing install cannot be relocated — this
// tree reaches gigabytes (measured: 1.8 GB of promoted artifacts and 1.5 GB of browser profiles
// against 28 MB of actual thread state), agents hold live file descriptors into it, and the threads
// have no backup anywhere else. So: DETECT first, and only choose for a machine that has never run
// Frizz.
//
//   1. `~/.frizz` exists  -> use it for everything, unchanged, forever. Nobody migrates.
//   2. otherwise         -> the platform's idiomatic locations, XDG variables honored individually.
//
// A `~/.frizz` that is plainly a project BOARD — `threads/` and no data-root file — is not an install
// and does not count (isStrayBoard, below). Nor does one that never held a registry while the platform
// root already does (supersededByInstall, below): rule 1 exists to keep an install from moving, and
// honoring that directory is what would move one.
//
// The three roots exist because the content genuinely differs in kind, which is the whole point of
// the XDG split: `cache` is regenerable and safe to delete (artifacts, browser profiles, quota
// snapshots — the gigabytes), `data` is the threads and cannot be recovered, `state` is logs, locks
// and launch bookkeeping. On a legacy install all three collapse to `~/.frizz` and every historical
// path stays byte-identical.
//
// There is deliberately NO `runtime` root, and the reason is worth stating because XDG says there
// should be one.
//
// `$XDG_RUNTIME_DIR` (`/run/user/<uid>`, mode 0700, wiped at logout) is exactly right for locks and
// sockets. But it exists only on Linux, and only when a session manager set it. macOS has no
// equivalent, so a portable rule has to fall back to `$TMPDIR` — and that is where the platforms
// stop agreeing:
//
//   · macOS  `$TMPDIR` is `/var/folders/…/T`, PRIVATE to one user (drwx------).
//   · Linux  `$TMPDIR` is normally unset, so it means `/tmp`: world-writable, SHARED by every account.
//
// One rule, two security properties. Frizz's launch lock and port reservations are machine-global
// mutexes, and putting them in a shared `/tmp` breaks them in a way that does not self-heal, because
// of how staleness is decided: `pidIsAlive` (project-identity.ts) probes `process.kill(pid, 0)` and
// treats EPERM as ALIVE — correct within one account, where EPERM means "running, just not signalable
// by me". Across accounts EPERM is also what you get for someone else's process, so another user's
// abandoned lock reads as permanently held. Nobody can reclaim it, and every launch on that machine
// blocks on a PID it has no business waiting for. A 0700 `/tmp/frizz` from whoever got there first
// fails even earlier, with EACCES.
//
// So locks live in `state`, which is under the user's own home (or their `$XDG_STATE_HOME`) and is
// therefore per-user by construction — the one property the runtime dir was wanted for. The only
// thing given up is the OS wiping them at reboot, which Frizz does not need: it already ages locks out
// itself, by PID plus process-start generation.
//
// Sockets, the other thing a runtime root would serve, already solve this for themselves.
// `claude-broker-host.ts` hashes them into `$TMPDIR` as `frizz-claude-<16 hex of sha256(stateDir,
// sessionId)>.sock` — unique per state directory, so two accounts cannot collide even in a shared
// `/tmp`, and short, which is mandatory: a unix socket path cannot exceed ~104 bytes on macOS, and a
// nested XDG path plus a session UUID would blow straight through that.

export interface FrizzPaths {
  /** Threads, attachments, project identity. Losing this loses the product. */
  data: string
  /** Logs and launch bookkeeping — persistent, reconstructible, not precious. */
  state: string
  /** Promoted artifacts, staged plugins, browser profiles, quota snapshots. Safe to delete. */
  cache: string
  /** True when an existing `~/.frizz` was found and every root collapsed onto it. */
  legacy: boolean
}

export interface FrizzPathOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  home?: string
  /**
   * Injected so the whole resolution matrix is testable without touching a filesystem. Passing one —
   * even `existsSync` itself — also BYPASSES the per-process memo below, which is how a test that
   * reshapes a real temp home between two calls asks for a fresh answer each time.
   */
  exists?: (path: string) => boolean
}

export const LEGACY_DIR_NAME = ".frizz"

export function legacyFrizzRoot(home = homedir()): string {
  return join(home, LEGACY_DIR_NAME)
}

/**
 * What only a Frizz DATA ROOT holds. Any one of them makes `~/.frizz` the legacy root, whatever else is
 * in it: every launch writes the registry and a project state directory, so a real install has several.
 */
const DATA_ROOT_ENTRIES = ["projects", "registry.json", "config.json", "ui.db", "server.lock", "settings.json", "logs"]
/** What a PROJECT'S BOARD directory holds (`<project>/.frizz/`) — the same name, one level down. */
const BOARD_ENTRIES = ["threads", ".session-state", ".id", ".gitignore", ".agent-bindings.jsonl"]

/**
 * Is `~/.frizz` a project's BOARD rather than a data root — something wrote `threads/…` into it?
 *
 * The name is shared: a project's board is `<project>/.frizz/`, so the home folder's board would be
 * `~/.frizz` — and the bare existence of that directory is what selects the legacy layout below. A Frizz
 * worker runs with its cwd in the home folder when it belongs to the Home workspace (home-workspace.ts),
 * and while Frizz points that worker's scratch directory elsewhere, a worker or tool that still writes
 * the conventional `.frizz/threads/<id>/` relative to its cwd would otherwise switch an XDG install onto
 * an empty data root at the next boot: every project gone from the page, their data intact but unread.
 *
 * Conservative in the one direction that matters. A real legacy root always holds a data-root entry and
 * stays legacy. An EMPTY `~/.frizz` stays legacy too — the sandbox harnesses create one on purpose to pin
 * that layout. Only a directory holding board entries and NOTHING of a data root is passed over.
 */
function isStrayBoard(root: string, exists: (path: string) => boolean): boolean {
  if (DATA_ROOT_ENTRIES.some((name) => exists(join(root, name)))) return false
  return BOARD_ENTRIES.some((name) => exists(join(root, name)))
}

/**
 * Has the platform data root ALREADY become this machine's install, while `~/.frizz` never held a
 * registry?
 *
 * Every launch writes `registry.json`, so a real legacy install always has one — and so does an
 * established XDG / Application Support / LocalAppData install. When only the platform root has one,
 * `~/.frizz` is debris from something that wrote into it by name, and honoring it would move the
 * install onto an empty root. That happened on 2026-09-28: `scripts/verify-codex-errors.mjs` pointed
 * `FRIZZ_RUNTIMES_DIR` at `~/.frizz/runtimes`, a 200 MB provision created the directory, and the next
 * `npm run dev` came up on it — every project gone from the page and every thread listed as an
 * external terminal session, the real data untouched and unread under `~/.local/share/frizz`.
 *
 * Deliberately one-directional: it never overrides a `~/.frizz` that has a registry of its own, and
 * never matters on a fresh machine, where there is no platform registry to prefer.
 */
function supersededByInstall(root: string, platformData: string, exists: (path: string) => boolean): boolean {
  return !exists(join(root, "registry.json")) && exists(join(platformData, "registry.json"))
}

/**
 * A `~/.frizz` with no registry never outranks an XDG_DATA_HOME somebody SET.
 *
 * Setting XDG_DATA_HOME is how a harness isolates a throwaway Frizz, and its fresh temp root has no
 * registry yet — so supersededByInstall cannot fire, and the legacy rule used to hand the harness the
 * REAL `~/.frizz` instead. On 2026-10-02 a dev-board harness (verify-dev-remote.ts, since deleted)
 * booted a test board that way; `~/.frizz` existed only as agent scratch debris, the board wrote its
 * registry into it, and that registry made `~/.frizz` an install: the live board re-resolved its root
 * on the next lookup, saw one throwaway project, and answered 404 to every worker's `/_frizz/<project>/rpc/…` call.
 *
 * A real legacy install always has a registry (every launch writes one), so this only ever passes
 * over debris; a `~/.frizz` with a registry still wins whatever XDG says.
 */
function yieldsToExplicitData(root: string, explicitData: string | undefined, exists: (path: string) => boolean): boolean {
  return explicitData !== undefined && !exists(join(root, "registry.json"))
}

/** An XDG variable counts only when it is SET and ABSOLUTE; the spec says to ignore relative values. */
function xdg(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]
  return value && (value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value)) ? value : undefined
}

/**
 * Is `child` at or below `parent`? Windows-only question, compared with both separators and without
 * case, because the caller may be a POSIX host simulating win32 — where `path.join` normalizes
 * nothing and `C:\Users\x` and `c:/users/x` are the same directory to Windows itself.
 */
function insideHome(child: string, home: string): boolean {
  const norm = (value: string) => value.replace(/[\\/]+$/u, "").replaceAll("\\", "/").toLowerCase()
  const parent = norm(home)
  const inner = norm(child)
  return inner === parent || inner.startsWith(`${parent}/`)
}

function windowsRoots(env: NodeJS.ProcessEnv, home: string): Omit<FrizzPaths, "legacy"> {
  // Never Roaming: a multi-gigabyte artifact cache must not follow a user between machines, which is
  // exactly what %APPDATA% would do to it.
  //
  // %LOCALAPPDATA% DESCRIBES THE PROCESS'S OWN HOME, so it is authoritative only when it actually
  // sits under the home being resolved. Trusting it unconditionally made `frizzPaths({ home })` —
  // the one mechanism every sandbox has (`projectStateDir(id, home)`, `registryPath(home)`,
  // `machineConfigPath(home)`, `serverAddressPath(home)`) — collapse onto the live machine's single
  // `%LOCALAPPDATA%\Frizz` tree on win32, whatever home it was handed: a test run wrote the real
  // account's `settings.json` and registry (caught by the first Windows suite run, 2026-08-24). It is
  // the same leak that let a test retire `~/.frizz/server.lock` under a live server on 2026-08-08,
  // and darwin/xdg never had it because they derive every root from `home` already.
  //
  // The test is CONTAINMENT rather than "was home passed explicitly", because production reads these
  // paths both ways — `frizzRoots()` with no home and `registryPath(home = homedir())` with one — and
  // a rule that answered differently for the two would split one machine's state across two trees.
  // %USERPROFILE% is gone from the fallback for the same reason and costs nothing: `homedir()` already
  // returns it on win32, so `home` IS %USERPROFILE% unless a caller deliberately named another root.
  const local = env.LOCALAPPDATA && insideHome(env.LOCALAPPDATA, home)
    ? env.LOCALAPPDATA
    : join(home, "AppData", "Local")
  const base = join(local, "Frizz")
  return {
    data: join(base, "Data"),
    state: join(base, "State"),
    cache: join(base, "Cache"),
  }
}

function darwinRoots(home: string): Omit<FrizzPaths, "legacy"> {
  const support = join(home, "Library", "Application Support", "Frizz")
  return {
    data: support,
    // macOS has no state directory concept; Application Support is where this belongs, and the log
    // files themselves already live under each project's own directory.
    state: support,
    cache: join(home, "Library", "Caches", "Frizz"),
  }
}

function xdgRoots(env: NodeJS.ProcessEnv, home: string): Omit<FrizzPaths, "legacy"> {
  return {
    data: join(xdg(env, "XDG_DATA_HOME") ?? join(home, ".local", "share"), "frizz"),
    state: join(xdg(env, "XDG_STATE_HOME") ?? join(home, ".local", "state"), "frizz"),
    cache: join(xdg(env, "XDG_CACHE_HOME") ?? join(home, ".cache"), "frizz"),
  }
}

/**
 * Every DECISION this process has made — legacy `~/.frizz` or not — by the inputs it was made from.
 * Unbounded on purpose: a server sees one or two keys for its whole life (its own home, and the real
 * home a sandbox resolves runtimes under), and a test file one per temp home — a few hundred short
 * strings at worst.
 *
 * The decision is the only thing that reads the disk, so it is the only thing memoised: given it, the
 * three roots follow from home, platform and environment alone (`layout`, below). That is what lets the
 * key use the CANONICAL home while the answer keeps the caller's own spelling. Production asks under
 * both — `registryPath(homedir())` and `globalLaunchLockPath`'s `canonicalHome(home)` — and a key on the
 * raw string gave a symlinked or trailing-slash home two independent decisions, the second made fresh
 * whenever it was first asked, so after a stray write (review of 2026-10-02, reproduced in a scratch
 * home: `<link>/.local/share/frizz` for one spelling, `<real>/.frizz` for the other).
 */
const decisions = new Map<string, boolean>()
/** Raw home spelling -> its realpath, so the key costs one realpath per spelling rather than per call. */
const canonicalHomes = new Map<string, string>()

function canonicalHome(home: string): string {
  let canonical = canonicalHomes.get(home)
  if (canonical === undefined) {
    try {
      canonical = realpathSync(home)
    } catch {
      canonical = resolve(home)
    }
    canonicalHomes.set(home, canonical)
  }
  return canonical
}

/**
 * The key is EXACTLY the decision's inputs: which home, on which platform, and where that platform puts
 * the data root (an explicit XDG_DATA_HOME anywhere; %LOCALAPPDATA% on win32). XDG_STATE_HOME and
 * XDG_CACHE_HOME are deliberately absent — they move only their own roots, which `layout` reads from
 * the caller's env on every call, and never the decision. Keying on them would only give the same home
 * a second, independently-timed decision whenever a caller passed a different cache root, which is the
 * mid-run flip again by another door. Values go in normalised the way resolution reads them (`xdg`
 * drops a relative value), so two spellings of "unset" share one decision.
 */
function memoKey(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string {
  return JSON.stringify([
    platform,
    canonicalHome(home),
    xdg(env, "XDG_DATA_HOME") ?? null,
    platform === "win32" ? env.LOCALAPPDATA ?? null : null,
  ])
}

/**
 * THE PIN: a decision a supervising process hands every child it forks, so the roots survive a
 * restart of the SERVER and change only with a restart of the whole process tree.
 *
 * Memoising inside one process was not enough on its own (review of 2026-10-02, reproduced against a
 * real `nub src/dev.ts`): the dev supervisor — which is what the maintainer's live board is, and what
 * the production launcher runs too (src/production.ts `startDevSupervisor`) — forks a FRESH server
 * child on every source edit, every crash and every Update & Restart. That child resolved again at its
 * own boot, so once a stray `~/.frizz/registry.json` existed, the next landed commit restarted the
 * board onto it: 404 on 10/10 board reads after a child restart, against 200 on 10/10 without the stray
 * file. With agents landing on `main` continuously, "next restart" is minutes.
 *
 * So the supervisor puts its own decision into the environment it hands the child and the re-exec of
 * itself (dev-supervisor.ts), and a process honors it in place of reading the disk — but ONLY for the
 * exact key it was made for. A harness that isolates itself by changing HOME or an XDG root is a
 * different key and resolves on its own; a mismatched or malformed pin is ignored, never trusted, so
 * the failure mode of a wrong pin is the old behavior rather than a wrong root.
 */
export const ROOTS_PIN_ENV = "FRIZZ_ROOTS_PIN"

interface RootsPin {
  key: string
  legacy: boolean
}

function pinnedDecision(env: NodeJS.ProcessEnv, key: string): boolean | undefined {
  const raw = env[ROOTS_PIN_ENV]
  if (!raw) return undefined
  try {
    const pin = JSON.parse(raw) as Partial<RootsPin>
    return pin.key === key && typeof pin.legacy === "boolean" ? pin.legacy : undefined
  } catch {
    return undefined
  }
}

/** The home `homedir()` would report in a process started with `env`. */
function homeIn(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  return (platform === "win32" ? env.USERPROFILE : env.HOME) || homedir()
}

/**
 * `env` plus this process's decision for the home and roots a child started with `env` will resolve.
 * The decision is this process's own memoised one (made, or itself inherited, at its boot), so every
 * generation of child sees the same roots however the disk has changed since.
 */
export function withRootsPin(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const platform = process.platform
  const home = homeIn(env, platform)
  const { legacy } = frizzPaths({ env, platform, home })
  const pin: RootsPin = { key: memoKey(env, platform, home), legacy }
  return { ...env, [ROOTS_PIN_ENV]: JSON.stringify(pin) }
}

/**
 * Resolve Frizz's global roots — ONCE per process for any given home and environment.
 *
 * An explicitly SET XDG variable wins on every platform, including macOS and Windows — a developer
 * who has configured XDG has asked for it and should get it. Everything else follows the platform.
 *
 * WHY THE ANSWER IS MEMOISED, and why that is a correctness rule rather than a speed-up. Resolution
 * reads the FILESYSTEM (does `~/.frizz` exist, does it hold a registry, does the platform root), and
 * production asks for these paths on every registry lookup — `registryPath(home = homedir())` lands
 * here per call, and the server's tenant router reads the registry on every `/_frizz/<project>/…`
 * request. Re-resolving each time meant a running server's data root was whatever the disk said at
 * that instant. On 2026-10-02 a test harness wrote a `registry.json` into a debris `~/.frizz`; the
 * live server's very next lookup took that file for a legacy install, moved its data root onto it,
 * found none of its own projects there, and answered 404 to every worker's `/_frizz/<project>/rpc/…`
 * call. ad124bae stopped the harness choosing that directory; this stops ANY later write from moving a
 * process that has already chosen, and the pin above carries the choice across a server restart. A
 * Frizz moves between roots only when its whole process tree restarts, which is also the only point at
 * which every daemon, descriptor and env var it handed out is re-derived together.
 *
 * The memo is KEYED on every input the decision depends on (memoKey) — never a single process-wide
 * slot, because a process legitimately resolves more than one home: `prepareSandbox` (src/launcher.ts) swaps $HOME before first use and still resolves
 * the operator's real cache under the real home; tests resolve a fresh temp home per case. Each of
 * those is its own key and gets its own answer, frozen from the first time that key was asked.
 *
 * Caching "no install yet" cannot strand a fresh machine's first launch. With no `~/.frizz`, the
 * answer is the platform roots whether or not they exist yet (their existence is only ever consulted
 * to OVERRULE a `~/.frizz`, in supersededByInstall), so the memo holds exactly the directories the
 * launch is about to create. The only thing a later disk change could do is make `~/.frizz` appear —
 * the debris case this exists to ignore — and the next process, seeing the registry this one wrote
 * under the platform root, resolves the same platform root (supersededByInstall again). That reasoning
 * holds for a process that WRITES the install. A process that only LOOKS for a server — the VS Code
 * extension host — has no install of its own to stay consistent with,
 * and a frozen answer strands it when the server it is looking for chose differently (a reader that
 * resolved on a fresh machine before debris and the first server appeared found nothing, where the
 * unmemoised code found the server). Those use `frizzPathsNow`.
 *
 * An injected `exists` bypasses the memo: it is a test asking about a hypothetical filesystem, and
 * an answer about one imaginary disk must never be served for a real one, or vice versa.
 */
export function frizzPaths(options: FrizzPathOptions = {}): FrizzPaths {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  if (options.exists) return resolveFrizzPaths(env, platform, home, options.exists)
  const key = memoKey(env, platform, home)
  let legacy = decisions.get(key)
  if (legacy === undefined) {
    legacy = pinnedDecision(env, key) ?? resolveFrizzPaths(env, platform, home, existsSync).legacy
    decisions.set(key, legacy)
  }
  return Object.freeze(layout(env, platform, home, legacy))
}

/**
 * What a process starting NOW would resolve: the disk as it is at this instant, no memo, no pin.
 *
 * For processes that only DISCOVER a server and own no Frizz data — the VS Code extension host. It
 * lives for days, and the server they look for can restart onto other
 * roots (a deliberate move, or a first launch on a fresh machine that picked `~/.frizz`), so each
 * lookup follows the rule a freshly started server follows. Never use it for anything that WRITES
 * Frizz state: that is exactly the mid-run flip `frizzPaths` exists to prevent.
 */
export function frizzPathsNow(options: Omit<FrizzPathOptions, "exists"> = {}): FrizzPaths {
  return frizzPaths({ ...options, exists: existsSync })
}

/** The roots a decision implies — pure, no filesystem. */
function layout(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string, legacy: boolean): FrizzPaths {
  if (legacy) {
    const root = legacyFrizzRoot(home)
    return { data: root, state: root, cache: root, legacy: true }
  }
  const platformRoots = platform === "win32"
    ? windowsRoots(env, home)
    : platform === "darwin"
      ? darwinRoots(home)
      : xdgRoots(env, home)
  const explicit = {
    data: xdg(env, "XDG_DATA_HOME"),
    state: xdg(env, "XDG_STATE_HOME"),
    cache: xdg(env, "XDG_CACHE_HOME"),
  }
  return {
    data: explicit.data ? join(explicit.data, "frizz") : platformRoots.data,
    state: explicit.state ? join(explicit.state, "frizz") : platformRoots.state,
    cache: explicit.cache ? join(explicit.cache, "frizz") : platformRoots.cache,
    legacy: false,
  }
}

function resolveFrizzPaths(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
  exists: (path: string) => boolean,
): FrizzPaths {
  const resolved = layout(env, platform, home, false)
  const legacyRoot = legacyFrizzRoot(home)
  if (
    exists(legacyRoot) &&
    !isStrayBoard(legacyRoot, exists) &&
    !supersededByInstall(legacyRoot, resolved.data, exists) &&
    !yieldsToExplicitData(legacyRoot, xdg(env, "XDG_DATA_HOME"), exists)
  ) {
    return layout(env, platform, home, true)
  }
  return resolved
}

/**
 * The roots for this process's own home and environment.
 *
 * Once a single process-wide slot that kept the FIRST answer whatever $HOME said later, while
 * `frizzPaths({ home })` beside it re-resolved on every call — so a process could hold two different
 * opinions of its data root at once. Both now go through the one keyed memo above: stable for a given
 * home, and a home swapped in before first use (`prepareSandbox`) is simply a different key.
 */
export function frizzRoots(): FrizzPaths {
  return frizzPaths()
}

/**
 * Test-only: forget every memoised answer, so a case that RESHAPES a home it already resolved (creates
 * `~/.frizz`, writes a registry) can watch a fresh resolution — what a restarted process would see.
 */
export function resetFrizzRoots(): void {
  decisions.clear()
  canonicalHomes.clear()
}

/**
 * A temp directory no other install or OS user can collide inside.
 *
 * `$TMPDIR` is per-user on macOS (`/var/folders/…`, drwx------) but on Linux it is normally unset,
 * so it means a world-shared `/tmp`. A bare `/tmp/frizz-<name>` is therefore shared between two OS
 * accounts AND between two installs of one account: the first creator sets the mode, and the second
 * writer gets EACCES or silently prunes the first one's files.
 *
 * Keying the DIRECTORY on a path that lives under $HOME is the fix already used for the broker
 * sockets (claude-broker-host.ts). Pass a state dir for per-PROJECT isolation, or leave the default
 * for per-install — which is enough wherever the filenames are already content- or id-addressed and
 * only a sweep is destructive.
 */
export function frizzTempDir(name: string, key?: string): string {
  const digest = createHash("sha256").update(key ?? frizzRoots().data).digest("hex").slice(0, 16)
  return join(tmpdir(), `${name}-${digest}`)
}

/** `<data>/projects/<id>` — a project's own directory, and the value of `stateDir` everywhere. */
export function projectStateDir(projectId: string, home?: string): string {
  return join(home ? frizzPaths({ home }).data : frizzRoots().data, "projects", projectId)
}

/**
 * `<data>/host` — the folder the server is launched on when the command is typed outside a project.
 *
 * A server serves a board, so it needs a project to start with, and a launch from a folder that is
 * not one has none. The launcher stands this folder in (launcher.ts hostWorkspace). It is a project in every way but one: it is never in
 * the registry, so the dashboard does not list it.
 */
export function launchHostDir(home?: string): string {
  return join(home ? frizzPaths({ home }).data : frizzRoots().data, "host")
}

/**
 * True for a file under `<data>/projects/<id>/attachments/` — something the human dropped onto a
 * prompt. The composer already shows those inline in the human's own bubble, so a worker's `Read` (or
 * Codex `view_image`) of one is the one image read whose picture the transcript should NOT repeat
 * (maintainer 2026-08-27: "If this is something the user just attached, then we obviously don't need
 * to re-render it redundantly"). Any other image the worker reads — a screenshot it took, a file it
 * found on disk — still renders as its card. `home` is for tests; production resolves the memoized
 * roots.
 */
export function isPromptAttachmentPath(path: string, home?: string): boolean {
  const data = home ? frizzPaths({ home }).data : frizzRoots().data
  const rel = relative(join(data, "projects"), resolve(path))
  if (!rel || isAbsolute(rel)) return false
  const parts = rel.split(sep)
  return parts.length >= 3 && parts[0] !== ".." && parts[1] === "attachments"
}

/**
 * `<data>/server.lock` — WHERE THE MACHINE'S FRIZZ IS, at one fixed path.
 *
 * One frizz per machine, so its address belongs somewhere that does not depend on which project
 * happened to launch it. The per-project lock is a record of a LAUNCH (pid, owner tokens, the lease);
 * this is a record of an ADDRESS, and the difference matters to anything long-lived that has to find
 * the server again later.
 *
 * A worker's frizz MCP server is exactly that: a detached daemon outlives restart after restart, and
 * an address it was handed once at spawn is frozen while the port behind it is not. Reading THIS file
 * per call is what lets a live worker survive an "Update & Restart" instead of needing one of its own.
 * `<data>` is the same root `projectStateDir` uses, so it is always `../..` from any state dir — which
 * is how the dependency-free shim finds it without knowing this module's platform rules.
 */
export function serverAddressPath(home?: string): string {
  return join(home ? frizzPaths({ home }).data : frizzRoots().data, "server.lock")
}

/**
 * The machine address for the frizz root a given project state dir lives under — `../..` from it.
 *
 * ALWAYS PREFER THIS over the `homedir()` default above. The default reads real machine state, and a
 * server booted inside a test or a sandbox stack would publish (and then, on its clean exit, RETIRE)
 * the address of the maintainer's actual running frizz. That is not hypothetical: it happened on
 * 2026-08-08, when a `startup-transaction.test.ts` run silently deleted `~/.frizz/server.lock` out
 * from under a live server on port 50020, and it looked exactly like a rogue second instance.
 *
 * Deriving it from the state dir instead makes the path follow whatever sandbox the caller is already
 * in, with no new option to thread and nothing to remember. It is also the SAME derivation the worker
 * shim uses (`dirname(dirname(FRIZZ_STATE_DIR))`, cc-worker/bin/frizz-mcp.mjs), so the two cannot
 * disagree about where the address lives.
 */
export function serverAddressPathForStateDir(stateDir: string): string {
  return join(dirname(dirname(stateDir)), "server.lock")
}
