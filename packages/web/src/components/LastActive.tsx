import type { ReactNode } from "react"
import { activityTimestamp, formatLastActive } from "../lib/activityTime.ts"
import { useNowMs } from "../lib/liveClock.ts"

/** `lead` renders just before the time and only with it — a separator that must not dangle when there
 *  is no time to show. */
export function LastActive({ at, fallbackAt, className = "", lead }: { at: string | undefined; fallbackAt?: string; className?: string; lead?: ReactNode }) {
  const now = useNowMs()
  const timestamp = activityTimestamp(at, fallbackAt)
  const label = formatLastActive(timestamp, now)
  if (!label || !timestamp) return null
  return (
    <>
      {lead}
      <time dateTime={timestamp} className={className}>
        {label}
      </time>
    </>
  )
}
