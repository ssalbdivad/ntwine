// ── Sub-agent report delivery repair ───────────────────────────────────────────────────────────────
// A background sub-agent's final report reaches its parent as a completion `<task-notification>`, and
// that notification rides THREE record shapes in the session JSONL (see tailer.ts `notificationText`).
// Two of them are NOT equivalent to the third, and conflating them is the bug this module exists for:
//
//   queue-operation  — the runtime ACCEPTED the notification into its input queue. Bookkeeping only.
//                      The model has not seen a word of it.
//   user record      — MODEL-FACING. The report is in the agent's context.
//   attachment       — (`type:"queued_command"`) MODEL-FACING. Same.
//
// MEASURED ON THE OPERATOR'S OWN CORPUS (2026-07-30, two real nub threads): a large fraction of
// `status=completed` notifications appear ONLY as queue-operations — an `enqueue` followed by a
// `remove`, with no `user` record and no attachment anywhere in the file. Raw-grepping every line that
// mentions those task-ids finds exactly those two records and nothing else. On the busier thread that
// was 39 of 117 completed reports (33%); the dropped payloads ran 3.3k–23.6k characters and were
// finished adversarial reviews — "3 HARD COMPILE breaks", "2 blocking, 2 should-fix", "Two hard
// CI-gate breaks". The orchestrator landed those diffs believing they had been reviewed. Worse, ntwine's
// own timeline rendered NOTHING for them, because the tailer retires a sub-agent row on any terminal
// notification regardless of carrier — so the row simply vanished and the loss was invisible.
//
// Payload size was the obvious suspect and is NOT the mechanism: 3,318 chars was dropped on that same
// thread while 12,299 was delivered. The drop is upstream of ntwine, inside a dependency we do not own
// (Claude Code's own queue, SDK stream-json under the broker — ntwine only ever READS these records).
//
// So this module does not try to explain the drop. It observes the model-facing carriers directly and
// repairs on ABSENCE, which is correct whatever the upstream cause turns out to be.
//
// IDEMPOTENCE IS CARRIED BY THE TRANSCRIPT, not by a persisted flag. The repair ntwine injects is itself
// a user record, and it embeds `RELAY_MARKER` + the task-id. On any later re-fold — a ntwine restart, a
// cold resume, a full re-read of the file — that record is model-facing evidence for exactly this
// task-id, so the report resolves as delivered and is never repaired twice. Nothing to persist,
// nothing to migrate, and the evidence lives in the same file as the thing it is evidence about.

/** A completion report the runtime queued. Cleared the moment a model-facing carrier names it. */
export interface QueuedReport {
  taskId: string
  /** An agent REPORT (its findings are unrecoverable) vs a shell WAKE (its output is on disk). */
  kind: "agent" | "shell"
  /** The dispatch's tool_use id, when the notification carried one (the recovery shape omits it). */
  toolUseId?: string
  /** The child's transcript — the FULL report, and what the repair points at. */
  outputFile?: string
  /** The `<summary>` line, e.g. `Agent "Correctness review of X" finished`. */
  summary?: string
  /** ISO8601 of the queue-operation record that enqueued it. */
  queuedAt?: string
  /** Characters in the `<result>` block — what the agent would have read. */
  chars: number
}

/**
 * Marker opening every relayed completion.
 *
 * The `<ntwine-…>` shape is deliberate and load-bearing TWICE. It is already in transcript.ts's
 * `NOISE_PREFIXES`, so `isInjectedNoise` skips the record and the relay never renders in the
 * timeline — the thread looks exactly as it did before, which is the point: ntwine is repairing a
 * runtime failure, not narrating one at the human. And because the marker carries the task id, the
 * same record is model-facing evidence for that id on any later re-fold, which is what makes the
 * relay idempotent with nothing persisted.
 */
export const RELAY_MARKER = "ntwine-relay"

