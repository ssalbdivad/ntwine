#!/usr/bin/env node
import { bindHostIsExposed } from "@frizz/server/local-origin";
// The registry launcher is intentionally separate from index.ts. `frizz-dev` follows mutable
// checkout source; `frizz` runs the package that npm resolved and never turns an npx cache into a
// deployment directory.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { launchApp, launchBrowserTab } from "./browser.ts";
import { fileSessionDirectory, loadOrCreateSessionKey } from "@frizz/server/access-codes";
import { renderQrLines } from "@frizz/server/qr";
import { listSessions, signOutSession } from "./sessions-cli.ts";
import { SUPERVISOR_ACCESS_CODE_PATH } from "@frizz/server/restart-supervisor";
import { createAccessPane, type AccessPane } from "./access-pane.ts";
import { installPaneHost, type PaneHost } from "./pane-host.ts";
import { createRemoteController, type RemoteController } from "./remote-controller.ts";
import { probeCloudflared, probeGithub, probeTailscale } from "./remote-detect.ts";
import { createRemotePane } from "./remote-pane.ts";
import { LOOPBACK_BIND_HOST } from "@frizz/server/local-origin";
import {
  establishCloudConfig,
} from "./cloud.ts";
import { noticeOnlyReadout, Readout, renderSupervisorActivity, tildePath } from "./readout.ts";
import {
  appendCrashRecord,
  attachTerminalMirror,
  createLogger,
  logEnvironment,
  runLogPath,
  setAmbientLogger,
  type Logger,
} from "@frizz/server/logging";
import {
  acquireGlobalLaunchLock,
  allocatePort,
  boardAddress,
  expectedOwnerHealth,
  liveWorkspaceOwner,
  cleanupSandbox,
  parseCliArgs,
  prepareSandbox,
  probeFrizz,
  readPreferredPort,
  resolveLaunchIntent,
  resolveLaunchControlTarget,
  runningFrizzStatus,
  stopProjectLaunch,
  waitForWorkspace,
  workspaceFromLaunchTarget,
  workspaceLaunchTarget,
  type CliOptions,
  type LaunchIntent,
  type Workspace,
} from "./launcher.ts";
import {
  adoptProjectLaunchOwner,
  projectLaunchEnvironment,
  projectLaunchOwnerTokenFromEnvironment,
  projectLaunchTargetFromEnvironment,
  readProjectLaunchOwner,
  tryAcquireProjectLaunchOwner,
} from "@frizz/server/project-launch";
import { createSupervisorShutdownHandler, startDevSupervisor } from "@frizz/server/dev-supervisor";
import { planRegistryUpdate, PRODUCTION_PRINT_LAUNCHER_FLAG, PRODUCTION_REEXEC_FLAG, reexecArgv } from "./production-update.ts";
import { npmServerPackageInstaller, serverGenerationLaunch, serverReleaseSpec, ServerReleaseStore, type ServerGeneration } from "./server-release.ts";
import { acquireStableServerOwner, publishStableServerAddress, releaseStableServerOwner, type ServerOwnerLease } from "./server-owner.ts";
import { GLOBAL_INSTALL_ENV, isGlobalInstall, keepUpdateHint } from "./production-update.ts";
import {
  assertLaunchPrerequisites,
  assertRequiredExecutables,
} from "./preflight.ts";
import { DEFAULT_PORT, fallbackPort } from "@frizz/shared";
import { registerProject } from "@frizz/server/project-registry";
import { resolveProjectLabel } from "@frizz/server/project-identity";

const PACKAGE_NAME = process.env.FRIZZ_REGISTRY_PACKAGE ?? "frizz";

/**
 * The version THIS bundle actually is, read from the package.json it ships inside.
 *
 * It used to be `process.env.npm_package_version ?? "0.0.1"`, and npm sets that variable only for
 * lifecycle scripts — NOT when a bin runs through the npx shim, which is how every real user starts
 * Frizz. So the launcher reported itself as `0.0.1` forever. Measured end-to-end against the published
 * package: a genuine 0.1.1 install served `artifactDigest: "npm:frizz@0.0.1"`, and still served
 * `0.0.1` after updating itself to 0.1.2.
 *
 * This is now the stable launcher's diagnostic version, not the separately selected server version
 * used for update comparisons. Read the manifest beside this bundle, never npm's invocation env.
 */
function resolvePackageVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { version?: unknown };
    if (typeof manifest.version === "string" && manifest.version.trim()) return manifest.version.trim();
  } catch {
    // Fall through — a launcher that cannot read its own manifest must still boot.
  }
  return process.env.npm_package_version ?? "0.0.1";
}

