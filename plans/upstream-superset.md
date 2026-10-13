# The fork as the base, with every upstream change in it

Plan, 2026-10-06 (David), revised the same day. Fork `main` vs `upstream/main` 0a3b9139.

**Goal.** Keep this fork as the base, with its defaults and features. Make sure **everything upstream built or decided** is
in it:
- every upstream feature, fix, view and rule;
- the core principles upstream stated at the 2026-10-06 standup.

Where one of those principles collides with a fork behavior, the principle wins, and the fork's behavior survives in the
least invasive form that still upholds it. The fork can then be offered as the product,
or cherry-picked from, with a ledger showing nothing of upstream's was lost. What doesn't make the product is removed, not
carried (2026-10-07, at the end of §10).

An earlier revision of this plan went the other way. It restored upstream's surfaces as the default and moved fork features
behind opt-ins or into plugins. David rejected that: features like thread names, status lines, auto effort, the single-key
shortcuts and the wake lock are useful with little downside, and they stay.

The research behind every claim, with file:line, is in the planning thread's scratch directory:
- `parity-ledger.md`, `principles.md`, `ui-surface.md`, `server-surface.md` and `plugins.md`;
- `sidebar/sidebar-report.md` (measured at both workloads);
- `divergence/divergence-report.md`.

---

## 1. Upstream's core principles

### Stated at the 2026-10-06 standup (binding)

| # | Principle | Upstream's words (standup notes) |
|---|---|---|
| S1 | **Every thread belongs to one of five rails, and that status distinction is core information** that must never be lost from view | "a unified sidebar loses important conceptual information in Ntwine, especially thread status distinctions, because each thread belongs to one of '5 rails.'" |
| S2 | **Workspaces/projects stay separate** | "[upstream's] strongest product intuition is still that workspaces/projects should stay separate, which aligns with other tools like Claude, ChatGPT, and T3." |
| S3 | **The default must hold up at heavy load,** e.g. upstream's 17 projects and ~70 open threads, against a sidebar that fits ~15–20 rows. No view fits 70, upstream's included, so in practice this means **capacity parity: the default shows at least as much as upstream's does** (§2) | "the unified-sidebar model does not scale for [upstream's] usage because [upstream] currently has '17 projects' and around '70 active threads'"; "a single sidebar only fits around '20' threads at most, and closer to '15' once project-group spacing is included" |
| S4 | **Mainline takes changes in pieces:** cherry-picks, soundness fixes first, no wholesale structural changes | "integrating the fork will likely be 'a cherry-pick situation'"; "substantive structural changes in the fork that [upstream] does not want to pull back into main wholesale"; "use agents to categorize changes from the fork and identify soundness fixes worth cherry-picking" |
| S5 | No release before someone strong takes point | Not a design rule; it means the fork must stay reviewable by someone new |

Also from the same standup: upstream said its setup with Ctrl+L "already feels better than the Cursor + Claude Code
integration path". That is a point in favor of the fork's VS Code work.

### Documented in upstream's repo (principles to honor, with the fork's answer)

These come from ARCHITECTURE.md, AGENTS.md, `cc-worker/DECISIONS.md` and upstream's commit messages (citations in
`principles.md`). The fork keeps several behaviors that bend them. Each is listed here with its reason, so the difference is
argued rather than hidden.

| # | Principle | Fork's position under this plan |
|---|---|---|
| P1 | One board is home; cross-project means awareness, not content (2498ad77) | **Changed, argued.** All projects is home: a project-grouped awareness surface that carries every project's counts, the rail's job, and gives up no capacity (§2). Each project's own board is one click away at its own URL. |
| P2 | Five named bands; Queue and Running never hidden (Sidebar.tsx:47-48, 259; 45ce008e) | **Upheld** in the project board, with S1 (§2); in All projects every row keeps its band mark. |
| P3 | Upstream's vocabulary: Queue, Running, board | **Adopted** (§2): no feature cost, and the fork's own CLAUDE.md already teaches agents upstream's band names. |
| P4 | `/project/<slug>` URLs; `?project=` was rejected (singleton-ntwine.md:131) | **Adopted** for the project board (§2). |
| P5 | Ntwine runs no model of its own (ARCHITECTURE.md:5) | **Kept, with an off switch.** See below. |
| P6 | The worker contract is mechanics only; every token costs | **Kept, trimmed where inert.** Tools and sections tied to an absent capability are not listed (§5). |
| P7 | Few settings | No setting for the view (the URL names it, §2). One setting for model calls, replacing today's env-only switches. |
| P8 | Keyboard is ⌘K, ⌘I and Esc | **Kept on.** The single-key layer is visible (the `?` sheet) and rebindable. |
| P9 | No pty | **Already reconciled** in the fork: node-pty is imported lazily, only for a terminal the human opens, and no agent or sign-in path touches it (fork CLAUDE.md). Remaining: make it an optional dependency so a box without it installs cleanly. |
| P10 | No git/worktree opinions | **Kept.** The fork's worktree folder rule is a mechanic its own threads rely on; the trade-off is offered upstream as a decision (§8). |
| P11 | Docs state the present | **Upheld** (§6): a docs pass, plus re-attributing the fork's quotes. |
| P12 | Lazy project activation; full-snapshot SSE | **Upheld** by running the all-projects poll and prefetch only while that view is open (§2). |
| P13 | The phone board is upstream's approved v2 | **Reflected.** The fork's phone page carries that v2; the gaps the ledger found are fixed (§3). |