// Bounds the tracking map. Sized GENEROUSLY on purpose: an evicted entry is a lost report that ntwine
// then silently declines to repair, which is precisely the failure this module exists to end — so the
// cap must not be the thing that reintroduces it. Entries are ~200 bytes, so even a long-lived
// orchestrator costs tens of kilobytes. Measured against the corpus, one real thread accumulated 242
// dropped reports over three days; at 64 the replay detected only 63 of them, at 256 it detects all.
export const MAX_TRACKED_REPORTS = 256
// How long a queued report may sit unresolved before ntwine treats it as dropped. The runtime delivers
// a queued notification at a TURN BOUNDARY, so the honest signal is "the agent came to rest and it
// still is not in its context" — this timer is only the floor under that check, sized well past a
// normal queue-to-delivery gap (35 ms on the measured cold-rest delivery, sub-second on every other
// delivered sample in the corpus).
export const RELAY_AFTER_MS = 90_000
// ── THE WATERMARK ──────────────────────────────────────────────────────────────────────────────────
// ntwine relays only completions that were queued AFTER this process came up.
//
// Without it, switching this on points ntwine at every historical drop in the transcript — hundreds per
// long-lived thread — and the first thing a resumed agent would receive is a wall of notices about
// work it finished days ago. An earlier draft tried to soften that with a per-tick cap, which was
// treating the symptom: the backlog is not a rate problem, it is a relevance problem. A completion
// that was lost last Tuesday is history, and replaying it teaches the agent nothing it can act on.
//
// Captured at module load, so it is the process start instant. A ntwine restart moves it forward and
// the (at most a few) completions dropped across the restart window are given up deliberately — that
// is a far better trade than resurrecting a week of dead notifications.
export const RELAY_EPOCH_MS = Date.now()

/**
 * Is this record shape one that puts the notification into the MODEL's context?
 *
 * `queue-operation` is the runtime's own bookkeeping and is deliberately NOT model-facing — that
 * distinction is the entire basis of this module.
 */
export function isModelFacingCarrier(recType: unknown): boolean {
  return recType === "user" || recType === "attachment"
}

/**
 * Is this notification an AGENT's report, as opposed to a background shell's or Monitor's exit line?
 *
 * Only an agent's is worth repairing. A shell's output stays on disk and pollable, so losing its
 * notification costs nothing a re-read cannot recover; a sub-agent's findings exist ONLY inside the
 * notification, so a drop is total. Without this gate the detector fires on ~880 shell/monitor
 * notifications per thread against ~39 real losses — burying the signal it exists to raise.
 *
 * Keyed on the harness's own `<summary>` prose, which is the same class of dependency the tailer
 * already rests on ("Command running in background with ID:", "Monitor started (task"). It is not a
 * guess: measured over 1,178 real notifications across two production threads, `Agent "…"` summaries
 * and long (>12 char) task-ids agree PERFECTLY — 289 agent/long, 884 shell+monitor/short, zero
 * crossover either way. The id shape is therefore kept as a corroborating fallback for the recovery
 * shape, which carries no per-op summary at all.
 *
 * Deliberately NOT keyed on correlating `<tool-use-id>` back to an `Agent` dispatch: a re-steered
 * child's notification carries the SendMessage's id and a grandchild's dispatch lives in another
 * transcript entirely, so that key matched only 76 of 170 real agent reports.
 */
export function isAgentReport(summary: string | undefined, taskId: string): boolean {
  return reportKind(summary, taskId) === "agent"
}

/**
 * An agent's REPORT and a shell's WAKE are both losable, and both matter — for different reasons.
 *
 * The original scoping here covered agents only, on the grounds that a shell's output stays on disk
 * and pollable so losing its notification costs nothing a re-read cannot recover. That is true of the
 * CONTENT and false of the WAKE, which is the entire point of a background shell: a rested agent whose
 * build finished and was never told just sits there. Measured on the same corpus, shells are hit far
 * harder than agents — 383 of 421 shell/monitor notifications lost on one thread (91%) against 32 of
 * 129 agent reports — and that is exactly the "the thread stopped churning" symptom that started this
 * whole investigation.
 *
 * Upstream this is anthropics/claude-code#20754 (OPEN since 2026-01-25): "Background Task
 * Notifications Not Delivered When Multiple Agents Complete Simultaneously" — 1 of 3 completed agents
 * notified, the rest silent. Same shape, same runtime, still unfixed.
 */
export function reportKind(summary: string | undefined, taskId: string): "agent" | "shell" | undefined {
  const s = summary?.trim()
  if (s?.startsWith('Agent "')) return "agent"
  if (s?.startsWith("Background command") || s?.startsWith("Monitor")) return "shell"
  if (s) return undefined // a summary naming something else is neither
  // The recovery shape carries no per-op summary. Fall back to the id shape, which agrees with the
  // summary perfectly across 1,178 real notifications (agent ids are long, shell/monitor ids short).
  return taskId.length > 12 ? "agent" : "shell"
}

