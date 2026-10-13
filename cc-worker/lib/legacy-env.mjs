// LEGACY — the dependency-free twin of packages/shared/src/legacy-env.ts (see its header for why, and for
// the removal condition, which is the same): a worker started before the Frizz -> Ntwine rename runs these
// scripts with FRIZZ_* in its environment. Imported FIRST.
const LEGACY_ENV_PREFIX = 'FRIZZ_';

export function adoptLegacyEnv(env = process.env) {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(LEGACY_ENV_PREFIX) || value === undefined) continue;
    const renamed = `NTWINE_${key.slice(LEGACY_ENV_PREFIX.length)}`;
    if (env[renamed] === undefined) env[renamed] = value;
    delete env[key]; // moved, not copied — see legacy-env.ts
  }
}

adoptLegacyEnv();
