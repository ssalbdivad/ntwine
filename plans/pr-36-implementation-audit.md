# PR #36 — light-mode implementation audit

Verified September 19, 2026, with the control corrections on local `main` at `e35d440e`. This supersedes the visual-change recommendation in [the original review](pr-36-review.md). The maintainer approved the third mockup's light-gray outline treatment, then requested quieter icon buttons and single-frame segmented controls.

[Open the 10-screenshot control refinements](file:///Users/me/Documents/projects/ntwine/.ntwine/threads/6219833f-167e-41b1-8f63-63259a8ef30e/control-refinements.html).
[Open the 32-screenshot review gallery](file:///Users/me/Documents/projects/ntwine/.ntwine/threads/6219833f-167e-41b1-8f63-63259a8ef30e/screenshots.html).

## What changed

- Light surfaces use a neutral scale: `#f7f7f7` canvas, white questions, `#dcdcdc` question outlines, and neutral prompt/message fills. Blue `#416896` is reserved for actions and selection; semantic warnings, errors, GitHub states and syntax colors remain distinct.
- Text/action buttons retain subtle inset outlines. Clean icon actions are borderless at rest in both palettes, with an edge on pointer hover or keyboard focus. Touch devices do not retain hover rings; the composer keeps its black filled Send button.
- Segmented controls have one outer frame, not separate outlines on each option. Dropdowns and text fields share the same light-gray border, including the GitHub triage prompt. Stronger checkbox and recovery boundaries remain unchanged.
- The recommendation badge fits inside the first answer line. Its compact height replaces the taller pill; wrapped answers still reclaim the full width below it.
- Light shadows are attenuated centrally, rather than carrying dark-mode-strength black shadows. Existing dark shadow strengths and palette values are retained.
- Mono is no longer a preference. Application typography is sans, including first paint and a stale saved Mono choice. Code, terminal output and literal technical fields retain their own monospace formatting.
- Appearance is browser-local: System, Light or Dark. It remains usable while server settings are unavailable. The existing project-sidebar, notification and dispatch settings remain independent.

The implementation retains the PR's semantic-token approach instead of adding per-component theme conditionals. [Theme ownership](../packages/web/src/lib/theme.ts), [palette tokens](../packages/web/src/theme.css), [first paint](../packages/web/index.html), and [standalone recovery](../packages/server/src/supervisor-pages.ts) agree. Changes to palette adapters preserve mounted terminals and interactive visualizations; Mermaid jobs serialize their global renderer configuration.

## Visible-surface coverage

The source audit covered all 89 production TSX component files, their shared style helpers, global CSS, and standalone recovery HTML. Browser coverage spans every major visible family below, not every possible combination of provider response, content and interaction state.

| Surface family | Browser coverage |
| --- | --- |
| Navigation and projects | Real project grid, rename/error/delete controls, project rail, desktop queue/running/snoozed/done bands, phone navigation, status list and toast |
| Threads | Real standalone transcript, stacked thread sheet, titles, header actions, lifecycle footer, activity rail and expanded tool output |
| Questions and cards | Real question selection and mobile reply; component fixtures for completion, awaiting, timer, PR/issue watches, single/multi/danger questions, refusals, pending asks, approval and provider errors |
| Composers | Real new-thread/reply controls; first-run fixture, model/effort picker, permission controls, attachment/GitHub/send buttons |
| Settings | Real appearance selection, persistence, server-setting failure, project-sidebar toggle, contextual Claude/Codex controls; quota and Goal fixtures |
| GitHub | Real picker/hovercard components with deterministic issue/PR/label responses, selection and prompt settings; no GitHub mutation |
| Readers | Real code/diff/Mermaid/interactive visualization; production file/Markdown/background-shell/sub-agent panels with fixture responses |
| Authentication and recovery | Real login terminal over one WebSocket; sign-in/error/restart component states; promoted artifact recovery after its disposable child is killed and assets removed |
| Shared primitives | Dialog, sheet, menu, popover, select, switch, tooltip, button/header styles, text/link/image wrappers and status marks exercised through their owning surfaces |

Direct source review also covers wrapper-only paths such as `ThreadDrawer`, `DrawerStack`, link wrappers and timestamp formatting. Their shared readers and primitives are rendered above; this audit does not claim a separate screenshot of every wrapper or a live provider session for each fixture.

## Verification

| Gate | Result |
| --- | --- |
| `nub run typecheck` | Passed |
| `nub run test` | 4,766 tests: 4,670 passed, 96 skipped, no failures |
| CI's board parser / portable monitor / sync checks | 73 board tests and 16 monitor tests passed; portable copies match |
| Contextual settings browser tests | 11 passed across agent settings, GitHub prompt and settings autosave |
| `verify-light-mode.mjs` | 61 passing checks against an isolated real Ntwine stack |
| `verify-light-mode-gallery.mjs` | 176 component captures at 1100px/390px, light/dark; no document overflow or unexpected console/page errors |
| `verify-control-chrome.mjs` | Light/dark at 1100px/390px; no resting icon edges, hover/focus edges present, no sticky touch edge, short/long/legacy recommendation alignment |
| `verify-light-mode-artifact.mjs` | Promoted production UI, complete compiled token set, asset-independent recovery, anonymous refusal and OS/persisted appearance passed |

All gates were rerun after the control corrections. The promoted artifact digest was `79646c24d8e297f48aa2614705d2f85c8bf9fece39ab44e6c1815c6a290b8675`. Both file-URL galleries loaded every image, opened full-size links, and had no external requests, page errors or horizontal overflow at desktop and 390px.

The real-stack run deliberately induces two project-rename refusals and asserts their HTTP 500 responses; those are expected console entries, not ignored failures. The gallery and promoted recovery have no unexpected errors. All owned Chrome instances, servers and disposable artifact processes were closed.

Visible enabled light text sampled by the harness meets 4.5:1. This is not a blanket accessibility certification: subtle decorative outlines intentionally have lower contrast, and disabled controls are excluded. Recovery's interactive boundary measures 3.54:1. The probes settle finite transitions and measure the actual gradient stops of animated text, not its transparent CSS `color`.

Optical measurements: resting composer ink gaps are **14.5px / 14.87px** in both palettes at device scale 8; the profile caret's cap-band residual is **−0.228px** at both widths in both palettes. The recommendation badge is **13.5px** tall (previously 17.0625px), with text/border cap-band residuals of **−0.119px / −0.022px** at both widths in both palettes. Enlarged captures were inspected as well as measured. Selected screenshots in the galleries were reviewed for wrapping, clipping, alignment, border weight and inconsistent fills.

## Findings resolved during verification

- Permission-approval cards still used a blue wash; they now share the neutral question treatment.
- GitHub picker labels used arbitrary external hues directly as text; they now share the hovercard's readable theme-aware label helper.
- The first implementation outlined icon buttons and individual segments too broadly. Icon actions now use one shared hover/focus utility; segmented options use only their enclosing frame. Composer offsets again follow bare-icon ink rather than outlined boxes.
- Dropdowns and the triage prompt had stronger frames than adjacent segmented controls. They now use the shared decorative border token; select carets and focus indicators retain their stronger affordance.
- Dark-only modal shadows and one white-only GitHub hover treatment survived the first token pass; both now use theme tokens.
- A full-suite run exposed a race in the supervisor test's foreign-progress fixture: it briefly published the child's genuine PID before replacing it. The fixture now writes only the foreign PID; the strict assertion and production behavior are unchanged.

No PR was opened, pushed, reviewed or closed through GitHub during implementation. No npm release, production restart, provider approval or live provider dispatch was performed.
