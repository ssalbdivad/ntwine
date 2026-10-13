#!/usr/bin/env node
// @ts-check
// PreToolUse hook on `Bash` (ntwine-worker). Claude's native `run_in_background` flag registers a
// task, output file, terminal notification, and wake. Shell job control (`cmd &`) does none of those:
// the child can survive after the Bash tool returns, but Claude and ntwine have no lifecycle identity
// for it. A worker can then rest forever waiting for a notification that cannot exist.
//
// Block only an ESCAPING local background job. Self-contained shell concurrency remains valid when
// the command explicitly waits for its children or owns them with an EXIT trap before Bash returns.
//
// GATE: inert unless NTWINE_THREAD is set (ordinary Claude sessions keep their native behavior).
// FAIL OPEN: malformed hook input allows the command rather than wedging a worker.
import '../lib/legacy-env.mjs';
import { readFileSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** @param {unknown} obj @returns {never} */
function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

/**
 * Blank heredoc bodies while preserving line/character positions. A script being WRITTEN may contain
 * `&`; only the shell currently executing this tool call is relevant to the lifecycle escape.
 * @param {string} command
 */
function withoutHeredocBodies(command) {
  const lines = command.split('\n');
  /** @type {string[]} */
  const pending = [];
  let active;
  return lines.map((line) => {
    if (active !== undefined) {
      if (line.trim() === active) {
        active = pending.shift();
        return line;
      }
      return ' '.repeat(line.length);
    }

    // Shell accepts quoted and bare heredoc delimiters. Multiple heredocs on one command line are
    // consumed in declaration order.
    for (const match of line.matchAll(/<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_-]*))/g)) {
      const delimiter = match[1] ?? match[2] ?? match[3];
      if (delimiter) pending.push(delimiter);
    }
    active = pending.shift();
    return line;
  }).join('\n');
}

/**
 * Replace quoted regions with spaces. Operators sent inside `ssh host '…'` are remote, and quoted
 * prose such as `printf '&'` is not local shell job control. Backticks are also synchronous command
 * substitutions from the outer shell's perspective.
 * @param {string} command
 */
function withoutQuotedRegions(command) {
  let quote = '';
  let escaped = false;
  let out = '';
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (escaped) {
      out += quote ? ' ' : c;
      escaped = false;
      continue;
    }
    if (c === '\\' && quote !== "'") {
      out += quote ? ' ' : c;
      escaped = true;
      continue;
    }
    if (quote) {
      // Double quotes may contain a complete command substitution with its OWN quote grammar:
      // `"$(python -c 'print(f"{x&255}")')"`. Treating the f-string's double quote as the end of the
      // outer region exposed arithmetic `&` as fake job control in a real corpus call. The outer shell
      // waits for command substitution, so blank the balanced substitution as part of the quote.
      if (quote === '"' && c === '$' && command[i + 1] === '(') {
        out += '  ';
        i += 2;
        let depth = 1;
        let innerQuote = '';
        let innerEscaped = false;
        for (; i < command.length; i++) {
          const inner = command[i];
          out += inner === '\n' ? '\n' : ' ';
          if (innerEscaped) {
            innerEscaped = false;
            continue;
          }
          if (inner === '\\' && innerQuote !== "'") {
            innerEscaped = true;
            continue;
          }
          if (innerQuote) {
            if (inner === innerQuote) innerQuote = '';
            continue;
          }
          if (inner === "'" || inner === '"' || inner === '`') {
            innerQuote = inner;
            continue;
          }
          if (inner === '(') depth++;
          else if (inner === ')' && --depth === 0) break;
        }
        continue;
      }
      if (c === quote) quote = '';
      out += c === '\n' ? '\n' : ' ';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      out += ' ';
      continue;
    }
    out += c;
  }
  return out;
}

