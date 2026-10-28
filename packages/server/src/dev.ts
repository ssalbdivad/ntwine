// Dev entry: a durable source watcher supervising a disposable API + Vite control-plane child.
// `pnpm run dev` runs it through src/dev.ts, which attaches remote access (the transport lives in the
// launcher package, which this one cannot import); run directly, it is the same board without it.
// Worker daemons remain independent.
import { fileURLToPath } from "node:url"
import { DEFAULT_PORT } from "@ntwine/shared"
import { fileSessionDirectory, loadOrCreateSessionKey } from "./access-codes.ts"
import type { DevSupervisor } from "./dev-supervisor.ts"
import { logEnvironment, openRunLogger } from "./logging.ts"
import { projectFromLaunchTarget, projectLaunchTarget, resolveProject } from "./project.ts"
import {
  acquireProjectLaunchOwner,
  adoptProjectLaunchOwner,
  projectLaunchEnvironment,
  projectLaunchOwnerTokenFromEnvironment,
  projectLaunchTargetFromEnvironment,
  verifyProjectLaunchDelegate,
} from "./project-launch.ts"

/** What a caller hangs on the running board — src/dev.ts's remote access. */
export interface DevAttachment {
  /** A sign-in code was redeemed. */
  onCodeConsumed?(): void
  /** Shutdown: restore the shell, stop any transport. */
  dispose(): void
}

export interface RunDevOptions {
  /** The board's public port. Default DEFAULT_PORT; another one runs a second board beside it. */
  port?: number
  /** Called once the board answers, with the supervisor that owns its public port. */
  attach?: (context: { supervisor: DevSupervisor; port: number; logger: ReturnType<typeof openRunLogger> }) => Promise<DevAttachment>
}

export async function runDev(options: RunDevOptions = {}): Promise<void> {
  if (process.env.NTWINE_DEV_CHILD === "1") {
    const childTarget = projectLaunchTargetFromEnvironment(process.env)
    const childToken = projectLaunchOwnerTokenFromEnvironment(process.env)
    if (!childTarget || !childToken) throw new Error("dev child is missing pinned project launch ownership")
    verifyProjectLaunchDelegate(childTarget, childToken)
    const { runDevControlPlaneChild } = await import("./dev-supervisor.ts")
    await runDevControlPlaneChild()
  } else {
    const inheritedTarget = projectLaunchTargetFromEnvironment(process.env)
    const inheritedToken = projectLaunchOwnerTokenFromEnvironment(process.env)
    const project = inheritedTarget && inheritedToken ? projectFromLaunchTarget(inheritedTarget) : resolveProject()
    // The run log, opened as soon as the project (and so its state dir) is known. This entry used to
    // install no logger at all, so every supervisor and control-plane record went nowhere — the child
    // adopts the file through NTWINE_LOG_FILE in launchEnv, the same mechanism the launchers use
    // (logging.ts `openRunLogger`).
    const debug = process.env.NTWINE_DEBUG === "1"
    const logger = openRunLogger(project.stateDir, { debug })
    const target = projectLaunchTarget(project)
    let launchOwner: ReturnType<typeof acquireProjectLaunchOwner>
    try {
      launchOwner = inheritedToken
        ? adoptProjectLaunchOwner(target, inheritedToken, "supervisor")
        : acquireProjectLaunchOwner(target, "supervisor")
    } catch (error) {
      logger.error("launcher", `could not take the project launch lock: ${error instanceof Error ? error.message : error}`)
      throw error
    }
    const launchEnv = {
      ...projectLaunchEnvironment(process.env, target, launchOwner.token),
      ...logEnvironment(logger, debug ? "debug" : "info"),
    }
    logger.info("launcher", `dev supervisor starting for ${project.dir}`)
    const { createSupervisorShutdownHandler, startDevSupervisor } = await import("./dev-supervisor.ts")

    let supervisor: Awaited<ReturnType<typeof startDevSupervisor>>
    let attachment: DevAttachment | undefined
    let boot: Awaited<typeof supervisor.firstBoot>
    try {
      supervisor = await startDevSupervisor({
        port: options.port ?? DEFAULT_PORT,
        cwd: project.dir,
        env: launchEnv,
        stateDir: project.stateDir,
        launchTarget: target,
        launchOwnerToken: launchOwner.token,
        // THIS file, whatever the caller's entry: the child boots only the control plane, so it never
        // needs (or loads) what a caller attaches to the supervisor.
        childEntry: fileURLToPath(import.meta.url),
        // Persisted beside the project's state, as the launchers do, so a restart of this terminal does
        // not sign every phone out.
        sessionKey: loadOrCreateSessionKey(project.stateDir),
        sessionDirectory: fileSessionDirectory(project.stateDir),
        onCodeConsumed: () => attachment?.onCodeConsumed?.(),
        // `pnpm dev` — source checkout, never the published bin. See RestartSupervisorProxy's `dev`.
        dev: true,
        // This entry paints no readout, so a beat prints as a plain line. Without it a restart asked
        // for from a browser tab cycles the board while the terminal that owns it says nothing.
        onActivity: (event) =>
          console.log(
            event.kind === "ready" && event.ms !== undefined
              ? `[ntwine] restarted in ${Math.round(event.ms)}ms`
              : `[ntwine] ${event.kind}: ${event.message}`,
          ),
      })
      boot = await supervisor.firstBoot
    } catch (error) {
      logger.error("launcher", `startup failed: ${error instanceof Error ? error.stack ?? error.message : error}`)
      launchOwner.release()
      throw error
    }
    // Say where the board is once it answers. Without this line the last thing in the terminal was
    // Vite's "bundling dependencies…", so a server that had been ready for minutes looked hung. The log
    // path rides along because this terminal shows almost nothing else; the file has the whole feed.
    console.log(`[ntwine] ready at http://127.0.0.1:${boot.port}/${logger.file ? ` — log: ${logger.file}` : ""}`)
    attachment = await options.attach?.({ supervisor, port: supervisor.port, logger })

    const stop = createSupervisorShutdownHandler({
      close: () => supervisor.close(),
      force: () => supervisor.forceStop(),
      release: () => { launchOwner.release() },
      onStop: () => console.log("[ntwine] stopping: draining the control plane — press ctrl-c again to force"),
      exit: (code) => {
        attachment?.dispose()
        process.exit(code)
      },
      error: (line) => console.error(line),
    })
    process.on("SIGINT", stop)
    process.on("SIGTERM", stop)
    void supervisor.stopRequested.then(stop)
  }
}

// Run directly — the control-plane child always is, and `node packages/server/src/dev.ts` still works.
if (import.meta.main) await runDev()
