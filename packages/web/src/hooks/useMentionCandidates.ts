import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { useSnapshot } from "valtio"
import type { ProjectQueue, ThreadView } from "@ntwine/shared"
import { rpc } from "../api/rpc.ts"
import { projectsQueuesQuery } from "../lib/projectsQueuesRead.ts"
import { store } from "../store.ts"
import { viewAt } from "../lib/pageView.ts"
import { crossProjectMentionCandidates, mentionCandidates, type MentionCandidate } from "../lib/threadMentions.ts"

/** Every open project's threads while the page shows All projects — the machine-wide poll the page
 *  itself draws from (same key), read here rather than fetched again. Undefined on a project's own page:
 *  a mention there means that project's threads alone. Read off the address rather than the router, so a
 *  prompt box on a fixture page with no router still renders. */
function useCrossProjectQueues(live: boolean): readonly ProjectQueue[] | undefined {
  const allProjects = typeof window !== "undefined" && viewAt(window.location.pathname).kind === "all"
  // Not live: subscribed to nothing. An observer that reads no field re-renders on EVERY change to the
  // entry (react-query's tracked props start empty and an empty set means "all"); `[]` means none.
  const queues = useQuery({ ...projectsQueuesQuery, enabled: allProjects && live, staleTime: 5_000, notifyOnChangeProps: live ? undefined : [] })
  return allProjects && live ? queues.data : undefined
}

/** The `@` typeahead's candidates for a prompt box: the threads of the project it writes to (`project`,
 *  the page's by default) minus the thread being written into, then — showing All projects — every other
 *  open project's (lib/threadMentions.ts crossProjectMentionCandidates). The box's own project comes from
 *  the page's board when that is it, which carries its done threads too, else from the poll; a mention
 *  never offers the wrong project's thread under the right one's name. */
//
// `live: false` computes nothing and SUBSCRIBES to nothing that moves: a box that is not being typed into
// has no menu to fill. A queue card passes it until its draft holds an `@` (AllQueuesCard ReplyBox): its
// candidates walked every thread of the board, so every board delta and every poll re-rendered every
// card's reply box — 244 of them, 1.3s of a 4.9s stall on a 244-card mirror (2026-10-02). The board's
// slug is still read, because a valtio snapshot that reads NOTHING re-renders on every store change.
export function useMentionCandidates(excludeSlug?: string, project?: string, live = true): MentionCandidate[] {
  const snap = useSnapshot(store)
  const boardSlug = snap.board?.projectSlug
  const queues = useCrossProjectQueues(live)
  const home = project ?? boardSlug
  const onBoard = project === undefined || boardSlug === project
  const threads = !live
    ? undefined
    : onBoard
      ? (snap.board?.threads as readonly ThreadView[] | undefined)
      : (queues?.find((queue) => queue.projectSlug === project)?.threads as readonly ThreadView[] | undefined)
  return useMemo(() => {
    if (!live) return NO_CANDIDATES
    const own = threads ? mentionCandidates(threads, excludeSlug) : []
    return queues ? [...own, ...crossProjectMentionCandidates(queues, home, own)] : own
  }, [live, threads, excludeSlug, queues, home])
}
const NO_CANDIDATES: MentionCandidate[] = []

/** The thread `slug` itself as a mention candidate, offered last in its OWN prompt box and the head a
 *  dotted `@this-thread.child` resolves against there (Composer `ownMention`). From the page's board only, when that is the
 *  box's project. */
export function useOwnMention(slug: string, project?: string, live = true): MentionCandidate | undefined {
  const snap = useSnapshot(store)
  const boardSlug = snap.board?.projectSlug
  // Not live: as useMentionCandidates — nothing walked, nothing subscribed but the slug.
  const threads = live && (project === undefined || boardSlug === project) ? (snap.board?.threads as readonly ThreadView[] | undefined) : undefined
  return useMemo(() => (threads ? mentionCandidates(threads.filter((t) => t.id === slug))[0] : undefined), [threads, slug])
}
