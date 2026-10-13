// The dependency-free twin of packages/shared/src/legacy-env.ts (see its header): a worker started
// before the Frizz -> Ntwine rename runs these scripts with FRIZZ_* in its environment. Imported FIRST.
export function adoptFrizzEnv(env = process.env) {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('FRIZZ_') || value === undefined) continue;
    const renamed = `NTWINE_${key.slice('FRIZZ_'.length)}`;
    if (env[renamed] === undefined) env[renamed] = value;
  }
}

adoptFrizzEnv();
