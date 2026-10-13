# Codex support for ntwine — investigation + adapter plan

**Status:** investigation + design. No production code changed. All findings below are grounded in
real experiments run against `codex-cli 0.144.1` (`~/.local/bin/codex`) on 2026-07-10, and in the
current ntwine source at `ui/packages/server/src/*`.

## TL;DR

- **Codex fits ntwine's spawn + tail + resume model.** It runs headless (`codex exec`) and as an
  interactive TUI (`codex`), both write a durable JSONL transcript ("rollout") to
  `~/.codex/sessions/YYYY/MM/DD/`, and both resume the same session by id (`codex exec resume <id>` /
  `codex resume <id>`) appending to the **same** rollout file. That is structurally the same shape as
  our `claude` + `--session-id` + `claude -r` + tail-the-JSONL loop.
- **The fence contract transfers.** In a real run, telling codex "end your message with a ```done
  fence" produced exactly that; and a project `AGENTS.md` carrying the contract was honored
  **unprompted** (system-level injection, compaction-proof). So the WORKER_PROMPT fence protocol
  needs no redesign for codex — only a different injection channel.
- **The tailer is the real work.** Codex's rollout schema is richer and cleaner than Claude's JSONL
  (explicit `task_started`/`task_complete` turn brackets, `agent_message` with a `phase`
  discriminator), but it is a *different* schema. The JSONL parser in `tailer.ts` is Claude-specific
  and needs a codex-specific parser behind a normalized-event interface.
- **Two real gaps** (not blockers, but adapter design must handle them): codex has **no session-id
  pin flag** (Claude has `--session-id`), so the transcript path must be *discovered* after spawn
  rather than computed; and codex has **no sub-agent / Task tool** analog today, so the sub-agent
  drill-in surface is a Claude-only feature that degrades to empty for codex.

---

## 1. Codex as a spawnable CLI

### 1.1 Invocation modes

`codex` has two spawn surfaces, mirroring `claude`'s interactive-vs-print split:

| Concern | Claude Code (today) | Codex (verified) |
|---|---|---|
| Interactive TUI (human attaches) | `claude …` | `codex …` (no subcommand) |
| Headless / non-interactive | `claude -p` (being deprecated for Max auth) | `codex exec [PROMPT]` (alias `codex e`) |
| Resume by id (fresh follow-up) | `claude -r <sessionId> <msg>` | `codex resume <id> [prompt]` (TUI) / `codex exec resume <id> [prompt]` (headless) |
| Resume most recent | n/a | `--last` |
| System-prompt injection | `--append-system-prompt-file <path>` | `AGENTS.md` (project/global) or prompt-prepend — no append flag |
| Session-id pin at spawn | `--session-id <uuid>` | **none** — codex mints its own id |
| Working dir | tmux `-c <cwd>` | `-C/--cd <dir>` or tmux `-c <cwd>` |
| Model | `--model` | `-m/--model` |
| Reasoning effort | `--effort` | `-c model_reasoning_effort=<...>` (config, not a flag) |
| Permission/sandbox | `--permission-mode <mode>` | `-s/--sandbox <read-only\|workspace-write\|danger-full-access>` + `--dangerously-bypass-approvals-and-sandbox` |
| Structured event stream | (none on stdout) | `codex exec --json` emits JSONL events to stdout |
| Final message to file | (none) | `-o/--output-last-message <file>` |

Relevant `codex exec` flags observed (`codex exec --help`): `--json`, `-o <file>`,
`--output-schema <file>` (JSON-Schema-constrained final response), `-C/--cd`, `--add-dir`,
`--skip-git-repo-check`, `--ephemeral` (do **not** persist session files — we must NOT use this,
tailing depends on the rollout), `-c key=value` (arbitrary TOML config override), `-p/--profile`
(layer `$CODEX_HOME/<name>.config.toml`).

### 1.2 A real headless run (exact command + result)

