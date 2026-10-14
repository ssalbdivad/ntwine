# All-projects-first: a sidebar ordered by attention, not by project

Status: built (2026-10-14), all four steps: `components/TierList.tsx` (every view's list), `lib/sidebarBudget.ts`
(fit-to-height), `components/HistoryView.tsx` with `projectsDone`/`threadsSearch` (History and cross-project search),
`components/ProjectDock.tsx` and `lib/lens.ts` (dock and lenses). Where it departs from this text: the bands keep
their names (Ready, Working, not "Needs you"/"Waiting"), a worker's own park stays in Working (no Waiting tier;
Snoozed is the human's snoozes), and History has no date or has-PR filter yet. The concept page lives in the thread
that wrote this, `.ntwine/threads/87256cc2-078f-471c-9177-7c18fe38d2fc/all-projects-first.html`.

## The premise

Today's All projects is a project board repeated 17 times. The left column is grouped BY PROJECT
(`ProjectList.tsx`): each project is a heading row, its Pinned/Ready/Working rows hang under it, and its
Snoozed/Done/External bands are quiet counts on that heading. The right column is one queue across
projects. That shape is inherited from Frizz's principles, which this proposal drops wholesale:

| Frizz principle (CLAUDE.md § The board) | Replaced by |
| --- | --- |
| Every thread is in one of five rails, and no view may lose that distinction | Four ATTENTION TIERS (Needs you, Working, Waiting, Finished), plus pins as a flag. Snoozed and External stop being bands. |
| Projects stay separate; All projects never interleaves projects | Tiers interleave projects. The project is an attribute of a row (its square in the gutter), not a container. |
| Pinned, Ready and Working never fold | Only Needs you is protected, and even it truncates last (below). |
| Default view shows ≥ upstream's board at heavy load (`capacityParity.e2e.test.ts`) | A new bar: the sidebar NEVER SCROLLS at heavy load, at 1280×720 and up, and still accounts for every live thread. |
| A project's board at `/project/<slug>` | A LENS: the same page filtered to one or more projects. |

Kept, because they are product facts and not Frizz's taste: one server for every project, the queue as the
center column, the worker contract and its rows, density.

## The question each region answers

- **Sidebar — "what is the state of everything?"** Live state only, across every project, ordered by how
  much it needs the human. It fits the viewport; it is never a list to scroll.
- **Center — "what do I act on, or look up?"** Tabs: **Queue** (today's cards), **History** (Done, across
  projects), **Waiting**, **Schedules**. The long lists move here, where there is width to show them
  richly.
- **Drawers** — unchanged.

The current split gets this backwards: the 34vw sidebar holds the deep lists (Done paged ten at a time,
inside a project's heading) while the center holds only the queue.

## The sidebar, top to bottom

1. **Dock** (2 lines at 17 projects). One 22px square per project in the machine-wide order, a badge for
   its Needs-you count, a tick under it while something is working. Click lenses to that project,
   shift-click adds one, `+` adds a project. Saved lenses above it (`All · Work · OSS · Side`, keys `1`–`4`).
   Project management (rename, reorder, remove, instructions) lives on the square's menu, so the list
   carries no project rows at all. Drag-reorder moves here, where order still means something.
2. **Pinned** — unchanged in meaning, one line per pin.
3. **Needs you** — every queue card, in queue order, one line each: square · kind glyph (`?` question,
   `✓` done card, `!` failed, `⚠` permission, `☐` steps) · title · rest age. Unread is bold. This is the
   queue's index, so a click scrolls the card into view.
4. **Working** — clustered by project (dock order), longest-running first in each run. One line: square
   on the first row of a run and a thread of its colour on the rest · spinner · title · sub-agent count ·
   the live gerund in muted text · elapsed. The gerund is the most useful datum the row can carry, and the
   width is there for it once project headings stop eating lines.
5. **Waiting** — folded to one line by default: `Waiting 9 · next 2h 10m`. Open, each row says what it
   waits on (`acme/app#391 · CI`, `timer`, `@thread reply`) and when it wakes. This absorbs Snoozed and
   the `watching` rests. User wall-clock snoozes stay here too; the footer counts them.
6. **Finished today** — a fading tail of the last few Done threads, with `history →` opening the center's
   History tab. This is how Done stays one glance away without owning lines.
7. **Footer** (1 line): schedules (`4 · next 9:00`), `⌘K`.

External sessions become a filter in History and a line in the dock's square menu; they are not a band.

## Fit-to-height: the budget

The sidebar measures itself and compresses lowest-priority-first until it stops scrolling:

1. Shorten the Finished tail, one row at a time, to its header.
2. Roll up Working by project, biggest run first: `▣ arktype · 5 working · 3 sub-agents · JIT cache…  3h`.
   Click expands that run in place; an expanded run is never re-rolled.
3. Truncate Needs you from the newest end to a floor of 5, ending in `3 more in the queue · app, arktype`.
   Last, because it is the one tier the center column already shows in full.

A tier the human opened by hand is never compressed. To keep rows from jumping under the pointer, the budget
recomputes only on resize, on a tier's membership change, and never while the pointer is over the list
(`listHold.ts` already does the holding).

Measured on the concept (heavy load, 51 open threads with this seed): no scroll at 1920×1080, 1440×900
and 1280×720. At 1440×900 that is 2 pins, 13 Needs-you rows plus a "3 more" line, 8 Working rollups plus
one single, and Waiting and Finished as headers. At 1920×1080 only 4 of 9 Working runs roll up. Today's
list at the same load fits 23 lines at 1440×900 (`ProjectList.tsx` `GROUP_GAP`), project headings
included, and scrolls for the rest. One seed, so the row counts are illustrative; the no-scroll property is
what the budget guarantees.

## Done, easily

Done leaves the sidebar except for its tail. In its place:

- **History tab.** One log across every project in the current lens, grouped by day, newest first,
  virtualized. Each entry is the done card's ledger (its bullets, its commits, its PR), not just a title,
  so History answers "what shipped this week" without opening a thread. Filters: project (the lens), date,
  External, has-PR. Reopen and open-drawer are on the row.
- **Search every thread.** `⌘K` and the History search box both reach Done threads in every project.
  Today the palette searches only the page project's board (`useBoard` in `CommandPalette.tsx`).
- **Finished today** in the sidebar, as above.

## What changes in code

- `ProjectList.tsx` → a tier list. The project-grouping, per-project quiet counts and `MoreToggle` go;
  `RailRow` (Sidebar.tsx) stays as the row, with the gutter square and gerund trailer added.
  `lib/listBands.ts` and `lib/crossProject.ts` folds become tier folds plus rolled-run state.
- New `lib/sidebarBudget.ts`: the compression order above, pure, unit-tested on its ordering.
- `AllQueues.tsx`: tabs over the center column; History and Waiting are new center views.
- `ProjectBoard.tsx` and `/project/<slug>` become a lens (`/?p=ntwine,app`), and the switcher becomes
  the dock. `pageView.ts` gains a project SET instead of `ALL_PROJECTS | slug`.
- Server: a cross-project Done query, paginated by rest time with filters. `ProjectQueue.recentDone`
  already rides the poll per project, so the Finished tail needs no new read; History does. A
  cross-project thread search for the palette, over open and Done threads.
- The first-run tour (`Onboarding.tsx`): its "Your projects" step describes today's per-project list and
  "N more"; with tiers it becomes the tier list, with History and the dock as their own steps.
- Docs: CLAUDE.md's "The board" principles, ARCHITECTURE.md § Board nomenclature, and the capacity test
  are rewritten to the new bar. The band vocabulary (Ready/Working/Snoozed/Done) becomes tier vocabulary
  (Needs you/Working/Waiting/Finished), which touches `BANDS` and every label that reads from it.

## Build order, by scope

1. **Tier sidebar** — the tier list, gutter squares, gerund trailer, Waiting folded, Finished tail from
   `recentDone`. Client-only. The largest visual change and the one to judge first.
2. **Budget** — `sidebarBudget.ts` plus the rollup row. Client-only. Replaces the capacity test with a
   no-scroll test at three viewports.
3. **History and search** — the center tabs, the cross-project Done query, palette search across projects.
   Client and server.
4. **Dock and lenses** — the dock, saved lenses, `/project/<slug>` folded into a lens, project management
   onto the square's menu. Touches routing and every link that builds a project URL.

Each step lands alone and leaves the app usable; 1 and 2 are where the idea is proven or dropped.

## Risks

- **Rows move between tiers.** Today a row moves within its project; here a thread that rests jumps from
  Working to Needs you. Mitigated by the list hold and a short FLIP move, but it is the trade.
- **Losing "what is going on in project X".** Answered by the lens (one click on a square) and by Working's
  clustering, not by headings. If that proves too weak, per-project headings can return inside a lens only.
- **The rollup hides titles** at small heights. The rollup line lists them truncated, and a click opens it.
