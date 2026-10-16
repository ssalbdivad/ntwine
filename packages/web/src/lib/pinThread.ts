import { useCallback } from "react"
import type { ThreadView } from "@ntwine/shared"
import { useThreadApi, useThreadProjectId } from "../api/threadApi.tsx"
import { isPinned } from "../groups.ts"
import { showToast } from "../store.ts"
import { threadKey } from "./allQueues.ts"
import { clearPinned, markPinned, PIN_OPTIMISM_MS, usePinOverrides } from "./optimisticPin.ts"
import { useAfterScopedWrite } from "./scopedWrite.ts"

/**
 * Pin or unpin a thread: the row's hover pin, the ⋯ menu's item and `p` all go through here. Reads the
 * optimistic overlay too, so a second `p` pressed before the board confirms the first undoes it rather
 * than repeating it.
 */
export function usePinToggle(t: ThreadView): { pinned: boolean; toggle: () => void } {
  const api = useThreadApi()
  const projectId = useThreadProjectId()
  const afterWrite = useAfterScopedWrite()
  const override = usePinOverrides()[projectId ? threadKey(projectId, t.id) : ""]
  const pinned = override && Date.now() - override.at <= PIN_OPTIMISM_MS ? override.pinned : isPinned(t)
  const toggle = useCallback(() => {
    if (projectId) markPinned(projectId, t.id, !pinned)
    api
      .setThreadPinned({ slug: t.id, sessionId: t.sessionId ?? "", pinned: !pinned })
      .then(afterWrite)
      .catch((error: unknown) => {
        if (projectId) clearPinned(projectId, t.id)
        showToast(`${pinned ? "Unpin" : "Pin"} failed: ${String(error instanceof Error ? error.message : error).slice(0, 80)}`)
      })
  }, [api, projectId, afterWrite, t.id, t.sessionId, pinned])
  return { pinned, toggle }
}
