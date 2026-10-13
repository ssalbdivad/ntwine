import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardSnapshot, ThreadView } from "@ntwine/shared"
import { ThreadRow, type RowScope } from "./components/Sidebar.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Where a row's click leads. This page only draws rows; every real row has a scope (ProjectList.tsx).
const ROW_SCOPE: RowScope = { open: () => {}, page: true }

// The rail row's PIN controls, on the REAL ThreadRow: the solid mark a pinned row wears in its
// right-edge column, and the hover strip's verb — an OUTLINE pin left of the fullscreen door on a row
// that can be pinned, the solid slashed unpin RIGHTMOST on a row that already is (after Retry too), and
// no box behind the strip (maintainer 2026-09-03). The long titles are deliberate: the strip overlays
// the title's first line, so a row whose title fills that line is where a letter bleeding through a
// glyph — or a visible backing — would show.
//
//   http://localhost:5907/sidebar-pin-fixture.html?font=sans   — ?font=mono for the other
//
// The strip only exists on CSS :hover, so photograph a row with
//   nub scripts/shot.mjs <url> out.png --hover='[data-sidebar-item="pinned-long"]' --clip=… --dsf=6
// and measure its rhythm with `scripts/ink-gaps.mjs` and the same flag, rather than forcing it open.
document.documentElement.dataset.font = new URLSearchParams(location.search).get("font") === "sans" ? "sans" : "mono"

const base = {
  kind: "session",
  backend: "claude",
  titleAuto: false,
  humanBlocked: false,
  pendingAsk: false,
  pendingQuestion: false,
  archived: false,
  foreign: false,
  state: "open",
  status: "active",
  crashed: false,
  needsYou: false,
  subAgents: [],
  bgShells: [],
  spawnedAt: "2026-09-01T09:00:00.000Z",
  lastAssistantAt: "2026-09-03T08:00:00.000Z",
} as const

const PINNED_AT = "2026-09-02T10:00:00.000Z"

// An ordinary CUE row that can be pinned: the rest time in the right-edge column, and on hover the
// outline pin left of the door.
const unpinnedLong = {
  ...base,
  id: "unpinned-long",
  title: "Migrate the tailer launch-race fix onto every backend and re-verify the broker replay on reconnect",
  runtime: "turn-idle",
} as unknown as ThreadView

// PINNED, long title: the solid mark in the column at rest; on hover the door, then the unpin rightmost.
const pinnedLong = {
  ...base,
  id: "pinned-long",
  title: "Rework the session-limit banner so the auto-resume countdown reads in the house duration grammar",
  runtime: "turn-idle",
  pinnedAt: PINNED_AT,
} as unknown as ThreadView

// PINNED and running, short title: the mark sits well clear of the title.
const pinnedShort = {
  ...base,
  id: "pinned-short",
  title: "Draft the changelog",
  runtime: "running",
  pinnedAt: PINNED_AT,
} as unknown as ThreadView

// PINNED and WORKING: its status inline, its task clock, and the mark still rightmost after the clock.
const pinnedWorking = {
  ...base,
  id: "pinned-working",
  title: "Port the parser",
  runtime: "running",
  statusLine: "Running focused tests",
  statusSince: new Date(Date.now() - 754_000).toISOString(),
  pinnedAt: PINNED_AT,
} as unknown as ThreadView

// PINNED and STALLED: door, Retry, unpin — the unpin stays rightmost even past Retry.
const pinnedStalled = {
  ...base,
  id: "pinned-stalled",
  title: "Audit the quota read path",
  runtime: "exited",
  crashed: true,
  needsYou: true,
  pinnedAt: PINNED_AT,
} as unknown as ThreadView

// PINNED and DONE: the pin holds the row at the top of the rail, and the row is grayed exactly as it
// would be in the Done band — the dim rides the row's state, not the band (maintainer 2026-09-11).
const pinnedDone = {
  ...base,
  id: "pinned-done",
  title: "Land the archived-row dim on the pinned band",
  runtime: "turn-idle",
  state: "archived",
  archived: true,
  pinnedAt: PINNED_AT,
} as unknown as ThreadView

// Unpinned and STALLED, for contrast: pin, door, Retry.
const unpinnedStalled = {
  ...base,
  id: "unpinned-stalled",
  title: "Jot the release notes",
  runtime: "exited",
  crashed: true,
  needsYou: true,
} as unknown as ThreadView

// An ACTIVE-band row (no rest time, no mark), whose title OPENS with an unbreakable token longer than
// the line, so `break-words` has to break it at the box edge and the first line fills the row to the
// very edge and runs UNDER the strip: the case where a letter would bleed through a glyph, and where
// the strip's backing and its left-edge fade are actually visible at work. (A long token later in the
// title just wraps whole onto its own line and never reaches the strip.)
const activeLong = {
  ...base,
  id: "active-long",
  title: "/Users/colinmcd94/.ntwine/projects/029a30af-f126-40e3-b04c-d80e74e3e090/broker.sock ENOTCONN on reconnect",
  runtime: "running",
} as unknown as ThreadView

const threads = [unpinnedLong, pinnedLong, pinnedShort, pinnedWorking, pinnedStalled, pinnedDone, unpinnedStalled, activeLong]
store.board = { threads } as BoardSnapshot

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <TooltipProvider>
      <main className="min-h-screen bg-bg px-10 py-10 text-fg">
        <div data-sidebar-rail className="w-[clamp(320px,34vw,680px)]">
          <ThreadRow scope={ROW_SCOPE} t={unpinnedLong} restedAge />
          <ThreadRow scope={ROW_SCOPE} t={pinnedLong} />
          <ThreadRow scope={ROW_SCOPE} t={pinnedShort} />
          <ThreadRow scope={ROW_SCOPE} t={pinnedWorking} />
          <ThreadRow scope={ROW_SCOPE} t={pinnedStalled} />
          <ThreadRow scope={ROW_SCOPE} t={pinnedDone} />
          <ThreadRow scope={ROW_SCOPE} t={unpinnedStalled} />
          <ThreadRow scope={ROW_SCOPE} t={activeLong} />
        </div>
      </main>
    </TooltipProvider>
  </QueryClientProvider>,
)
