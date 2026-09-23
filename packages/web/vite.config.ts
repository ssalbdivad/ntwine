import { defineConfig, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

/**
 * Load the DEV-ONLY render instrumentation (src/perf-scan.ts, opt-in per page via `?scan=1`) as its
 * own module script, ahead of the app's — and only when Vite is SERVING.
 *
 * It is here rather than as an import in main.tsx because of an ordering constraint that no lazy
 * import can satisfy. react-scan side-effect-imports bippy, whose module body installs
 * `__REACT_DEVTOOLS_GLOBAL_HOOK__`; react-dom reads that global ONCE, at its own module scope
 * (react-dom-client.production.js: `if ("undefined" !== typeof __REACT_DEVTOOLS_GLOBAL_HOOK__)`), and
 * never looks again. So react-scan has to be evaluated before react-dom is — and `await
 * import("react-scan")` cannot be, because main.tsx's static import of react-dom is evaluated while
 * the awaiting module is suspended. That edit LOOKS right, ships a smaller bundle, and can leave
 * `?scan=1` recording nothing at all, with no error to say so.
 *
 * A separate `<script type="module">` in the head satisfies it unconditionally: classic module
 * scripts execute in document order, so perf-scan.ts finishes before main.tsx starts. It is also the
 * arrangement react-scan documents ("top of your entry, or as the first script in `<head>`").
 *
 * The payoff is on the production side: main.tsx no longer reaches react-scan at all, so the shipped
 * entry chunk drops react-scan + react-grab + preact + bippy, which a devDependency was putting in
 * front of every user because the `import.meta.env.DEV` guard sat inside the function while the
 * import sat at the top of the file. Measured 2026-09-04 by building both ways: the entry chunk goes
 * 1,511,795 -> 1,326,040 bytes (-185,755), and 25 occurrences of "react-scan" in the artifact go to
 * 0. At 4x CPU throttle in headless Chrome over loopback that is a median cold FCP of 780 -> 752 ms
 * and DOMContentLoaded of 219.7 -> 202.4 ms — a real win, and about half the ~56 ms of FCP the
 * investigation that found this predicted.
 */
function devRenderScanScript(): Plugin {
  return {
    name: "frizz:dev-render-scan",
    apply: "serve",
    transformIndexHtml: () => [
      { tag: "script", attrs: { type: "module", src: "/src/perf-scan.ts" }, injectTo: "head-prepend" },
    ],
  }
}

// Dev is served same-origin through the server's Vite middleware, so no proxy.
export default defineConfig({
  plugins: [react(), tailwindcss(), devRenderScanScript()],
  build: { outDir: "dist", emptyOutDir: true },
  // The dependency cache is per SERVER, never shared with a throwaway one. Every dev Vite rooted here
  // defaults to node_modules/.vite, and a disposable stack booted beside the maintainer's `npm run dev`
  // hashes its config differently, re-optimizes, and rewrites that directory under the live server. The
  // open tab still holds the old React chunk, so the next lazily loaded module (the terminal drawer's
  // TerminalPane) pulls in the rewritten one: two Reacts, and the drawer dies on "resolveDispatcher()
  // is null" (2026-09-23). Throwaway servers (scripts/adhoc-stack.mjs, dev-test.mjs, e2e-web.mjs) set
  // FRIZZ_VITE_CACHE_DIR to a scratch cache of their own.
  cacheDir: process.env.FRIZZ_VITE_CACHE_DIR || "node_modules/.vite",
  // The browser e2e suite (scripts/e2e-web.mjs) boots this vite over a working tree other agents are
  // often editing mid-run. With the watcher on, each of those edits becomes an HMR update or full
  // reload in the middle of a test — a fixture that mounts its root at module top level re-evaluates
  // and the test fails on React's "createRoot() on a container that has already been passed to
  // createRoot()" console error, a flake with nothing behind it. The suite never edits files, so its
  // server neither watches nor pushes.
  ...(process.env.FRIZZ_E2E_STATIC_VITE ? { server: { hmr: false, watch: null } } : {}),
})
