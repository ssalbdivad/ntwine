# Stable launcher/server verification — 2026-09-11

The implementation separates the public `ntwine` launcher from unscoped `ntwine-server`. Ordinary updates replace only the server child and its matched frontend/runtime closure. No npm publication or production restart was performed for this effort. Verification establishes the exercised behavior below, not literal certainty about every platform or future release.

## Design and safety boundary

- The launcher retains its PID, terminal, public proxy, recovery listener and global ownership lease through ordinary server updates. A second repository joins that listener even on a custom port or during child downtime; a cold owner without a published address blocks a competing launch.
- The old server serves while npm installs into a fresh immutable generation. The installer invokes npm's JavaScript entry with the current Node executable, a private prefix, lifecycle scripts disabled and a bounded timeout. It does not invoke shell startup hooks or globally upgrade Node, FNM, Claude Code or Codex.
- The old child exits before the candidate starts. The candidate must prove owner-bound readiness and survive a stability interval before the active selection is atomically committed. Install, validation, startup, timeout and early-crash failures leave or restore the previous same-epoch server.
- Each child registers under the machine-wide owner before opening server state. After a launcher crash, a different repository cannot acquire that owner while a live control-plane delegate remains. Global owner tests use actual competing processes and a launcher killed with `SIGKILL`.
- A monotonic global data-compatibility marker advances before a new-epoch candidate can write, including the crash-before-readiness window. Lower-epoch shells refuse it; corrupt selections and protocol mismatches fail closed. This does not make arbitrary migrations reversible or protect manual downgrades to pre-split binaries that never implemented the marker.
- Server generations retain the provider daemon files and worker-plugin closure. Existing detached workers can keep their old files and resume with the replacement server. The server already owns exact private runtime pins: Claude Code `2.1.268`, Codex `0.154.0`; explicit binary overrides and the existing warned PATH fallback remain unchanged.

Implementation: [`src/production.ts`](../src/production.ts), [`src/server-release.ts`](../src/server-release.ts), [`src/server-owner.ts`](../src/server-owner.ts), [`dev-supervisor.ts`](../packages/server/src/dev-supervisor.ts), [`dev-child.ts`](../packages/server/src/dev-child.ts).

## Actual packed npm and browser matrix

The reproducible harness is [`scripts/verify-server-updates.mjs`](../scripts/verify-server-updates.mjs). It packs the built launcher and instrumented copies of real server bundles, serves them through a private local npm registry, then uses real npm execution, real child processes and headless Chrome. Fault injection adds process observations or a specified failure; it does not replace the production installer, supervisor, storage, HTTP or browser code. These fixture tarballs are **not release artifacts**.

Evidence lives under `.ntwine/threads/83fb409a-c418-422d-8173-c7fb7823d626/` in the maintainer checkout. Each run's `evidence.json` includes process generations, status outcomes and cleanup.

| Case | Observed result | Evidence directory |
| --- | --- | --- |
| Published monolith `0.12.10` to split launcher `0.13.0`, clicked in Chrome | New stable launcher booted its managed server | `server-final-worker` |
| Update download held open; simultaneous restart/update requests | Old board stayed available, requests coalesced, launcher PID unchanged | `server-singleton-final2` |
| Second repository during cold download | Exited with a busy diagnostic; no second child | `server-singleton-final2` |
| Second repository during download and hung candidate, custom public port | Joined the existing listener; no second child | `server-singleton-final2` |
| Incompatible epoch/protocol or missing frontend file | Rejected before disturbing the old server | `server-singleton-final2` |
| Registry HTTP 503 and corrupted tarball integrity | npm failed; old server remained usable | `server-singleton-final2` |
| Candidate throws, exits 100ms after ready, or hangs for 30s | Candidate stopped; previous server restored; browser retry succeeded | `server-singleton-final2` |
| Launcher killed before candidate commit | Child noticed disconnect; next launcher loaded the previous committed selection | `server-singleton-final2` |
| Launcher killed after commit | Next launcher selected the committed version | `server-singleton-final2` |
| Managed cache removed after clean shutdown | Exact committed version reinstalled, not the shell's older bootstrap default | `server-singleton-final2` |
| Real Codex worker running a 20s command during update | Same provider generation survived; follow-up answered | `server-final-worker` |
| Real Claude worker running a 20s command during update | Same broker generation survived; follow-up answered | `server-node-floor2` |
| Minimum supported Node | Actual Node `22.13.0` used by npm bins and every instrumented child | `server-node-floor2`, `server-node-floor3`, `server-singleton-final2` |

The final singleton matrix used launcher PID `31041` throughout ordinary updates. No overlapping server processes or failed public-status probes were observed. Application sockets can disconnect during the serial handoff; that is distinct from losing the public recovery listener. Intentional launcher kills caused the expected connection-refused browser messages. JavaScript page errors were absent. Owned Chrome instances, launchers, server children and provider daemons were closed; final cleanup reported no remaining owned PIDs.

