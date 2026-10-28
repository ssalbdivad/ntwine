import { spawn, type ChildProcess } from "node:child_process";
import { promoteCurrentSourceArtifact } from "./artifacts.ts";

/**
 * Update & Restart's artifact build, run in its OWN process.
 *
 * The build is a chain of `execFileSync` calls (typecheck, the web build, the runtime bundle) plus
 * synchronous copying and hashing, and it takes minutes — 623s for a cold sandbox on 2026-10-01. It
 * used to run inline in the supervisor, which is the process that owns the public listener and the
 * signal handlers, so for the whole build:
 *
 * - the board stopped answering: the supervisor's proxy could not forward a single request, though
 *   the readout promised "the running ntwine is untouched until it is ready";
 * - SIGINT/SIGTERM/SIGHUP queued unhandled. A worker's `TaskStop` on a sandbox mid-update sat for
 *   6m24s, and Ctrl-C in the terminal did nothing until the build finished.
 *
 * So the supervisor re-runs its own entry with ARTIFACT_BUILD_JOB_ENV set, and that entry hands off
 * to runArtifactBuildJob before it parses an argument or touches a project. Re-running the entry
 * rather than adding one keeps a single file valid in both shapes the launcher runs in: source under
 * node (which strips the types itself, so the child needs no loader) and the bundled artifact, where
 * there is no separate module to point at — see DETACHED_DAEMON_ENTRIES for why that list stays short.
 */
export const ARTIFACT_BUILD_JOB_ENV = "NTWINE_ARTIFACT_BUILD_JOB";

const RESULT_PREFIX = "ntwine-artifact-build-result ";
const PROGRESS_PREFIX = "ntwine-artifact-build-progress ";

interface ArtifactBuildJob {
  stateDir: string;
  sourceDir: string;
  root: string;
}

type ArtifactBuildResult =
  | { ok: true; candidate: string; previous?: string }
  | { ok: false; message: string };

/**
 * The child half. Returns false when this process is not a build job, so the caller carries on as the
 * launcher; otherwise builds, promotes, reports one result line on stdout and exits.
 */
export function runArtifactBuildJob(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[ARTIFACT_BUILD_JOB_ENV];
  if (!raw) return false;
  // The build's own subprocesses (pnpm typecheck, vite, esbuild) inherit the environment; none of them
  // is this entry, but nothing downstream should ever see the marker either.
  delete env[ARTIFACT_BUILD_JOB_ENV];
  let result: ArtifactBuildResult;
  try {
    const job = JSON.parse(raw) as ArtifactBuildJob;
    const { candidate, previous } = promoteCurrentSourceArtifact(job.stateDir, job.sourceDir, job.root, {
      onProgress: (message) => process.stdout.write(`${PROGRESS_PREFIX}${message}\n`),
    });
    result = { ok: true, candidate: candidate.digest, ...(previous ? { previous: previous.digest } : {}) };
  } catch (error) {
    result = { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`, () => process.exit(result.ok ? 0 : 1));
  return true;
}

export interface SpawnArtifactBuildOptions extends ArtifactBuildJob {
  /** The launcher entry to re-run; defaults to this process's own. */
  entry?: string;
  execArgv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  onProgress?: (message: string) => void;
}

export interface ArtifactBuildHandle {
  result: Promise<{ candidate: string; previous?: string }>;
  /** Kill the build and everything it started. Safe to call more than once, or after it finished. */
  cancel(): void;
}

/**
 * The parent half: build and promote the checkout's current source WITHOUT blocking this event loop.
 * Resolves with the promoted digest and the one it replaced (the rollback slot); rejects with the
 * build's own error message.
 */
export function spawnArtifactBuild(options: SpawnArtifactBuildOptions): ArtifactBuildHandle {
  const job: ArtifactBuildJob = { stateDir: options.stateDir, sourceDir: options.sourceDir, root: options.root };
  const child: ChildProcess = spawn(
    process.execPath,
    [...(options.execArgv ?? process.execArgv), options.entry ?? process.argv[1]!],
    {
      env: { ...(options.env ?? process.env), [ARTIFACT_BUILD_JOB_ENV]: JSON.stringify(job) },
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so cancel() reaches the pnpm/tsc/vite/esbuild grandchildren too, not only
      // the job process. Windows has no groups; there the job's own exit has to do.
      detached: process.platform !== "win32",
    }
  );
  let settled = false;
  const signalGroup = (signal: NodeJS.Signals) => {
    if (settled || child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
    try {
      if (process.platform === "win32") child.kill();
      else process.kill(-child.pid, signal);
    } catch {
      // Already gone.
    }
  };
  // SIGTERM first, never a bare SIGKILL: a script runner that puts each script in a process group of
  // its own (nub did, until 2026-10-28) leaves `tsc` and vite OUTSIDE the job's group, and the only way
  // to reach them is the runner forwarding the signal — which SIGKILL never gives it a chance to do. Measured on a real sandbox: a group
  // SIGKILL left `tsc -b` running after the launcher had exited.
  const cancel = () => {
    signalGroup("SIGTERM");
    setTimeout(() => signalGroup("SIGKILL"), 5_000).unref();
  };
  // A launcher that exits mid-build (a stop signal, the drain finishing) must not leave a detached
  // build behind writing into the artifact cache. Only the SIGTERM can be sent from `exit`; a
  // runner forwards it and the job's own default action is to die.
  const onExit = () => signalGroup("SIGTERM");
  process.once("exit", onExit);
  const result = new Promise<{ candidate: string; previous?: string }>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let outcome: ArtifactBuildResult | undefined;
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      stdout += chunk;
      let newline: number;
      while ((newline = stdout.indexOf("\n")) !== -1) {
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (line.startsWith(PROGRESS_PREFIX)) options.onProgress?.(line.slice(PROGRESS_PREFIX.length));
        else if (line.startsWith(RESULT_PREFIX)) {
          try {
            outcome = JSON.parse(line.slice(RESULT_PREFIX.length)) as ArtifactBuildResult;
          } catch {
            // Reported below as a missing result.
          }
        }
      }
    });
    // Bounded: only the tail is worth showing when the job dies before it can report.
    child.stderr!.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4_000);
    });
    child.once("error", (error) => {
      settled = true;
      process.removeListener("exit", onExit);
      reject(error);
    });
    child.once("close", (code, signal) => {
      settled = true;
      process.removeListener("exit", onExit);
      if (outcome?.ok) resolve({ candidate: outcome.candidate, ...(outcome.previous ? { previous: outcome.previous } : {}) });
      else if (outcome) reject(new Error(outcome.message));
      else
        reject(
          new Error(
            `the artifact build exited ${signal ? `on ${signal}` : `with code ${code}`} without a result${
              stderr.trim() ? `\n${stderr.trim()}` : ""
            }`
          )
        );
    });
  });
  return { result, cancel };
}
