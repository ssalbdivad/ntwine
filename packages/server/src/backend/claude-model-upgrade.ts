import { claudeEditionIsNewer, claudeFamilyLabel, parseClaudeWireId, type ClaudeModel } from "@ntwine/shared"
import { hibernationVerdict, type HibernationBlock, type HibernationCandidate } from "../thread-hibernation.ts"
import type { SessionRow, Storage } from "../storage.ts"
import type { SessionTelemetry } from "../tailer.ts"
import { claudeBrokerRecordPath, liveBrokerRecord } from "./claude-broker-host.ts"

// A Claude thread can fall BEHIND its own model family. ntwine dispatches on the family alias (`opus`) and
// the pinned runtime resolves it, so when a pin bump moves the alias (Claude Code 2.1.280 took `opus` from
// Opus 5 to Opus 5.5) every worker started after the bump runs the new edition — and every worker started
// before it keeps the old one, because a daemon keeps the `claude` binary it was forked with for as long as
// it lives. Nothing about the thread's row changes: it says `opus` before and after.
//
// Two ways across, both the same act — retire the daemon, so the next turn cold-resumes the transcript in a
// process forked from the CURRENT pin (the permission-change and hibernation mechanism; see the bridge's
// retireDaemon):
//
//  - the operator's one-click upgrade in the composer's model picker (router `upgradeThreadModel`);
//  - on its own, at the first message after the thread's next COMPACTION (maintainer 2026-09-24: "we want
//    to always upgrade to the latest model version on compaction"). A model switch always re-reads the
//    whole context uncached — the prompt cache is per model — and a compaction is when that context is at
//    its smallest. The switch waits for the thread to be AT REST: a compaction usually lands mid-turn, and
//    retiring a process mid-turn kills the turn, its in-memory sub-agents and its shells. So it rides the
//    next input delivered to an idle thread, as a fresh process, never the turn that compacted.

/** What a Claude thread's worker last ran, and the newer edition of that family the pin now resolves. */
export interface ClaudeModelStanding {
  running: { alias: string; edition: string; label: string }
  /** Present only when the pinned runtime resolves the family to a strictly newer edition. */
  newer?: { label: string; edition: string }
}

/** Read a thread's observed model id (the transcript's `message.model`) against the pin's catalogue.
 *  Undefined when the id is not a Claude edition. A catalogue that has not resolved (or resolved only the
 *  bare family) names no `newer` — unknown is never "behind". */
export function claudeModelStanding(observedModel: string | undefined, catalogue: readonly ClaudeModel[] | undefined): ClaudeModelStanding | undefined {
  const running = observedModel ? parseClaudeWireId(observedModel) : undefined
  if (!running) return undefined
  const standing: ClaudeModelStanding = {
    running: { alias: running.alias, edition: running.edition, label: `${claudeFamilyLabel(running.alias)} ${running.edition}` },
  }
  const latest = catalogue?.find((model) => model.alias === running.alias)
  if (latest?.edition && claudeEditionIsNewer(latest.edition, running.edition)) standing.newer = { label: latest.label, edition: latest.edition }
  return standing
}

/**
 * May this thread's worker be retired RIGHT NOW so its next turn runs the newer edition? The pure gate
 * both paths share: every refusal hibernation makes (a turn in flight, a sub-agent, a shell, an approval,
 * an undelivered message — thread-hibernation.ts carries why each one is there), minus the two that are
 * about reclaiming MEMORY rather than safety: the idle TTL and the daemon's minimum age.
 */
export function claudeModelUpgradeBlock(candidate: HibernationCandidate, nowMs: number): HibernationBlock | undefined {
  const verdict = hibernationVerdict(candidate, { nowMs, idleMs: 0, minDaemonAgeMs: 0 })
  return verdict.hibernate ? undefined : verdict.blockedBy
}

export type ClaudeUpgradeDue =
  | { due: true; from: string; to: string }
  | { due: false; blockedBy: HibernationBlock | "current" | "no-compaction-since" }

/**
 * Does the input about to be delivered to this thread have to land in a FRESH process, because the thread
 * compacted while running an edition its family has since moved past?
 *
 * The compaction has to be newer than BOTH the daemon (a compaction under a previous process was not this
 * one's) and this server (the catalogue that says "behind" is this server's; a compaction from before it
 * started predates the upgrade being available at all). An unreadable instant on either side refuses.
 */
export function claudeModelUpgradeDue(
  candidate: HibernationCandidate,
  opts: { catalogue: readonly ClaudeModel[] | undefined; nowMs: number; serverStartedAtMs: number },
): ClaudeUpgradeDue {
  const standing = claudeModelStanding(candidate.telemetry?.model, opts.catalogue)
  if (!standing?.newer) return { due: false, blockedBy: "current" }
  const compactedAt = candidate.telemetry?.lastCompactionAt ? Date.parse(candidate.telemetry.lastCompactionAt) : Number.NaN
  if (!(compactedAt >= Math.max(candidate.daemonStartedAtMs, opts.serverStartedAtMs))) return { due: false, blockedBy: "no-compaction-since" }
  const blockedBy = claudeModelUpgradeBlock(candidate, opts.nowMs)
  if (blockedBy) return { due: false, blockedBy }
  return { due: true, from: standing.running.label, to: standing.newer.label }
}

/** The operator's words for a refusal of the one-click upgrade — a toast, so each stays short. */
export function claudeModelUpgradeRefusal(blockedBy: HibernationBlock): string {
  switch (blockedBy) {
    case "turn-in-flight": return "Wait for the current turn to finish"
    case "awaiting-a-human":
    case "pending-approval": return "Resolve the open approval or question first"
    case "sub-agents": return "Wait for the thread's sub-agents to finish"
    case "background-shells": return "Wait for the thread's background shells to finish"
    case "undelivered-input": return "Wait for the last message to reach the worker"
    case "not-a-broker-thread": return "Only a Claude thread ntwine runs can be upgraded"
    case "archived": return "Reopen this thread before upgrading it"
    default: return "This thread's state cannot be read yet"
  }
}

/** Gather one thread's gate inputs off the live system. Undefined when no daemon is running for it: then
 *  there is nothing to retire, and the next turn forks from the current pin — the newer edition — anyway. */
export function claudeUpgradeCandidate(
  deps: { stateDir: string; projectId: string; storage: Pick<Storage, "interactions">; telemetry: SessionTelemetry | undefined },
  row: SessionRow,
): HibernationCandidate | undefined {
  const record = liveBrokerRecord(claudeBrokerRecordPath(deps.stateDir, row.session_id))
  if (!record) return undefined
  let pendingInteractions = 1 // a store that cannot be read answers "there might be one", never "none"
  try {
    pendingInteractions = deps.storage.interactions.listPending({ projectId: deps.projectId, threadSlug: row.slug, sessionId: row.session_id }).length
  } catch { /* keep the refusal */ }
  return { slug: row.slug, sessionId: row.session_id, row, telemetry: deps.telemetry, pendingInteractions, daemonStartedAtMs: Date.parse(record.createdAt) }
}

/** The instant the catalogue that says "behind" became this server's: the process start. */
export const SERVER_STARTED_AT_MS = performance.timeOrigin
