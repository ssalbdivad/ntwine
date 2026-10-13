// @ts-check
/**
 * THIN SHIM — do NOT fork config logic. cc-worker shares the repo board's single source of truth
 * for the activation gate, config schema, status vocab, and the per-session sentinel/heartbeat
 * helpers. This re-exports `board/config.mjs` verbatim so cc-worker hooks can `import ... from
 * '../scripts/ntwine/config.mjs'` at the plugin-local path while the real code lives in ONE place.
 *
 * Coupling note: cc-worker assumes `board/` is a SIBLING dir (`../../board/` from the plugin root) —
 * the same assumption ntwine's server makes (see ARCHITECTURE.md: it imports the board logic from
 * `../../board/*.mjs`). If that layout changes, this one path changes with it.
 */
export * from '../../../board/config.mjs';
