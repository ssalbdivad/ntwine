# ntwine architecture (read this before touching any package)

ntwine is a machine-wide orchestration surface: a localhost server + web client (a browser tab by
default) showing ONE page in two views — All projects at `/all`, the default, or one
project's board at `/project/<slug>`, with every project on the machine down the left with its threads and every card
waiting on a human beside them — and the thread you open in a drawer beside either. A bare `/` goes back
to whichever of the two this browser showed last.
The UI has ZERO intelligence: all orchestration wisdom lives in the user-editable dispatch preamble
(settings), in the repo's own `NTWINE.md`, and in the worker plugin (`cc-worker/`). The few model calls
ntwine makes on its own run on the operator's Claude sign-in behind one switch (see **Background
summaries** under Invariants). The original plan: `plans/standalone-ui.md`.

## Repo layout

**The repo root IS the published `ntwine` package** — root `package.json` is the manifest, `src/` is
the launcher, the publish runs from the root, and the root `README.md` is the npmjs.com page.
**Releases publish from the `release` branch, not from main** (since 2026-09-08): main says a change
landed, `release` says it was verified and chosen to ship, and only the second one is ever released by
[`release.yml`](.github/workflows/release.yml). The branch is a fast-forward pointer into main with no
commits of its own — you move it to the tested sha. Moving it selects the commit but starts nothing:
since 2026-09-23 the workflow runs on `workflow_dispatch` alone, so a version bump on main stays inert
until a maintainer runs `gh workflow run release.yml --ref release`.
Full procedure in [plans/runtime-pin-bumps.md](plans/runtime-pin-bumps.md).

| Path | What it is |
| --- | --- |
| [`src/`](src/) | The `ntwine` launcher itself — artifact build/promote/verify, port + lock, browser launch. |
| [`packages/`](packages/) | The app workspace — `shared`, `rpc`, `server`, `web`, `vscode` (see **Packages** below). |
| [`board/`](board/) | The zero-dep `.ntwine/` board parser + thread writer. The server SHELLS OUT to it; never re-implement it. |
| [`cc-worker/`](cc-worker/) | The Claude Code plugin every dispatched agent loads: worker contract seed, sub-agent profiles, hooks, and `ntwinectl`, the command line a worker reaches ntwine through. |
| [`monitors/`](monitors/) | Portable CI/PR/review watchers, synced into `cc-worker/skills/gh/scripts/`. |
| [`scripts/`](scripts/) | Packaging (`prepare-package.mjs`, `build-*.mjs`) + dev tooling (`seed-*`, `verify-*`, `shot.mjs`). |

`board/` used to be `cc/scripts/ntwine/` — `cc/` was the Claude Code **plugin** port back when ntwine
itself shipped as an agent plugin rather than an app. The plugin is retired; the parser is not.

## Developing ntwine

```sh
pnpm install
pnpm run ntwine-dev:install     # one-time: ~/.local/bin/ntwine-dev -> this checkout's launcher source
```

Then from any Git repo: `ntwine-dev` (foreground; Ctrl-C stops only that workspace's server).
`ntwine-dev /path/to/repo` selects a repository, `--no-app` prints the URL instead of opening a browser,
`--app` opts into the legacy dedicated window, `--status` reports workspace/port/supervisor PID, and
`--stop` stops the UI server while agent processes survive. `ntwine-dev:check` verifies the shim
without changing it; `ntwine-dev:uninstall` removes only that owned shim. Use
`NTWINE_BIN_DIR=/another/bin` to install elsewhere.

### Readout and logs

A TTY launch repaints a step list while booting and settles into a static block naming the address,
the project, and this run's log. It repaints only during the boot — once that block prints, nothing
touches the cursor again, so a stray write can never land on a live region.

Under that block the launcher APPENDS one timestamped line per lifecycle beat — Restart ntwine, Update ntwine, a control-plane crash, and the recovery that follows each. Appending keeps the no-repaint rule above intact. The supervisor raises these through `onActivity` (`SupervisorActivity` in `dev-supervisor.ts`), which every transition reaches through `writeStatus`, so a path added later announces itself without being wired up again; `renderSupervisorActivity` in `src/readout.ts` turns one into a row. Beats are suppressed until the first boot settles, because until then the readout owns the terminal. A launcher that re-execs itself for an update — `ntwine-dev` keeps its pid and its tty across the handoff — builds a `noticeOnlyReadout` instead, or the generation that took over would be mute for the rest of the session. The registry launcher does the same on a Node that has `process.execve` (22.15+ / 23.11+, which is why that is the floor). Where there is none — Windows — it starts the successor detached with its stdio closed, holds on until that successor answers the status route with the new version (a successor that exits first or never answers is a failed update, and the old board is restored), and only then prints a farewell naming the new version and `ntwine --stop` and exits; `ntwine --stop` and `ntwine --status` are real flags on that launcher since 2026-09-11.

Every process writes the complete feed to `<stateDir>/logs/ntwine-<timestamp>-<pid>.log`, one file per
run, with `logs/latest.log` pointing at the newest. The launcher passes that path down in
`NTWINE_LOG_FILE`, so the supervisor and the forked control-plane child append to the SAME file — they
share the file, not a writer, and O_APPEND makes each short write atomic. That is what lets the child
stay silent on a terminal the launcher is repainting without losing anything it had to say.
Retention keeps 20 runs and nothing older than 14 days; a single file stops at 32 MB.
`NTWINE_LOG_PATH` overrides the location (a directory or an exact `.log` file).

High-impact board actions also go to a machine-wide AUDIT log, `<data>/logs/audit.jsonl` (`~/.ntwine/logs/audit.jsonl` on a legacy layout), one JSON line each at mode 0600 and never pruned: every project add (typed or picked) and remove, every dispatch, every follow-up and sub-agent steer, and every question answer and interaction decision, refused or not. Each line names the project and thread, the outcome, and the request origin: `public` (the declared public origin — an ntwine.app relay or a tunnel), `network` (an exposed `--host` bind), `loopback`, or `direct` (past the launcher's proxy, as a worker's `ntwinectl` calls), plus the peer address, the client address a public origin claims, the board session's RECORD id (the one `ntwine --sessions` lists and `--sign-out` takes, never the cookie) and the device label. Typed text is a character count and a SHA-256; a secret answer is not recorded at all. The child cannot tell who called once the proxy rewrites Host and Origin, so the proxy stamps `x-ntwine-caller` on every request it forwards, replacing any copy the client sent (`restart-supervisor.ts`, `audit.ts`). It exists because a session stolen through a backdoored relay added `/private/tmp`, dispatched workers into it and removed it on 2026-10-08, and nothing recorded which device did it.

`--debug` streams that same feed to the terminal instead of the compact readout, in every process at
once — the launcher sets `NTWINE_DEBUG` in the child environment, since the child never sees the
command line. Ctrl-C and a failed boot both print the log path.

Gates: `pnpm run typecheck` and `pnpm test`. CI (`.github/workflows/ci.yml`) runs only the checks that
need no install or provider CLI; the full suite is local-only by design.

The suite runs through `scripts/run-tests.mjs` rather than calling node's runner directly, because a
green run has to prove the whole run happened. `--test-force-exit` is load-bearing here — without it
`claude-agent-broker.test.ts` leaks a handle and hangs forever — but it also makes each per-file child
`process.exit()` while verdicts are still queued on the pipe carrying them to the parent, which drops
them with no failure and no non-zero exit ([nodejs/node#64833](https://github.com/nodejs/node/issues/64833),
still open; measured here 2026-08-16 as a run that silently lost 31 of one file's 70 tests). So the
runner is wrapped: every child puts its report pipe in blocking mode and tallies the verdicts it
emits, and the wrapper refuses to report success unless that tally matches what reached the parent.
Invoking `node --test` by hand is fine for one file that imports no `.tsx`, but it bypasses that check.

The browser files (`*.e2e.test.ts`) each gate on their own env var and skip in that suite; `pnpm run test:e2e`
(`scripts/e2e-web.mjs`) runs the ones a Vite over the fixtures can serve, one browser at a time, and names
the rest (`NEEDS_REAL_STACK`), whose headers give their stack. One of those gates a product claim rather than
a component: `packages/web/src/sidebarFit.e2e.test.ts` boots, seeds and tears down its own stacks and fails if
the list scrolls, or loses an open thread, at upstream's heavy load (17 projects, 70 open threads) on All
projects or a project's page —
`NTWINE_SIDEBAR_FIT_E2E=1 pnpm run test packages/web/src/sidebarFit.e2e.test.ts`.

## Invariants

- **THERE IS NO TMUX. Agents run as detached broker daemons.** A Claude thread is
  `claude_runtime="broker"`, forked by `claude-broker-host.ts` with `detached: true` into its own
  process group, which is exactly why Ctrl-C on the server does not reach it and why a turn survives
  a restart. `packages/server/src/tmux.ts` has not existed since 2026-08-02, and nothing execs,
  spawns or imports tmux. The old vocabulary outlived the transport for weeks and had every reader
  re-deriving the wrong answer from it, so it was swept out on 2026-08-19: the session column is
  `thread_name` (the thread identity string `ntwine-<slug>`, never a pane name), the launch variable
  is gone, and no seed or verify script opens a pane. One reference survives on purpose —
  `isTmuxServer` in `orphan-reaper.ts` refuses to reap a tmux server left behind by a pre-cutover
  ntwine. Anything else still saying tmux outside `plans/` is a miss; prefer `git log -S` over
  believing it.
- **One server, every project.** A SINGLETON: one server on one origin serves every project on the
  machine, each named by a URL prefix. It was one server per repo until 2026-08; if you find a
  statement to that effect anywhere, it is stale. See "URL shape (one server, every project)" below —
  that section is load-bearing, and most bugs in this area come from carrying the old model forward.
- **ntwine files are the source of truth for thread status.** The server imports the board logic
  from `../../board/*.mjs` (zero-dep, plain node) — NEVER duplicate the parser. Writes
  to thread files go through the same code paths as `ntwine-update` (import `thread-update.mjs`
  helpers), never hand-rolled markdown edits.
- **Session JSONL (`~/.claude/projects/<slug>/<session-id>.jsonl`) is telemetry only** —
  liveness, previews. Parse defensively; on schema surprise degrade to "unknown", never crash,
  never let correctness depend on it.
- **Agents are headless processes ntwine owns over a pipe**, spawned with a pinned
  `--session-id <uuid>`: a Claude thread runs in the session BROKER (a detached daemon holding one
  Agent SDK session, reached over a unix socket or, on Windows, a named pipe), and a Codex thread in
  the app-server. There is no multiplexer, no pane and no terminal transport: provider sign-in is a
  command the human runs in their own terminal (the sign-in modal shows it), not a CLI ntwine hosts.
- **An idle thread's daemon is HIBERNATED, and that is not a stop.** A resting worker costs ~504 MB (measured 2026-08-19: the `claude` CLI 289 MB, a chrome-devtools MCP pair 159 MB, the broker daemon 39 MB, the ntwine MCP server 17 MB), and 38 idle threads held 19 GB. That browser was ntwine's own always-on mount, dropped 2026-08-26 — after that ntwine injected only the `ntwine` MCP server (and since 2026-10-11 not that either: a worker reaches ntwine through `ntwinectl`, below), so a thread in a project that brings no browser of its own rests nearer ~345 MB, and one whose `.mcp.json` mounts chrome-devtools is back at the measured figure only once it has called one of its tools: since 2026-10-05 the broker daemon starts a project's stdio MCP servers on first use, not at boot (`lazy-mcp-host.ts`; `NTWINE_LAZY_MCP_OFF=1` restores the eager start). So `thread-hibernation.ts` sweeps every 5 minutes and retires the daemon of any broker thread that has rested past the 60-minute prompt-cache TTL with nothing outstanding; the next input cold-resumes it from the on-disk transcript, and above the TTL that resume costs no extra tokens because the cache is already gone. **A hibernated thread is still an ordinary Rested queue row** — same `turn-idle` runtime, same rest time, same card — because the predicate refuses any thread whose dead daemon would change what the board draws. It fails CLOSED on every unknown, and the list of refusals is the point: no telemetry, no transcript, a turn in flight, a pending approval or ask, ANY direct sub-agent (including `stale` and `rested`, unlike the Mark-as-done gate), any background shell, any undelivered send, a daemon under 5 minutes old. `NTWINE_HIBERNATE_OFF=1` disables it; `NTWINE_HIBERNATE_IDLE_MINUTES` moves the threshold. Codex is deliberately excluded — one app-server daemon serves every codex thread, so there is no per-thread process to reclaim.
- **A daemon no open row claims is listed, and ended only if it never held a conversation.** `warmUp` rejoins every daemon an open broker row names; nothing else revisits the rest (the hibernator skips row-less daemons, the orphan reaper never touches a session root), so before 2026-10-08 a daemon forked by a dispatch whose server died before writing the row sat unattached until its own six-hour idle exit. `unowned-brokers.ts` runs at context start and on the hibernation sweep's cadence: it logs each unowned daemon once per verdict (session id, pid, why, age, last activity) and ends only one with no row referencing it, no transcript in any `~/.claude/projects` bucket, and an age of at least 10m. Archived, row-referenced and transcript-holding daemons are listed and kept, since each can be a turn still running. The hibernator also logs, once per idle window, every daemon it kept that has been up longer than the threshold, with the refusal that kept it.
- **A thread can run an OLDER edition of its own model family.** ntwine dispatches on the family alias (`opus`) and the pinned runtime resolves it, so a pin bump that moves the alias (Claude Code 2.1.280 took `opus` from Opus 5 to Opus 5.5) reaches only daemons forked after it — a live daemon keeps the `claude` binary it was forked with, and the row says `opus` either way. The board reads the edition a worker RUNS off its transcript's model id (`runningModelLabel`, "Opus 5") and compares it with the pin's catalogue (`claude-models.ts`, `modelUpgrade`: "Opus 5.5", `staged` when no live daemon holds the old one). The composer's model picker names the running edition and offers a one-click upgrade (`upgradeThreadModel`), which retires the idle daemon so the next turn forks from the current pin; and the first input delivered to an idle thread after a compaction newer than both its daemon and this server takes a fresh process on its own. Both refuse on the hibernation predicate minus its two memory gates — a turn, sub-agent, shell, approval or undelivered send holds them off (`claude-model-upgrade.ts`).
- **A teardown ntwine CHOSE is never reported as a crash.** `attach` reports a death whenever a resume has to cold-start, because that is normally the only way ntwine learns a daemon died unobserved — but a permission-mode change, a model upgrade, a usage-limit resume and hibernation all end in exactly that cold start. `killBroker(stateDir, sessionId, reason)` leaves a one-shot `<key>.retired` mark beside the broker record, stamped with the dying daemon's `generation`; the next cold fork consumes it and suppresses the report only when the exit record's generation matches. Genuine crash detection is untouched — an unmarked teardown still reports, which is what the negative control in `claude-agent-broker-bridge.test.ts` pins.
- **One daemon per session, and a follow-up succeeds only for a message the daemon took.** Cold resume is SINGLE-FLIGHT per session in the bridge (`attachOnce`): every caller that needs a daemon while an attach is running awaits that attach. Without it, a hibernated thread whose operator answered its questions took two inputs in one instant (the waker's answers and the operator's send), and each forked a daemon on the same socket path (2026-09-30, `we-ve-got-to-start-working`). The input frame is ACKNOWLEDGED (`input-ack-v1`): `followUp` resolves on the daemon's `input-result`, or — for a daemon forked by an older build — once the frame is written to a connected socket, and throws otherwise, so the router never records `delivered` for a frame buffered into a socket that never came back. A daemon closes its listener only while the socket path still leads to it (closing a unix-socket server unlinks its PATH, whoever owns that file now), and an unattached daemon whose socket file is gone self-collects (`self-collected-socket-lost`). `scripts/verify-broker-resume-race.mjs` reproduces all three against a real daemon.
- **ntwine's own model calls.** Five jobs ask a model without an agent: naming a thread (and "Rename
  with Claude"), the one-line status of what a thread is doing, choosing an effort when the operator
  picks Auto, reading a schedule out of a prompt ("every Monday at 9am"), and writing a to-do's first
  steps (`todo-steps.ts`, 2026-10-15). Each is a `claude-oneshot`
  call on the operator's own Claude sign-in, and each has a mechanical fallback that runs whenever its
  completer is absent. `NTWINE_THREAD_NAMER=0`, `NTWINE_LIVE_STATUS=0`, `NTWINE_AUTO_EFFORT=0` and
  `NTWINE_TODO_STEPS=0` turn a call off. (A Settings switch over all four, Background summaries, existed 2026-10-06 to 2026-10-07.)
- **No worktree opinions, one cleanup.** ntwine creates no worktree or branch, mandates no folder for
  one, and removes none when a thread is marked done; where an agent makes a worktree is the project's
  call, in its `NTWINE.md`. What ntwine does know is which checkout a thread works in (the tailer's
  `checkout`), so the terminal, the `editor` tool and a thread's links follow it. The one thing it does
  do: shortly after boot and daily after, `server/worktree-sweep.ts` removes a linked worktree under a
  registered project's `<main checkout>/.ntwine/worktrees` once it has been idle 7d (Settings → Remove
  idle worktrees after, `removeIdleWorktreesDays`; Never turns it off) — idle meaning no commit on its
  HEAD and no tracked or untracked file modified in that long. Only when nothing could be lost: git says
  it is clean, no ignored file is a secret or local data (a `.env`, a key or a `.db` keeps it, unless
  the main checkout holds an identical copy; build and test output goes), its HEAD
  is on a ref, no registered project lives in it, and no Working, Ready, Pinned or Snoozed thread on
  this server works in it; any check it cannot answer keeps it, and a repository with a registered
  project this server has not opened is skipped. `git worktree remove` without `--force`, then
  `git worktree prune`; branches are never deleted. This bends upstream's "no git or worktree opinions"
  (P10) for the fork. (The fork enforced one folder and removed a thread's worktrees on done from
  2026-09-30 to 2026-10-07; that went, and this idle sweep replaced it.)
- **Full-snapshot SSE.** The single `/events` SSE channel pushes `{type:"board", board}` full
  snapshots (see `@ntwine/shared` `ServerEvent`). No diff protocol.
- **Permission prompts come from a MARKER, not from JSONL.** Even under `--permission-mode auto` a
  worker can pause on a permission request with NO transcript signal (the last record stays assistant
  + `stop_reason:"tool_use"`), so the cc-worker hook writes a marker into `NTWINE_PERM_DIR` naming what
  is waiting and the tailer reads that. A broker thread's approvals arrive as typed permission
  requests over the control channel. The `perm-prompt` runtime rides the board snapshot
  with no notify and no unread — the sidebar's attention sort surfaces it. A deferred marker stops
  blocking when the transcript advances past it OR when the interaction journal says the session's
  request was answered (`InteractionStore.settledSince`): an approved tool call writes nothing until
  it returns, so the transcript alone kept a thread on `perm-prompt` for the whole run of the command
  the operator had just approved, with the external-terminal net drawn where the card had been.
  And a request is not always the operator's to answer: the SDK asks the daemon's `canUseTool` and runs
  the worker's PermissionRequest hook side by side, and takes the daemon's copy back when the hook
  settles it first (~70ms, nearly every request). The daemon therefore HOLDS a request 250ms before
  showing it to ntwine, and sends `permission-withdrawn` for one it had already shown, which the bridge
  turns into a `provider-cancelled` card (`InteractionStore.withdraw`). Before 2026-10-10 neither
  existed, and a hook-approved request left a dead approval card on screen until the turn ended.
- **A Claude agent's FIRST escalation goes back to it, not to the operator (2026-10-06).** In an `auto` or
  `bypassPermissions` thread the bridge denies it once with a note — approval stalls the thread, here is
  Claude Code's own reason (`decision_reason`/`decision_reason_type`, e.g. "Dangerous rm operation on
  possibly-empty variable path … rewrite it as "${W:?}"…"), find another route or make the identical call
  again — and the retry, like every later escalation, becomes the card (`claudeFirstApprovalHint`). Once per
  agent (sub-agents each get their own), remembered in `claude-broker/<key>.perm-hint` so a restart does not
  repeat it. Never for an ask rule, a hook's ask, or a restrictive mode the operator chose. Codex never asks
  (`approvalPolicy: "never"`); an ACP permission reply cannot carry text, so it has no note.

## How a thread hands off its state

The worker's final message is the interface. Its last fenced block is the thread's state: the fence
language (```` ```done ```` or ```` ```awaiting ````) is the state, and the body is the card the human reads
(`tailer.parseSignalFence`: the last fence wins, and only as the message's final content). A
registration — `done`, `ask`, `watch` — is a row that outlives the message, a compaction and a restart.
A wait always takes the awaiting fence, because where the thread sits meanwhile is a fact about this rest.
ntwine only CHECKS what the worker declared:

- **Park integrity** (scheduler SOURCE 12, `evalParkIntegrity`). An awaiting fence must name only live
  items the thread owns; an open question never refuses it. One that does not
  queues the thread and draws a correction naming the fault, at most `PARK_BUMP_MAX` (3) in a row. An
  expired `for:` wakes the worker to re-check, uncapped.
- **The sign-off nudge** (SOURCE 9, `evalSignoffNudges`, `board.signoffNudgeVerdict`). A rest with no
  fence and no `done` or `ask` of its own gets the protocol back, at most `SIGNOFF_NUDGE_MAX` (2) in a
  row; a `watch` alone is not a sign-off, and a rest behind a running direct sub-agent waits for the rest
  its return brings. A held question signs off every rest, so a rest beside one is never nudged.

**Where a rest sits is read off the fence** (`awaitingStatus`, `packages/shared`): prose under its `---`,
steps or questions ⇒ `needs_input`; only shells, sub-agents and timers ⇒ `working`; any PR, thread,
command or terminal ⇒ `watching`. A `status:` line overrides it, and an unwritten `for:` takes its items'
default (`awaitingDefaultForMs`: a shell's hour, a day for most, a PR's or command's watch for as long as
it stands). Both were required until 2026-10-24.
`working` keeps the thread in Working, spinning only while something it names is moving — a live
sub-agent, a named or watched shell, CI not held at the approval gate (`board.deriveWaitStatus` →
`ThreadView.waitStatus`). `watching` rests it in Waiting under its wait's mark, never spinning (it parked
it in Snoozed until 2026-10-14, when Snoozed became the human's alone, and in Working for the rest of that
day, until the Waiting band). `needs_input` queues it while the
work runs.
Either quiet answer holds only while every named item is live and `for:` has not run out
(`awaiting.needsInputParkHolds`), and owes no write-up. Threads dispatched before
`NEEDS_INPUT_REQUIRED_AT` whose fence writes no answer keep the older per-wait inferences (the legacy tail
of `board.deriveNeedsYou`), and `needs_input: true|false` is still read.

The fence's other keys name what it waits on:

- `shells:`, `agents:`, `timers:`, `prs:`, `commands:` — runtime or registration ids. `for:` is
  capped at a day, at a year on a park naming only PRs, at a week on one naming only command
  watches (`awaiting.parkForMaxMs`); a park on running `agents:` alone never expires. A command watch
  (`ntwinectl watch-command`, `command-watch.ts`) is a check the SERVER re-runs until it exits 0; it is
  refused unless the thread is a Claude one in `bypassPermissions` with its sandbox off, so only
  Claude's contract teaches it.
- `steps:` — acts only the human can perform, read verbatim (`awaitingSteps`). Steps name the human, so
  the fence needs no other item and no `for:`, and it always queues. The card (`AwaitingSteps.tsx`), headed
  by an "Awaiting human" chip ("To do" until 2026-10-10), draws them as a to-do stepper over one Done button — since 2026-10-12 a numbered marker per step that the human ticks off as they go, the ticks kept in localStorage keyed by the steps’ own text (`lib/stepsTicked.ts`) so the queue card and the drawer agree and a reload keeps the reader’s place; nothing is sent until Done, which sends the ordinary follow-up `Done`. Nothing is registered.
- `questions:` — registered question ids (`awaitingQuestions`). No longer taught or required (2026-10-24),
  but still read, because older workers and transcripts write it: they name the human too, and a card a
  fence names is drawn at that rest.
- `threads:` — threads asked with `ntwinectl message-thread --await-reply`, and terminals, read verbatim
  because YAML reserves `@`. For a thread the call only registers the wait: a one-off timer on the asker
  (`replyWaitPrompt`, `shared/src/thread-handle.ts`), armed for `AWAITING_FOR_MAX_MS` and cancelled the
  instant the other thread answers. A name that matches no armed wait is refused like any dead name.
  A terminal, anyone's, needs no registration: it must be running, or the park check answers (WAITING FOR
  INPUT, ENDED). `terminals:` is a synonym. The wake is SOURCE 17 (`scheduler.evalTerminalWaits`): one per
  event — the terminal reaching a prompt, ending, or changing hands after the rest — keyed on its run and
  the instant it changed, carrying the screen's last 30 lines. `ntwinectl watch terminal @x --for <d>`
  registers the same wake on the terminal's own row (`thread_terminal.watch_*`, `trw_` ids, one watcher
  per terminal; `thread_watch` holds only shells and agents), so it fires whatever the rest says, and a
  lapse wakes the worker to re-decide. A change of hands also leaves a note for the thread it concerns
  (`thread_terminal.control_notes`): told at once when that thread is working, watching or waits on the
  terminal, otherwise owed and folded into its next wake, so taking a terminal never costs an idle agent
  a turn. A note sent mid-turn that the quiet window holds past the turn is owed again
  (`reoweTerminalNote`).

