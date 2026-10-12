import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router"
import type { BoardSnapshot, ThreadView as ThreadViewModel } from "@frizz/shared"
import { FocusRail } from "./components/FocusRail.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for the /full page's operational rail (FocusRail) on its own, beside a stand-in transcript
// edge, with every row kind it draws. The labels are the long ones a real worker writes — the case the
// rail used to cut to two or three words (maintainer 2026-10-08) — so wrapping, the status track and the
// rows' hover inset can all be judged at once.
//
//   (cd packages/web && nubx vite --port 5422 --strictPort)
//   http://localhost:5422/focus-rail-fixture.html            dark, sans
//   ?theme=light                                             the light palette
//
// The transcript page is seeded straight into the query cache (with its edited files), so nothing is
// fetched; the rows' drill-ins open drawers that have no server behind them here.

const SLUG = "focus-rail-demo"
const params = new URLSearchParams(location.search)
document.documentElement.dataset.font = params.get("font") === "mono" ? "mono" : "sans"
if (params.get("theme") === "light") document.documentElement.dataset.theme = "light"
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const HOME = "/Users/demo"
const DIR = `${HOME}/projects/frizz/.frizz/threads/4204dab2`

const thread = {
  id: SLUG,
  title: "Rotate every credential after the token leak",
  status: "active",
  runtime: "running",
  state: "active",
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  kind: "session",
  backend: "claude",
  subAgents: [
    { id: "toolu_a", label: "Sweep E+F: edit every rotation doc to the new key names", subagentType: "frizz:opus-high", startedAt: ago(133), state: "running", depth: 1 },
    { id: "toolu_b", label: "Vector: npm supply-chain audit of the last 30 days", subagentType: "frizz:opus-xhigh", startedAt: ago(61), state: "running", depth: 1 },
    { id: "toolu_c", label: "Vector: local, a compromised laptop as the entry point", subagentType: "frizz:opus-xhigh", startedAt: ago(60), state: "running", depth: 1 },
    { id: "toolu_d", label: "Audit the old projection for a stale key", subagentType: "frizz:sonnet-low", startedAt: ago(200), state: "stale", depth: 1 },
  ],
  bgShells: [
    { id: "toolu_s", taskId: "b7k2m1xq0", label: "vite dev --host --port 5173", startedAt: ago(18), state: "running" },
  ],
  watches: [
    {
      id: "github:demo:colinhacks/frizz#412", kind: "github", target: "colinhacks/frizz#412", state: "armed", createdAt: ago(40),
      github: { checks: "failing", running: 1, passed: 9, failed: 2, failing: ["lint", "e2e (chromium)"], merge: "blocked", state: "open", polledAt: ago(1) },
    },
    { id: "timer:demo:1", kind: "timer", target: "tmr_a1b2c3d4e5f6", state: "armed", createdAt: ago(5), timer: { fireAt: new Date(Date.now() + 34 * 60_000).toISOString(), prompt: "Re-check npm for any publish of frizz after 0.13.8 and compare its tarball hash against the one CI built" } },
  ],
  links: [
    { id: "l1", kind: "file", label: "Rotation checklist (every credential, in order)", target: `${DIR}/rotation.md` },
    { id: "l2", kind: "file", label: "Agent actions for after the rotation", target: `${DIR}/agent-actions.md` },
    { id: "l3", kind: "file", label: "Fresh install plan", target: `${DIR}/fresh-install-plan.md` },
    { id: "l4", kind: "file", label: "Incident timeline", target: `${DIR}/incident.md` },
    { id: "l5", kind: "file", label: "Attribution report: who published 0.13.6", target: `${DIR}/investigate-attribution.md` },
    { id: "l6", kind: "file", label: "Reports to file (copy-paste ready)", target: `${DIR}/reports-to-file.md` },
    { id: "l7", kind: "file", label: "Downloads reads in the incident window", target: `${DIR}/investigate-downloads.md` },
    { id: "l8", kind: "link", label: "npm access tokens page", target: "https://www.npmjs.com/settings/colinhacks/tokens" },
  ],
  lastActivityAt: ago(1),
} as unknown as ThreadViewModel

store.board = { projectDir: `${HOME}/projects/frizz`, homeDir: HOME, threads: [thread] } as unknown as BoardSnapshot

const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
client.setQueryData(["transcript", SLUG], {
  messages: [],
  transcriptKey: "fixture-key",
  hasEarlier: false,
  beforeCursor: null,
  reachedTurnBoundary: true,
  editedFiles: [
    { path: `${HOME}/projects/frizz/packages/web/src/components/FocusRail.tsx`, edits: 3, added: 24, removed: 9 },
    { path: `${HOME}/projects/frizz/packages/web/src/components/AwaitingBackgroundCard.tsx`, edits: 5, added: 41, removed: 12 },
    { path: `${HOME}/projects/frizz/docs/rotation.md`, edits: 1, added: 80 },
  ],
})

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <MemoryRouter>
      <TooltipProvider>
        <div className="flex h-screen bg-bg text-fg">
          {/* A stand-in for the thread column's right edge, so the rail is judged where it sits. */}
          <div className="w-[360px] shrink-0 border-x border-border bg-panel" />
          <FocusRail thread={thread} />
        </div>
      </TooltipProvider>
    </MemoryRouter>
  </QueryClientProvider>,
)
