# Moving a thread to another machine

Design plan, 2026-11-12. Status: **BUILT** (2026-11-12; ARCHITECTURE.md § Moving a thread to another machine). The maintainer runs ntwine on a Mac (`/Users/ssalb`) and on a
Windows desktop in WSL (`/home/ssalb`, mDNS `ssalb-xps.local`), with the same projects cloned on both. He wants
to pick a resting thread up on the other machine. The design he approved is an explicit **move**, not a sync:
exactly one machine owns a thread at a time, so there is nothing to reconcile, and `ui.db` (SQLite in WAL mode)
is never copied as a file.

```mermaid
sequenceDiagram
  participant A as Origin (owns the thread)
  participant B as Destination (paired peer)
  A->>A: refuse unless resting; stop its daemon; hold sends
  A->>B: prepare {project identities, slug, session}
  B-->>A: ok {destination project, paths} | refused
  A->>A: snapshot rows, transcript, scratch, git bundle of the WIP
  A->>B: import {manifest + bundle} (encrypted, authenticated)
  B->>B: verify everything, then place files, rewrite paths, restore checkout, insert rows
  B-->>A: ok {slug}
  A->>A: mark moved (read-only stub), drop its waits, revert the moved WIP paths
```

## 1. What a thread is (read off the code, 2026-11-12)

Full survey with file:line citations: `.ntwine/threads/5acde319-6e07-45d7-b970-b4016e6ed8f6/survey-thread-files.md`
(scratch, not kept). The load-bearing facts:

- **The resume cwd is not stored anywhere.** A cold resume runs in `workDirOf(project)`, recomputed on every
  machine (`context.ts`), and passes only `{ resume: sessionId }` to the SDK (`claude-agent-sdk.ts`). The worker
  prompt, scratch path, `NTWINE.md`, deadline and MCP config are rebuilt at every resume. So moving a Claude
  thread is: put its transcript where Claude looks, and give the destination its rows.
- **The project id is machine-local** (`git config ntwine.id`, `.ntwine/.id`; `.ntwine/` ignores itself). A clone
  gets a new id, so every moved row is re-keyed to the destination's project id. Projects are matched by
  **git remote identity**: each remote URL normalized to `host/owner/repo` (or `file:<realpath>` for a local
  remote), and two projects match when they share one.

