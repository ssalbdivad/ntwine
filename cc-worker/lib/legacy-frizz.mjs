// LEGACY — the worker scripts' half of packages/shared/src/legacy-frizz.ts, dependency-free (see that
// header for why it is still here, and for the gate and runbook that remove it). A worker started before
// the Frizz -> Ntwine rename runs these scripts with FRIZZ_* in its environment, and calls `frizzctl`.
// Imported FIRST.
const LEGACY_ENV_PREFIX = 'FRIZZ_';

/** `ntwinectl`'s name in the contract of a worker started before the rename (bin/frizzctl). */
export const LEGACY_CTL_NAME = 'frizzctl';

export function adoptLegacyEnv(env = process.env) {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(LEGACY_ENV_PREFIX) || value === undefined) continue;
    const renamed = `NTWINE_${key.slice(LEGACY_ENV_PREFIX.length)}`;
    if (env[renamed] === undefined) env[renamed] = value;
    delete env[key]; // moved, not copied — see legacy-frizz.ts
  }
}

adoptLegacyEnv();
