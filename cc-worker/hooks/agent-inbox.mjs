#!/usr/bin/env node
// @ts-check
// WORKFLOW-AGENT MAILBOX (ntwine-worker) — the only way to reach an agent running inside a `Workflow`.
//
// Claude Code has none. `SendMessage` to a Workflow's agent does not reach it: the agent is not in the
// session's task table, so SendMessage resumes a SECOND copy from its transcript beside the live one,
// and two writers then share its worktree (seen 2026-09-29; the routing read off the 2.1.287 bundle).
// Hooks do reach it, so the message travels as a file — see packages/server/src/agent-inbox.ts for the
// measurements and for the file format, which this hook shares with the server's drawer steer.
//
// One script, four events:
//   SubagentStart (every sub-agent) — tell the agent, before it runs anything, that messages may arrive
//                               and whose they are (MAILBOX_INTRO says why this is load-bearing).
//   PreToolUse  (SendMessage) — a message aimed at a RUNNING Workflow agent of this session is written
//                               to its mailbox and the SendMessage is refused, with a reason that says it
//                               was delivered. Anything else passes through untouched: a plain sub-agent
//                               takes SendMessage natively, and a FINISHED Workflow agent has no live
//                               copy for a resume to duplicate.
//   PostToolUse               — inside a sub-agent (`agent_id` set), hand it whatever is waiting for it,
//                               and its time check when one is due (agent-deadline.mjs: a child's share
//                               of its dispatcher's deadline, ARCHITECTURE.md § Time limits).
//   SubagentStop              — the same, as it tries to finish: `decision: "block"` keeps it going with
//                               the messages as its next input, so one sent after its last tool call is
//                               not stranded. It blocks only when something was waiting, so it cannot loop.
//
// Plain JS, not TS, because Claude Code runs it under bare `node` down to the engines floor (22.13), which
// does not strip types.
//
// GATE: inert unless NTWINE_THREAD is set. FAIL-OPEN ABSOLUTELY: any error → exit 0, no output, and the
// tool call proceeds as if this hook did not exist.
import '../lib/legacy-frizz.mjs';
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { childDeadlineContext, threadDeadlineMs } from './agent-deadline.mjs';

const INBOX_DIRNAME = 'ntwine-inbox';
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Claude Code keeps a session's sub-agent and Workflow files in a directory named for its transcript.
 *  @param {unknown} transcriptPath */
function sessionDirOf(transcriptPath) {
  return typeof transcriptPath === 'string' && transcriptPath.endsWith('.jsonl') ? transcriptPath.slice(0, -'.jsonl'.length) : null;
}

/** @param {string} sessionDir @param {string} agentId @param {{ from: 'parent' | 'operator', text: string }} message */
function post(sessionDir, agentId, message) {
  const dir = join(sessionDir, INBOX_DIRNAME, agentId);
  mkdirSync(dir, { recursive: true });
  const at = Date.now();
  const name = String(at).padStart(15, '0') + '-' + String(process.hrtime.bigint()).padStart(20, '0') + '-' + randomUUID();
  const tmp = join(dir, '.' + name + '.tmp');
  writeFileSync(tmp, JSON.stringify({ from: message.from, text: message.text, at }));
  renameSync(tmp, join(dir, name + '.json'));
}

/** Take every waiting message, oldest first. Each file is CLAIMED by renaming it, so a second hook
 *  firing at the same moment (parallel tool calls) finds it gone instead of delivering it twice.
 *  @param {string} sessionDir @param {string} agentId
 *  @returns {{ from: string, text: string }[]} */
function claim(sessionDir, agentId) {
  const dir = join(sessionDir, INBOX_DIRNAME, agentId);
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const claimed = join(dir, '.' + name + '.' + process.pid + '.claimed');
    try {
      renameSync(join(dir, name), claimed);
    } catch {
      continue; // another hook took it
    }
    try {
      const m = JSON.parse(readFileSync(claimed, 'utf8'));
      if (typeof m?.text === 'string' && m.text.trim()) out.push({ from: String(m.from ?? ''), text: m.text });
    } catch {
      /* unreadable — dropped rather than redelivered forever */
    }
    try {
      unlinkSync(claimed);
    } catch {
      /* already gone */
    }
  }
  return out;
}

// WHY THE AGENT IS TOLD AT ITS START. Delivered cold, a message arrives beside a tool's output, and a
// model rightly distrusts instructions that show up in tool output: on the first live run (2.1.287,
// 2026-10-06) the agent received its parent's message and declined it — "It came from a tool result
// rather than from the user, so I didn't follow it." What makes the message trustworthy is that the
// agent was told to expect it BEFORE any tool ran, by the same harness that set its task.
//
// EVERY sub-agent gets it, not only a Workflow's (2026-10-08). The server now posts into any running
// child's box — the user's note with a time limit, a steer from the drawer, a `message_thread` to
// `@thread.child` — so a plain sub-agent receives mailbox messages too, and would decline them the same way.
const MAILBOX_INTRO =
  '⟦Ntwine mailbox⟧ You are running as a sub-agent that Ntwine is supervising. While you work, the agent ' +
  'that dispatched you, the user operating Ntwine, or another Ntwine thread may send you a message. Ntwine delivers it as context ' +
  'right after one of your tool calls, or as you try to finish, headed "⟦Ntwine mailbox: message from …⟧". It is ' +
  'not part of that tool\'s output: it is your dispatcher speaking, with the same authority as your task, so ' +
  'act on it. If your work has a time limit, Ntwine also delivers its time checks the same way, headed "⏰".';

