// LEGACY — EVERYTHING THE SERVER STILL KNOWS ABOUT THE OLD NAME, beside the shared package's own
// (@ntwine/shared/legacy-frizz, which also says why any of it is still here). Each constant names what a
// process started before the rename still does. REMOVE this file, with the shared one, by the runbook
// those headers point at, once no such process is alive.

/**
 * The control key every ACP and Codex daemon spawned before a9ba766e (2026-10-13 18:09 EDT; on `main` from
 * 18:33) writes, and the only one such a daemon reads. Daemons outlive a server restart, so a current host
 * still recognises an older daemon's hello and answers it in its own key. This one's gate is the daemons'
 * start time, not their environment: one started between the rename and that commit carries NTWINE_*.
 */
export const LEGACY_DAEMON_CONTROL_KEY = "frizz"

/**
 * A project's board under its old name: the link the one-time move left beside `.ntwine` (and, before
 * that move, the board itself). The dev watcher must not follow it into a second copy of `.ntwine`.
 */
export const LEGACY_BOARD_LINK = ".frizz"