Two test-instrument errors were corrected rather than misreported as product defects: a cold-download gate initially held both package names sharing version `0.13.0`, and a requested minimum-Node run initially left a newer Node first on PATH for npm's bin shebang. The final harness gates only `ntwine-server` and asserts the actual child Node version.

After the frozen pnpm install and final package build, the combined singleton/failure/worker matrix passed again in `server-ci-workers`, using actual Node `22.13.0`. Launcher PID `73417` stayed fixed through ordinary updates. Codex PID `76381` and Claude PID `77858` retained their generations and answered follow-ups. The earlier `server-main-workers` run additionally repeated the legacy `0.12.10` browser handoff on the merged source with both providers active.

## Unmodified release candidates

The final artifacts were produced through the real root `npm pack` lifecycle and standalone server pack after `CI=1 pnpm install --frozen-lockfile`; typecheck passed on that installed dependency graph. Unlike the failure fixtures, these tarballs contain no test instrumentation. [`scripts/verify-server-package.mjs`](../scripts/verify-server-package.mjs) then served their exact bytes through a private registry and exercised npm execution, cold browser boot and server restart. Both reported versions were `0.13.0`; the launcher PID/public port persisted while the child PID and boot ID changed. Unexpected browser errors were absent; the empty project's icon 404 and the bounded restart WebSocket disconnect are recorded separately. Final cleanup explicitly confirmed browser, npm process, launcher and observed children were gone.

The final smoke is in `release-candidate/final-smoke/`; the retained tarballs are in `release-candidate/`, under this thread's evidence directory. Their package manifests do not contain `gitHead`, so source provenance is this report and the local commit history, not npm provenance. The build source was `89cd604d`; subsequent commits only add verification scripts and this report. No public release is implied.

| Tarball | SHA-512 |
| --- | --- |
| `ntwine-0.13.0.tgz` | `d53754813f9236ab30684689048f0c0d8a6e6a59bcea6b2e44e6bb1ff4ceb1d1112e19b96b34b1473003d869fa2eb04dfafe1121eecafd644fc0c8bbe6f6a6cd` |
| `ntwine-server-0.13.0.tgz` | `6c182f8841cbdda3f080cdbb6df064c1a9932712566270c2b6db30b40cd162933d99682f155f6cb4b278904c199d9d9e82973ea81c5f4002d199b00bf4491ef0` |

## Browser and optical verification

The version popover distinguishes the selected server from the stable launcher. Desktop and narrow boards were inspected after real updates, with no clipping or page errors. Both actual font settings were exercised through the settings API and page reload, not a transient DOM override. The panel deliberately uses sans text and monospace version identifiers under either setting.

The ink instrument measured a `10.5px` horizontal gap for the `10px` CSS box gap. The icon tile's center matched the three-line text group's box center; measured ink-center residual was `0.50px`, left unchanged as subpixel. Enlarged screenshots were read back and inspected. Evidence: `server-node-floor3/versions-sans.png`, `versions-mono.png`, ink JSON files and geometry events; latest recovery screenshots in `server-singleton-final2/`.

## Review and gates

Independent review found and fixed the cross-epoch bootstrap/crash barrier, release retry tagging, and ambiguous launcher/server version display. Lifecycle tests additionally cover rollback failure, close races and child death during an asynchronous commit. After merging local main through `f0a15f67`, the complete suite passed: **4,620 tests, 4,535 passed, 85 skipped, zero failures** (`full-tests-main.log`). Typecheck passed. CI-equivalent board tests passed `73/73`; portable-monitor synchronization passed; monitor tests passed `16/16`.

The Windows VM experiment did not reach an initialized guest or working SSH connection, so **the new packed update path was not exercised on Windows**. The owned Windows Server 2022 VM and temporary firewall rule were deleted. Windows-sensitive behavior was reviewed against the existing process-generation protocol, npm-JavaScript resolution, IPC-first shutdown, path-containment and atomic-replacement tests; this is not a substitute claim of a Windows E2E pass.

## Publication and diagnostic boundaries

The package name is `ntwine-server`, not `@ntwinesh/server`, following the explicit selection. Initial publication and npm Trusted Publisher setup are documented in [`stable-server-publishing.md`](stable-server-publishing.md): GitHub owner: the upstream Frizz account; repository `ntwine`, workflow filename `release.yml`, no environment. Ordinary server releases leave the launcher package version alone.

The friend's `cd`/permission failure was not attributed to Ntwine, FNM or macOS permissions by this work. The diagnostic question was cancelled; no speculative permissions, shell configuration or TCC changes were made. The new installer avoids invoking interactive shell hooks, but that is a design property, not a diagnosis of the reported machine.

## Local landing

The implementation and verification scripts landed on local `main` at `8c1199b0`. A post-landing typecheck passed. A full run against the concurrently edited shared working tree briefly encountered an unrelated incomplete `ChildOpRow` import edit (17 failures); after that edit finished, all 20 tests in the two affected files passed (`main-concurrent-recheck.log`). No changes to those files were made by this effort. The complete isolated-tree and packed-artifact results above remain the evidence for the landed implementation. All delegated work was collected; the owned development worktree and test processes were removed. No remote push or publication occurred.