```bash
cd /tmp/codex-ntwine-exp   # a git repo with hello.txt = "test file"
codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox \
  -o /tmp/codex-ntwine-exp/last.txt \
  "Read hello.txt and tell me what it says in one sentence. Then end your message with a fenced code block: ```done newline all good newline ```"
```

`--json` stdout stream (verbatim, one event per line):

```jsonl
{"type":"thread.started","thread_id":"019f4cca-7ad6-74a1-a1f3-400a0deae173"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I'll read `hello.txt` …"}}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc 'cat hello.txt'","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc 'cat hello.txt'","aggregated_output":"test file\n","exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"`hello.txt` says: test file.\n\n```done\nall good\n```"}}
{"type":"turn.completed","usage":{"input_tokens":27669,"cached_input_tokens":15616,"output_tokens":110,"reasoning_output_tokens":16}}
```

`-o last.txt` contained exactly the final message, fence intact:

```
`hello.txt` says: test file.

```done
all good
```
```

**Takeaway:** the fence contract is honored verbatim, and the `--json` stream is a clean,
already-normalized event log (`thread.started` → `turn.started` → `item.*` → `turn.completed`).

### 1.3 Resume (verified)

```bash
codex exec resume 019f4cca-7ad6-74a1-a1f3-400a0deae173 \
  --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check \
  "What was the filename I asked you about a moment ago? One word."
# → "hello.txt"   (full prior context retained)
```

The resume **appended to the same** on-disk rollout file
(`rollout-2026-07-10T09-09-25-019f4cca-…​.jsonl`) — no new file. This is exactly the property ntwine's
tailer relies on: one growing transcript per session that a byte-offset cursor can follow across
turns and across a dead-session resume.

### 1.4 Custom-instruction / worker-contract injection

Ntwine injects the fixed worker norms (`WORKER_PROMPT.md`) at **system** level via
`claude --append-system-prompt-file`. Codex has no `--append-system-prompt` flag. Two channels were
tested; results:

1. **`AGENTS.md` (works, recommended).** Wrote a project-root `AGENTS.md` telling codex to end every
   reply with a ```done fence, then ran a fresh session asking only "What is 2+2?" **without
   mentioning the fence**. Codex honored it:

   ```
   2+2 is 4.

   ```done
   contract-worked
   ```
   ```

   AGENTS.md is discovered from the cwd (and parent dirs, and `~/.codex/AGENTS.md` globally), is
   surfaced in the rollout's `world_state.agents_md`, and is compaction-proof (the base + project
   instructions are re-sent each turn). This is the codex analog of `--append-system-prompt`.

2. **`-c experimental_instructions_file=<path>` (rejected as the channel).** The flag was accepted
   (no error) but the one-line contract was **not** honored — this key *replaces* base instructions
   rather than appending, so it strips codex's own identity and is the wrong tool. Do not use it.

3. **Prompt-prepend (works, not compaction-proof).** Putting the contract in the first user message
   works for turn 1 and rides forward as conversation history, exactly like Claude's `composePrompt`
   visible half. Good as a belt-and-suspenders companion to AGENTS.md, not a replacement.

**Recommended codex injection strategy:** the adapter writes a **session-scoped AGENTS.md** that
carries the worker norms + spawn orientation (scratchpad/plan lines), and additionally prepends the
task framing into the prompt (mirroring the current dispatch split). The open question is *where* to
put the AGENTS.md without polluting the repo — see §6.

---

## 2. Codex transcript / log format

### 2.1 Where codex writes

- **Rollout files:** `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO8601>-<session_id>.jsonl`.
  The filename embeds both a timestamp **and** the session UUID. (`$CODEX_HOME` overrides `~/.codex`.)
- A `~/.codex/history.jsonl` and several SQLite DBs (`state_5.sqlite`, `logs_2.sqlite`, …) also
  exist, but the **rollout JSONL is the transcript of record** and the only artifact we need.
- Contrast with Claude: `~/.claude/projects/<cwdSlug>/<session_id>.jsonl` — path is a deterministic
  function of cwd + the pinned session id. Codex's path is **not** deterministic from the id alone
  (the timestamp is in the name and the dir is date-sharded), and the id is not known until the
  process starts. See §4/§6 for the discovery consequence.

### 2.2 Rollout record envelope + observed types

Every line is `{"timestamp": ISO8601, "type": <string>, "payload": {…}}`. Observed `type`s from the
real 18-line rollout (a one-tool turn):

| `type` | Role | Key payload fields ntwine cares about |
|---|---|---|
| `session_meta` | First line; session header | `payload.session_id`, `payload.cwd`, `payload.originator` (`codex_exec`), `payload.source` (`exec`), `payload.cli_version`, `payload.base_instructions.text` (the full system prompt) |
| `turn_context` | Per-turn config | `cwd`, `model`, `effort`, `approval_policy`, `sandbox_policy` |
| `event_msg` | **Semantic events** (mirror of `--json` stdout) | `payload.type` ∈ `task_started`, `user_message`, `agent_message`, `token_count`, `task_complete` |
| `response_item` | **Raw model I/O items** | `payload.type` ∈ `message` (role `developer`/`user`/`assistant`, `content[].{input_text,output_text}`), `reasoning` (encrypted), `function_call` (`name`, `arguments`, `call_id`), `function_call_output` (`call_id`, `output`) |
| `world_state` | Env/skills snapshot | `agents_md`, filesystem roots |

The two families overlap deliberately: `event_msg` is the high-level story (turn lifecycle + final
answer), `response_item` is the low-level API trace (every tool call/result and reasoning block).
**ntwine should parse `event_msg` for state and `response_item` for tool-call rendering.**

### 2.3 The turn-state signal (cleaner than Claude's)

Codex brackets each turn explicitly, so we do **not** need Claude's `stop_reason` heuristic +
5s-silence backstop:

- `event_msg / task_started` (with `turn_id`) → a turn began → **in-flight**.
- `event_msg / task_complete` (with `turn_id`, `last_agent_message`, `duration_ms`) → the turn
  finished → **idle**. `last_agent_message` is the final message (the fence lives here).
- A later `user_message` re-opens a turn (→ in-flight), exactly like a user JSONL record does today.

The `agent_message` event carries a **`phase` discriminator**: `"commentary"` (intermediate status
updates, "I'll read hello.txt…") vs `"final_answer"` (the actual final message). **The fence must be
parsed from the `final_answer` agent_message / `task_complete.last_agent_message`, never from a
`commentary` one.** This is strictly cleaner than Claude, where "last assistant text block" required
care.

### 2.4 Tool calls

`response_item / function_call` = tool_use; `response_item / function_call_output` = tool_result,
correlated by `call_id`. The shell tool is `exec_command` (args JSON: `{cmd, workdir, yield_time_ms,
max_output_tokens}`). The `--json` stream renders the same thing as
`item.{started,completed}` with `type:"command_execution"` (`command`, `aggregated_output`,
`exit_code`, `status`). So turn-state, tool-calls, and the final message are **all recoverable** from
the rollout, the way `tailer.ts` recovers them for Claude — just off a different schema.

### 2.5 What has no clean codex analog

- **Sub-agents (Claude `Agent`/Task tool).** Codex 0.144.1 has no first-class sub-agent dispatch that
  writes a child transcript the way Claude does (the rollout showed a `multi_agent_version:"v1"` field
  and multi-agent is emerging, but there is no Task-tool → `subagents/agent-<id>.jsonl` artifact to
  tail). The sub-agent drill-in drawer + spinner counts are **Claude-only** and degrade to empty for
  codex.
- **Background shells (Claude `Bash run_in_background`).** Codex backgrounds via `exec_command`
  timeouts/`yield_time_ms`, a different mechanism; treat as unsupported for codex initially.
- **Native `AskUserQuestion`.** No codex analog; `pendingAsk` stays empty. Human questions still work
  via the ```question **fence** (message-as-medium), which transfers fine.