**Features that stay, on by default:**
- thread names, status lines and auto effort;
- the single-key shortcuts;
- the wake lock;
- schedules;
- the VS Code integration with Ctrl+L, @-files and editor context;
- thread terminals, spinoff, Home, inter-thread messages, handles;
- the 10-minute question default;
- arrival-order queue, shell budgets, check-ins;
- the queue card's docked prompt box, stable queue, cords;
- the lightbox/ImageViewer/FileReaderDrawer, quota alerts, delete-old-threads, Fable fallback.

**On P5 specifically.** The model calls behind names, status lines and auto effort run on the user's own Claude sign-in
through `claude-oneshot`. Each has a mechanical fallback, which is what runs when `ctx.complete` is undefined. Today the
only off-switches are environment variables (context.ts:970). They become one setting, **Background summaries** (default
on), so a user who wants upstream's "no model of its own" posture gets it from Settings.

---

## 2. The sidebar: S1–S3 with All projects as the default

**No sidebar shows ~70 threads, upstream's included.** Upstream's default is one project's board, and it fits 22 rows at
1440x900. Upstream's other 16 projects sit behind a click, or behind the opt-in rail's badges. So S3 does not mean "handles
70"; it means **the default shows at least as much as upstream's default does**. That is the bar here: capacity parity,
measured, and pinned by a test.

All projects stays the default home at `/`. S2 holds because projects never interleave:
- every row sits under its project's header;
- each project's own board is one click away (the switcher, or the project header), at its own URL.

No view setting is added. The URL names the view, so the per-tab `?project=` state goes away.

Measured today (sidebar-report.md, single-line titles, 27.5px rows):

| View and load | 1440x900 | 1920x1080 |
|---|---|---|
| Upstream's board, one project | 22 rows | 28 rows |
| Fork focus mode, one project | 22 rows | 29 rows |
| Fork All projects, upstream's load (17 projects, 70 open) | 11 rows + 6 project headers | 14 rows + 8 project headers |
| Fork All projects, David's load (4 projects, 10 threads) | everything | everything |

### Capacity parity (S3)

- **Project board:** upstream's 22/28 already include its band headers and rules. Adding them to focus mode (below) keeps
  parity by construction.
- **All projects:** the shortfall is group overhead. Each project costs about 60px beyond its rows: a 23px header, a ~23px
  "N more" row, and a 13px rule. **Compact each group to one line:**
  - **The "N more" affordance moves into the header line** as the same explicit text. That keeps David's 2026-10-01 fix ("the
    counts alone proved too hidden") visible without a row of its own.
  - **The rule between groups goes;** the header's own top padding separates them.

  With the group costing about one row, the view fits about upstream's number of lines (thread rows plus project headers).
  Each header carries its project's counts, so at heavy load it shows more status per screen than upstream's board, not less.
- **The gate:** port the measurement (`sidebar/seed-scale.ts` and `sidebar/measure.ts` in the planning scratch directory)
  into one maintained `.ts` e2e test.
  - It seeds upstream's load (17 projects, 70 open) and David's, renders both views, and counts what is visible without
    scrolling at 1440x900 and 1920x1080.
  - It fails if the project board shows fewer rows than upstream's 22/28 (baseline measured on 0a3b9139), or if All projects
    shows fewer lines.

### The project board (focus mode)

URL `/project/<slug>`, upstream's scheme. `?project=<slug>` and `?focus=` redirect to it. In S1's terms it is **at least as
detailed as upstream's sidebar** (U:Sidebar.tsx):

- **The five rails, named, with counts:** Pinned, Queue, Running, Snoozed, Done. External stays apart, never a sixth band
  (96-104).
  - Use the `SectionHeader` the fork still carries (fork `Sidebar.tsx:115`) and upstream's band labels.
  - Upstream's names **Queue** and **Running** replace Ready and Working. The icons stay.
