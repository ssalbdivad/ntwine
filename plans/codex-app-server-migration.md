# Codex backend migration: tmux TUI → app-server JSON-RPC

Status: DRAFTING (architecture readers in flight). Owner effort: ntwine worker thread.
Branch: `codex-app-server-migration`.

## Why

Codex is the only ntwine backend still driven by scripting its interactive TUI inside tmux
(`backend/codex.ts`): ntwine types the user's follow-up into the Codex composer, presses Enter/Tab, then
*discovers* the rollout jsonl (Codex gives no session-id pin) and polls it for state. That mechanism is
fragile and produced the "unsteerable thread" failure: a stale draft in the Codex composer blocks the
input-queue drain, follow-ups pile up undelivered, and once the process exits nothing recovers. Claude,
by contrast, runs on the Agent SDK (stdio JSON), never touching tmux.

The fix is to drive Codex over its **app-server JSON-RPC protocol** — the same surface the official
VS Code extension uses — which has no terminal composer at all. Input becomes a JSON-RPC call; it
either succeeds or returns a typed error. This deletes the entire tmux-composer failure class.

## Verified premises (ground truth, this machine)

- **Protocol capability** — `codex app-server` v2 (installed codex **0.144.6**) exposes exactly what we
  need (confirmed via `codex app-server generate-json-schema`, dumped at `/tmp/codex-schema/`):
  - `turn/start`, **`turn/steer`** (mid-turn input inject; typed error `activeTurnNotSteerable`),
    **`turn/interrupt`** (graceful; turn ends `status: interrupted`).
  - `thread/start`, `thread/resume`, `thread/fork`, `thread/read`, `thread/list`, `thread/rollback`,
    `thread/injectItems`, archive/unarchive/delete.
  - Approvals: `ExecCommandApproval`, `ApplyPatchApproval`, `CommandExecutionRequestApproval`,
    `FileChangeRequestApproval`, `PermissionsRequestApproval`, `ToolRequestUserInput`.
  - Streaming deltas: `AgentMessageDelta`, `ReasoningTextDelta`, `CommandExecOutputDelta`,
    `ItemStarted`/`ItemCompleted`, `TurnStarted`/`TurnCompleted`, `ThreadStarted`.
  - Subscription auth surface: `ChatgptAuthTokensRefresh`, `GetAccount`, `GetAccountRateLimits`,
    `GetAccountTokenUsage`.
- **Billing preserved** — `~/.codex/auth.json` on this machine is `auth_mode: chatgpt`, `OPENAI_API_KEY`
  null, ChatGPT OAuth `tokens` present. The app-server spawned WITHOUT an injected API key rides the
  ChatGPT **subscription**, identical to the tmux path. (Same trick Claude already uses: SDK pointed at
  the subscription-authed CLI binary.) Undocumented-but-functional; pin the codex version + add a
  subscription-auth canary.
- **Foundation exists** — `backend/codex-app-server.ts` (~105KB, feature-flagged
  `NTWINE_CODEX_APP_SERVER_BRIDGE`, "deliberately not an AgentBackend") already speaks `thread/start`,
  `thread/resume`, `turn/start`, and the approval surface. Version-pinned to **0.144.1** (drift vs
  installed 0.144.6 → re-audit + re-pin per its own upgrade policy). Does NOT yet wire turn/steer or
  turn/interrupt, and its sessions are currently disposable (no durable resume across server restart).

## Architecture maps (filled from parallel readers R1–R4)

### R1 — AgentBackend contract the new backend must satisfy  ✅
**Central finding:** the `AgentBackend` interface (`types.ts:180-215`) models a **fire-and-forget tmux
spawn + poll-a-jsonl-file** lifecycle. BOTH current impls (`codex.ts`, `claude.ts`) are tmux-launched;
`claude-agent-sdk.ts` is a live-handle *foundation* but is NOT wired as an `AgentBackend`. **So the
app-server backend is the FIRST live-process (long-lived JSON-RPC child holding state) backend** — the
interface as written can't express it. It WILL need extension.

