#!/usr/bin/env node
import "@ntwine/shared/legacy-env"
import type { RemoteController } from "./remote-controller.ts";
import { wireRemote } from "./remote-wiring.ts";
import { bindHostIsExposed } from "@ntwine/server/local-origin";
import { loadSessionState, sessionEpochLogLine, sessionEpochNotice } from "@ntwine/server/access-codes";
import { qrAreaOf, renderQrLines } from "@ntwine/server/qr";
import { listSessions, signOutSession } from "./sessions-cli.ts";
import { SUPERVISOR_ACCESS_CODE_PATH } from "@ntwine/server/restart-supervisor";
import type { AccessPane } from "./access-pane.ts";
import type { PaneHost } from "./pane-host.ts";
import { LOOPBACK_BIND_HOST } from "@ntwine/server/local-origin";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { launchApp, launchBrowserTab } from "./browser.ts";
import { Readout, noticeOnlyReadout, renderSupervisorActivity, tildePath } from "./readout.ts";
import {
  appendCrashRecord,
  attachTerminalMirror,
  createLogger,
  logEnvironment,
  runLogPath,
  setAmbientLogger,
  type Logger,
} from "@ntwine/server/logging";
import {
  buildNtwineArtifact,
  assertArtifactHostCompatible,
  defaultArtifactRoot,
  ensureStableNtwineArtifact,
  promoteNtwineArtifact,
  readNtwineArtifact,
  readStableArtifact,
} from "./artifacts.ts";
import { assertLaunchPrerequisites, assertRequiredExecutables } from "./preflight.ts";
import { DEFAULT_DEV_PORT, fallbackPort } from "@ntwine/shared";
import {
  acquireGlobalLaunchLock,
  allocatePort,
  boardAddress,
  canBindPort,
  resolveLaunchIntent,
  expectedOwnerHealth,
  FIRST_ARTIFACT_LAUNCH_LOCK_TIMEOUT_MS,
  helpText,
  liveWorkspaceOwner,
  DEV_SANDBOX_HOME_ENV,
  devLauncherReexecArgs,
  durableReexecArgs,
  cleanupSandbox,
  parseCliArgs,
  prepareSandbox,
  persistLauncher,
  probeNtwine,
  JOIN_PROBE_TIMEOUT_MS,
  prepareBeforeGlobalLaunchLock,
  readPreferredPort,
  requestNtwineStop,
  resolveWorkspace,
  sourceLabel,
  sourceWorkspaceDir,
  supervisorNeedsAttention,
  waitForWorkspace,
  workspaceFromLaunchTarget,
  workspaceLaunchTarget,
  type CliOptions,
  type Workspace,
} from "./launcher.ts";
import {
  adoptProjectLaunchOwner,
  projectLaunchEnvironment,
  projectLaunchOwnerTokenFromEnvironment,
  projectLaunchTargetFromEnvironment,
  processGenerationIsStale,
  readProjectLaunchOwner,
  tryAcquireProjectLaunchOwner,
  verifyProjectLaunchDelegate,
  type ProjectLaunchLease,
} from "@ntwine/server/project-launch";
import { registerProject } from "@ntwine/server/project-registry";
import { ProjectServedElsewhereError, servingRecordElsewhere } from "@ntwine/server/project-serving";
import { resolveProjectLabel } from "@ntwine/server/project-identity";
import { runArtifactBuildJob, spawnArtifactBuild } from "./artifact-build-job.ts";

// Update & Restart re-runs this entry as its artifact build job (see artifact-build-job.ts). It must
// hand off before anything below parses an argument, resolves a project or opens a log.
if (runArtifactBuildJob()) await new Promise<never>(() => {});

