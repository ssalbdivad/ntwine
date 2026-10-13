import { existsSync } from 'node:fs';
import { join } from 'node:path';

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

/**
 * The board directory's name in `projectDir`: `.ntwine`, unless the project still has only the `.frizz`
 * it had before the rename. The server moves that board on its first look (project-root.ts
 * adoptFrizzBoard) and leaves `.frizz` linked to it, so a `.frizz` path stays right either way, while a
 * fresh `.ntwine` created here first would split the board in two.
 */
export function boardDirName(projectDir) {
  return existsSync(join(projectDir, '.ntwine')) || !existsSync(join(projectDir, '.frizz')) ? '.ntwine' : '.frizz';
}