- **Interactive permission-prompt pane-sniff.** Codex's approval modal has different on-screen text
  than Claude's ("Do you want…"/"1. Yes"/"Esc to cancel"). The `matchesPermPrompt` markers in
  `tailer.ts` are Claude-TUI-specific and need codex-specific markers captured empirically (only
  matters if codex runs with an approval policy that can pause; with
  `--dangerously-bypass-approvals-and-sandbox` or `approval_policy=never` there is no prompt).

---

## 3. What transfers vs what needs a codex adapter

### Transfers unchanged (backend-agnostic already)

- **tmux layer** (`tmux.ts`): spawn detached, `remain-on-exit`, `capture-pane`, `paneDead`,
  `sendKeys`/`pasteText` live injection, per-project socket, batched liveness. Codex is just another
  argv to `new-session`. **Zero changes.**
- **The fence grammar** (`parseSignalFence`, `hasQuestionBlock`, `SIGNAL_FENCE_RE`,
  `QUESTION_BLOCK_RE`): pure string parsing over the final message. Reusable verbatim once the
  backend hands us "the final assistant message text."
- **The scheduler / wakers** (`scheduler.ts`): operates entirely on `tailer.get(slug).lastFence` +
  `resume(slug, msg)`. Backend-agnostic as long as the tailer produces a `FenceView` and resume
  works. **Zero changes** beyond routing resume through the adapter.
- **Board read-model, SSE, storage registry, RPC, web client, CLI:** all consume the normalized
  `SessionTelemetry` / `BoardSnapshot`. Untouched if the adapter preserves those shapes.
- **Live resume** (`resumeThread` when `tmux.isLive`): `sendKeys`/`pasteText` into the running TUI is
  backend-agnostic. Only the **dead-session** resume argv is backend-specific.

### Needs a codex-specific adapter

1. **Spawn argv builder** — `buildClaudeCommand` / `buildClaudeResumeCommand` (`dispatch.ts`).
2. **System-prompt injection** — `loadWorkerPrompt` + `systemPromptFlags` (`--append-system-prompt-file`)
   → codex AGENTS.md write + prompt-prepend.
3. **Transcript location** — `defaultLogDir` (`~/.claude/projects/<slug>`) + the deterministic
   `<sessionId>.jsonl` path → codex date-sharded dir + **session-id discovery** (no pin flag).
4. **Transcript parser** — the whole `applyRecord` / `computeTurn` / record-type machinery in
   `tailer.ts` → a codex rollout parser producing the same normalized folds.
5. **Perm-prompt markers** — `matchesPermPrompt` regexes → codex TUI markers (or disabled for codex).
6. **Sub-agent / bg-shell / native-ask tracking** — Claude-only; codex adapter returns empty.
7. **Session-seed hooks** (`cc/hooks/session-seed.mjs`, gated on `NTWINE_THREAD`): these are Claude
   Code hooks (`~/.claude` `SessionStart`). Codex has its own hook system
   (`~/.codex` `ntwine-session-start.mjs` etc. already exist in `codex/hooks/`). Worker-contract
   seeding for codex rides AGENTS.md instead; codex hooks are a separate, optional parity effort.

---

## 4. The adapter abstraction

One interface, one implementation per backend. The server holds an `AgentBackend` chosen per session
(persisted on the registry row) and routes spawn/resume/tail through it. The **tailer becomes a thin
driver** that owns byte-offset cursoring + the poll loop + board-dirty bookkeeping, and delegates
**parsing** to the backend, which folds bytes into a shared normalized accumulator.

### 4.1 Backend identity on the registry row

