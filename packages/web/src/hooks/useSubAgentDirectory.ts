import { useQuery, type QueryClient } from "@tanstack/react-query"
import type { SubAgentDirectory } from "@ntwine/shared"
import type { Api } from "../api/rpc.ts"
import { useThreadApi, useThreadProjectId } from "../api/threadApi.tsx"
import { resolveSubAgentMention } from "../lib/threadMentions.ts"
import { openThread, pushSubAgentDrawer } from "../store.ts"

// A THREAD'S SUB-AGENT DIRECTORY — every child it ever dispatched, live and returned, with each one's
// `thread.child` address (the `subAgentDirectory` RPC). Read by the `@thread.` typeahead and by a click
// on a `@thread.child` link, through ONE cache key so the menu that offered a child and the link that
// names it later share the answer.
//
// The client is the thread control's own (useThreadApi): the page's project, or the card's on the
// cross-project page — the same project the prompt box's thread candidates come from, since a box on
// another project's card is offered none (useMentionCandidates). The project rides the key so two
// projects' same-slug threads never share a cache entry.
//
// STALE TIME is what keeps typing cheap: `@port-the-parser.c`, `.ca`, `.cac` all read the one answer the
// dot fetched. Ten seconds is long enough to cover a word and short enough that a child dispatched a
// moment ago shows up by the next time the dot is typed.
export const SUB_AGENT_DIRECTORY_STALE_MS = 10_000

export function subAgentDirectoryKey(projectId: string | undefined, slug: string) {
  return ["subAgentDirectory", projectId ?? "", slug] as const
}

export function useSubAgentDirectory(slug: string | undefined) {
  const api = useThreadApi()
  const projectId = useThreadProjectId()
  return useQuery({
    queryKey: subAgentDirectoryKey(projectId, slug ?? ""),
    queryFn: () => api.subAgentDirectory({ slug: slug! }),
    enabled: slug !== undefined,
    staleTime: SUB_AGENT_DIRECTORY_STALE_MS,
  })
}

/** The same answer on demand, for a click that has no hook to render with: served from the cache while
 *  it is fresh, fetched otherwise. */
export function fetchSubAgentDirectory(queryClient: QueryClient, api: Api, projectId: string | undefined, slug: string): Promise<SubAgentDirectory> {
  return queryClient.fetchQuery({
    queryKey: subAgentDirectoryKey(projectId, slug),
    queryFn: () => api.subAgentDirectory({ slug }),
    staleTime: SUB_AGENT_DIRECTORY_STALE_MS,
  })
}

/**
 * OPEN WHAT A `@thread.child` MENTION NAMES — the one click path behind a human's mention link
 * (MentionLinks.tsx) and an agent's (lib/thread-links.ts, for prose rendered through markdown). The
 * child is found by its folded address in the thread's directory, which keeps the children that have
 * already returned (David 2026-09-30: "some subagents are transient so probably we want to maintain
 * some history of completed subagents so we can reference the thread if needed"), and opens in its
 * sub-agent drawer. A child the directory does not know — a typo, a name since changed, a server that
 * cannot answer — opens its thread instead, which is where it would have been.
 */
export async function openSubAgentMention(queryClient: QueryClient, api: Api, projectId: string | undefined, slug: string, address: string): Promise<void> {
  const directory = await fetchSubAgentDirectory(queryClient, api, projectId, slug).catch(() => undefined)
  const entry = directory && resolveSubAgentMention(directory, address)
  if (entry) pushSubAgentDrawer(slug, entry.id, { label: entry.label, subagentType: entry.subagentType, startedAt: entry.startedAt })
  else openThread(slug)
}
