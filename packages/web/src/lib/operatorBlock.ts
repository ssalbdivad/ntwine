import type { PendingAsk, ThreadView } from "@frizz/shared"

// What the bottom of a thread says while a worker is blocked on a PERSON — the two decisions the
// runtime-status ladder (ChatView `runtimeStatusRung`) needs and must not get wrong, kept here so they
// are importable by a test.
//
// Both used to assume a terminal. A permission prompt drew "respond in your external terminal", and so
// did a native AskUserQuestion, each standing down only while a typed interaction was pending. That
// premise is gone for every thread Frizz runs: `perm-prompt` and an owned thread's `pendingAsk` occur
// only on a broker session (board.ts `deriveRuntime`, tailer.ts `permBlocked`), which HAS no terminal —
// its request is journaled as an answerable card or denied on the spot. So the terminal reading could
// only ever draw in the gap around a card: before it was journaled, or after it was answered and before
// the transcript caught up (maintainer 2026-10-10: "every time after I approve a command … it changes
// the render to this"). Its "Copy terminal command" was worse than wrong there — it starts a second
// `claude` on a session whose daemon is alive.
type BlockState = Pick<ThreadView, "foreign" | "runtime" | "pendingAsk" | "pendingInteraction" | "actionableInteraction">

/** The read-only "answer it in your external terminal" card for a native AskUserQuestion. FOREIGN
 *  sessions only: a session the operator is driving in their own terminal is the one place that
 *  sentence is true, and the one place Frizz has no card of its own to offer. */
export function frozenPendingAsk(thread: BlockState | undefined): PendingAsk | undefined {
  return thread?.foreign && thread.pendingInteraction !== true ? thread.pendingAsk : undefined
}

/** Whether the Working… line is the thread's tail. A permission block with no card on screen is a turn
 *  in flight like any other — the card is a moment away, or was just answered — so it reads as working
 *  rather than as a state of its own. And a card that still needs the operator's decision is never
 *  followed by a line saying the agent is working: the two used to draw together for every question
 *  card and every Codex or ACP approval, where nothing marks the runtime as blocked. */
export function drawsWorking(thread: BlockState | undefined, showWorking: boolean): boolean {
  if (thread?.actionableInteraction === true) return false
  return showWorking || thread?.runtime === "perm-prompt"
}