Add `backend: "claude" | "codex"` to the sessions table (default `"claude"`, so every existing row
and all current behavior is unchanged). `session_id` stays the durable key; for codex it is the
discovered rollout id.

### 4.2 The interface (TypeScript)

```ts
export type BackendKind = "claude" | "codex"

// A backend-neutral transcript record: the ONLY vocabulary the tailer's fold understands. Each
// backend's parser maps its raw lines onto this union. Sidecar/unknown lines map to nothing (skipped).
export type NormalizedEvent =
  | { kind: "turn-start"; at?: string }                    // a turn began (→ in-flight)
  | { kind: "turn-end"; at?: string; finalText?: string }  // a turn finished (→ idle); finalText carries the fence
  | { kind: "assistant-text"; at?: string; text: string; final: boolean } // streamed assistant text (final=the answer, not commentary)
  | { kind: "user-message"; at?: string; text?: string; synthetic: boolean } // human turn (synthetic=peer/notification/tool-result echo — never bumps lastUserAt)
  | { kind: "tool-call"; at?: string; id: string; name: string; input: unknown }
  | { kind: "tool-result"; at?: string; id: string; text: string }
  | { kind: "title"; title: string }                       // backend's own session auto-title (ai-title / codex thread title)

// What the tailer's fold produces per session — the SAME shape both backends feed, and the SAME
// shape board.ts already consumes (SessionTelemetry). Unchanged surface; new producers.
export interface NormalizedTail {
  turn: "in-flight" | "idle"
  lastActivityAt?: string
  lastAssistant?: string
  aiTitle?: string
  lastUserAt?: string
  lastFence?: FenceView          // parsed by the shared fence grammar from the final message
  pendingQuestion: boolean
  subAgents: SubAgentView[]      // codex: always []
  bgShells: BgShellView[]        // codex: always []
  pendingAsk?: PendingAskData    // codex: undefined
}

export interface AgentBackend {
  readonly kind: BackendKind

  // ---- spawn / resume (argv + injection) ----
  // Build the detached-spawn argv + any files that must exist on disk first (e.g. codex AGENTS.md,
  // claude sysprompt file). The caller runs `tmux.spawn(slug, argv, cwd, env)`.
  buildSpawn(opts: SpawnOpts): { argv: string[]; env: Record<string, string>; prewrite: PrewriteFile[] }
  // Dead-session resume: argv to re-attach the pinned session with a follow-up message.
  buildResume(opts: ResumeOpts): { argv: string[]; env: Record<string, string>; prewrite: PrewriteFile[] }

  // ---- transcript location ----
  // Deterministic path for claude (<slug>/<sessionId>.jsonl). For codex, the id isn't known until the
  // process writes session_meta, so this may return undefined until discovered — the tailer then calls
  // discover() to resolve it (newest fresh rollout in cwd) and pins it on the registry row.
  transcriptPath(sessionId: string): string | undefined
  discoverSession?(cwd: string, spawnedAtMs: number): { sessionId: string; path: string } | undefined

  // ---- parsing ----
  // Fold one raw transcript line into normalized events (0..n). Pure + defensive: bad line → []. The
  // tailer owns byte-offset/partial-line cursoring and calls this per complete line, backend-blind.
  parseLine(line: string): NormalizedEvent[]

  // ---- optional pane-sniff (perm prompt) ----
  matchesPermPrompt?(pane: string): boolean   // claude: current regexes; codex: its own markers or omit
}

export interface SpawnOpts {
  sessionId: string          // claude: pinned via --session-id. codex: advisory (id is discovered)
  cwd: string
  prompt: string             // the composed first user message (task + orientation)
  workerContract: string     // WORKER_PROMPT.md norms — injected at system level per backend
  extraSystemPrompt?: string // scratchpad/plan orientation
  permissionMode: PermissionMode
  model?: string
  effort?: string
}
export interface ResumeOpts extends Omit<SpawnOpts, "prompt"> { message: string }
export interface PrewriteFile { path: string; contents: string }
```