function fail(error: unknown): never {
  console.error(`ntwine: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

/**
 * The last thing the operator sees when the board stops. Ctrl-C used to print nothing whatsoever, so
 * a clean shutdown and a crashed one looked identical, and neither told you where to read the log.
 */
function printFarewell(code: number): void {
  const suffix = logger.file ? `\n  log: ${tildePath(logger.file, homedir())}` : "";
  process.stdout.write(
    code === 0
      ? `\n  Ntwine stopped. Running agents keep going — they are detached daemons.${suffix}\n\n`
      : `\n  Ntwine stopped with errors (exit ${code}).${suffix}\n\n`
  );
}

/** The version this checkout reports, for the readout header. Best-effort; never fails a launch. */
function sourceVersion(): string | undefined {
  try {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")
    ) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

const argv = process.argv.slice(2);
const sourceCommand = process.env.NTWINE_SOURCE_COMMAND ?? "ntwine-dev";
// `top` reads the machine and exits; it touches no workspace, lock or artifact, so it runs before any of
// them are resolved and works from any directory. Shared with src/production.ts.
if (argv[0] === "top") {
  const { runTop } = await import("@ntwine/server/top");
  process.exit(await runTop(argv.slice(1)));
}
/**
 * build/promote/restart are ARTIFACT verbs: they suppress the readout and the foreground hold, do one
 * job and exit. Launching is not one of them — there is exactly one way to start Ntwine, and it is the
 * bare command with flags. `up` used to be a fourth verb here, sugar for `--cloud`; it was removed
 * because a second spelling of "start the server" is a second thing to explain, and because it read as
 * a per-project command on a server that has never been per-project.
 */
const command = ["build", "promote", "restart"].includes(argv[0] ?? "")
  ? argv[0]
  : undefined;
let options: CliOptions;
try {
  options = parseCliArgs(command === "promote" ? argv.slice(2) : command ? argv.slice(1) : argv);
} catch (error) {
  fail(error);
}
if (options.help) {
  console.log(helpText(sourceCommand));
  process.exit(0);
}
if (argv.includes("--prod"))
  fail("--prod is not available from the source-backed development launcher");

// Before ANYTHING reads the home directory: the sandbox swaps $HOME for a throwaway, so every piece
// of state after this line — registry, lock, logs, session key, cloud.json — is a disposable copy.
// A `--dev` launcher that re-execs itself for a source edit is still the same sandbox: the throwaway
// home rides in the environment (its HOME already points there), so the successor adopts it rather
// than minting a second one, and still deletes it when the board finally stops.
const sandbox = options.sandbox
  ? prepareSandbox()
  : process.env.NTWINE_DEV_REEXEC === "1" && process.env[DEV_SANDBOX_HOME_ENV]
  ? { home: process.env[DEV_SANDBOX_HOME_ENV]!, project: process.cwd() }
  : null;
if (sandbox) {
  process.env[DEV_SANDBOX_HOME_ENV] = sandbox.home;
  process.on("exit", () => cleanupSandbox(sandbox.home));
}

const internalLaunch =
  process.env.NTWINE_DIRECT_SUPERVISOR === "1" ||
  process.env.NTWINE_DAEMON_CHILD === "1" ||
  process.env.NTWINE_DEV_REEXEC === "1" ||
  process.env.NTWINE_DEV_CHILD === "1";
const interactiveLaunch =
  !internalLaunch &&
  !options.stop &&
  !options.status &&
  // --link is a QUERY against a running board, not a launch. Counting it as interactive built a
  // progress readout around it, so `ntwine-dev --link` printed boot chatter above the URL you asked
  // for — and it would have made the takeover below fire on a command that must never restart anything.
  !options.link &&
  command !== "restart" &&
  command !== "promote";

const readout = interactiveLaunch
  ? new Readout({ debug: options.debug, version: sourceVersion() })
  : undefined;

/**
 * Where supervisor lifecycle beats print. Normally the boot readout — but a launcher that re-execed
 * itself through Update Ntwine has no boot to narrate and still owns the operator's terminal, so it
 * gets a notice-only one rather than falling silent for the rest of the session.
 */
const activityReadout =
  readout ??
  (process.env.NTWINE_DEV_REEXEC === "1" && process.stdout.isTTY
    ? noticeOnlyReadout({ version: sourceVersion() })
    : undefined);

readout?.plan([
  { key: "workspace", label: "Workspace" },
  ...(options.dev ? [] : [{ key: "artifact", label: "Artifact" }]),
  { key: "server", label: "Server" },
  { key: "browser", label: options.noApp ? "Address" : "Browser" },
]);
readout?.begin("workspace");

let workspace: Workspace;
let launchIntent: ReturnType<typeof resolveLaunchIntent> | undefined;
try {
  const pinned = projectLaunchTargetFromEnvironment(process.env);
  const internal =
    process.env.NTWINE_DEV_CHILD === "1" ||
    process.env.NTWINE_DIRECT_SUPERVISOR === "1" ||
    process.env.NTWINE_DAEMON_CHILD === "1" ||
    process.env.NTWINE_DEV_REEXEC === "1";
  if (internal && !pinned)
    throw new Error("internal launch is missing its pinned project identity");
  // Resolving a workspace opens this project's database, so check first and name what is wrong. The
  // Node floor is the live half for a real launch: on an unsupported release SQLite SEGFAULTS rather
  // than erroring, and a segfault mid-boot reads as "Ntwine is broken" instead of "upgrade Node".
  // `--stop`/`--status` and the repair commands keep the executables-only check, since they only read a
  // status file and signal a process — that list is EMPTY today (nothing shells out to `git` or `tmux`
  // any more; see preflight.ts) and survives as the seam for the next hard dependency.
  if (!internal) {
    if (interactiveLaunch) assertLaunchPrerequisites();
    else assertRequiredExecutables();
  }
  // Running the command never ADOPTS the directory it was run in — see resolveLaunchIntent. A
  // directory that is not already a project hosts the server on Ntwine's own stand-in folder and
  // lands on `/all`, or on `/` (the add-project dialog) when it is a repository Ntwine has not seen.
  let hosted: Workspace | undefined;
  if (!internal) {
    const intent = resolveLaunchIntent();
    launchIntent = intent;
    hosted = intent.workspace;
  }
  workspace = internal ? workspaceFromLaunchTarget(pinned!) : hosted!;
} catch (error) {
  // Report ONCE — `fail()` prints too, and doing both showed the operator the same sentence twice
  // under two prefixes, which reads like two separate failures.
  //
  // No project is known yet, so this record goes to the machine-level fallback directory rather than
  // a per-project one. Written directly: there is no logger to own, and none is worth creating for a
  // launch that is already over.
  const fallback = runLogPath();
  appendCrashRecord(
    fallback,
    `workspace resolution failed: ${error instanceof Error ? error.stack ?? error.message : error}`
  );
  if (readout) {
    readout.fail(error instanceof Error ? error.message : String(error), fallback);
    process.exit(1);
  }
  fail(error);
}
// No `process.chdir(workspace.root)` — see the same line in production.ts.
// The project is known now, so this run's log belongs in its state directory, beside every other
// per-project artifact a reader debugging this board already looks at. A forked child inherits the
// parent's path through the environment instead of opening its own.
const logger: Logger = setAmbientLogger(
  process.env.NTWINE_LOG_FILE
    ? createLogger({ file: process.env.NTWINE_LOG_FILE, owner: false })
    : createLogger({ file: runLogPath(workspace.stateDir) })
);
attachTerminalMirror(logger, options.debug || process.env.NTWINE_DEBUG === "1");
// Only the OPERATOR's invocation announces itself. The control-plane child re-enters this same entry
// point with NTWINE_DEV_CHILD=1 before reaching its own branch below, so without this guard every run
// logged the launcher banner twice — once for the real launch and once for the child.
if (!internalLaunch) {
  logger.info("launcher", `${sourceCommand} starting in ${options.dev ? "source" : "artifact"} mode`);
  logger.info("launcher", `workspace ${workspace.name} (${workspace.root})`);
}
// Only an `open` launch is ABOUT its workspace. Any other is hosted on a project the operator did
// not pick, and naming that one here reads as "this is the project you opened".
readout?.settle("workspace", "done", launchIntent && launchIntent.kind !== "open" ? "dashboard" : workspace.name);
const expectedHealth = { projectId: workspace.id, projectDir: workspace.root };
const launchTarget = workspaceLaunchTarget(workspace);
/**
 * The first single-use access link, minted once the supervisor is listening.
 *
 * Module-scoped because the supervisor is built inside the launch path while the readout is assembled
 * in another function entirely, and threading one nullable string through that call chain buys nothing.
 */
let activeAccessLink: { code: string; url: string; expiresAt: number } | null = null;
/** Set when this start's session-epoch advance signed remote devices out; the readout says so. */
let sessionNotice: string | null = null;
/** The keyboard: L for a link, R for the remote-access walkthrough. Held so shutdown can restore the shell. */
let paneHost: PaneHost | null = null;
let accessPane: AccessPane | null = null;
/** How this board is reached from outside — the saved setup, the transport, the origin. Built once the supervisor listens. */
let remote: RemoteController | null = null;

// The supervisor validates every generation by forking this same source entry with a private marker.
// That disposable child boots only the HTTP/Vite control plane; it must never recursively supervise.
if (process.env.NTWINE_DEV_CHILD === "1") {
  const token = projectLaunchOwnerTokenFromEnvironment(process.env);
  if (!token) throw new Error("dev child is missing project launch ownership");
  verifyProjectLaunchDelegate(workspaceLaunchTarget(workspace), token);
  const { runDevControlPlaneChild } = await import(
    "@ntwine/server/dev-supervisor"
  );
  await runDevControlPlaneChild();
  await new Promise<never>(() => {});
}

async function runSupervisor(
  port: number,
  inheritedToken?: string | null,
  pinnedArtifactDigest?: string
): Promise<never> {
  // Keep build/promote/status/stop usable for repair on a partially provisioned machine, but never
  // let a control-plane server start when its mandatory local tools are unavailable.
  assertLaunchPrerequisites();
  const target = workspaceLaunchTarget(workspace);
  const token =
    inheritedToken ?? projectLaunchOwnerTokenFromEnvironment(process.env);
  if (!token) throw new Error("supervisor launch is missing project ownership");
  const launchOwner = adoptProjectLaunchOwner(target, token, "supervisor");
  const supervisorEnv = projectLaunchEnvironment(
    {
      ...process.env,
      NTWINE_DIRECT_SUPERVISOR: "1",
      // Every descendant appends to THIS run's log. That is what lets the control-plane child stay
      // silent on the terminal without its records being lost.
      ...logEnvironment(logger, options.debug ? "debug" : "info"),
      ...(options.debug ? { NTWINE_DEBUG: "1" } : {}),
      // --dev runs Vite from this checkout, and Vite's dependency cache must never be shared with
      // another dev server rooted here (packages/web/vite.config.ts says why). Left at its default,
      // a `ntwine-dev --dev` beside the maintainer's `nub run dev` hashed its config differently and
      // re-optimized node_modules/.vite under the live server, whose open tab then 404ed on every
      // rewritten chunk (2026-10-01). So --dev keeps its own cache, and a sandbox one of its own.
      // Relative to packages/web like the throwaway stacks' `.vite-scratch`, and inside node_modules
      // on purpose: @vitejs/plugin-react skips any path containing node_modules, and a cache outside
      // it (one under the sandbox's /tmp home was tried) gets its prebundled react-scan run through
      // Fast Refresh, which throws "can't detect preamble" on every load.
      ...(options.dev && !process.env.NTWINE_VITE_CACHE_DIR
        ? { NTWINE_VITE_CACHE_DIR: sandbox ? "node_modules/.vite-sandbox" : "node_modules/.vite-ntwine-dev" }
        : {}),
    },
    target,
    launchOwner.token
  );
  const selectedArtifact = options.dev
    ? undefined
    : pinnedArtifactDigest ?? process.env.NTWINE_STABLE_ARTIFACT
    ? readNtwineArtifact(
        pinnedArtifactDigest ?? process.env.NTWINE_STABLE_ARTIFACT!,
        defaultArtifactRoot()
      )
    : ensureStableNtwineArtifact(
        workspace.stateDir,
        sourceWorkspaceDir(),
        defaultArtifactRoot()
      );
  if (selectedArtifact) assertArtifactHostCompatible(selectedArtifact);
  const { createSupervisorShutdownHandler, probeLauncherSource, startDevSupervisor } = await import(
    "@ntwine/server/dev-supervisor"
  );
  let supervisor: Awaited<ReturnType<typeof startDevSupervisor>>;
  const stableOptions = selectedArtifact
    ? (() => {
        let updateRollbackArtifact: string | undefined;
        let firstChildLaunch = true;
        const selectedChildLaunch = () => {
          // The launcher selected this artifact before starting the foreground supervisor. The first control-plane child is
          // pinned to that verified digest even if source or the durable pointer changes while the
          // supervisor is coming up. Later authenticated restarts intentionally consult promotion.
          const artifact = firstChildLaunch
            ? selectedArtifact
            : readStableArtifact(workspace.stateDir, defaultArtifactRoot());
          firstChildLaunch = false;
          if (!artifact)
            throw new Error(
              "the currently promoted Ntwine artifact is missing or failed verification"
            );
          assertArtifactHostCompatible(artifact);
          return {
            entry: join(artifact.runtimeDir, "src", "index.js"),
            environment: {
              NTWINE_STABLE_WEB_DIST: artifact.webDir,
              NTWINE_STABLE_ARTIFACT: artifact.digest,
              NTWINE_SCRIPTS_DIR: join(artifact.runtimeDir, "board"),
              // The bundled runtime resolves its worker plugin from the verified artifact closure.
              NTWINE_WORKER_PLUGIN_DIR: join(artifact.runtimeDir, "cc-worker"),
            },
          };
        };
        return {
          childLaunchProvider: selectedChildLaunch,
          watch: false,
          updateRestart: async () => {
            // Build and verify before touching the healthy child. No source edit can enter this path.
            // An unverifiable current artifact leaves us without a rollback target but does not
            // block the update — see promoteCurrentSourceArtifact.
            // In a child process: this one owns the board's listener and the stop signals, and the
            // build blocks for minutes — see artifact-build-job.ts.
            try {
              const { previous } = await spawnArtifactBuild({
                stateDir: workspace.stateDir,
                sourceDir: sourceWorkspaceDir(),
                root: defaultArtifactRoot(),
                onProgress: (message) => logger.info("artifact", message),
              }).result;
              updateRollbackArtifact = previous;
              return { state: "ready" as const };
            } catch (error) {
              return {
                state: "failed" as const,
                message: error instanceof Error ? error.message : String(error),
              };
            }
          },
          rollbackUpdate: () => {
            if (!updateRollbackArtifact) return;
            promoteNtwineArtifact(
              workspace.stateDir,
              updateRollbackArtifact,
              defaultArtifactRoot()
            );
            updateRollbackArtifact = undefined;
          },
          ...(typeof process.execve === "function"
            ? {
                durableReexec: () => {
                  // Update & Restart promotes a complete deployed CLI/runtime, not merely the
                  // child HTTP entry. Replace this owner with that immutable CLI so
                  // server/supervisor fixes take effect too. The tokenized launch lease stays in
                  // the environment across execve; SQLite and provider-side sessions are project
                  // resources and are never copied or torn down for this handoff.
                  const artifact = readStableArtifact(
                    workspace.stateDir,
                    defaultArtifactRoot()
                  );
                  if (!artifact)
                    throw new Error(
                      "the promoted Ntwine artifact is missing or failed verification"
                    );
                  assertArtifactHostCompatible(artifact);
                  const env = projectLaunchEnvironment(
                    {
                      ...supervisorEnv,
                      NTWINE_DEV_REEXEC: "1",
                      NTWINE_SOURCE_DIR: sourceLabel(),
                      NTWINE_STABLE_ARTIFACT: artifact.digest,
                    },
                    target,
                    launchOwner.token
                  );
                  delete env.NTWINE_DEV_CHILD;
                  delete env.NTWINE_DEV_PORT;
                  // execve keeps this pid and this terminal, so the successor announces itself below
                  // once its first child is up. Saying it here too covers the window in between, which
                  // is the whole build-and-boot of a new artifact.
                  activityReadout?.notice(
                    "progress",
                    "Updating",
                    `reloading this launcher in place on ${artifact.digest.slice(0, 12)}`
                  );
                  // The successor takes the tunnel over, so hand it back rather than leaving it. execve
                  // keeps this pid and its children, so a cloudflared left running here would outlive
                  // every handle to it — nothing in the new image knows it exists, and stopping the
                  // board would strand it pointed at a port nobody serves.
                  remote?.stop();
                  process.execve!(
                    process.execPath,
                    [
                      process.execPath,
                      ...durableReexecArgs({
                        entry: join(artifact.runtimeDir, "src", "index.js"),
                        port,
                      }),
                    ],
                    env
                  );
                },
              }
            : {}),
        };
      })()
    : {
        // --dev is intentionally the only route that can boot source plus Vite/HMR.
        watch: true,
        // An edit to the launcher's own source re-execs this process in place. Its argv must be the
        // internal re-entry's, not the operator's: `ntwine-dev --dev` carries no --port, and the
        // re-entry refuses to start without one, so every launcher edit used to end the board with
        // "internal supervisor launch is missing --port" (2026-10-01, three runs in one evening).
        reexecArgs: devLauncherReexecArgs({
          entry: import.meta.filename,
          port,
          debug: options.debug,
        }),
        validateLauncher: async () => {
          // `--help` loads every module this entry imports statically and exits before touching any
          // state; dev-supervisor is the one launcher module it loads lazily, so it gets its own probe.
          const env = { ...supervisorEnv };
          delete env.NTWINE_DEV_REEXEC;
          const [cli, supervisorModule] = await Promise.all([
            probeLauncherSource({ args: [import.meta.filename, "--help"], env }),
            probeLauncherSource({
              args: [
                "--input-type=module",
                "-e",
                `await import(${JSON.stringify(import.meta.resolve("@ntwine/server/dev-supervisor"))})`,
              ],
              env,
            }),
          ]);
          return cli ?? supervisorModule;
        },
        ...(process.platform !== "win32" && typeof process.execve === "function"
          ? {
              reexec: (request: { executable: string; argv: string[]; env: Record<string, string> }) => {
                // Same handoff as an update's: the successor serves the saved remote setup itself, so a
                // tunnel left running here would outlive every handle to it. And give the terminal back
                // before the new image installs its own key handling.
                remote?.stop();
                paneHost?.dispose();
                process.execve!(request.executable, request.argv, request.env);
              },
            }
          : {}),
      };
  // Persisted beside the project's other state so a restart does not sign every device out.
  // Always, not only when public: the origin can be switched on later (press R), and a phone signed
  // in through one name stays signed in through the next. Loading it also applies SESSION_EPOCH, which
  // signs out every device from before a security bump, once.
  const sessions = loadSessionState(workspace.stateDir);
  const epochRecord = sessionEpochLogLine(sessions.advance, sessions.signedOut);
  if (epochRecord) logger.warn("launcher", epochRecord);
  sessionNotice = sessionEpochNotice(sessions.signedOut);
  try {
    // First run only. Asking here rather than at import keeps the question off every other launch.
    supervisor = await startDevSupervisor({
      port,
      host: LOOPBACK_BIND_HOST,
      allowedHosts: [],
      // A spent code repaints the open QR pane as stale, so nobody photographs a dead link.
      onCodeConsumed: () => accessPane?.markConsumed(),
      sessionKey: sessions.key,
      rotateSessionKey: sessions.rotateKey,
      sessionDirectory: sessions.directory,
      cwd: workspace.root,
      env: supervisorEnv,
      stateDir: workspace.stateDir,
      launchTarget: target,
      launchOwnerToken: launchOwner.token,
      ...stableOptions,
      // This file IS ntwine-dev: it only ever runs from a source checkout, and the published bin is
      // src/production.ts (scripts/build-package.mjs maps "ntwine.js" to it). So reaching here means
      // a development build, on BOTH routes — the artifact one as much as `--dev`. The web client
      // cannot work that out for itself, because the artifact route serves a Vite PRODUCTION bundle
      // where `import.meta.env.DEV` is statically false. Stated after the spread so no launch-mode
      // option can quietly take it away.
      dev: true,
      // The terminal that owns the board says so when the board goes down and comes back. Restart
      // Ntwine and Update Ntwine are clicked in a browser and a control-plane crash is clicked by
      // nobody, so without this the foreground process is the last place to learn what happened.
      onActivity: (event) => renderSupervisorActivity(activityReadout, event),
      // Every child leaves the terminal as it found it at its own fork, and the first one was forked
      // before the keyboard went raw — so without this R stopped working after the first restart.
      onChildExit: () => paneHost?.reclaim(),
    });
    // The supervisor is listening now, so a code minted here is immediately redeemable.
    // Serve the saved setup, offer Settings → Remote access, and bind L and R (remote-wiring.ts).
    const wiring = await wireRemote({ supervisor, port, log: logger, say: (message) => console.error(`ntwine: ${message}`), sandbox: sandbox !== null });
    remote = wiring.remote;
    activeAccessLink = wiring.firstLink;
    accessPane = wiring.accessPane;
    paneHost = wiring.paneHost;
  } catch (error) {
    launchOwner.release();
    throw error;
  }
  const stop = createSupervisorShutdownHandler({
    close: () => supervisor.close(),
    force: () => supervisor.forceStop(),
    release: () => {
      launchOwner.release();
    },
    // The first signal answers on the spot. A drain can take seconds (the child gets a bounded stop,
    // then the proxy closes), and until 2026-08-25 nothing printed during it — so an operator whose
    // Ctrl-C had been received saw exactly what one whose Ctrl-C had been lost saw, and mashed the key.
    // The log line stamps when the stop actually arrived, which is the one fact a later report needs.
    onStop: () => {
      logger.info("launcher", "stop signal received; draining the control plane");
      activityReadout?.notice("progress", "Stopping", "draining the control plane — press ctrl-c again to force");
    },
    exit: (code) => {
      // Say the board stopped, and where the complete record of the run it just ended can be read.
      logger.info("launcher", `stopped with code ${code}`);
      // Before the farewell, or the operator's shell is left in raw mode echoing nothing.
      paneHost?.dispose();
      // Down with the board: leaving cloudflared running would keep the hostname resolving to a 530.
      remote?.stop();
      printFarewell(code);
      process.exit(code);
    },
    error: (line) =>
      logger.error("supervisor", line.startsWith("[ntwine] ") ? line.slice(10) : line),
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
  // The re-exec'd generation prints no boot block (it is not an interactive launch), so this one line
  // is the only thing that tells the operator the handoff finished. Two different things arrive here:
  // Update Ntwine execs into a promoted artifact and names its digest, while `--dev` re-execs this
  // launcher whenever its own source changes, where there is no artifact and nothing was updated.
  if (process.env.NTWINE_DEV_REEXEC === "1") {
    const digest = process.env.NTWINE_STABLE_ARTIFACT?.slice(0, 12);
    if (digest) activityReadout?.notice("done", "Updated", `now serving ${digest}`);
    else activityReadout?.notice("done", "Restarted", "this launcher reloaded itself in place");
  }
  persistLauncher(workspace, port, sourceWorkspaceDir());
  return await new Promise<never>(() => {});
}

// A legacy detached supervisor or durable re-exec re-enters here after launcher source changes. It must rebuild
// its watcher in-place without competing with its own global lock or trying to open another window.
if (
  process.env.NTWINE_DIRECT_SUPERVISOR === "1" ||
  process.env.NTWINE_DAEMON_CHILD === "1" ||
  process.env.NTWINE_DEV_REEXEC === "1"
) {
  if (!options.port) fail("internal supervisor launch is missing --port");
  await runSupervisor(
    options.port,
    projectLaunchOwnerTokenFromEnvironment(process.env)
  );
}

if (command === "build") {
  try {
    const artifact = buildNtwineArtifact(
      sourceWorkspaceDir(),
      defaultArtifactRoot(),
      { onProgress: (message) => logger.info("artifact", message) }
    );
    logger.info("artifact", `built ${artifact.digest}`);
    console.log(`built Ntwine artifact ${artifact.digest}`);
    console.log(`web: ${artifact.webDir}`);
    process.exit(0);
  } catch (error) {
    logger.error(
      "artifact",
      `build failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`
    );
    fail(error);
  }
}

if (command === "promote") {
  try {
    const digest = argv[1];
    if (!digest) throw new Error("usage: ntwine-dev promote <artifact-digest>");
    const pointer = promoteNtwineArtifact(
      workspace.stateDir,
      digest,
      defaultArtifactRoot()
    );
    console.log(
      `promoted Ntwine artifact ${pointer.current}${
        pointer.previous ? ` (rollback ${pointer.previous})` : ""
      }`
    );
    process.exit(0);
  } catch (error) {
    fail(error);
  }
}

async function existingHealth() {
  const ports = new Set<number>();
  const authoritative = readProjectLaunchOwner(workspace.stateDir);
  const owner = liveWorkspaceOwner(workspace.stateDir, launchTarget);
  if (
    authoritative &&
    (authoritative.state === "draining" ||
      processGenerationIsStale(authoritative))
  ) {
    return {
      port: undefined,
      health: null,
      owner: null,
      launchOwner: authoritative,
    };
  }
  const expected = expectedOwnerHealth(launchTarget, authoritative);
  if (owner) ports.add(owner.port);
  const preferred = readPreferredPort(workspace.stateDir);
  if (preferred) ports.add(preferred);
  for (const port of ports) {
    const health = await probeNtwine(port, expected);
    if (health) return { port, health, owner, launchOwner: authoritative };
  }
  return { port: undefined, health: null, owner, launchOwner: authoritative };
}

async function claimProjectLaunch(): Promise<
  ProjectLaunchLease | { reusePort: number }
> {
  const target = workspaceLaunchTarget(workspace);
  const deadline = Date.now() + 10_000;
  let lastOwner = readProjectLaunchOwner(workspace.stateDir);
  for (;;) {
    const attempt = tryAcquireProjectLaunchOwner(target, "launcher");
    if (attempt.kind === "acquired") return attempt.lease;
    lastOwner = attempt.owner ?? lastOwner;
    const existing = await existingHealth();
    if (existing.health && existing.port) return { reusePort: existing.port };
    if (Date.now() >= deadline) {
      const detail = lastOwner
        ? `${lastOwner.role} pid ${lastOwner.pid} owns startup but did not become ready`
        : "another launcher is still publishing project ownership";
      throw new Error(
        `${detail}; retry, inspect ntwine-dev --status, or stop the exact owner with ntwine-dev --stop`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Hand the operator the running board and print the block that stays on screen.
 *
 * Exactly ONE address appears here, and it is the one to open. The old readout printed the control
 * plane's private child port as well ("server on http://127.0.0.1:51739") — two ports, no indication
 * which was real. That port is an implementation detail and now goes to the log only.
 */
/**
 * This project's URL segment, registering it with the machine if it has not been seen before.
 *
 * `/` is not a board (it is the cross-project page), so a board lives under its own slug — including
 * the board we are about to launch. Registration is idempotent: an id already in the registry keeps the slug it was given.
 */
function ownSlug(launched = false): string | undefined {
  try {
    return registerProject(
      {
        dir: workspace.root,
        id: workspaceLaunchTarget(workspace).projectId,
        remoteOwner: resolveProjectLabel(workspace.root)?.split("/")[0],
        launched,
      },
      homedir()
    ).entry?.slug;
  } catch {
    // The registry is an INDEX. If it cannot be written, opening the board unprefixed still works.
    return undefined;
  }
}

/**
 * Where an Ntwine that could already be serving this project would be listening.
 *
 * An explicit `--port` is asked FIRST, for the same reason the well-known ones are asked at all: if a
 * Ntwine is already serving this project there, joining it is the answer and starting a rival is not.
 * Without it `--port N` skipped the join outright and then died at allocation, because the port it was
 * told to use was held by the very server it should have been using.
 */
function joinCandidatePorts(): number[] {
  return [
    ...new Set(
      [options.port, DEFAULT_DEV_PORT, fallbackPort(DEFAULT_DEV_PORT)].filter(
        (candidate): candidate is number => candidate !== undefined
      )
    ),
  ];
}

/**
 * An ntwine-dev already running on this machine, serving THIS project under its own slug.
 *
 * The same client-not-a-server move the published launcher makes, and it matters more here: this is
 * the command the maintainer actually runs, in four repositories. Without it a second `ntwine-dev`
 * would start a second server rather than joining the one that is already serving every project.
 *
 * The identity check is the launcher's own handshake minus the owner proof — that proof is keyed to a
 * launch LEASE and a client holds none. What a client needs to know is that this port serves ITS id
 * from ITS directory, which is exactly what the id and dir answer.
 */
async function joinRunningNtwine(): Promise<
  { port: number; slug: string } | undefined
> {
  const slug = ownSlug();
  if (!slug) return undefined;
  const target = workspaceLaunchTarget(workspace);
  for (const port of joinCandidatePorts()) {
    if (
      await probeNtwine(
        port,
        {
          projectId: target.projectId,
          projectDir: target.projectDir,
          slug,
        },
        fetch,
        JOIN_PROBE_TIMEOUT_MS
      )
    )
      return { port, slug };
  }
  return undefined;
}

/**
 * Say it on screen when this launch is about to become the machine's SECOND Ntwine.
 *
 * Falling past the join is right when nothing is running and wrong in every other case: two Ntwinees
 * means two schedulers, and one board's timers and recurring prompts firing twice. Until now the only
 * trace was `machine server address is held by a live ntwine …; leaving it` in a per-project log file,
 * printed by the child a full twenty seconds after the launcher had already committed — so what the
 * operator saw was a clean startup banner on a port they did not ask for.
 */
async function warnAboutStartingASecondNtwine(): Promise<void> {
  for (const port of joinCandidatePorts()) {
    if (await canBindPort(port)) continue;
    const detail = `port ${port} is in use but did not answer for ${workspace.root}; starting a SECOND Ntwine`;
    logger.warn("launcher", detail);
    console.warn(`warning: ${detail}`);
    return;
  }
}

let cachedSlugPath: string | undefined;
/**
 * Where to land — upstream's answer again (upstream commit 0a3b9139, src/index.ts slugPath), since a
 * project's board became the default view on 2026-10-06:
 *
 *   - run in a project: THAT PROJECT'S BOARD, `/project/<slug>`;
 *   - run in a repository Ntwine has not seen (`offer`): the add-project dialog asking about it, `/?add=<dir>`, over
 *     whichever view this browser was on last (web routes.tsx LastViewRedirect);
 *   - run anywhere else (`everything`, $HOME included): All projects, `/all` — upstream's dashboard at `/`;
 *   - no intent (a supervisor child, an update re-exec): `/`, the browser's own last view.
 *
 * From 2026-09-30 until then every launch landed on All projects at a bare `/` (maintainer: "by default
 * ntwine should open the all projects view").
 *
 * `?add=` is a REQUEST, not a registration — nothing on disk changes until the operator confirms on
 * the page, which is the only reason an unmarked directory is safe to point the launcher at at all.
 */
function slugPath(): string {
  if (cachedSlugPath === undefined) cachedSlugPath = landingPath();
  return cachedSlugPath;
}

function landingPath(): string {
  if (launchIntent?.kind === "offer") return `/?add=${encodeURIComponent(launchIntent.directory)}`;
  if (launchIntent?.kind === "everything") return "/all";
  if (launchIntent?.kind !== "open") return "/";
  // The registry is an index: a launch it cannot record still opens, on the browser's own last view.
  const slug = ownSlug();
  return slug ? `/project/${encodeURIComponent(slug)}` : "/";
}

/**
 * Record in the machine's registry that `ntwine` was just run in THIS project, cold or joining. The launch
 * itself lands on this project's board (slugPath), but the stamp outlives it: it is the board a bare `/`
 * opens in a browser with no view on record, and the project All projects' prompt box aims a new thread at
 * when this browser has neither picked nor focused one (web lib/crossProject.ts lastViewHref,
 * defaultCrossProjectFocus). Only an `open` launch is from a project: an `everything` or `offer`
 * launch is hosted on Ntwine's own stand-in folder (launcher.ts hostWorkspace), not where it was run.
 * Internal relaunches (a supervisor child, an update re-exec) carry no intent, so a restart never
 * re-stamps the host over a later launch elsewhere.
 */
function noteLaunchedHere(): void {
  if (launchIntent?.kind === "open") ownSlug(true);
}

async function openOrPrint(
  port: number,
  reused: boolean,
  path = ""
): Promise<void> {
  noteLaunchedHere();
  const url = `http://127.0.0.1:${port}${path}`;
  const home = homedir();
  logger.info("launcher", `${reused ? "reusing" : "started"} Ntwine at ${url} for ${workspace.root}`);
  if (reused) {
    // Nothing was built and nothing was started. Settle those steps for what they are, or a reuse
    // paints as a cold boot whose artifact and server rows simply never happened.
    readout?.settle("artifact", "skipped", "server already running");
    readout?.settle("server", "done", `already running on port ${port}`);
  }
  let browser: string | undefined;
  if (!options.noApp) {
    readout?.begin("browser", options.appMode ? "requesting app window" : "requesting default browser");
    try {
      if (options.appMode) {
        await launchApp(url, { dataPath: join(workspace.stateDir, "browser-profile") });
        browser = reused ? "focused the Ntwine app window" : "opened the Ntwine app window";
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
  const accessLink = publicOrigin && !reused ? activeAccessLink : null;
  const warnings: string[] = [];
  if (sandbox) warnings.push(`Sandbox: everything here is throwaway (${sandbox.home}) and is deleted when this terminal closes.`);
  if (sessionNotice && !reused) warnings.push(sessionNotice);
  if (!readout) {
    // `--status`, internal launches and pipes keep the plain, parseable records.
    console.log(`${reused ? "reusing" : "started"} Ntwine for ${workspace.root}`);
    console.log(`source: ${sourceLabel()}`);
    console.log(url);
    if (publicOrigin) console.log(accessLink?.url ?? `${publicOrigin}/`);
    for (const warning of warnings) console.log(warning);
    return;
  }
  readout.ready(
    [
      { label: "Local", value: boardAddress(url), accent: true },
      ...(publicOrigin ? [{ label: "Public", value: accessLink?.url ?? `${publicOrigin}/`, accent: true }] : []),
      ...(launchIntent && launchIntent.kind !== "open"
        ? []
        : [{ label: "Project", value: `${workspace.name} — ${tildePath(workspace.root, home)}` }]),
      { label: "Source", value: tildePath(sourceLabel(), home) },
      ...(logger.file ? [{ label: "Logs", value: tildePath(logger.file, home) }] : []),
    ],
    reused
      ? // Ctrl-C is the WRONG instruction here: this launch owns nothing and exits immediately, so
        // the server it just reopened would keep running either way.
        `reopened the server already running for this project · run ${sourceCommand} --stop to stop it`
      : options.debug
        ? undefined
        : publicOrigin
          ? `press L for a fresh sign-in link · R to change how this board is reached · ctrl-c to stop`
          : `press R to reach this board from a phone or another machine · ctrl-c to stop`,
    {
      ...(reused ? { status: `already running on port ${port}` } : {}),
      ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
      // Scannable, because the point of the link is to reach a phone and nobody types 40 characters
      // off a terminal. Only when there IS a link — a loopback board has nothing to scan.
      ...(accessLink ? { qr: renderQrLines(accessLink.url) } : {}),
    }
  );
}

// Why a stop is safe, said correctly. There is no multiplexer: a Claude thread's worker lives in a
// broker daemon and a Codex thread's in the app-server daemon, each forked `detached: true` into its
// own process group, so stopping the board never signals them and a turn in flight keeps running.
// This line used to claim tmux preserved them, which has been false since the runtime moved and had
// operators reaching for a pane that does not exist.
function stoppedMessage(): string {
  return `stopped Ntwine for ${workspace.root}; detached agent daemons were preserved`;
}

async function stopWorkspace(): Promise<void> {
  const target = launchTarget;
  const owner = readProjectLaunchOwner(workspace.stateDir);
  if (!owner) {
    console.log(`Ntwine is not running for ${workspace.root}`);
    return;
  }
  const status = liveWorkspaceOwner(workspace.stateDir, target);
  const healthy = status ? null : await existingHealth();
  const controlPort = status?.port ?? healthy?.port;
  const controlled = controlPort
    ? await requestNtwineStop(
        controlPort,
        expectedOwnerHealth(target, owner),
        owner.token
      )
    : false;
  // Never turn a process-generation observation into a later PID signal: the PID can be recycled in
  // that gap. Live shutdown requires the owner token over HTTP/IPC. Proven-stale owners are recovered
  // below while registered children self-exit on supervisor IPC disconnect.
  if (!controlled && !processGenerationIsStale(owner)) {
    throw new Error(
      "Ntwine refused to stop a live owner without authenticated token-bound control; the owner was left untouched"
    );
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!readProjectLaunchOwner(workspace.stateDir)) {
      console.log(stoppedMessage());
      return;
    }
    // A process can exit after accepting authenticated control but before its finally block removes
    // ownership. Reap through the same delegate-fencing protocol; never unlink the record directly.
    const reaped = tryAcquireProjectLaunchOwner(target, "launcher", {
      delegateDrainTimeoutMs: 250,
    });
    if (reaped.kind === "acquired") {
      reaped.lease.release();
      console.log(stoppedMessage());
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // The last poll can race a supervisor's finally block by a few milliseconds. Make one final
  // generation-safe observation before calling this a timeout: never signal a PID or unlink an
  // ownership record directly, and only reclaim through the same token/delegate protocol.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const lateOwner = readProjectLaunchOwner(workspace.stateDir);
  if (!lateOwner) {
    console.log(stoppedMessage());
    return;
  }
  if (processGenerationIsStale(lateOwner)) {
    const reaped = tryAcquireProjectLaunchOwner(target, "launcher", {
      delegateDrainTimeoutMs: 250,
    });
    if (reaped.kind === "acquired") {
      reaped.lease.release();
      console.log(stoppedMessage());
      return;
    }
  }
  throw new Error(`supervisor pid ${owner.pid} did not stop within 10s`);
}

try {
  if (options.stop) {
    await stopWorkspace();
    process.exit(0);
  }

  if (options.sessions || options.signOut !== undefined) {
  // Reads and writes the RUNNING board's session directory, so there is nothing useful to say when
  // no board is up — starting one here would create an empty directory and answer a different question.
  const running = liveWorkspaceOwner(workspace.stateDir, workspaceLaunchTarget(workspace));
  if (!running?.port) {
    console.error("ntwine: no board is running for this workspace");
    process.exit(1);
  }
  if (options.signOut !== undefined) await signOutSession(running.port, options.signOut);
  await listSessions(running.port);
}
if (options.link) {
    // Mint from the RUNNING board rather than starting one. This is the answer for a board running
    // detached or in someone else's terminal, where the interactive QR pane cannot install — without
    // it, "I need another code" means restarting the server, which is absurd.
    const running = liveWorkspaceOwner(workspace.stateDir, launchTarget);
    if (!running?.port) {
      console.error("ntwine: no board is running for this workspace");
      process.exit(1);
    }
    const response = await fetch(`http://127.0.0.1:${running.port}${SUPERVISOR_ACCESS_CODE_PATH}`, {
      method: "POST",
      headers: { origin: `http://127.0.0.1:${running.port}` },
    }).catch(() => undefined);
    if (!response?.ok) {
      const detail = response ? (await response.json().catch(() => undefined))?.error : undefined;
      console.error(`ntwine: ${detail ?? "could not mint an access link"}`);
      process.exit(1);
    }
    const { url } = (await response.json()) as { url: string };
    // The QR first: the whole point of a link is to reach a phone, and nobody types forty characters.
    // The window gets the glyph-free code when the terminal does not draw block elements itself and it
    // fits above the blank line, the URL and the prompt that follow it (see qr.ts).
    if (process.stdout.isTTY) for (const row of renderQrLines(url, { area: qrAreaOf(process.stdout, { indent: 2, rows: 3 }) })) console.log(`  ${row}`);
    console.log(process.stdout.isTTY ? `\n  ${url}` : url);
    process.exit(0);
  }

  let before = await existingHealth();


  if (command === "restart") {
    if (!before.port) throw new Error("Ntwine is not running for this workspace");
    const response = await fetch(
      `http://127.0.0.1:${before.port}/_ntwine/control/restart`,
      {
        method: "POST",
        headers: { origin: `http://127.0.0.1:${before.port}` },
      }
    );
    const result = (await response.json()) as {
      state?: string;
      message?: string;
    };
    if (!response.ok || result.state !== "ready")
      throw new Error(
        result.message ?? "Ntwine did not become ready after restart"
      );
    console.log(
      `restarted Ntwine artifact ${
        readStableArtifact(workspace.stateDir)?.digest ?? "unknown"
      }`
    );
    process.exit(0);
  }
  if (options.status) {
    if (before.health && before.port) {
      const needsAttention = supervisorNeedsAttention(before.owner);
      console.log(
        `${needsAttention ? "degraded" : "running"}: http://127.0.0.1:${
          before.port
        }`
      );
      console.log(`workspace: ${before.health.projectDir}`);
      console.log(`source: ${sourceLabel()}`);
      if (before.owner?.artifactDigest)
        console.log(`artifact: ${before.owner.artifactDigest}`);
      console.log(`supervisor pid: ${before.owner?.pid ?? "unknown"}`);
      if (needsAttention) {
        console.log(
          `detail: ${
            before.owner?.message ?? `supervisor is ${before.owner?.state}`
          }`
        );
        process.exitCode = 1;
      }
    } else if (before.owner) {
      console.log(
        `broken: supervisor pid ${before.owner.pid} is ${
          before.owner.state ?? "alive"
        } but port ${before.owner.port} is unhealthy`
      );
      if (before.owner.message) console.log(`detail: ${before.owner.message}`);
      process.exitCode = 1;
    } else if (before.launchOwner) {
      console.log(
        `broken: ${before.launchOwner.role} pid ${before.launchOwner.pid} owns launch in ${before.launchOwner.state} state without a healthy control plane`
      );
      if (before.launchOwner.delegates.length > 0) {
        console.log(
          `detail: waiting for ${before.launchOwner.delegates.length} delegated control plane(s) to drain`
        );
      }
      process.exitCode = 1;
    } else {
      // Under one server per machine, "this project has no server of its own" and "this project is
      // not being served" stopped being the same statement. A project that joined holds no launch
      // lease and never writes a server.lock, so every check above misses it and the honest answer
      // is the one the join path already knows how to get.
      const joined = await joinRunningNtwine();
      if (joined) {
        console.log(`running: http://127.0.0.1:${joined.port}/project/${encodeURIComponent(joined.slug)}`);
        console.log(`workspace: ${workspace.root}`);
        console.log(`served by the ntwine running on this machine, which this project did not start`);
      } else console.log(`stopped: ${workspace.root}`);
    }
    process.exit();
  }
  if (before.health && before.port) {
    await openOrPrint(before.port, true, slugPath());
    process.exit(0);
  }
  {
    const joined = await joinRunningNtwine();
    if (joined) {
      // slugPath(), not the joined slug: the slug names the project this launch is HOSTED on, which
      // is only the project to open when the intent is `open`. An `everything`/`offer` launch joins a server
      // hosted on some other project and must still land on `/all` or `/?add=` — hard-coding the host's board here
      // is what made `ntwine-dev` in an unadopted directory open somebody else's board outright.
      await openOrPrint(joined.port, true, slugPath());
      process.exit(0);
    }
    await warnAboutStartingASecondNtwine();
  }
  if (before.owner && !readProjectLaunchOwner(workspace.stateDir)) {
    const owner = before.owner;
    // Upgrade compatibility: an old supervisor has atomic-ish status but predates tokenized ownership.
    // Never start over it; allow its current child handoff to finish, then fail closed if still unhealthy.
    try {
      await waitForWorkspace(owner.port, expectedHealth, 5_000);
      before = await existingHealth();
    } catch {}
    if (before.health && before.port) {
      await openOrPrint(before.port, true, slugPath());
      process.exit(0);
    }
    throw new Error(
      `supervisor pid ${
        owner.pid
      } is alive but its control plane is unhealthy (${
        owner.state ?? "unknown"
      }: ${
        owner.message ?? "no detail"
      }); fix the source or run ntwine-dev --stop`
    );
  }

  const projectClaim = await claimProjectLaunch();
  if ("reusePort" in projectClaim) {
    await openOrPrint(projectClaim.reusePort, true, slugPath());
    process.exit(0);
  }
  const launchOwner = projectClaim;
  const target = workspaceLaunchTarget(workspace);
  // Another Ntwine under this home already has this project open as one of its many — the installed
  // one, whose dev port this launch does not probe. Its server would refuse to boot on it anyway; say
  // so now, naming that server, rather than after a build and a boot. Checked once the launch lease is
  // ours: an ntwine-dev of this project that is still starting has had its chance to be reused above.
  const servedBy = servingRecordElsewhere(workspace.stateDir, target.projectId);
  if (servedBy !== undefined) {
    launchOwner.release();
    throw new ProjectServedElsewhereError(workspace.name, servedBy);
  }
  // This preparation is local to the project. Keep it outside the machine-global port/start lock
  // so independent repositories can perform cold source/artifact work concurrently.
  let pinnedArtifact: ReturnType<typeof ensureStableNtwineArtifact> | undefined;
  let release: (() => void) | undefined;
  let portReservation: (() => void) | undefined;
  try {
    const sequenced = await prepareBeforeGlobalLaunchLock(
      () => {
        logger.info("launcher", "checking launch prerequisites");
        assertLaunchPrerequisites();
        // The verified digest is passed to the foreground supervisor generation so a source mutation
        // after this point cannot alter its first child.
        return options.dev
          ? undefined
          : (() => {
              readout?.begin("artifact", "checking for a verified build");
              const artifact = ensureStableNtwineArtifact(
                workspace.stateDir,
                sourceWorkspaceDir(),
                defaultArtifactRoot(),
                {
                  onProgress: (message) => {
                    logger.info("artifact", message);
                    readout?.detail("artifact", message.toLowerCase());
                  },
                }
              );
              assertArtifactHostCompatible(artifact);
              readout?.settle("artifact", "done", artifact.digest.slice(0, 12));
              return artifact;
            })();
      },
      () => {
        readout?.begin("server", "waiting for the machine-wide startup lock");
        logger.info("launcher", "waiting for the machine-wide startup lock");
        // This lock protects only machine-shared port allocation and initial supervisor startup.
        // Artifact publication handles same-digest winners independently of this critical section.
        return acquireGlobalLaunchLock(
          undefined,
          FIRST_ARTIFACT_LAUNCH_LOCK_TIMEOUT_MS
        );
      }
    );
    pinnedArtifact = sequenced.prepared;
    release = sequenced.release;
  } catch (error) {
    launchOwner.release();
    throw error;
  }
  try {
    // Another invocation may have completed while this one waited for the allocator lock.
    const after = await existingHealth();
    if (after.health && after.port) {
      await openOrPrint(after.port, true, slugPath());
      release();
      release = undefined;
      launchOwner.release();
      process.exit(0);
    }
    if (after.owner)
      throw new Error(
        `supervisor pid ${after.owner.pid} became unhealthy during launch; run ntwine-dev --status`
      );

    const allocation = await allocatePort(
      options.port,
      readPreferredPort(workspace.stateDir),
      { host: LOOPBACK_BIND_HOST, base: DEFAULT_DEV_PORT }
    );
    const port = allocation.port;
    portReservation = allocation.release;
    const ownedHealth = expectedOwnerHealth(
      target,
      readProjectLaunchOwner(workspace.stateDir)
    );
    readout?.begin("server", `starting on port ${port}`);
    logger.info("launcher", `starting the control plane on port ${port}`);
    const running = runSupervisor(port, launchOwner.token, pinnedArtifact?.digest);
    // Allocation is the only machine-shared step, so the machine-global lock ends HERE — the port
    // reservation above, not this lock, is what keeps `port` ours until the child listens on it.
    // Holding the lock across the health wait below is what made three repositories launched in quick
    // succession fail: that wait is progress-tracked, so one cold boot can legitimately hold on for
    // minutes (up to LAUNCH_HARD_TIMEOUT_MS) while every other repository's launcher gives up on the
    // lock after its own much shorter budget.
    release();
    release = undefined;
    // The forked control-plane child no longer writes to this TTY (its records go to the run log, and
    // to the terminal only under --debug), so the readout keeps repainting through the health wait
    // instead of standing down the moment the child starts talking.
    readout?.detail("server", "waiting for health");
    // Progress-tracked (see waitForWorkspace): the flat deadline made a slow-but-healthy boot — a big
    // board, or a busy machine — indistinguishable from a wedge. `running` still wins the race the
    // moment the in-process supervisor itself fails, so a real failure is reported immediately.
    await Promise.race([
      waitForWorkspace(port, ownedHealth, undefined, { stateDir: workspace.stateDir }),
      running,
    ]);
    // The child is listening now, so the port defends itself and the reservation has done its job. It
    // must NOT span the foreground server lifetime, or a stopped-but-unreleased claim would push the
    // next launch of this repository off its remembered port.
    portReservation();
    portReservation = undefined;
    // Settle the server step BEFORE handing off to the browser. Leaving it to `ready()` meant the
    // browser row showed a ✓ while the server row above it was still spinning — a later step
    // finishing before an earlier one, which reads as the display being wrong.
    readout?.settle("server", "done", `port ${port}`);
    // A COLD launch lands on this project's board too. This call passed no path from before boards had
    // slugs at all, so `/` — the project grid — was where the one command that definitely knows which
    // project you meant dropped you, every time it was the first to start the server.
    await openOrPrint(port, false, slugPath());
    // The normal launcher intentionally remains attached. Its SIGINT/SIGTERM handler is installed
    // by runSupervisor and stops only this workspace's UI control plane.
    await running;
  } finally {
    release?.();
    portReservation?.();
    launchOwner.release();
  }
} catch (error) {
  logger.error(
    "launcher",
    `startup failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`
  );
  if (readout) {
    const where = readout.activeStep();
    readout.fail(
      `${where ? `${where.label.toLowerCase()}: ` : ""}${
        error instanceof Error ? error.message : String(error)
      }`,
      logger.file ?? undefined
    );
    process.exit(1);
  }
  fail(error);
}
