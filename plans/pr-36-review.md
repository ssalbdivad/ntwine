# PR #36 review — light mode

Reviewed 2026-09-16. This is an investigation record, not current product documentation.

**Superseded September 19:** the maintainer approved the light-gray outline treatment. The implementation removes the Mono preference, adds subtle button outlines and neutralizes the light palette. See the [implementation audit and screenshots](pr-36-implementation-audit.md) for the current disposition and verification.

## Recommendation

**Request visual changes before merging.** Light mode is useful and its architecture is appropriate. The latest head fixes the two text-contrast findings below, but the light palette still mixes several cool grays, pale-blue sent messages and gold selection. Simplify the large surfaces to a restrained neutral hierarchy before treating the design as ready. The earlier recommendation focused too narrowly on contrast compliance.

The review made no product changes and posted nothing on GitHub.

## Sans-serif and palette follow-up

Fresh captures on 2026-09-16 use head `35a8f60264bdb57844a47c5a64f0850953f6a92d`, not the original review head. This commit incorporates local `main` through `2d2ee9e4` and the review fixes.

**Sans-serif is already the default**, on local `main` and the PR. The server default (upstream `35a8f602:packages/server/src/settings.ts#L80`), first-paint guard (upstream `35a8f602:packages/web/index.html#L43-L46`), and runtime font owner (upstream `35a8f602:packages/web/src/lib/font.ts#L23-L26`) agree. A fresh isolated server returned `font: "sans"`; a clean Chrome profile rendered `data-font="sans"` with the system sans-serif stack before any font setting was changed. Mono requires an explicit saved choice. The previous diagnostic screenshot showed Mono because the save-status reproduction deliberately switched fonts, not because Mono was the default. No default change is needed.

The real board's computed fills explain the visual concern:

| Surface | Light fill |
| --- | --- |
| Transcript card | `#ffffff` |
| Page and both prompt composers | `#f6f8fa` |
| Question block | `#f1f4f7` |
| Sent user prompt | `#dbeafe` |

These come from the light palette (upstream `35a8f602:packages/web/src/theme.css#L255-L280`), not screenshot color processing. The question block and composers are slightly different blue-grays; the sent prompt adds a much stronger blue. Gold remains the selection/action accent. Different surface depths are useful, but this combination draws attention to filled rectangles without a clear relationship between their hues. That is a design judgment, not a claim that different shades are inherently an accessibility failure.

**Smallest revision:** retain the semantic tokens and renderer adapters; tune the light surface, border and user-bubble values as one family. Use white and a small neutral-gray scale for large surfaces, including sent prompts, and reserve accent color for selection, actions and meaningful status. Keep the dark palette unchanged. Compare the real board and question/composer pair in Sans first, then recheck Mono, narrow widths and contrast. This is a palette pass, not a component rewrite; allow roughly half a day including visual review and regression checks.

Fresh evidence, captured at 1440px and 390px with device scale 2:

- [Sans board with both prompt composers and question card](../.ntwine/threads/6219833f-167e-41b1-8f63-63259a8ef30e/evidence/sans-current/light-sans-board.png)
- [Close view of the question, sent prompt and reply composer](../.ntwine/threads/6219833f-167e-41b1-8f63-63259a8ef30e/evidence/sans-current/light-sans-question-card.png)
- [Sans phone view](../.ntwine/threads/6219833f-167e-41b1-8f63-63259a8ef30e/evidence/sans-current/light-sans-phone.png)
- [Settings showing Sans](../.ntwine/threads/6219833f-167e-41b1-8f63-63259a8ef30e/evidence/sans-current/light-sans-settings.png)
- [Reproduction script](../.ntwine/threads/6219833f-167e-41b1-8f63-63259a8ef30e/sans-capture.mjs) and [computed readings](../.ntwine/threads/6219833f-167e-41b1-8f63-63259a8ef30e/evidence/sans-current/readings.json)

The latest head's provisional title now measures **5.08:1** and the settled Settings “Saved” label **5.41:1** in Light. Both original defects are resolved. The new screenshots were inspected; the phone view has no horizontal overflow, and Chrome recorded no console or page errors. All owned browser/server processes exited and both listening ports were checked closed. The old posting question was withdrawn because it requested fixes already present.

Latest CI passes (upstream run 35146461143); Pullfrog still fails (upstream run 35146460578) on the provider usage limit. This follow-up exercised the real source stack with seeded threads, not a promoted build or live provider dispatch. The complete test and artifact results below remain evidence for the original head only; the newer integration has not received another full review here.

## Scope and classification

The upstream PR #36 is a **FEATURE**, not a bug report. Current local `main` has no appearance preference or light palette. The proposal gives operators a light workspace or OS-following appearance while retaining an explicit Dark choice. It changes almost every rendered surface, not the server's project model or dispatch API.

