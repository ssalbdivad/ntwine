import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { BatteryWarning, ExternalLink, X } from "lucide-react"
import type { ThreadView } from "@ntwine/shared"
import { rpc } from "../api/rpc.ts"
import { spanUntil } from "../lib/activityTime.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { PROVIDER_LABEL } from "../lib/signIn.ts"
import { QUOTA_ALERT_LINKS, dismissQuotaAlert, isQuotaAlertDismissed, quotaAlerts, readDismissedQuotaAlerts, type QuotaAlert } from "../lib/quotaAlert.ts"
import { CARD_ACTION_RADIUS, CARD_BODY, CARD_PRIMARY_ACTION, CardActions, TranscriptCard } from "./TranscriptCard.tsx"

/**
 * The low-quota alerts at the head of the queue (lib/quotaAlert.ts says when one appears). Reads the same
 * `quota` / `authStatus` queries the status row's chips poll, so it costs no fetch of its own and tracks
 * the chip within one poll.
 */
export function QuotaAlerts({ threads }: { threads: readonly ThreadView[] }) {
  const quota = useQuery({ queryKey: ["quota"], queryFn: () => rpc.quota(), refetchInterval: 30_000, staleTime: 10_000 })
  const auth = useQuery({ queryKey: ["authStatus"], queryFn: () => rpc.authStatus(), staleTime: 30_000 })
  const [dismissed, setDismissed] = useState(readDismissedQuotaAlerts)
  const alerts = useMemo(
    () => quotaAlerts(quota.data, auth.data, threads).filter((alert) => !isQuotaAlertDismissed(alert, dismissed)),
    [quota.data, auth.data, threads, dismissed],
  )
  if (alerts.length === 0) return null
  return (
    <div data-quota-alerts className="mb-10 flex flex-col gap-4 px-[21px]">
      {alerts.map((alert) => (
        <QuotaAlertCard key={alert.key} alert={alert} onDismiss={() => setDismissed(dismissQuotaAlert(alert.key))} />
      ))}
    </div>
  )
}

function QuotaAlertCard({ alert, onDismiss }: { alert: QuotaAlert; onDismiss: () => void }) {
  const now = useNowMs()
  const provider = PROVIDER_LABEL[alert.backend]
  const resets = alert.window.resetsAt ? spanUntil(new Date(alert.window.resetsAt * 1000).toISOString(), now) : null
  const [primary, ...rest] = QUOTA_ALERT_LINKS[alert.backend]
  return (
    <TranscriptCard
      data-quota-alert={alert.backend}
      tone={alert.remaining <= 3 ? "danger" : "caution"}
      icon={BatteryWarning}
      label={`${provider} ${windowName(alert.window.label)}: ${alert.remaining}% left`}
      aside={
        <button
          type="button"
          aria-label="Dismiss"
          title="Dismiss until this window resets"
          onClick={onDismiss}
          className="-m-1 flex size-6 shrink-0 items-center justify-center rounded text-muted-60 outline-none transition-colors hover:bg-panel hover:text-fg focus-visible:ring-1 focus-visible:ring-border-strong"
        >
          <X size={14} />
        </button>
      }
    >
      <p className={CARD_BODY}>
        {alert.running === 1 ? "1 running thread" : `${alert.running} running threads`} will pause when it runs out
        {resets ? `. It resets in ${resets}.` : "."}
      </p>
      <CardActions>
        {primary && (
          <a href={primary.href} target="_blank" rel="noreferrer" className={CARD_PRIMARY_ACTION}>
            {primary.label}
            <ExternalLink size={11} aria-hidden />
          </a>
        )}
        {rest.map((link) => (
          <a
            key={link.href}
            href={link.href}
            target="_blank"
            rel="noreferrer"
            className={`flex shrink-0 items-center gap-1 ${CARD_ACTION_RADIUS} border border-border px-2 py-1 text-[11px] text-fg/90 transition-colors hover:border-border-strong hover:bg-panel`}
          >
            {link.label}
            <ExternalLink size={11} aria-hidden />
          </a>
        ))}
      </CardActions>
    </TranscriptCard>
  )
}

/** "5h" → "5h limit", "Weekly" → "weekly limit"; any other window (Opus wk) keeps its own label. */
function windowName(label: string): string {
  if (label === "5h") return "5h limit"
  if (label === "Weekly") return "weekly limit"
  return `${label} limit`
}
