import type { QuestionAnswer } from "@ntwine/shared"
import { projectApiBase, projectRpc } from "../api/rpc.ts"
import { DELIVERY_SEND_TIMEOUT_MS, trackPendingSend, withDeliveryRetry } from "./eagerComposerSubmission.ts"
import { clearSteeredIn, markSteeredIn } from "./steering.ts"

export type ProjectFollowUpTarget = {
  projectId: string
  projectDir: string | undefined
  slug: string
  sessionId: string | undefined
}

export type ProjectFollowUpOptions = {
  /** Staged answers to registered questions carried in this same turn (FollowUpInput.answers). */
  answers?: QuestionAnswer[]
}

/**
 * A follow-up into a thread of ANY project, named by id — delivered the way the board's composer delivers
 * one: a refusal the server PROVED took no effect (runtime contention, a permission or model change
 * mid-flight, a control-plane restart) is waited out and retried under the same delivery id, which the
 * server's ledger dedupes; each attempt is bounded, so a hung request cannot hold the caller.
 *
 * Everything's cards (AllQueuesCard.tsx) and its project list's rows (Sidebar.tsx ThreadRow's Retry, under
 * a ThreadProjectScope) both send through here, because on that page the thread is usually not the page
 * project's and the page's own eager follow-up would address the wrong server.
 */
export function deliverProjectFollowUp(
  target: ProjectFollowUpTarget,
  message: string,
  options?: ProjectFollowUpOptions,
): Promise<void> {
  const deliveryId = crypto.randomUUID()
  const sessionId = target.sessionId ?? ""
  const answers = options?.answers?.length ? options.answers : undefined
  const pending = {
    deliveryId,
    apiBase: projectApiBase(target.projectId),
    projectDir: target.projectDir,
    slug: target.slug,
    sessionId,
    message,
    ...(answers ? { answers } : {}),
    at: Date.now(),
  }
  // The thread is working again the moment the message is sent, so its row in the project list says so
  // now rather than at the next poll (lib/steering.ts); a send that fails takes that back.
  markSteeredIn(target.projectId, target.slug)
  const sent = trackPendingSend(pending, () => withDeliveryRetry(async () => {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), DELIVERY_SEND_TIMEOUT_MS)
    try {
      await projectRpc(target.projectId).followUp(
        { slug: target.slug, sessionId, message, deliveryId, ...(answers ? { answers } : {}) },
        { signal: abort.signal },
      )
    } finally {
      clearTimeout(timer)
    }
  }, () => markSteeredIn(target.projectId, target.slug)))
  sent.catch(() => clearSteeredIn(target.projectId, target.slug))
  return sent
}
