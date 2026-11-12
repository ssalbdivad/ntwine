# Sourced by post-commit and post-merge (git runs only files named after a hook, so this one never runs
# on its own). Starts src/autosync.ts in the BACKGROUND when a commit lands on main in a clone that opted
# in (`pnpm run autosync:on`), and returns at once: a sync must never slow down or fail the commit that
# triggered it. Everything it does goes to .git/ntwine-sync.log.
#
# The cheap checks run here in shell, so a clone that has not opted in pays no node start per commit.
# src/autosync.ts re-checks all of them (and that origin is ssalbdivad/ntwine) before it touches anything.

# The merge a sync makes fires post-merge; that sync is already running.
[ "${NTWINE_AUTOSYNC_RUNNING:-}" = 1 ] && exit 0
[ "${NTWINE_AUTOSYNC:-}" = 0 ] && exit 0
[ "$(git config --bool ntwine.autosync 2>/dev/null)" = true ] || exit 0
[ "$(git symbolic-ref --quiet --short HEAD 2>/dev/null)" = main ] || exit 0

# The script beside these hooks, not one in the committing checkout: they are the same file in a normal
# clone, and a test clone pointing core.hooksPath here has no src/ of its own.
autosync_script="$(cd "$(dirname "$0")/../.." && pwd)/src/autosync.ts"
if ! command -v node >/dev/null 2>&1; then
	echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [$1] node is not on PATH for this commit; not synced" \
		>>"$(git rev-parse --git-common-dir)/ntwine-sync.log" 2>/dev/null
	exit 0
fi

# `set -m` puts the background job in its own process group, so a harness that kills the committing
# command's group when it returns cannot take the sync with it; `--detach` then moves it to its own
# session. Every descriptor is redirected: an agent reading `git commit`'s output waits for EOF on the
# pipe, and a background process holding it open would hang that agent until the sync finished.
set -m
nohup node "$autosync_script" sync --detach --reason "$1" </dev/null >/dev/null 2>&1 &
exit 0
