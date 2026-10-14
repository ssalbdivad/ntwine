# Performance pass — 2026-09, what landed and what did not

Written 2026-09-04, after a measured pass over the two complaints that started it: an ntwine restart took a long time, and the first load after it took a long time. Both were root-caused and both are fixed in `0.11.0`. This file exists for the other half — the findings that were MEASURED but not acted on, and the ones that were measured and turned out to be nothing. It is a record at a point in time, not a description of how ntwine works now; read [`plans/README.md`](README.md) first.

Every number here came from an instrument, not from reading code. Where a claim was later disproved by a second measurement, the disproof is kept beside it rather than deleted, because the wrong version is the one that sounds plausible and gets re-derived.

## The two complaints, answered

**The restart** was a cold `tsc`. `tsconfig.base.json` set `noEmit` on every project without `incremental`, so `tsc -b` had no output file to date-stamp: it asked each project for `src/index.js`, never found one, and declared the whole tree out of date on every run. Median restart across 59 real boots was `22.9s` when it rebuilt the artifact against `2.7s` when it reused one, and `15.9s` of the difference was that typecheck. With `incremental` an unchanged tree resolves in `0.2s` and a one-file edit in `packages/server` in `3.9s`.

**The first load** had four independent causes, all now fixed: static assets carried no cache policy at all (a reload re-transferred `1,568,997` bytes; it now re-transfers `1,200`), `react-scan` shipped `184,841` bytes to production because its `import.meta.env.DEV` guard sat inside the function body rather than around the import, tenant priming starved the event loop (board RPC `1.19s` mean and `5.60s` max with priming against `10ms` and `427ms` without), and board assembly issued about `2,794` synchronous SQLite statements per rebuild.

## Open, ranked by measured cost

Nothing below is assigned and nothing below is started. Each carries the measurement that justifies it so the next person does not have to re-take it.

1. **99% of the board payload is archived rows nobody is looking at.** 634 of 637 threads, carrying `176KB` of `lastFence` and `55KB` of `lastAssistant`. Dropping those two fields from archived rows takes the board from `154.6KB` gzipped to `69.4KB`. Blocked on a decision rather than on work: it depends what the Done band is meant to render for a row nobody has expanded.
2. **The board keyframe costs `128.7ms` of main thread per project switch, and 96% of it is valtio rather than parsing.** `JSON.parse` of the real `910KB` board is `1.34ms`; the assignment at [`store.ts:528`](../packages/web/src/store.ts) is `31.9-52.7ms` of deep-proxying across 637 threads, three times over the navigation.
3. **The board is fetched twice on every load and one copy is thrown away.** [`App.tsx:47`](../packages/web/src/App.tsx) fires `rpc.board()` while the socket handshake sends the same board as a keyframe, and `seedBoard` discards whichever loses the race. Both carry the full payload. The seed is a deliberate first-paint optimization, so removing it needs a measurement of which one actually wins.
4. **Archived threads are re-derived every second, forever** — `4.1µs` of CPU per row per second, perfectly linear in the row count. 1,258 of the 1,355 sessions on the machine this was measured on (92.8%) are archived and invisible.
5. **16% of tick wall time builds `Error` objects that are immediately discarded.** A `statSync` ENOENT costs `16.08µs` against `4.11µs` with `{ throwIfNoEntry: false }`; a `readFileSync` ENOENT costs `54.57µs`. Six call sites in the tick path, every one of them a bare `catch {}`. Mechanical.
6. **Two synchronous child processes remain on hot paths.** [`process-generation.ts:69`](../packages/server/src/process-generation.ts) spends `172ms` in `ps` at module load, and `originRemoteUrl` at [`project-identity.ts:579`](../packages/server/src/project-identity.ts) spends `41ms` per project across 12 projects. The tailer's `lsof` — the third and largest, at `982ms` inside board assembly — is fixed.
7. **`~/.ntwine/builds` has grown to `3.0GB` across 179 artifacts with no garbage collection.** Confirmed again on 2026-09-04. Not a latency finding; a disk one.

## Measured and dismissed — do not re-investigate these

- **An empty isolated ntwine idles at 0.0% CPU.** Every watt is proportional to rows and to activated projects, so there is no background cost to hunt.
- **A browser reload sends one keyframe, not a backlog replay.** The 20,000-frame broker backlog was suspected and is not involved.
- **Nothing at boot opens or migrates all 40+ project databases.** The launcher opens one, in `9ms`; `backfillRegistry()` walks 57 state directories in under `5ms`.
- **No watcher touches `node_modules`.**
- **The `662KB` mermaid chunk is a red herring.** Mermaid and xterm are both already correctly lazy and a real board load requests zero mermaid chunks. The entry chunk was the whole story.
- **The transcript pane is properly virtualized and paginated**, and behaved perfectly at `37MB`. Navigation is server-bound, not render-bound: every navigation traced produced zero long tasks except where the Done band was mounted.
- **`yaml` in the entry chunk is not the barrel import.** That premise was stated in a brief here and then disproved by three builds: shipped `1,326,040` / `yaml` stubbed `1,228,593` / barrel untouched but the one web call removed `1,259,948`. So `yaml` costs `97,450` bytes and `66,095` of them come from `fenceBlocks.ts` calling `splitAwaitingFrontmatter`, which `ChatView`, `RestedCard` and `registeredDone.ts` call synchronously during render. Moving the export buys nothing and a lazy parse would print raw frontmatter at the reader. Recorded as a comment in `348e8f70`.
- **"Compression buys nothing on loopback" was wrong, and an earlier draft of this file said it.** The first measurement compared gzip on static assets and saw no change in first contentful paint. A later single-variable A/B on the same server, varying only `accept-encoding`, measured a median cold FCP of `260ms` with brotli against `280ms` with identity. What survives is narrower: on the WEBSOCKET, per-frame deflate of the board cost about `5ms` of first-message latency on loopback to save `483KB`, which makes that one a win for the relay rather than for localhost. Two different measurements; the first does not generalize.

## The `.ntwine` write rate is unmeasured, and one win depends on it

A board rebuild fires on a `150ms` debounce whenever anything writes into `.ntwine`, plus unconditionally every `RECONCILE_MS`. Two readings of that looked contradictory and are not: a steady-state trace recorded 1 watcher event in `60s`, while writing three files into `.ntwine/threads/<session-id>/` produced exactly 3 events. Both are true — worker scratch writes do reach the watcher, and a sandbox with no agents running has nothing writing to it. What has never been measured is the real write rate under real agent load, and the value of narrowing the watch scope depends entirely on it.

## The repo's own browser instrument deserves a look

`scripts/shot.mjs` and `scripts/ink-gaps.mjs` are what this project's rules point every agent at for "drive it in Chrome and carry the evidence". Both hung during this effort, and a second agent hit the same wall independently. Two candidate causes were read out of the source rather than reproduced under a controlled variable, so treat them as leads and not as findings: both call `page.goto(url, { waitUntil: "networkidle2", timeout: 30000 })`, and neither passes `--disable-gpu` (under machine load, headless Chrome's GPU process stops producing frames and `page.screenshot` fails with a CDP `ProtocolError`).

Neither script was changed. `--force-color-profile=srgb` sits beside those arguments because this repo measures glyph INK, and forcing software rasterization can shift antialiasing under the per-glyph offsets `visual-review` has already documented — so the measurement baseline is the maintainer's call, not something to alter quietly under a performance pass. It is worth attention because it degrades silently: an agent that cannot photograph the app tends to report what it reasoned rather than what it saw.
