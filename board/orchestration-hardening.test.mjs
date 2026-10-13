// @ts-check
/**
 * ntwine — orchestration-hardening tests (2026-07-06). Run: `node --test 'board/*.test.mjs'`.
 *
 * Covers the anti-treadmill / anti-drop PREDICATES the board exports. (The orchestrator hooks that
 * consumed them — ntwine-stop-reminder, ntwine-subagent-rest — retired with the plugin; only the pure
 * functions survive, so only those are tested here.)
 *   #1 OWNER-CLEAN — an owning-agent thread edit is owner-clean, NOT drift (ownerCleanMtime /
 *      assessDrift / computeBoardDrift).
 *   #2 SCOPED STALENESS — reconcileStampLastInstruction names the drifted thread(s).
 *   #3 STRUCTURED queued detection — only an UNCHECKED `- [ ]` follow-up flags (hasQueuedFollowup).
 *   #4 DEBOUNCE — a `dirty` nag holds until it persists > T min AND > K turns (debounceReconcileNag).
 *   #5 WATCHER/AGENT DROP-GUARD — a long-running still-alive agent with no terminal result gets a
 *      LOUD "VERIFY DIRECTLY" line (longRunningAgentLines).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ownerCleanMtime,
  assessDrift,
  computeBoardDrift,
  hasQueuedFollowup,
  debounceReconcileNag,
  reconcileStampLastInstruction,
  DEFAULT_RECONCILE_DEBOUNCE_MIN,
  DEFAULT_RECONCILE_DEBOUNCE_TURNS,
} from './config.mjs';
import { longRunningAgentLines } from './agent-liveness.mjs';
import { DEFAULT_LONG_RUNTIME_MIN, DEFAULT_DROPPED_MIN } from './agent-status.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKSTOP = 120;

/** A throwaway ACTIVATED `.ntwine/` project (session sentinel ON). */

// ── #1 owner-clean predicate + owner-filtered drift ─────────────────────────────────
test('ownerCleanMtime: a mark ≥ current mtime is clean; no mark / stale mark is not', () => {
  assert.equal(ownerCleanMtime(1000, 1000), true, 'exactly at the mark → owning-agent edit → clean');
  assert.equal(ownerCleanMtime(999, 1000), true, 'below the mark → clean');
  assert.equal(ownerCleanMtime(1001, 1000), false, 'edited AFTER the owner mark → non-owning drift');
  assert.equal(ownerCleanMtime(1000, undefined), false, 'no mark → not clean (never suppress an unmarked thread)');
  assert.equal(ownerCleanMtime(0, 1000), false, 'unreadable mtime (0) → not clean');
});

test('assessDrift: an owning-agent edit is excluded; a non-owning edit is dirty + named', () => {
  const last = 1_000_000;
  const records = [
    { slug: 'owned', status: 'active', mtimeMs: last + 5000 }, // edited after reconcile, BUT owner-clean
    { slug: 'drifted', status: 'active', mtimeMs: last + 9000 }, // edited after reconcile, no owner mark
    { slug: 'done-x', status: 'done', mtimeMs: last + 9999 }, // terminal → never counts
  ];
  const owner = { owned: last + 5000 };
  const d = assessDrift({ records, ownerReconciled: owner, lastReconcileMs: last, backstopMin: BACKSTOP, now: last + 10_000 });
  assert.equal(d.nag, true, 'the non-owning edit trips the dirty-gate');
  assert.equal(d.reason, 'dirty');
  assert.deepEqual(d.dirtySlugs, ['drifted'], 'ONLY the non-owning thread is named — the write-ownership edit is excluded');
});

test('assessDrift: a board whose only change is owning-agent edits is CLEAN (no treadmill)', () => {
  const last = 1_000_000;
  const records = [{ slug: 'owned', status: 'active', mtimeMs: last + 5000 }];
  const d = assessDrift({ records, ownerReconciled: { owned: last + 5000 }, lastReconcileMs: last, backstopMin: BACKSTOP, now: last + 6000 });
  assert.equal(d.nag, false, 'an agent editing its OWN thread does not nag a board re-ground');
  assert.deepEqual(d.dirtySlugs, []);
});

// ── #1 write side: the SubagentStop hook stamps owner-reconciled ─────────────────────

