import { useSyncExternalStore } from "react"

// WHAT THE CENTER COLUMN SHOWS on All projects: the queue, or History — every project's Done threads, by day
// (plans/all-projects-first.md § Done, easily). Per tab and not remembered: a reload is back at the queue,
// which is what the page is for. The sidebar's Done tail opens History from its header (TierList.tsx).

export type CenterTab = "queue" | "history"

let tab: CenterTab = "queue"
const listeners = new Set<() => void>()

export function setCenterTab(next: CenterTab): void {
  if (tab === next) return
  tab = next
  for (const listener of listeners) listener()
}

export function useCenterTab(): CenterTab {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => tab,
    () => "queue",
  )
}
