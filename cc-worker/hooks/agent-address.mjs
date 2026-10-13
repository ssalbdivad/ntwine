#!/usr/bin/env node
// @ts-check
// PostToolUse hook on the `Agent` tool (ntwine-worker) — TELL THE WORKER ITS NEW SUB-AGENT'S ADDRESS.
//
// Every sub-agent answers to an address under its thread, `@portTheParser.spelling` (the server's shared
// thread-handle.ts), and the board turns that address into a link that opens the child — in the worker's
// handoff, on its card, anywhere its prose renders. The maintainer asked that agents refer to each other
// "by the fully qualified name so you can easily click to view that agent", never as "another agent".
// The worker prompt says so, and on the first real run the worker still wrote **Spelling** and
// **Version** in its handoff: it had never seen its own thread's handle, and a rule it would have to call
// a tool to apply is one it skips. So the address arrives HERE, as context, the moment the child starts —
// exact, and already in the conversation when the handoff is written.
//
// The server computes it (`subAgentAddressFor`), so the naming rule has one implementation. Found the
// way the ntwine MCP server finds it (cc-worker/bin/ntwine-mcp.mjs serverLockPort), from what a worker's
// own env carries: NTWINE_PERM_DIR is `<ntwine root>/projects/<project id>/perm-requests`, and the root's
// `server.lock` names the running server.
//
// Only the THREAD's own dispatches: a hook firing inside a sub-agent carries `agent_id`, and that child's
// children sit one segment further down an address this hook does not know.
//
// GATE: inert unless NTWINE_THREAD is set. FAIL-OPEN ABSOLUTELY: any error, a slow server, a missing lock
// → exit 0 with no output. A missed hint costs one link; a PostToolUse hook must never disturb the turn.
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const TIMEOUT_MS = 1500;

try {
  const slug = (process.env.NTWINE_THREAD ?? '').trim();
  if (!slug) process.exit(0);
  const input = JSON.parse(readFileSync(0, 'utf8'));
  if (input.agent_id) process.exit(0);
  const label = typeof input.tool_input?.description === 'string' ? input.tool_input.description.trim() : '';
  const permDir = (process.env.NTWINE_PERM_DIR ?? '').trim();
  if (!label || !permDir) process.exit(0);
  const stateDir = dirname(permDir);
  const lock = JSON.parse(readFileSync(join(dirname(dirname(stateDir)), 'server.lock'), 'utf8'));
  if (!Number.isInteger(lock?.port)) process.exit(0);
  const query = encodeURIComponent(JSON.stringify({ slug, label }));
  const res = await fetch(`http://127.0.0.1:${lock.port}/_ntwine/${encodeURIComponent(basename(stateDir))}/rpc/subAgentAddressFor?input=${query}`, {
    headers: { 'sec-fetch-site': 'same-origin' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const address = res.ok ? (await res.json())?.result?.address : undefined;
  if (typeof address === 'string' && address) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          `This sub-agent is @${address}. Wherever the user will read about it — your handoff above all — ` +
          `name it exactly that way, never as "a sub-agent", "the helper" or its description in bold: the ` +
          `board turns the address into a link that opens it.`,
      },
    }));
  }
} catch {
  /* fail-open — never disturb the turn */
}
process.exit(0);