const PACKAGE_VERSION = resolvePackageVersion();
const rawArgs = process.argv.slice(2);
const reexec = rawArgs.includes(PRODUCTION_REEXEC_FLAG);
// Answered before anything else is touched: an OLDER launcher runs this through `npm exec` to learn
// where npm installed this release, then execve's into it. Nothing here may need a project, a lock,
// a Node floor or a terminal — the whole exchange is one path on stdout.
if (rawArgs.includes(PRODUCTION_PRINT_LAUNCHER_FLAG)) {
  console.log(fileURLToPath(import.meta.url));
  process.exit(0);
}
// A re-exec'd launch was started by the PREVIOUS release, whose argv may carry a project directory this
// release refuses (0.7.0–0.12.10 all append one); see reexecArgv. A human's argv is parsed as written.
const args = reexec ? reexecArgv(rawArgs) : rawArgs;
const fail = (error: unknown): never => {
  console.error(`frizz: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
};

const options: CliOptions = (() => {
  try { return parseCliArgs(args); } catch (error) { return fail(error); }
})();
if (options.help) {
  console.log(
    `Frizz production launcher

Usage: npx ${PACKAGE_NAME} [options]

Run it in the directory you want to work in. One server serves EVERY project on this machine,
each at its own /project/<name> URL, so a second run joins the one already going. Runs the
npm-resolved immutable Frizz package, then opens it in your default browser. Use frizz-dev only
for a source checkout.

Options:
  --no-app               print the URL without opening a browser
  --port <port>          request a fixed port for a new workspace server
  --sandbox              a disposable Frizz to try things in: throwaway home and project, its
                         own port, deleted when this terminal closes; credentials (gh,
                         cloudflared, Claude, Codex, the machine's frizz.sh key) are shared
  --link                 print a fresh single-use access link for the running board
  --sessions             list the devices signed in to the running board
  --sign-out <id|all>    sign one device out, or every one of them
  --status               report the board running for this project: address, pid, version
  --stop                 stop the board running for this project (running agents keep going)
  --debug                stream the full event feed to the terminal instead of the compact readout
  -h, --help             show this help


To reach the board from a phone or another machine, press R in the terminal running it: a short
walkthrough sets up a private frizz.sh name (no account needed), a custom one, a Cloudflare
Tunnel, Tailscale, or a proxy of your own, and
remembers the choice, so a plain launch serves it from then on. The board stays on loopback and
shows a single-use sign-in link as a QR; press L for a fresh one, or run --link from another shell.`,
  );
  process.exit(0);
}
if (options.dev || rawArgs.includes("--prod")) fail("--dev and --prod are not available from the registry launcher");

// Before ANYTHING reads the home directory: the sandbox swaps $HOME for a throwaway, so every piece
// of state after this line — registry, lock, logs, session key, cloud.json — is a disposable copy.
const sandbox = options.sandbox ? prepareSandbox() : null;
if (sandbox) process.on("exit", () => cleanupSandbox(sandbox.home));

/** How this board is reached from outside — the saved setup, the transport, the origin. Built once the supervisor listens. */
let remote: RemoteController | null = null;
/** The keyboard: L for a link, R for the remote-access walkthrough. Held so shutdown can restore the shell. */
let paneHost: PaneHost | null = null;
/**
 * A global bin (`npm i -g frizz`) is the one launch shape a self-update does not outlive: the release
 * lands in npm's execution cache and the bin on disk keeps pointing at this version. Decided here,
 * from THIS bundle's path, and handed down through the environment — the successor's own path is
 * always the cache and could never tell.
 */
const globalInstall = process.env[GLOBAL_INSTALL_ENV] === "1" || isGlobalInstall(import.meta.dirname);
let accessPane: AccessPane | null = null;
/** The single-use link this launch minted, read by the readout below. */
let activeAccessLink: { url: string } | null = null;
let serverOwner: ServerOwnerLease | undefined;
// Cold-install errors and signals also release the lease. Live registered control-plane delegates
// retain its draining fence until their exact process generations are gone.
process.on("exit", () => { if (serverOwner) releaseStableServerOwner(serverOwner); });

let launchIntent: LaunchIntent | undefined;
const workspace: Workspace = (() => {
  try {
  // BEFORE workspace preparation, so a machine running a Node the server's database cannot survive
  // learns it here by name instead of from whichever internal step tripped over it first. On an
  // unsupported release SQLite does not misbehave, it SEGFAULTS, and a segfault mid-boot is
  // indistinguishable from Frizz being broken. The required executables list beside it is empty:
  // repository discovery can fall back to project markers when Git is absent (see preflight.ts).
  //
  // `--stop` and `--status` skip the Node floor deliberately: they only read a status file and signal
  // a process, both of which work on any runtime, and they are how someone shuts down a board after
  // switching to a Node that cannot run one.
  if (!reexec) {
    if (options.stop || options.status) assertRequiredExecutables();
    else assertLaunchPrerequisites();
  }
  const pinned = projectLaunchTargetFromEnvironment(process.env);
  if (reexec || process.env.FRIZZ_PRODUCTION_SUPERVISOR === "1") {
    if (!pinned) throw new Error("registry successor is missing its pinned project identity");
    return workspaceFromLaunchTarget(pinned);
  }
  // ONE launch policy for both launchers. This called resolveWorkspace directly, which adopts
  // whatever directory it is handed — so `frizz` in $HOME minted a project id inside Frizz's own
  // `~/.frizz` state root, the failure frizz-dev was fixed for in 95d81bd and this file was not.
  // A repository still opens as itself and is still adopted on sight; see resolveLaunchIntent.
  const intent = resolveLaunchIntent();
  if (intent.kind === "empty")
    throw new Error(
      intent.reason === "home"
        ? "frizz cannot open your home directory as a project, and there is no other project to show yet. cd into a repository and run frizz there."
        : `${intent.directory} is not a Frizz project yet, and there is no other project to show. Run frizz inside a repository, or add this one from the projects page once a board is open.`,
    );
  launchIntent = intent;
  return intent.workspace;
  } catch (error) { return fail(error); }
})();
process.chdir(workspace.root);
if (options.stop) {
  // The farewell after a detached update has said "stop it with frizz --stop" since 0.12.10, and
  // `--help` never listed it, because nothing here handled it: the flag fell through to the join
  // path below and OPENED A BROWSER TAB on the board it was asked to stop (audit 2026-09-11,
  // finding 2). The protocol is the dev launcher's (src/index.ts stopWorkspace): token-bound HTTP
  // stop, then reap only a provably stale owner — never a signal to a pid that might be recycled.
  try {
    // One server, every project: the record may belong to the project the board was launched from.
    const control = await resolveLaunchControlTarget({ stateDir: workspace.stateDir, target: workspaceLaunchTarget(workspace) });
    const where = control.host ? workspace.root : `${workspace.root} (the board was launched from ${control.target.projectDir})`;
    const result = await stopProjectLaunch({ stateDir: control.stateDir, target: control.target });
    console.log(
      result.kind !== "stopped"
        ? `Frizz is not running for ${where}`
        : result.stale
          // A board that died without releasing its record (a kill, a crash) reads as "running" to
          // every later launch until someone reaps it; say what happened rather than claiming a stop.
          ? `Frizz was not running for ${where}; cleared the record a dead board left behind`
          : `stopped Frizz for ${where}; running agents keep going — they are detached daemons`,
    );
    process.exit(0);
  } catch (error) { fail(error); }
}
if (options.status) {
  const control = await resolveLaunchControlTarget({ stateDir: workspace.stateDir, target: workspaceLaunchTarget(workspace) });
  const running = await runningFrizzStatus({ stateDir: control.stateDir, target: control.target });
  if (!running) {
    console.log(`Frizz is not running for ${workspace.root}`);
    process.exit(1);
  }
  console.log(`running: http://127.0.0.1:${running.port}`);
  console.log(`workspace: ${workspace.root}`);
  if (!control.host) console.log(`launched from: ${control.target.projectDir} (one server serves every project)`);
  console.log(`supervisor pid: ${running.pid}`);
  console.log(`version: ${running.version ?? "unknown"}`);
  if (running.state && running.state !== "ready") console.log(`state: ${running.state}${running.message ? ` — ${running.message}` : ""}`);
  process.exit(0);
}
if (options.sessions || options.signOut !== undefined) {
  // Reads and writes the RUNNING board's session directory, so there is nothing useful to say when
  // no board is up — starting one here would create an empty directory and answer a different question.
  const running = liveWorkspaceOwner(workspace.stateDir, workspaceLaunchTarget(workspace));
  if (!running?.port) {
    console.error("frizz: no board is running for this workspace");
    process.exit(1);
  }
  if (options.signOut !== undefined) await signOutSession(running.port, options.signOut);
  await listSessions(running.port);
}
if (options.link) {
  // Mint from the RUNNING board rather than starting one — the same query frizz-dev answers
  // (src/index.ts): the answer for a board running detached or in someone else's terminal, where
  // the interactive QR pane cannot install.
  const running = liveWorkspaceOwner(workspace.stateDir, workspaceLaunchTarget(workspace));
  if (!running?.port) {
    console.error("frizz: no board is running for this workspace");
    process.exit(1);
  }
  const response = await fetch(`http://127.0.0.1:${running.port}${SUPERVISOR_ACCESS_CODE_PATH}`, {
    method: "POST",
    headers: { origin: `http://127.0.0.1:${running.port}` },
  }).catch(() => undefined);
  if (!response?.ok) {
    const detail = response ? (await response.json().catch(() => undefined))?.error : undefined;
    console.error(`frizz: ${detail ?? "could not mint an access link"}`);
    process.exit(1);
  }
  const { url } = (await response.json()) as { url: string };
  // The QR first: the whole point of a link is to reach a phone, and nobody types forty characters.
  if (process.stdout.isTTY) for (const row of renderQrLines(url)) console.log(`  ${row}`);
  console.log(process.stdout.isTTY ? `\n  ${url}` : url);
  process.exit(0);
}
// Every launch leaves a complete record on disk, so a crash is never silent. The forked control-plane
// child appends to this same file rather than writing to the terminal the readout is repainting.
const logger: Logger = setAmbientLogger(
  process.env.FRIZZ_LOG_FILE
    ? createLogger({ file: process.env.FRIZZ_LOG_FILE, owner: false })
    : createLogger({ file: runLogPath(workspace.stateDir) }),
);
const readout = reexec || process.env.FRIZZ_PRODUCTION_SUPERVISOR === "1"
  ? undefined
  : new Readout({ debug: options.debug });
/**
 * Where supervisor lifecycle beats print. Normally the boot readout — but a launcher that execve'd
 * itself into this release through Update Frizz has no boot to narrate and still owns the operator's
 * terminal, so it gets a notice-only one rather than falling silent for the rest of the session. The
 * detached fallback successor has no terminal at all (stdio ignored) and stays quiet, as before.
 */
const activityReadout =
  readout ?? (reexec && process.stdout.isTTY ? noticeOnlyReadout({}) : undefined);
attachTerminalMirror(logger, options.debug || process.env.FRIZZ_DEBUG === "1");
readout?.plan([
  { key: "server", label: "Server" },
  { key: "browser", label: options.noApp ? "Address" : "Browser" },
]);
readout?.begin("server", "starting");
logger.info("launcher", `Frizz launcher ${PACKAGE_VERSION} starting for ${workspace.root}`);
const target = workspaceLaunchTarget(workspace);
const expected = expectedOwnerHealth(target, readProjectLaunchOwner(workspace.stateDir));

async function existingPort(): Promise<number | undefined> {
  const owner = liveWorkspaceOwner(workspace.stateDir, target);
  const ports = [owner?.port, readPreferredPort(workspace.stateDir)].filter((value): value is number => !!value);
  for (const port of new Set(ports)) if (await probeFrizz(port, expected)) return port;
  return undefined;
}

/**
 * A Frizz already running on this machine, serving THIS project under its own slug.
 *
 * The singleton's payoff at the CLI: a second `frizz` in another repository is a client, not a
 * server. It registers the project (which is what mints the slug), then asks the machine's Frizz for
 * that project's health — a request which, by activating the tenant, is also what opens it.
 *
 * The identity check is the launcher's own handshake minus the owner proof. That proof is keyed to a
 * launch LEASE and a client holds none; what a client needs to know is that this port serves ITS
 * project id from ITS directory, and that is exactly what the id and dir already answer. The proof
 * still guards the case it was written for — a launcher adopting the supervisor it believes it owns.
 *
 * A COPIED checkout (`cp -R`, so two directories claim one id) is deliberately not joined here: the
 * registry refuses the duplicate, and the re-mint belongs to resolveProject, which does it properly.
 */
/**
 * This project's URL segment, registering it if the machine has not seen it before.
 *
 * `/` is the project GRID now, so a board — including the one we are about to launch — lives at
 * `/<slug>`. Both the join path and the launch path want the same answer, and registration is
 * idempotent: an id already in the registry keeps the slug it was given.
 */
function ownSlug(): string | undefined {
  try {
    return registerProject(
      { dir: workspace.root, id: target.projectId, remoteOwner: resolveProjectLabel(workspace.root)?.split("/")[0] },
      homedir(),
    ).entry?.slug;
  } catch {
    // The registry is an INDEX. If it cannot be written, opening the board unprefixed still works.
    return undefined;
  }
}

let cachedSlugPath: string | undefined;
/**
 * Where to land: the cross-project page focused on this project (the default mode — its prompt box
 * dispatches here, and every other project's queue is beside it), the cross-project page with no
 * particular project, or the add-project dialog asking about a directory (`/?add=` opens it on `/`).
 *
 * `/?focus=<slug>` rather than the page's own `/all/<slug>`: this launcher may be JOINING an older
 * server, whose page has no `/all` route and would draw the launching project's board there. An older
 * page ignores the query and shows its own `/`.
 *
 * `?add=` is a REQUEST, not a registration — nothing on disk changes until the operator confirms on
 * the page, which is the only reason an unmarked directory is safe to point the launcher at at all.
 */
function slugPath(): string {
  if (cachedSlugPath === undefined) {
    if (launchIntent?.kind === "everything") cachedSlugPath = "/";
    else if (launchIntent?.kind === "offer") cachedSlugPath = `/?add=${encodeURIComponent(launchIntent.directory)}`;
    else {
      const slug = ownSlug();
      cachedSlugPath = slug ? `/?focus=${encodeURIComponent(slug)}` : "";
    }
  }
  return cachedSlugPath;
}

async function joinRunningFrizz(): Promise<{ port: number; slug: string } | undefined> {
  const slug = ownSlug();
  if (!slug) return undefined;
  // Compatibility with pre-split launchers, which did not publish the global owner/address record.
  // New launchers join that record before probing application health, even during child recovery.
  for (const port of new Set([DEFAULT_PORT, fallbackPort(DEFAULT_PORT)])) {
    if (await probeFrizz(port, { projectId: target.projectId, projectDir: target.projectDir, slug }))
      return { port, slug };
  }
  return undefined;
}

/**
 * Hand the operator the running board. This is deliberately the SAME contract as the source
 * launcher's openOrPrint (index.ts): a plain launch opens the default browser, `--app` opens the
 * dedicated app window, `--no-app` prints the URL and nothing else, and a browser that refuses to
 * open degrades to the URL instead of failing the launch.
 *
 * It printed the URL and stopped there from the day this file was written, so `npx frizz` never
 * opened anything while `frizz-dev` always did — the whole divergence the operator hit.
 */
async function openOrPrint(port: number, reused: boolean, path = ""): Promise<void> {
  const url = `http://127.0.0.1:${port}${path}`;
  logger.info("launcher", `${reused ? "reusing" : "started"} Frizz at ${url}`);
  readout?.settle("server", "done", reused ? `already running on port ${port}` : `port ${port}`);
  let browser: string | undefined;
  if (!options.noApp) {
    readout?.begin("browser", options.appMode ? "requesting app window" : "requesting default browser");
    try {
      if (options.appMode) {
        await launchApp(url, { dataPath: join(workspace.stateDir, "browser-profile") });
        browser = reused ? "focused the Frizz app window" : "opened the Frizz app window";
      } else {
        await launchBrowserTab(url);
        browser = "opened in your default browser";
      }
      logger.info("launcher", browser);
    } catch (error) {
      browser = `could not open the ${options.appMode ? "app window" : "default browser"} — open the address above`;
      logger.warn("launcher", `${browser}: ${error instanceof Error ? error.message : error}`);
    }
    readout?.settle("browser", "done", browser);
  } else {
    readout?.settle("browser", "done", url);
  }
  // A reuse did not choose this server's bind address or its proxy origin, so it must not claim either.
  const publicOrigin = reused ? undefined : remote?.origin();
  const warnings: string[] = [];
  if (sandbox) warnings.push(`Sandbox: everything here is throwaway (${sandbox.home}) and is deleted when this terminal closes.`);
  if (!readout) {
    console.log(`${reused ? "reusing" : "started"} Frizz for ${workspace.root}`);
    console.log(url);
    if (publicOrigin) console.log(activeAccessLink?.url ?? `${publicOrigin}/`);
    for (const warning of warnings) console.log(warning);
    return;
  }
  const home = homedir();
  readout.ready(
    [
      { label: "Local", value: boardAddress(url), accent: true },
      ...(publicOrigin ? [{ label: "Public", value: activeAccessLink?.url ?? `${publicOrigin}/`, accent: true }] : []),
      { label: "Project", value: `${workspace.name} — ${tildePath(workspace.root, home)}` },
      ...(logger.file ? [{ label: "Logs", value: tildePath(logger.file, home) }] : []),
    ],
    reused
      ? // This launch owns nothing and exits immediately, so ctrl-c would not stop what it reopened.
        "reopened the server already running for this project · stop it from the terminal that started it"
      : options.debug
        ? undefined
        : publicOrigin
          ? "press L for a fresh sign-in link · R to change how this board is reached · ctrl-c to stop"
          : "press R to reach this board from a phone or another machine · ctrl-c to stop",
    {
      ...(reused ? { status: `already running on port ${port}` } : {}),
      ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
      ...(activeAccessLink && !reused ? { qr: renderQrLines(activeAccessLink.url) } : {}),
    },
  );
}

async function runSupervisor(port: number, token: string, onPrepared: () => void = () => {}): Promise<never> {
  assertLaunchPrerequisites();
  if (!serverOwner) throw new Error("stable server launch is missing global ownership");
  const owner = adoptProjectLaunchOwner(target, token, "supervisor");
  const env = projectLaunchEnvironment(
    {
      ...process.env,
      FRIZZ_PRODUCTION_SUPERVISOR: "1",
      FRIZZ_SERVER_OWNERSHIP: JSON.stringify(projectLaunchEnvironment({}, serverOwner.target, serverOwner.token)),
      ...logEnvironment(logger, options.debug ? "debug" : "info"),
      ...(options.debug ? { FRIZZ_DEBUG: "1" } : {}),
    },
    target,
    owner.token,
  );
  const spec = serverReleaseSpec(
    JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")),
    process.env.FRIZZ_SERVER_PACKAGE,
  );
  const installer = npmServerPackageInstaller(env);
  const store = new ServerReleaseStore(spec, installer);
  activityReadout?.notice("progress", "Starting", "loading the selected Frizz server release");
  let active = await store.load();
  let pending: ServerGeneration | undefined;
  let previous = active;
  onPrepared();

  // Whether the registry actually has something newer, refreshed on a timer and READ FROM CACHE.
  // The status endpoint is polled by every open tab, so it must never reach the network; and the
  // answer only changes when someone publishes, so a slow cadence is plenty.
  //
  // Seeded `false`, not `true`. It started optimistic so the button would not flip from Restart to
  // Update a second after load — but the flip that actually happens is the other way: right after
  // an update the successor seeded `true` again and the reloaded tab showed "Update Frizz" naming a
  // version it already was, and a click in that window failed with "already current" presented as
  // an error; offline, the seed never cleared at all and every click was a red failure (audit
  // 2026-09-11, finding 5). A Restart that becomes Update once the registry answers is the cheaper
  // mistake. Only a POSITIVE probe raises it; a probe that fails leaves the last known answer.
  let updateAvailable = false;
  // The newer version the last successful probe saw, so the status endpoint can NAME the update it is
  // advertising. Set together with the boolean: a number we have not observed would be a lie, so
  // until the registry answers the client gets its generic copy.
  let updateVersion: string | undefined;
  const refreshUpdateAvailable = async (): Promise<void> => {
    try {
      const checkedVersion = active.version;
      const plan = await planRegistryUpdate(spec.package, checkedVersion, installer);
      if (active.version !== checkedVersion) return;
      updateAvailable = plan !== null;
      updateVersion = plan?.latestVersion;
    } catch {
      // A registry we cannot reach is not evidence either way. Leave the last known answer.
    }
  };
  void refreshUpdateAvailable();
  const updateAvailablePoll = setInterval(() => void refreshUpdateAvailable(), 30 * 60 * 1000);
  updateAvailablePoll.unref();

  const supervisor = await startDevSupervisor({
    port,
    host: LOOPBACK_BIND_HOST,
    allowedHosts: [],
      // A spent code repaints the open QR pane as stale, so nobody photographs a dead link.
      onCodeConsumed: () => accessPane?.markConsumed(),
    // Persisted beside the project's other state, so a restart does not sign every device out.
    // Always, not only when public: the origin can be switched on later (press R), and a phone signed
    // in through one name stays signed in through the next.
    sessionKey: loadOrCreateSessionKey(workspace.stateDir),
    sessionDirectory: fileSessionDirectory(workspace.stateDir),
    cwd: workspace.root,
    stateDir: workspace.stateDir,
    launchTarget: target,
    launchOwnerToken: owner.token,
    env,
    watch: false,
    childLaunchProvider: () => serverGenerationLaunch(pending ?? active),
    updateMode: "child",
    updateAvailable: () => updateAvailable,
    version: () => active.version,
    launcherVersion: PACKAGE_VERSION,
    updateVersion: () => updateVersion,
    // The terminal that owns the board says so when the board goes down and comes back. Everything
    // here is triggered from a browser tab or by a crash, so without this the foreground process is
    // the last place to learn what happened to it.
    onActivity: (event) => renderSupervisorActivity(activityReadout, event),
    updateRestart: async () => {
      previous = active;
      try {
        const plan = await planRegistryUpdate(spec.package, active.version, installer);
        if (!plan) { updateAvailable = false; updateVersion = undefined; return { state: "failed" as const, message: `Frizz ${active.version} is already current` }; }
        updateAvailable = true;
        updateVersion = plan.latestVersion;
        // Install while the current server serves. Selection remains provisional until the new
        // child is ready; the durable launcher, listener, terminal and tunnels never move.
        pending = await store.prepare(plan.latestVersion);
        return { state: "ready" as const, message: `Frizz ${plan.latestVersion} is installed and compatible` };
      } catch (error) {
        return { state: "failed" as const, message: error instanceof Error ? error.message : String(error) };
      }
    },
    commitUpdate: () => {
      if (!pending) throw new Error("no server update was prepared");
      store.commit(pending);
      active = pending;
      pending = undefined;
      updateAvailable = false;
      updateVersion = undefined;
    },
    rollbackUpdate: () => {
      if (active.id !== previous.id) store.commit(previous);
      active = previous;
      pending = undefined;
    },
  });
  publishStableServerAddress(serverOwner, port);
  // The first single-use link, minted now that the board can redeem it. The old `?frizz_token=` this
  // replaced was a STANDING secret: it never expired and never rotated, so anything that saw it once
  // — a screenshot, scrollback, a chat log — kept working forever.
  remote = createRemoteController({ host: supervisor, port, log: logger, say: (message) => console.error(`frizz: ${message}`) });
  try {
    await remote.serveSaved();
  } catch (error) {
    // A saved setup that cannot come up must not take the board down with it: the board still serves
    // loopback, the readout says so, and R offers the setup again.
    const message = error instanceof Error ? error.message : String(error);
    logger.error("remote", message);
    console.error(`frizz: the saved remote setup could not start: ${message}`);
  }
  activeAccessLink = remote.origin() ? supervisor.issueAccessLink() : null;

  // "Press L for a fresh link" — the only way to reissue without restarting. Null when stdout is not
  // a terminal, which leaves the plain records path untouched.
  accessPane = createAccessPane({ issue: () => supervisor.issueAccessLink() });
  const remotePane = createRemotePane({
    port,
    current: () => remote?.current() ?? null,
    apply: (next, applyOptions) => remote!.apply(next, applyOptions),
    claim: (name) => establishCloudConfig(name, port),
    issueLink: () => supervisor.issueAccessLink(),
    probes: { github: probeGithub, cloudflared: probeCloudflared, tailscale: probeTailscale },
    onChanged: (config) => logger.info("remote", config ? `reached at https://${config.hostname}` : "loopback only"),
    sandbox: sandbox !== null,
  });
  paneHost = installPaneHost({ bindings: { l: accessPane, L: accessPane, r: remotePane, R: remotePane } });

  const stop = createSupervisorShutdownHandler({
    close: () => supervisor.close(),
    force: () => supervisor.forceStop(),
    release: () => { owner.release(); if (serverOwner) releaseStableServerOwner(serverOwner); },
    // Acknowledge the first signal on the spot; the drain that follows is bounded but not instant.
    onStop: () => {
      logger.info("launcher", "stop signal received; draining the control plane");
      activityReadout?.notice("progress", "Stopping", "draining the control plane — press ctrl-c again to force");
    },
    exit: (code) => {
      logger.info("launcher", `stopped with code ${code}`);
      // Before the farewell, or the operator's shell is left in raw mode echoing nothing.
      paneHost?.dispose();
      // Down with the board: a surviving cloudflared keeps the hostname resolving to a 530.
      remote?.stop();
      const suffix = logger.file ? `\n  log: ${tildePath(logger.file, homedir())}` : "";
      process.stdout.write(
        code === 0
          ? `\n  Frizz stopped. Running agents keep going — they are detached daemons.${suffix}\n\n`
          : `\n  Frizz stopped with errors (exit ${code}).${suffix}\n\n`,
      );
      process.exit(code);
    },
    error: (line) => logger.error("supervisor", line.startsWith("[frizz] ") ? line.slice(10) : line),
  });
  // SIGHUP is what closing a terminal sends, and Node's default action for it is to die on the spot —
  // so without this the launcher was killed WITHOUT running `stop`, and the control-plane child (which
  // sits in its own process group, so the tty never signals it directly) was orphaned still holding the
  // port. That is the whole reason an "always foreground" board could outlive its terminal and need
  // `--stop` to reach. Verified on a live board: launcher pgid 31700, child pgid 31704, same tty.
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
  void supervisor.stopRequested.then(stop);
  await supervisor.firstBoot;
  store.commit(active);
  activityReadout?.notice("done", "Server", `${active.version} · launcher ${PACKAGE_VERSION}`);
  // The execve'd generation prints no boot block (it is not an interactive launch), so this one line
  // is the only thing that tells the operator the update finished and this terminal still owns it.
  if (reexec) {
    activityReadout?.notice(
      "done",
      "Updated",
      `Frizz ${active.version} is serving on port ${port} · ctrl-c to stop${globalInstall ? ` · ${keepUpdateHint(PACKAGE_NAME, PACKAGE_VERSION)}` : ""}`,
    );
  }
  return await new Promise<never>(() => {});
}

try {
  // Hold this across downloads, child handoffs and recovery. A 503 from the application is never
  // permission to start a second scheduler, and a custom port is just as discoverable as the default.
  const globalClaim = acquireStableServerOwner();
  if (globalClaim.kind === "busy") throw new Error("Frizz is starting or recovering on this machine; retry shortly");
  if (globalClaim.kind === "running") {
    if (options.port && options.port !== globalClaim.port)
      throw new Error(`Frizz is already running on port ${globalClaim.port}; --port cannot change a running server`);
    await openOrPrint(globalClaim.port, true, slugPath());
    process.exit(0);
  }
  serverOwner = globalClaim.lease;
  if (process.env.FRIZZ_PRODUCTION_SUPERVISOR === "1" || reexec) {
    if (!options.port) throw new Error("internal registry supervisor launch is missing --port");
    const token = projectLaunchOwnerTokenFromEnvironment(process.env);
    if (!token) throw new Error("registry supervisor launch is missing project ownership");
    await runSupervisor(options.port, token);
  }
  const existing = await existingPort();
  if (existing) {
    await openOrPrint(existing, true, slugPath());
    process.exit(0);
  }
  // slugPath(), not the joined slug: that slug names the project this launch is HOSTED on, which is
  // the project to open only when the intent is `open`. An `everything`/`offer` launch rides on the most
  // recent project and must still land on `/` rather than opening someone else's board.
  const joined = await joinRunningFrizz();
  if (joined) { await openOrPrint(joined.port, true, slugPath()); process.exit(0); }
  const claim = tryAcquireProjectLaunchOwner(target, "launcher");
  if (claim.kind !== "acquired") throw new Error("Frizz is starting for this project; retry shortly");
  let release: (() => void) | undefined = await acquireGlobalLaunchLock();
  let portReservation: (() => void) | undefined;
  try {
    const allocation = await allocatePort(options.port, readPreferredPort(workspace.stateDir), { host: LOOPBACK_BIND_HOST });
    const port = allocation.port;
    portReservation = allocation.release;
    // The supervisor owns the rest of this process's life (runSupervisor never returns), so start it
    // WITHOUT awaiting and race it against health. Awaiting it directly is what made everything below
    // unreachable: parseCliArgs pins `foreground` to true, so the old `if (options.foreground) await
    // runSupervisor(...)` always won and a cold `npx frizz` never printed its URL, never opened a
    // browser, and never released the lock it took — the detached-spawn branch that used to follow was
    // dead code the day parseCliArgs stopped honouring --detach.
    let didPrepare!: () => void;
    const prepared = new Promise<void>((resolve) => { didPrepare = resolve; });
    const running = runSupervisor(port, claim.lease.token, didPrepare);
    // Allocation is the only machine-shared step, so the machine-global lock ends HERE — the port
    // reservation above, not this lock, keeps `port` ours until the child listens. Holding it across
    // the progress-tracked wait below meant one cold `npx frizz` could sit on it for minutes while
    // every other repository's launcher gave up after a far shorter budget.
    release();
    release = undefined;
    // Cold installs have their own bounded npm timeout. Do not spend the server's boot/stall budget
    // waiting for a download, and do not hold the machine-global allocation lock while it runs.
    await Promise.race([prepared, running]);
    // Progress-tracked: a boot that keeps reporting steps keeps the launcher's patience, so a large
    // board on a busy machine is no longer indistinguishable from a wedge. See waitForWorkspace.
    // `running` stays in the race so a supervisor that dies while booting reports immediately.
    await Promise.race([
      waitForWorkspace(
        port,
        expectedOwnerHealth(target, readProjectLaunchOwner(workspace.stateDir)),
        undefined,
        { stateDir: workspace.stateDir },
      ),
      running,
    ]);
    // The child is listening now, so the port defends itself. The reservation must NOT span the
    // foreground server lifetime, or a stopped-but-unreleased claim would push this repository's next
    // launch off its remembered port.
    portReservation();
    portReservation = undefined;
    await openOrPrint(port, false, slugPath());
    await running;
  } finally { release?.(); portReservation?.(); claim.lease.release(); }
} catch (error) {
  logger.error("launcher", `startup failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  if (readout) {
    const where = readout.activeStep();
    readout.fail(
      `${where ? `${where.label.toLowerCase()}: ` : ""}${error instanceof Error ? error.message : String(error)}`,
      logger.file ?? undefined,
    );
    process.exit(1);
  }
  fail(error);
}