**A done card offers Watch for the PRs and issues it names** (`DoneWatchButtons.tsx`,
`router.watchDoneRef`). One "Watch #N" per ref the card links, on the thread's current done at rest. The
click arms a row in the same `pr_watch` registry `watch-pr` uses (`registered_by: human`; PR or issue is
probed), and parks this rest (`bg_snooze_rested_at`), so the thread rests in Waiting as a `watching`
rest (`board.doneParkedOnWatch`; it rested in Snoozed until 2026-10-14) until the watch wakes the worker; its next rest decides the place again.
It is the human's act, not ntwine parking on a worker's behalf. A human's watch leaves the done standing,
does not gate the worker's `done`, and its wake says whose it is (`PR_WATCH_HUMAN_TRAILER`). A finished
worker therefore signs off `done` naming the ref rather than parking on it.

**A question is a row with a lifecycle** (`ntwinectl ask`, `thread_question`). It is open until the
human answers or dismisses it or the worker withdraws it with `ntwinectl unask`; ntwine never retracts one by
omission. A HELD question — open, and not typed past — is the sign-off of every rest until it is
answered or withdrawn (`board.heldQuestionRows`, 2026-10-24); the worker never restates it, and nothing
nudges or refuses a rest for leaving it out. From 2026-10-05 it signed off only the rest that asked it,
and every later rest had to name it under `questions:` or `unask` it — 772 of 2,727 park fences re-listed
ids the server already held. When the human TYPES PAST it (`questionRepliedPast`; since 2026-10-14,
maintainer: *"the questions should move along with the conversation and not be re-asked if the user moves
on"*), it stays open and answerable where it was asked, but no longer holds the thread: it blocks no
`done`, queues nothing and signs off nothing. A `secret` or MCP request
is exempt: it is an input the worker cannot proceed without. `ask` refuses to re-ask a question the human
dismissed or typed past, or one the worker withdrew after the human's newest message. On
the page a card stays at the bottom of the rest that asked it until a later fence claims it, then moves
to the end of that rest (`questionClaims`, `web/src/lib/questionAnchor.ts`); a wake never moves it. A
question whose card sits above the newest rest — held, or typed past — is linked from the transcript's
tail ("1 unanswered question above", `ChatView` `questionsAbove`), so the newest handoff never reads as a
bare stop with its ask out of sight; the queue card draws a held one between the rests it shows
(`lib/queueCardQuestions.ts`). An
empty placement marker, ```` ```question qst_… ````, draws its card where the marker sits instead
(`questionShadow.placeQuestions`); the contract tells workers to write none. The free-form question fence
is prose for every thread dispatched since `QUESTION_FENCE_RETIRED_AT`; an older thread keeps it as an
ask, its trailing `- A. …` list parsed into choices (`questionBlocks.ts`), and a fence that restates a
registered question draws nothing.

**A secret the human pastes is a registered question whose answer never enters the row (`ntwinectl secret`, since 2026-10-08).** The command rides the `ask` RPC with `secret: true` on a root, option-free question (`askedQuestionFaults`), so the card, the wake, the `done` gate and `questions:` naming are all a question's. The card draws a password field (`QuestionBlockCard`, the phone sheet's `SecretText`) whose value lives in the answering state's memory, never the sessionStorage draft store. `answerQuestions` serves the value from MEMORY through a named pipe at `<project state dir>/secrets/<slug>/<qst_id>` (`mkfifo -m 600` in a 0700 dir, `secret-files.ts`) and stores only `secretAnswerText(path)`, so the settled card, the in-flight card and the worker's wake carry the path and never the value. The pipe reads ONCE: the first reader gets the value and the path is removed; an unread value is dropped after `SECRET_TTL_MS` (15m), and each context start clears the dir, since a pipe a dead process left has no writer and would hang its reader. The worker reads it inside the command that uses it (`"$(cat '<path>')"`). It was a 0600 plaintext file on its first day (2026-10-08) and became a pipe so nothing persists for a backup or a sync client to copy; Windows has no FIFOs and keeps the file, removed at the same TTL. A blank secret answers nothing, and the request survives a Goal being armed and is allowed on an autonomous thread (a credential is not a call the worker can decide). The interaction store still refuses secret PROVIDER answers: those would have to cross its durable outbox, which this path never touches.

**A worker reaches ntwine through ONE command line, `ntwinectl`, on every backend (since 2026-10-11).** Every worker capability (`ask`, `unask`, `secret`, `done`, `activity`, `watch`, `unwatch`, `watch-pr`, `watch-command`, `extend-shell`, `terminal`, `timer`, `goal`, `deadline`, `title`, `link`, `unlink`, `editor`, `read-thread`, `message-thread`, `spawn-thread`, `schedule`) is a subcommand the worker runs from its own shell, and none of them is a tool in the model's registry. The registry is [`cc-worker/lib/ntwine-tools.mjs`](cc-worker/lib/ntwine-tools.mjs): each command's definition, its `--help` text, how its arguments are spelled, and its handler. [`cc-worker/bin/ntwinectl`](cc-worker/bin/ntwinectl) (with `ntwinectl.cmd` for Windows) is a launcher in front of `ntwinectl.mjs` that tries `NTWINE_NODE` before a bare `node`. Each handler POSTs one loopback RPC (`/_ntwine/<project>/rpc/<procedure>`), finding the server from a lock file on every call. **The caller is named by the worker's environment and never by an argument**, which is what stops one thread acting as another: a Claude worker has `NTWINE_THREAD` from its broker daemon's environment, an ACP agent `NTWINE_THREAD_SLUG` from its per-thread agent daemon's, and a Codex thread `NTWINE_THREAD_SLUG` from its own config bag as `shell_environment_policy.set.*` keys (`backend/codex-shell-env.ts`), because one app-server serves every thread in a project and its process environment cannot name one. The last two are never `NTWINE_THREAD`, which is the orphan reaper's ownership tag: a process carrying it is reaped unless a live `claude`/`codex` session root carries the same slug, and neither an ACP agent nor a Codex thread's shell has one (`backend/types.ts` `ntwineCliEnv`). A sub-agent's shell inherits the same environment and so acts as its parent's thread. The worker contract (`packages/server/src/workerPrompt.ts`) states the rules and each command's own `--help` carries the detail. The MCP front-end [`cc-worker/bin/ntwine-mcp.mjs`](cc-worker/bin/ntwine-mcp.mjs) is the same registry over MCP stdio and remains only for threads that were started under the old contract, which taught `mcp__ntwine__*` tools; it lists `editor` only while an editor has the project open and follows that live (`GATED_TOOLS`, `notifications/tools/list_changed`), where `ntwinectl editor` always answers. Upstream's `steer` is not in the fork's registry: `message-thread` is the thread-to-thread command.

**Other threads, by handle.** `ntwinectl read-thread` returns another thread's request, status, newest
messages and edited files, and reaches a sub-agent at `@thread.agent`, returned ones included; it wakes
nobody. `ntwinectl message-thread` puts a signed message into another open thread's conversation, joining
its turn or waking it; it never reaches the human, and messages between two threads are capped per hour.
A thread `ntwinectl spawn-thread` starts carries its spawner's slug at the end of its prompt (the registry's
handler adds it), so it can message results back; upstream's `steer` verb for the same delivery is not taken (2026-10-12).

The contract that teaches all of this is `packages/server/src/workerPrompt.ts`, the tool descriptions in
`cc-worker/bin/ntwine-mcp.mjs`, and `cc-worker/hooks/deny-ask.mjs`; keep them aligned.

### Where ntwine acts on a clock or with a model

Each of these departs from "ntwine only checks" on purpose.

- **The 10-minute default answer** (`QUESTION_DEFAULT_AFTER_MS`, scheduler `evalQuestionDefaults`). A
  question the worker marked `mayDefault` (opt-in since 2026-10-08), unanswered 10 minutes after its thread rests, takes its `recommended` option, delivered marked
  as ntwine's default. An `external` recommendation (it posts, merges, pushes, publishes or spends) is
  never taken: the first option that is not is, and with none the question waits. So does a `danger`,
  `multi` or free-text question, one with no recommendation, and one the human typed past
  (`questionRepliedPast`). Why: a call the worker could have made should not hold a thread for hours.
  Off: the countdown's × on the card, per question (`default_off`); a pick or keystroke on the card
  holds it off for 2 minutes.
- **The 30-minute check-in on sub-agent parks** (`AGENT_PARK_FOR_MAX_MS`). A park naming `agents:`
  expires at 30 minutes, and the wake (`parkExpiredWakeMessage`) asks the parent to read and steer its
  children, ask any decision they surfaced, and re-park with a progress note under the band its last
  park chose. Why: a long orchestration otherwise shows one stale line for hours. The resting card's
  "Ask for update" sends it early (`requestParkCheckIn`). Not configurable.
- **Model-written names and status lines.** A thread is named at dispatch (`thread-names.ts`), and the
  name, its `@handle`, never changes once shown, so `ntwinectl title` lands only on an unnamed thread.
  Its status line is written at each rest where the conversation moved (`periodic-status.ts`) and,
  while a turn runs, whenever the work changes task (the live status line, `live-status.ts`), into
  `ThreadView.statusLine`. Why: a stable name before the worker has oriented, and a current line beside
  the worker's own sign-off. A row shows it on hover unless Settings → Always show status lines is on
  (§ Board nomenclature). Off: `NTWINE_THREAD_NAMER=0` and `NTWINE_LIVE_STATUS=0`.
- **A to-do's first steps** (`todo-steps.ts`). When `/todo` adds one, a single background completion
  reads the task and writes how to start it: a draft message, the official page to open, where to look in
  the code. It has no tools, so it never browses or reads the repo. Why: a to-do is written down mid-flow,
  and the first step is the one that stalls it. Off: `NTWINE_TODO_STEPS=0` (or `NTWINE_THREAD_NAMER=0`).
- **Per-question answer delivery** (scheduler `evalQuestionAnswers`). Each card is sent the moment the
  human completes it and delivered mid-turn like a steer; every undelivered answer a pass finds for one
  thread goes as one message (`mergeAnswerMessages`). Why: the worker starts on the first answer while
  the human reads the rest. Not configurable.

### Background shells

- **Budgets** (`server/src/shell-budget.ts`, SOURCE 13). A shell ends on a clock only when one was
  declared: its Bash `timeout`, or `ntwinectl extend-shell`, the only way a Codex exec gets one. Past
  it the worker gets one wake, mid-turn if busy, and the shell is stopped `SHELL_BUDGET_GRACE_MS` (10
  minutes) later unless extended. With no budget a shell runs until it exits or is stopped; the
  PreToolUse hook (`cc-worker/hooks/bash-background.mjs`) adds one line of context to an unbudgeted
  background call.
- **Stray shells behind a question** (SOURCE 14, `strayShellsMessage`). A question's card hides the
  thread's live shells, so a rest on a question with shells still running gets one message listing them,
  once per set of shells. Shells under an armed `watch` are left out, nothing is killed, and it is Claude
  only, since the remedy is `TaskStop`.

## Board nomenclature (the maintainer's words — write code, comments and copy in them)

Saved links and files are thread references, not activity or waits. Workers register them with `ntwinectl link "<label>" <target>` and remove them with `ntwinectl unlink <id>`; `ntwinectl activity` lists their ids separately from running work. The `thread_link` table scopes them to project + thread, with one slot per label. They survive rests, archive/reopen and restarts, disappear when the thread is deleted, and never block completion. The prompt's activity area renders them below an unlabeled divider; files use the existing reader/opener and trust boundary.

These are the names for a project's row groups, top to bottom. They are the MAINTAINER's vocabulary (2026-08-05), so they win over whatever a symbol happens to be called; when a comment and this list disagree, the comment is wrong.

**Where the bands live.** In the page's left column, one list whichever view the page shows (see **URL shape** below).

- **Every view is ONE list** (`components/TierList.tsx`, since 2026-10-14; `plans/all-projects-first.md`): All projects (`/all`, the home page), a project's page (`/project/<slug>`) and a lens (several projects, shift-clicked in the dock, kept for the tab: `lib/lens.ts`) draw the same bands over a different set of projects. Top to bottom: **Pinned** (by pin time), **Ready** (in the queue column's own order, so a row faces its card), **Working** (each project's threads together, in the dock's order), **Snoozed** (folded), **Done** (every finished thread, grouped by day — the last week's days that finished anything, then Older — each folded to a line with its count but the newest, which opens with the next while fewer than five rows show; it scrolls on its own and pages Older in from History's `projectsDone`; External sessions and each thread's ledger are the center column's History tab, `components/HistoryView.tsx`), then **Schedules** (folded). Each band has a header, Pinned, Ready and Working's static and never folded, the rest fold headers remembered per browser (`lib/crossProject.ts` `setTierFold`). The project is an ATTRIBUTE of a row, never a heading: its square sits in the gutter of the first row of each run of one project's rows, and the cord ties the rest (`ThreadConnector`, each run a `data-xq-rail-project`). A working row's status is inline. On a project's page a thread's sub-agents list as rows under it (Sidebar.tsx `SubAgentRows`); elsewhere they are a count on the row.
- **The dock** (`components/ProjectDock.tsx`) heads the list: a 20px square per project in the machine-wide order, a badge for its Ready count and a tick while something works. Click opens the project's page (or, on it, goes back to All projects); shift-, ⌘- or Ctrl-click adds it to the lens; right-click is the project's menu (`ProjectMenu`); drag or ⌥←/⌥→ reorders; `+` adds a project. Lenses can be saved by name (per browser) and are then chips above the squares.

**The list never scrolls, except Done** (2026-10-16), which takes the room the bands above leave, down to its header, and scrolls inside it — so it gives every line before any band does. The rest measures itself and raises a compression level until it fits (`lib/sidebarBudget.ts`, whose header lists the order): Working rolls its biggest runs into one line each (spinner with the count, project, titles, longest clock), then Ready and Working list their first rows and count the rest ("N more in the queue", "N more working"), then Pinned. What the human opened by hand (a rollup, Working's or Pinned's "more") is never taken back, and nothing is re-budgeted while the pointer is over the list (`lib/listHold.ts`). Rows are one line, 23px. `packages/web/src/sidebarFit.e2e.test.ts` gates it at upstream's heavy load (17 projects, 70 open threads) at 1280x720, 1440x900 and 1920x1080: no overflow, and every open thread accounted for as a row, inside a rollup or in a "more" count (see **Developing ntwine**).

**The visible labels are one table**, `BANDS` in `components/BandLabel.tsx` — **Pinned · Ready · Working · Waiting · Snoozed · Done · External** — shared by the list's band headers (`components/TierList.tsx`, Sidebar.tsx `SectionHeader`), the center column's Ready and History tabs, the QUEUE header over the queue and the band stamp in a drawer's header, so they are a legend for the whole screen. A header's glyph stands in the rows' indicator column, so a name reads as the head of the rows under it rather than a divider; the rows still wear their own marks — the pin, the rest time, the spinner. The maintainer's spoken words for two of them are older than those labels: **Rested** is the band labelled **Queue**, and **Active** is the band labelled **Running** (unlabelled until 2026-09-19, then "Queue" and "Running", then on 2026-09-23 "Ready" with an inbox and "Working" with a bot — "Working" alone left it open who was working — and upstream's "Queue" and "Running" again since 2026-10-06, keeping the inbox and the bot; `plans/upstream-superset.md`). Most comments still say Rested/Active; say either pair, never mix them within one sentence.

- **Pinned** — the human's shelf, ABOVE everything including the cue (maintainer 2026-09-02: a pin "takes a thread entirely out of the whole rail system"). Named on a board; on All projects each row says it with a small solid pin where the cue's rest time would sit. Membership is one fact — `pinnedAt` on the thread, written only by the row's hover pin/unpin verb — and it outranks every derived state: a pinned thread that spins, rests, snoozes or finishes stays here, in PIN order (oldest pin first), until unpinned. Not a `SectionKey`: `sectionThreads` diverts these rows before `sectionOf` runs (`isPinned`, groups.ts), which is what keeps the pin from having to be excluded band by band. One deliberate consequence: a pinned thread that needs you keeps its QUEUE CARD (the pin is a rail arrangement, not a queue excusal), so its card's row lives up here rather than in the cue — the card↔cue pairing below holds for every UNPINNED thread.
- **Rested** (labelled **Ready**) — the top band of the RAIL SYSTEM proper, directly under the project's pinned rows (under the prompt box on the board, maintainer 2026-08-08), and the same set as **"the queue"** / **"the cue"** / **"items in the queue"**: one rested row per queue card, in the identical order, so a project's first Queue row faces the first card in that project's lane of the queue (`ThreadConnector` draws the tie across the gutter). A Queue row's click brings its card into view — the queue always shows the cards of exactly the projects the list shows — and a row with no card on the page opens the thread's drawer; a thread open in a drawer keeps its row, marked open, and only a card being finished takes its row with it. Say "rested" or "in the queue"; do NOT say "active" about these rows just because they share a `<section>` with the Active band. Each carries a right-justified time — when that thread ENTERED the queue (`queuedAt`, stamped server-side by `queue-clock.ts`), which is its rest time for a plain rest and the moment the wait let go for one that rested behind a hold. The queue orders by that same instant, oldest first, so a new arrival always joins the bottom and nothing moves a thread while it waits (maintainer 2026-09-24: the queue had behaved like a stack, because a thread entering off a wait carried its old rest time to the top). A thread let go by a hold that usually ends in a wake — its sub-agent returning, CI settling, a park or timer firing — is withheld for 12s first, so a worker woken inside that window never flashes into the queue or notifies; permission prompts, questions, crashes and limit pauses enter at once. The queue card prints the same instant as "Queued 5m ago" ("Ready 5m ago" until 2026-10-06); the conversation header keeps the agent's own "Last active".
- **Active** (labelled **Working**) — the rows after the Ready rows, in practice the ones currently SPINNING. Silence never queues a turn in flight, however long it has written nothing: the worker's own rest does, and mid-turn only something the human must answer now does (a permission prompt, a provider interaction), or the crash net when the worker's process exits mid-turn (`deriveNeedsYou`). A foreground call blocked on a prompt ntwine cannot see is the human's to notice here and interrupt. The rule between the two bands is drawn on the CARD, both ways: nothing below it has a queue card, and every card has a row above it. So the band also takes the occasional row that is neither spinning nor asking — a thread the server excused from the queue while it rests (a worker's own `status: working` park; for a thread that predates the line, a live sub-agent or CI running on a watched PR; a follow-up still in flight), and every park a worker declared — a `watching` rest, an armed timer — since Snoozed became the human's alone (2026-10-14, shared `agentParked`). That is the honest place for it. A `working` rest spins with the mark of what it waits on inside the spinner; a row here that is not `working` — a follow-up in flight past a minute — wears its static at-rest mark. The alternative, tried until 2026-08-14, was a cue row with no card behind it, which looks queued and opens a drawer on click. No rest time: nothing below the rule has handed anything back.
- **Waiting** — under Active, never folded (2026-10-14; shared `inWaitingBand`): a worker at rest on something outside the thread — a review, CI, a release, a reply — which the server reads as `waitStatus: "watching"` (`board.deriveWaitStatus`), and a done the human chose to Watch from its card. A park on the thread's own sub-agents, shells or timers stays in Active, because it finishes by itself (timers 2026-10-22). It is the first band the list shortens (`lib/sidebarBudget.ts`), down to two rows and "N more waiting", so it is always in view (maintainer: *"a separate category that is always visible under working … when agents are waiting for something external"*).
- **Snoozed** — the dimmed, labeled band under Waiting, and the first of a project's QUIET bands (a folded header on a board, a count on the project's row in All projects). It holds only a TIME the HUMAN picked (since 2026-10-14; shared `isSnoozed`): a wall-clock snooze and a schedule's next run. A working thread — a turn running, or its own sub-agents or shells out — cannot be snoozed (router `setThreadSnooze`, the header clock disabled), and a plain snooze ends at the agent's next rest after it was set (`session.snooze_set_at`, board `futureSnooze`), so a thread that wakes and works comes back into view instead of folding away again; a snooze carrying a follow-up prompt is a scheduled message and holds to its time. Until 2026-10-14 it also held the resting card's "until new activity" and a queued parent's "until all sub-agents return" — both removed that day, after the second, armed by a stray `s` then Enter, hid a working thread for hours and re-folded it at every rest — and a done card's Watch, which waits in Waiting now. A worker's own park was a member from 2026-10-05 to 2026-10-14 and is in Active or Waiting now (shared `agentParked`; maintainer: *"if I consider a thread to be active and an agent happens to be waiting for something, I still don't want to see it collapsed"*). Parked, not asking, and still — no mark in this band spins. A limit pause ntwine will auto-resume was a member until 2026-08-31; it now QUEUES as a failed thread (yellow hourglass in the cue, hover Retry) — a whole fleet a quota limit killed once sat here as calm muted hourglasses, which is the opposite of what a mass kill should look like (maintainer: "they should have shown up in the queue … as threads that had failed in some way"). Renamed from **Held** on 2026-08-26, key and label together.
- **Done** — the archived section, last of the thread groups, most recent first: a folded header on a board (virtualized once open, the one band that grows without bound), a count on the project's row in All projects that lists ten at a time. An archived thread whose worker is still running — a turn draining, a sub-agent it dispatched still out — is not filed here until it rests: it lifts into Active (Running) with its spinner, keeping its Done dim and uncheck box (`sectionOf`, `doneButRunning`; upstream 2026-07-10, "hit 3×"). Its state never moves; only the human reopens a thread. The fork filed it in Done whatever the worker did from 2026-09-24 (da8ebaf1) until 2026-10-06, which hid running workers in a collapsed band.
- **External** — agent sessions in the project that ntwine did not start (one you ran in your own terminal, `foreign` on the wire — `externalThreads`, groups.ts), rested ones only. Read only: its drawer shows the transcript and has no prompt box, and the session is continued in its own terminal (steering one promoted it into an ordinary thread until 2026-10-14). Quiet, like Snoozed and Done.
- **A terminal is a thread, in the same six bands (`kind: "terminal"`, 2026-10-15, maintainer-confirmed; `plans/terminal-threads.md`).** A `$ npm run dev` line in the prompt box on All projects, a project page or Home starts one with no parent, in the folder the box's picker names: the project root or a `.ntwine/worktrees/*` checkout (`thread-cwd.ts terminalFolders`). Open terminal, `t` or a `$` line in a thread's prompt box starts one with that thread as its PARENT (`parent_slug`, "started from", not "lives inside"), in the folder its agent works in: the newest `cwd` its Claude transcript records, or the newest tool `workdir` in a Codex rollout, lifted to the checkout it lies in (`thread-cwd.ts`). Its band is its process's state, read at build time (shared `terminalOutcome`, `thread-terminals.ts terminalThreadView`): running is **Working**; waiting at a prompt (`awaitingInput` — text left on an unterminated line for 3s) is **Ready**, its card drawing the live screen to type into; an exit of its own with a non-zero code, or a signal nobody sent, is **Ready** shown failed; a run with no recorded exit is **Ready** shown interrupted; exit 0, Ctrl-C (130), SIGTERM (143), Stop, or `exit` in a bare shell is **Done** — queuing a clean exit would put a card in the queue only to be dismissed. Pin, snooze to a time and Mark as done work as on any thread (`setThreadPinned`/`setThreadSnooze`/`setThreadState` branch on `terminalRunner.has`); Mark as done stops a running one first, a snooze ends when the process exits, and a `$` follow-up or Restart reopens a Done one. Its `@handle` comes from its command (`terminalHandle`: `pnpm run dev` → `nub-run-dev`, a bare shell `shell`, `-2` on a clash), and `read-thread @handle` returns its screen tail, ANSI-stripped. **An agent starts one the same way, from its shell** (`ntwinectl terminal start "<cmd>"`, the `ownTerminal` RPC): parent and `started_by` are the calling thread, the folder is the one `thread-cwd.ts` gives that thread unless `--cwd` names another, and the command prints the `@handle`. **One driver types at a time** (`thread_terminal.controller`, the human or a thread slug; maintainer 2026-10-15, `plans/terminal-threads.md` § Control). The starter drives first. An agent reaches a terminal through the thread verbs: `read-thread @h` reads its screen, `message-thread @h` types the text and Enter, and `threads: [@h]` waits on it; `ntwinectl terminal start|stop|restart|release` is the rest. Typing, stop and restart are refused (exit 2, naming the driver) unless the caller drives, and `release` hands it to the human. The rule holds for the human too, and the pty enforces it rather than the UI: `thread-terminals.ts attach().write` drops a viewer's keystrokes unless the human drives, and `terminalStop`/`terminalRestart`/`terminalRun` refuse while a thread does (`requireHumanDrives`). While a thread drives, the drawer and card draw a bar, "@x is driving", with Take control, and the pane and `$` line are read-only; after a take the bar offers Hand back to @x (`control_agent`, the last agent driver). Any terminal's ⋯ offers Let an agent drive, a pick of the project's open threads (`TerminalControlBar.tsx`, the `terminalControl` RPC). Mark as done and the Done dialog's Stop take control implicitly, since ending the thread is the human's call. The worker contract sends a process the worker works alongside — a dev server, a log tail — here rather than to `run_in_background`, which keeps it alive past the turn and leaves the thread free to hibernate; a slow gate stays a background shell. A running terminal the thread started, drives or watches is a `threads:` item in `ntwinectl activity`, never blocks `done`, and draws the agent's bot in the parent's strip and in the Mark-as-done dialog (`CompletionHoldOp.owner`, `ThreadProcess.mark`). Its row is one line — a dim `$`, the command in mono, ` · <checkout>` only off the root, its age (`TerminalThreadRow.tsx`); its card is `TerminalQueueCard.tsx`; its drawer is `TerminalSheet`. A parented terminal is also a line in its parent's strip (`ThreadView.terminals`, `board.withThreadTerminals`), a way to it, never a reason to queue the parent. Marking the parent done no longer stops it: the "End this session?" dialog lists the live terminals the thread started with a Stop box each, unticked (`completeThread.stopTerminals`). A finished terminal's drawer and card end in a `$` line (`TerminalFollowUp`): the next command runs as the SAME terminal's next run (`terminalRun`), on the previous screen plus a `$ <command>` line; Restart alone starts blank. Each run's pty lives in its own detached daemon (`backend/terminal-daemon.ts`), so it outlives an ntwine restart; `/term/<id>` (`server/src/terminal.ts`) streams it to xterm.js. node-pty is loaded LAZILY, in that daemon, so a box where the addon will not load serves every project and the terminal pane says why. History: top-level `kind: "command"` threads from a Terminal tab (2026-09-23, every finished run queued), then a thread's own terminals with no row of their own (2026-09-29, upstream's call), then this.

Where the CODE disagrees, and it does in places worth knowing before reading `web/src/groups.ts`:

- `sectionOf` (`@ntwine/shared`, re-exported by `groups.ts`) returns `"active"` for Active AND Rested rows alike. That key names the `<section>` that holds both bands, not the maintainer's "Active". `partitionActive` splits it: `.running` is Active, `.rested` is Rested.
- The archived section's `SectionKey` is `"inactive"`, but its rendered label is **Done**. And the band KEYS are `ready` and `working` (`BANDS`, `Band`), matching the labels Ready and Working (which read Queue and Running from 2026-10-06 to 2026-10-14).

None of these is worth a rename sweep — but every new comment says Active / Rested / Snoozed / Done in the sense above, and `inActiveBand` (the predicate for "this row has no queue card") is the one function that means "Active" exactly.

## Packages

- `shared` — zod schemas + types + constants. THE contract; read `src/index.ts` first.
- `rpc` — typed query/mutation/stream over Hono (lifted from gent, unchanged). Server defines a
  `Router` in `server/src/router.ts`; web imports `type AppRouter` from it for the typed client.
- `server` — Hono app on 127.0.0.1 (default port in shared). Every route of its own lives under the
  RESERVED `/_ntwine` namespace (`NTWINE_ROUTE_PREFIX`), which is what leaves the top level free for a
  project slug: rpc mounts at `/_ntwine/rpc` (and `/_ntwine/<project>/rpc` — see § URL shape), SSE at
  `/_ntwine/events`, the multiplex socket at `/_ntwine/ws`, static web assets in prod, Vite
  middleware in dev (`src/dev.ts`). Subsystems: `bus.ts` (EventEmitter → SSE), `board.ts`
  (.ntwine watcher + read model), `sessions.ts` (SQLite registry via better-sqlite3),
  `tailer.ts` (JSONL), `dispatch.ts` (thread file create + prompt compose + spawn),
  `settings.ts`.
- `web` — React 19 + Vite 8 + Tailwind v4 + valtio + TanStack Query + xterm.js.
- `vscode` — the VS Code (and Cursor, Windsurf) extension: a client of the one server over the
  machine-wide editor bridge (see **VS Code extension** below). Private; nothing it adds reaches the
  published packages.

Plus root `src/` — the `ntwine` launcher (NOT a workspace package): canonicalize cwd's Git root,
health-check/reuse its detached supervisor, atomically allocate/persist an isolated port, then open the
URL. Locks and logs live under `~/.ntwine/projects/<id>/`; `src/browser.ts` is vendored from Gluon via
gent. See **CLI launcher** below.

## URL shape (one server, every project — the singleton)

ntwine used to run ONE SERVER PER PROJECT, each on its own port, so every URL was unambiguous and unprefixed. It is now a SINGLETON: one server on one origin serves EVERY project on the machine, and the project is named by a URL PREFIX. Two rules follow, and most of the bugs in this area come from missing one of them.

**ntwine's own routes are under `/_ntwine`, so the top level is free.** Anything outside `/_ntwine` is the SPA's: `/`, `/all/<slug>/…` and `/project/<slug>…`. `APP_ROUTE_SEGMENTS` (`thread`) is a different set — the unprefixed in-app links an AGENT writes (`[x](/thread/<t>)`), which the markdown sanitizer re-points at the page's project (`prefixedAppRoute`) rather than letting them address whichever project launched the server.

**A project in an address lives under a segment — `/project/<slug>` for its board, `/all/<slug>` for a drawer on All projects — not at `/<slug>`.** One segment buys back the whole root namespace, so a future page can never be shadowed by a directory somebody happens to have. `/project/<slug>` was a project's own page until 2026-09-28, gone while focus mode lived in the query, and the board's address again since 2026-10-06 (David: the fork is the base with upstream's URL scheme, `plans/upstream-superset.md` §2). Only its exact shapes are pages (`base-path.ts PROJECT_BOARD`): `/project/acme/src/main.rs` is somebody's file.

**ONE page, in two views** (`lib/pageView.ts`). Every address in the table below renders the same component (`components/AllQueues.tsx`, through `routes.tsx PageRoute`), mounted once, so nothing remounts under the operator when a drawer opens or the view changes. **All projects** is the default at `/all` (a board was the default from 2026-10-06 to 2026-10-14): a bare `/` opens the view this browser showed last, which for a browser that never chose is All projects. It is reached from the switcher's first entry and the board's ⌂ crumb, and is every project's threads in one list by band, one queue across them, and the prompt box's own project picker. Projects interleave there by design (2026-10-14, `plans/all-projects-first.md`; it replaced upstream's rule that projects stay separate, S2 in `plans/upstream-superset.md` §1): every row wears its project's square and every card names its project. **A project's board** is the page showing ONE project, upstream's one project per page: the same list over that project (**Board nomenclature** above), the queue showing its cards, and a prompt box that dispatches into it with no picker. History, because it explains the shape: upstream's board was a page of its own (`TodosView.tsx`) until 2026-09-28, when the fork folded every project onto one page and that board became a filter, then a view in the query (`/?project=<slug>`, 2026-09-29); on 2026-10-06 it took upstream's URL and named bands back as a view of the same page (David: the fork is the base, and everything upstream built is in it). `TodosView.tsx`, `MobileBoard.tsx` and the board's `Sidebar` component stay deleted; `Sidebar.tsx` keeps the row pieces both views share (`RailRow`, `SectionHeader`, `SubAgentRows`). Below 800px the same page stacks — prompt box, queue, then the list. Below the phone breakpoint (700px, `lib/mobile.ts`) it has its own layout of the same view, the desktop's left column for one hand (`components/PhonePage.tsx`, its bands in `lib/phonePage.ts`, 2026-10-14): the dock as the header (All and every project's square, a tap is the dock's click), the view's name with "N need you · M ready · K working", then the list's own bands in its order — Pinned, Ready, Working, Waiting, Snoozed and Schedules folded, Done today with History at its right — in two-line rows that wear their project's square in All projects, and a New thread button that opens the page's prompt box aimed where the view dispatches (All projects' picker included). The list scrolls; it has no budget. History is a screen over it, a history entry, so Back puts it away. A row opens its thread's drawer in place, full-screen on a phone, and a long press opens its actions sheet. The desktop's columns from 700px up are unchanged.

**Say "All projects" and "a project's board"** — the switcher's own labels — for the two views, and "cross-project" in code and comments about the page; the code also calls the board view "focus mode" (`PageView` `kind: "project"`). Never "project view", "Everything" or "All queues", the names of surfaces that are gone; `board` is also the internal name of a project's snapshot and store.

| URL | renders |
| --- | --- |
| `/project/<slug>` | the page (`components/AllQueues.tsx`) focused on `<slug>` — the project's BOARD. A slug no project has says so in a toast and lands on `/` |
| `/project/<slug>/thread/<t>` | the board with `<t>` open in place: a COLD link (a bookmark, a pasted address) to a queued thread lands on its card on a desktop and the address returns to `/project/<slug>` (`lib/queueLandingHold.ts` holds it there); anything else opens its drawer |
| `/` | NO VIEW OF ITS OWN (`routes.tsx LastViewRedirect`): it replaces itself with the view this browser showed last — `/all` or `/project/<slug>`, remembered in localStorage (`ntwine.lastView`, `lib/crossProject.ts lastViewHref`; navigation memory, not a setting, and never written by an editor's frame) — and a browser that never chose, or whose remembered board is gone, gets All projects. A launch from a known project lands here too, with that project stamped as All projects' prompt-box pick. It answers a launcher's `?add=` and the server's `?unknown=` on the way through. With no project at all it is the welcome page (add a project, or start in Home). |
| `/all` | the page showing All projects, bound to the prompt box's pick (the operator's last pick in this browser, else the most recently opened open project — `lib/crossProject.ts`; never the Home workspace, which is picked only when chosen); where an `everything` launch (from $HOME) lands, and what an editor's sidebar frames when no folder maps to a project. It was the bare `/` from 2026-09-30 to 2026-10-06 |
| `/all/<slug>/thread/<t>` | All projects with `<t>`'s drawer open IN PLACE; the page is bound to `<slug>` while the drawer is open |
| `…/thread/<t>/full` | the thread's fullscreen page until 2026-10-15 (maintainer: "the fullscreen view sucks"): an old link drops the `/full` and lands on that thread's address above (`lib/retiredFullPage.ts`, read by `main.tsx` on a cold load and `routes.tsx` in the app); an unprefixed one becomes a bare `/thread/<t>`, which lands on `/` |
| `/?project=<slug>`, `/?focus=<slug>`, `/?all`, `/?embed=vscode` | the view's addresses from 2026-09-29 to 2026-10-06 — redirected to `/project/<slug>` and `/all` (an older editor sidebar's bare `/?embed=…` asked for All projects), the rest of the query riding along (`lib/pageView.ts legacyViewRedirect`); a drawer's old `/all/<s>/thread/<t>?project=…` lands on `/project/<s>/thread/<t>` |
| `/projects`, `/queues`, `/all/<slug>` | All projects' old names, and a drawer's address cut short: redirected to `/all`, keeping the query |
| anything else — `/status/…`, a bare `/thread/<t>` | redirects to `/`, keeping its query (`?add`, `?unknown`). These are deliberately NOT translated (David 2026-09-28: "backward compat not important at this point") |

**THE VIEW IS THE PATH, per tab, and nowhere shared.** `/project/<slug>…` is a board and anything else All projects, a drawer's address included, so a drawer's close goes back to the view it sat on with nothing to remember (a tab kept its view in `sessionStorage` from 2026-09-29 to 2026-10-06, while a drawer's address could not say). Nothing is shared between tabs but the address a bare `/` goes to: the view the BROWSER showed last, whichever tab showed it (`lib/crossProject.ts rememberLastView`, 2026-10-06; `/` meant All projects from 2026-09-30, and before that reopened the tab's or the browser's last-focused project). Two tabs on two projects therefore stay on them across reloads whatever the other does — which is why the view is NOT the prompt box's pick, a per-browser setting that one tab's choice would change under the other.

**The page is BOUND to one project, the page project**: on a board, the board's; in All projects, the prompt box's PICK (its project pill, beside the model); under a drawer, the drawer's. The route (`routes.tsx CrossProjectPage`) resolves it and hands it to `base-path.ts` with `setHomeFocus`, which then answers `/all` (and a phone's `/`) as it answers `/all/<slug>` — same API base, same live feed, same cache scope — so the whole drawer stack, prompt box, router sync and notifications work for it. Opening ANOTHER project's thread navigates to `/all/<other>/thread/<t>` in All projects, where other projects' rows show, and to that project's board, `/project/<other>/thread/<t>`, from a board (`base-path.ts crossProjectHref`, as upstream's links did): the route resets the store and rebinds the feed, and `<App/>` is keyed by a constant so the page itself survives. Closing the last drawer goes home to THIS TAB'S view (`lib/pageView.ts homeHref`, through `lib/router.ts`), never to a bare `/` that would have to guess it again.

**The switcher changes the view, by navigating** (2026-09-29; it replaced the QUEUE FILTER, which from 2026-09-28 scoped the right column per tab while the list kept every project). It is the page's TITLE, at the left end of the status row over the prompt box (`components/ProjectSwitcher.tsx`, placed by `AllQueues.tsx Switcher` into `StatusRow`'s `title`) — it sat at the right end of the READY header until later on 2026-09-29, where it read as a filter on the queue rather than the scope of the whole page — and names the view — the project's square and name, or "All projects" — with a menu of every project, the Home workspace included, each with its asks, its Running and its Queue count, with All projects above them all and Add a project under them. A choice is a navigation (`/project/<slug>`, `/all`), so Back undoes it; leaving a project for All projects carries it over as the pick, so the prompt box keeps aiming where the operator just was. The other doors: "Focus on this project" / "Show all projects" in a project row's ⋯ menu (`components/ProjectActions.tsx ProjectMenu`, which also holds "Open on GitHub", the icon, rename and delete); a card's project chip, drawn in All projects only; a board's ⌂ crumb, to `/all`; and ⌥↑/⌥↓ in the prompt box, which step a board through the projects as they step the picker in All projects. On a board it is the only place the project's name is drawn: a project's board draws no project row at all (the line pays for the band headers), so the thread cord starts at the first band's header glyph; the status row carries the board's door home before the switcher and its owner/repo and ⋯ menu after it (`StatusRow.tsx`, `BoardIdentity.tsx`). The queue filter's one idea that survives is the maintainer's: the UI says what it did — on a board, the list shows the one project, so nothing on the page implies more than is there.

**No door leads anywhere else, because there is nowhere else** (David 2026-09-28: "too many places in the ui where it is easy to navigate to a ui which is not the primary home ui"). The status row (`components/StatusRow.tsx`) is the switcher, then settings, keyboard shortcuts and restart, then the quota readouts — on a board led by ⌂, the door back to All projects at `/all`, and followed by the project's repo; the ∞ door to Everything is gone from it (maintainer: "there should no longer be an everything or an infinity button").

`scripts/verify-focus-mode.mjs` drives a project's board on a seeded four-project stack — `/project/<slug>` and the query-era addresses that land there, two tabs on two boards across reloads, a bare `/` going back to the last view (a board, All projects once chosen) and in a fresh browser to All projects, a phone's dock, the switcher and Back, a drawer closing back to the tab's view, a card's chip and the board's ⋯ menu and a dock square's right-click menu moving between views, an unknown board, the board's tier list (`components/TierList.tsx`: the tiers in order, Pinned, Ready and Working never folding, Snoozed folded to start, Done today a plain header over its rows) and the cord through each run, a phone's width (its header has the invocation; `--only=<words>` runs one step). All projects is driven by `scripts/verify-all-queues.mjs` (see below).

This page absorbed the project grid (`/projects`) on 2026-09-24: adding a project is the list's last row (and Add a project in the switcher's menu), both through the one dialog `store.addProject` opens, and a machine with no usable project gets the welcome page at `/`.

`packages/web/src/lib/base-path.ts` is the single definition, and every URL a client builds or parses goes through it:

| helper | answers |
| --- | --- |
| `projectSlug(path)` | the project this page is bound to — the `<slug>` of `/project/<slug>…` or `/all/<slug>…` in the address, or at `/all` (and a phone's `/`) the focus `setHomeFocus` was handed — or `undefined` where there is none |
| `isCrossProjectPath(path)` | whether this is the page (`/all` or `/` with a focus, `/all/<slug>…` or a board's `/project/<slug>…`), rather than the welcome |
| `isProjectBoardPath(path)` | whether this is a project's board — only its exact shapes (`PROJECT_BOARD`): `/project/<slug>`, `…/thread/<t>` (and its retired `/full`), `…/status/<s>` |
| `basePath(path)` | `/project/<slug>` on a board, `/all/<slug>` on All projects (`/all` answers `/all/<focus>`), or `""` |
| `innerPath(path)` | the path with the prefix removed — what the ROUTER reasons about |
| `outerPath(inner)` | an inner path put back in ADDRESS-BAR terms; the inner `/` is the board on a board, `/all` on All projects whichever project a drawer had bound, and `/` at a phone's `/` |
| `apiBase(path)` | `/_ntwine/<slug>`, or `/_ntwine` unprefixed |
| `crossProjectHref(slug)` | `/project/<slug>` on a board, `/all/<slug>` elsewhere, only ever with a thread's path after it — the one place that knows the shape, so a thread opened in place keeps the page's view |
| `prefixedAppRoute(href)` | an agent-written `/thread/<slug>` re-pointed at this page's project |

The VIEW's addresses are `lib/pageView.ts`'s: `viewHref` / `projectViewHref` (`/all`, `/project/<slug>`), `viewAt` (what a page at an address shows), `homeHref` (the page under the drawers, with none open — the board or `/all`, never `/`), and `legacyViewRedirect` (where a query-era address lands). Where a bare `/` goes is `lib/crossProject.ts lastViewHref`.

**AN EMPTY BASE IS A SUPPORTED STATE**, and a narrow one now: a page with no project at all (the welcome). Until 2026-09-28 the launching project was also served unprefixed at `/thread/<slug>` and `/status/<name>`, so every pre-singleton bookmark still resolved; those now land on `/` like any other unknown address. An unprefixed link is still not a shape to MINT: built without the prefix, it silently addresses whichever project started the server, which is how the drawer's ↗ button came to open a stranger's board (2026-08-07). Build outward-facing URLs with `outerPath`/`crossProjectHref`; parse with `innerPath`.

## The Home workspace (a board for work that belongs to no project)

Some work has no project yet — cloning a repository, a question about the machine, a scratch script — and until 2026-09-28 it was filed under whichever project the prompt box happened to point at. **Home** is the prompt box's other target: a built-in workspace whose agents run in the operator's home folder. It behaves like any project everywhere a project is drawn — an entry in the switcher and in All projects' list with its threads under it, cards in the queue and a board of its own at `/project/home`, drawers at `/all/home/thread/<t>` — and it is synthesized by `packages/server/src/home-workspace.ts`, never written into `registry.json`.

**It cannot be a registered project, because its board cannot live at `<folder>/.ntwine/`.** For the home folder that is `~/.ntwine`, which is not a free name: it IS the data root on every install that predates the XDG layout, and on every other install its mere existence switches ntwine back to it at the next boot (`ntwine-paths.ts`), taking every project's threads with it. So Home's `Project` splits the two directories a registered project keeps as one — `dir` is its STATE DIRECTORY (`<data>/projects/686f6d65-0000-4000-8000-000000000000/`, the id is "home" in hex), which holds its board; `workDir` is the folder its agents run in. `workDirOf(project)` (`project.ts`) is the agent side — spawn and resume cwd, transcript sharding, tailer cwds, edited files, file roots, the terminal — and every site that means "the board" keeps reading `dir`. A site that should read `workDirOf` and does not puts an agent in ntwine's state directory: visibly wrong, never `~/.ntwine`. As a second guard, `ntwinePaths` ignores a `~/.ntwine` that holds only board entries (`threads/`, `.id`, …) and nothing of a data root.

**A worker's scratch directory is therefore not under its cwd.** Dispatch hands it the ABSOLUTE path (`workerScratchPath`, `dispatch.ts`) whenever the board root is not the cwd, and the cc-worker hooks that create and announce it read the board root from `NTWINE_BOARD_ROOT` (the Claude broker's worker env) or `--board-root=` (the Codex hook command) before falling back to `CLAUDE_PROJECT_DIR`/cwd. For a registered project nothing changes: both are the project folder and every prompt stays byte-identical.

**It stays out of the registry's own lookups on purpose.** The launcher picks a project to host the server from `listProjects` (`src/launcher.ts` `mostRecentProject`) and resolves it as a workspace, which would mint `.ntwine/.id` in the home folder. Only the SERVER's surfaces ask for workspaces — `listWorkspaces`, `findWorkspaceBySegment`, `projectForEntry` — for the project list, routing and tenant priming. `home` is a reserved slug; a project registered as `home` before that keeps its address, and Home then answers on its id.

What Home does NOT have: a repository (no GitHub identity, even when the home folder is a dotfiles repo), an icon, a rename, a delete. On the page it is drawn as a house (`ProjectCard.home`): in All projects' list like any project (it holds no place in the drag order), last in the switcher's menu and the prompt box's picker under a rule with its folder beside it, and offered on the welcome page. It is the prompt box's pick only when CHOSEN — `defaultCrossProjectFocus` never falls back to it, so an empty machine still gets the welcome page that adds its first project.

## Held threads (a thread with no agent yet)

A **held thread** is base's one primitive for a thread written down with no agent behind it (`session.held_by`, `held-start.ts`). A held row names its holder: `schedules` for a schedule's next run, or `todo` for a **to-do** (2026-10-15): `/todo <task>` in the new-thread box writes the task down instead of starting it. A row left from lazy threads (`lazy`, 2026-10-01 to 2026-10-07) is the same feature and reads as a to-do. Base never tails and never resumes a held row, and queues only a to-do: it waits in Ready like a bare rest until it is started, marked done or snoozed (`heldThreadView`); it starts it in place (`dispatch(…, { onto })`) on the same slug and session. A message to a held thread starts it on that message, whoever holds it, so no holder can strand one. `session.lazy_prompt` stays every held row's opening prompt, so an older server generation rolled back to still reads the row as unstarted; it is never dropped or emptied.

## Scheduled threads (a saved prompt that starts a fresh thread on a calendar rule)

A **schedule** is a prompt plus a recurrence; each occurrence starts a NEW thread in the schedule's project, which lands in the queue like any other. It is the third recurring pattern beside a Goal (the same thread, on rest or a clock) and a timer (the same thread, once). Server: `schedules.ts` (the service and the tick), `schedule-store.ts` (`thread_schedule`, `thread_schedule_run`), `schedule-router.ts`, `schedule-interpreter.ts`; shared: `schedule-rule.ts` (the engine), `schedules.ts` (views, caps, the run header).

- **The model interprets; ntwine computes.** Words become one RFC 5545 `RRULE`, a wall-clock `DTSTART` and an IANA zone. `schedule-rule.ts` accepts a subset (`FREQ` HOURLY…YEARLY, `INTERVAL`, `COUNT`, `UNTIL`, `BYMONTH`, `BYMONTHDAY`, `BYDAY` with ordinals, `BYHOUR`, `BYMINUTE`, `BYSETPOS`, `WKST`) and refuses the rest with a reason an agent can act on, computes every occurrence itself, and builds the echo the human reads from the rule it will fire. RRULE, not cron, because "every other Friday", "the first weekday of the month" and "for three weeks" need an interval anchored on a start, `BYSETPOS` and `COUNT`/`UNTIL`. Its own engine, with no dependency: `rrule-temporal` pulls in a Temporal polyfill and skips a time that does not exist on a DST day. A nonexistent local time runs at the next valid one, an ambiguous one once at its first instance; `DTSTART` is an occurrence only when it matches the rule; runs closer than 15m apart are refused.
- **The zone is the human's and is stored on the schedule.** The page reports its `Intl` zone on load (`reportClientZone`), kept as a machine setting and used as the default, because a WSL or container server is often UTC while the human is not.
- **A condition stays in words and the run checks it.** "unless it's a holiday" is never compiled: the run's header opens with it, and a run whose condition does not hold finishes quietly with the reason. The run is the only evaluator with tools.
- **The next run is ONE held thread per active schedule** (`held_by = schedules`, `session.schedule_id`, `snoozed_until` = the occurrence), shown in Snoozed. Every per-occurrence act is then one the human already knows: send it to run now, Mark as done to skip, snooze to move, edit its note to change this run's prompt. The slug is reserved and the session row written before any spawn, and catch-up-once is structural.
- **Each occurrence starts at most once.** `evalScheduledThreads` on each project's tick first reconciles what the human did to the held run, then claims the occurrence in one transaction: a `thread_schedule_run` row (`UNIQUE(project_id, schedule_id, occurrence_at)`, the permanent never-twice record) and a `revision` bump guarded on the revision read. The start runs off the tick, tracked so `stop()` awaits it; a failed start is recorded and never retried. A `starting` row whose owner process is gone settles by whether its thread left the held state.
- **A missed run runs once, late, within reason.** A machine asleep for a week wakes ONE overdue run, and only within min(half the gap to the following occurrence, 12h), after a 60s post-boot grace so the tailer has vouched for the previous run; past that it is skipped, saying so. Resume never catches up.
- **Back-pressure pauses a schedule.** 3 unreviewed runs (started, not archived) pause it, and clearing them resumes it; 3 failed starts, or 3 occurrences skipped because the previous run was still working (read from a vouched view, never raw telemetry), pause it until a human resumes. At most 2 scheduled starts are in flight machine-wide. 25 schedules per project; 200 history rows per schedule.
- **A worker can only PROPOSE a schedule.** The `schedule` MCP tool creates it as `proposed`, which never fires until a human clicks Turn on; on an active schedule a worker may only `skip_next`, `move_next` and `pause`. A worker reading untrusted text must not be able to create something that runs unattended, and `ask` cannot gate it, because an unanswered question takes its recommended option.
- **A run** is the held note under a `<scheduled-run>` header: the schedule, its condition first, the occurrence and any lateness, the previous run's `@thread`. `done` takes `quiet: true` on a scheduled run alone, sending it straight to Done with its first line in the schedule's history, so an hourly check with nothing to say does not fill the queue. Runs take the schedule's title, a collision a numeric suffix.
- **The prompt box reads a schedule out of its words; there is no schedule button, mode or chord.** A closed list of schedule words (`shared/schedule-trigger.ts`, matched outside code, quotes, chips and mentions) gates ONE model read (`interpretSchedule`) that decides whether the words ask for the work to repeat and returns the phrase verbatim, the rule, the start, a condition and a title. The saved prompt is the typed text minus that phrase, never rewritten (`shared/schedule-text.ts`), and a reading is used only for the exact text submitted. The reader (`web lib/scheduleModelRead.ts`, `scheduleReadScheduler.ts`) is single-flight per draft, cached 10m across boxes, capped at 40 automatic reads per draft and 15s per read; the strip's next runs are computed in the browser from the rule. A read that fails is never cached and never read as "no schedule". Which model reads, and the measurement behind it, is the comment above `SCHEDULE_INTERPRETER_MODEL`.
- **Enter never waits on the model, and never dispatches silently in place of a schedule.** An Enter with no answer yet takes the whole draft out of the box at once and the answer settles it: a schedule is created, anything else (none, a refusal, a failed or unanswered read) starts the thread, and a toast says which. × or Esc dismisses the reading for those words, kept in the draft's sessionStorage sibling so it survives a reload. "Change when" in the schedule's drawer reads its field by the same rules and saves only a fresh reading of exactly its words.

## Time limits (a deadline a thread plans around)

A thread may carry a **deadline**, set by the human at dispatch (the prompt box's control: `30m`, `2h`, `15:30`) or later from the drawer. The worker is told to deliver the best result it can by then, is checked in with as time runs out, and passes a share to its sub-agents. Shared `deadline.ts` (the grammar, the stages, the child share), server `deadline.ts` and the scheduler's check-in source, `cc-worker/hooks/agent-deadline.mjs`.

- **There is no hard kill.** Running out never interrupts a turn or a sub-agent (the agent completion invariant); the limit is enforced by what the agent is told and by the card reading over time. Wall clock only, never tokens.
- **Only the human may extend a deadline the human set.** `deadline_set_by` records who set it. A worker's `deadline` MCP tool may read its deadline and set one where there is none. The dispatch field is honoured only from a browser (`dispatchCaller`), so a worker's own dispatch cannot mint a human's deadline. Prose such as "go until 3:30" is never parsed: the control is the only input, so the board never disagrees with the prompt.
- **The row** holds `deadline_at`, `deadline_set_at` (the generation: moving the deadline restarts the check-ins, whose delivery ids are keyed on it), `deadline_set_by` and `deadline_stage` (the last stage queued, so none is sent twice). A re-dispatch onto a new session drops it; a resume keeps it.
- **Check-ins come at fixed stages**, delivered mid-turn the way a Goal heartbeat is, or as a wake to a resting thread: `half` (50%, which says it is not a signal to wrap up), `converge` (80%), `final` (95%, or 5m before if that is earlier, never before 87.5%), `over`. Only the latest due stage is sent. They are exempt from the wake quiet window, which otherwise held three of four stages on the first real run. A thread resting on a handoff is not woken by one; a quiet park is. Every wake header carries `· 42m left`, exact and rounded down under 10m. After `over` there is no second nag: the board is the escalation.
- **A running child hears every change (2026-10-08).** When the user sets or lifts a thread's limit — from the drawer or the machine-wide wrap-up — the router's `reachChildren` rewrites each running child's `ntwine-deadlines/<agentId>.json` with its share (`setChildDeadline` in `agent-inbox.ts`, `setBy: "user"`), and posts the wrap-up's note to its mailbox. The child's own hook then introduces the limit after its next tool call and runs its check-ins against it. A share of the thread's limit FOLLOWS it — moved later on an extend, removed on a lift — while a limit the dispatcher declared with `Time limit:` stays its own, clamped under the new ceiling (2026-10-14: before this a cleared or extended thread kept its children counting down to the old time). "Running children" is the tailer's `liveMailboxes`: direct sub-agents, their descendants and live Workflow agents; a finished direct child counts again only while its transcript is fresh (resumed with SendMessage), after one 5m limit was written into 149 finished children. Measured cause: at a 5m wrap-up four parents handed off within 50s while their twelve children ran on unaware. The wrap-up also covers a QUEUED thread whose children are still running, setting its limit and theirs without waking the resting worker.
- **One limit on every running thread, machine-wide.** The stopwatch in the status row beside the restart button (All projects and every board), or the command palette's "Time limit for running threads…" (`RunningTimeLimitDialog.tsx` → router `setRunningDeadlines`) sets one human deadline on every Running thread in every open project, with an optional note quoted into each worker's notice — the way to say "restarting the machine in 15m" before a reboot, which ends the agent daemons an ntwine restart does not. Queued and snoozed threads are left alone, and a thread already due sooner keeps its time but still gets the note.
- **It bounds what would outrun it.** Goal deliveries stop at the deadline, and an `awaiting` park's `for:` is clamped to it. A usage-limit pause does not stop the clock.
- **Sub-agents get a share (Claude only).** `agent-dispatch.mjs` adds the child's deadline above the dispatch epilogue, ending in a marker line `⟦ntwine-deadline⟧ <deadline> <start>`, plus ` declared=<end>` when the dispatch declared its own limit. A `Time limit: 20m` line in the dispatch declares the share and is stripped; without one the child gets the parent's remaining time minus a reserve of max(20%, 5m), capped at half. A declared limit is clamped to the same ceiling, and the floor is 1m. The child's first PostToolUse (`agent-inbox.mjs`) reads the marker back out of its own transcript, whose first record is the rewritten prompt, because SubagentStart carries no tool-use id and races sibling dispatches (measured on Claude Code 2.1.287). Each stage is claimed by an exclusive file create under `<sessionDir>/ntwine-deadlines/`. `agent-deadline.mjs` is a plain-JS twin of shared `deadline.ts`, because hooks run under bare node, and `agent-deadline-hook.test.ts` pins the two together. A Workflow agent works out its share from its first record's timestamp and is told the limit in its first check-in. A child already running when the user sets, moves or lifts its thread's limit is reached from the server instead (the bullet above).

## Switching projects without a document load (the invariants that keep one project's data off another's page)

The singleton's characteristic bug is not a crash: it is **another project's board, transcript or settings rendered under this project's URL, silently**. It shipped once (2026-08-11, `/project/ntwine` showing the zod board on every board on the machine), and auditing it turned up two more live instances, so treat this section as load-bearing rather than descriptive. The reason the class keeps recurring is that "which project" used to be AMBIENT — re-derived from `location` by a dozen modules — and never travelled WITH the data, while thread slugs are unique only WITHIN a project. Nothing downstream can tell one project's payload from another's unless the payload says.

**Nothing keeps a second copy of "which project we are on".** The module that HOLDS the live connection answers `feedIsBoundTo(slug)` (`api/socket.ts`); `routes.tsx` asks it rather than remembering. The shipped bug was a `useRef` guard in a component: react-router unmounts one element and mounts another whenever the matched ROUTE changes (the old project grid to a board, a board to a thread page), so the ref was reborn equal to the new slug and reported "already bound" while the socket sat on the previous project. A bystander with nothing to remember cannot get it wrong, and being asked redundantly is free.

**A board must say which project it is, and is refused at the door if it is not ours.** The server stamps `BoardSnapshot.projectSlug`; `setBoard`/`seedBoard` check it through `ownedByThisPage` (`lib/projectOwnership.ts`). This rests on the payload's own evidence rather than on client bookkeeping — which is the thing that failed — and it is what catches the seed race: `seedBoard` takes a board only when the store is EMPTY, which is precisely the state a switch leaves behind, so the previous project's in-flight `rpc.board()` walks straight in. The check is deliberately permissive when the PAGE names no project (the unprefixed launching project) or the PAYLOAD names none (a pre-restart server, a test fixture): refusing on a guess would blank a working board.

**Nothing renders against the project you left, not even for one commit.** The switch resets the store (`resetProjectState`) in an effect, because a render must not have side effects, so the first commit under the new URL still holds the old project's board, drawer stack and drafts. `routes.tsx` therefore renders nothing under `BoardRoute`/`StandaloneRoute` until `useProjectBinding` says the feed is bound to this project AND the stored board passes `ownedByThisPage`; the reset runs in a layout effect and reopens the gate in the same task. Before that gate, every per-thread hook in the remounted `<App/>` asked the NEW project's API about the OLD project's slugs — wasted `threadTranscript`/`threadSettledQuestions` reads, a 500 from `threadProfileOptions` (#50 gated that query alone), and a write: a drawer open across the switch sent `threadSeen` to the new project and marked its same-slug thread read (2026-10-08). Do not answer the next instance of this with a per-query `enabled:` check; the tree gate already covers it, and if something slips past, the gate is what is wrong.

**A live connection is stamped with the project it was opened for, and drops what arrives after the page moves.** Both transports do it (`api/socket.ts`, `api/sse.ts`). This is what covers TRANSCRIPT frames, which name a thread and nothing else — no downstream check can tell alpha's `fix-auth` from beta's, so only the socket, which knows what it was opened for, can. A switch is `rebindProject()`, the single entry point, which re-opens whichever transport is live: a session that fell back to SSE switches projects too, and did not for a long time because `rebindSSEProject` sat exported with no caller.

**The query cache is scoped per project at the HASH, not by prefixing keys.** `queryKeyHashFn` (`lib/queryKeyScope.ts`) folds the page's project into every cache-entry identity, so a query written tomorrow is scoped without its author knowing this problem exists. `MACHINE_WIDE` lists the exceptions — the machine-wide reads (`projectsList`, `projectsQueues`, …), and `["ofProject", <id>, …]`, a key that carries its project itself. There is no per-switch cache wipe any more, and that is a gain: one project's entries are invisible to another rather than deleted in front of it, so switching back finds a warm cache and a late response has nowhere wrong to land.

**Anything that outlives the moment it was started captures its project BEFORE it — an `await`, and a callback that fires later.** `apiBase()`/`projectSlug()` answer for whatever the address bar says at the instant they are called, which is correct at send time and wrong in a continuation. Reading a large file is long enough to switch projects, which is how an attachment came to be filed in a project the message was never going to (`Composer.uploadAttachment`). A desktop notification is worse, because it is raised only while the window is HIDDEN and clicked whenever the operator comes back: its click handler now carries the project it was raised for (`notify` in `api/board-stream.ts`), instead of opening that slug in whatever project is on screen — which did not fail, it opened a different thread that happened to share the name.

**A surface showing ANOTHER project's thread must name that project on every call.** On the cross-project page every "which project" helper above answers the FOCUS, and every other project's card is somebody else's, so each card carries its own: reads and writes go through `projectRpc(projectId)` (`api/rpc.ts`, addressed by id), cache keys start `["ofProject", projectId, …]`, prose renders under `MarkdownScopeContext` (the project's repo, directory and app path — never the module-global repo), the shared Snooze and Mark-as-done buttons take their client from `ThreadProjectScope` (`api/threadApi.tsx`) and skip the page-level overlays keyed by bare slug — a steer sent from a card or a row is filed under the thread's key instead (`lib/steering.ts markSteeredIn`), which the project list reads back for that project's row (`lib/listBands.ts`), a thread terminal's Stop and its `/term/<id>` socket on a card go through the same scope (`useThreadApiBase`), and the reply box uploads to `projectApiBase(projectId)`. A same-slug thread in two projects is the case that proves it; `scripts/verify-all-queues.mjs` drives it in a real browser, along with the page itself (opening in place, returning to the pick, a follow-up from a tenant's drawer, a tenant thread's terminal at a prompt). And anything WAITING to be sent captures its project when it is committed, not when it goes out — a follow-up queued behind another (`SendTarget`, `lib/eagerComposerSubmission.ts`) or a toast's "Open thread" (`ToastLink.project`) — because on this page the focus moves whenever a drawer of another project opens.

**A page with no project bound refuses a call that needs one.** At `/all` or `/` before the route binds its pick, or with nothing to pick, `apiBase()` is the unprefixed `/_ntwine` — the project that launched the server, a stranger to the page. So `routeCall` (`api/rpc.ts`) throws, as a rejected call, for anything plain `rpc` sends there carrying a thread slug (bar `threadLocate`, which searches every project) or naming a procedure in `PROJECT_SCOPED_PROCEDURES`, instead of reading or writing that project's state and looking like it worked. A call that names its project goes through `projectRpc` and never reaches it. (Upstream's Console guard, 759c3255, in this page's terms; the Console itself did not come in.)

**A URL naming a project that does not exist is answered by the SERVER.** `/project/<slug>…` and `/all/<slug>/…` are SPA routes, so the client used to be handed the app for a slug nobody has (renamed, removed), whereupon every call 404s, the board never lands, and the page retries forever on its boot spinner. `unknownProjectPage` (`packages/server/src/index.ts`) redirects to `/?unknown=<slug>`, and the page says what happened in a toast ("No project named …") as `/` sends it on to the last view. It matches `/project/<slug>` and `/all/<slug>` (`/project/` was off the list from 2026-09-28 to 2026-10-06, while it named nothing).

Two browser-level checks live in `packages/web/src/lib/projectSwitch.e2e.test.ts` (opt-in — see its header for the `adhoc-stack.mjs` invocation, the `NTWINE_PROJECT_SWITCH_E2E_URL` env, and `NTWINE_PROJECT_SWITCH_E2E_HOME`, which the stale-render check needs to seed threads): the feed follows the URL, and a switch sends none of the old project's slugs to the new one. The unit-level pins are `api/projectFeed.test.ts`, `lib/projectOwnership.test.ts` and `lib/queryKeyScope.test.ts`; each has a negative control, which is the bar to keep when adding to them.

## CLI launcher

Two entry points, deliberately distinct:

- **`npx ntwine`** installs a stable, small `ntwine` shell that resolves a compatible `ntwine-server`
  generation into an immutable managed directory. The shell package contains only `dist/ntwine.js`;
  its `ntwineServer` manifest field names the default server package/version and compatibility epoch.
  `prepare-package.mjs --server` stages the public server's runtime closure at
  `packages/server-release/`: `web-dist/` (built client), `runtime/board/` (the board parser the
  server shells out to), and `runtime/cc-worker/` (the worker plugin dispatch loads), while
  `build-package.mjs --server` emits `dist/dev-child.js` plus every detached daemon sibling. The
  runtime tree MUST keep board and cc-worker as siblings because the worker shims reach back
  relatively (`../../board`); it is a COPY rather than a `files` entry naming source directories, so
  every public server path remains build output. Root prepack intentionally leaves this staging in
  place: `npm pack --ignore-scripts packages/server-release` is the reproducible standalone server
  pack after a root build. Both build paths assert the same closure (`src/worker-plugin-closure.ts`);
  widening it is one edit.
- **`ntwine-dev`** (`pnpm run ntwine-dev:install`) is source-backed at launch only: the shim holds an
  absolute pointer to this checkout's CLI entrypoint. On each fresh launch it selects a
  verified immutable artifact matching the current source fingerprint, reuses an identical global one,
  or builds and promotes one. **The running server never watches the checkout and never runs HMR** —
  edits do nothing until you stop ntwine and relaunch.

### What a launch is about, and who decides

**`npx ntwine` holds no rule about folders.** The folder the command is typed in is what the launch is about and nothing else: the server always runs on ntwine's own folder (`<data>/host`, `hostWorkspace`), never on a project, and the launcher asks the running server where to land — `POST /_ntwine/control/launch` with the folder, answered by [`launch-routing.ts`](packages/server/src/launch-routing.ts). The server classifies it (a project ntwine knows opens; one that looks like a project is offered at `/?add=`; anything else is the dashboard), registers a known one, and returns the path. The request carries the owner token from the record that names the server, as `/control/stop` does, because answering can register a folder.

Two things follow, and both are why it is built this way ([`plans/server-side-launch-routing.md`](plans/server-side-launch-routing.md)). A change to launch behaviour is a `ntwine-server` release, where it used to need a `ntwine` shell release because the launcher carried its own bundled copy of the rule: four of the seven shell releases between 2026-10-01 and 2026-10-11 changed nothing else. And no user folder is load-bearing for the machine's board: the folder a launch was typed in can be deleted, moved or unmounted and Restart and Update still work, and the remote sign-in key no longer depends on where ntwine was started (it lives in the stand-in's state folder, carried over once by `adoptSessionState`).

The launcher keeps the rules it used to apply as a **frozen fallback** (`legacyLanding` in [`src/production.ts`](src/production.ts)), for a server that predates the route or is not answering. Change the rule in `launch-routing.ts`; an edit to the fallback reaches nobody until the next shell release. `ntwine-dev` is unchanged: it has no release to wait for, and still runs its server on the project it is typed in.

**One project, one server.** Because the installed ntwine opens every project as one of many, the launch lease on the folder a server runs on no longer says who has a project open. Each server writes a serving record into the state folder of every project it opens ([`project-serving.ts`](packages/server/src/project-serving.ts)). A second server refuses a project whose record names another live process, and names that process. This covers a board request, a launch, a server booting on the project, and `ntwine-dev` typed in it. The alternative is two schedulers firing the same timers and recurring prompts. The record keeps the project's folder after the server closes it, and registry recovery reads it first.

State is keyed by a stable checkout UUID: an ordinary worktree keeps it in `git config --local ntwine.id`,
each linked worktree in its private Git admin dir, so siblings stay isolated. Canonical real paths make
a checkout opened through a symlink reuse the same instance. The project id and its state dir are the
whole identity — there is no multiplexer and nothing else to key.

### Stable server updates

The registry launcher owns the public proxy and recovery listener for its entire lifetime. It installs an exact `ntwine-server` version with npm's JavaScript entry under the current Node executable, with lifecycle scripts disabled and a private prefix. No shell startup hooks, global provider upgrades or project permission changes are part of this operation. The server needs no lifecycle script on any platform: its only native addon, `@parcel/watcher`, ships each platform's binary as an optional package. Sign-in ran on node-pty until 2026-09-24, which publishes no Linux prebuild, so every Linux and WSL generation died at boot (upstream PR #42); it runs the provider CLI over pipes now.

An update stages and validates the candidate while the old server continues serving, drains the old child, then starts the candidate. After authenticated readiness and a short stability interval, it atomically commits the active generation. Candidate failures restore the previous same-epoch selection. Frontend assets, provider daemons and worker plugin files come from that same immutable server generation; retained generations protect detached workers still using their files.

**A worker that is already running follows the update; nobody reloads it.** A worker's daemon is detached and outlives the server that started it, so an update used to leave every live thread on the previous generation's hooks, skills and sub-agent profiles until it happened to restart. Now the server stages the generation's `runtime/cc-worker` under `<cache>/plugins/<content digest>/` and launches every worker against one stable link, `<cache>/current/cc-worker` ([`stable-plugin-path.ts`](packages/server/src/stable-plugin-path.ts), `workerPluginDir()` in [`dispatch.ts`](packages/server/src/dispatch.ts)). Booting the next generation repoints that link, by rename, and two things follow. Hook SCRIPTS move at once, because `${CLAUDE_PLUGIN_ROOT}/hooks/…` is resolved through the link on every run; the hook paths and monitor directory a Codex thread is given go through the same link. Hook REGISTRATIONS, skills and sub-agent profiles move when each Claude worker's daemon next reaches a turn boundary: it fingerprints its plugin closure when a turn ends and when an input arrives for an idle session, and re-reads it in place when it changed ([`claude-plugin-sync.ts`](packages/server/src/backend/claude-plugin-sync.ts)) — same process, same conversation. A source checkout is launched against its own `cc-worker/`, which is edited in place, and the same fingerprint picks those edits up. The closure is wider than ntwine's plugin: it also covers the project's and the operator's own `.claude` skills, agents, commands and installed plugins, because a live session notices none of those by itself either, so a skill added to a repo reaches the threads already running in it at their next turn. Two things do not move: a worker's MCP servers, which a reload reports and does not re-spawn (so the legacy ntwine MCP shim re-resolves its server on every call instead; `ntwinectl` needs no such care, because a shell finds it on PATH at each call), and a daemon forked before 2026-10-11, which was launched against its generation's own directory and catches up when it next cold-starts. `NTWINE_PLUGIN_SYNC_OFF=1` switches the reload off for newly started workers.

**A Codex thread follows it too, by a different road.** A Codex thread has no plugin. What ntwine gives it is per-thread config — its MCP mount, its hooks, the reasoning-summary setting — and Codex keeps that nowhere but in the loaded thread: when a `thread/resume` rebuilds a thread, it is built from the bag in that one request. So the bridge builds the whole bag in one place (`threadConfig()` in [`codex-app-server.ts`](packages/server/src/backend/codex-app-server.ts), fed by `codexWorkerThreadConfig()` in [`dispatch.ts`](packages/server/src/dispatch.ts)) and sends it with the start and with every resume. Until 2026-10-11 the hooks rode `thread/start` alone, and every Codex thread lost them at its first resume after any ntwine restart. What a resume does with the bag was measured on codex 0.161.0, since nothing documents it: an idle thread no connection subscribes to is torn down and rebuilt with it, and a thread that is mid-turn, or that a connection still subscribes to, is only rejoined. Three cases follow. A thread idle at the update is rebuilt by the new server at its first message. One that was mid-turn is released (`thread/unsubscribe`) and resumed before its NEXT turn, never during one. One that holds a background command is rejoined with no bag at all, because a rebuild ends the thread's commands, and moves once the command has ended. It is the same app-server process and the whole conversation throughout, and `spawn_agent` children are not touched. Unlike a Claude worker's, a Codex thread's MCP shim moves with the rest. What does not move is `baseInstructions`, the worker contract and `NTWINE.md` as they stood when the thread was dispatched, which ntwine never re-sends. [`_live_codex_config_sync.mts`](packages/server/src/backend/_live_codex_config_sync.mts) is the check, against a mock model provider so that it needs no Codex sign-in, and the same `NTWINE_PLUGIN_SYNC_OFF=1` switches the rebuild off.

A global generation-checked lease in the ntwine state root keeps stable launchers from starting separate schedulers across repositories or custom ports. Each server child registers as a delegate before opening application state. After a launcher crash, a replacement cannot acquire that lease until its live delegates have exited. A second launch joins the recorded public listener even while the application child is unavailable.

**A shell newer than the installed server is the ordinary pairing.** `npx ntwine` fetches the newest shell on every run, and the server moves only on Update: `ServerReleaseStore.load()` boots the selected release and reads the shell's pin only for a machine that has none. A shell that needs something a server release learned declares it as `ntwineServer.minimum`. At a cold start a selection below that is replaced by the pinned release through the path a new machine takes: staged, validated, booted, and recorded as the selection only once it is up. It never runs while a server is serving, and it never moves a server down. The first minimum is 0.15.21, the release that keeps ntwine's own launch folder off the dashboard, which a shell from 0.13.13 hosts every launch outside a project on.

Protocol and data epoch are explicit compatibility contracts. Ordinary updates reject a mismatched epoch before draining. An explicitly newer compatible shell may stage its exact next-epoch bootstrap server, but advances a global compatibility marker before that server can write data; lower-epoch shells then fail closed, including after a pre-readiness crash. Protocol changes require a separately designed migration. Pre-split binaries cannot honor a marker they predate, so manually downgrading to those releases is unsupported.

### Browser launch modes

The default launch makes one standard OS request to open the localhost URL in the default browser; the
browser decides which window receives it. ntwine does not scan, reuse, focus, or privately address tabs.

`--app` preserves the legacy dedicated/chromeless window as an explicit opt-in. On macOS that window
gets its own Dock name and icon: on first opt-in launch the launcher silently installs the ntwine PWA
into the project's browser profile over CDP (`--remote-debugging-pipe` → `PWA.install` +
`PWA.changeAppUserSettings(displayMode: standalone)`; windowless, ~3-4s, once per machine). Chrome then
generates a real app-shim bundle at `~/Applications/Chrome Apps.localized/ntwine.app` and every launch
goes through it. Why it works this way (all verified empirically on Chrome 150 / macOS):

- A plain `--app=` window is owned by the Chrome browser process — the Dock shows "Google Chrome", no
  launch flag changes it, and a hand-rolled `.app` that `exec`s Chrome loses its identity the moment
  Chrome's Cocoa startup re-registers the process. Chrome's generated app-shim is the only mechanism
  that yields an own Dock identity.
- The CDP `PWA.*` domain is only exposed on `--remote-debugging-pipe` connections (port-based
  websocket clients lack `AllowUnsafeOperations`), and a CDP install defaults the app to open-in-a-tab
  — `changeAppUserSettings(displayMode: "standalone")` is the required second half.
- Shim detection is stateless: scan shim `Info.plist`s for `CrAppModeShortcutURL` == the launch URL and
  `CrAppModeUserDataDir` under the project profile. (Chrome's generated app id is NOT a reproducible
  hash of the URL — don't try.)

Failure at any opt-in app step falls back silently to a plain `--app` window.
`packages/web/public/favicon.svg` is the canonical artwork; `node scripts/generate-icons.mjs`
regenerates its six tracked PNG derivatives (`--check` detects drift, `--refresh-app-icons` refreshes
ICNS in idle shims). *Windows/Linux Dock branding is an unwired TODO:* Windows would set an
`AppUserModelID` on a generated `.lnk`; Linux (X11) would pass `--class=ntwine` + a `.desktop` file whose
`StartupWMClass` matches.

### VS Code extension

[`packages/vscode`](packages/vscode/README.md) connects each editor window to the one server, in both
directions: a selection becomes a new thread (Ask ntwine), a follow-up (Send to ntwine thread) or a chip
in the page's prompt box (Add to ntwine prompt), and a file link clicked on the page opens in the window
that has its folder open, at the line it names. It also frames the page in an editor sidebar and gives
every worker the editor through the `editor` MCP tool.

- **The extension dials the server, never the reverse.** Each window holds one WebSocket to the
  MACHINE-WIDE `/_ntwine/editor` (`server/src/editor-bridge.ts`), answered in `index.ts`'s upgrade
  handler before tenant routing. It says which folders the window has open and whether it has focus;
  the server sends it files to open, folders to raise, and every project with its Ready and Working counts (`ready`/`working` on the wire).
  Frames are pinned in `shared/src/editor-protocol.ts` (plain types the extension bundles) and validated
  by their zod twins in the shared index. Ask and Send use the ordinary RPCs, addressed by project id.
- **`openLocalFile` tries a connected window first** when the Local file links app names its editor family
  (`vscode`, `cursor`, or `$EDITOR`'s), choosing the window whose folder contains the file, then the
  most recently focused one on the same machine; otherwise it spawns the CLI as before, now with
  `-g path:line:col`. Positions travel as `line`/`column`/`endLine` beside the path, parsed by the one
  grammar in `shared/src/file-position.ts` (`a.ts:12:3`, `a.ts#L12-L20`).
- **Prompt-box inserts are claimed, not broadcast.** The server holds what an editor sends and
  publishes a payload-free `compose-pending` on every open project's bus; the page that has focus takes
  it with `composeTake`, so exactly one tab inserts it (`web/src/lib/editorBridge.ts`).
- **The protocol stays v1 and grows by advertisement.** The server closes a socket on any frame it
  does not know, on every redial, so the welcome names `features` (`editor-state`, `sidebar`,
  `attention`, `review`, …) and the extension sends a newer frame or field only to an ntwine that named
  it. Limits: 64 KiB a frame (128 KiB for compose), 64 folders, 32 windows; the extension fits itself to
  them rather than be refused.
- **The sidebar is the real page, framed** (`?embed=vscode`, `web/src/lib/embed.ts`): the app's own
  queue, cards and composer, so nothing is drawn twice and an approval button cannot drift from the
  page's. A native rebuild, a TreeView and a chat participant (which Cursor cannot host) were each
  rejected for that. The page and the extension talk only through `shared/src/embed-protocol.ts`,
  relayed by the webview document, never through the server. In embed mode the page is the wide layout
  narrowed, not the phone layout, and a code link opens in the window holding the sidebar. The frame's
  storage is partitioned from the browser's by design: it is another browser. An editor tab
  (`ntwine.thread`) frames the same page on a thread's own address.
- **What the editor shows is one reading behind one switch.** `packages/vscode` `editor-front.ts`
  decides the editor in front for the sidebar's context bar, the editor-context block every sidebar
  send carries, and the agents' `editor` tool, so the three never disagree; `ntwine.shareEditorState`
  (the bar's eye) governs all three. A selection's TEXT never leaves from a file whose name says it holds
  secrets, or that `files.exclude` hides; its path and lines still do. `editorState` describes only the
  windows that have the caller's project open and counts the rest. A held thread carries no editor
  block, since it would be read hours later as the moment of launch.
- **Worktrees: everything that crosses names its copy.** The `editor` tool, sidebar sends and a
  thread's links resolve against the thread's checkout first, then the project. A worker never attaches to the
  human's IDE: `inheritWorkerEnvironment` drops Claude Code's IDE variables, and a Claude worker gets
  `CLAUDE_CODE_AUTO_CONNECT_IDE=false`.
- **Review changes opens VS Code's multi-file diff.** The server names the checkouts from where the
  thread wrote (`server/src/review-target.ts`: its own worktree is the whole branch, the shared project
  folder only its files); the extension asks git (`review.ts`): files against HEAD, a branch against
  where it left the branch it came from.
- **A thread that needs the human reaches ONE window** (`attention`): the most recently focused one that
  listens and has the project open, so an old extension or a window with notifications off cannot
  swallow it. The extension says nothing while the sidebar is in sight.
- It finds the server the way the launcher does (the address record, trusted only with a live owner
  generation behind it, as `readStableServerOwner` checks; then the well-known ports with the
  launch-token proof), plus ntwine-dev's `dev-supervisor.lock`, and declares `extensionKind: ["workspace"]`
  so a Remote-WSL or SSH window runs it where the files and the server are. It ships as a `.vsix`
  (`pnpm run vscode:package`, `vscode:install`); `@vscode/vsce` is fetched per run, never installed.
  `packages/vscode/scripts/e2e.ts` drives a real VS Code under Xvfb against a fake ntwine (on stable and
  on the manifest's oldest VS Code), or with `--stack` against a disposable two-project ntwine it boots
  itself, with a headless page that must receive the prompt-box insert.

### Running against a repo outside this monorepo

Set `NTWINE_SCRIPTS_DIR` to the board parser directory and `NTWINE_WORKER_PLUGIN_DIR` to the `cc-worker`
plugin directory. The published package does this for you.

## Conventions

- TypeScript run directly by Node in a source checkout (type stripping) — no build step for
  server/cli; Vite builds web. The published package ships compiled JS instead (a dependency under
  `node_modules` cannot be type stripped), so a consumer's Node floor is `engines`, not this one.
- ESM everywhere, `type: "module"`.
- Comments sparse and dense: design/invariant/provenance only.
- Tests: `node --test`, colocated `*.test.ts`, minimal + contract-shaped.
- UI state (unread, lastReadAt, session registry, settings) lives in ONE SQLite file for the whole
  machine, `~/.ntwine/ui.db`, every row tagged with its project id (`packages/server/src/ntwine-db.ts`;
  one file per project under `~/.ntwine/projects/<projectId>/ui.db` until 2026-08-27; a leftover is
  never read, and is left in place so an older build still finds it). An ordinary/main worktree's UUID remains the repo's
  `.git/config` key `ntwine.id`; a linked worktree stores its own UUID at
  `<worktree-gitdir>/ntwine.config`, preserving ordinary state while isolating sibling DB and lock
  namespaces. NEVER store UI state in the checkout's `.ntwine/`.
- **Sidebar design philosophy (2026-07-09, maintainer-directed — don't regress it).** It was written
  for one project's board rail; since 2026-09-28 it governs the one page's left column instead — the
  status row, the prompt box and the project list under them (`AllQueues.tsx`'s `aside`, on
  `SIDEBAR_COLUMN_CLASS` from `Sidebar.tsx`) — and the bands below are each project's, under its row
  (see **Board nomenclature**). A FLOATING
  left column: NO background, NO border, NO clipping on the column itself (the New-thread pill's
  hover-scale must never clip; only the section LIST is a scroll container). A sticky full-height
  wrapper, but TOP-anchored (48px down) rather than vertically centered as the board's was: a click in
  the list changes its height, and a centred column moved the prompt box and the row just clicked out
  from under the pointer. The inner column grows to `max-h-[calc(100vh-68px)]` and scrolls internally
  only past that cap; horizontal overflow impossible by width discipline: min-w-0 everywhere +
  break-words titles. Width scales `clamp(272px, 34vw, 680px)`; it and the 720px queue sit as a
  centered pair across one `clamp(28px, 3.4vw, 52px)` gutter, stacking below 800px. Row groups keyed
  on the session-first model (`sectionOf`), in the vocabulary above, per project: on a board, Pinned,
  Ready and Working under their names, then the folded Snoozed, Done and External bands; on All
  projects, the Pinned, Ready and Working rows under the project's row, and the quiet bands as counts.
  Rows order by most-recent USER interaction (`orderByInteraction` — agent churn never
  reorders), except the Rested band, which uses the EXACT queue comparator (`orderQueue`, keyed on when
  each thread entered the queue) so the rail and the cards read in one order.
  Titles WRAP, never truncate. ONE derived indicator per row (spinner running, blue ● a live background
  shell — in Active AND in its snoozed twin, since 2026-08-31; GitHub's octocat for a PR wait and the
  hourglass for a timer wait, each in WHICHEVER band the row sits — a timer park queues, and its queued
  row wore the shell's dot until 2026-09-07; the hourglass for a user snooze, "?"
  needs-action, "!" stalled, faint · idle); a petite-caps PLAN tag marks a doc with a
  `## Plan` section (derived `hasPlan`). Rows are clicked, not walked — no arrow-walk, no
  chevron, no focus machine (all deleted): a row click opens the thread's drawer in place (chat; the
  ntwine DOC composite for a never-spawned thread — `store.openThread`) — a Ready row whose card the
  queue is showing scrolls to that card instead. The keyboard is a set of REBINDABLE shortcuts
  (`lib/keybindings.ts` defines them, `lib/keyboardRuntime.ts` runs them, the `?` sheet lists and
  rebinds them): `j`/`k` step through the queue's cards; `r` reply, `d` done and `s` snooze
  press the real control on whatever is in front of you — the top drawer or the card being read; `t` opens a terminal on that thread; `c` starts a thread and `n` adds a project. A plain key is inert
  while you type in a field and under any overlay (a thread drawer is not one, at any width); ⌘K
  (palette) and ⌘I (details) work anywhere, and Esc unwinds overlays then drawers. A machine with
  NO usable project gets the welcome page at `/` instead of the column (the zero-thread board, which
  hid its sidebar and centered the dispatch prompt as the whole screen, went with the board on
  2026-09-28).

## Provisioned runtimes (ntwine owns the Claude Code and Codex it runs)

A worker is NOT whatever `claude` or `codex` is first on the operator's PATH — it was until 2026-09-04, and that left half of each pair unpinned: the bundled Claude Agent SDK is built against ONE Claude Code build (`claudeCodeVersion` in its package.json, shipped as a matched platform package the SDK resolves by itself when handed no path), yet ntwine handed it PATH's binary, fifty-odd releases ahead on the maintainer's own machine, over a private wire nothing audited. Codex had the audited pin (`CODEX_APP_SERVER_SUPPORTED_VERSION`) but no binary behind it, so the gate merely WARNED on a newer build and the conformance test skipped on any machine that had moved on.

`packages/server/src/runtimes.ts` is the single source: one pin per backend, resolved in the `runtimes` boot phase (right after launch ownership, before the context, because every consumer — the broker bridge, the app-server daemon, `claude auth status`, the logout action, the quota readers — takes the executable as a plain string from the context). First boot on a machine fetches each exact platform binary from the vendor's own npm package (`@anthropic-ai/claude-agent-sdk-<os>-<arch>@<sdk>`, `@openai/codex@<version>-<os>-<arch>`) into `<cache>/runtimes/<backend>/<version>/`, verified against the registry's sha512 and renamed into place only complete; the launcher readout follows the download through boot progress. Every later boot is a marker read.

- **Resolution order:** an explicit executable (`StartOptions.claudeBin`/`codexBin`, or `NTWINE_CLAUDE_BIN`/`NTWINE_CODEX_BIN`) wins and is never provisioned around; then the pin; then the bare name on PATH as a WARNED fallback, so an offline machine still dispatches and the log says the version seam is open. `NTWINE_RUNTIMES=path` skips provisioning (the test runner sets it — a suite must never pull half a gigabyte); `NTWINE_RUNTIMES_DIR` relocates the root (the ad-hoc stack points a sandbox HOME at the machine's real copies).
- **Bumping a pin is a release.** The SDK version moves in `packages/claude-agent-sdk-runtime` and `CLAUDE_CODE_VERSION` follows it — `runtimes.test.ts` pins the pair to the SDK's own manifest. The Codex coordinate is the audited one and moves with the re-audit.
- **A provisioned Claude Code runs with `DISABLE_AUTOUPDATER=1`**, set on the server's own environment so every worker and every auth probe inherits it; otherwise the pin updates itself out from under ntwine.
- **The sweep keeps only the current pin**, plus any `.partial-*` younger than a day (another process may be mid-download). Nothing under `runtimes/` is precious — it is the cache root, regenerable by definition.
- **Not reused on purpose:** the vendors' own versioned installs (`~/.local/share/claude/versions/`, `~/.codex/packages/standalone/releases/`). Both prune on their own schedule, and a pin that can vanish under a running server is worse than one download.

## Codex app-server bridge (the only Codex transport)

**Codex is a first-class backend, not an experiment.** A `backend: "codex"` dispatch runs through `backend/codex-app-server.ts` and nothing else, since 2026-08-02 (`f926288f`: "both backends have exactly one transport now — codex → app-server, claude → broker"). The old opt-in flag is gone: `codexAppServerBridgeEnabled()` returns true unconditionally and the context wires the bridge at boot. This section read "Disabled by default … do not enable this flag" until 2026-09-14, and a worker that trusted it over `dispatch.ts` reported Codex as unfinished work to the maintainer — prefer the code.

- The bridge is deliberately not an `AgentBackend`: it starts new sessions and resumes only native thread ids in its own SQLite ownership table, so no existing/default/TUI Codex session can cross the boundary. The default transport is the native listener (`codex app-server --listen unix://`, `NTWINE_CODEX_NATIVE_LISTEN`), which owns its own socket and outlives every ntwine process; the hand-written daemon is the fallback.
- **The audited coordinate is `CODEX_APP_SERVER_SUPPORTED_VERSION`** (`0.154.0` at the time of writing, source tag `rust-v0.154.0`), and the acceptance rule is a FLOOR that refuses and a CEILING that only warns (`codexVersionVerdict`): an older binary is refused because it may lack params ntwine sends; a newer one runs with one loud warning, because the protocol is additive and `codex-protocol-conformance.test.ts` asks the installed binary for its own schema and fails when a param ntwine sends is gone. Moving the pin is a re-audit at the matching immutable Rust tag, then new fixtures. ntwine provisions that exact binary itself (see Provisioned runtimes).
- The wire is JSON-RPC after `initialize` / `initialized`. It rejects versioned `jsonrpc` envelopes, bounds and serializes inbound records, and never retains stderr text. No PTY or terminal scraping. `turn/steer` delivers a mid-turn follow-up and `turn/interrupt` stops a turn; both are wired.
- The child receives an explicit minimal environment, not `process.env`: executable/runtime/home,
  locale/temp, OS credential-store plumbing, proxy/custom-CA settings, and only the audited built-in
  Codex/OpenAI auth/provider variables. ntwine, GitHub, Anthropic, AWS, Node injection, and arbitrary
  `CODEX_*`/`OPENAI_*` values are excluded. Arbitrary custom-provider `env_key` support remains out of
  scope until it can be derived and approved without forwarding unrelated secrets.
- Provider responses are durably claimed once, but the interaction journal remains pending until
  Codex emits `serverRequest/resolved`. A disconnect never blindly replays an unknown send; a newly
  witnessed matching server request is required. Session/turn ownership, provider RPC ids, and
  response acknowledgements remain connection-epoch and project-session scoped. Secret user-input
  delivery fails closed until a secure transient escrow exists.
- Exact response semantics are intentionally narrow: additional permissions expose turn/session
  grants plus deny (the server treats an empty granted profile as no grant), while
  `request_user_input` exposes only answer. That protocol has no decline/cancel response; cancelling
  work is the separate `turn/interrupt` client request, never a fabricated interaction choice.
- Registry replacement/deletion atomically cancels old delivery rows and detaches the exact native
  binding before a lifecycle hook removes it and terminates the child. Bridge disconnect/close
  detaches active bindings, and action authority requires a live connection plus the exact active
  binding/epoch. Ordinary TUI sessions have no matching binding and are untouched.
- Scoped interaction reads expose only a provider-neutral delivery effect. `awaiting-user` is the
  sole provider-backed state that enables controls; durable `queued`/`sent` projects as noninteractive
  “Sending to runtime…” across remounts and restarts, and a missing bridge projects as
  `reconnect-required`. Transport ids, provider context/responses, and secret values never cross this
  RPC boundary. The board retains pending thread visibility but removes queued/sent work from Needs
  You until a genuinely actionable request exists.
- Still out of scope on purpose: arbitrary custom-provider `env_key` forwarding (above) and secret user-input delivery, which fails closed until a transient escrow exists.

## ACP backend (any Agent Client Protocol agent, as a third backend)

**`backend: "acp"` is the generic fallback beside the two rich integrations, added 2026-09-15 (design: [`plans/acp-backend.md`](plans/acp-backend.md)).** Claude keeps the SDK broker and Codex keeps the app-server bridge — quota chips, account actions, sub-agent telemetry, per-thread model/effort/permission controls all stay theirs. An ACP thread gets what the protocol carries and nothing invented on top: streamed text and reasoning, tool calls with status, permission requests as cards, a queued follow-up, cancel, and resume after a restart. Verified end to end on a disposable stack against `opencode acp` 1.18.29: the ntwine MCP tools were called through the real server, a `write` and a `bash` permission card each round-tripped, a follow-up sent mid-turn queued and delivered the instant the turn ended, `killAgent` cancelled a running `sleep` through `session/cancel`, and a follow-up after a server restart answered from the `session/load`-replayed history.

- **The agent is a model, and the agent's model rides the same slug.** The composer's profile grid lists every ACP agent found on the server's PATH under "ACP agents" with one `Default` cell (an agent runs on its own CLI's effort — ntwine has no effort axis to offer), and a MODEL DROPDOWN beside the pill (`AcpModelSelect`, 2026-09-16, maintainer: "a dropdown picker, not the grid") lists the models the agent itself advertises — ACP exposes them only as a session's `model` config option, so `rpc.acpAgentModels` opens a throwaway session per agent, reads the option and caches it ten minutes (`AcpBridge.agentModels`). The thread carries `model: "acp:<agent>"` or `"acp:<agent>@<model>"` (`@`, because model ids contain `/` and `:`; helpers in `@ntwine/shared`), `backendForModel` reads the prefix as `acp`, the bridge asks for the model with `session/set_config_option` when it opens a session (a refusal becomes an `acp-note` and the session runs on the agent's own model), and `setThreadProfile` on a live ACP thread switches it in place through the same request — the AGENT half of the slug is refused, since the session belongs to the process that opened it. The catalogue is `backend/acp-agents.ts` (opencode, cursor-agent, gemini, copilot, kilo, qwen, goose, kimi — each the executable plus the argument that puts it into ACP mode) merged with `settings.acpAgents`; agents are PATH-resolved and NEVER provisioned, and their credentials are their own CLI's (`AccountBackend` narrows sign-in, quota and logout to Claude and Codex; `/login` on an ACP thread says so).
- **Transport:** `backend/acp-rpc.ts` is a hand-rolled newline-delimited JSON-RPC 2.0 client over the child's stdio (`initialize` v1 → `session/new` or `session/load` → `session/prompt`, the prompt's response being the end of the turn). No `@agentclientprotocol/sdk`, no PTY, no scraping. One agent per live thread, held in a DETACHED DAEMON (`backend/acp-daemon.ts`, attached through `backend/acp-host.ts`, 2026-09-24) the same way the Claude broker and the Codex app-server are: an ntwine restart or crash only drops the socket, the agent and its running turn (and every sub-agent inside it) keep going, and the bridge (`backend/acp-bridge.ts`) reattaches at the next boot (`warmUp`), adopting the in-flight `session/prompt` as the live turn and raising afresh any permission card the dead runtime was holding — the daemon rewrites request ids, caches `initialize`, queues everything the agent says while nobody is attached, and re-sends an agent request nobody answered. Opening a session is SINGLE-FLIGHT per session id (`openOnce`): the waker and an operator's send reaching a session with no live agent in one instant used to fork two daemons on one socket path and fail both sends (`scripts/verify-daemon-socket-takeover.mjs`, which also covers the Codex daemon). Like the broker, the ACP and Codex daemons judge their socket by inode (`backend/socket-ownership.ts`): a dying one removes the socket file only while the path still leads to it, and an unattached one whose socket file is gone self-collects (`self-collected-socket-lost`). Only a session whose daemon actually died is re-opened on the next follow-up with `session/load` when the agent advertised `loadSession`, else a fresh session with an `acp-note` saying the earlier conversation is gone. Mark as done, dismiss and replace end the daemon (`releaseSession`). The child's environment goes through `inheritWorkerEnvironment`, never raw `process.env`.
- **The transcript is ntwine-written.** ACP has no on-disk session format ntwine could tail, so the bridge writes `<stateDir>/acp/<ntwine session id>.jsonl` — an `acp-session` header (agent, ACP session id, cwd, model) then NormalizedEvents as the tailer already folds them (`backend/acp-transcript.ts`). The stem is ALWAYS the ntwine `session_id`; `agent_session_id` holds the agent's own session id for `session/load` only, and every reader that switches on backend (tailer prime, `sourceForThread`, `projectSnapshot`, the cursor, `readThreadTranscript`) has an acp arm keyed that way — the first live dispatch spun `running` forever because the tailer built the stem from `agent_session_id`. ACP rows skip the Claude discovery sweep and the perm-marker read exactly as Codex rows do.
- **Permissions are cards with canonical ids.** `session/request_permission` becomes a `command-approval` (bash-like) or `file-approval` (edit-like, with the agent's diff preview) interaction whose decisions are `accept` / `acceptForSession` / `decline`; the agent's own `optionId`s stay beside the pending entry and the chosen one goes back on the wire. A turn ending or the session being released cancels its open cards. Whether an agent asks at all is the agent's configuration (opencode: `permission.edit`/`permission.bash` in `opencode.json`; its default in ACP mode allows edits silently).
- **Follow-ups queue; there is no steer.** A follow-up during a turn is held by the bridge and sent as the next `session/prompt` when the turn ends (the delivery ledger draws it as the gray queued bubble meanwhile); `killAgent` is `session/cancel`, after which the queue drains. A cancelled turn records `turn-end` with `successful: false` plus an `acp-note`, and a zero-token `usage_update` (opencode sends one on cancel) is dropped rather than emptying the context dial.
- **Deliberately not integrated:** quota/usage chips, sub-agent and background-shell telemetry, per-thread effort and permission changes (the RPCs refuse an ACP thread; the model is the one profile axis it has), the `fs/*` and `terminal/*` client methods, and hibernation. Each is a separate effort on top of the seam, not a gap in it. (The detached host that lets a turn outlive the server was one of these until 2026-09-24; it exists now, above.)
- **Verifying it needs a real agent:** `scripts/adhoc-stack.mjs --creds` links `~/.local/share/opencode` into the sandbox HOME for opencode's own credentials; `backend/_live_acp_opencode.mts` is the manual wire probe; the fake agent under `backend/acp.fixtures/` drives the protocol, bridge and transcript tests without a vendor CLI.
