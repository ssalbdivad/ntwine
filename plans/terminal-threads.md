# Terminal threads: a terminal is a thread anyone can start

Written 2026-10-15. Status: **proposed, not built.** Asked for by ssalbdivad: *"you open ntwine as your one stop shop
for coding, you can easily start a dev server immediately from home or run what commands you need without leaving the
window … as a first class citizen can be created by user or agent all should work same way and have same
introspectability, follow semantics around when things are working or ready."*

## Where this stands

- **2026-09-23, first shape:** top-level *terminal command threads* (`471b6d78`). A Terminal tab on the prompt box
  ran a command as a `kind: "command"` row. It started in a Terminals band of its own, then shared the
  queue/running/done lifecycle (`2ff3b1d1`): **every finished run queued with a card.**
- **2026-09-29, second shape (today's):** reversed by `07e56004`. A terminal hangs off a thread: it is opened from the
  drawer, by `t`, or by `$ cmd` in that thread's prompt box. It starts where the agent works (`thread-cwd.ts`), has
  no row, and queues its parent only while it waits at a prompt. Marking the thread done stops it. The reasons, from
  the header of `packages/server/src/thread-terminals.ts`, were upstream's: a second top-level kind of thread, a
  standalone terminal ignoring the agent's worktree, one more row in a dense sidebar, and a pty on the boot path. The
  last one is answered: node-pty loads lazily.
- **Later:** human terminals and the agent's background shells share one strip with an owner glyph
  (`63e7c749`, `lib/threadProcesses.ts`).
- **2026-10-13:** the fork detached from colinhacks/frizz. Colin's positions are now design input, not constraints.

**What still hurts:**
- Starting a dev server needs an agent thread first.
- An ntwine restart or update hangs up every terminal, because the pty is a child of the control plane.
- An agent's dev server is a `run_in_background` shell inside its turn, which has two costs. It dies with the
  worker. It also makes `thread-hibernation.ts` refuse (`blockedBy: "background-shells"`), so the thread holds its
  ~345–504 MB for as long as the server lives.

## The model

**One new top-level kind, `terminal`.** It is a thread like any other: a slug, a `@handle`, a project, a row in
exactly one of the six bands, a drawer and a card. Its body is a live pty screen instead of a transcript. It has no
model, no profile and no worker contract.

The thread-owned shape **goes away**. "Open terminal" on a thread, `t`, and a `$ cmd` line in a thread's prompt box
all create a terminal thread with `parent` set to that thread and `cwd` set to that thread's working folder
(`thread-cwd.ts` unchanged). A `$ cmd` line typed into the prompt box on All projects or Home creates one with no
parent, in the folder the prompt box's picker names. One kind, so one set of rules. (The alternative, keeping parented
terminals and adding top-level ones beside them, keeps two lifecycles with nothing gained.)

**Fields** (the `thread_terminal` table grows; it is not replaced):
- `command` (absent = an interactive login shell), `cwd`, `shell`: already there.
- `parent_slug` becomes OPTIONAL: it means "started from this thread", not "lives inside it".
- `started_by`: `human` | the starting thread's slug. This is the owner glyph's source, already drawn by the strip.
- `state`: `open` | `archived`, as for agent threads.
- run history: the `terminalRun` follow-up runs stay as they are.

The handle comes from the command: `$ nub run dev` → `@nub-run-dev`, with a suffix on a clash. A bare shell is
`@shell`.

## Lifecycle: the existing bands, no new ones