### 4.3 How the two implementations differ

| Interface member | `ClaudeBackend` | `CodexBackend` |
|---|---|---|
| `buildSpawn` | `claude --session-id <id> --permission-mode … --model … --plugin-dir … --append-system-prompt-file <f> <prompt>`; prewrite = the sysprompt file | `codex --cd <cwd> -m <model> -s <sandbox> -c model_reasoning_effort=<effort> <prompt>`; prewrite = session-scoped `AGENTS.md` with the contract |
| `buildResume` | `claude --permission-mode … --append-system-prompt-file <f> -r <id> <msg>` | `codex resume <id> <msg>` (or `codex exec resume` for headless) |
| `transcriptPath` | `~/.claude/projects/<cwdSlug>/<id>.jsonl` (deterministic) | `undefined` → `discoverSession` scans `~/.codex/sessions/**/rollout-*-<id>.jsonl`, or newest-fresh in cwd when id unknown |
| `parseLine` | current `applyRecord` logic, re-expressed as `NormalizedEvent[]` | rollout parser: `event_msg/task_started`→turn-start, `event_msg/task_complete`→turn-end(finalText=last_agent_message), `event_msg/agent_message` phase→assistant-text(final=phase==="final_answer"), `response_item/function_call(_output)`→tool-call/result |
| `matchesPermPrompt` | current regexes | omitted initially (run bypass-approvals) |

The shared fence grammar (`parseSignalFence`, `hasQuestionBlock`) runs in the **tailer**, over the
`finalText` of a `turn-end` (or the latest `assistant-text{final:true}`), for **both** backends — one
implementation, no duplication.

### 4.4 Code that moves behind the interface

- `dispatch.ts`: `buildClaudeCommand`, `buildClaudeResumeCommand`, `loadWorkerPrompt`,
  `systemPromptFlags`, `workerPluginDir` → `ClaudeBackend`. `composePrompt` / `scratchpadOrientation`
  / `slugify` / `writeScratchpad` stay in dispatch (backend-neutral).
- `tailer.ts`: `applyRecord` + all record-typed helpers (`trackDispatches`, `trackLaunchResults`,
  `trackCompletions`, `trackAsk`, `lastTextBlock`, `isRealUserMessage`, `matchesPermPrompt`,
  `defaultLogDir`) → `ClaudeBackend.parseLine` + `ClaudeBackend.transcriptPath` +
  `ClaudeBackend.matchesPermPrompt`. The cursoring (`consume`), poll loop (`tick`), foreign discovery,
  dirty bookkeeping, and `computeTurn`/fence application **stay** in the tailer, now driven by
  `NormalizedEvent`.
- `resume.ts`: route the dead-session argv through `backend.buildResume`; live `sendKeys`/`pasteText`
  unchanged.
- `scheduler.ts`: unchanged (consumes `lastFence` + `resume`).

---

## 5. Phased roadmap

### Phase 1 — Refactor to the adapter, Claude as the sole implementation (NO behavior change)

Goal: introduce `AgentBackend` + `NormalizedEvent` and move all Claude-specific code behind
`ClaudeBackend`, with **byte-for-byte identical** observable behavior. Every gate stays green.

1. Add the `AgentBackend` interface + `NormalizedEvent` union to a new `server/src/backend/` module
   (or `@ntwine/shared` for the types).
2. Extract `ClaudeBackend`: move the argv builders + `parseLine` (re-express `applyRecord` as
   `NormalizedEvent[]`) + `transcriptPath` + `matchesPermPrompt`.
3. Rewrite `tailer.ts` to fold `NormalizedEvent`s from `backend.parseLine` into `NormalizedTail`
   instead of parsing Claude records inline. Keep `computeTurn`, fence application, sub-agent/ask
   folding — but drive them off the normalized events. The Claude-specific sub-agent/ask tracking
   moves into events too (`tool-call`/`tool-result` carry enough for the Claude fold to reconstruct
   them; **or** keep Claude sub-agent tracking as a `ClaudeBackend`-owned side-fold to avoid churning
   that hard-won logic — decide during implementation, favoring the smaller diff).
