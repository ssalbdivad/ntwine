// @ts-check
// A SUB-AGENT'S TIME LIMIT (ntwine-worker) — ARCHITECTURE.md § Time limits. A library, not a hook:
// agent-dispatch.mjs carves the child's share when the Agent call is made, and agent-inbox.mjs, which
// already speaks to a running sub-agent after each of its tool calls, delivers its check-ins.
//
// HOW A CHILD IS BOUND TO ITS DEADLINE (measured on Claude Code 2.1.287, 2026-10-06). The dispatch hook
// runs before the child has an id, and nothing it can see links forward: SubagentStart carries only the
// new `agent_id` (no tool_use_id, no prompt), two children dispatched in one message start with
// overlapping hooks in no fixed order, and the child's `meta.json` is written only after SubagentStart
// returns. So the plan's FIFO fallback would have been a race. What IS reliable is the child's own
// transcript: by its first PostToolUse, `<sessionDir>/subagents/agent-<id>.jsonl` exists and its first
// record is the prompt AS REWRITTEN by the dispatch hook. So the deadline rides INSIDE the prompt, as a
// marker line, and the child's hook reads it back from its own first record. Nothing is keyed, so
// nothing can be claimed by the wrong child.
//
// A Workflow agent has no Agent call to rewrite: its transcript is under
// `subagents/workflows/<run>/agent-<id>.jsonl`, wrapped in the harness's "computed task" preamble with
// every line indented. So its hook computes the share itself, the first time it runs, from the agent's
// own `Time limit:` line, the thread's deadline and the agent's start (the record's timestamp).
//
// THE ARITHMETIC IS A TWIN of @ntwine/shared deadline.ts (`childDeadlineMs`, `deadlineStageAtMs`): this
// runs under bare node down to the engines floor (22.13), which does not strip types, so it cannot
// import the TS. agent-deadline-hook.test.ts pins the two together over a grid of inputs.
//
// Everything here fails soft — a deadline Ntwine cannot read is one it does not keep — and callers wrap
// it in their own fail-open.
import { mkdirSync, openSync, closeSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export const DEADLINE_MIN_MS = 60_000;
export const DEADLINE_FINAL_LEAD_MS = 5 * 60_000;
export const CHILD_RESERVE_FRACTION = 0.2;
export const CHILD_RESERVE_MIN_MS = 5 * 60_000;
export const STAGES = /** @type {const} */ (['half', 'converge', 'final', 'over']);
/** @typedef {typeof STAGES[number]} Stage */

/** The `Time limit:` line a parent writes into a child's prompt, on a line of its own. */
export const TIME_LIMIT_LINE = /^[ \t]*time limit:[ \t]*([^\n]+?)[ \t]*$/im;
/** The line the dispatch hook appends: the child's deadline and the instant its budget started. */
export const DEADLINE_MARKER = /⟦ntwine-deadline⟧ (\S+) (\S+)/g;

const FETCH_TIMEOUT_MS = 1500;
const STATE_DIRNAME = 'ntwine-deadlines';
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

// ---- THE ARITHMETIC (twin of @ntwine/shared deadline.ts) ---------------------------------------------

/** @param {Stage} stage @param {number} budgetMs */
function stageFraction(stage, budgetMs) {
  switch (stage) {
    case 'half': return 0.5;
    case 'converge': return 0.8;
    case 'final': return Math.min(0.95, Math.max(0.875, 1 - DEADLINE_FINAL_LEAD_MS / Math.max(1, budgetMs)));
    default: return 1;
  }
}

/** @param {number} setAtMs @param {number} deadlineMs @param {Stage} stage */
export function stageAtMs(setAtMs, deadlineMs, stage) {
  const budget = Math.max(0, deadlineMs - setAtMs);
  return stage === 'over' ? deadlineMs : Math.round(setAtMs + budget * stageFraction(stage, budget));
}

/** The latest stage due at `nowMs`, or undefined before half-time.
 *  @param {number} setAtMs @param {number} deadlineMs @param {number} nowMs @returns {Stage | undefined} */
export function stageDue(setAtMs, deadlineMs, nowMs) {
  /** @type {Stage | undefined} */
  let due;
  for (const stage of STAGES) if (nowMs >= stageAtMs(setAtMs, deadlineMs, stage)) due = stage;
  return due;
}

/** @param {{ nowMs: number, parentDeadlineMs?: number | null, declaredMs?: number | null }} input
 *  @returns {number | undefined} */
export function childDeadlineMs(input) {
  const { nowMs } = input;
  const declared = input.declaredMs != null && input.declaredMs > 0 ? nowMs + Math.max(DEADLINE_MIN_MS, input.declaredMs) : undefined;
  if (input.parentDeadlineMs == null) return declared;
  const remaining = input.parentDeadlineMs - nowMs;
  const reserve = Math.min(remaining / 2, Math.max(remaining * CHILD_RESERVE_FRACTION, CHILD_RESERVE_MIN_MS));
  const ceiling = Math.max(nowMs + DEADLINE_MIN_MS, Math.round(input.parentDeadlineMs - reserve));
  return declared === undefined ? ceiling : Math.min(declared, ceiling);
}

const SPAN_WHOLE = /^(?:\d{1,5}\s*(?:s|m|h|d)\s*){1,3}$/;
const SPAN_PART = /(\d{1,5})\s*(s|m|h|d)/g;
/** @type {Record<string, number>} */
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `20m`, `1h 30m`, `90s` → ms; anything else → undefined. @param {string} raw */
export function parseSpan(raw) {
  const text = raw.trim().toLowerCase();
  if (!SPAN_WHOLE.test(text)) return undefined;
  let ms = 0;
  for (const m of text.matchAll(SPAN_PART)) ms += Number(m[1]) * UNIT_MS[m[2]];
  return ms > 0 ? ms : undefined;
}

/** The house duration grammar, rounded up to the minute past one (shared `spanLabel`). @param {number} ms */
export function spanLabel(ms) {
  if (ms < 60_000) return `${Math.max(0, Math.ceil(ms / 1_000))}s`;
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** The worker's reading (shared `preciseSpanLabel`): exact and rounded down under ten minutes, where a
 *  rounded-up minute is a large share of what is left. @param {number} ms */
export function preciseSpanLabel(ms) {
  if (ms >= 10 * 60_000) return spanLabel(ms);
  const s = Math.max(0, Math.floor(ms / 1_000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** Local `15:30` — the clock the worker's own wake header and the human's transcript are on. @param {number} ms */
function clock(ms) {
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/** A budget to the nearest minute, as the thread's own section reads it. @param {number} ms */
function budget(ms) {
  return spanLabel(Math.max(60_000, Math.round(ms / 60_000) * 60_000));
}

// ---- AT DISPATCH ------------------------------------------------------------------------------------

/** The paragraph the dispatch hook adds above its epilogue. The marker on its last line is what the
 *  child's own hook reads back (see the header); the prose is what the child model reads.
 *  @param {number} atMs @param {number} setAtMs */
export function deadlineParagraph(atMs, setAtMs) {
  return (
    `\n\n[TIME LIMIT — set by your dispatcher, kept by Ntwine] Your deadline is ${clock(atMs)} (a ${budget(atMs - setAtMs)} budget). ` +
    `Your final message is due by then: return the best result you can by ${clock(atMs)}, not the complete one eventually. ` +
    'Ntwine checks in after your tool calls — at half-time, at 80%, just before the deadline and at it — in messages headed "⏰". ' +
    'They are your dispatcher\'s clock speaking, with the same authority as this task, not output of the tool you ran. Commit ' +
    'to an approach early, keep what you have in a state you could report, and when time runs short end your turn with what ' +
    'you have, saying what is unfinished.' +
    `\n⟦ntwine-deadline⟧ ${new Date(atMs).toISOString()} ${new Date(setAtMs).toISOString()}`
  );
}

/** Carve the child's share out of `prompt`: strip a `Time limit:` line it reads, compute the deadline,
 *  and add the paragraph. Unchanged when there is no deadline to give, or the prompt already carries one.
 *  @param {string} prompt @param {{ nowMs: number, parentDeadlineMs?: number | null }} at
 *  @returns {{ prompt: string, atMs?: number }} */
export function shareIntoPrompt(prompt, at) {
  if (new RegExp(DEADLINE_MARKER.source).test(prompt)) return { prompt };
  const line = TIME_LIMIT_LINE.exec(prompt);
  const declaredMs = line ? parseSpan(line[1]) : undefined;
  const atMs = childDeadlineMs({ nowMs: at.nowMs, parentDeadlineMs: at.parentDeadlineMs, declaredMs });
  if (atMs === undefined) return { prompt };
  // A line this reads is replaced by the paragraph, which states the clamped figure — leaving it would
  // hand the child two limits that disagree. One it cannot read stays, for the child to make sense of.
  const body = line && declaredMs !== undefined ? prompt.replace(new RegExp(TIME_LIMIT_LINE.source + '\\n?', 'im'), '').trimEnd() : prompt;
  return { prompt: body + deadlineParagraph(atMs, at.nowMs), atMs };
}

/** The thread's deadline in ms, read from the running server the way agent-address.mjs reaches it:
 *  NTWINE_PERM_DIR is `<ntwine root>/projects/<project id>/perm-requests`, and the root's `server.lock`
 *  names the port. Undefined for no deadline, and for anything that goes wrong.
 *  @param {NodeJS.ProcessEnv} env @returns {Promise<number | undefined>} */
export async function threadDeadlineMs(env = process.env) {
  try {
    const slug = (env.NTWINE_THREAD ?? '').trim();
    const permDir = (env.NTWINE_PERM_DIR ?? '').trim();
    if (!slug || !permDir) return undefined;
    const stateDir = dirname(permDir);
    const lock = JSON.parse(readFileSync(join(dirname(dirname(stateDir)), 'server.lock'), 'utf8'));
    if (!Number.isInteger(lock?.port)) return undefined;
    const query = encodeURIComponent(JSON.stringify({ slug }));
    const res = await fetch(`http://127.0.0.1:${lock.port}/_ntwine/${encodeURIComponent(basename(stateDir))}/rpc/threadDeadline?input=${query}`, {
      headers: { 'sec-fetch-site': 'same-origin' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const at = res.ok ? (await res.json())?.result?.deadline?.at : undefined;
    const ms = typeof at === 'string' ? Date.parse(at) : NaN;
    return Number.isFinite(ms) ? ms : undefined;
  } catch {
    return undefined;
  }
}

// ---- IN THE CHILD -------------------------------------------------------------------------------------

/** `setBy: 'user'` marks a limit the server wrote into a child already running, when the user set its
 *  thread's limit (packages/server/src/agent-inbox.ts `setChildDeadline`).
 *  @typedef {{ atMs: number, setAtMs: number, announce: boolean, setBy?: 'user' } | { none: true }} AgentDeadline */

/** The child's own transcript: a plain sub-agent's, else a Workflow agent's.
 *  @param {string} sessionDir @param {string} agentId */
function transcriptOf(sessionDir, agentId) {
  const plain = join(sessionDir, 'subagents', `agent-${agentId}.jsonl`);
  if (existsSync(plain)) return { path: plain, workflow: false };
  let runs = [];
  try {
    runs = readdirSync(join(sessionDir, 'subagents', 'workflows'));
  } catch {
    return undefined;
  }
  for (const run of runs) {
    const path = join(sessionDir, 'subagents', 'workflows', run, `agent-${agentId}.jsonl`);
    if (existsSync(path)) return { path, workflow: true };
  }
  return undefined;
}

/** The first record of a transcript: its text and when it was written. @param {string} path */
function firstRecord(path) {
  const raw = readFileSync(path, 'utf8');
  const line = raw.slice(0, raw.indexOf('\n') === -1 ? raw.length : raw.indexOf('\n'));
  const rec = JSON.parse(line);
  const content = rec?.message?.content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content) ? content.map((/** @type {any} */ c) => (typeof c?.text === 'string' ? c.text : '')).join('\n') : '';
  const atMs = Date.parse(rec?.timestamp ?? '');
  return { text, atMs: Number.isFinite(atMs) ? atMs : undefined };
}

/** What a child's deadline is, worked out once and kept in `<sessionDir>/ntwine-deadlines/<id>.json`.
 *  `announce` is true when its prompt did not already say (a Workflow agent): the first check-in
 *  then introduces the limit.
 *  @param {string} sessionDir @param {string} agentId @param {{ nowMs: number, threadDeadline: () => Promise<number | undefined> }} deps
 *  @returns {Promise<AgentDeadline | undefined>} */
export async function agentDeadline(sessionDir, agentId, deps) {
  if (!AGENT_ID.test(agentId)) return undefined;
  const file = join(sessionDir, STATE_DIRNAME, `${agentId}.json`);
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    /* not worked out yet */
  }
  const transcript = transcriptOf(sessionDir, agentId);
  if (!transcript) return undefined; // not written yet — the next tool call tries again
  const first = firstRecord(transcript.path);
  /** @type {AgentDeadline} */
  let found = { none: true };
  const marks = [...first.text.matchAll(DEADLINE_MARKER)];
  const mark = marks[marks.length - 1];
  if (mark && Number.isFinite(Date.parse(mark[1])) && Number.isFinite(Date.parse(mark[2]))) {
    found = { atMs: Date.parse(mark[1]), setAtMs: Date.parse(mark[2]), announce: false };
  } else if (transcript.workflow) {
    const line = TIME_LIMIT_LINE.exec(first.text);
    const declaredMs = line ? parseSpan(line[1]) : undefined;
    const startMs = first.atMs ?? deps.nowMs;
    const atMs = childDeadlineMs({ nowMs: startMs, parentDeadlineMs: await deps.threadDeadline(), declaredMs });
    if (atMs !== undefined) found = { atMs, setAtMs: startMs, announce: true };
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(found));
  return found;
}

/** Claim a stage for this child: true exactly once, across parallel tool calls (an exclusive create),
 *  and false once any later stage was sent. @param {string} sessionDir @param {string} agentId @param {Stage} stage */
function claimStage(sessionDir, agentId, stage) {
  const dir = join(sessionDir, STATE_DIRNAME);
  for (const later of STAGES.slice(STAGES.indexOf(stage))) if (existsSync(join(dir, `${agentId}.${later}`))) return false;
  try {
    closeSync(openSync(join(dir, `${agentId}.${stage}`), 'wx'));
    return true;
  } catch {
    return false;
  }
}

/** @param {Stage} stage @param {number} atMs @param {number} nowMs */
export function childCheckIn(stage, atMs, nowMs) {
  const left = preciseSpanLabel(Math.max(0, atMs - nowMs));
  switch (stage) {
    case 'half':
      return `⏰ Time check: half your time is gone — ${left} left until your deadline at ${clock(atMs)}. This is not a signal to ` +
        'stop: the other half is yours, so keep working. If you are still exploring, commit now to the approach you can finish ' +
        'and report by then.';
    case 'converge':
      return `⏰ Time check: ${left} left until your deadline at ${clock(atMs)}. Start nothing new: finish what is open and get your ` +
        'final message ready — what you found, what is done, what is not.';
    case 'final':
      return `⏰ Time check: ${left} left until your deadline at ${clock(atMs)}. Return at your next stop: do not start another ` +
        'step, end your turn with your final message — what is done, what is not, and what you would do next.';
    default:
      return `⏰ Your time is up: your deadline was ${clock(atMs)}. End your turn now with your final message — what you have, and ` +
        'what is unfinished. Your dispatcher is waiting on it.';
  }
}

/** What a child should be told after this tool call, or undefined: the introduction for a Workflow
 *  agent the first time, then the latest stage due and not yet sent.
 *  @param {string} sessionDir @param {string} agentId @param {{ nowMs: number, threadDeadline: () => Promise<number | undefined> }} deps */
export async function childDeadlineContext(sessionDir, agentId, deps) {
  const d = await agentDeadline(sessionDir, agentId, deps);
  if (!d || 'none' in d) return undefined;
  const out = [];
  if (d.announce) {
    const intro = join(sessionDir, STATE_DIRNAME, `${agentId}.intro`);
    try {
      closeSync(openSync(intro, 'wx'));
      out.push(
        `⏰ Your time limit: ${clock(d.atMs)} (a ${budget(d.atMs - d.setAtMs)} budget, set by ${d.setBy === 'user' ? 'the user operating Ntwine, after you started' : 'the agent that dispatched you'}). Your ` +
        'final message is due by then: return the best result you can by that time, not the complete one eventually. Ntwine ' +
        'checks in after your tool calls at half-time, at 80%, just before the deadline and at it.',
      );
    } catch {
      /* already introduced */
    }
  }
  const due = stageDue(d.setAtMs, d.atMs, deps.nowMs);
  if (due && claimStage(sessionDir, agentId, due)) out.push(childCheckIn(due, d.atMs, deps.nowMs));
  return out.length ? out.join('\n\n') : undefined;
}
