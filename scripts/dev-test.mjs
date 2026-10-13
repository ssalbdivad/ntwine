// Ephemeral verification server: a fresh ntwine instance on a test port (default 4919), serving the
// CURRENT source (incl. the new GitHub RPC endpoints) so the orchestrator can drive an end-to-end
// visual pass without touching the maintainer's live instance. Wakers OFF (no scheduler side effects).
// cwd must be ui/ (its git toplevel = the ntwine repo → project = ssalbdivad/ntwine, a gh-authed repo).
import { startServer } from "../packages/server/src/index.ts"
// Never the live dev server's Vite dep cache — see packages/web/vite.config.ts.
process.env.NTWINE_VITE_CACHE_DIR ||= "node_modules/.vite-scratch"

startServer({ dev: true, port: Number(process.env.PORT) || 4919 })