- **Never collapsible:** Pinned, Queue and Running render SectionHeader with no `onToggle` (upstream 381-404). No fold,
  project-level or otherwise, can hide them in this view.
- **Order and rules:** Pinned shows only when non-empty, oldest pin first, any state, Done greyed (244-258). Queue rows carry
  rest times, Running rows don't. There is a rule between Queue and Running when both exist (259-291). Snoozed, Done
  (virtualized) and External are collapsible and collapsed by default.
- **Sub-agent rows under each thread,** restored from upstream (U:Sidebar.tsx:896-924): click into one, dismiss with ×, nested.
  The fork's count stays as the collapsed form.
- **The fork's additions fit in:** a collapsed Schedules header after External, ScheduleMark, rest-time and pin marks, the
  reading marker and row-click scroll (already present).
- **Other projects' counts (rail parity):** the fork's ProjectSwitcher stands in for upstream's opt-in rail. It shows each
  project's Queue, Running and asks counts, not Ready alone. Upstream's home crumb (back to `/`) and the owner/repo link go
  back in StatusRow (U:StatusRow.tsx:133, 176), beside the switcher.

### All projects (home)

URL `/`, also `/all`. It stays David's design: project groups, unlabeled loud rows marked by icon, quiet bands as counts,
project folds, cords, stable queue. Changes:

1. **The compact group** described under capacity parity.
2. **Every thread's rail stays readable (S1).**
   - Each row keeps its band mark: a rest time means Queue, a spinner means Running, a pin mark means Pinned.
   - A folded project's header shows **Pinned, Queue and Running** counts, each with its band glyph. Today it omits Pinned
     (ProjectList.tsx:922-923).
   - Named band headers live in the project board, one click away.
   - If upstream finds per-row marks insufficient here, the fallback is a one-line band label inside a group. It costs lines,
     and the capacity test says how many.
3. **Fix the pinned-Done hole.** A pinned thread that is Done in another project is invisible. `projectsQueues` drops
   archived threads before the pin check (router.ts:5455-5458), and `loudBands` reads pins only from open lists
   (listBands.ts:56). Fix both, plus allQueues.ts:123-127.
4. **The same names:** Queue and Running wherever a band is named (the header over the cards, the drawer stamp).
5. **Upstream's ProjectGrid details** that the fork's desktop lost (path, "Opened 2h", `/slug`) go on the project header's
   hover and menu.
6. **Load (P12):** the 3s `projectsQueues` poll and the idle board prefetch run only while this view is mounted. Moving the
   poll onto the server's SSE stream is a follow-up for heavy loads.

Upstream's objection was that All projects degrades the board. Under this plan upstream's board exists unchanged at
`/project/<slug>`, with at least its detail and at least its capacity, and the default home shows at least as much as its
default at any load.

---

## 3. Upstream changes the fork lost (the parity fixes)

From the parity ledger: of the 26 upstream commits since 2026-09-28 that edited files the fork deleted, **11 are in the
fork, 7 partly, 1 missing and 7 moot**. The fixes below close every gap. Each one lands in the fork's own components rather
than by restoring a deleted file.

**Serious**
- **The steps card is invisible on queue cards** (fe668a8d). `parseFenceBody` strips the hint lines (lib/fenceBlocks.ts:44-47)
  and AllQueuesCard draws the awaiting fence as plain markdown (AllQueuesCard.tsx:592-595). So a rest that hands the human
  `steps:` shows no steps, no note box and no Done / Couldn't do it buttons, except in the drawer. Render the steps card on
  the queue card.
- **Questions on the queue card ignore where they were asked** (e157817a, 22084580). AllQueuesCard draws every open question
  under the newest handoff (357-360, 637-640), and `showsRestedCard` is called without `questionsHere` (625). That is the bug
  e157817a fixed. Port upstream's per-rest placement and the answered-questions stack.
- **Contract contradiction:** the fork's worker contract says the question placement marker "draws nothing" (golden:781).
  But `questionShadow.ts` is byte-identical to upstream and the drawer still places by marker. Either keep upstream's marker
  rendering and fix the contract text, or remove the rendering. **Decision: keep upstream's rendering** (it costs nothing) and
  correct the contract.

