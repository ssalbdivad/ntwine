import { rmSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"
import type { AppContext } from "./context.ts"
import { projectStateDir } from "./ntwine-paths.ts"
import { log as ntwineLog } from "./logging.ts"
import { stopThreadRuntime } from "./router.ts"

// TAKING A PROJECT APART — the two destructive halves of `projectRemove` that are not the registry.
//
// The registry half is one line (`forgetProject`) against a machine-level index file. These two are
// the ones with teeth: a project's WORKERS, which do not stop when its tenant does, and its STATE
// DIRECTORY, which holds every thread it has ever had.
//
// Both are called from index.ts, behind `AppContext.teardownProject`, and not from the router — which
// is what keeps this out of an import cycle with router.ts, whose `stopThreadRuntime` is the stop
// every one of these reduces to.

/**
 * Kill every live worker daemon in one project.
 *
 * An Ntwine worker is a DETACHED daemon in its own process group — that is the whole point, and it is
 * why Ctrl-C on the server leaves a running turn alone. Deactivating a tenant therefore stops the
 * board, the tailer and the scheduler and touches no worker at all, which is exactly right for a
 * shutdown and exactly wrong for a delete: the daemon keeps running against a state directory that
 * is about to be unlinked, writes into files nobody can see, and can no longer be stopped from the UI
 * because the board it belonged to is gone.
 *
 * Per-row and forgiving, for the same reason `deleteExpiredDoneThreads` is (router.ts): a broker that will not answer for one
 * session must not strand the twenty after it. Returns how many were actually alive to stop, which is
 * what the operator is told.
 */
export async function stopProjectWorkers(ctx: AppContext): Promise<number> {
  let stopped = 0
  for (const row of ctx.storage.allSessions()) {
    try {
      // The default terminator is the right one here — this is the same stop the Dismiss button
      // performs, session by session.
      if (await stopThreadRuntime(row, undefined, ctx.codexAppServer, ctx.claudeBroker) === "stopped") {
        stopped++
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      ntwineLog.warn("project-teardown", `${ctx.project.name}: ${row.slug} did not stop cleanly: ${detail}`)
    }
  }
  return stopped
}

/**
 * Delete everything Ntwine holds ON DISK for one project: `~/.ntwine/projects/<id>/`.
 *
 * ONE DIRECTORY IS THE FILES — attachments, logs, permission markers, the broker's and app-server's
 * sockets and records, and the pre-unification `ui.db` if the project predates the unified
 * database (left in place for an older build to find — see ntwine-db.ts). The project's ROWS live in that database (ntwine-db.ts) and are purged by the caller
 * through `purgeProject`, before this runs; the registry index is forgotten separately too.
 *
 * THE PROJECT'S OWN FOLDER IS NEVER TOUCHED. Deleting a project deletes Ntwine's record of it, not the
 * operator's code; `.ntwine/.id` is left in the tree, so adding the folder back keeps the same id and
 * simply starts a fresh board under it.
 *
 * The id is spliced into a path, so it is checked rather than trusted: a caller passing `..`, a slash,
 * or an empty string would otherwise aim `rm -rf` at the projects root, or at `~/.ntwine` itself.
 */
export function deleteProjectState(projectId: string, home = homedir()): void {
  const target = projectStateDir(projectId, home)
  if (!/^[\w.-]+$/u.test(projectId) || projectId === "." || projectId === "..") {
    throw new Error(`Refusing to delete state for a malformed project id: ${projectId}`)
  }
  // Belt and braces: the resolved path must still be a direct child of the projects root it came from.
  if (dirname(resolve(target)) !== resolve(dirname(projectStateDir("x", home)))) {
    throw new Error(`Refusing to delete ${target} — it is not a project state directory`)
  }
  rmSync(target, { recursive: true, force: true })
}