/** Every `<task-id>` named by a notification block (a recovery block names several at once). */
export function blockTaskIds(block: string): string[] {
  return [...block.matchAll(/<task-id>([^<]*)<\/task-id>/g)]
    .map((m) => m[1].trim())
    // The orphan-scan sentinel correlates to no real dispatch — the tailer skips it too.
    .filter((id) => id.length > 0 && !id.startsWith("__orphan_summary__"))
}

/** Pull the fields a repair needs out of one `<task-notification>` block. */
export function parseReportBlock(block: string, at?: string, taskId = ""): Omit<QueuedReport, "taskId"> {
  const grab = (tag: string): string | undefined =>
    block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim() || undefined
  const summary = grab("summary")
  return {
    kind: reportKind(summary, taskId) ?? "agent",
    toolUseId: grab("tool-use-id"),
    outputFile: grab("output-file"),
    summary,
    queuedAt: at,
    chars: grab("result")?.length ?? 0,
  }
}

/**
 * Does this model-facing record resolve a report ntwine injected a repair for?
 *
 * The repair is not a `<task-notification>`, so the ordinary notification fold will never see it. This
 * is what closes the idempotence loop described at the top of the file.
 */
export function relayedTaskIds(text: string): string[] {
  if (!text.includes(RELAY_MARKER)) return []
  return [...text.matchAll(new RegExp(`<${RELAY_MARKER}:([A-Za-z0-9_-]+)>`, "g"))].map((m) => m[1])
}

/**
 * The message ntwine injects when a report was dropped.
 *
 * A POINTER, never the payload. The child's transcript on disk already holds the full report — more
 * of it than the truncated `<result>` excerpt ever carried (one measured child's output file was
 * 739,475 bytes against a 12k excerpt). Re-injecting tens of thousands of characters would also feed
 * the runtime the very thing it just failed to move, which is a poor way to fix a delivery failure.
 *
 * It is addressed to the agent, in the imperative, because it is not an FYI: the agent's next action
 * has to change. It names the file, the size, and what was lost.
 */
export function relayMessage(report: QueuedReport): string {
  const who = report.summary?.replace(/\s+/g, " ").trim() || `Background op ${report.taskId}`
  const tag = `<${RELAY_MARKER}:${report.taskId}>`
  // A SHELL's repair is a WAKE, not a reading assignment. Its output was always retrievable; what was
  // lost is the fact that it finished, which is what should have re-invoked the agent. Keep it short —
  // the agent's own next step is obvious once it knows.
  if (report.kind === "shell") {
    const where = report.outputFile ? ` Its output is at ${report.outputFile}.` : ""
    return [
      `${tag} ${who} — but that completion never reached you, so you were never woken for it.`,
      `${where} Pick the work back up where this was blocking you.`,
    ].join("")
  }
  const size = report.chars > 0 ? ` (~${report.chars.toLocaleString("en-US")} characters)` : ""
  const where = report.outputFile
    ? `Its full report is on disk at ${report.outputFile} — READ THAT FILE before you continue.`
    : `Its report was not recoverable from disk; re-run the work or ask the child again.`
  return [
    `${tag} ${who}, but its report never reached you.`,
    `The runtime queued the completion and then discarded it without delivering it${size}, so it is`,
    `NOT in your context and you have not read it, whatever your earlier summary may have implied.`,
    where,
    `If you already acted on this work as though it were reviewed, revisit that decision now.`,
  ].join(" ")
}

// ── THE TIMELINE'S SIDE OF THE REPAIR ──────────────────────────────────────────────────────────────
// A relayed completion is the SAME real event as a delivered one — a background op finished and
// re-invoked the agent — so the transcript owes the reader the same three things: a wake divider naming
// the cause, a back-filled terminal state on the launch card, and a broken merge chain. It owed all
// three and paid none, because the repair is PROSE rather than a `<task-notification>`: completionEvents
// skipped it and isInjectedNoise then swallowed the record whole.
//
// Measured on a fixture against the delivered control, changing only how the completion arrived: three
// messages with a `completed` card became ONE message whose card was stuck on `pending`, the post-wake
// turn folded into the launch bubble, and nothing anywhere named the cause. That is what a maintainer
// hit on 2026-08-05 — "it looks like the agent came to rest, then re-triggered with no external event
// triggering" — after the only visible wake source on the thread had been switched off, leaving 55
// relays as the sole driver and every one of them silent.
//
// The comment at RELAY_MARKER is still right that ntwine should not NARRATE its own plumbing at the
// human. Showing that a background task finished is not narrating plumbing: that event is already a
// first-class divider when the runtime delivers it, and hiding it only when ntwine is the one carrying it
// makes the timeline lie about why the agent moved.
//
// Rather than grow a second projection path, a relay is translated BACK into the notification it stands
// for and handed to the one that already exists. The delimiters below are the ones `relayMessage` writes
// a few lines up — parsed and written in the same file precisely so they cannot drift apart.
const SHELL_SUMMARY_END = " — but that completion never reached you"
const AGENT_SUMMARY_END = ", but its report never reached you."

