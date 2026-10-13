import { useQuery } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import type { ReactNode } from "react"
import type { ThreadStats, ThreadTokenUsage, ThreadView } from "@ntwine/shared"
import { useThreadApi, useThreadProjectId } from "../api/threadApi.tsx"
import { displayTitle } from "../groups.ts"
import { ageSpan, exactStamp } from "../lib/activityTime.ts"
import { formatRuntimeElapsed } from "../lib/durationLabels.ts"
import { Dialog } from "./ui/Dialog.tsx"

// THE ⋯ MENU'S THREAD INFO: what a thread has consumed — cost, tokens, turns, requests — read off its
// own transcript by the server (thread-stats.ts, which says where each number comes from and why the
// cost is Claude Code's own figure rather than a price table). Polled while open, so a running thread's
// numbers climb as you watch; the server reads only what was appended since the last look.

const total = (t: ThreadTokenUsage) => t.input + t.cacheWrite + t.cacheRead + t.output

// 12345 → "12.3k", 65207270 → "65.2M": three significant figures, the precision a glance can use. The
// exact count is in the cell's title.
export function compactCount(n: number): string {
  if (n < 1_000) return String(n)
  const [value, unit] = n >= 1_000_000_000 ? [n / 1_000_000_000, "B"] : n >= 1_000_000 ? [n / 1_000_000, "M"] : [n / 1_000, "k"]
  return `${value >= 100 ? Math.round(value) : value >= 10 ? value.toFixed(1).replace(/\.0$/, "") : value.toFixed(2).replace(/\.?0+$/, "")}${unit}`
}