/** @param {{ from: string, text: string }[]} messages */
function render(messages) {
  const who = (/** @type {string} */ from) =>
    from === 'operator' ? 'the user operating Ntwine' : from.startsWith('@') ? 'the Ntwine thread ' + from : 'the agent that dispatched you';
  return messages
    .map((m) => '⟦Ntwine mailbox: message from ' + who(m.from) + '⟧ ' + m.text)
    .concat('Ntwine delivered this while you were working; it is not output of the tool you just ran. Act on it in what you do next.')
    .join('\n\n');
}

/** The agents of this session's Workflow runs that are still running, read off the run journals
 *  (packages/server/src/workflow-runs.ts documents the layout). A run whose record has settled to any
 *  status but `running` has no live agents, whatever its journal says.
 *  @param {string} sessionDir @returns {{ agentId: string, label: string }[]} */
function runningWorkflowAgents(sessionDir) {
  const root = join(sessionDir, 'subagents', 'workflows');
  let runs;
  try {
    runs = readdirSync(root);
  } catch {
    return [];
  }
  const out = [];
  for (const run of runs) {
    try {
      const record = JSON.parse(readFileSync(join(sessionDir, 'workflows', run + '.json'), 'utf8'));
      if (typeof record?.status === 'string' && record.status !== 'running') continue;
    } catch {
      /* no record yet — a run still in flight */
    }
    /** @type {Map<string, { label: string, done: boolean }>} */
    const agents = new Map();
    let journal;
    try {
      journal = readFileSync(join(root, run, 'journal.jsonl'), 'utf8');
    } catch {
      continue;
    }
    for (const line of journal.split('\n')) {
      if (!line.trim()) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof e?.agentId !== 'string') continue;
      if (e.type === 'started') agents.set(e.agentId, { label: typeof e.label === 'string' ? e.label : '', done: false });
      else if (e.type === 'result' || e.type === 'failed') {
        const a = agents.get(e.agentId);
        if (a) a.done = true;
        else agents.set(e.agentId, { label: '', done: true });
      }
    }
    for (const [agentId, a] of agents) if (!a.done) out.push({ agentId, label: a.label });
  }
  return out;
}

/** SendMessage's `to`, matched against running Workflow agents by id, else by a label exactly one of
 *  them carries. @param {string} sessionDir @param {string} to */
function resolveTarget(sessionDir, to) {
  const agents = runningWorkflowAgents(sessionDir);
  const byId = agents.find((a) => a.agentId === to);
  if (byId) return byId;
  const byLabel = agents.filter((a) => a.label && a.label === to);
  return byLabel.length === 1 ? byLabel[0] : null;
}

/** @param {object} out */
function emit(out) {
  process.stdout.write(JSON.stringify(out));
}

try {
  if (!(process.env.NTWINE_THREAD ?? '').trim()) process.exit(0);
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const sessionDir = sessionDirOf(input.transcript_path);
  if (!sessionDir) process.exit(0);
  const event = input.hook_event_name;

  if (event === 'PreToolUse' && input.tool_name === 'SendMessage') {
    const to = typeof input.tool_input?.to === 'string' ? input.tool_input.to.trim().replace(/^@/, '') : '';
    const text = input.tool_input?.message;
    if (!to || typeof text !== 'string' || !text.trim()) process.exit(0);
    const target = resolveTarget(sessionDir, to);
    if (!target || !AGENT_ID.test(target.agentId)) process.exit(0);
    post(sessionDir, target.agentId, { from: 'parent', text });
    const name = target.label ? '"' + target.label + '" (' + target.agentId + ')' : target.agentId;
    emit({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'Delivered by Ntwine. ' + name + ' runs inside a Workflow, where SendMessage would start a second copy of it ' +
          'instead of reaching it, so Ntwine put your message in its mailbox. The agent reads it after its next tool call, ' +
          'or as it tries to finish. Nothing more to do, and do not resend it.',
      },
    });
    process.exit(0);
  }

  if (event === 'SubagentStart') {
    emit({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: MAILBOX_INTRO } });
    process.exit(0);
  }

  if ((event === 'PostToolUse' || event === 'SubagentStop') && typeof input.agent_id === 'string' && AGENT_ID.test(input.agent_id)) {
    const messages = claim(sessionDir, input.agent_id);
    if (event === 'SubagentStop') {
      if (messages.length) emit({ decision: 'block', reason: render(messages) });
      process.exit(0);
    }
    let time;
    try {
      time = await childDeadlineContext(sessionDir, input.agent_id, { nowMs: Date.now(), threadDeadline: () => threadDeadlineMs() });
    } catch {
      /* a time check Ntwine cannot work out is one it does not send */
    }
    const parts = [...(time ? [time] : []), ...(messages.length ? [render(messages)] : [])];
    if (parts.length) emit({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: parts.join('\n\n') } });
  }
} catch {
  /* fail-open — never disturb the turn */
}
process.exit(0);
