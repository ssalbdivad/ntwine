import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query"
import "@xterm/xterm/css/xterm.css"
import "./styles.css"
import { RootErrorBoundary } from "./components/ErrorBoundary.tsx"
import { RouterProvider } from "react-router"
import { router } from "./routes.tsx"
import { connectSync } from "./api/socket.ts"
import { initTranscriptLive } from "./api/transcript-live.ts"
import { initSupervisorStatus } from "./api/supervisorStatus.ts"
import { initEditorBridge } from "./lib/editorBridge.ts"
import { initEmbedHost } from "./lib/embedHost.ts"
import { initFont } from "./lib/font.ts"
import { setProjectMonograms } from "./lib/monograms.ts"
import { initTheme } from "./lib/theme.ts"
import { installExternalLinkInterceptor } from "./lib/external-links.ts"
import { installLocalFileLinkInterceptor } from "./lib/local-file-links.ts"
import { installCodeCopyInterceptor } from "./lib/copy-code.ts"
import { installCodeTabInterceptor } from "./lib/switch-code-tab.ts"
import { installCodeExpandInterceptor } from "./lib/expand-code.ts"
import { installDisclosureInterceptor } from "./lib/toggle-disclosure.ts"
import { installPasteFallback } from "./lib/paste-fallback.ts"
import { installThreadLinkInterceptor } from "./lib/thread-links.ts"
import { setProjectMentions } from "./lib/projectMentions.ts"
import { rpc } from "./api/rpc.ts"
import { primeRoute } from "./lib/router.ts"
import { installViewTransitionRejectionFilter } from "./lib/viewTransitionRejections.ts"
import { PENDING_SEND_REPLAY_DELAY_MS, replayPendingSends } from "./lib/eagerComposerSubmission.ts"
import { stepOffStaleLayerEntries } from "./lib/backDismiss.ts"
import { innerPath } from "./lib/base-path.ts"
import { projectScopedQueryKeyHash } from "./lib/queryKeyScope.ts"
import { parseStandaloneThreadPath } from "./lib/standaloneThreadRoute.ts"

// DEV ONLY: React 19.2's development build logs its Components/Scheduler performance tracks through
// `performance.measure`, each entry carrying a `detail` object (a props diff for a re-render), and
// Chrome buffers every measure for the life of the page — nothing ever evicts them. Measured
// 2026-09-29 on the real board with the tab idle: 177 entries/s, so a dev tab left open overnight held
// ~10M of them, and the GC pressure surfaced as multi-second freezes while typing. Nothing in the app
// reads the buffer, and DevTools records these tracks from trace events at call time, so emptying it
// loses no profiling data. Production React emits none of this.
if (import.meta.env.DEV && typeof performance !== "undefined") {
  setInterval(() => performance.clearMeasures(), 5_000)
}

const settingsFixture = typeof window !== "undefined" && window.location.pathname.endsWith("/settings-formatting-fixture.html")
// innerPath, not location.pathname: under a project prefix the deep link is `/all/nub/thread/x/full`.
const standaloneThreadSlug = typeof window !== "undefined" ? parseStandaloneThreadPath(innerPath()) : null

// A reload with a phone sheet up restores the sheet's same-URL history entry with no sheet to own it.
// Step off it before anything pushes, so the page sits on the router's own entry (see lib/backDismiss).
if (!settingsFixture) stepOffStaleLayerEntries()

if (!settingsFixture && !standaloneThreadSlug) {
  // Adopt a cold/deep URL before React takes its first store snapshot — still SYNCHRONOUS, and still
  // before the first render, which is the whole point: it is what makes a deep-linked drawer painted
  // open on the first frame instead of animating in afterwards. The router resolves the same path a
  // beat later and `useRouteToStore` re-applies it, which is idempotent.
  primeRoute()
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      // Every cache entry is scoped to the project the page is showing — see lib/queryKeyScope.ts.
      // This is a client-level default rather than 19 hand-prefixed key shapes precisely so that the
      // twentieth is scoped too, without its author knowing this problem exists.
      queryKeyHashFn: projectScopedQueryKeyHash,
    },
  },
})

// One multiplexed /ws (board + transcript push + notify); falls back to SSE + polling if /ws is
// unavailable (a pre-restart server). The socket writes transcript pushes into this queryClient's cache.
if (!settingsFixture) {
  initTheme()
  connectSync(queryClient)
  // Observer-driven transcript liveness: any mounted surface observing ["transcript", slug] is kept
  // fresh centrally (socket subscription within budget, activity-edge refetch beyond) — components
  // never manage subscriptions themselves.
  initTranscriptLive(queryClient)
  // The ONE listener for the control-action wake event, so an accepted restart costs one status read
  // rather than one per surface reading the supervisor — see api/supervisorStatus.ts.
  initSupervisorStatus(queryClient)
  // The connected editor windows, the offer to send code files to one, and what an editor sends to the
  // prompt box — machine-wide, so once per page rather than per project.
  initEditorBridge(queryClient)
  // In an editor's sidebar (lib/embed.ts): VS Code's theme, its selections, its keys. Nothing otherwise.
  initEmbedHost()
  initFont()
  installExternalLinkInterceptor()
  installLocalFileLinkInterceptor()
  installCodeCopyInterceptor()
  installCodeTabInterceptor()
  installCodeExpandInterceptor()
  installDisclosureInterceptor()
  installPasteFallback()
  installThreadLinkInterceptor(queryClient)
  // The projects a `#slug` names (lib/projectMentions.ts): the machine's project list, the same cached
  // read the dock draws from, kept current as it is invalidated by an add, rename or removal.
  new QueryObserver(queryClient, { queryKey: ["projectsList"], queryFn: () => rpc.projectsList() }).subscribe((result) => {
    setProjectMentions(result.data)
    setProjectMonograms(result.data)
  })
  installViewTransitionRejectionFilter()
  // A reply still on the wire when the last page in this tab went away — see lib/pendingSends.ts.
  setTimeout(() => void replayPendingSends(), PENDING_SEND_REPLAY_DELAY_MS)
}

// No StrictMode: it double-mounts effects, which would open each live socket twice in dev.
if (!settingsFixture) {
  createRoot(document.getElementById("root")!).render(
    <QueryClientProvider client={queryClient}>
      {/* The last-resort catch. App wraps its own surfaces far more finely (sidebar / queue / each
          drawer), so anything reaching this one broke above all of them — a throw in App's own body,
          or in the standalone thread page. It still renders a page with the error ON it, which is
          the whole difference between a bad render and the blank window this replaced. */}
      <RootErrorBoundary>
        <RouterProvider router={router} />
      </RootErrorBoundary>
    </QueryClientProvider>,
  )
}
