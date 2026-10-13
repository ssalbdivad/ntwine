import { createRoot } from "react-dom/client"
import { useSnapshot } from "valtio"
import type { ReactElement } from "react"
import { ErrorBoundary, DrawerErrorSheet, RootErrorBoundary } from "./components/ErrorBoundary.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for the render-error boundaries. The thing being proved is a NEGATIVE — that a throwing
// component no longer blanks the window — so the fixture has to actually throw, in the actual shape
// that took ntwine down: a FREE IDENTIFIER left in the bundle by an artifact built from a torn working
// tree (ChatView.tsx's unqueue hooks were called one edit before their `import` line was written, and
// a free identifier is legal JS, so rolldown emitted the calls without a word).
//
// `declare const` reproduces that exactly: TypeScript is satisfied, the declaration erases at build,
// and the emitted call references a name that was never defined — the identical ReferenceError, from
// the identical mechanism, rather than a hand-rolled `throw new Error("boom")` that proves less.
declare const useUnqueueSupported: (slug: string | null) => boolean

function CrashingBody(): ReactElement {
  return <div data-never-rendered>{String(useUnqueueSupported(null))}</div>
}

// The three surfaces App wraps, one per `?case=`, each mounted the same way App mounts it so the
// fixture exercises the real wiring and not a lookalike.
const CASE = new URLSearchParams(window.location.search).get("case") ?? "drawer"

// The board stand-in. Its whole job is to still be on screen after the drawer above it has thrown —
// that assertion IS the bug fix.
function Board(): ReactElement {
  return (
    <main data-fixture-board className="mx-auto w-[720px] max-w-[62vw] py-5">
      <div className="rounded-lg border border-border bg-panel px-4 py-3 text-[13px] text-fg/90">
        The board is alive. A drawer crashing above this must not take it down.
      </div>
    </main>
  )
}

// App's drawer map, verbatim in structure: the layer is wrapped in an ErrorBoundary whose fallback is
// the DrawerErrorSheet at the same stack geometry.
function DrawerStack(): ReactElement {
  const snap = useSnapshot(store)
  return (
    <>
      {(() => {
        let below = 0
        return snap.drawers.map((d, i) => {
          const widthDepth = below
          if (!d.closing) below++
          return (
            <ErrorBoundary
              key={d.id}
              label="this drawer"
              resetKeys={[d.kind, d.slug, d.subId, d.path]}
              fallback={(error, retry) => (
                <DrawerErrorSheet id={d.id} depth={i} widthDepth={widthDepth} error={error} onRetry={retry} />
              )}
            >
              <CrashingBody />
            </ErrorBoundary>
          )
        })
      })()}
    </>
  )
}

if (CASE === "drawer") store.drawers = [{ id: 1, kind: "thread", slug: "auth-refresh" }]

const root = createRoot(document.getElementById("root")!)
root.render(
  CASE === "root" ? (
    <RootErrorBoundary>
      <CrashingBody />
    </RootErrorBoundary>
  ) : CASE === "panel" ? (
    <div className="min-h-screen bg-bg text-fg">
      <div data-fixture-panel className="mx-auto w-[720px] max-w-[62vw] py-5">
        <ErrorBoundary label="the queue">
          <CrashingBody />
        </ErrorBoundary>
      </div>
    </div>
  ) : CASE === "unguarded" ? (
    // THE CONTROL. The same throw with no boundary around it — React tears #root down to nothing and
    // this is the blank window that was reported. Without this case the passing assertions above
    // prove only that a page renders, not that the boundaries are what keeps it rendering.
    <div className="min-h-screen bg-bg text-fg">
      <Board />
      <CrashingBody />
    </div>
  ) : (
    <div className="min-h-screen bg-bg text-fg">
      <Board />
      <DrawerStack />
    </div>
  ),
)
