import { useCallback } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useThreadProjectId } from "../api/threadApi.tsx"

/**
 * After a row's verb lands, re-read what the row was drawn from. Everything polls every project, so a
 * row asks for that poll now, and for its project's full board (Done, External), rather than showing the
 * old state for up to a poll. A row under no ThreadProjectScope (a fixture's) has nothing to re-read.
 */
export function useAfterScopedWrite(): () => void {
  const queryClient = useQueryClient()
  const projectId = useThreadProjectId()
  return useCallback(() => {
    if (!projectId) return
    void queryClient.invalidateQueries({ queryKey: ["projectsQueues"] })
    void queryClient.invalidateQueries({ queryKey: ["ofProject", projectId, "board"] })
  }, [queryClient, projectId])
}
