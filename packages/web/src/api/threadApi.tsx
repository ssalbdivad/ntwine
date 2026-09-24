import { createContext, useContext, type ReactNode } from "react"
import { useProjectDir } from "../lib/drafts.ts"
import { projectApiBase, projectRpc, rpc, type Api } from "./rpc.ts"
import { apiBase } from "../lib/base-path.ts"

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
  projectDir: string | undefined
}

const ThreadScopeContext = createContext<ThreadScope | null>(null)

export function ThreadProjectScope({ projectId, projectDir, children }: { projectId: string; projectDir: string | undefined; children: ReactNode }) {
  return <ThreadScopeContext.Provider value={{ api: projectRpc(projectId), projectId, projectDir }}>{children}</ThreadScopeContext.Provider>
}

/**
 * The directory a thread control files its DRAFTS under (lib/drafts.ts keys them by project directory):
 * its thread's project's, or the page's. The page's is the board in the store, which on the cross-project
 * page is the FOCUS — so a line typed into another project's card was filed under whichever project was
 * focused, and vanished from the box the moment the focus moved.
 */
export function useThreadProjectDir(): string | undefined {
  const scope = useContext(ThreadScopeContext)
  const pageDir = useProjectDir()
  return scope ? scope.projectDir : pageDir
}

/** The client a thread control must use: its thread's own project's, or the page's. */
export function useThreadApi(): Api {
  return useContext(ThreadScopeContext)?.api ?? rpc
}

/** The same choice for a control that opens its own connection — a terminal's `/term/<slug>` socket. */
export function useThreadApiBase(): string {
  const scope = useContext(ThreadScopeContext)
  return scope ? projectApiBase(scope.projectId) : apiBase()
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