// A LOCAL shell wrapper runs its script in THIS machine's process tree, so `bash -c 'job &'` escapes
// exactly as a bare `job &` does — the wrapper forks the job and exits. Blanking quoted regions is
// what exempts `ssh host '… &'` (that job is remote and the ssh client still waits), but it hid the
// local wrapper along with it, leaving a one-token bypass of the whole guard. So scan the sanitized
// text for a wrapper, then re-read its script from the ORIGINAL command and recurse.
//
// Only in COMMAND POSITION. A wrapper passed as an ARGUMENT belongs to whatever program precedes it,
// and that program decides where the script runs: `docker run img bash -c …` and
// `limactl shell vm bash -lc …` both appear in the real corpus, and neither backgrounds anything
// local. That is the same call the `ssh` exemption already makes. It costs the genuinely-local
// `xargs sh -c 'job &'`, which the corpus never shows, and under-blocking is the safer miss here.
const LOCAL_SHELL_SCRIPT = /(?:^|[\n;|&({])\s*(?:\/\S*\/)?(?:bash|sh|zsh|dash|ksh)(?:\s+-[A-Za-z]+)*\s+-[A-Za-z]*c(?=\s)/g;

/**
 * Read the quoted argument that begins at `from` in the original command, undoing only the escaping
 * the surrounding quote itself performs.
 * @param {string} raw @param {number} from
 */
function quotedArgumentAt(raw, from) {
  let i = from;
  while (raw[i] === ' ' || raw[i] === '\t') i++;
  const quote = raw[i];
  if (quote !== "'" && quote !== '"') return '';
  let out = '';
  for (i++; i < raw.length; i++) {
    if (raw[i] === '\\' && quote === '"' && i + 1 < raw.length) {
      out += raw[++i];
      continue;
    }
    if (raw[i] === quote) return out;
    out += raw[i];
  }
  return '';
}

/**
 * Return true when this Bash call starts a local background job and can return without joining or
 * terminating it. This is deliberately a small shell-lifecycle recognizer, not a general parser.
 * @param {unknown} raw
 * @param {number} depth
 */
export function hasEscapingBackgroundJob(raw, depth = 0) {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  const command = withoutQuotedRegions(withoutHeredocBodies(raw));
  /** @type {number[]} */
  const operators = [];
  for (let i = 0; i < command.length; i++) {
    if (command[i] !== '&') continue;
    const before = command[i - 1] ?? '';
    const after = command[i + 1] ?? '';
    // `&&`, redirects (`2>&1`, `&>`), and an escaped literal are not background operators.
    if (before === '&' || after === '&' || before === '>' || before === '<' || after === '>' || before === '\\') continue;
    operators.push(i);
  }
  if (operators.length > 0) {
    // A lifecycle action AFTER the last launch makes the command self-contained. `kill` alone does
    // not: the signal is asynchronous, so the shell still needs a wait before returning. An EXIT trap
    // owns cleanup at the shell boundary — wherever it is SET. `trap 'kill $pid; wait' EXIT; server &
    // pid=$!` is the idiomatic order (arm cleanup, then launch), and the trap fires at exit all the same;
    // checking only the tail denied a standard-schema sub-agent on 2026-09-30 for doing exactly what the
    // denial message tells it to do.
    const tail = command.slice(operators[operators.length - 1] + 1);
    if (!(/\bwait\b/.test(tail) || /\btrap\b[^\n;]*\b(?:EXIT|0)\b/.test(command))) return true;
  }

  // Both sanitizers substitute character-for-character, so a match position in the sanitized text
  // still indexes the original. A length mismatch would mean that invariant broke: fail open rather
  // than slice the wrong bytes. The depth cap bounds `sh -c 'sh -c …'` nesting.
  if (depth >= 3 || command.length !== raw.length) return false;
  // `matchAll` iterates a CLONE, so the module-level regex keeps no cursor for a nested call to reset
  // out from under this loop — `exec` on the shared object spins forever on `bash -c "sh -c '…'"`.
  for (const match of command.matchAll(LOCAL_SHELL_SCRIPT)) {
    const script = quotedArgumentAt(raw, match.index + match[0].length);
    if (hasEscapingBackgroundJob(script, depth + 1)) return true;
  }
  return false;
}

// THE SPAWN-TIME BUDGET PROMPT. A background shell has a runtime budget only when one is DECLARED
// (server shell-budget.ts): the `timeout` on this very call, or `ntwinectl extend-shell` later. No
// default — a dev server and a CI poller look identical from outside, and a universal clock killed a
// real shell its worker had registered a 20h watch on (2026-09-29). So the worker is ASKED, once, at
// the one moment it knows what the shell is for: a `run_in_background` call with no `timeout` gets one
// line of context. Never on a call that carries a timeout, never on a foreground call, never a block.
// It arrives after the call is committed, so it points at the in-the-moment command (`ntwinectl extend-shell`) for
// this shell and at `timeout` for the next.
//
// THE CALL ALSO GETS THE LONGEST `timeout` CLAUDE CODE ALLOWS. "No timeout" does not mean "no clock" to
// Claude Code: it stops an untimed background command after its own default, 30m, so a docs server
// launched exactly as the contract says died half an hour in (yes thread 4f19c4e3, 2026-10-08). The
// hook raises it to the ceiling through `updatedInput`, with no permission decision — measured on
// 2.1.287 under `--permission-mode default`: a hook-set 61s cap killed an untimed `sleep 200` at 61s, and
// the transcript kept the model's original input, so Ntwine still reads the shell as unbudgeted
// (shell-budget.ts). 24h is a hard ceiling here; nothing longer can be asked for.
export const BACKGROUND_UNTIMED_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const BACKGROUND_NO_TIMEOUT_CONTEXT =
  '⟦background shell with no `timeout`⟧ Ntwine never stops this shell on a clock; Claude Code stops it after 24h. ' +
  'Right for a dev server or watcher meant to keep running. If it is a poller, build or one-off check, give it an end — ' +
  '`ntwinectl extend-shell <id> --for <duration>` sized to it now (Ntwine warns you past it, then stops it), or a ' +
  '`timeout` (ms, max 24h) on the call next time. Either way, `TaskStop` it once you no longer need it.';

/** @param {unknown} toolInput */
function isUntimedBackgroundCall(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return false;
  const { run_in_background: background, timeout } = /** @type {Record<string, unknown>} */ (toolInput);
  if (background !== true) return false;
  return !(typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0);
}

// THE LONG-FOREGROUND PROMPT. Ntwine lifted the foreground ceiling to 24h on purpose (server
// backend/types.ts BASH_MAX_TIMEOUT_MS: "a worker can block on anything it chooses"), so a long call is
// never refused. But a foreground call holds the whole turn: no transcript record until it returns, so
// the thread sits in Running with nothing moving, and the human reads a worker that is running a gate
// as one that is stuck. Measured on 2026-09-29/30 (arktype
// session 50d1f5b7): a repo-wide pre-push gate run five times in the foreground under `timeout: 3600000`,
// 13–25m each, two of them failing on load, and the maintainer twice asking whether the worker was
// stuck. In the background the same run keeps the turn moving and its exit still wakes the worker.
//
// So a foreground call DECLARING more than 15 minutes gets one line of context: past the ~5-minute test
// gate, so an ordinary gate run in the foreground is left alone. Only a declared `timeout` counts — with
// none, Claude bounces the call to the background at BASH_DEFAULT_TIMEOUT_MS itself. Claude only: a
// codex exec has no `run_in_background` to point at. Like the prompt above, it lands after the call is
// committed, so it speaks to the next one.
export const LONG_FOREGROUND_MS = 15 * 60_000;

/** A duration in the house grammar (`1h`, `40m`, `2h 30m`), whole minutes only. @param {number} ms */
function minutesLabel(ms) {
  const minutes = Math.round(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

/** @param {number} timeoutMs */
export function longForegroundContext(timeoutMs) {
  return (
    `⟦long foreground call⟧ This call may hold the turn for up to ${minutesLabel(timeoutMs)}. Nothing reaches the board while it runs, ` +
    `so past ${minutesLabel(LONG_FOREGROUND_MS)} the user reads a thread with nothing moving as stuck. Run a gate, build or suite that takes minutes with ` +
    '`run_in_background: true` and the same `timeout` instead: its exit wakes you, and you can keep working or rest meanwhile.'
  );
}

/** @param {unknown} toolInput @returns {number | undefined} the declared timeout of a long foreground call */
function longForegroundTimeout(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return undefined;
  const { run_in_background: background, timeout } = /** @type {Record<string, unknown>} */ (toolInput);
  if (background === true) return undefined;
  return typeof timeout === 'number' && Number.isFinite(timeout) && timeout > LONG_FOREGROUND_MS ? timeout : undefined;
}

// BOTH PROMPTS ABOVE ARE THE THREAD'S, NEVER A SUB-AGENT'S. A hook firing inside a sub-agent carries
// `agent_id` (agent-address.mjs and session-seed.mjs skip on the same field), and neither line is true
// there:
// - the no-`timeout` line points at `extend_shell`, which resolves a shell against the THREAD's own
//   transcript (router extendOwnShell → tailer bgShells, which skips sidechain records), so a sub-agent's
//   shell is never found. Both `extend_shell` failures in three days of worker transcripts (2026-09-29..
//   10-01) were sub-agents obeying this line 3s after launching the shell, told "it has already finished
//   … or the id is wrong" about a shell that was running. Nor does Ntwine own that shell's clock: Claude
//   itself kills a sub-agent's background shell when the sub-agent returns.
// - the long-foreground line says "run it with `run_in_background: true`", while the sub-agent's own
//   dispatch epilogue (agent-dispatch.mjs) tells it the opposite — "run long commands in the FOREGROUND",
//   because nothing can wake a sub-agent that ends its turn waiting on a shell.
// Measured over those three days: 53 no-timeout and 91 long-foreground lines landed in sub-agents, against
// 31 and 0 in threads. The escaping-job DENY still applies to everyone.
/** @param {unknown} input */
function isSubAgentCall(input) {
  if (!input || typeof input !== 'object') return false;
  const { agent_id: snake, agentId: camel } = /** @type {Record<string, unknown>} */ (input);
  return Boolean(snake ?? camel);
}

export function evaluateBashBackgroundHook(input, env = process.env) {
  if (!String(env.NTWINE_THREAD ?? '').trim()) return {};
  const command = input && typeof input === 'object'
    ? String(input.tool_input?.command ?? '')
    : '';
  const codex = typeof input?.model === 'string';
  if (!hasEscapingBackgroundJob(command)) {
    if (isSubAgentCall(input)) return {};
    if (isUntimedBackgroundCall(input?.tool_input)) {
      const updatedInput = codex ? undefined : { ...input.tool_input, timeout: BACKGROUND_UNTIMED_TIMEOUT_MS };
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: BACKGROUND_NO_TIMEOUT_CONTEXT, ...(updatedInput && { updatedInput }) } };
    }
    const longTimeout = codex ? undefined : longForegroundTimeout(input?.tool_input);
    if (longTimeout !== undefined) {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: longForegroundContext(longTimeout) } };
    }
    return {};
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        codex
          ? 'Ntwine blocked an untracked shell background job (`&`). Shell job control can return without a Codex lifecycle handle, so Ntwine cannot report completion or wake this agent. For work that must continue while you do something else, remove `&` and use the managed unified exec pattern: start `tools.exec_command(...)`, call `yield_control()`, then await and fully drain that same process. A returned `session_id` alone is only foreground continuation. For bounded parallel work inside one shell call, finish with `wait` (after `kill`, if used) or own cleanup with an EXIT trap.'
          : 'Ntwine blocked an untracked shell background job (`&`). Shell job control can return from Bash without a Claude task ID, so Ntwine cannot report completion or wake this agent. For a long-running local command, remove `&` and call Bash with `run_in_background:true`. For bounded parallel work inside one Bash call, finish with `wait` (after `kill`, if used) or own cleanup with an EXIT trap.',
    },
  };
}

