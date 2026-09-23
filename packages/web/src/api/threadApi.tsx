import { createContext, useContext, type ReactNode } from "react"
import { projectRpc, rpc, type Api } from "./rpc.ts"

// WHICH PROJECT A SHARED THREAD CONTROL ACTS ON.
//
// The lifecycle verbs — Snooze, Mark as done — are one component each, drawn on the queue card, the
// thread drawer and the fullscreen page. Each called `rpc`, which addresses whatever project the ADDRESS
// BAR names; on a board that is the thread's own project by construction. The All queues page draws
// threads of EVERY project on a page that names none, where `rpc` means the launching project — so the
// same button there would snooze the launcher's `fix-auth` instead of the one on the card.
//
// A control reads its client from here. Absent a provider it is `rpc`, so every board surface behaves
// exactly as before without knowing this exists; the All queues page wraps each card in a provider
// naming the card's project.

interface ThreadScope {
  api: Api
  projectId: string
}

const ThreadScopeContext = createContext<ThreadScope | null>(null)

export function ThreadProjectScope({ projectId, children }: { projectId: string; children: ReactNode }) {
  return <ThreadScopeContext.Provider value={{ api: projectRpc(projectId), projectId }}>{children}</ThreadScopeContext.Provider>
}

/** The client a thread control must use: its thread's own project's, or the page's. */
export function useThreadApi(): Api {
  return useContext(ThreadScopeContext)?.api ?? rpc
}

/**
 * True when the control sits on a page showing ANOTHER project's thread.
 *
 * The page-level optimistic overlays (lib/optimisticArchive.ts, lib/steering.ts) are keyed by bare slug
 * and read by the page's own rail, so a scoped control must not write them: marking another project's
 * `fix-auth` archived would hide the page project's `fix-auth` from its rail until the overlay expired.
 */
export function useThreadIsForeignToPage(): boolean {
  return useContext(ThreadScopeContext) !== null
}
