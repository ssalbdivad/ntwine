import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// The ntwine-worker plugin (single-thread worker contract + hooks + the worker-facing bin/ scripts), a
// sibling of board/ in the ntwine source tree. Deployed artifacts carry it at runtime/cc-worker, but
// pnpm may load this module through a nested store rather than the flat node_modules layout. Search
// module ancestors so the closure remains discoverable in either layout; an explicitly verified
// artifact path wins.
//
// This lives in its own leaf module (node builtins only) rather than in dispatch.ts, where it was born
// and from which it is still re-exported. The cycle that split it out is gone: backend/types.ts needed
// it to resolve `bin/browser-mcp.mjs` for the always-mounted browser, and dispatch.ts imports
// backend/types.ts. The browser mount was removed 2026-08-26 and dispatch.ts is now the only importer,
// so the leaf could fold back — it stays because the split costs nothing and every caller reaches for
// the dispatch.ts re-export. The ancestor walk is unaffected either way: this file sits in the same
// directory dispatch.ts does, so the default `import.meta.url` starts from the same place.
export function resolveWorkerPluginDir(
  moduleUrl = import.meta.url,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const override = env.NTWINE_WORKER_PLUGIN_DIR
  if (override && existsSync(join(override, ".claude-plugin", "plugin.json")))
    return override
  let current = dirname(fileURLToPath(moduleUrl))
  for (;;) {
    const candidate = join(current, "cc-worker")
    if (existsSync(join(candidate, ".claude-plugin", "plugin.json"))) return candidate
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}