export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01"
  return `$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function ThreadInfoDialog({ thread, onClose }: { thread: ThreadView; onClose: () => void }) {
  const api = useThreadApi()
  const projectId = useThreadProjectId()
  const stats = useQuery({
    queryKey: ["threadStats", projectId ?? "", thread.id],
    queryFn: () => api.threadStats({ slug: thread.id }),
    refetchInterval: 5_000,
  })
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }} title={displayTitle(thread)} className="w-[460px] max-w-[92vw] max-h-[82vh]">
      {stats.data ? (
        <StatsBody stats={stats.data} />
      ) : (
        <div className="flex items-center gap-2 p-4 text-[12.5px] text-muted">
          {stats.isError ? (
            <span className="text-danger">Couldn't read this thread's usage: {(stats.error as Error).message.slice(0, 160)}</span>
          ) : (
            <>
              <Loader2 size={12} className="animate-spin" aria-hidden />
              Reading the transcript…
            </>
          )}
        </div>
      )}
    </Dialog>
  )
}

function StatsBody({ stats }: { stats: ThreadStats }) {
  if (!stats.recorded) {
    return <p className="p-4 text-[12.5px] text-muted">No usage recorded for this thread yet.</p>
  }
  const now = Date.now()
  const hasSubAgents = stats.subAgents > 0 || total(stats.subAgentTokens) > 0
  const allTokens = total(stats.tokens) + total(stats.subAgentTokens)
  const span = stats.startedAt && stats.lastActivityAt ? Date.parse(stats.lastActivityAt) - Date.parse(stats.startedAt) : NaN
  return (
    <div className="flex flex-col gap-4 p-4 text-[12.5px]">
      <div className="grid grid-cols-3 gap-2">
        <Tile label={stats.cost ? "Cost at API rates" : "Cost"} title={stats.cost?.partial ? "Requests since the session last stopped are not priced yet" : undefined}>
          {stats.cost ? `${formatUsd(stats.cost.usd)}${stats.cost.partial ? "+" : ""}` : "—"}
        </Tile>
        <Tile label="Tokens" title={`${allTokens.toLocaleString()} tokens`}>{compactCount(allTokens)}</Tile>
        <Tile label="Turns">{stats.turns.toLocaleString()}</Tile>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5">
        <Row label="Model requests">{stats.requests.toLocaleString()}</Row>
        <Row label="Tool calls">{stats.toolCalls.toLocaleString()}</Row>
        {hasSubAgents && <Row label="Sub-agents">{stats.subAgents.toLocaleString()}</Row>}
        <Row label="Compactions">{stats.compactions.toLocaleString()}</Row>
        {stats.startedAt && <Row label="Started" title={exactStamp(stats.startedAt) ?? undefined}>{ageSpan(stats.startedAt, now)} ago</Row>}
        {stats.lastActivityAt && <Row label="Last active" title={exactStamp(stats.lastActivityAt) ?? undefined}>{ageSpan(stats.lastActivityAt, now)} ago</Row>}
        {Number.isFinite(span) && span > 0 && <Row label="Span">{formatRuntimeElapsed(span)}</Row>}
      </dl>

      <table className="w-full border-collapse tabular-nums">
        <thead>
          <tr className="text-[11px] text-muted-55">
            <th className="pb-1 text-left font-normal">Tokens</th>
            <th className="pb-1 text-right font-normal">{hasSubAgents ? "Thread" : ""}</th>
            {hasSubAgents && <th className="pb-1 text-right font-normal">Sub-agents</th>}
          </tr>
        </thead>
        <tbody>
          <TokenRow label="Input" pick={(t) => t.input} stats={stats} sub={hasSubAgents} />
          {/* Codex reports no cache writes, so its row would be a column of zeros. */}
          {stats.backend !== "codex" && <TokenRow label="Cache write" pick={(t) => t.cacheWrite} stats={stats} sub={hasSubAgents} />}
          <TokenRow label="Cache read" pick={(t) => t.cacheRead} stats={stats} sub={hasSubAgents} />
          <TokenRow label="Output" pick={(t) => t.output} stats={stats} sub={hasSubAgents} />
          <TokenRow label="Total" pick={total} stats={stats} sub={hasSubAgents} strong />
        </tbody>
      </table>

      {stats.models.length > 1 && (
        <table className="w-full border-collapse tabular-nums">
          <thead>
            <tr className="text-[11px] text-muted-55">
              <th className="pb-1 text-left font-normal">Model</th>
              <th className="pb-1 text-right font-normal">Requests</th>
              <th className="pb-1 text-right font-normal">Tokens</th>
            </tr>
          </thead>
          <tbody>
            {stats.models.map((row) => (
              <tr key={row.model}>
                <td className="truncate py-0.5 pr-3 font-mono text-[11.5px] text-muted">{row.model}</td>
                <td className="py-0.5 text-right">{row.requests.toLocaleString()}</td>
                <td className="py-0.5 text-right" title={`${total(row.tokens).toLocaleString()} tokens`}>{compactCount(total(row.tokens))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {stats.cost && (
        <p className="text-[11px] leading-relaxed text-muted-55">
          Cost is Claude Code's own estimate at API prices; on a subscription it is what the work would have cost, not a charge.
          {stats.cost.partial && " Requests since the session last stopped are not priced yet."}
        </p>
      )}
    </div>
  )
}

function Tile({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-border bg-panel-2/50 px-3 py-2" title={title}>
      <span className="text-[11px] text-muted-55">{label}</span>
      <span className="text-[17px] font-medium tabular-nums text-fg">{children}</span>
    </div>
  )
}

function Row({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="text-right tabular-nums text-fg" title={title}>{children}</dd>
    </>
  )
}

function TokenRow({ label, pick, stats, sub, strong }: { label: string; pick: (t: ThreadTokenUsage) => number; stats: ThreadStats; sub: boolean; strong?: boolean }) {
  const own = pick(stats.tokens)
  const child = pick(stats.subAgentTokens)
  const cell = `py-0.5 text-right ${strong ? "border-t border-border pt-1 font-medium text-fg" : "text-fg"}`
  return (
    <tr>
      <td className={`py-0.5 ${strong ? "border-t border-border pt-1 font-medium text-fg" : "text-muted"}`}>{label}</td>
      <td className={cell} title={`${own.toLocaleString()} tokens`}>{compactCount(own)}</td>
      {sub && <td className={cell} title={`${child.toLocaleString()} tokens`}>{compactCount(child)}</td>}
    </tr>
  )
}