// Compared through `realpath` on BOTH sides. Node realpaths the main entry, so `import.meta.url` is
// the long, resolved spelling, while `argv[1]` is whatever CLAUDE_PLUGIN_ROOT spelled — an 8.3 short
// name (`C:\Users\RUNNER~1\…`, common when a profile or %LOCALAPPDATA% is one), a junction, or a
// symlink. A plain URL comparison then fails and the hook emits NOTHING, which Claude reads as
// "allowed": the guard silently switched off (Windows audit 2026-09-11, finding 15). The cheap URL
// equality is kept as the first test; realpath is the tie-breaker, and a path that cannot be
// realpath'd is not this file.
export function isDirectHookExecution(argv1, moduleUrl, realpath = realpathSync) {
  if (typeof argv1 !== 'string' || basename(argv1) !== 'bash-background.mjs') return false;
  if (pathToFileURL(argv1).href === moduleUrl) return true;
  try {
    return realpath(argv1) === realpath(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

// The server imports `hasEscapingBackgroundJob` and its production build bundles this module into
// `src/index.js`. esbuild rewrites `import.meta.url` to that bundle URL, so URL equality alone would
// mistake the whole server for this executable and block startup reading hook JSON from stdin.
if (isDirectHookExecution(process.argv[1], import.meta.url)) {
  /** @type {any} */
  let input;
  /** @type {Record<string, any>} */
  let result = {};
  try {
    const env = process.argv.includes('--ntwine-thread')
      ? { ...process.env, NTWINE_THREAD: process.env.NTWINE_THREAD || 'codex-worker' }
      : process.env;
    input = JSON.parse(readFileSync(0, 'utf8'));
    result = evaluateBashBackgroundHook(input, env);
  } catch {
    emit({});
  }
  // THE JOB GATE (cc-worker/job-gate/hook.ts) rides this hook rather than registering its own: Claude
  // Code keeps one `updatedInput` per call, so a second Bash hook would race this one's timeout patch.
  // It is a `.ts` module loaded on demand, and every way that can fail — a Node that cannot strip
  // types, a copy installed under node_modules (where Node refuses to), a throw inside the rewrite —
  // lands in the catch and emits this hook's own result unchanged. Never for a denied call, never for
  // Codex (`--ntwine-thread`: it has no `updatedInput`), never outside a Ntwine thread.
  if (
    result.hookSpecificOutput?.permissionDecision === 'deny' ||
    process.argv.includes('--ntwine-thread') ||
    !String(process.env.NTWINE_THREAD ?? '').trim()
  ) emit(result);
  import(new URL('../job-gate/hook.ts', import.meta.url).href)
    .then((gate) => {
      const command = gate.jobGateCommand(input);
      if (typeof command !== 'string') return emit(result);
      const out = result.hookSpecificOutput ?? { hookEventName: 'PreToolUse' };
      emit({ ...result, hookSpecificOutput: { ...out, updatedInput: { ...(out.updatedInput ?? input.tool_input), command } } });
    })
    .catch(() => emit(result));
}
