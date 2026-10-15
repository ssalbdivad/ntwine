import { isDevNtwineBuild } from "../api/restart.ts"
import { useSupervisorStatus } from "../api/supervisorStatus.ts"

// "Is ntwine itself a development build?" — the one answer every dev-only affordance in the UI asks for.
//
// It is a RUNTIME question, not a build-time one, and that distinction is the whole reason this file
// exists. `import.meta.env.DEV` is a Vite compile-time constant that is true only under `vite dev`
// middleware; ntwine-dev's ordinary route builds an immutable artifact and serves the Vite PRODUCTION
// bundle, where Vite statically replaces it with `false` and drops the guarded code entirely. So a
// verb gated that way was absent from every build the maintainer actually ran — see
// components/RestartWorkerButton.tsx, which shipped invisible for exactly that reason. The launcher
// is the only thing that knows, and it reports it on the supervisor status.
//
// The answer rides the ONE shared supervisor poll (api/supervisorStatus.ts). It used to be a
// module-level promise of its own, which is how a single navigation came to request
// /_ntwine/control/status three times (t+58ms / t+61ms / t+63ms, 2026-09-04) — and the caller is a
// thread-header verb, so the queue renders one per card. Sharing the query keeps that at one
// request however many headers mount, and drops the old cache's one weakness with it: a `null` answer
// (a supervisor mid-restart, unreachable, or serving the SPA HTML fallback) is not evidence of a
// production build, and the poll now simply asks again instead of the verb staying hidden for the life
// of the page.

/**
 * Starts false and flips true once the supervisor answers. A dev-only control therefore appears a
 * beat after first paint rather than being present in the initial HTML — the same shape as the
 * Restart ntwine button in the status bar, and the correct bias: an affordance that must never show up
 * in a published ntwine should render only once the server has affirmatively said "development build".
 */
export function useDevNtwineBuild(): boolean {
  return isDevNtwineBuild(useSupervisorStatus().data ?? null)
}