**Queue card parity** (upstream's TodosView capabilities, added to AllQueuesCard)
- The transcript: folded middle, "Load earlier", and a per-card collapse (U:TodosView.tsx:85-100, 724-731, 1393-1419).
  Today the card is handoff-only and "Show earlier messages" opens the drawer.
- The resting card.
- A deep link to `/project/<slug>/thread/<t>` for a queued thread lands on its card (U:store.ts:343) instead of always
  opening the drawer (store.ts:368-388). Once it lands on a card, port aad5298d's landing hold.
- `/project/<slug>/status/<s>` resolves to its status view. Restore StatusListView's route, since it is upstream's own file.

**Phone** (upstream's v2 board)
- **Long-press on a phone row opens the thread's actions sheet** (7d768576). Missing, and with swipe-to-triage dropped on
  purpose, phone rows have no actions at all.
- The phone projects list counts **asks**, as upstream changed it to (lib/phonePage.ts:164 counts Ready).
- The file reader's Open footer is hidden on a phone, where it does nothing visible (FileReaderDrawer.tsx:206-211; db0e7568).

**Lightbox** (0e81902b)
- ImageViewer gains pinch, wheel zoom, pan and swipe. Galleries already zoom; a single picture click opens ImageViewer, which
  only does fit/actual-size and ←/→.

**Drawer**
- Restart worker, Reload plugins and Doc stay in the ⋯ menu (fork). A one-click-deeper move is a taste call that loses no
  capability. It is listed in §8 for upstream.

---

## 4. Rules the fork changes, reconciled

Each of upstream's deliberate rules the fork touches, with its disposition. "Fix" means the fork's version answers a real bug and
goes upstream as a PR naming that bug.

| Rule | Fork | Disposition |
|---|---|---|
| A PR watcher never vanishes into the dimmed band (2026-07-22) | Fenced PR parks go to Snoozed | **Moot going forward.** Upstream's own `status: watching` (593afc8c, 10-05) already parks PR watchers in Snoozed with code identical to the fork's. They differ only for older fences without `status:`, which age out. No change. |
| An archived thread whose worker is running lifts back to Running (07-10) | Stays in Done | **Adopt upstream's rule.** Done is collapsed by default, so a running worker filed there is invisible, which breaks S1. If da8ebaf1's motivating case recurs, solve it inside the lift-back (e.g. a "finishing" mark), not by hiding the worker. |
| Register a question immediately and keep working | "Ask last, then rest" | **Fix.** Upstream never queues a running thread, and a registered question shows no [?] while it runs, so the card went unseen. |
| Queue ordered by rest time | Ordered by arrival (`queuedAt`) + 12s settle | **Fix.** A thread released from a wait re-entered with its old rest time and jumped ahead in the queue. |
| The rest's one Send sends every answer | Answers go one at a time, merged into one wake per pass | **Improvement that coexists:** same-pass answers merge, which answers upstream's half-wake worry. |
| A question stays open until answered, dismissed or `unask`ed | A typed message set open questions aside; they were withdrawn at the next rest unless the worker called `keep` | **Adopted upstream's rule** (David 2026-10-07): `keep` and set-aside are gone. |
| Nothing running shows in the queue (08-01) | A turn silent for 15 awake-minutes queued while running | **Adopted upstream's rule** (David 2026-10-07): quiet-turn queueing is gone. |
| A wait always takes the awaiting fence | `message_thread` with `await_reply` parked with no fence | **Adopted upstream's rule** (David 2026-10-07): the rest names the thread under `threads:`. |

---

## 5. The agent-facing surface

The fork's contract and tools stay. Under P6 two cheap changes remove cost without removing a feature:

- **List a tool only when its capability exists.** `editor` only while an editor is connected; terminal-related text only
  when node-pty loads. The server already advertises `__procedures`, so ntwine-mcp can read capabilities from it.
- **Render a contract section only when its feature can fire.** For example, the editor section only with an editor
  connected. Sections for features that are always on stay as they are.
- **Fix the placement-marker text** (§3).
- **Send the generic guidance upstream as small PRs,** each with the failure that motivated it: answer in full prose, give a
  requested list in full, a human question outranks work in flight, run long gates in the background, stop unneeded shells,
  stop critique loops when findings stop falling, exclude `.ntwine/` from repo-wide lint.

---

## 6. Hygiene (makes the fork reviewable by someone new, S4–S5)

- **Re-attribute the fork's quotes.** About 146 `maintainer YYYY-MM-DD` quotes the fork added are David's. Rewrite them as
  `David YYYY-MM-DD`, so "maintainer" keeps meaning upstream's maintainer.
- **A docs pass.** ARCHITECTURE.md, README.md and AGENTS.md disagree with the code on the default view, band names, the rail
  and worktrees. Fix them, then again after §2 lands.
- **Delete finished experiments** (record the conclusion, delete the harness):
  - `scripts/schedule-extract-eval.*` (4,463 + 435 lines);
  - the verify and seed scripts for retired surfaces: `verify-one-view`, `verify-everything-queue`, `seed-everything-queue`,
    `demo-standup`, `probe-hmr-*`, and the rest of the 43 fork-added scripts (12,094 lines) that no maintained test or
    release step runs.
- **Rename `command_thread` → `thread_terminal`** and drop its dead `queued_at`. It never shipped, so no migration is owed.
- **Drop duplicate fixes:** `pending-call.ts` against upstream's `pendingCallDeadline` (keep upstream's, pass awake time in);
  the Monitor expiry; 7c00c397 (= upstream b89f6146).
- **Shrink the bash prefilter corpus** from 1,000 lines to ~100. (Superseded 2026-10-07: the pre-filter is removed.)
- **Small dedupes:** `isDirectory` ×4, `expandHome` ×3.
- **Cut spinoff's legacy side-turn path** (1,533 of its 2,821 server lines), which only Codex, ACP or cross-project parents
  still reach. Do it if those can use the main path. (Done 2026-10-07, with a summary route.)

---

## 7. The plugin system (built, then removed)

Step 9 built a plugin system (loader, web slots, per-plugin database, Settings → Ntwine plugins) to hold features that
don't make the product, with lazy threads as its one plugin. On 2026-10-07 David removed lazy threads and then the
system, since it had no other user: an empty extension API is structure upstream never asked for. It can be restored from
git (`refactor(plugins): remove the Ntwine plugin system`) if a declined feature needs a home. The held-thread primitive
it introduced stays, because a schedule's next run is one.

---

## 8. Getting it upstream (S4)

**Order of offers**, each small and naming the bug or need it answers:

1. **Soundness fixes with no fork dependencies** (from `divergence-report.md`). Each applies cleanly or with 1–2 hunks:
   - 109af220 + 32da3a5c: an approval card auto-denies after 5m instead of freezing the turn.
   - 5dfc85ef: one slow project no longer blocks boot.
   - 1734e48d: the session cache stops being dropped by unrelated writes.
   - 20c498c3: the PATH walk moves off the event loop.
   - 6f731c87 and 8e6a0ddb: symlink removal on Node 25.0–25.3.
   - d89d3729: MCP connection drops during a restart.
   - 4ac1422a: another Claude session's message no longer shows as the operator's.
   - 5efbd4fd: the bypass-mode permission rule.
   - 39541d53: a duplicate wake when a shell finishes.
   - 11f327a0: a worktree thread's edited files are read from the worktree.
   - 8459cf6f: the relay never answers 304.
   - 64e78b5c: a 10s false failure on `xdg-open`.
   - 303d6273: a second interrupt no longer kills the follow-up turn.
   - add52ad1: a prose-only reply no longer cancels a done.
   - 0609f501 + 7a1e60df: a reused PID read as a live daemon can SIGTERM an unrelated process. Check against upstream
     88f468d8 first.
   - 722a566d: a worker inherits the human's `$EDITOR`.
   - From the server audit: awake-time sub-agent staleness, the stray `~/.ntwine` data-root guard, follow-up dedupe, the
     board's fallback when watching `.ntwine` fails, the sign-off nudge exclusions.
2. **The rule fixes from §4:** ask-last, arrival-order queue, merged answers.
3. **The generic contract guidance** (§5).
4. **The VS Code extension and editor bridge.** The extension package is already separate: 70 files, talking through two
   shared protocol files. This is the integration upstream praised at standup.
5. **The project board improvements** that apply to upstream's board as-is: sub-agent rows, schedules header, switcher counts.
6. **All projects, as a design proposal,** with the capacity test as evidence that it shows at least as much as upstream's board
   and keeps every thread's rail readable. Whether it is home or opt-in upstream is upstream's call.
7. **The rest of the fork's features, one at a time:** schedules, terminals, spinoff, model-backed names/status/effort,
   shortcuts, wake lock, Home, messaging. Each goes with its off switch or reason.

**Decisions that are upstream's,** to put upstream rather than to settle in the fork:
- the 10-minute default answer on an unanswered question (it bends "questions carry no timeout");
- the worktree folder rule and cleanup on done;
- the drawer strip moving into ⋯;
- terminals and node-pty in base;
- whether a held thread is acceptable as a base primitive.

**Keeping parity from now on.** The daily merge already records what it does with upstream commits in its merge body.
Make it checkable:
- a `.ts` script lists the upstream commits in the merge that touch files the fork deleted or replaced;
- the merge is incomplete until each has a line in `plans/upstream-parity-ledger.md`, marked reflected (with where),
  ported, or moot (with how its behavior is covered).

Seed that ledger from `parity-ledger.md` after §3 lands. It is also the categorization upstream said it would have agents
produce.

**One standing check.** Run upstream/main's test files against the fork weekly. Every failure is either a ledger entry (an
intended difference, listed in §4) or a parity bug.

