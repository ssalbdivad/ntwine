# Pause — a thread the human has frozen

Written 2026-09-03 as a design mockup, not a description of shipped behavior. Its pictures were a mockup page, `pause-mockup-fixture.tsx`, removed 2026-10-14 with the other unused mockups (it is in git history). This file carries the behavior the pictures could not.

## What it is, next to what already exists

ntwine has two ways to take a thread out of your way, and neither stops the worker. **Snooze** parks the CARD until an instant: the agent keeps running, its watchers keep waking it, and the card comes back on the clock. **Mark as done** ends the session and files the thread away. **Pause** is the missing third: the AGENT stops, and nothing ntwine would otherwise send it reaches it until the human presses play. A pause has no clock. It ends when you end it.

## The verb

- **Where:** the lifecycle footer, a split button left of Snooze (frame 1, variant A). Pause and Snooze are siblings (both park the thread), and the footer is the one strip that already holds every whole-thread lifecycle verb. The alternative (variant B) is a header-strip icon beside Restart worker; cheaper, but it files a lifecycle verb among maintenance and navigation icons.
- **Paused footer:** Pause and Snooze are replaced by one accent **Resume** split button (the header's Retry chrome: the same verb, bringing a thread back). Mark as done stays. The goal mark goes muted because it will not fire.
- **Caret modes (frame 2):** `Pause now` interrupts a running turn; `Pause at next rest` lets the turn and its sub-agents finish and holds the rest that follows. A resting thread pauses instantly under either mode. The Resume caret offers `Resume, drop held`: play without delivering what was held.
- **A running turn asks first (frame 3):** the completion-hold dialog with a gentler verb. It names the turn the interrupt stops, and says that live sub-agents and background shells keep running. Buttons: Cancel, Pause at next rest, Pause now. A resting thread never sees it.

## While paused

Everything below is a rule about the scheduler and the delivery path, not about the browser. There is exactly one gate: a delivery addressed to a paused thread is written to a HELD ledger instead of the worker.

| Source | While paused | On resume |
| --- | --- | --- |
| The goal (stop hook, heartbeat, post-compaction) | Held as ONE entry with a fire count | Delivered once |
| Worker timers (`mcp__ntwine__timer`) | Held, each | Delivered in arrival order |
| Shell watchers, sub-agent returns, Monitor timeouts | Held, each; the shell itself keeps running | Delivered in arrival order |
| PR watchers (`watch_pr`) | Held, each; the watcher keeps watching | Delivered in arrival order |
| A snooze bump (a snooze carrying a prompt) | Held | Delivered in arrival order |
| ntwine's own sign-off nudge | DROPPED: a pause is not a rest to nudge | Nothing |
| Human follow-ups (Enter) | QUEUED, the existing queued-bubble mechanism | Delivered after the held wakes, as their own bubbles |
| `⌘⏎` in the composer | Resumes AND sends | Same as Resume, then the message |
| Answers to a registered question | Queued like a follow-up | Delivered after the held wakes |

- **Pause now** uses the SDK interrupt `⌘⏎` already uses (`router.ts` `interruptTurn`), so the worker resumes exactly where it stopped. The interrupt aborts only the turn: since 2026-09-24 the broker declares the SDK's `perTaskStopAffordance`, so the turn's sub-agents keep running (measured in `_live_broker_interrupt_subagent.mts`; without the declaration the CLI killed them with the turn). Background shells are OS processes and are not touched.
- **Pause at next rest** arms a pending pause: the thread keeps spinning, its footer reads `Pausing at next rest…` with a Cancel, and the pause takes at the next rest event, before any stop-hook goal fires.
- **Rail (frame 5):** a paused thread has no queue card and no rest time. A pause outranks an open question, a permission prompt and a crash, exactly as a user snooze does (`isSnoozed`, `sessionIndicatorKind`). It wears a filled `⏸` in the status box where a snoozed row wears the hourglass, dimmed like its neighbours. Variant A files it in the Snoozed band, sorted first; variant B gives it a PAUSED band between Snoozed and Done, drawn only while something is paused. The tooltip reads `Paused 40m ago — 4 wakes held`.
- **The thread (frame 4):** a caution-tone `TranscriptCard` titled `Paused by you` at the transcript's tail, one more member of the family the usage-limit pause card already belongs to. The held wakes are listed inside it (icon, label, age, a hover `×` to drop one). The composer stays open with a paused placeholder and a status line: `Paused · Enter queues · ⌘⏎ resumes and sends`.
- **Other verbs while paused:** Mark as done archives and drops the held wakes (the dialog says so when any are held). Snooze is hidden. Restart worker and Reload plugins work as today; the thread stays paused. A `ntwine` MCP call cannot arrive, because the worker is not running.
- **Sub-agents:** a live sub-agent is what makes a thread un-snoozable today (`hasLiveSubAgents`). A pause is stronger: `Pause now` stops them with the turn, `Pause at next rest` waits for them. There is no state where a paused parent has live children.

## Resume (frame 6)

1. The pause card collapses to its title line (`Paused by you · 2h 35m`) and stays as the record.
2. A `WakeDivider` hairline: `▶ Resumed — 4 held wakes delivered · 4m ago`.
3. ONE ntwine wake, in the shape of the other wake prompts: `▶ Resumed after being paused for 2h 35m. While you were paused:` then the held items, numbered, in arrival order, then `Continue exactly where you left off.` Delivering them as one briefing rather than four bumps is the point: the worker reads what happened, not a burst of stale nudges.
4. Queued follow-ups flush after it, through the existing queue path.
5. With nothing held and nothing queued, Resume sends `Continue exactly where you left off.` alone, so the worker always gets one turn-starting message.

## Server sketch

- `sessions.paused_at` (ISO, null when not paused), `sessions.pause_pending` (a `next-rest` pause armed on a running turn). Both ride the board as `pausedAt` / `pausePending`.
- A `held_wake` table: `(session_id, kind, label, text, at, count)`. The goal upserts on `(session_id, kind='goal')` and increments `count`. Rides the board as `heldWakes[]` for the card.
- `setThreadPause({ slug, sessionId, paused, mode: 'now' | 'next-rest', dropHeld? })` on the typed RPC surface. `paused: true, mode: 'now'` calls `interruptTurn` first when the runtime is `running`.
- The scheduler's ONE gate: in the delivery choke point every SOURCE already funnels through, a paused target writes a `held_wake` row and returns. The sign-off nudge (SOURCE 9) checks the flag itself and skips.
- Resume composes the wake from the ledger, deletes the rows, clears `paused_at`, and sends through the ordinary follow-up path so every eager-send affordance (the row leaving Snoozed for Active, the bubble) comes for free.

## Pause all (frame 7) — a scope question

The same switch at board altitude: every open thread in the project pauses at once (`next-rest` for the running ones), and new dispatches start paused, until Resume all. A caution strip under the prompt box carries the count and the Resume all button; the `⏸` beside the project name is the switch. It is a second feature riding the first's mechanics, drawn to ask whether it ships with Pause or after.

## Open questions

1. Verb placement: footer split button (A) or header icon (B).
2. Rail placement: inside Snoozed with the pause mark (A) or its own PAUSED band (B).
3. Whether Pause all is in the first cut.
