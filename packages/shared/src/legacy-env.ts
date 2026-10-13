// THE RENAME'S ENVIRONMENT: this product was Frizz until 2026-10-13, and a process started by that code
// — the durable dev supervisor, a broker daemon, a worker and the shells it opened — keeps handing out
// FRIZZ_* variables until it restarts. Imported FIRST by every entry point, before anything reads the
// environment, so each one is read under its NTWINE_* name. An NTWINE_* value already set always wins.
// cc-worker/lib/legacy-env.mjs is the dependency-free twin for the worker scripts; keep them agreeing.
export function adoptFrizzEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("FRIZZ_") || value === undefined) continue
    const renamed = `NTWINE_${key.slice("FRIZZ_".length)}`
    if (env[renamed] === undefined) env[renamed] = value
  }
}

adoptFrizzEnv()