---

## 9. Work order and what each step touches

| Step | Touches | Risk | Needs upstream |
|---|---|---|---|
| 1 parity fixes (§3): steps card, question placement, contract text, phone long-press/counts/footer, lightbox | AllQueuesCard, fenceBlocks, phone page, ImageViewer, workerPrompt + goldens | low–medium: queue card is busy code | no |
| 2 project board (§2): `/project/<slug>` replacing `?project=`, named never-collapsible bands, sub-agent rows, StatusRow crumb/link, switcher counts | routes, pageView, ProjectList / Sidebar, StatusRow, ~8 web files | medium: focus mode's look changes; All projects is untouched | no |
| 3 All projects (§2): compact one-line groups, folded counts with Pinned, pinned-Done, names, grid details on hover, poll only while mounted; the capacity test | ProjectList, router `projectsQueues`, allQueues, listBands, one new e2e test | low; the test settles the parity claim | no |
| 4 queue card parity (§3): transcript fold, Load earlier, collapse, resting card, deep-link landing, status route | AllQueuesCard, store, routes | medium | no |
| 5 rules (§4): lift-back adopted; quiet-turn row marking | board.ts, groups | low | no |
| 6 agent surface (§5) | ntwine-mcp, workerPrompt | low | the guidance PRs |
| 7 hygiene (§6) | docs, scripts, quotes, one table | low | no |
| 8 Background summaries setting (§1) | context.ts, settings | low | no |
| 9 plugin seams 1–4, lazy threads out (§7) | ~450 base lines, lazy code moves | medium | the loader, the held thread |
| 10 offers upstream (§8) | per PR | low each | yes |