4. Wire `dispatch.ts` / `resume.ts` to call `backend.buildSpawn` / `buildResume`. Default backend =
   `"claude"`; add the `backend` column with a `"claude"` default so all existing rows are unchanged.
5. **Verification (the bar for "no behavior change"):** run the full `node --test` suite
   (`tailer.test.ts`, `board.test.ts`, `scheduler.test.ts`, `transcript.test.ts`, `repair.test.ts`,
   `app*.test.ts`); the tailer tests already encode the corpus-verified derivations, so a green run is
   the regression proof. Then dogfood: spawn a real Claude worker, confirm sidebar runtime, turn-idle,
   fences, sub-agent drill-in, and wakers all behave as today.

*Deliverable of Phase 1: identical ntwine, now backend-pluggable.* This is the bulk of the work and
carries all the risk; land it alone.

### Phase 2 — CodexBackend

1. Implement `CodexBackend.buildSpawn`/`buildResume` (§4.3 argv), prewriting a session-scoped
   `AGENTS.md` carrying the worker contract (resolve the AGENTS.md-location question first, §6).
2. Implement `transcriptPath` + `discoverSession` (scan `~/.codex/sessions/**` for the fresh rollout;
   pin the discovered id on the row on first sighting). Add `CODEX_HOME` awareness.
3. Implement `CodexBackend.parseLine` over the rollout schema (§2.2–2.4). Unit-test it against a
   **captured real rollout fixture** (the 18-line sample in this doc is a starting fixture; capture a
   multi-turn + multi-tool one too).
4. Codex-specific tests mirroring `tailer.test.ts`: turn-start/turn-end detection, final-vs-commentary
   fence parsing, tool-call rendering. Sub-agents/bg-shells/ask assert empty.
5. Dogfood a real codex worker end-to-end: dispatch → runtime `running` → `turn-idle` → a ```done
   fence excuses it from the queue → a follow-up steer resumes it → an ```awaiting fence + `timer:`
   hint fires the waker. Contrast the sidebar against a Claude worker.
6. Decide perm-prompt handling: either run codex with approvals bypassed (no prompt to sniff) or
   capture codex's TUI approval markers and add `CodexBackend.matchesPermPrompt`.

### Phase 3 — Backend selection in the dispatch UI

1. Add `backend` to `DispatchInput` + `Settings` (default `"claude"`); persist per session.
2. Dispatch composer: a backend picker (Claude / Codex) next to the model/effort/permission controls.
   Model options become backend-scoped (codex: `gpt-5.5` etc.; claude: opus/sonnet/…). Effort maps to
   each backend's knob.
3. Sidebar: a small backend badge per row (so a mixed board is legible). Sub-agent affordances hide
   for codex rows (nothing to drill into).
4. Docs: WORKER_PROMPT.md notes the AGENTS.md injection path for codex; ARCHITECTURE.md gains a
   "backends" section.

---

## 6. Risks & open questions

- **Session-id discovery race (codex).** No `--session-id` pin means the transcript path is
  discovered post-spawn. Every worker runs in the **same repo cwd**, so "newest fresh rollout in this
  cwd" is racy across concurrent codex dispatches. Mitigations to evaluate: (a) spawn codex via
  `codex exec --json` in a wrapper that captures `thread.started.thread_id` from stdout and writes it
  to a known sidecar path ntwine reads — but that only works headless, not for the attach-able TUI;
  (b) briefly serialize codex spawns and grab the single newest rollout created in a tight window;
  (c) match on `session_meta.cwd` + an ntwine marker we can force into the rollout (e.g. a unique
  sentinel in the first prompt) and scan for it. **Recommendation:** prototype (b)+(c) in Phase 2;
  this is the single biggest codex-adapter risk.