// ── #3 scoped staleness instruction ─────────────────────────────────────────────────
test('reconcileStampLastInstruction: scoped names the threads; unscoped says every non-terminal', () => {
  const scoped = reconcileStampLastInstruction(['alpha', 'beta']);
  assert.match(scoped, /re-ground alpha, beta/, 'the specific drifted threads are named');
  assert.doesNotMatch(scoped, /re-ground EVERY non-terminal/, 'scoped does NOT say "every non-terminal thread"');
  assert.match(reconcileStampLastInstruction(), /re-ground EVERY non-terminal thread/, 'unscoped = full sweep (backstop/first case)');
  assert.match(reconcileStampLastInstruction([]), /re-ground EVERY non-terminal thread/, 'empty scope = full sweep');
});

// ── #4 structured queued-followup detection ─────────────────────────────────────────
test('hasQueuedFollowup: only an UNCHECKED `- [ ]` follow-up flags; checked / prose never do', () => {
  assert.equal(hasQueuedFollowup('- [ ] QUEUED: dispatch review on AG1 return'), true, 'unchecked QUEUED item flags');
  assert.equal(hasQueuedFollowup('- [ ] dispatch the self-review on its return'), true, 'unchecked "dispatch … return" flags');
  assert.equal(hasQueuedFollowup('- [x] QUEUED: dispatch review on AG1 return'), false, 'a CHECKED-OFF item never flags (the false-positive killed)');
  assert.equal(hasQueuedFollowup('We already QUEUED and drained the follow-up.'), false, 'a prose mention of QUEUED never flags');
  assert.equal(hasQueuedFollowup('- [ ] land the PR'), false, 'an unchecked item without the follow-up shape does not flag');
  assert.equal(hasQueuedFollowup('title: t\nstatus: active\n'), false, 'no checkbox → no flag');
});

// ── #5 debounce ─────────────────────────────────────────────────────────────────────
test('debounceReconcileNag: dirty holds for T min AND K turns; first/backstop nag at once; clean resets', () => {
  const min = DEFAULT_RECONCILE_DEBOUNCE_MIN, turns = DEFAULT_RECONCILE_DEBOUNCE_TURNS, now = 5_000_000;
  // clean → no nag, window cleared
  assert.deepEqual(debounceReconcileNag({ reason: null, now, turns: 9, state: { dirty_since_ms: 1, dirty_since_turn: 1 }, debounceMin: min, debounceTurns: turns }), { nag: false, state: {} });
  // first + backstop → immediate, no window
  assert.equal(debounceReconcileNag({ reason: 'first', now, turns: 1, state: {}, debounceMin: min, debounceTurns: turns }).nag, true);
  assert.equal(debounceReconcileNag({ reason: 'backstop', now, turns: 1, state: {}, debounceMin: min, debounceTurns: turns }).nag, true);
  // dirty, first sighting → silent, starts the window
  const first = debounceReconcileNag({ reason: 'dirty', now, turns: 3, state: {}, debounceMin: min, debounceTurns: turns });
  assert.equal(first.nag, false, 'dirty first-sight is debounced');
  assert.deepEqual(first.state, { dirty_since_ms: now, dirty_since_turn: 3 });
  // dirty, aged in turns but NOT in time → still silent (AND, not OR)
  assert.equal(debounceReconcileNag({ reason: 'dirty', now: now + 60_000, turns: 3 + turns, state: first.state, debounceMin: min, debounceTurns: turns }).nag, false, 'enough turns but < T minutes → still held');
  // dirty, aged in time but NOT in turns → still silent
  assert.equal(debounceReconcileNag({ reason: 'dirty', now: now + (min + 1) * 60_000, turns: 3 + 1, state: first.state, debounceMin: min, debounceTurns: turns }).nag, false, 'enough time but < K turns → still held');
  // dirty, aged past BOTH → nag
  assert.equal(debounceReconcileNag({ reason: 'dirty', now: now + (min + 1) * 60_000, turns: 3 + turns, state: first.state, debounceMin: min, debounceTurns: turns }).nag, true, 'past both thresholds → fires');
});

// ── #2 self-satisfying stop + genuine-drift block ───────────────────────────────────
/** Run the Stop hook; return `{ blocked, ctx }` (ctx = additionalContext when it blocked). */

// ── #6 watcher/agent drop-guard ─────────────────────────────────────────────────────
/**
 * Fixture for a long-running-but-still-alive agent: an active thread, a binding dispatched
 * `runtimeMin` ago, and a fresh `.output` (age `outputAgeMin`) under a /private/tmp/claude-* tasks
 * dir reachable from `transcriptPath`. Mirrors liveness.test.mjs's fixture, parametrizing the
 * dispatch time (runtime) which is what the drop-guard keys on.
 */
