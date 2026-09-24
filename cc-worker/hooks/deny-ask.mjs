#!/usr/bin/env node
// @ts-check
// PreToolUse hook on AskUserQuestion (frizz-worker). A frizz worker runs under a dashboard, not a
// live chat: an interactive question prompt would hang the session invisibly (nobody is at the
// keyboard to click it). Deny with a redirect to the async pattern: register the question with
// `mcp__frizz__ask` (a row; the free-form ```question fence was retired 2026-09-11), keep working, and
// rest normally; the answer arrives as its own wake.
// GATE: inert unless FRIZZ_THREAD is set. FAIL OPEN on parse errors.
//
// SECOND GATE: also inert when FRIZZ_NATIVE_ASK=1. The premise above — "nobody is at the keyboard" —
// is only true where the question has nowhere to go. On the Claude session-broker path frizz now
// intercepts the call at canUseTool and renders it as a real question card on the dashboard, which the
// operator answers and which returns the chosen labels to the tool. The broker bridge sets that var
// only when an InteractionStore is actually wired to render and resolve the card, so a denial here
// would block a question the operator CAN see. Any other path leaves the var unset, so it keeps the
// deny plus the `mcp__frizz__ask` redirect.
import { readFileSync } from 'node:fs';

const slug = process.env.FRIZZ_THREAD;
if (!slug) process.exit(0);
if (process.env.FRIZZ_NATIVE_ASK === '1') process.exit(0);

try {
  JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0); // fail open — a broken hook must never halt work
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'Interactive prompts freeze headless workers (no one is at the keyboard to answer). Register the question with `mcp__frizz__ask` instead — several in one call, each self-contained (context + the specific question + options with a one-line trade-off each, the recommended one first), written actor-explicit — never "I" or "you", which flip meaning when the human clicks an option; the frizz Queue renders each as a card. Do NOT write it as a ```question fence: that fence is retired, and a question in a fence body is plain prose nobody can answer. Finish what does not depend on the answer FIRST, then register, then rest right away — the card reaches the queue only once you rest: an open registered question IS the handback (no done/awaiting fence beside it, and do NOT invoke this tool again). The answer arrives as your next user message.',
    },
  }),
);
process.exit(0);
