# t3code adoption spike

Briefing for an implementation spike that pulls the worthwhile architecture out of
[pingdotgg/t3code](https://github.com/pingdotgg/t3code) into ntwine, without regressing ntwine's DX.

## Provenance

The investigation behind this document ran as a **non-ntwine** Claude Code session
(`3d465878-f791-4383-8d45-de5732e61e3a`, cwd = this repo, 2026-07-25 17:39–17:51 local). It wrote no
file — its entire output was two chat messages, extracted here so it survives.

Prompts it ran under: *"investigate t3code deeply and see if there's any architectural improvements
we should steal"*, then *"mostly wondering about tmux broker stuff, but consider all agent harness
stuff."*

**Working clone:** `/tmp/t3code-study/t3code` — `pingdotgg/t3code`, full history (2,119 commits),
HEAD `5719e8ac` (2026-07-24). Re-clone if `/tmp` has been swept. All t3code paths below are relative
to that clone; all ntwine paths are relative to this repo root.

**Verification status.** Every load-bearing claim below was re-checked against source before this
document was written. Confirmed: t3code has zero `tmux` in `apps/` + `packages/`; `handleAskUserQuestion`
at `apps/server/src/provider/Layers/ClaudeAdapter.ts:3200` with `method: "canUseTool/AskUserQuestion"`;
the `CLAUDE_CONFIG_DIR`-not-`HOME` keychain rationale at `apps/server/src/provider/Drivers/ClaudeHome.ts:27`;
`EventNdjsonStream = "native" | "canonical" | "orchestration"` at
`apps/server/src/provider/Layers/EventNdjsonLogger.ts:31`. On the ntwine side: `persistSession: true` at
`packages/server/src/backend/claude-agent-broker.ts:92`, `tailer.ts` is 2,737 lines, `NormalizedEvent`
carries 10 kinds with the "Claude's OWN fold does NOT route through this union" note, and the broker
bridge is default-ON.

One refinement to the original report: `onEvent` **is** plumbed through the bridge
(`claude-agent-broker-bridge.ts:147` forwards to `deps.onEvent`). What is missing is a *handler* —
`context.ts` never supplies one, so the structured event stream is dropped on the floor and the tailer
re-derives the same state from disk. The conclusion stands; the mechanism is one step further in.

## The headline question: keep the broker

**Answer: ntwine's broker daemon is better than t3code's model on the axis that matters, and it should
be kept.**

t3code has **no detached agent process**. The only `detached: true` in its entire provider tree is
opencode's server child (`apps/server/src/provider/opencodeRuntime.ts:460`). Agent children die with
the server. Durability comes instead from two other places:

1. A persisted `resumeCursor` on the session binding — for Claude,
   `{threadId, resume: sessionId, resumeSessionAt: lastAssistantUuid, turnCount}`
   (`apps/server/src/provider/Layers/ClaudeAdapter.ts:1453`). Note it resumes at a specific *message
   uuid*, not just a session.
2. The event log — on restart the projector settles any still-running turn from session status
   (`stopped`/`interrupted` → `interrupted`, `error` → `error`) and the client replays by sequence
   (`apps/web/src/orchestrationRecovery.ts` handles `sequence-gap` → replay-or-snapshot).

Plus a `ProviderSessionReaper` that stops sessions idle >30min on a 5min sweep.

**The tradeoff t3code accepts: it loses the in-flight turn on server restart.** You resume the
conversation; you do not resume the work that was mid-flight. That is fine for t3code, whose threads
are foreground and interactive. It is *not* fine for ntwine, whose threads are unattended multi-hour
dispatches and where a ntwine restart during a dev cycle is routine.

Ntwine's broker already solves this, and its own header says so
(`packages/server/src/backend/claude-agent-broker.ts`): *"the session OUTLIVES ntwine, so ntwine
reconnects to the LIVE session after a restart instead of cold resume-from-disk, while keeping
structured TYPED control (no TUI scraping, no tmux, no PTY — stream-json is pipes)."* It is a detached
daemon with adopt-on-restart, keyed per session id, with owner-checked cleanup and idle exit.

So the broker is the *convergence* of both designs: it gets t3code's typed-control win **and** keeps
survival, which t3code gave up. Closing ntwine without terminating sessions is not too difficult — it is
already built and default-on. **tmux is the thing to drop, not the broker.** The stability problems
come from tmux and from running two parallel transports, not from the daemon concept.

## ⚠ The trap in item 1 — read before touching the tailer

> **CORRECTION (2026-07-26, implementation spike).** The premise of this section — "the daemon does
> not buffer" — is **empirically false for events**, and the line it cites is a different code path.
> The daemon's `emitEvent` has always had a 20,000-frame backlog that is replayed in full on the next
> connect (`claude-agent-broker.ts`: `else { eventBacklog.push(…) }`, replayed by
> `while (eventBacklog.length) sock.write(…)` in the connection handler).
>
> Proven by driving it, not by reading it — `backend/_live_broker_detached_backlog.mts`: attach,
> start a turn, disconnect while it is still running, let the whole turn finish with **nothing
> attached**, reconnect. The reconnecting client receives `other, assistant, result`, including the
> agent's complete reply (`"1\n2\n3\n4\n5\n\nDETACHED-OK"`) and `subtype=success`. Client A saw only
> `init` before it left. Restart-gap work is recovered over the socket, and independently off disk.
>
> `if (client) write(...)` with no backlog was real — for the **diagnostic** relay, one callback lower
> in the same file. That gap was genuine and is now fixed: the daemon writes its own lifecycle/stderr
> forensics to disk (`backend/claude-broker-diagnostics.ts`), because a relay only reaches a ntwine that
> is attached, which a ntwine crashing or restarting is not.
>
> The section's *conclusion* is still worth keeping for the reason below, and the spike honored it:
> item 1 as landed does **not** delete the tailer. The fold stays the authority and the event stream
> only schedules reads and resolves turn ambiguity, so no recovery path was removed. The warning
> applies to the "consume the socket stream INSTEAD of the file" reading of item 1 — which is a
> different, larger change, and remains unbuilt.

**The daemon does not buffer.** `claude-agent-broker.ts:81` is `if (client) write(client, {t:"event", event})`
— when ntwine is gone there is no client, and the event is dropped. There is no backlog, no replay
cursor, no "events since". The comment at `:132` states the intent plainly: *"ntwine gone; the session
stays alive."* The session stays alive; its **events do not reach anyone**.

What actually delivers restart survival today is `persistSession: true` (`:92`) writing the SDK
transcript to JSONL, plus the tailer re-reading that file when ntwine comes back. In other words: the
recovery mechanism is the same write-to-disk-and-re-read that t3code uses. The daemon's marginal value
over t3code is narrower than it first appears — it is *"the agent keeps making progress while ntwine is
down"*, and nothing else.

**So item 1 and the broker's survival property are in direct tension.** Deleting the tailer and
consuming only the live socket stream would remove the only path by which work done during a restart
gap is ever recovered. The result would be a daemon that survives restarts and whose work during them
is unrecoverable — silently destroying the exact property the detachment exists for.

Item 1 is therefore only safe if the daemon becomes genuinely authoritative first: a bounded on-disk
event backlog in the daemon plus a resume-from-sequence handshake, so a reconnecting ntwine replays what
it missed. Do that **before** removing any tailer responsibility, and verify it by killing ntwine
mid-turn, letting the agent work through the gap, and confirming the thread renders complete after
reconnect. If that ordering is not respected, item 1 is a regression wearing a refactor's clothes.

## Tier 1 — steal these

**1. Consume the event stream you already pay for.**
The broker receives structured SDK messages and discards them; `persistSession: true`
(`claude-agent-broker.ts:92`) makes the SDK write JSONL to disk, and the 2,737-line `tailer.ts` polls
that file back to re-derive state the SDK already handed over in memory. t3code's path is adapter →
`streamEvents` → `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` → domain events →
read model. No file tailing, no poll interval, no defensive re-parse, no pane-sniffing.

Retires: byte-cursor bookkeeping, "parse defensively, degrade to unknown", the 4s-quiet pane-capture
heuristic for permission prompts, and the poll-tick latency floor.

**2. A canonical event vocabulary every backend must produce.**
`packages/contracts/src/providerRuntime.ts` — 47 event types plus `CanonicalItemType` (14 item kinds)
and `CanonicalRequestType` (9 approval kinds): turn lifecycle, item lifecycle, content deltas,
approvals, structured user-input requests, sub-tasks, hooks, token usage, rate limits, MCP status,
model reroutes. Ntwine's `NormalizedEvent` (`packages/server/src/backend/types.ts:42`) has 10 kinds
and its own comment admits Claude bypasses it — so it is a lowest-common-denominator view only Codex
drives, and a third agent means a third private fold.

**3. The adapter contract as a control plane, not a parser.**
`apps/server/src/provider/Services/ProviderAdapter.ts`: `startSession` / `sendTurn` / `interruptTurn` /
`respondToRequest` / `respondToUserInput` / `stopSession` / `readThread` / `rollbackThread` /
`streamEvents` / `capabilities`. Ntwine's `AgentBackend` is `buildSpawn(argv)` / `transcriptPath` /
`foldLine` / `matchesPermPrompt(pane)` — an interface shaped around scraping a TUI. The broker already
implements most of the control-plane verbs; they just don't live in the interface.

**4. The in-process integration harness — biggest cost-per-change win.**
`apps/server/integration/`: `TestProviderAdapter.integration.ts` (577 lines) is a scripted fake
provider — queue a `TestTurnResponse` with canned canonical events plus an optional `mutateWorkspace`
hook. `OrchestrationEngineHarness.integration.ts` (560 lines) boots the entire server graph against a
real temp git repo. `orchestrationEngine.integration.test.ts` (1,441 lines) asserts the full chain —
send turn → events → projections → checkpoint captured → diff finalized → revert — deterministically,
no LLM, no browser. Ntwine's only gate for orchestration logic today is "launch a promoted artifact,
drive real Chrome, screenshot", which is right for UI and ruinously expensive for everything else.

**5. `DrainableWorker` + `RuntimeReceiptBus` — the primitives that make #4 deterministic.**
`packages/shared/src/DrainableWorker.ts` is ~70 lines: a queue worker with an atomic outstanding-count
so `drain()` resolves when the queue is empty *and* the in-flight item finished.
`apps/server/src/orchestration/Services/RuntimeReceiptBus.ts` publishes typed async milestones
(`checkpoint.baseline.captured`, `checkpoint.diff.finalized`, `turn.processing.quiesced`) that tests
await instead of polling or sleeping — explicitly documented as not part of the production event model.
Neither needs Effect; both are a few dozen lines of plain TS. Cheapest item on the list, and it
unblocks the most expensive one.

## Tier 2 — high value, real work

**6. Per-turn checkpoints as hidden git refs.**
`apps/server/src/vcs/GitVcsDriver.ts:651`: capture sets `GIT_INDEX_FILE` to a temp path, `read-tree HEAD`,
`add -A`, `write-tree`, `commit-tree` (parentless), `update-ref refs/t3/checkpoints/<base64url threadId>/turn/<n>`.
Restore is `git restore --source <oid> --worktree --staged` + `clean -fd` + `reset`. The user's index,
HEAD, stash and reflog are never touched. Buys per-turn diffs, "what did this turn change", and
revert-to-turn-N — ntwine has none of it.

Side benefit: the temp-`GIT_INDEX_FILE` trick is exactly the fix for ntwine's known shared-index commit
race, where a concurrent agent's `git add` sweeps their file into your commit.

**7. Provider *instances*, not provider kinds.**
`apps/server/src/provider/ProviderDriver.ts` — every provider is instantiated N times with its own
`instanceId`, typed config, env, and `continuationIdentity`; threads pin to an identity so they can only
resume on a compatible instance. The UX in `docs/providers/claude.md` is "Claude Work" / "Claude
Personal" / "Claude OpenRouter" as separate providers. Ntwine is single-account by construction, but
already tracks Claude quota per account.

**8. Generate the Codex protocol instead of hand-auditing it.**
`packages/effect-codex-app-server` is 42,860 generated lines + ~1,200 hand-written, from
`openai/codex` → `codex-rs/app-server-protocol/schema/json` at a pinned commit. That path exists on
`main` upstream and publishes both `schema/json/` and `schema/typescript/`. Ntwine hand-wrote 3,490 lines
in `packages/server/src/backend/codex-app-server.ts`, audited against Rust at tag `rust-v0.144.1`,
behind a gate accepting exactly 0.144.1 — so every Codex bump is a fresh manual audit.

## Tier 3 — cheap, worth noting

- **Traces as the persisted source of truth.** `docs/operations/observability.md`: stdout logs are
  human-only and never persisted; completed spans go to NDJSON with `traceId`/`durationMs`/
  `attributes`/`exit`. A log line only persists if emitted inside a span.
- **Repo-local lint plugin for house invariants.** `oxlint-plugin-t3code` — e.g.
  `no-global-process-runtime` bans `process.platform`/`process.arch` outside one file. Ntwine encodes its
  invariants as prose in CLAUDE.md and keeps getting bitten by env/path resolution in promoted
  artifacts (the absolute-`executablePath` broker bug). A lint rule enforces what a doc only asks for.
- **In-app preview + project scripts.** `apps/server/src/preview/Manager.ts` — tabbed browser preview
  sessions per thread, port scanning, `ProjectScript` entries for dev/test commands. Relevant to ntwine's
  web-UI completion rule, which currently makes every agent hand-roll a Chrome stack.

## The agent-harness finds

1. **`AskUserQuestion` intercepted at `canUseTool` → a structured question channel.**
   `ClaudeAdapter.ts:3200`/`:3343`. The tool call is caught, emitted as `user-input.requested` with typed
   `UserInputQuestion[]` (options, labels), blocked on a Deferred, answered by returning
   `{behavior:"allow", updatedInput:{questions, answers}}`. Abort-aware: interrupting the turn resolves
   it empty and denies. This is the direct replacement for ntwine's ` ```question ` fence convention,
   which exists only because the tmux era had no channel. Ntwine's `ARCHITECTURE.md` records two prior
   designs (blocking MCP tool; `ntwine-ask` CLI + sidecars) built and rejected as fragile — `canUseTool`
   interception is a third option with none of those failure modes: no timeout, no sidecar state, no
   markdown parsing, and structurally impossible for the agent to "forget the format."
2. **`ExitPlanMode` intercepted, denied, and captured.** Same file, `:3347`. The plan markdown is
   extracted into a first-class proposed-plan object, then the tool is *denied* with "The client
   captured your proposed plan. Stop here and wait for the user's feedback or implementation request in
   a later turn." Maps onto ntwine's Plans section.
3. **`CLAUDE_CONFIG_DIR`, never `HOME`.** `Drivers/ClaudeHome.ts:27` — overriding `HOME` relocates the
   macOS login keychain lookup (`$HOME/Library/Keychains`), so the spawned CLI cannot find its OAuth
   credentials and reports "Not logged in."
4. **Codex shadow-home auth overlay.** `Drivers/CodexHomeLayout.ts` — rather than a fully separate
   `CODEX_HOME` per account, build a shadow home that symlinks the shared dirs (`sessions`,
   `archived_sessions`, `sqlite`, `shell_snapshots`, `worktrees`, `skills`, `plugins`, `cache`, `logs`)
   back to the shared home, keeping only `auth.json` and `models_cache.json` private, with typed errors
   for every conflict case. Multiple accounts, one corpus.
5. **`settingSources: ["user","project","local"]`.** They deliberately load the user's own CLAUDE.md and
   settings rather than running a hermetic agent. Ntwine should make this an explicit posture either way.
6. **Skills discovered by filesystem scan, not the handshake.** `Drivers/ClaudeSkills.ts`: "The Agent SDK
   init handshake surfaces skills only as slash commands without their filesystem paths," so they scan
   `<config dir>/skills` and `<cwd>/.claude/skills` for `SKILL.md` frontmatter directly.
7. **Three NDJSON event streams per thread.** `Layers/EventNdjsonLogger.ts:31` writes rotating per-thread
   logs on `native` | `canonical` | `orchestration`. When a thread renders wrong you diff the three and
   know instantly whether the provider, the adapter's normalization, or the projector broke it.
8. **Sub-agents and hooks as first-class canonical events.** `task_started` / `task_progress` /
   `task_completed` and `hook_started` / `hook_completed` come straight off the SDK's `system` messages
   (`ClaudeAdapter.ts:2642-2727`). Ntwine reconstructs sub-agents with two bespoke trackers for what the
   runtime already reports.
9. **Runtime mode as a two-value switch mapped per provider.** `docs/architecture/runtime-modes.md`:
   full-access = `approvalPolicy: never` + `sandboxMode: danger-full-access`; supervised = `on-request`
   + `workspace-write`. One user-facing concept, N provider mappings — versus ntwine's `PermissionMode`
   threaded through argv per backend.
10. **Per-provider maintenance.** `makePackageManagedProviderMaintenanceResolver` handles npm / homebrew
    / native `claude update`, with version advisories in the provider snapshot.

## What NOT to steal

- **Effect-TS.** The layer/service/typed-error discipline is good, but adopting it is a rewrite of 73k
  lines of server, and every pattern above works fine in plain TS.
- **Full event sourcing with SQL projections.** Ntwine's `.ntwine/` markdown-as-source-of-truth is
  deliberate — the files are user-editable and `ntwine-update` is a real CLI surface. Take the *shape*
  (validated commands → events → projections) only where ntwine already owns a DB: `ui.db`.
- **Relay / Tailscale / SSH / mobile / cloud auth.** That is a product decision about whether ntwine stops
  being localhost-and-one-repo, not an architectural improvement.
- **The weight.** 523k LOC across 5 apps with a team, vs ntwine's 117k. Copy mechanisms, not scale.
- **Deleting the broker.** See the headline section. t3code's lack of one is a limitation it accepts,
  not a design ntwine should adopt.

## Suggested order

`5 → 4 → 1 → 2 → 3`. Receipts and drain are a day and make everything after them testable; the harness
is what makes the adapter refactor safe to attempt; consuming the event stream is the change that
actually deletes code — the tailer, the pane-sniffing, the poll latency — rather than adding it.