let fixtureSeq = 0;
function longRunningFixture({ runtimeMin, outputAgeMin, status = 'active' }) {
  // UNIQUE per fixture: `agentAge`'s fallback globs ALL /private/tmp/claude-* task dirs, so two
  // concurrent fixtures sharing an agentId/proj/session would cross-read each other's output.
  const uid = `${process.pid}-${fixtureSeq++}`;
  const agentId = `WATCH_${uid}`;
  const dir = mkdtempSync(join(tmpdir(), 'ntwine-dropguard-'));
  mkdirSync(join(dir, '.ntwine'), { recursive: true });
  writeFileSync(join(dir, '.ntwine', 'watch.md'), `---\ntitle: w\nstatus: ${status}\n---\nbody\n`);
  const now = Date.now();
  const dispatchedIso = new Date(now - runtimeMin * 60_000).toISOString();
  writeFileSync(join(dir, '.ntwine', '.agent-bindings.jsonl'),
    JSON.stringify({ ts: dispatchedIso, agent_id: agentId, thread: 'watch', label: 'ci-watch' }) + '\n');

  const projSlug = `proj-${uid}`, session = `sess-${uid}`;
  // deriveTasksDir globs exactly ['/tmp','/private/tmp'], so the fixture MUST live under one of
  // them — os.tmpdir() would not be found. macOS has both (/tmp -> /private/tmp); Linux only /tmp.
  const claudeRoot = mkdtempSync(join(existsSync('/private/tmp') ? '/private/tmp' : '/tmp', 'claude-ntwinetest-'));
  const tasksDir = join(claudeRoot, projSlug, session, 'tasks');
  mkdirSync(tasksDir, { recursive: true });
  const p = join(tasksDir, `${agentId}.output`);
  writeFileSync(p, 'x');
  if (outputAgeMin != null) {
    const t = (now - outputAgeMin * 60_000) / 1000;
    utimesSync(p, t, t);
  }
  const transcriptPath = join('/anything', projSlug, `${session}.jsonl`);
  return { dir, sess: session, transcriptPath, agentId, outputPath: p, cleanup: () => { rmSync(dir, { recursive: true, force: true }); rmSync(claudeRoot, { recursive: true, force: true }); } };
}

/** Rewrite a fixture's binding so its agent's RUNTIME (now − dispatch ts) is `runtimeMin`, and
 *  re-touch its output to `outputAgeMin` (keeps it fresh) — to simulate an idle-wait watcher aging
 *  past a new drop-guard tier without re-creating the whole fixture (state persists across runs). */
function ageFixture(fx, runtimeMin, outputAgeMin) {
  const now = Date.now();
  writeFileSync(join(fx.dir, '.ntwine', '.agent-bindings.jsonl'),
    JSON.stringify({ ts: new Date(now - runtimeMin * 60_000).toISOString(), agent_id: fx.agentId, thread: 'watch', label: 'ci-watch' }) + '\n');
  const t = (now - outputAgeMin * 60_000) / 1000;
  utimesSync(fx.outputPath, t, t);
}

test('longRunningAgentLines: a long-running STILL-ALIVE agent gets a loud VERIFY DIRECTLY line', () => {
  const fx = longRunningFixture({ runtimeMin: DEFAULT_LONG_RUNTIME_MIN + 10, outputAgeMin: 5 });
  try {
    const lines = longRunningAgentLines({ transcriptPath: fx.transcriptPath, projectDir: fx.dir });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].slug, 'watch');
    assert.equal(lines[0].agentId, fx.agentId);
    assert.match(lines[0].line, /VERIFY DIRECTLY — watch/);
    assert.match(lines[0].line, /can HANG on a stuck\/ghost CI check/);
  } finally {
    fx.cleanup();
  }
});

test('longRunningAgentLines: a SHORT-runtime agent, and a long-runtime-but-STALE one, are NOT flagged', () => {
  const fresh = longRunningFixture({ runtimeMin: 10, outputAgeMin: 2 }); // under the runtime threshold
  const stale = longRunningFixture({ runtimeMin: DEFAULT_LONG_RUNTIME_MIN + 30, outputAgeMin: DEFAULT_DROPPED_MIN + 5 }); // stale = the 'dropped' case, not this one
  try {
    assert.equal(longRunningAgentLines({ transcriptPath: fresh.transcriptPath, projectDir: fresh.dir }).length, 0, 'short runtime → no verify flag');
    assert.equal(longRunningAgentLines({ transcriptPath: stale.transcriptPath, projectDir: stale.dir }).length, 0, 'long but STALE is the dropped signal, not the drop-guard (no double-nag)');
  } finally {
    fresh.cleanup();
    stale.cleanup();
  }
});