Steps 1–8 change only the fork, and David's default stays All projects. Each step also lowers the cost of
the daily merge, because the fork's code stops diverging from upstream on the surfaces upstream keeps editing.

---

## 10. Decisions made while implementing steps 1–9 (branch `upstream-superset`, 2026-10-06)

Where the code showed a plan item to be wrong, ambiguous or impossible, this is what was decided and why.
Each line names the step it amends.

**Step 1 (parity fixes)**
- Steps card on the queue card is the drawer's card (numbered steps, one Done), not fe668a8d's note box and
  "Couldn't do it": upstream dropped both itself; `AwaitingSteps.tsx` on 0a3b9139 is byte-identical to the fork's.
  Every action on a card's awaiting card goes to the card's own project.
- Question placement on the queue card follows the drawer's readers. A placement marker picks the rest, but on
  the clamped handoff view the card draws at that rest's end, since a card inside "Show more" is invisible.
  No per-question Send: the fork already sends each answer on its own and merges them server-side.
- Contract text: a placement marker draws its card where it sits, and the contract tells the worker to write
  none. The fork's ask-last guidance is unchanged.
- Phone asks are counted the fork's way (the "?" mark, which includes a pending permission request), off each
  project's own Queue tab, so the list's number always equals the header it opens. Restart worker is not offered
  in the long-press sheet for another project's row (the cross-project send cannot ask for a fresh process).
- Single pictures still open the fork's `ImageViewer`; its zoom now comes from the lightbox's own gesture code
  (`lib/viewerGestures.ts`), so there is one zoom implementation.

**Step 2 (the project board)**
- The board drops the project's own row; the switcher names the project. That line pays for the five band headers:
  the board measured exactly 22 rows at 1440x900 before, with no headroom.