Interface members + fate under app-server:
- `buildSpawn`/`buildResume` → rework: launch `codex app-server` once, drive via JSON-RPC. The dozens of
  `-c` overrides become initialize/config params. Worker-contract prompt-prepend + discovery **sentinel
  become unnecessary** (app-server returns the thread id on `thread/start`).
- `transcriptPath` + `discoverSession` + ALL rollout discovery → **obsolete** (durable thread id from
  `thread/start`; no jsonl to locate, no post-spawn id race).
- `parseLine`/`foldLine` → **reuse the NormalizedEvent vocabulary + `applyEvent` verbatim**; only the
  input changes (v2 notification → NormalizedEvent instead of rollout line). Reuse `parseToolArguments`,
  `stringifyOutput`, the ntwine-title extraction, `codexSandbox`/`codexEffort` value maps.
- `matchesPermPrompt`/`detectNativeInput` (pane-scraping TUI modals) → **omit both**; replaced by a live
  **approval callback** answering ExecCommandApproval/ApplyPatchApproval/Permissions/ToolRequestUserInput
  JSON-RPC requests (→ InteractionStore). Kills the stuck-modal + `ensureCwdTrusted` trust-gate classes.

NEW live-transport obligations with NO interface member today (model on `ClaudeQueryHandle`
start/ready/send/interrupt/setPermissionMode/canUseTool/close): live **steer** (`turn/steer`, else
`turn/start` on resumed thread), live **interrupt** (`turn/interrupt`), live **permission-mode change**
(no restart), **approval answering**, bounded queues + abort/close, version pin+fingerprint, subscription
auth preserved.

NormalizedEvent union (`types.ts:33-41`) the parser must emit: `turn-start`(turn/started),
`turn-end`+finalText(turn/completed), `assistant-text`+`final`(agent-msg complete), `user-message`
+`synthetic`, `tool-call`/`tool-result`(item started/completed), `reasoning`(reasoning item),
`title`. **Fold on item-COMPLETE, not per-delta**, to reuse `applyEvent` unchanged.

⚠️ Parser correctness hinges on pinning from the v2 schema: (a) which notification is the authoritative
final-answer bracket + carries `finalText`, (b) how `final` (answer vs commentary) is determined,
(c) where per-event ISO timestamps live (else `lastAssistantAt`/rest-time + done/awaiting fences break).

### R2 — codex-app-server.ts current state & gaps  ✅
**DONE (solid, reusable):** process transport (spawn `codex app-server --stdio`, JSONL framing,
backpressure/limits, env allowlist, 20s timeouts, diagnostics); `thread/start` (ephemeral),
`thread/resume` machinery, `turn/start` (text+model+effort, turn-id witnessing); and the **entire
approvals path** — command/file/permissions/user-input/MCP mapped to InteractionStore with a durable
two-phase outbox (awaiting-user→queued→sent→acknowledged), fail-closed redaction, correlation/
invalidation. Approvals are live-wired into `router.ts` (ownsInteraction/resolveInteraction).

