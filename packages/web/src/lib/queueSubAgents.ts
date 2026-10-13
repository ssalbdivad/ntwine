import type { SubAgentView } from "@ntwine/shared"
import { runningOperations } from "./operationIndicators.ts"

export function runningQueueSubAgents(subAgents: readonly SubAgentView[]): readonly SubAgentView[] {
  return runningOperations(subAgents)
}
