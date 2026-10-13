# Server patch release verification

## Popover patch 0.13.2

Published `ntwine-server@0.13.2` from `4fdc8d69fd350002a19fe27ff37839ecad1045ab` after explicit release authorization. The shell remains `ntwine@0.13.0`; the workflow skipped shell publication and retained the original `v0.13.0` tag at `ba088812`. Upstream release run 34648565761 and CI runs `34648565850` / `34648563193` completed successfully.

- The restart popover now shows only the application version, with no launcher diagnostic line. Historical fixture values such as `0.4.2` are test inputs, not installed or published versions. The release evidence uses the actual public artifact displaying `0.13.2`.
- The exact isolated candidate passed frozen installation, typecheck, 4,544 tests with 83 skips and zero failures, board 73/73, monitors 16/16 and monitor synchronization. A clean packed-package browser upgrade passed before publication.
- Public npm/Chrome verification installed `ntwine@0.13.0`, bootstrapped its pinned server, and clicked the real browser update to `ntwine-server@0.13.2`. All downloaded package integrities matched the registry. Launcher PID `38710` and public port `50540` remained unchanged; 383 status probes succeeded.
- Real Codex daemon PID `39785`, generation `92d36f5c-9b39-4cc7-946f-6edf8b1fb913`, survived the update during a 30s terminal command and answered a follow-up. Settings, server restart and committed selection across full launcher relaunch passed.
- The actual published popover, desktop and narrow screenshots were inspected; no launcher label, stale fixture version, unexpected browser error or horizontal overflow. The same component's prior both-font optical pass measured a `10.33px` horizontal ink gap and `0.50px` vertical residual. Expected absent-icon 404 and explicit-handoff RPC 503/WebSocket reconnect events are separately recorded.
- All owned browsers, npm/launcher/server/worker processes were cleaned up. Production was not restarted or modified. This published runtime check ran on macOS, not Windows.

Evidence: `.ntwine/threads/83fb409a-c418-422d-8173-c7fb7823d626/popover-release/`, particularly `published-server.json`, `published-shell.json`, `public-smoke/result.json`, `public-smoke/updated-popover.png`, `public-smoke/worker-transcript.json`, and `public-smoke/cleanup.json`.

## Initial split release

Published `ntwine-server@0.13.1` and the initial stable shell `ntwine@0.13.0` from `ba0888128527ffe8f5287d00844a93e96766d2b3`. The release was explicitly authorized. No production server, project registry, or settings were changed by the tests.

## Publication

| Check | Observed result |
| --- | --- |
| npm server | `ntwine-server@0.13.1`; registry `gitHead` equals `ba088812` |
| npm shell | `ntwine@0.13.0`; registry `gitHead` equals `ba088812` |
| Authentication | Both packages accepted through npm Trusted Publishing, with provenance attestations |
| Shell tag | Remote annotated `v0.13.0` peels to `ba088812`, not the reconciliation commit |
| GitHub release | upstream v0.13.0, published, not draft/prerelease |
| Reconciliation | upstream run 34645415424, attempt 2, successful at `089af8ae`; both package publishes skipped |
| CI | Main/release runs `34645412007` and `34645415123` successful at `089af8ae` |

The shell remains pinned to bootstrap server `0.13.0`. This deliberately exercised a real published `0.13.0 → 0.13.1` update rather than booting directly into the candidate. Compatible later server selections persist independently of that bootstrap pin.

## Published-package browser test

The harness used a new HOME, XDG directories, npm cache, git project and loopback port. It downloaded the three tarballs from npm and checked their SHA-512 integrity against registry metadata. In public mode there was no private registry, rewritten package metadata, instrumented server bundle or mocked update response.

| Contract | Observed result |
| --- | --- |
| Browser action | Chrome's update button sent the real request and displayed server `0.13.1`, launcher `0.13.0` afterward |
| Stable owner | Launcher PID `77296` and public port `58195` unchanged across the update and server restart |
| Public recovery endpoint | 361 successful status probes, sampled every 100ms; no failed requests |
| Server handoff | Old server PID `77681` exited; replacement PID `79937` served the updated version |
| Worker continuity | Real Codex daemon PID `78298`, generation `47a00c65-2bcb-462c-9936-5aba8583b219`, unchanged across update and follow-up |
| In-flight command | A real 30s terminal command completed through the update; the same session then wrote another file and answered `RECONNECTED-OK` |
| Durable state | Font setting survived; active selection committed `0.13.1`; a full launcher stop/relaunch retained `0.13.1` instead of reverting to bootstrap |
| Negative control | Cross-origin update request rejected with HTTP 403 |
| Browser inspection | Desktop and narrow screenshots read back; version labels readable, popover balanced, no horizontal overflow |
| Browser errors | No unexpected errors; absent project-icon 404 plus RPC 503/WebSocket reconnect events during the explicit handoff window recorded separately |
| Cleanup | Browser, launcher, npm process, observed server children and detached worker stopped; remaining child/worker PID lists empty |

The same clean-artifact update/restart/relaunch path passed before publication using the locally packed candidate and the already-published bootstrap server. That run retained launcher PID `48056` and completed 57 successful listener probes.

Evidence is under `.ntwine/threads/83fb409a-c418-422d-8173-c7fb7823d626/patch-release/`: `public-smoke/result.json`, `public-smoke/worker-transcript.json`, `public-smoke/updated-desktop.png`, `public-smoke/updated-narrow.png`, `public-smoke/cleanup.json`, registry metadata files, and workflow logs. The reusable harness is `scripts/verify-server-package.mjs`; its public mode takes `--shell`, `--server`, `--update`, `--public=1`, `--worker=codex`, and `--out`.

## Release failures found and resolved

1. Publication run `34644864691` accepted both packages, then an immediate npm metadata read returned 404. The new `scripts/published-git-head.mjs` waits for the exact published version with a bounded deadline. Real HTTP tests cover delayed visibility, an absent version, invalid/missing commit metadata, version mismatch and authorization failure. It never uses the current workflow commit as a fallback.
2. The next run correctly selected the old published commit, but GitHub rejected tag creation because that historical workflow revision required permission unavailable to the workflow token. The authorized maintainer checkout created the tag at the registry commit. Reconciliation attempt 2 then completed without republishing either package. The [publishing guide](stable-server-publishing.md#recovery-after-publication) records this recovery procedure; no credentials or CI permissions were added.

## Gates and limits

The isolated published snapshot passed frozen pnpm installation, typecheck, 4,538 tests with 83 skips and no failures, board 73/73, monitors 16/16 and portable-monitor synchronization. After the harness and metadata repair, `089af8ae` passed typecheck and the full suite again: 4,544 passed, 83 skipped, zero failures, plus both CI suites and monitor synchronization.

This release's published-process/browser test ran on macOS with Node `26.7.0` and a real Codex worker. No Windows runtime pass is claimed. The preceding redesign's Node-floor, both-provider, singleton, corruption, crash, timeout and compatibility matrix is documented separately in [stable server update verification](stable-server-update-verification-2026-09-11.md). Finite tests do not establish literal 100% certainty.