- Reviewed head: `6c0c94471dc5968b1af01dd239bd375996d7ddde`.
- Read the body, all discussion and reviews, inline review comments, labels (none), and changes. Prior contrast/hover findings were resolved; they are not outstanding findings in this report.
- Compared against local `main`, including `803399d8b8642c5ad615ef9845f4ac55fa369799`. GitHub's base and this machine's active development branch differ.
- Diff from the shared ancestor: 119 files, 3,117 insertions and 658 deletions, including fixtures, tests and verification scripts.

## Original findings — resolved in the latest head

### P2 — remaining dark-mode opacity treatments reduce light text contrast

Both states render real, enabled text below the PR's own 4.5:1 target. These are omissions in the migration, not failures of the overall theme model.

| State | Observed in light mode | Cause and smallest correction |
| --- | --- | --- |
| Provisional sidebar title, “Spinning up a thread…” | **3.11:1**, 13px text; the same rendered row in Dark measured **4.55:1** | The title branch (upstream `6c0c9447:packages/web/src/components/Sidebar.tsx#L636`) retains `text-fg/50`. Give provisional-title ink a theme-aware token with its existing dark value and opaque readable light value. |
| Settings “Saved” status | **3.24:1**, 11px text on white | The save status (upstream `6c0c9447:packages/web/src/components/SettingsDrawer.tsx#L294-L301`) retains `text-muted opacity-70`. Apply the existing `text-muted-70` semantic treatment without multiplying whole-element opacity; preserve the dark appearance. |

Reproduction used the exact PR head in an isolated real stack and Chrome:

1. Set Appearance to Light, open Settings, switch Font from Sans to Mono, and measure the actual “Saved” result after opacity settles. This used the real settings mutation, not a fabricated status element.
2. Supply a valid fresh-thread state to the real board store: `titleAuto: true`, empty `aiTitle`, and a current `spawnedAt`. Measure the unmodified `ThreadRow`, then switch the same page to Dark as a control. This is a renderer reproduction; no live model was dispatched for this state.

The independent probe is [review-extra.mjs](../.ntwine/threads/6219833f-167e-41b1-8f63-63259a8ef30e/review-extra.mjs), with measured output in [review-extra.json](../.ntwine/threads/6219833f-167e-41b1-8f63-63259a8ef30e/evidence/review-extra.json). It can run after recreating the reviewed checkout at the adjacent `pr36` path and installing its dependencies.

The acceptance harness passes because the fixture has named threads and its settings checks do not capture a completed server-settings save. Add both states to `scripts/lib/light-mode-fixture.mjs` / `scripts/lib/light-mode-surfaces.mjs`, retaining the existing composited-contrast sampler. This requires changes to the two components, `theme.css`, and the targeted checks. Risk is low if the dark values remain unchanged; a global increase in text opacity would unnecessarily alter the whole app.

### Local integration requirement — preserve ACP provider marks

The non-mutating command `git merge-tree --write-tree 6c0c9447 803399d8` reports a content conflict in `packages/web/src/components/ProviderMark.tsx`. The resolution must combine the PR's `text-muted-65` token with current main's `PROVIDER_MARK_GEOMETRY[provider.key]` and expanded provider dispatch. Taking either side wholesale loses a required change. This is local branch drift, not an author defect against GitHub's currently mergeable base.

Also migrate the newly added unknown-status mark in `AwaitingBackgroundCard.tsx`, which still introduces `text-muted/60` on local main. Recheck the integrated provider marks and watch rows in both themes; the PR-head browser evidence cannot certify code added after that head.

## Design assessment

| Area | Assessment |
| --- | --- |
| Preference and startup | A dedicated browser-local `ntwine-theme` key, separate preference/resolved values, pre-paint resolution, OS changes and cross-tab synchronization fit the use case. No database migration or server setting is needed. The tested denied-storage and unavailable-settings paths still work. |
| CSS migration | Root-selected semantic palettes are better than duplicating components, adding per-call-site `dark:` branches, or inverting the page. Separate ink/fill/on-fill roles and explicit light secondary text address the real contrast problem. |
| Terminal | The palette updates through `term.options.theme`, outside the effect owning the terminal and socket. The real login-terminal test preserved buffer, selection, focus and one connection. Explicit process true-color output correctly remains content-owned. |
| Mermaid | Serializing configuration and rendering is justified because the imported renderer has global configuration. Captured palettes, unique IDs, stale-result rejection and rejection cleanup are appropriate. The browser run exercised multiple diagrams, rapid changes and malformed-source recovery. |
| Visualizations | The correlated ready/applied bridge avoids remounting interactive content. Source checks and `sandbox="allow-scripts"` remain in place. Browser checks covered first visible palette, retained counter state, resizing and the no-ack timeout. |
| GitHub, code and diffs | Theme variables replace literal colors; the former hex-suffix composition is corrected. GitHub label hues remain external data with readable light foregrounds. Actual card components were exercised with fixture responses, not live GitHub E2E. |
| Recovery | Inline palettes are necessary when web assets are absent. The promoted artifact retained Light through deliberate child termination and asset removal. Anonymous refusal pages stayed unbranded and OS-driven. |