| Piece | Where | Moves? |
| --- | --- | --- |
| Claude transcript | `~/.claude/projects/<cwdSlug(workDir)>/<session_id>.jsonl` (and `<transcript_id>.jsonl` when it drifted) | yes: needed to resume |
| Claude session dir | `…/<session_id>/subagents/`, `…/tool-results/`, `…/workflows/` | yes: sub-agent history and `SendMessage`, and tool outputs the transcript cites by absolute path |
| Claude session dir, live-only | `…/<session_id>/ntwine-inbox/`, `ntwine-deadlines/` | no |
| Worker scratch | `<project>/.ntwine/threads/<session_id>/` | yes |
| Attachments the transcript cites | `<state dir>/attachments/<file>` (per project, cited by absolute path) | yes, only the files the transcript names |
| Codex rollout | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl` | not in this build: refused with a reason (Codex is not installed here, so its resume cannot be verified) |
| ACP transcript | `<state dir>/acp/<session_id>.jsonl` | not in this build: refused |
| Runtime-only state | broker records, perm markers, secret FIFOs, temp prompts and MCP configs (which hold credentials), background-shell output, `file-history`, `session-env` | never |

Rows in `ui.db` (all keyed by `project_id` + slug):

| Table | Moves? |
| --- | --- |
| `session` | yes, re-keyed; `schedule_id` cleared (the schedule stays home) |
| `thread_question`, `thread_done`, `thread_link`, `thread_reaction`, `subagent_steer`, `retired_op`, `thread_spinoff` | yes, as history the drawer renders |
| `thread_timer`, `pr_watch`, `command_watch` | yes; the origin settles its armed copies, so each wait fires on one machine |
| `thread_watch` (shell and agent waits) | no: they name live runtime ids, and a resting thread has none armed |
| `wake_delivery` | no: a pending or leased one refuses the move ("a message is on its way to the worker") |
| `interaction_journal` | no: a pending one refuses the move, through the resting check |
| `tail_state` | no: a cache that rebuilds itself (and stores an absolute path) |
| `shell_budget`, `thread_terminal`, `thread_schedule*`, `tombstone`, `settings` | no |

**Resting** is the hibernation predicate without its two memory gates — no turn, sub-agent, background shell,
approval, ask or undelivered input — the same gate `claudeModelUpgradeBlock` uses. A to-do (held thread) has
nothing to move but a row and is refused in this build ("Start it first").

## 2. Path rewriting (done by the destination, which knows its own paths)

Inputs from the manifest: origin home `Ho`, checkout `Po`, state dir `So`, Claude bucket `Bo`; the destination
supplies `Hd`, `Pd`, `Sd`, `Bd = cwdSlug(Pd)`.

1. **Placement.** Transcript and session dir under `Hd/.claude/projects/Bd/`; scratch under `Pd/.ntwine/threads/`;
   attachments under `Sd/attachments/`.
2. **Structural fields.** Every JSONL record's top-level `cwd` (main and sub-agent transcripts), `thread_link`
   targets of kind `file`: longest prefix first, `Po → Pd`, then `Ho → Hd`. The board reads the newest `cwd` for
   the thread's working folder, and Claude records it per message.
3. **References to moved files**, in any string of the transcript: `Ho/.claude/projects/Bo/<sid>/ → Hd/.claude/projects/Bd/<sid>/`
   and `So/attachments/ → Sd/attachments/`. These prefixes can only name the files that moved with the thread.
4. **Conversation text is NOT rewritten wholesale**, which is a deliberate departure from "rewrite the home dir
   and checkout path" everywhere. Two reasons: Claude verifies the signature on each `thinking` block it is handed
   back, so text inside one cannot change; and a blanket `/Users/ssalb → /home/ssalb` corrupts meaning — this
   thread's own prompt names both homes in one sentence. Strings inside `thinking` and `redacted_thinking`
   blocks are never touched, by any rule. Instead the first message the thread receives after the move carries a
   note from ntwine naming the machine it came from, the two path mappings, and that nothing it had running
   came along.

## 3. Work in progress

The thread's checkout is the newest `cwd` in its transcript, lifted to its git top level, when that is a
linked worktree under `<main>/.ntwine/worktrees/<name>`; otherwise the checkout holding the newest file the
thread edited (`threadCheckout`). A worker often runs `git worktree add` and then writes by absolute path
without ever `cd`-ing in, so its cwd stays at the root: the first real-worker run did exactly that, and the cwd
alone would have moved nothing. A checkout anywhere else refuses the move by name. The thread's own
uncommitted edits in any other checkout stay, and the preview and the result name them.

- **What counts as the thread's WIP.** In a worktree: every uncommitted path (tracked and untracked, not
  ignored). In the main checkout, which other agents share: only the uncommitted paths this thread edited
  (`editedFilesOf` over its transcript, shell writes included); the rest stay, and the move result names them.
- **The snapshot** is a commit `W` whose parent is `HEAD` (`H`), built from a private index seeded with
  `git read-tree H` (never an empty index) so nothing in the checkout or its index moves. Branch `B` is recorded.
- **It travels as a `git bundle` inside the encrypted envelope, not as a pushed branch.** This departs from the
  approved "push a WIP branch to the remote". The bundle carries the same commits, but nothing leaves the two
  machines: no uncommitted work on a public repo's remote (ntwine is open source), no push credentials needed,
  and no stray branches for anyone to clean up. The bundle excludes what the origin's remote-tracking refs
  already hold; the destination fetches its own remote first when a prerequisite is missing.
- **On the destination, nothing from the other machine is trusted further than it must be** (added after the
  security review): no git hook runs; nothing under `.ntwine/`, and no symlink or submodule, moves as work; an
  existing branch is never moved; the main checkout fast-forwards only to commits its own remotes hold; nothing
  is written through a symlinked folder; and every row must be the moved thread's own. Timers, command watches,
  a recurring prompt, a time limit and the thread's permission mode are not re-armed on arrival.
- **On the destination, nothing is overwritten.** It fetches `W` into `refs/ntwine/moved/<slug>`, then, in the
  matching checkout (the same relative worktree path, created on `B` at `H` if absent; else the main checkout):
  the checkout must be on `B`; its `HEAD` must equal `H`, fast-forward to it (`git merge --ff-only`), or
  already contain it with the WIP paths unchanged since; every WIP path must be clean there. Then the `H → W`
  diff is applied as uncommitted changes. Any failure refuses the whole import before a file is written.
- **On the origin, after the destination confirms,** the moved paths go back to `H` (only where they still hold
  exactly what `W` captured), so an agent committing "whatever is in the tree" cannot land the same work twice.
  `W` stays at `refs/ntwine/moved/<slug>` on both machines. No branch or worktree is deleted.

## 4. Pairing, authentication and encryption

Nothing in the codebase authenticates one server to another (`survey-auth.md`): the board binds loopback, the
only way in from another machine is the declared public origin, and every request through it meets the browser
session gate. Nothing here does encryption beyond Ed25519 signatures. So this builds a small, separate channel
on node:crypto, with no new dependency:

- **Keys.** Each machine gets an X25519 key, `<data>/peer.key`, 0600, made on first use and never silently
  replaced (an unreadable key is an error, as `src/identity.ts` treats the claim key). Its fingerprint is the
  machine's id. Paired machines live in `<data>/peers.json`, 0600: name, address, public key, paired-at,
  last-seen.
- **Pairing, once per pair, presence on both machines.** Machine R shows a single-use code (60 bits as
  `XXXX-XXXX-XXXX`, 10 minutes, five wrong tries burn it) and its addresses. On machine I, the human enters R's
  address and the code. I sends its public key, name and addresses, MACed with a key derived from the code; R
  checks it against its live codes, consumes the code, and answers with its own key, MACed over both. Each side
  stores the other. Minting and entering a code are refused through the public origin, as minting a sign-in
  code is: pairing a machine needs a person at both keyboards.
- **Every later request is a one-message Noise-K-shaped envelope.** The sender's static key and a fresh
  ephemeral key head the body; the key is HKDF-SHA256 over `X25519(e, s_R) ‖ X25519(s_I, s_R)`, salted with
  both static keys and the ephemeral key; the payload is AES-256-GCM with that header as associated data. Only
  a paired machine can produce a request the receiver opens, and only the receiver can produce the response
  (sealed under a sibling key). A timestamp window and a cache of seen request ids refuse replays. An unknown
  sender key is refused before anything else. This gives no forward secrecy against theft of the receiver's
  key; the threat that buys is someone holding a recorded transfer AND that machine's `peer.key`, who could
  read the transcripts straight off the same disk.
- **Transport.** Requests go to `/_ntwine/peer/v1/*` at the peer's address. Two ways to reach a peer: its public
  origin (Tailscale serve, a tunnel, or its ntwine.app name — the relay then carries ciphertext it cannot open),
  or an opt-in **network listener** (Settings, off by default) that serves only those routes on a port of its
  own, for a LAN or tailnet address such as `http://ssalb-xps.local:9394`. The launcher's proxy lets
  `/_ntwine/peer/v1/*` past the browser session gate; those routes authenticate themselves. Over WSL's default
  NAT networking a LAN address needs Windows to forward the port (mirrored networking or a `netsh` portproxy);
  Tailscale serve on the Windows side needs nothing.
- **Audit.** Every pairing, unpairing, move out and move in is a line in `audit.jsonl`
  (`peerPair`, `peerUnpair`, `threadMoveOut`, `threadMoveIn`) with the peer's name and fingerprint, outcome,
  sizes and the refusal reason; never transcript text.

## 5. The move, and its failure modes

1. The origin refuses unless the thread is resting, a Claude thread, not held, not already moved. It marks the
   thread **moving** in memory, which refuses follow-ups, answers and wakes, then retires the idle daemon.
2. `prepare` asks the destination whether it has the project and whether the slug is free (a moved-away stub
   of the same session counts as free: that is a thread coming home).
3. The origin snapshots the rows, files and git bundle, gzips them, and sends `import` with a fresh move id.
4. The destination verifies everything first — sizes, paths inside their roots, the git placement — and only
   then writes, inserting the rows in one transaction. A repeated `import` with the same move id answers ok
   without writing again, so a lost response can be retried safely.
5. On ok, the origin stamps `moved_to` on the row, archives it, settles its armed timers and watches, and reverts
   the moved WIP paths. On any failure before that, the origin's thread is untouched and stays its own.

The one window with two copies is a response lost after the destination committed: the origin then reports the
move as unconfirmed and offers the retry, which is idempotent.

**The moved-away stub** stays readable on the origin (its transcript is kept), reads "Moved to <machine>" in its
drawer, and refuses everything that would run it: a follow-up, an answer, reopening it.

## 6. Where the human starts it

- **Settings → Other machines:** this machine's name and fingerprint, the paired machines (name, address, last
  seen, Unpair), **Pair a machine** (shows a code and this machine's addresses) and **Enter a code**, and the
  network listener switch.
- **A thread's ⋯ menu → Move to <machine>** for each paired machine, opening a confirm dialog that runs the
  destination's `prepare` and shows what will move: the checkout and branch, the uncommitted files, what stays
  behind, and the destination's folder. It disables with the reason while the thread is running.

## 7. Verification

- Unit: the envelope (round trip, a flipped byte, a wrong key, a replay, an unknown sender), pairing (the wrong
  code, a spent code, the attempt limit), path rewriting (structural fields, moved-file prefixes, thinking blocks
  untouched), the git snapshot and restore (worktree, main checkout with another agent's dirty file, fast-forward,
  diverged refusal, round trip back), the row export and import against a real database.
- End to end: two disposable stacks with their own HOMEs and their own clones of one bare remote, paired over
  loopback; a real Claude worker given a fact and a file edit, moved while resting, then asked on the other
  stack for the fact and to finish the edit; then moved back.
