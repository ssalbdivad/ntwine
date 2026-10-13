import type { QueryClient } from "@tanstack/react-query"
import type { ScheduleView } from "@ntwine/shared"
import { spanUntil } from "./activityTime.ts"

// SCHEDULES ON THE PAGE (ARCHITECTURE.md § Scheduled threads): the cache keys every surface reads them under,
// and the one reading of a schedule's right-hand column.
//
// A schedule is read from pages that name another project — the project list draws every project's, the
// palette lists them all — so its keys carry their project (`ofProject`, lib/queryKeyScope.ts) rather than
// take the page's. The palette's cross-project list is under `*`, which names no project and every one.
export const scheduleKeys = {
  list: (projectId: string) => ["ofProject", projectId, "schedules", "list"] as const,
  get: (projectId: string, id: string) => ["ofProject", projectId, "schedules", "get", id] as const,
  all: () => ["ofProject", "*", "schedules", "all"] as const,
}

/** After any write to a schedule: every list and drawer that might show it, and the project row's count
 *  (the poll's `schedules`). `deleted` names a schedule that is gone: its own reads are not refetched,
 *  since the drawer or sheet still mounted on it for the frame it takes to close would ask the server for
 *  it and log the server's error. */
export function invalidateSchedules(queryClient: QueryClient, deleted?: string): void {
  if (deleted) void queryClient.cancelQueries({ predicate: (query) => query.queryKey[3] === "get" && query.queryKey[4] === deleted })
  void queryClient.invalidateQueries({
    predicate: (query) => query.queryKey[0] === "ofProject" && query.queryKey[2] === "schedules" && !(deleted && query.queryKey[3] === "get" && query.queryKey[4] === deleted),
  })
  void queryClient.invalidateQueries({ queryKey: ["projectsQueues"] })
}

/**
 * The schedule row's right-hand column, in the rest-time column's grammar (lib/activityTime.ts): `in 3h`
 * until its next run, `now` once that is due and not yet started, or — when it will not run on its own —
 * why: `Proposed`, `Paused`, `Ended`.
 */
export function scheduleNextLabel(schedule: Pick<ScheduleView, "state" | "nextRun">, nowMs = Date.now()): string {
  if (schedule.state === "proposed") return "Proposed"
  if (schedule.state === "paused") return "Paused"
  if (schedule.state === "ended" || !schedule.nextRun) return "Ended"
  const span = spanUntil(schedule.nextRun.at, nowMs)
  return span ? `in ${span}` : "now"
}

/** "Proposed by @triage-bot" — a worker's proposal names the thread that made it. */
export function proposedByLine(createdBy: string): string | null {
  return createdBy && createdBy !== "human" ? `Proposed by @${createdBy}` : null
}

/**
 * What a scheduled run's opening header says about its schedule — its title and its rule — read back off
 * the header's first line (shared `scheduledRunHeader`), so the transcript can name the schedule in one
 * line instead of printing the machinery. Undefined when the line is not that header's: the transcript
 * then names no schedule rather than a wrong one.
 */
export function scheduledRunFacts(header: string): { title: string; describe: string } | undefined {
  const first = header.split("\n", 1)[0] ?? ""
  const m = /^This is a scheduled run of "(.*)" \(sch_[0-9a-f]{12}\), (.*?)\. It is a fresh thread/.exec(first)
  return m ? { title: m[1]!, describe: m[2]! } : undefined
}
