// @ts-check
/**
 * THIN SHIM — re-exports `board/agent-bindings.mjs` so the worker's PostToolUse
 * `agent-bind` hook writes `.ntwine/.agent-bindings.jsonl` records in the EXACT format the board
 * (`bindingsByThread`) + Stop-hook liveness consume. Keeping the writer shared is what lets a
 * worker's own THREAD-tagged sub-agent show up on the ntwine board's per-thread liveness.
 * Never fork this — the record shape is a cross-plugin contract.
 */
export * from '../../../board/agent-bindings.mjs';