- No rule between Pinned and Queue (Queue's header parts them) and none between two closed quiet headers.
- Sub-agent rows on the board only; All projects keeps the count (its headroom is one line).
- A deep link to a queued thread lands on its card only when the page was opened from outside the tab (a bookmark,
  a pasted URL). Inside the app, threads keep opening drawers, as the fork has since 2026-09-28. All projects, the
  phone and the editor sidebar never land on a card. Upstream's landing hold was still needed, because the fork's
  viewport lock holds the reading line, not the landed card.
- The ⋯ project menu moved into the status row beside the repo link. Folds of the quiet bands persist per project
  in `ntwine.boardOpenBands`, apart from All projects' folds.
- The phone header keeps "working" for the spinning rows (upstream's own phone board says it) and now says "queued"
  for the rest of the queue.

**Step 3 (All projects and the capacity test)**
- Group gap 6px rather than 8: 6px gives 23 lines at 1440x900 (bar 22); 7px and 8px meet the bar exactly with
  no headroom. David found 6px tight on 2026-10-01, with a muted "N more" row above the gap; that row is gone.
  `GROUP_GAP` in `ProjectList.tsx` is the one constant to change.
- "N more" sits right after the project's name, not among the right-edge counts.
- A folded project adds a Pinned count; the existing accent badge is its Queue count.
- `pinnedDone` is a separate field on each project's queue, so no other reader of the open list sees a Done
  thread. `doneCount` excludes pinned Done threads, as the board's Done band does.
- On the project board the cross-project poll slows to 30s for the switcher's counts, rather than reading on open
  (counts would change under the pointer). The notification observer now polls only while the tab is hidden.
- The capacity test boots its own three stacks behind `NTWINE_CAPACITY_E2E=1` and seeds the database directly,
  since no RPC can create a running thread without a real agent.
- Measured on the merged branch: All projects at upstream's load 23 lines at 1440x900 and 30 at 1920x1080 (bars 22 and
  28); the project board with 70 open threads 22 and 29.

**Step 4 (queue card parity)**
- **David 2026-10-06: a card's earlier messages open its drawer** (his 2026-09-29 call, b3872adc). The in-card
  transcript with upstream's folded middle and "Load earlier" was built, verified and then removed; both are in the
  drawer, one click away. The per-card collapse button, steps card, resting card and per-rest questions stay.

**Step 5 (rules)**
- The lift-back reverses da8ebaf1's "Archived → Done whatever the worker is doing"; its other half (a human bump
  really un-archives) stays. The lifted row keeps the Done dim plus the uncheck box with a spinner, which serves as
  the "finishing" mark.
- Quiet-turn queueing needed no code: the row's mark already resolves to the spinner. It is now pinned by a test.

**Step 6 (agent surface)**
- Only `editor` is gated. The fork's other tools back always-on features, and no tool or contract text concerns
  thread terminals, so nothing is gated on node-pty.
- "Capability" means an editor window has this project open, not any editor connected; otherwise every project's
  workers would be shown a tool that answers "none has this project open".
- A new `workerCapabilities` RPC reports it (`__procedures` lists procedures, not live state). ntwine-mcp polls it
  every 10s and notifies the client; Claude Code 2.1.287 re-reads the tool list. The contract section is fixed per
  worker process, so the two can briefly disagree.

**Step 7 (hygiene)**
- `scripts/schedule-extract-eval.*` deleted as listed, though 6554d0ea had kept it that morning as a benchmark. Its
  numbers are in that commit, in the `SCHEDULE_INTERPRETER_MODEL` comment and in `git show 7e0b68b5:plans/schedule-live-reading.md`;
  reverting the commit "chore(scripts): delete the schedule extraction benchmark now that its choice is made"
  restores it (named by subject, since the branch is rebased as `main` moves and its hashes change).
- 29 fork-added scripts deleted (5,124 lines), each with the maintained test that covers it named in the commit;
  14 kept because a skill, test, doc or kept script uses them.
- `command_thread` → `thread_terminal` needed a real migration after all: this machine's database has the table.
  The rename keeps every row; `queued_at` is dropped.
- Upstream's `pendingCallDeadline` kept with the fork's awake time passed in. Two behaviours now follow upstream: a
  dead child mid-call reads stale 15m past its call's deadline (the fork said 2m), and only Bash declares a bound.
- Spinoff's legacy side-turn path is NOT cut. Codex has no session fork in Ntwine's app-server client, ACP has none
  that is portable, cross-project spinoffs use the brief route by David's 2026-09-30 call (cce227b4), and a parent
  with no transcript has nothing to fork.
- Quotes: fork-added `maintainer YYYY-MM-DD` quotes dated from the fork point (2026-09-26) whose text is not in
  upstream's tree now read `David YYYY-MM-DD`.

**Step 8 (Background summaries)**
- Turning it off also disables "Rename with Claude". The three environment variables still work, as off-only
  overrides. It applies without a restart. The phone's settings page, which holds only phone-relevant rows, does
  not list it.