/** Rides the synthesized block so the wake label can say the completion was RECOVERED rather than
 * delivered — the one fact a reader cannot infer from the event itself, and the tell that the runtime
 * dropped something. */
export const RELAYED_MARKER = "<ntwine-relayed/>"

/** The terminal status a summary implies. The corpus is narrow — 362 `Background command "…" completed
 * (exit code 0)`, 60 `Agent "…" finished`, 4 `Monitor "…" stream ended` across every relay in the logs —
 * but a non-zero exit is read properly rather than assumed away, because a FAILING op is exactly the one
 * a reader most needs the divider for. */
function relayedStatus(summary: string): "completed" | "failed" | "killed" {
  const code = summary.match(/exit code (\d+)/)?.[1]
  if (code !== undefined) return code === "0" ? "completed" : "failed"
  if (/\b(stopped|killed)\b/i.test(summary)) return "killed"
  if (/\bfailed\b/i.test(summary)) return "failed"
  return "completed"
}

/**
 * The `<task-notification>` a relay message stands for, or undefined if this text is not a relay.
 *
 * Correlation rides `<task-id>`, not `<tool-use-id>`: the tag carries the background TASK id, which the
 * projection already maps back to the launch's tool-use id. That is the same key the delivered path
 * falls back to, so a repaired completion lands on exactly the same card.
 */
export function relayNotificationBlock(text: string): string | undefined {
  const tag = text.match(new RegExp(`^\\s*<${RELAY_MARKER}:([A-Za-z0-9_-]+)>\\s*`))
  if (!tag) return undefined
  const body = text.slice(tag[0].length)
  const shellCut = body.indexOf(SHELL_SUMMARY_END)
  const cut = shellCut >= 0 ? shellCut : body.indexOf(AGENT_SUMMARY_END)
  // A relay whose prose this cannot parse must NOT silently vanish the way every relay used to — fall
  // back to the leading sentence so the divider still names something real.
  const summary = (cut > 0 ? body.slice(0, cut) : (body.split(". ")[0] ?? "")).trim()
  if (!summary) return undefined
  return [
    "<task-notification>",
    `<task-id>${tag[1]}</task-id>`,
    `<status>${relayedStatus(summary)}</status>`,
    `<summary>${summary}</summary>`,
    RELAYED_MARKER,
    "</task-notification>",
  ].join("\n")
}

/**
 * Which tracked reports are due for repair?
 *
 * Two conditions, and both matter. The age floor keeps ntwine off a notification that is simply still
 * in flight. `atRest` is the real discriminator: a queued notification is handed to the model at a
 * turn boundary, so once the agent has finished a turn and the report STILL is not in its context,
 * waiting longer cannot help — the delivery that was going to happen already didn't.
 */
export function completionsDueForRelay(
  reports: Iterable<QueuedReport>,
  opts: { nowMs: number; atRest: boolean; afterMs?: number; sinceMs?: number },
): QueuedReport[] {
  if (!opts.atRest) return []
  const afterMs = opts.afterMs ?? RELAY_AFTER_MS
  const sinceMs = opts.sinceMs ?? RELAY_EPOCH_MS
  const due: QueuedReport[] = []
  for (const r of reports) {
    const queuedMs = r.queuedAt ? Date.parse(r.queuedAt) : Number.NaN
    // No usable stamp ⇒ cannot prove it belongs to THIS process, so it is history by default. This is
    // the opposite of the old policy (treat it as due) and deliberately so: an undatable completion is
    // exactly the shape a re-folded historical record has, and the cost of guessing wrong is spamming
    // a live agent about dead work.
    if (Number.isNaN(queuedMs)) continue
    if (queuedMs < sinceMs) continue          // the WATERMARK — history, not this run
    if (nowMinus(opts.nowMs, queuedMs) >= afterMs) due.push(r)
  }
  return due
}

function nowMinus(nowMs: number, thenMs: number): number {
  return nowMs - thenMs
}
