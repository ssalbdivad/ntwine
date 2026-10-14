import type { ThreadView } from "@ntwine/shared"
import { sessionIndicatorKind } from "../groups.ts"
import { limitResumeClock } from "./activityTime.ts"
import { PROVIDER_LABEL } from "./signIn.ts"

// ONE WORDING FOR A USAGE-LIMIT PAUSE, on every surface that draws one: the rail row's tip, the drawer's
// pause card, and the queue card's copy of it. Each surface built its own sentence until 2026-10-02, and
// they had drifted — the rail named an ACP agent's pause "Claude", the drawer read "Paused by the The
// agent usage limit", and the queue card drew no pause at all, only whichever line the agent wrote last
// (maintainer: "all pauses should look the same").

type Pause = NonNullable<ThreadView["limitPause"]>

/** "Paused by the Claude session limit". Only Claude and Codex report a window ntwine can read; an ACP
 *  agent's limits stay inside its own CLI, so its pause is named without a provider. */
export function limitPauseTitle(pause: Pause): string {
  const which = pause.window === "weekly" ? "weekly limit" : pause.window === "session" ? "session limit" : "usage limit"
  return pause.backend === "acp" ? `Paused by the agent's ${which}` : `Paused by the ${PROVIDER_LABEL[pause.backend]} ${which}`
}

/** What ntwine will do about it. The auto-resume promise is the server's word (board.resolveLimitPause
 *  keeps it truthful — an unknown window has no wake), so a promised wake names its clock and an
 *  unpromised one says plainly that continuing is the human's. */
export function limitPauseResume(pause: Pause): string {
  if (!pause.autoResume) return "Continue it whenever you have capacity again."
  return pause.resumesAt ? `Continuing automatically at ${limitResumeClock(pause.resumesAt)}.` : "Continuing automatically once the window resets."
}

/** A thread the board shows as limit-paused — the rail's yellow hourglass. The RESOLVED kind, never the
 *  raw field, so a thread whose pause is outranked (the operator's own snooze, a fresh ask, live work)
 *  is not counted as one: the same gate the rail mark and the Retry verb read (groups.offersRetry). */
export function isLimitPaused(thread: ThreadView): boolean {
  return sessionIndicatorKind(thread) === "limit"
}
