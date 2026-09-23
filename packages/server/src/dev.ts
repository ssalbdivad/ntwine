// Dev entry: a durable source watcher supervising a disposable API + Vite control-plane child.
// Run with `nub packages/server/src/dev.ts` from ui/. Worker daemons remain independent.
import { DEFAULT_PORT } from "@frizz/shared"
import { projectFromLaunchTarget, projectLaunchTarget, resolveProject } from "./project.ts"
import {
  acquireProjectLaunchOwner,
  adoptProjectLaunchOwner,
  projectLaunchEnvironment,
  projectLaunchOwnerTokenFromEnvironment,
  projectLaunchTargetFromEnvironment,
  verifyProjectLaunchDelegate,
} from "./project-launch.ts"

if (process.env.FRIZZ_DEV_CHILD === "1") {
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
  const target = projectLaunchTarget(project)
  const launchOwner = inheritedToken
    ? adoptProjectLaunchOwner(target, inheritedToken, "supervisor")
    : acquireProjectLaunchOwner(target, "supervisor")
  const launchEnv = projectLaunchEnvironment(process.env, target, launchOwner.token)
  const { createSupervisorShutdownHandler, startDevSupervisor } = await import("./dev-supervisor.ts")

  let supervisor: Awaited<ReturnType<typeof startDevSupervisor>>
  let boot: Awaited<typeof supervisor.firstBoot>
  try {
    supervisor = await startDevSupervisor({
      port: DEFAULT_PORT,
      cwd: project.dir,
      env: launchEnv,
      stateDir: project.stateDir,
      launchTarget: target,
      launchOwnerToken: launchOwner.token,
      childEntry: process.argv[1],
      // `pnpm dev` — source checkout, never the published bin. See RestartSupervisorProxy's `dev`.
      dev: true,
      // This entry paints no readout, so a beat prints as a plain line. Without it a restart asked
      // for from a browser tab cycles the board while the terminal that owns it says nothing.
      onActivity: (event) =>
        console.log(
          event.kind === "ready" && event.ms !== undefined
            ? `[frizz] restarted in ${Math.round(event.ms)}ms`
            : `[frizz] ${event.kind}: ${event.message}`,
        ),
    })
    boot = await supervisor.firstBoot
  } catch (error) {
    launchOwner.release()
    throw error
  }
  // Say where the board is once it answers. Without this line the last thing in the terminal was
  // Vite's "bundling dependencies…", so a server that had been ready for minutes looked hung.
  console.log(`[frizz] ready at http://127.0.0.1:${boot.port}/`)

  const stop = createSupervisorShutdownHandler({
    close: () => supervisor.close(),
    force: () => supervisor.forceStop(),
    release: () => { launchOwner.release() },
    onStop: () => console.log("[frizz] stopping: draining the control plane — press ctrl-c again to force"),
    exit: (code) => process.exit(code),
    error: (line) => console.error(line),
  })
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  void supervisor.stopRequested.then(stop)
}