- **AGENTS.md placement.** Writing a repo-root `AGENTS.md` pollutes the user's workspace and collides
  with a repo that already has one. Options: (a) append ntwine's contract to the existing AGENTS.md and
  restore on exit (fragile); (b) use `--add-dir` / a config-declared extra instructions dir if codex
  supports one; (c) rely on prompt-prepend for the contract and use AGENTS.md only if the repo has no
  own file. **Open — needs a focused codex-config spike** (does codex support an out-of-tree
  project-doc path or a per-invocation instructions file that *appends* rather than replaces?).
- **`--append`-style system prompt.** Confirmed there is no append flag and
  `experimental_instructions_file` *replaces* base instructions. If a future codex adds an append
  mechanism, prefer it over AGENTS.md.
- **Effort/permission semantics don't map 1:1.** Codex effort is a config key, not a flag; codex
  "sandbox" is not the same axis as Claude "permission mode." The UI must present backend-appropriate
  controls, not a shared enum pretending to be universal.
- **Sub-agent parity.** Codex's multi-agent is `v1`/emerging; today there's no child-transcript to
  tail. The drill-in surface stays Claude-only until codex exposes a stable sub-agent artifact. Not a
  blocker — degrade to empty.
- **Reasoning blocks are encrypted** (`response_item/reasoning.encrypted_content`). Fine — ntwine never
  needed model reasoning; we render commentary `agent_message`s and tool calls.
- **Two event families in the rollout** (`event_msg` vs `response_item`) describe overlapping
  activity. The parser must not double-count (e.g. count a turn from `task_started` **and** an
  assistant message from both `event_msg/agent_message` and `response_item/message`). Rule of thumb:
  **turn lifecycle + final answer from `event_msg`; tool calls from `response_item`; assistant text
  from `event_msg/agent_message` (has the `phase` discriminator) — ignore the `response_item/message`
  duplicates.**
- **Interactive-TUI rollout parity.** All experiments used `codex exec` (`source:"exec"`). The
  interactive `codex` TUI (what a human attaches to in tmux) is expected to write the same rollout
  schema with `source:"interactive"`, but this was **not** directly verified headlessly. Phase 2
  must confirm the interactive TUI's rollout matches before committing to tailing it.

---

## Appendix — key file references (ntwine)

- Tailer / JSONL parser (Claude-coupled): `ui/packages/server/src/tailer.ts`
- Spawn + prompt compose + argv: `ui/packages/server/src/dispatch.ts`
- Dead-session resume: `ui/packages/server/src/resume.ts`
- Wakers (backend-agnostic): `ui/packages/server/src/scheduler.ts`
- tmux layer (backend-agnostic): `ui/packages/server/src/tmux.ts`
- Runtime derivation: `ui/packages/server/src/board.ts` (`deriveRuntime`)
- Wire schema / RuntimeState / DispatchInput / Settings: `ui/packages/shared/src/index.ts`
- Worker contract (transfers): `ui/WORKER_PROMPT.md`, `cc-worker/skills/worker/SKILL.md`
- Claude session-seed hook (gated on `NTWINE_THREAD`): `cc/hooks/session-seed.mjs`
- Existing codex hook stubs (parity effort): `codex/hooks/ntwine-session-start.mjs` et al.

## Appendix — reproducing the codex experiments

```bash
# headless run with structured stream + final-message capture
codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox \
  -o /tmp/last.txt "…prompt ending in a ```done fence…"
# resume the exact session (appends to the same rollout file)
codex exec resume <session_id> --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check "follow-up"
# AGENTS.md injection: drop a contract in ./AGENTS.md, then run a session that never mentions it
# on-disk transcript:
ls -t ~/.codex/sessions/*/*/*/rollout-*-<session_id>.jsonl
```
