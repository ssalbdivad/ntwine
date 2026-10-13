// LEGACY — THE RENAME'S ENVIRONMENT. This product was Frizz until 2026-10-13, and a process started by that
// code keeps handing out FRIZZ_* variables until it exits: the durable dev supervisor forks every server
// child with them, and a worker it started runs today's hook scripts with them. Imported FIRST by every
// entry point, before anything reads the environment, so each one is read under its NTWINE_* name. An
// NTWINE_* value already set always wins. cc-worker/lib/legacy-env.mjs is the dependency-free twin for the
// worker scripts; keep them agreeing.
//
// REMOVE (this file, its twin, and every import of either) once no process started before the rename
// (67962b73, 2026-10-13 12:32 EDT) is alive, nor any child it forked:
// `grep -las '^FRIZZ_' /proc/[0-9]*/environ` finds none of the children, and no `nub src/dev.ts` that old runs.
export const LEGACY_ENV_PREFIX = "FRIZZ_"

/** The FRIZZ_* names this process was started with, before they moved. frizz-migration.ts reads them. */
export const adoptedLegacyEnv = new Set<string>()

export function adoptLegacyEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(LEGACY_ENV_PREFIX) || value === undefined) continue
    if (env === process.env) adoptedLegacyEnv.add(key)
    const renamed = `NTWINE_${key.slice(LEGACY_ENV_PREFIX.length)}`
    if (env[renamed] === undefined) env[renamed] = value
    // Moved, not copied: code that later deletes the NTWINE_* name must not see it come back from here.
    delete env[key]
  }
}

adoptLegacyEnv()