| The process | Band | Why |
| --- | --- | --- |
| running | **Working** | it is spinning, so this is the maintainer's "Active" exactly |
| waiting at a prompt (`awaitingInput`, today's 3s rule) | **Ready** | a question only the human can answer; the card draws the live screen to type into (today's behaviour, now on the terminal's own card) |
| exited non-zero by itself | **Ready**, shown as failed | like a worker that crashed: answerable with Restart or a `$` follow-up |
| exited 0, or ended by Stop, by Ctrl-C (130), or by `exit` in a bare shell | **Done** | the run finished or the human ended it. Queuing it would break *"Nothing enters the queue just to be dismissed"*, which is what the 2026-09-23 shape did |
| interrupted by an ntwine restart (until the host below exists) | **Ready**, shown as interrupted | it did not finish by itself, and Restart is the answer |

- The human can snooze, pin, and Mark as done like any thread. Mark as done on a running terminal stops it (SIGTERM to
  the process group, SIGKILL after 5s, as today) before Done is recorded.
- A Done terminal reopens by a `$` follow-up or Restart, as an agent thread reopens by a reply.
- **Marking a parent thread done no longer stops its terminals.** A dev server is meant to outlive the effort that
  started it. The "End this session?" dialog lists the live terminals the thread started, each with a stop checkbox,
  unticked by default. (Alternative: keep stopping them, which is today's rule. That defeats "start the dev server
  and keep it".)

**Density.** A long-lived dev server sits in Working permanently. That is honest, and Working never folds;
`lib/sidebarBudget.ts` already shortens a band to its first rows and a count. A terminal row is one line: the terminal
mark, the command in mono, the folder hint only off the project root, and its age. A parented terminal also shows in
its parent's strip, as now, as a link to its row rather than as the only place it lives.

## Agents start, read and stop them the same way

New `ntwinectl terminal` subcommands, for every provider (the CLI is provider-neutral):

- `ntwinectl terminal start "<cmd>" [--cwd <dir>]` creates a terminal thread with `parent` and `started_by` set to the
  caller, and prints its `@handle`. `--cwd` defaults to the caller's working folder.
- `ntwinectl terminal read @handle [--tail N]` returns the screen tail, ANSI-stripped. `ntwinectl read-thread @handle`
  gives the same for any terminal, including the human's, so "why did my dev server die?" is answerable.
- `ntwinectl terminal send @handle --text-file -` types into a terminal **this thread started**. A human's terminal
  is read-only to agents. (Security posture: an agent typing into the human's shell is the one asymmetry. Reverse it
  only with ssalbdivad's explicit say-so.)
- `ntwinectl terminal stop @handle` and `restart @handle`, again only on terminals this thread started.
- `ntwinectl watch terminal @handle --for <d>` wakes the starter on exit or on a prompt, like a shell watch. Rest on
  it with `terminals: [@handle]` in the awaiting fence: a new hint kind beside `shells:` in the shared fence parser.

The base worker contract (`workerPrompt.ts`, § Waiting in Claude Code) changes one rule: **a process you work
alongside (a dev server, a log tail) is started with `ntwinectl terminal start`, not `run_in_background`.** A slow
gate (a test suite, a build) stays `run_in_background`, because it belongs to the turn and its exit should wake the
turn. That also unblocks hibernation for every thread that runs a dev server. It is a rule a worker measurably gets
wrong without being told, so it earns its tokens.

## Terminals survive a restart: a detached terminal host

This is the largest piece, and it is what makes "one-stop shop" true. It follows the pattern three transports already
use: `acp-daemon.ts`, `codex-app-server-daemon.ts` and the Claude session broker.

- **`terminal-host.ts`**: one daemon per terminal, forked `detached: true` into its own process group. It owns the
  pty (node-pty, loaded there, still never at server boot) and serves a local socket, framed with the existing
  `DAEMON_CONTROL_KEY` control lines.
- **It holds the 1 MiB replay ring** (`REPLAY_CAP_BYTES`, moved from `thread-terminals.ts`) and the prompt
  detector's state, so a reattaching server gets the screen and `awaitingInput` without loss. While nothing is
  attached it keeps reading the pty; output past the ring is trimmed from the front, as today.
- **It records the exit** (code and signal) in a file beside its socket before it exits, so a server that was down
  at that moment still files the run correctly. Boot's "no recorded exit ⇒ interrupted" becomes "no daemon and no
  exit file ⇒ interrupted".
- **Adoption**: boot enumerates live hosts through `daemon-identity.ts`, and `/term/<id>` (`terminal.ts`) attaches
  through them. The reaper (`orphan-reaper.ts`, `unowned-brokers.ts`) learns the host's identity, so a terminal whose
  row was forgotten is reaped and a live one never is.
- Stop semantics are unchanged: the host signals the pty's process group.

## Worktrees

The folder picker on a top-level `$` lists the project root and every `.ntwine/worktrees/*` checkout (the
`WorkCheckout` shape already exists). A parented terminal keeps following its agent's folder. This answers the
objection "terminal threads ignore worktrees" without ntwine choosing a worktree for anyone.

## Principles this touches, and needs ssalbdivad's yes on

1. **CLAUDE.md, The board: "One server serves every project. Nothing ntwine runs on its own uses a pty or tmux."**
   An agent-started terminal is a pty ntwine runs at an agent's request. Proposed wording: *"Nothing ntwine runs on
   its own uses a pty or tmux; the one pty is a terminal a human or an agent asked for, and it runs in its own
   detached host."* The matching CLAUDE.md section ("No agent runs in a pty … One exception is real") is rewritten the
   same way, and its "needs sign-off from upstream" line is dropped.
2. **"Prompt threads are the only top-level kind"** (maintainer 2026-09-29, recorded in `thread-terminals.ts` and
   `ARCHITECTURE.md` § Board nomenclature, "A thread's terminals have no band — and no row"). This plan reverses it.
3. **The worker contract's dev-server rule** (above): a contract change, held to its header's "earns its tokens" test.

These are upheld unchanged: six bands, Working never folds, every queue item answerable (the exit-0 → Done rule
exists for this one), the worker's last word decides its state (a terminal has no worker; its process's state is the
reading), and ntwine never parks or answers on a worker's behalf.

## Migration

- Open `thread_terminal` rows with a `parent_slug` become terminal threads with that parent and
  `started_by: "human"`. Live ones keep running: the first build after this one still holds them as server children.
  They become host-owned at their next Restart.
- Archived rows stay archived. The parentless 2026-09-23 command threads (8 archived rows on the maintainer's
  `ui.db` as of 2026-10-06) stay archived and now draw as Done terminal threads: a record, not a resurrection.
- `ThreadView.terminals` on a parent becomes a list of child terminal slugs. `withThreadTerminals`' parent-queuing
  rule is deleted, because a terminal at a prompt now queues itself.

## Scope

Surfaces, in build order. Each step ships on its own:

1. **Shared model and board.** Add `kind: "terminal"` and teach `sectionOf`, `partitionActive` and `inActiveBand` its
   bands (today `sectionOf` returns `null` for anything that is not `"session"`). Add a terminal row and card to
   `TierList`/`listBands`, an `@handle`, and `read-thread`. Server: `board.ts`, `storage.ts` (the additive columns),
   `thread-terminals.ts` (the lifecycle and exit classification). Web: row, card, drawer header. Risk: every
   `kind !== "session"` guard that once excluded command rows has to be revisited on purpose. Run `git log -S'kind:
   "command"'` to find the 2026-09-23 sites.
2. **Creating one from anywhere.** A top-level `$` in the prompt box on All projects, a project page and Home, plus the
   folder picker. `t` and Open terminal create parented terminal threads. Web composer plus one RPC.
3. **Agents.** `ntwinectl terminal` and `watch terminal`, the `terminals:` fence hint (shared fence parser plus its
   tests), the contract rule, and the done dialog's checkboxes.
4. **The detached host.** `terminal-host.ts`, adoption, reaper identity and the exit file, verified with a
   `real-subsystem-harness` script that restarts the server under a running `sleep` and an `npm run dev`-like
   listener, with a negative control.

Verification per step: `ntwine-stack` and `headless-browser` for the bands, cards and prompt-at-a-card flow; a real
Claude worker on a disposable stack for step 3, starting a dev server, reading it, and hibernating with it running;
step 4's harness; an optical pass on the new row.

What needs ssalbdivad: the three principle changes above, and the agent-writes-only-its-own-terminals posture. The
rest are reversible calls made here: the handle from the command, parents no longer stopping children, the exit
classification.