**David 2026-10-06 evening: the project board becomes the default** (supersedes §2's "All projects stays the default
home at `/`"). Upstream's standup needs, read from the 09-30..10-06 notes: projects stay separate (like Claude, ChatGPT
and T3); progressive focus ("hide what the user does not need so they can focus on one chat or one workspace"); a
unified sidebar loses the five rails and does not scale to upstream's 17 projects and ~70 threads; upstream prefers persistent
workspace navigation, "the project sidebar that looks like Discord", to one sidebar holding everything; always-on
status lines may be too dense in the sidebar. David had told upstream a unified sidebar is fine "especially if it is not
the default". So:
- `/` opens the view this browser showed last (`ntwine.lastView`, a board or All projects); a browser that never chose
  lands on a project board (last launched, else the machine order's first). No projects: Welcome. On a phone `/`
  stays the projects list, upstream's phone home.
- All projects lives at `/all` (drawers `/all/<slug>/thread/<t>`); `/?all` and the old aliases redirect there.
- The launcher opens `/project/<own slug>`, as upstream's does; VS Code opens `/project/<slug>?embed=vscode`.
- Picking a view: the switcher (All projects first, then each project with its counts), the board's home crumb (to
  `/all`, standing in for upstream's grid), ⌥↑/⌥↓, ⌘K, and upstream's Discord-style project rail restored as upstream
  ships it: the `projectRail` setting, off by default, with upstream's help text and its light `projectsRailCounts`
  poll. Its top button is the All projects glyph rather than upstream's House, which in this fork is the Home
  workspace.
- On the board, a working row's status line moves into the row's hover (upstream 10-01); All projects keeps it inline.
- Capacity is unchanged, with the rail off and on: All projects 23/30, the board 22/29.

**Step 9 (plugins)**
- User-visible copy says "Ntwine plugins", apart from Claude Code plugins ("Reload plugins"). The final name is
  upstream's call (§8).
- The held thread keeps a downgrade-safe shadow: every held row also carries a non-null `lazy_prompt`, so an
  older server generation reads it as an unstarted thread. Nothing is dropped.
- A schedule's pending run is a row held by `schedules` and keeps its per-run note in `lazy_prompt`.
- An orphaned held row (its plugin missing or failed) is not queued; it sits in Running's place as "Not started",
  with no band stamp, and starts on its next message with base's copy of the latest note.
- `plugins` is a reserved project slug (the `/_ntwine/plugins/<id>/…` asset route).
- Lazy threads shipped in the repo as `plugins/lazy` until 2026-10-07 (below). Existing lazy threads are held
  by `lazy`, a holder that no longer exists, so they wait in Running's place as "Not started".

**2026-10-07: lazy threads removed at David's request**
- `plugins/lazy/`, its installer `plugins/install.ts`, its tests and `plans/lazy-threads.md` are gone. The plugin
  system went the same day (below).
- The held-thread primitive stays, because a schedule's next run is one (`held_by = 'schedules'`). So do the
  `lazy_prompt` column and every migration that maps old lazy rows, so old databases still open: a legacy lazy
  row is an orphaned held row and starts on its next message, on the note base kept.

**2026-10-07: removals before the offer, and the hand-off brought back to upstream's rule (David)**

David asked that nothing reach upstream that reads as bloat. He picked these from a ranked audit, and each is one commit
whose body says what went and what replaced it:
- **The Ntwine plugin system** (`refactor(plugins): remove the Ntwine plugin system`). Held threads stay for schedules;
  the `plugins` slug is no longer reserved; the alternate submit beside Send went with its slot.
- **The desktop app** (`refactor(desktop): remove the Electron desktop app`), with its release workflow and docs.
- **Spinoff's side turn** (`refactor(spinoff): replace the side-turn brief route with a summary Ntwine builds itself`).
  This supersedes Step 7's "NOT cut". A Codex, ACP, cross-project or no-transcript parent now gets a fresh child whose
  prompt carries the parent's request and latest handoff. Nothing reaches the parent, and no model is called.
- **The Bash pre-filter** (`refactor(cc-worker): the per-Bash hook calls node directly; …`). The cost is about 67ms
  p50 per Bash call.
- **Leftover scripts and plans**: three scripts, and the shipped schedule, time-limit and VS Code plans, folded into
  ARCHITECTURE.md.

Not removed, after the audit: terminals, schedules and their live reading, time limits, cords, ImageViewer, Remote
access in Settings, the rarely-used settings and thread info.

From upstream's tenets on hand-off (the worker's own last word decides a thread's state; Ntwine only checks it), David
chose three changes:
- **A typed message leaves questions open.** Set-aside and `keep` are gone, so Ntwine never withdraws a question by
  omission. This supersedes §4's row and §8's item. The 10-minute default still skips a question the human typed past.
- **A wait on another thread takes the awaiting fence**, naming it under `threads:`. `await_reply` no longer parks on
  its own, and its own timeout is gone; the fence's `for:` is the timeout.
- **A running thread never queues.** Quiet-turn queueing is gone, superseding Step 5's note. A terminal waiting at a
  prompt still queues its thread, which is a separate rule from the same commit.

Kept by David's choice, and documented in ARCHITECTURE.md as Ntwine acting on a clock or with a model: the 10-minute
default answer, the 30-minute check-in on sub-agent parks, model-written names and status lines (Background
summaries), and per-question delivery.

The worker contract went back to rules, not rationale: no worker anecdotes, no dated quotes, and the
"a login is a question" rule replaced by `steps:`.