The main product consequence is **System becomes the default for existing browsers too**. Someone using a light OS will see a different appearance immediately after upgrading, without changing Settings. This is deliberate in the design (upstream `6c0c9447:plans/light-mode-architecture.md#L15-L17`), not an accidental persistence bug. System is a reasonable default for this feature; it should be an explicit release decision rather than described as preserving every user's appearance.

The smallest viable version is essentially this architecture: two palettes, one local preference owner, startup/recovery guards and adapters only where CSS cannot reach. Enabling Light before the migration is complete would be worse than this broad but cohesive PR. Remaining contrast work is roughly half a day; allow another half-day for current-main integration and repeat browser/artifact verification. This estimate excludes new product requirements.

The Appearance label and help copy are short and consistent with the app. The architecture document is appropriately archived, but its closing “Model the Domain”, “Laziness Protocol” and “Poteto principles” paragraph adds no implementation guidance and can be removed. That is non-blocking editorial cleanup.

## Verification

All commands ran against the isolated exact PR head, not the shared dirty checkout.

| Check | Result |
| --- | --- |
| `nub install --frozen-lockfile` | Completed; no tracked dependency changes |
| `nub run typecheck` | Passed |
| Web `nub run build` | Passed; existing large-chunk warning |
| Board/monitor tests and portable-monitor sync check | **89 passed**, sync check passed |
| Focused theme, renderer, visualization and supervisor tests | **24 passed** |
| Non-E2E web tests through the guarded repository runner | **1,305 passed**, no failures/skips/cancellations |
| `nub scripts/verify-light-mode.mjs` | **77 checks passed**, no console/page errors |
| `nub scripts/verify-light-mode-artifact.mjs` | **11 checks passed**, no page errors |
| Independent missing-state probe | Reproduced the two contrast failures above; no page errors |

The browser run used port `45931` and `THEME_EVIDENCE_DIR` pointing into this thread's `evidence` directory. The artifact run used port `45935`. The full non-E2E web command was `find packages/web/src -name '*.test.ts' ! -name '*.e2e.test.ts' -print0 | xargs -0 nub run test`.

Desktop, 390px phone, both fonts and both themes were exercised. Inspected screenshots include the board, phone queue, settings, code/Mermaid, GitHub cards, Appearance crop and recovery. The Appearance caret's measured cap-band residual was **0px in both fonts**; horizontal ink-gap measurements and high-resolution crops were also produced. No new layout defect was found in the inspected states. The original hover finding is now tested through compiled CSS rules with an explicitly identified no-hover-host fallback, not a fake inline opacity replacement.

Evidence lives in [the local evidence directory](../.ntwine/threads/6219833f-167e-41b1-8f63-63259a8ef30e/evidence/). The promoted artifact digest was `db83f0576f815a8c06a34992dc9131031167f54a93bf3464e27a793e0c7b5a8f`. All owned browsers, servers and proxies were closed; the owned listening ports and recorded browser PIDs were checked afterward.

Limits: the full provider-dependent monorepo suite was not run, Safari/Firefox were not exercised, and current-main integration was inspected but not built. Source-regex adapter tests alone are weak lifecycle evidence; the actual browser and artifact runs supply that evidence here. The suite samples visible states and does not prove universal contrast, as the additional probe demonstrates.

## CI and discussion

The exact head's CI check (upstream run 34888246180) passed. That workflow runs board/monitor checks, not the web browser acceptance suite. The latest Pullfrog run (upstream run 34888244892) failed on provider usage limits before completing a review. Its logs also contain a frozen-install overrides mismatch. Neither is evidence of a light-mode runtime regression, and the last successful bot review predates the latest PR merge commit.

## Proposed public review

Request changes, with this summary; not posted:

> The two reported text-contrast defects are fixed at 35a8f602; the fresh light-mode readings are 5.08:1 and 5.41:1. The remaining concern is the palette itself: blue-gray question blocks and composers, pale-blue sent prompts, white cards and gold selection compete rather than forming a restrained hierarchy. Please simplify the large light-mode surfaces to a neutral family, retain deliberate accent/status colors, and verify the question/composer pair in the default Sans font at desktop and phone widths before merging. The theme architecture does not need a rewrite.