**MISSING / blocking:**
1. **Disposability (the #1 blocker).** `startDisposableSession` is the ONLY creator, defaults
   `ephemeral:true`. Every reachable session is disposable → **dead on any ntwine-server restart OR child
   disconnect** (`reconcileOwnedSessions` detaches all ephemeral rows). The persisted (`ephemeral:false`)
   + `thread/resume` + reconcile path EXISTS but is unreachable — no caller sets it. Fix FIRST.
2. **Zero event projection.** Notifications are consumed only for approval correlation + turn-id
   tracking. No agent text / reasoning / tool output / diff / token-usage / title reaches the board or
   transcript. A whole new projector is required (feeds NormalizedEvent→applyEvent per R1).
3. **Hard version gate.** `connect()` rejects userAgent != `0.144.1`; installed is **0.144.6** →
   **flag-on today connects to nothing.** Re-pin per the file's 4-step policy: (a) schema audit — DONE,
   `/tmp/codex-schema/` for 0.144.6; (b) source audit at the 0.144.6 rust tag/commit → update
   `CODEX_APP_SERVER_PROTOCOL_REVISION`; (c) new `PROTOCOL_FINGERPRINT` (auto-bumps capability_revision,
   cancels affected pending interactions on resume); (d) new contract fixtures.
4. Not sent yet (protocol supports both): **`turn/steer`** (TurnSteerParams{threadId,expectedTurnId=
   current_turn_id,input[],clientUserMessageId}), **`turn/interrupt`** (TurnInterruptParams{threadId,turnId}).
5. Per-session kill (today `close`/`shutdown` kill the SHARED child = all sessions) → use
   `turn/interrupt` + `thread/archive`/`thread/delete`. Title via `ThreadNameUpdatedNotification`.
   Worker-contract via `thread/start.baseInstructions`/`developerInstructions`.

Own DB tables in the project `ui.db`: `codex_app_server_session` (ntwine_session_id↔thread_slug↔
codex_thread_id, epoch/capability/turn-id/state), `codex_app_server_meta`, schema marker. Does NOT
write the ntwine `session` registry — parallel binding keyed by ntwine_session_id/thread_slug.

### R4 — wiring + cutover blast radius  ✅
`backendFor(kind)=kind==="codex"?codexBackend:claudeBackend` (context.ts:388) — pure string switch,
defaults claude; **the bridge is NEVER returned by backendFor.** It's a parallel `ctx.codexAppServer`
wired only into session-release + interaction RPCs + shutdown. So a `backend="codex"` row ALWAYS runs
tmux today; the bridge only owns sessions it starts itself (`startDisposableSession`/`startTurn`) — which
**nothing in dispatch calls** (tests only). ⇒ cutover is NOT a `codexBackend` swap; dispatch/resume need
real new app-server branches (or an AgentBackend adapter over the bridge).

Server touch-points (each disappears/rewrites under app-server):
- **dispatch.ts:** `transportCodexPrompt` 18KB temp-file hack (540-571), rollout-discovery + sentinel +
  15s poll (536,695-709,817-849), `ensureCwdTrusted` pre-arm (795) → ALL gone (thread/start returns the
  id synchronously; prompt is a turn/start param; no trust modal).
- **resume.ts:** live keystroke inject + paste-buffer + cross-socket legacy-worker reuse + codex-input
  queue append (1150-1238), `inspectCodexComposer` idle probes (253-259,997) → replaced by one
  `startTurn`/`turn/steer` RPC. deliveryId dedupe must map onto `clientUserMessageId`.
- **permission-controller.ts:406-564:** the ENTIRE codex-input queue subsystem (ownCodexInput/
  queueFollowUp/submitExistingDraft/prepareCodexDraftReplacement/clearAmbiguousCodexInput + Enter/Tab
  keystrokes) → obsolete.
- **board.ts:379-384:** followUpQueueAvailable/queuedInputCount/codexInputAmbiguous → obsolete.
- **tailer.ts:** `detectCodexNativeInput` pane-scrape modal families → replaced by protocol approval
  requests (already implemented in the bridge).
- **scheduler wake** (context.ts:489-500), **followUp RPC** (router.ts:499-518) → bridge startTurn/steer.
- **router.ts draft-recovery RPCs** (556-588) + shared types (index.ts:693-709) + UI callers → DELETE.

UI (wire-neutral, mostly): ThreadActionBar/eagerComposerSubmission already submit via plain
`rpc.followUp` — server maps to turn/start|steer, client unchanged. Retire codex-input-queue
assumptions in `threadPermissions.ts` (29,35-41,48-50) + `useThreadComposerControls.tsx` (47,152-154).

**⚠️ MOST load-bearing unknown (R4):** transcript source. `readLatestThreadTranscriptPage` still routes
codex chat through the tmux rollout reader (router.ts:370→findRolloutById). Does `codex app-server`
write a readable rollout JSONL? R2 says the bridge projects nothing regardless → board/chat rendering is
a gap either way. **→ resolving via live smoke test below.**

### R3 — state derivation + input machinery to replace
<!-- pending R3 (a9cbddfb): tailer/board pipeline, codex-input drain, replace/remove/keep/new-source table -->

### R4 — wiring + cutover blast radius
<!-- pending R4 (ac164c7c): backendFor/dispatch/resume/router + UI codex-input sites, cutover options, touch-point list -->

## Live validation (smoke test against real codex 0.144.6 — `scratchpad/appserver-smoke.mjs`)
Confirmed facts (drove the real `codex app-server --stdio`, subscription auth, a real turn):
- **Subscription auth works with NO API key.** Handshake + thread/start + turn/start ran; the agent
  streamed "PONG" via `item/agentMessage/delta`. Billing preserved. ✅
- **userAgent = `ntwine/0.144.6 (Mac OS 26.5.2; arm64) tmux/3.7a (ntwine; 0.0.1)`** → the re-pin gate regex
  `^ntwine/(\d+\.\d+\.\d+)` cleanly extracts `0.144.6`. Re-pin is mechanical. ✅
- **`thread/start` returns `thread.path` = the exact rollout jsonl path synchronously** (with
  `ephemeral:false`): `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<threadId>.jsonl`. **No discovery
  race, no sentinel, no 15s poll.** ✅
- **The persisted rollout file exists on disk (60KB) in the IDENTICAL format `parseCodexLine` already
  parses** (`session_meta`/`event_msg`/`response_item`). Ephemeral:true wrote **0** files; ephemeral:false
  writes the rollout. ✅ → **the existing state/fold/title/profile pipeline is reusable UNCHANGED.**
- Streaming vocabulary confirmed: `thread/started, turn/started, item/started, item/completed,
  item/agentMessage/delta, thread/tokenUsage/updated, account/rateLimits/updated, turn/completed`.
- **DURABLE RESTART→RESUME PROVEN LIVE** (`scratchpad/appserver-restart-resume.mjs`): persist thread on
  process A → turn1 (rollout 60298B) → **KILL A** → fresh process B → `thread/resume(sameThreadId)` OK
  (same id, ephemeral:false) → turn2 → rollout grew to 63413B with a full turn appended. The #1 blocker
  (disposability) is solvable exactly as planned: `ephemeral:false` + `thread/resume`. ✅✅✅ Rollout tail
  = `event_msg/user_message, agent_message, task_complete` — precisely what `parseCodexLine` folds.

**⇒ De-risked architecture (locked):** create sessions with **`ephemeral:false`**, take the rollout
`path` from the thread/start response, **KEEP rollout-tailing for ALL state**, and move only **INPUT**
to RPC. The notification→board projector (R2 gap #2) becomes a LATER latency optimization, NOT a
prerequisite. Durable resume falls out of persisted threads + `thread/resume` (bridge already scaffolds).

## Critic findings folded in (adversarial review)
- **B1 (blocker, re-sequenced):** liveness/crash is tmux-hardwired — `deriveRuntime` (board.ts:52)
  returns "exited" with no tmux pane; `crashed = exited && turn==="in-flight"` (board.ts:312) marks a
  streaming app-server row CRASHED; `paneDeadForRow`→`tmux.paneDead` (tailer.ts:1713) fires a spurious
  "session ended". ⇒ input-routing and liveness-re-source are ONE phase. App-server must be a distinct
  backend kind that `deriveRuntime`/`paneDeadForRow` special-case from day one (liveness = bridge
  connection/process state, not a pane).
- **B2 (blocker):** start-vs-steer off `current_turn_id` (async-mutated at turn/started:2304 /
  turn/completed:2325) is a TOCTOU race → `activeTurnNotSteerable` → eager UI drops the message
  (eagerComposerSubmission.ts:97). And `deliveryId` is NOT honored — `startTurn` mints its own id
  (:1475). FIX: the BRIDGE owns the decision atomically under its op-lock — try `turn/steer`, on
  `activeTurnNotSteerable` fall back to `turn/start` internally; thread `deliveryId`→`clientUserMessageId`
  + a persisted dedup table; define two-composers/concurrent-submit behavior explicitly.
- **M2 (gap):** bridge `thread/start` (:1390-1399) sends NO `developerInstructions`/`config`/
  `baseInstructions` → under app-server: no auto-title, no reasoning summaries (`model_reasoning_summary`
  unset), no worker-contract. Must port the tmux `-c` overrides (codex.ts:135-231) to thread/start params
  BEFORE "reuse pipeline unchanged" is true. Also verify rich-turn fold (function_call/custom_tool_call/
  apply_patch diff/reasoning.summary) — smoke only exercised a trivial reply.
- **M3:** mid-session model/effort works only on the NEXT `turn/start` (TurnStartParams has
  model/effort/sandboxPolicy/approvalPolicy); `turn/steer` carries none. Key-name trap: thread/start uses
  `sandbox`, turn/start uses `sandboxPolicy`. Bridge's startTurn currently sends only model+effort. Perm
  change mid-turn must fail-closed (matches tmux behavior) — make explicit.
- **M1 (good):** durable restart→resume independently re-confirmed by the critic's harness. HOLDS.
  Caveat: `reconcileOwnedSessions` (:1791) resumes serially inside connect() w/ 20s each → bound/
  parallelize so N slow threads don't block bridge startup.
- **m1:** ~113 `backend==="codex"` sites across ~21 files; many fall through to the Claude default and
  would misbehave under a new kind. `"codex-app-server"` is NOT a reserved backend value today (only an
  InteractionStore provider const) — R4 was wrong on that. Cutover is real breadth, not a one-liner.
- **m2:** headless Terminal tab loss ALSO removes the human approval escape-hatch (attach + answer a
  stuck approval) → InteractionStore becomes the ONLY approval path; and the `codex resume <id>` copy
  affordance becomes dangerous (a 2nd process on the same thread the app-server holds).
- **m3 (good):** rollout is written INCREMENTALLY (18.7KB mid-turn → 60KB after) — tailing streams, no
  turn-end latency cliff. Projector deferral is safe.

## Phasing (revised — foundation additive & safe; integration is the risky, coupled phase)

**Phase A — bridge foundation (pure additions behind the flag; NO tmux-path risk, nothing user-facing):**
1. **Re-pin 0.144.1→0.144.6** so the bridge connects: source audit at the 0.144.6 rust tag/commit, update
   `CODEX_APP_SERVER_PROTOCOL_REVISION` + `PROTOCOL_FINGERPRINT`, regenerate contract fixtures from
   `/tmp/codex-schema/`.
2. **Persisted sessions + steer/interrupt + config.** `ephemeral:false`; persist `codex_thread_id` +
   rollout `path` to the ntwine registry; add `turn/steer` (with the atomic steer→start fallback owned in
   the bridge, B2) + `turn/interrupt`; per-session kill via `thread/archive`/`delete`; port the tmux `-c`
   overrides into `thread/start` `developerInstructions`/`config` (title protocol, `model_reasoning_summary`,
   worker-contract — M2); `deliveryId`→`clientUserMessageId` dedup table.
3. **Verification harnesses** (extend the smoke tests): steer-race (fire input as turn/completed lands →
   no dropped message), duplicate-deliveryId→one turn, rich-turn fold (command + file edit + reasoning),
   restart-resume through the BRIDGE (not just raw protocol), bounded reconcile.

**Phase B — integration & cutover (coupled; the risky phase — one coherent PR):**
4. **App-server as a distinct backend kind + liveness re-source (B1, must land together with input).**
   `deriveRuntime`/`paneDeadForRow`/`crashed` special-case app-server rows; liveness from bridge
   connection/process state. Route codex INPUT through the bridge: spawn=`thread/start`(persisted, path→
   transcript, kills discovery/sentinel/poll/`transportCodexPrompt`/`ensureCwdTrusted`), resume=
   `thread/resume`, followUp=bridge atomic start|steer. **Keep the rollout tailer for STATE.**
5. **Retire the codex-input composer machinery** — permission-controller drain, draft-recovery RPCs +
   shared types + UI callers, board queue fields. Approvals via the bridge InteractionStore path
   replacing `detectCodexNativeInput` pane-scrape.
6. **Cutover routing + fallback** — per-row runtime discriminator so NEW dispatches use app-server while
   existing tmux `"codex"` rows drain; keep tmux CodexBackend as fallback until proven; then remove.
   (~113 `backend==="codex"` sites to audit — m1.)
7. **Runtime verification** — drive a real Codex thread end-to-end in the app: spawn, stream, **steer a
   running turn**, interrupt, approve a command, resume-after-restart. Board shows RUNNING not crashed.
   Screenshots desktop+narrow.
8. **(Later/optional)** replace rollout-tailing with live notification projection for lower latency.

## Key design fork (from R1 — mine to decide, will recommend)
The `AgentBackend` interface is file-oriented (`foldLine(state, line: string)` + `transcriptPath`), but a
JSON-RPC backend receives parsed notification OBJECTS and holds a live handle. Two ways:
- **(A) Persist v2 notifications to a jsonl the tailer tails** (deterministic path from the app-server
  thread id). Least interface churn; PRESERVES the file-tail architecture AND durable resume across
  server restart for free; the fold stays line-oriented. ← leaning A.
- **(B) Change the fold-driver contract to accept parsed events** and hold state in the live handle.
  Cleaner conceptually but ripples through the tailer + loses the free durable-resume/replay property.
Recommend A unless R3/R4 surface a blocker. This also means ntwine gets its FIRST live-process backend
handle (model on `ClaudeQueryHandle`) — a reusable abstraction both this and the (also-foundation-only)
`claude-agent-sdk.ts` could share later.

## Workflow (DECIDED by human)
- Work in the worktree, test end-to-end THERE, then **merge straight into local `main`** at high
  confidence. **NO GitHub PR** (per NTWINE.md — this repo never uses PRs). I own the merge-back.
- **Test the real thing end-to-end** as the primary confidence mechanism; adversarial/self-review is a
  supplement only (NTWINE.md hardened in commit 287b828). Build → run it live → merge.
- **PRs #12 & #15 are SUPERSEDED** by this migration (both patch `permission-controller.ts` codex-input
  drain — the machinery Phase B deletes). Close as superseded once this lands (human's call).

## Open decisions for the human (checkpoint)
1. **Protocol version-pin policy.** Bridge hard-pins 0.144.1; installed is 0.144.6 (drift will keep
   happening as codex ships). Re-pin per the existing 4-step audit discipline each bump (recommended,
   matches the security posture) vs. loosen to a semver range vs. auto-generate bindings + fingerprint
   in CI. Recommend: keep exact-pin, re-pin to 0.144.6 now.
2. **Headless Codex → the "Terminal" tab.** App-server runs Codex headless (JSON-RPC), NOT in an
   attachable tmux TUI pane. Today a Codex thread has a live Terminal tab + `codex resume <id>` external
   attach. Under app-server there's no TUI to attach. Options: drop the Terminal tab for codex / show a
   read-only event log / keep an opt-out tmux mode. (This is the main user-visible behavior change.)
3. **Cutover routing + in-flight sessions.** Recommend per-row `backend="codex-app-server"` discriminator:
   new dispatches use app-server, existing tmux `"codex"` rows drain on the old path (no forced migration
   — the bridge refuses TUI-session import anyway). Keep tmux CodexBackend as fallback until proven, then
   delete. Alt: global flag hard-cutover (simpler, loses in-flight tmux turns). 
4. **Scope of THIS effort.** Land phases 1–3 (connect + persisted sessions + steer/interrupt + input
   routing, behind the flag, tmux still default) and prove it end-to-end, then a second effort does 4–6
   (retire composer machinery + cutover)? Or push straight through 1–6 in one branch? Recommend
   incremental: 1–3 first, verified, before ripping out the composer machinery.

## Non-goals
- Not adopting npm `@openai/codex-sdk` (wraps `codex exec`; no steer/interrupt/live-approvals — would
  not fix the complaint). We target the richer app-server protocol directly, as the bridge already does.
- Not changing the Claude backend.
