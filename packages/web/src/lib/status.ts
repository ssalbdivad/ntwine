import { NtwineStatus, type ThreadView } from "@ntwine/shared"

type RecoveryThread = Pick<ThreadView, "kind" | "foreign" | "runtime">

// CAN this session be resumed at all: an OWNED (non-foreign) session row whose process is gone.
// Recovery works through the ordinary follow-up path — the server reattaches the dead provider
// session, retires any phantom Codex turn, then starts the continuation — and that holds whether the
// exit was a mid-turn crash or an ordinary rest. Foreign sessions are read-only; a live session has
// nothing to retry.
//
// This is a CAPABILITY, not the affordance. It deliberately ignores lifecycle (`state`/fences), so it
// is NOT what any surface should gate a Retry button on: every visible Retry comes from
// groups.ts `offersRetry` (the STALLED rows PLUS the ones killed by an auto-resume usage limit), which
// consults this and then lets archived / done-fenced / answered / snooze-or-timer-held threads keep
// their own mark and affordance. Gating a surface on this directly is exactly how the drawer ended up
// offering Retry on 158 archived threads whose rail rows showed a muted [✓] (maintainer 2026-07-23).
// Its one caller is sessionIndicatorKind.
export function canRetry(thread: RecoveryThread): boolean {
  return thread.kind === "session" && thread.foreign !== true && thread.runtime === "exited"
}

// Lifecycle order for status pickers: planning → planned → active → blocked → done → dismissed.
// This is the shared NtwineStatus enum's own declaration order — single-sourced, never re-listed.
export const STATUS_ORDER: readonly NtwineStatus[] = NtwineStatus.options
