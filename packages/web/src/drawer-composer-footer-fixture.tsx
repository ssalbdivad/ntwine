import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import { useState } from "react"
import type { BoardSnapshot, ThreadView } from "@ntwine/shared"
import { Composer } from "./components/Composer.tsx"
import { ProfileGridSelector } from "./components/ProfileGridSelector.tsx"
import { QueueOpsSummary } from "./components/QueueOpsSummary.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

const thread: ThreadView = {
  id: "drawer-footer-fixture",
  title: "Long transcript with active work",
  status: "active",
  mechanism: null,
  humanBlocked: false,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  runtime: "running",
  unread: false,
  archived: false,
  hasPlan: false,
  pendingQuestion: false,
  kind: "session",
  foreign: false,
  subAgents: [
    { id: "agent-a", label: "Trace the layout regression in the drawer", startedAt: "2026-07-14T10:00:00.000Z", state: "running" },
    { id: "agent-b", label: "Exercise desktop and narrow viewport behavior", startedAt: "2026-07-14T10:01:00.000Z", state: "running" },
  ],
  bgShells: [{ label: "Watch the production fixture build", startedAt: "2026-07-14T10:02:00.000Z", state: "running" }],
  watches: [],
  questions: [],
}

store.board = { threads: [thread] } as BoardSnapshot

function Fixture() {
  const [draft, setDraft] = useState("This deliberately long draft verifies that a multiline prompt, the model selector, and every running-operation row remain visible together.\n\nOption-Enter can add another line without changing the footer boundary.")
  const [profile, setProfile] = useState({ provider: "codex", model: "gpt-5.6-sol", effort: "high" })
  return (
    <main className="relative min-h-screen overflow-hidden bg-bg px-4 py-4">
      {/* This deliberately reproduces the real shell's desktop relationship: a sticky queue rail
          above the board (z-[100]) overlaps the left edge of an open thread drawer. The selectors
          are portaled to body, so this catches a portal that is opaque yet painted underneath rows. */}
      <aside data-fixture-board-rail className="pointer-events-none absolute inset-y-0 left-0 z-[100] w-[min(600px,58vw)] border-r border-border px-5 pt-20 [&>*]:pointer-events-auto max-[800px]:hidden">
        <p className="mb-3 text-[11px] font-medium uppercase tracking-wide text-muted">Active queue</p>
        {[
          "Trace the selector layering regression",
          "Exercise desktop and narrow viewport behavior",
          "Verify the drawer profile mutation",
          "Capture final visual proof",
        ].map((label) => (
          <div key={label} className="mb-2 rounded-lg border border-border bg-panel-2 px-3 py-2 text-[12px] leading-snug text-fg">
            {label}
          </div>
        ))}
        {/* A queue row at the same optical height as the upward-opening menu. Its text and pointer
            target reproduce the exact overlap without covering the drawer trigger itself. */}
        <div data-fixture-overlap-row className="absolute left-5 right-[-60px] top-[580px] rounded-lg border border-border bg-panel-2 px-3 py-2 text-[12px] leading-snug text-fg max-[800px]:hidden">
          Verify the drawer profile mutation
        </div>
      </aside>
      <section data-fixture-thread-drawer className="relative z-10 ml-[420px] flex h-[min(760px,calc(100vh-2rem))] w-[min(720px,calc(100vw-436px))] min-w-[320px] flex-col overflow-hidden border border-border bg-panel shadow-2xl max-[800px]:ml-0 max-[800px]:h-[min(680px,calc(100vh-2rem))] max-[800px]:w-full max-[800px]:min-w-0">
        <header className="shrink-0 border-b border-border px-4 py-3">
          <p className="text-[11px] text-muted">Fixture · transcript-only scroll</p>
          <h1 className="text-[15px] font-semibold">Long transcript with active work</h1>
        </header>
        <div data-drawer-transcript-scroll className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {Array.from({ length: 12 }, (_, index) => (
            <article key={index} className="mb-4 rounded-lg border border-border bg-panel-2 p-3 text-[13px] leading-relaxed text-fg/85">
              <strong className="block text-[11px] text-muted">Transcript message {index + 1}</strong>
              The transcript remains independently scrollable while the entire composer surface stays anchored below it.
            </article>
          ))}
        </div>
        {/* The device's bottom inset rides the chat footer, as it does in ChatView: the lifecycle footer
            that used to sit under this and carry it went on 2026-10-05. 0px on a desktop screen. */}
        <footer data-thread-chat-footer className="z-10 shrink-0 border-t border-border/60 bg-panel pb-[env(safe-area-inset-bottom)]">
          <div data-thread-action-bar className="px-3 py-3">
            {/* Mirrors ThreadActionBar's `above` slot: the live ops as one line of counts over the
                prompt box, their rows one hover away (2026-10-09). Under the box nothing hangs any more,
                so the box's own pb is its gap to the footer's bottom edge. */}
            <QueueOpsSummary thread={thread} />
            <Composer
              surface="drawerFooterFixture"
              value={draft}
              onChange={setDraft}
              onSubmit={() => {}}
              // The thread above is mid-turn, so the forced chord would interrupt — renders the hint.
              onInterruptSubmit={() => {}}
              placeholder="Follow up…"
              footer={(
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                  <ProfileGridSelector
                    groups={[{ id: "codex", label: "Codex", options: [{ model: "gpt-5.6-sol", label: "GPT-5.6 Sol", efforts: ["medium", "high"] }] }]}
                    value={profile}
                    onValueChange={setProfile}
                    ariaLabel="Thread model and effort"
                    menuAriaLabel="Choose Codex model and effort"
                    compact
                    side="top"
                    className="min-w-0 max-w-[72%] px-1.5 py-0.5"
                  />
                </div>
              )}
            />
          </div>
        </footer>
      </section>
    </main>
  )
}

// The same providers the real shell mounts above this footer. Without them the page threw "No
// QueryClient set" out of RestartWorkerButton's `useQueryClient` before React committed anything, so
// the fixture rendered an EMPTY body and its e2e died on `[data-thread-action-bar]` not existing —
// a failure that reads as "the selector moved" rather than "the page never mounted". The ops rows (now
// in the counts' hover panel) have needed a client since the restart verb joined them.
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <TooltipProvider>
      <Fixture />
    </TooltipProvider>
  </QueryClientProvider>,
)
