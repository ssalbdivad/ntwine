// ONE QUEUE CARD ON THE CROSS-PROJECT PAGE — a thread of ANY project, in either of the page's views:
// focused on one project, or All projects, where the cards of every project share one queue.
//
// It wears the queue card a project's own board drew until 2026-09-28 (TodosView QueueCard): the same
// bordered, shadowed shell, the same header with the title and its rest time, the human's last message
// as their bubble, the handoff as prose with its ```done card (fenced or registered), the thread's registered questions, a reply box, and the lifecycle footer's
// Snooze and Mark as done. What it deliberately does NOT carry is the transcript — the tool calls, the
// earlier rounds, the sub-agent rows. That is the next level down, one click away IN PLACE — the title,
// and "Show earlier messages" at the card's top, open the thread's own drawer on this page
// (useOpenThreadInPlace) — and it is what makes a page of
// every project's queue readable at all. The ↗ into a project's view went on 2026-09-28 (maintainer: "too
// many places in the ui where it is easy to navigate to a ui which is not the primary home ui"); the ⤢
// into the fullscreen page followed on 2026-10-15, with the page itself.
// The header's collapse (upstream's per-card fold, 2026-10-06) folds the card to its header.
//
// THE CARD NEVER ASKS THE PAGE WHICH PROJECT IT IS. Everything that could — the RPC client, the query
// cache, the markdown's repo and paths, the lifecycle buttons, the question drafts — is handed the
// card's own project explicitly (see the provider stack at the bottom). The board's queue card could not
// be reused here for exactly that reason: it read its project from the address bar, the store and the
// page's socket, and on this page all three name the FOCUSED project, which is usually not the card's.
import { memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, CheckCheck, ChevronRight, ChevronsDownUp, ChevronsUpDown, RotateCcw } from "lucide-react"
import { useNavigate } from "react-router"
import { expandUserCommandDraft, heldQuestionViews, parseParkWake, parseScheduledRunPrompt, type AccountBackend, type AwaitingHint, type ThreadView } from "@ntwine/shared"
import { projectApiBase, projectRpc } from "../api/rpc.ts"
import { ThreadProjectScope } from "../api/threadApi.tsx"
import { prefetchProjectTranscript } from "../hooks.ts"
import { ThreadMenu, ThreadTerminalButton } from "./ThreadMenu.tsx"
import { displayTitle, offersRetry, queueLabelAt, queueLabelWord } from "../groups.ts"
import { ScheduleMark } from "./ScheduleMark.tsx"
import { useMentionCandidates, useOwnMention } from "../hooks/useMentionCandidates.ts"
import { answerProse, handoffParts, projectMarkdownScope, sameProjectAddress, squareCard, threadKey, type QueuesProject } from "../lib/allQueues.ts"
import { draftKey, draftStore, useDraftValues } from "../lib/drafts.ts"
import { buildMessageWithContext, type ComposerContextItem } from "../lib/composerContext.ts"
import { restoreContextItems, takeContextItems, useStagedContextSources, useStagedContextTokens } from "../lib/stagedContext.ts"
import { openLocalPath } from "../lib/local-file-links.ts"
import { pageUnloading } from "../lib/pendingSends.ts"
import { deliverProjectFollowUp } from "../lib/projectFollowUp.ts"
import { STALLED_RETRY_MESSAGE } from "../lib/retrySession.ts"
import { parseAccountAlias } from "../lib/signIn.ts"
import { TRANSCRIPT_META_LABEL_CLASS, transcriptMetaChevronClass } from "../lib/transcriptMetaLabels.ts"
import { isPlainLeftClick } from "../lib/plainClick.ts"
import { useMarkdownHtml } from "../lib/useMarkdown.ts"
import { drawnHeight, observeCardSlot, whenCardRendered } from "../lib/cardVisibility.ts"
import { IN_PLACE_OPEN_STATE, openThread, pushTerminalDrawer, showToast, store } from "../store.ts"
import { crossProjectHref, innerPath, projectSlug } from "../lib/base-path.ts"
import { GithubWatchRows, LimitPauseNotice, QueueDismissContext, TerminalNetCard } from "./ChatView.tsx"
import { isLimitPaused } from "../lib/limitPause.ts"
import { registeredDoneBody, showsRegisteredDoneCard } from "../lib/registeredDone.ts"
import { ThreadStatusLine } from "./ThreadStatusLine.tsx"
import { Composer } from "./Composer.tsx"
import { fetchThreadSkills, fetchUserCommands, mergeSlashItems, useUserCommands } from "../hooks/useUserCommands.ts"
import { InteractionStack } from "./InteractionCards.tsx"
import { AwaitingSubAgentsCard } from "./AwaitingSubAgentsCard.tsx"
import { AwaitingBackgroundCard, showsRestingCard, WaitRowOpenContext } from "./AwaitingBackgroundCard.tsx"
import { drawsSubAgentWaitCard, showsSubAgentWait } from "../lib/subAgentWait.ts"
import { useThreadComposerControls } from "../hooks/useThreadComposerControls.tsx"
import { UpdateRequestedMarker } from "./NtwineWake.tsx"
import { SpinoffButton, SpinoffOf } from "./Spinoff.tsx"
import { HEADER_ICON_CLASS } from "../lib/headerIcon.ts"
import { LastActive } from "./LastActive.tsx"
import { HeldThreadComposer, TodoSteps } from "./HeldThreadBox.tsx"
import { ProjectSquare } from "./ProjectSquare.tsx"
import { LinkedHtml } from "./LinkedHtml.tsx"
import { QuestionBlockCard } from "./QuestionBlockCard.tsx"
import { openQuestionsOf, RegisteredAnsweringContext, RegisteredAnsweringProvider, RegisteredQuestionStack, SettledQuestionStack, useSettledQuestions, type SettledQuestion } from "./RegisteredQuestionCards.tsx"
import { cardTranscriptQuery, useCardTranscript } from "../hooks/useCardTranscript.ts"
import { handoffQuestionSlots } from "../lib/queueCardQuestions.ts"
import { RestedCard, showsRestedCard } from "./RestedCard.tsx"
import { LogoutConfirmModal, SignInModal } from "./SignInModal.tsx"
import { QueueChildOps } from "./QueueChildOps.tsx"
import { QueueOpsSummary } from "./QueueOpsSummary.tsx"
import { ThreadLinks } from "./ThreadLinks.tsx"
import { queueOpsCounts } from "../lib/queueOpsCounts.ts"
import { trackQueueDock } from "../lib/queueDockInset.ts"
import { ThreadLifecycleActions } from "./ThreadLifecycle.tsx"
import { RecurringPromptControl } from "./RecurringPromptControl.tsx"
import { ContextFact, FACTS_LINE_CLASS, Fact, FactSep, GoalLoopFact } from "./ThreadHeaderFacts.tsx"
import { DeadlineFact } from "./DeadlineControl.tsx"
import { focusedProject, openProcessDrawer, ThreadProcessStrip } from "./ThreadTerminals.tsx"
import { TerminalCardArticle } from "./TerminalQueueCard.tsx"
import type { ThreadProcess } from "../lib/threadProcesses.ts"
import { ThreadCheckoutToken } from "./ThreadCheckoutToken.tsx"
import { Tooltip } from "./Tooltip.tsx"
import { BLOCK_RADIUS, BLOCK_RADIUS_INNER_BOTTOM, CardActions, QUEUE_WRAP, TranscriptCard } from "./TranscriptCard.tsx"
import { DoneWatchButtons, doneWatchable, useDoneWatchRefs } from "./DoneWatchButtons.tsx"
import { useFileDropZone, useFileIntakeHandle, type SurfaceFileDrop } from "../lib/fileDrop.ts"

/**
 * WHOSE CARD THIS IS, on its meta line — in All projects the page's one queue holds every project's
 * threads, and the lanes that used to say whose they were are gone (lib/allQueues.ts mergedQueue). A
 * focused view shows one project's cards, so it draws no chip (AllQueues.tsx passes `chip={!focused}`).
 * Given `onChoose` it is a button that focuses the page on the project — navigates to its
 * board, `/project/<slug>` (lib/pageView.ts projectViewHref), the same place the dock
 * goes; it filtered the queue in place until focus mode retired the queue filter on 2026-09-29.
 * Without it, plain text, for a line that already sits inside a control (the command card's open button).
 * `square: false` drops its 12px square, for a card that already leads with the project's ProjectMark.
 */
export function ProjectChip({ project, onChoose, square = true }: { project: QueuesProject; onChoose?: (project: QueuesProject) => void; square?: boolean }) {
  const body = (
    <>
      {/* ON THE NAME'S CAP BAND: a filled square has no baseline of its own, so it sits ON the name's and is
          lowered by half its height less half a cap — computed by the browser, right in any font at any
          size (the prompt box's project picker places its square the same way). */}
      {square && (
        <span className="flex shrink-0 self-baseline translate-y-[calc(6px_-_0.5cap)]">
          <ProjectSquare project={squareCard(project)} size={12} />
        </span>
      )}
      <span className="min-w-0 truncate">{project.name}</span>
    </>
  )
  // Beside a mark the name is the card's second project signal, set a step above the grey time it leads.
  const className = `flex min-w-0 shrink items-baseline gap-1.5 ${square ? "text-fg/80" : "font-medium text-fg/90"}`
  if (!onChoose) return <span data-xq-chip={project.id} className={className}>{body}</span>
  return (
    <button
      type="button"
      title={`Show only ${project.name}`}
      data-xq-chip={project.id}
      onClick={() => onChoose(project)}
      className={`${className} cursor-pointer rounded-sm border-0 bg-transparent p-0 text-left underline-offset-2 outline-none transition-colors hover:text-fg hover:underline focus-visible:ring-1 focus-visible:ring-border-strong`}
    >
      {body}
    </button>
  )
}

/**
 * THE PROJECT'S LOGO, leading a card's header on a queue that holds several projects — its icon, or its
 * monogram tile, small (ProjectSquare.tsx). The 12px square on
 * the meta line said whose a card was only to someone reading that line; a column of cards is scanned
 * down its left edge, so that is where the mark sits, big enough to pick one project's cards out of a
 * page of them without reading a word (David 2026-09-29: "a more visible indicator of the project
 * name/logo … so users can easily visually filter through"). Given `onChoose` it focuses the page on the
 * project, as the chip beside it does; it is out of the tab order because that chip is the same control.
 */
export function ProjectMark({ project, onChoose }: { project: QueuesProject; onChoose?: (project: QueuesProject) => void }) {
  const square = <ProjectSquare project={squareCard(project)} size={PROJECT_MARK_PX} />
  if (!onChoose) return <span data-xq-mark={project.id} aria-hidden className="flex shrink-0">{square}</span>
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden
      title={`Show only ${project.name}`}
      data-xq-mark={project.id}
      onClick={() => onChoose(project)}
      className="flex shrink-0 cursor-pointer rounded-[30%] border-0 bg-transparent p-0 transition-opacity hover:opacity-80"
    >
      {square}
    </button>
  )
}

/** The mark's side: the header's two lines (a 15px title over the 11px meta line) are ~36px of type. */
const PROJECT_MARK_PX = 32

/** A thread opened IN PLACE on the cross-project page: the page focused on its project, its drawer open. */
export function crossProjectThreadHref(project: Pick<QueuesProject, "slug">, slug: string): string {
  return `${crossProjectHref(encodeURIComponent(project.slug))}/thread/${encodeURIComponent(slug)}`
}

/**
 * Open a thread of ANY project in place — the cross-project page's one verb for "show me this thread".
 *
 * A thread of the focused project whose board is already in the store opens the way its row in the
 * project list opens one (`openThread`: the drawer animates in and the store writes the URL). Any other thread moves
 * the focus there by URL, which rebinds the page project and opens the drawer once its board lands
 * (routes.tsx CrossProjectPage → store.resolveRoutedThread).
 *
 * THAT DRAWER IS SECONDS AWAY, SO ITS FRAME IS NOT. The rebind re-renders the whole page for the new
 * project and the drawer cannot exist until that project's board has landed: measured 2026-10-01 on a
 * loaded WSL box, a click on "Show earlier messages" drew nothing for 4–6s, then the transcript 3s after
 * that. So the click first puts the drawer's frame on screen (store.pendingOpen → PendingThreadSheet) and
 * starts reading the transcript through the thread's own project, and only navigates once the frame has
 * painted — the rebind's render would otherwise hold the frame's first paint hostage too. The real drawer
 * takes the frame's place, already open, with the transcript waiting in the cache.
 */
export function useOpenThreadInPlace(): (project: Pick<QueuesProject, "slug" | "id" | "name">, slug: string, title?: string) => void {
  const navigate = useNavigate()
  const qc = useQueryClient()
  return useCallback(
    (project, slug, title) => {
      // The focus AS OF THE CLICK, read off the address bar — never the one this component last rendered
      // with. react-router renders a location change as a transition, and under load the page it leads to
      // took up to 1.8s to commit, so for that long the page on screen was the one BEFORE it, clickable,
      // its render-time focus naming the project of a drawer that had just closed. A click on that
      // project's card then took the store-first open below on a page already rebinding to the pick: the
      // address writer refused to name a board the page no longer owned, the rebind swept the drawer away,
      // and the click did nothing. The address has moved on the moment the router has, so it cannot lag.
      const focus = projectSlug()
      if (project.slug === focus && store.board?.projectSlug === focus) {
        openThread(slug)
        return
      }
      const pending = { projectSlug: project.slug, projectName: project.name, slug, title: title ?? slug }
      store.pendingOpen = pending
      prefetchProjectTranscript(qc, project, slug)
      // rAF runs before the frame's paint and a timeout queued from it after, so the navigation's render
      // starts once the frame is on screen. An open closed or replaced in between never navigates.
      requestAnimationFrame(() => window.setTimeout(() => {
        if (store.pendingOpen?.slug !== pending.slug || store.pendingOpen.projectSlug !== pending.projectSlug) return
        navigate(crossProjectThreadHref(project, slug), { state: IN_PLACE_OPEN_STATE })
      }, 0))
    },
    [navigate, qc],
  )
}

/** A thread of a queue card's project by slug, for a line that names another thread of it (SpinoffOf): the
 *  project's own open rows, then the page's board when the page is showing that project (a done thread is
 *  on the board and in no queue). Never another project's board — a same-named slug there is not this. */
function queueThread(project: QueuesProject, slug: string): ThreadView | undefined {
  return project.queued.find((t) => t.id === slug)
    ?? project.running.find((t) => t.id === slug)
    ?? project.snoozed.find((t) => t.id === slug)
    ?? (store.board?.projectSlug === project.slug ? store.board.threads.find((t) => t.id === slug) : undefined)
}

/** A follow-up into another project's thread (lib/projectFollowUp.ts, which the project list's Retry shares). */
function deliverFollowUp(project: QueuesProject, thread: ThreadView, message: string): Promise<void> {
  return deliverProjectFollowUp({ projectId: project.id, projectDir: project.projectDir, slug: thread.id, sessionId: thread.sessionId }, message)
}

const noop = () => {}

/** The collapsed body's height: enough for a verdict line and the paragraph under it, never a wall. */
const CLAMP_PX = 188

export interface AllQueuesCardProps {
  project: QueuesProject
  thread: ThreadView
  leaving: boolean
  /**
   * Its thread left the queue while the card was on screen, and not by the human's hand in this tab
   * (lib/stableQueue.ts): the card holds its place as an empty gap of its own height, out of reach of
   * the pointer and the keyboard, until it is closed (AllQueues.tsx) or the thread rests again.
   */
  ghost?: boolean
  /** Said on the meta line in place of the time the card was ready, WITHOUT a ghost's dimming: a held
   *  card (`onHold`) whose worker is at work on the answer it sent. */
  status?: string
  /**
   * Its drawer is open, where it is read: the card stays drawn in its place in the queue, inert — out of
   * the tab order and out of reach of a click — so the drawer is the one live copy (AllQueues.tsx).
   */
  concealed?: boolean
  /** The card has been acted on — answered, replied to, snoozed or finished — so it fades out now. */
  onLeave: () => void
  /** The action failed after the card had already faded: put it back. */
  onReturn: () => void
  /** A reply, Retry or Mark as done went out: the card leaves, and stays gone while it is on the wire.
   *  `onLeave` when absent. */
  onSent?: () => void
  /** It landed, so the wait for its thread to leave the queue starts now (AllQueues useLeavingCards). */
  onLanded?: () => void
  /** A question on the card was answered and the worker went to work on it, while the card still asks
   *  more: keep it where it is, live, although its thread leaves the queue (AllQueues useLeavingCards). */
  onHold?: () => void
  /** Lead the meta line under the title with the card's project, on a queue that holds several
   *  (ProjectChip) — a flag and a stable chooser rather than the element, which would be a new object on
   *  every render of the queue and so re-render the card every time (sameCard). */
  chip?: boolean
  /** What choosing the chip does: focus the page on the card's project (its board, `/project/<slug>`). */
  onChoose?: (project: QueuesProject) => void
}

export const AllQueuesCard = memo(function AllQueuesCard(props: AllQueuesCardProps) {
  const { project, thread, leaving, ghost, concealed = false } = props
  const key = threadKey(project.id, thread.id)
  // BUILT ONLY NEAR THE SCREEN (lib/cardVisibility.ts): until then the slot holds a stand-in of the guessed
  // height, and the slot's ref is told when to build the card — as it comes within a viewport of the
  // screen, before the first paint for one already there, or in idle time. Once built it stays built.
  // `data-near` on the slot is that module's too, never React's: within a viewport of the screen the
  // browser draws the card, further off it skips it.
  const [built, setBuilt] = useState(false)
  // Its handoff is fetched ahead of the build (cardVisibility.ts `prefetch`), under the key the card reads
  // it by — from the props it has WHEN it runs, since a thread that rests again meanwhile has a new handoff.
  const queryClient = useQueryClient()
  const latest = useRef(props)
  latest.current = props
  const slotRef = useCallback((slot: HTMLDivElement | null) => observeCardSlot(
    slot,
    () => setBuilt(true),
    () => {
      const { project: p, thread: t } = latest.current
      // A terminal's card reads its screen over /term, not a handoff.
      if (t.kind === "terminal") return Promise.resolve()
      // …and the transcript its open questions are placed by (cardNeedsTranscript), so they land with the
      // handoff rather than a round trip after it. One promise, so the prefetch's concurrency counts both.
      return Promise.all([
        queryClient.prefetchQuery(handoffQuery(p, t)),
        cardNeedsTranscript(t) ? queryClient.prefetchQuery(cardTranscriptQuery(p, t)) : undefined,
      ])
    },
  ), [queryClient])
  // A card mounted again starts at the height it was last drawn at, not the guess (cardVisibility.ts
  // `drawnHeight`): the inline intrinsic size sizes it while it is skipped, the stand-in while it is near.
  const [remembered] = useState(() => drawnHeight(key))
  return (
    <div ref={slotRef} data-xq-card={key} data-queue-leaving={leaving} data-queue-ghost={ghost || undefined} aria-hidden={ghost || undefined} data-queue-concealed={concealed || undefined} inert={concealed || ghost} className="ntwine-card-slot min-w-0" style={remembered ? { containIntrinsicBlockSize: `auto ${remembered}px` } : undefined}>
      <div className="ntwine-card-clip min-h-0 min-w-0">
        {built ? (thread.kind === "terminal" ? <TerminalCardArticle {...props} /> : <CardArticle {...props} />) : <CardStandIn thread={thread} height={remembered} />}
      </div>
    </div>
  )
}, sameCard)

/** The card's handoff query, for the card and for the prefetch ahead of its build (one key, one fetch). */
function handoffQuery(project: QueuesProject, thread: ThreadView) {
  // KEYED ON THE REST, so a thread that rests again fetches its new handoff, and one that has not moved
  // is read exactly once however often the page polls.
  return {
    queryKey: ["ofProject", project.id, "handoff", thread.id, thread.lastAssistantAt ?? ""],
    queryFn: () => projectRpc(project.id).threadHandoff({ slug: thread.id }),
    staleTime: Infinity,
  }
}

/**
 * A card not built yet, far from the screen: its frame and its title, at the height every unbuilt card is
 * guessed at (styles.css `.ntwine-card-slot`'s intrinsic size — the same number, so the browser remembers
 * the guess and not a short stand-in if it ever draws one). Nothing in it takes focus or a click: the card
 * replaces it before anyone can reach it, and a link here would be swapped out from under the focus.
 */
function CardStandIn({ thread, height }: { thread: ThreadView; height?: number }) {
  return (
    <article
      data-xq-card-stand-in
      aria-label={displayTitle(thread)}
      style={height ? { height } : undefined}
      className={`ntwine-card-body flex h-[540px] min-w-0 max-w-full flex-col ${BLOCK_RADIUS} border border-border-strong bg-panel shadow-lg shadow-shadow-ink/25`}
    >
      <header className="rounded-t-xl border-b border-border/60 px-5 py-3.5">
        <h3 className="truncate text-[15px] font-semibold leading-snug">{displayTitle(thread)}</h3>
      </header>
    </article>
  )
}

function CardArticle({
  project,
  thread,
  onLeave,
  onReturn,
  onSent = onLeave,
  onLanded = noop,
  onHold,
  chip = false,
  onChoose,
  status,
}: AllQueuesCardProps) {
  const api = projectRpc(project.id)
  const chipNode = chip ? <ProjectChip project={project} onChoose={onChoose} square={false} /> : undefined
  const openInPlace = useOpenThreadInPlace()
  // The previous handoff stays on screen while the next one loads rather than blanking the card.
  const handoff = useQuery({
    ...handoffQuery(project, thread),
    placeholderData: (previous) => previous,
  })
  const text = handoff.data?.text
  const parts = useMemo(() => (text ? handoffParts(text, thread.questions) : null), [text, thread.questions])
  // The reply to the human's message when wakes rested after it (router handoffOf): its prose alone, since
  // its fences were superseded by the newest rest's — and none of it under a done, which says it all,
  // unless the answer signed off done itself.
  const answer = handoff.data?.answer
  const registeredDone = showsRegisteredDoneCard(thread, text)
  const answerDone = handoff.data?.answerDone ?? false
  const answered = useMemo(() => answerProse(answer, parts, registeredDone, thread.questions, answerDone), [answer, parts, registeredDone, thread.questions, answerDone])
  // Does the awaiting card list the children, or the ops column under the reply box (QueueChildOps)?
  const drawsSubAgentWait = drawsSubAgentWaitCard(thread, parts?.fences)
  // Is the thread at rest on its own declared wait, so the RESTING card states it (CardAwaiting)? The
  // drawer's predicate, unchanged — except where the sub-agent batch card is already stating the wait.
  const restingShown = showsRestingCard(thread) && !drawsSubAgentWait
  const cardReply = useCardReply(project, thread, onLanded)
  // EACH QUESTION AT THE REST THAT ASKED IT (upstream e157817a, 22084580). This card is three rests at
  // most — the one before the human's bubble, the one its `answer` replies with, the newest — and a
  // question belongs to whichever its rest is, by the drawer's own readers over the thread's transcript
  // (lib/queueCardQuestions.ts). It drew every open question under the newest rest until 2026-10-06, so an
  // ask two rests old read as the newest rest's sign-off and hid the rested card that bare rest is owed.
  // The transcript is read only while a question is open (cardNeedsTranscript); until it lands the
  // stacks wait rather than drawing at the tail and then moving, and if it cannot be read they fall back
  // to the tail, where they used to be — never off the card.
  // FOLDED TO ITS HEADER (upstream's per-card collapse, TodosView): no body, no dock.
  const [collapsed, setCollapsed] = useState(false)
  // A FILE DROPPED ANYWHERE ON THE CARD goes into its prompt box, exactly as one dropped on the box does
  // (upstream 8a945245; maintainer 2026-10-12: "drag a file anywhere onto a card in the queue in order to
  // drop it into the chat"). The card is the zone and the box the intake (lib/fileDrop). A collapsed card
  // has no box, so the drop opens it and the box takes the file as it mounts.
  const fileIntake = useFileIntakeHandle()
  const fileDropZone = useFileDropZone((files) => {
    fileIntake.give(files)
    setCollapsed(false)
  })
  const composerFileDrop = useMemo(() => ({ over: fileDropZone.over, intake: fileIntake }), [fileDropZone.over, fileIntake])
  const needsTranscript = cardNeedsTranscript(thread)
  const transcript = useCardTranscript(project, thread, needsTranscript)
  const messages = transcript.data?.messages
  const settledScope = useMemo(() => ({ api, projectId: project.id }), [api, project.id])
  // ANSWERED questions keep their rest too (the drawer's SettledQuestionStack, which only ChatView drew).
  const settledQuestions = useSettledQuestions(thread, { scope: settledScope, enabled: needsTranscript })
  // The drawer's open set (openQuestionsOf: minus any already drawn settled), so the card and the drawer
  // agree on which rest each question belongs to — less every one the human typed past, which holds
  // nothing and is answered in the thread, where it was asked (heldQuestionViews).
  const openQuestions = useMemo(() => heldQuestionViews(openQuestionsOf(thread, settledQuestions)), [thread, settledQuestions])
  const slots = useMemo(() => {
    if (messages) return handoffQuestionSlots(messages, openQuestions, settledQuestions)
    if (needsTranscript && !transcript.isError) return null
    return handoffQuestionSlots([], openQuestions, [])
  }, [messages, needsTranscript, transcript.isError, settledQuestions, openQuestions])
  // Keyed on the rest: an answered card keeps its slot while the card holds for the worker's turn, and a
  // NEW handoff — which says what became of it — starts every stack over.
  const restKey = handoff.data?.at ?? ""
  const placeHref = crossProjectThreadHref(project, thread.id)
  const dismiss = useMemo(() => ({ dismiss: onLeave, cancel: onReturn, hold: onHold }), [onLeave, onReturn, onHold])
  const queryClient = useQueryClient()
  // The snooze toast's Undo: the card comes back, and the page re-reads the queues now rather than at
  // the next poll, which left the card missing for up to 3s after the click.
  const onUnsnoozed = () => {
    onReturn()
    void queryClient.invalidateQueries({ queryKey: ["projectsQueues"] })
  }
  const answeringScope = useMemo(() => ({ api, projectDir: project.projectDir, projectId: project.id }), [api, project.projectDir, project.id])
  const key = threadKey(project.id, thread.id)

  // THE DOCK'S STICKY RANGE STOPS AT THE HEADER (upstream 01953049, on its board card). The dock's
  // containing block is the whole card, and `bottom-0` alone let it rise to the card's top edge: a card
  // coming in from the bottom of the screen showed its prompt box over its own header. Sticky keeps the
  // MARGIN box inside its containing block, so a top margin of the header's height holds the dock's border
  // box below the header, and the block before the dock hands that height back with a negative bottom
  // margin so nothing moves in flow. Measured rather than assumed — a long project chip or a status line
  // can wrap — and read off the observer's own entry, never `getBoundingClientRect()`: a card far from the
  // screen is skipped (lib/cardVisibility.ts), and measuring inside one lays it out on the spot. A skipped
  // card reports 0, which is not its height, so it keeps the last reading.
  const rootRef = useRef<HTMLElement>(null)
  const headerRef = useRef<HTMLElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const header = headerRef.current
    const root = rootRef.current
    if (!header || !root || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver((entries) => {
      const height = entries[entries.length - 1]?.borderBoxSize?.[0]?.blockSize ?? 0
      if (height > 0) root.style.setProperty("--queue-card-header-h", `${height}px`)
    })
    observer.observe(header)
    return () => observer.disconnect()
  }, [])
  // The band the docks cover at the bottom of the screen, for the page's scroll padding and the toaster
  // (lib/queueDockInset.ts). Only a BUILT card has a dock: a stand-in (CardStandIn) draws none.
  useEffect(() => {
    const dock = dockRef.current
    if (!dock || typeof ResizeObserver === "undefined") return
    return trackQueueDock(key, dock)
    // A collapsed card has no dock, and expanding it again mounts a new one.
  }, [key, collapsed])

  // A terminal row on the card — in the strip, or the caption over a prompt's screen — opens the thread,
  // then that terminal's drawer over it when the thread's project is the one in focus (the drawer stack is
  // that project's); otherwise the thread's drawer carries it.
  const openProcess = (process: ThreadProcess) => {
    const here = focusedProject(project.slug)
    openInPlace(project, thread.id, displayTitle(thread))
    if (here) openProcessDrawer(thread.id, process)
  }

  // The header's terminal button, the same way: the drawer stack is the focused project's, so a terminal
  // drawer pushed there for another project's thread found no thread and read "This terminal is closed".
  const openTerminal = (terminalId: string) => {
    const here = focusedProject(project.slug)
    openInPlace(project, thread.id, displayTitle(thread))
    if (here) pushTerminalDrawer(thread.id, terminalId)
  }

  const openHere = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (!isPlainLeftClick(event)) return
    event.preventDefault()
    openInPlace(project, thread.id, displayTitle(thread))
  }

  return (
    <article
      ref={rootRef}
      data-xq-card-root
      aria-label={displayTitle(thread)}
      {...fileDropZone.handlers}
      // The accent border while a file is over the card says WHICH card takes it; its prompt box says
      // where in it, with the same dashed "Drop file to attach" a drop on the box itself shows.
      className={`ntwine-card-body flex min-w-0 max-w-full flex-col ${BLOCK_RADIUS} border ${fileDropZone.over ? "border-accent" : "border-border-strong"} bg-panel shadow-lg shadow-shadow-ink/25`}
    >
      {/* Collapsed, the header IS the card: the whole radius and no rule under it (upstream's state-dependent
          rounding — a rounded-top header with a rule over nothing reads as a doubled edge). */}
      <header ref={headerRef} data-xq-collapsed={collapsed || undefined} className={`flex items-center gap-3 px-5 py-3.5 ${collapsed ? "rounded-xl" : "rounded-t-xl border-b border-border/60"}`}>
        {chip && <ProjectMark project={project} onChoose={onChoose} />}
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-semibold leading-snug" title={displayTitle(thread)}>
            {/* The card's title is its drawer door, and `o` presses it (lib/keyboardRuntime.ts). Only a
                queue card carries `open`: in a drawer the thread is already open. */}
            <a href={placeHref} onClick={openHere} data-command="open" className="rounded-sm outline-none hover:underline hover:underline-offset-2 focus-visible:ring-1 focus-visible:ring-focus-ink-60">
              {displayTitle(thread)}
            </a>
            {thread.schedule && <ScheduleMark schedule={thread.schedule} size="title" className="ml-1.5" />}
          </h3>
          {/* THE FACTS LINE (ThreadHeaderFacts FACTS_LINE_CLASS): one row in priority order, where a fact
              that does not fit drops whole with its separator. The project chip leads, so it never drops,
              and truncates only on a line narrower than its name alone; the project mark at the card's
              left already names the project. A held card's status and the live status line truncate
              rather than drop (`give`). */}
          <div data-facts-line className={`mt-0.5 ${FACTS_LINE_CLASS} text-[11px] leading-tight text-muted-75`}>
            {chipNode && <Fact>{chipNode}</Fact>}
            {/* The time limit in its last stretch or over, ahead of the time: a narrow card drops facts from the
                end, and over time is the one it must keep (DeadlineControl DeadlineFact). The card's project. */}
            <ThreadProjectScope projectId={project.id} projectDir={project.projectDir}>
              <Fact><DeadlineFact thread={thread} slot="urgent" lead={<FactSep />} /></Fact>
            </ThreadProjectScope>
            {status !== undefined ? (
              <Fact give="5em">
                <FactSep />
                <span className="min-w-0 truncate">{status}</span>
              </Fact>
            ) : (
              <Fact>
                <LastActive
                  at={thread.held !== undefined ? thread.spawnedAt : queueLabelAt(thread)}
                  label={thread.held !== undefined ? "Added" : queueLabelWord(thread)}
                  fallbackAt={thread.spawnedAt}
                  lead={<FactSep />}
                  className="min-w-0 truncate"
                />
              </Fact>
            )}
            {/* The thread-header facts the lifecycle footer used to carry (ThreadHeaderFacts): the context
                reading — its Compact sent into the CARD's project — and the Goal's loop. */}
            <ThreadProjectScope projectId={project.id} projectDir={project.projectDir}>
              {/* The time limit while there is plenty of it, its extend / remove sent into the CARD's project. */}
              <Fact><DeadlineFact thread={thread} slot="quiet" lead={<FactSep />} /></Fact>
              <Fact><ContextFact thread={thread} lead={<FactSep />} /></Fact>
              <Fact><GoalLoopFact thread={thread} lead={<FactSep />} /></Fact>
            </ThreadProjectScope>
            {/* Where the agent is working, only when that is off the project root (a worktree, or another folder). */}
            <Fact><ThreadCheckoutToken checkout={thread.checkout} homeDir={project.homeDir} lead={<FactSep />} /></Fact>
            {/* A SPINOFF CHILD says whose, as its drawer header does — ahead of the status line, which
                takes the rest of the row. Resolved, addressed and opened in the CARD's project: the
                page's board names the focused one. */}
            <Fact className="max-w-[40%]">
              <SpinoffOf
                compact
                thread={thread}
                lead={<FactSep />}
                resolve={(slug) => queueThread(project, slug)}
                href={(slug) => crossProjectThreadHref(project, slug)}
                onOpen={(slug) => { const t = queueThread(project, slug); openInPlace(project, slug, t ? displayTitle(t) : undefined) }}
              />
            </Fact>
            {/* What the thread is doing NOW, beside the name that stays put (ThreadStatusLine). */}
            <Fact give="7em"><ThreadStatusLine thread={thread} lead={<FactSep />} /></Fact>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {/* SPINOFF, on every card (Spinoff.tsx), leading the strip as the one verb that starts new
              work. In the card's OWN project scope: the header sits outside the body's, and the
              page's api names the focused project. */}
          <ThreadProjectScope projectId={project.id} projectDir={project.projectDir}>
            {/* The drawer header's strip, in its order (ChatView ThreadHeader): terminal, spinoff, ⋯. The terminal carries `t` on the card as it does in the drawer. */}
            <ThreadTerminalButton slug={thread.id} show={openTerminal} />
            <SpinoffButton thread={thread} className={HEADER_ICON_CLASS} />
          </ThreadProjectScope>
          {/* COLLAPSE — upstream's per-card fold to the header (TodosView HeaderActions `onCollapse`). */}
          <CollapseCardButton collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
          {offersRetry(thread) && <RetryButton project={project} thread={thread} onSent={onSent} onLanded={onLanded} onFailed={onReturn} />}
          {/* The ⋯ menu, as the drawer's (ThreadMenu.tsx) minus Restart worker, which only sends to the
              page's project. Then THE LIFECYCLE VERBS, after a rule, as every thread header closes
              (ThreadLifecycle.tsx; upstream moved them out of the footer on 2026-10-05): Mark as read when
              the card is only a reply to read, the snooze clock, the check. The cluster now ends the strip,
              so it takes the `-mr-2` trim the ⋯ carried: a glyph's ink sits well inside a 14px box centred
              in a 28px square, and untrimmed the last mark drew ~29px in from the card's right border
              against the project mark's 20.75px on the left. In the card's OWN project scope, so the
              snooze and completion address the card's project, not the focused one. */}
          <ThreadProjectScope projectId={project.id} projectDir={project.projectDir}>
            <ThreadMenu thread={thread} restart={false} card className={HEADER_ICON_CLASS} />
            <ThreadLifecycleActions
              thread={thread}
              className="-mr-2"
              projectName={project.name}
              onSnoozed={onLeave}
              onUnsnoozed={onUnsnoozed}
              onArchived={onSent}
              onDismissCancel={onReturn}
              onCompleted={onLanded}
              leading={thread.queuedForReply ? <MarkReadButton project={project} thread={thread} onRead={onLeave} onFailed={onReturn} /> : undefined}
            />
          </ThreadProjectScope>
        </div>
      </header>

      {/* ONE answering state for the cards AND the reply box, so a reply sent with a pick staged
          carries the pick (ReplyBox) instead of replying past it. */}
      <QueueDismissContext.Provider value={dismiss}>
      <RegisteredAnsweringProvider thread={thread} scope={answeringScope}>
      <ProjectLinkScope project={project}>
        {/* Everything between the header and the dock, in ONE block whose negative bottom margin hands back
            the dock's header-height top margin (see `--queue-card-header-h` above). Empty for a held
            thread, which still needs the hand-back. */}
        {!collapsed && (
        <div className="flex min-w-0 flex-col mb-[calc(-1*var(--queue-card-header-h,0px))]">
        {/* A held thread has no conversation, handoff or process to show: what it will start with is the box
            below, and a to-do's first steps above it. */}
        {thread.held !== undefined && thread.todoSteps && (
          <div className="flex min-w-0 flex-col px-5 pt-5 pb-4"><TodoSteps steps={thread.todoSteps} /></div>
        )}
        {thread.held === undefined && (
        <div className="flex min-w-0 flex-col gap-4 px-5 pt-5 pb-4">
          {/* EARLIER MESSAGES OPEN THE DRAWER, never the card. History drawn into the card grew it
              inside the queue, and the queue is ONE page: whether a page loaded on a press or on a
              scroll up, the card swelled between the reader and the card above it (tried and
              reverted 2026-09-29; David: "offer opening the sidebar as a way to see more to not
              interfere with threads queue"). The drawer is the thread's own scroller, where reading
              back loads as it goes and the queue under it does not move. Upstream's in-card transcript
              (its folds and "Load earlier") came back on 2026-10-06 and went again the same day, on the
              same ground (David 2026-10-06: back to the drawer, where both are one click away). */}
          <a
            href={placeHref}
            onClick={openHere}
            title="Open the thread to read back through it"
            className="self-center rounded-md border border-border px-2 py-0.5 text-[11px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-border-strong"
          >
            Show earlier messages
          </a>
          {/* A question from a rest older than the human's bubble, flushed first as upstream's window
              flushes it — everything below the bubble is newer than it. */}
          {slots && <RegisteredQuestionStack key={`above-${restKey}`} thread={thread} questions={slots.above} keepAnswered />}
          {/* A scheduled run's first message opens with ntwine's header for the worker; the card shows only the
              saved prompt under it, the human's own words — the title's repeat glyph already says where the
              run came from (ChatView ScheduledRunOpening does the same in the drawer). */}
          {/* An "Ask for update" click is the human's turn too (router.handoffOf), drawn as the transcript
              draws it rather than quoting the worker's wake text as if they had typed it. */}
          {handoff.data?.asked && (parseParkWake(handoff.data.asked)?.kind === "requested"
            ? <UpdateRequestedMarker />
            : <AskedBubble text={parseScheduledRunPrompt(handoff.data.asked)?.prompt || handoff.data.asked} />)}
          {answered && (
            <ClampedBody resetKey={thread.lastAssistantAt ?? ""}>
              <Prose md={answered} />
            </ClampedBody>
          )}
          {/* A question of a rest between the human's turn and the newest — the one the prose above
              answered with, or one the handoff skips — under that prose and over the newest. Answered
              ones first, as the drawer stacks a slot. */}
          {slots && <CardSettledStack questions={slots.settledBetween} />}
          {slots && <RegisteredQuestionStack key={`between-${restKey}`} thread={thread} questions={slots.between} keepAnswered />}
          {/* Only the PROSE clamps. The fence card under it is the handoff's ledger — what shipped, or
              what it is waiting on — and the rested notice is its state; both are the glance. */}
          {parts ? (
            parts.prose && (
              <ClampedBody resetKey={thread.lastAssistantAt ?? ""}>
                <Prose md={parts.prose} />
              </ClampedBody>
            )
          ) : !handoff.data && (thread.lastAssistant || handoff.isError) ? (
            // The server's own 200-character preview (`lastAssistant`), until the whole message lands: a card that shows
            // the gist at once beats one that is blank for a round trip. Only UNTIL it lands: a handoff
            // with no text is a worker that has not answered the human's last turn, and the preview is
            // then the reply to an earlier one.
            <p className="text-[13px] leading-5 text-muted-80">{thread.lastAssistant ?? "The handoff could not be read."}</p>
          ) : null}
          {parts?.questions.map((question, index) => (
            <QuestionBlockCard key={index} raw={question.raw} questionKind={question.questionKind} danger={question.danger} />
          ))}
          {/* THE HANDOFF'S SIGNAL FENCES. A ```done is its card. An ```awaiting is the DRAWER'S card for it
              (AwaitingBackgroundCard, through CardAwaiting): the worker's title and prose, the wait table,
              and — the reason it is here at all — the `steps:` a rest hands the human, with their Done.
              Until 2026-10-06 this card drew the fence as plain markdown with its frontmatter parsed off,
              so a rest that handed the human steps showed no steps and no verb anywhere but the drawer
              (upstream fe668a8d drew them on its queue card from the start). Three shapes:
                • a parent resting on its sub-agents states the batch instead (AwaitingSubAgentsCard);
                • a thread AT REST on its wait draws the RESTING card below, which opens on this very
                  fence, so the fence itself draws nothing (ChatView skips it the same way, through
                  Message's `restingCardShown`) — two cards for one wait is the doubling that rule ends;
                • any other awaiting fence — a wait that is no longer live, a bg-snoozed thread — is the
                  same card stating the fence, with no verbs of its own (ChatView FenceCard's branch). */}
          {parts?.fences.map((fence, index) => fence.kind === "done"
            ? <FenceBody key={index} body={fence.body} project={project} thread={thread} />
            : drawsSubAgentWait
              ? <AwaitingSubAgentsCard key={index} project={project} thread={thread} body={fence.body} openThread={() => openInPlace(project, thread.id, displayTitle(thread))} onReplied={onSent} onReplyFailed={onReturn} reply={cardReply} />
              : restingShown ? null
              : <CardAwaiting key={index} project={project} thread={thread} fence={{ body: fence.body, hints: fence.hints }} onLeave={onLeave} onSent={onSent} onLanded={onLanded} onReturn={onReturn} />)}
          {/* THE RESTING CARD (upstream TodosView AwaitingBackgroundBanner), whenever the thread is at rest on
              its own declared wait — a fence or not, since a rest on agent terminals alone queues with no
              fence at all. It carries the wait table and the steps and their Done (and, until 2026-10-14, the
              event-snooze), each of which takes this card out the way a reply does. Held until the handoff is read, as the
              gates below are: it carries buttons, and the full handoff landing above it would move them. */}
          {restingShown && (handoff.data || handoff.isError) && (
            <CardAwaiting project={project} thread={thread} onLeave={onLeave} onSent={onSent} onLanded={onLanded} onReturn={onReturn} />
          )}
          {/* A DONE THE WORKER REGISTERED (`mcp__ntwine__done`) rather than fenced — the sign-off the worker
              contract now asks for first — is in no message, so the handoff text above carries no fence
              for it and the card queued a finished thread with no Done card at all. The drawer draws it
              from the thread (ChatView's "registered-done" rung); this is the same predicate, keyed on
              the same handoff text, so a worker that fenced AND registered gets one card, the fenced one.
              Held until the handoff is read, or a fenced done would draw here first and then swap. */}
          {(handoff.data || handoff.isError) && registeredDone && <FenceBody body={registeredDoneBody(thread.lastFence!)} project={project} thread={thread} />}
          {/* THE GATE: a turn parked on a request — "Run a command?", a native question, an MCP form —
              with its real buttons, under the prose that led to it. It is the whole reason such a card
              is in the queue, and this card drew none of it until 2026-09-28: a thread held on a
              permission prompt showed its last progress line and a reply box, and read as a
              notification for nothing. Held until the handoff lands, for the reason the board's card held it: these
              carry buttons, and the full handoff replacing the preview above would move them out from
              under a cursor already on its way. Scoped to the card's project like every other control
              here; the queue context lets a decision take the card out the way a reply does. */}
          {(handoff.data || handoff.isError) && (
            <ThreadProjectScope projectId={project.id} projectDir={project.projectDir}>
              <QueueDismissContext.Provider value={dismiss}>
                <InteractionStack thread={thread} />
                <CardTerminalNet thread={thread} />
              </QueueDismissContext.Provider>
            </ThreadProjectScope>
          )}
          {/* Not gated on the handoff: a STALL's last record is often a tool call with no prose at
              all, and its notice is about the process, not the message (showsRestedCard). */}
          {/* A USAGE-LIMIT PAUSE draws the drawer's own pause card (ChatView LimitPauseNotice), so every
              paused thread looks the same wherever it is read. Until 2026-10-02 the card drew none: it
              showed whatever line the agent wrote last, and the pause was only a mark on the rail. */}
          {isLimitPaused(thread) && thread.limitPause && <QueueLimitPause project={project} thread={thread} pause={thread.limitPause} onSent={onSent} onLanded={onLanded} onFailed={onReturn} />}
          {/* The bare rest's card, beside an OLDER question too: only one this rest asked, claimed or kept
              is its ending (questionsAtCurrentRest). Without the transcript, any open question counts —
              the reading from before 2026-10-05 (showsRestedCard). */}
          {showsRestedCard(thread, text, messages ? slots?.here : undefined) && <RestedCard thread={thread} />}
        </div>
        )}

        {/* The newest rest's questions, under everything it said — the card's stack as it always was. */}
        {slots && <CardSettledStack questions={slots.settledTail} className="shrink-0 px-5 pb-4 pt-0" />}
        {slots && <RegisteredQuestionStack key={`tail-${restKey}`} thread={thread} questions={slots.tail} keepAnswered className="shrink-0 px-5 pb-4 pt-0" />}
        </div>
        )}
      </ProjectLinkScope>

      {!collapsed && (
      <ThreadProjectScope projectId={project.id} projectDir={project.projectDir}>
        {/* THE DOCK (upstream 199adf2c, ported 2026-10-06): the prompt box holds to the bottom of the
            screen while any of the card is above it, so a reply never means scrolling to the card's end
            (maintainer 2026-10-01: "have the prompt box be sticky at the bottom of the queue page the same
            way that it is on the full screen view"). Its top margin is the header's height, handed back by
            the block above, so it never rises over its own header. The rule and the upward shade are always
            drawn, docked or not — the shade is what separates it from the text scrolling under it, and a
            rule that came and went would move the box by a pixel. The bottom corners are the card's arc
            one pixel in (BLOCK_RADIUS_INNER_BOTTOM): the card has no overflow clip, so a square-cornered
            dock would paint through its rounded border.

            NOTHING ABOVE IT MAY CLIP OR SCROLL. Sticky resolves against the nearest scroll container, so an
            `overflow: hidden` on the card or its slot would take the dock's stickiness away — upstream hit
            exactly that with the exit pin of its board card (fixed there with `overflow: clip`). This card
            has no such pin; the slot's `content-visibility: auto` only applies to cards far off screen,
            whose docks are off screen with them.

            LIVE WORK FOLDS INTO ONE LINE OF COUNTS above the box (QueueOpsSummary), the real rows one
            hover away. Those rows are the ones the ops column under the reply box drew until now —
            AGENT and WORKFLOW rows (QueueChildOps), then the TERM strip of every live process, the
            agent's shells and your terminals (ThreadTerminals ThreadProcessStrip) — plus upstream's PR
            and issue watchers and the thread's saved files and links. All of them read the CARD's
            project, never the page's board. */}
        <div
          ref={dockRef}
          data-queue-dock={thread.id}
          // A held thread's card has nothing between its header and the dock, so the dock can never leave the header's
          // bottom edge — and the header's own rule is already there; a second would draw a 2px line.
          className={`sticky bottom-0 z-10 mt-[var(--queue-card-header-h,0px)] shrink-0 ${BLOCK_RADIUS_INNER_BOTTOM} ${thread.held !== undefined && !thread.todoSteps ? "" : "border-t border-border/60"} bg-panel px-5 pb-3 pt-3 shadow-[0_-12px_18px_-14px_var(--dock-shadow)]`}
        >
          <QueueOpsSummary
            counts={queueOpsCounts(thread, { agents: !drawsSubAgentWait })}
            // ONE KIND OF ROW PER PANEL (upstream 7a8a8ebe): each count opens its own, split by the same
            // tests queueOpsCounts counts with, so a count and its panel cannot disagree.
            panel={(kind) => (
              <div data-queue-card-ops={thread.id} className="flex min-w-0 flex-col gap-0.5">
                {kind === "agent" || kind === "workflow" ? (
                  <QueueChildOps
                    project={project}
                    thread={{ ...thread, subAgents: (thread.subAgents ?? []).filter((child) => Boolean(child.workflow) === (kind === "workflow")) }}
                    api={api}
                    onOpenThread={() => openInPlace(project, thread.id, displayTitle(thread))}
                  />
                ) : kind === "terminal" ? (
                  <div data-queue-processes={thread.id} className="min-w-0">
                    <ThreadProcessStrip thread={thread} surface="card" onOpen={openProcess} />
                  </div>
                ) : kind === "pr" || kind === "issue" ? (
                  <GithubWatchRows watches={(thread.watches ?? []).filter((watch) => watch.kind === "github" && (watch.subject === "issue") === (kind === "issue"))} />
                ) : (
                  <ThreadLinks links={(thread.links ?? []).filter((link) => link.kind === kind)} scope={projectMarkdownScope(project)} />
                )}
              </div>
            )}
          />
          {/* A HELD THREAD's box is what it will start with, and sending it starts the agent (HeldThreadBox.tsx). */}
          {thread.held !== undefined
            ? <HeldThreadComposer thread={thread} surface="queueComposer" className="min-w-0" />
            : <ReplyBox project={project} thread={thread} onSent={onSent} onLanded={onLanded} onFailed={onReturn} fileDrop={composerFileDrop} />}
        </div>
      </ThreadProjectScope>
      )}
      </RegisteredAnsweringProvider>
      </QueueDismissContext.Provider>

    </article>
  )
}

/**
 * The card's memo: its thread by identity (the poll and the board keep an unchanged thread's object), its
 * project by address (lib/allQueues.ts sameProjectAddress — the lists it is rebuilt around are not the
 * card's), everything else as React would. A card must read nothing from its project beyond what that
 * compares; widen it before reading more.
 */
function sameCard(a: AllQueuesCardProps, b: AllQueuesCardProps): boolean {
  return (
    a.thread === b.thread &&
    a.leaving === b.leaving &&
    a.onLeave === b.onLeave &&
    a.onSent === b.onSent &&
    a.onLanded === b.onLanded &&
    a.onReturn === b.onReturn &&
    a.onHold === b.onHold &&
    a.chip === b.chip &&
    a.onChoose === b.onChoose &&
    a.ghost === b.ghost &&
    a.status === b.status &&
    a.concealed === b.concealed &&
    sameProjectAddress(a.project, b.project)
  )
}

/**
 * The thread header's stall recovery (HeaderActions.tsx RetryButton): the same message through the same
 * follow-up, sent to the thread's own project. The thread goes back to work, so the card leaves.
 */
/**
 * THE WAY OUT FOR A REPLY THAT IS ALL THE CARD IS FOR (ThreadView.queuedForReply). The thread is parked on
 * a wait it named and queues only because the human has not read its answer, and until this the one thing
 * that cleared it was opening the drawer — the card showed the reply, an Awaiting fence and nothing to
 * press. Recording it seen is the same write the drawer makes on open (threadSeen), so the park takes and
 * the thread moves to Snoozed until its wait wakes it. Optimistic, like Mark as done: the card leaves on
 * the click and comes back if the write fails.
 */
function MarkReadButton({ project, thread, onRead, onFailed }: { project: QueuesProject; thread: ThreadView; onRead: () => void; onFailed: () => void }) {
  const [pending, setPending] = useState(false)
  // A BARE ICON in the header's lifecycle cluster since 2026-10-06, beside the clock and the check it is a
  // peer of — all three take the card off the queue. It was a worded pill in the card's footer, which went
  // with the lifecycle footer. The double check is the read receipt's own mark; its name is one hover away.
  return (
    <Tooltip label="Mark as read">
    <button
      type="button"
      data-mark-read
      aria-label="Mark as read"
      onMouseDown={(event) => event.preventDefault()}
      disabled={pending}
      onClick={() => {
        setPending(true)
        onRead()
        projectRpc(project.id).threadSeen({ slug: thread.id }).catch((error) => {
          onFailed()
          setPending(false)
          showToast(`Couldn’t mark as read: ${(error as Error).message.slice(0, 80)}`)
        })
      }}
      className={HEADER_ICON_CLASS}
    >
      <CheckCheck size={15} strokeWidth={2} />
    </button>
    </Tooltip>
  )
}

function RetryButton({ project, thread, onSent, onLanded, onFailed }: { project: QueuesProject; thread: ThreadView; onSent: () => void; onLanded: () => void; onFailed: () => void }) {
  const queryClient = useQueryClient()
  const retry = useMutation({
    mutationFn: () => deliverFollowUp(project, thread, STALLED_RETRY_MESSAGE),
    onMutate: onSent,
    onSuccess: () => {
      onLanded()
      showToast("Retrying…")
      void queryClient.invalidateQueries({ queryKey: ["projectsQueues"] })
    },
    onError: (error) => {
      onFailed()
      showToast(`Retry failed: ${(error instanceof Error ? error.message : "unknown error").slice(0, 80)}`)
    },
  })
  return (
    <Tooltip label="Retry — resume this session where it left off">
      <button
        type="button"
        onClick={() => retry.mutate()}
        disabled={retry.isPending || !thread.sessionId}
        aria-label="Retry exited session"
        onMouseDown={(event) => event.preventDefault()}
        // AN ICON in the header strip's chrome — the same mark as the drawer's Retry
        // (HeaderActions.tsx). It was a labelled accent pill until 2026-09-29, and one worded pill beside
        // the bare ⤢ read as a stray (maintainer: "having a retry button labeled with other non labeled
        // icons looks awful").
        className={HEADER_ICON_CLASS}
      >
        <RotateCcw size={14} strokeWidth={2} />
      </button>
    </Tooltip>
  )
}

/** The pause card's "Continue now", sent into the CARD's project — the drawer's own would address the page's. */
function QueueLimitPause({ project, thread, pause, onSent, onLanded, onFailed }: { project: QueuesProject; thread: ThreadView; pause: NonNullable<ThreadView["limitPause"]>; onSent: () => void; onLanded: () => void; onFailed: () => void }) {
  const queryClient = useQueryClient()
  const resume = useMutation({
    mutationFn: () => deliverFollowUp(project, thread, STALLED_RETRY_MESSAGE),
    onMutate: onSent,
    onSuccess: () => {
      onLanded()
      showToast("Continuing…")
      void queryClient.invalidateQueries({ queryKey: ["projectsQueues"] })
    },
    onError: (error) => {
      onFailed()
      showToast(`Continue failed: ${(error instanceof Error ? error.message : "unknown error").slice(0, 80)}`)
    },
  })
  return <LimitPauseNotice pause={pause} onContinue={() => resume.mutate()} continuing={resume.isPending || !thread.sessionId} />
}

/**
 * Markdown links inside this card, pointed at the card's project.
 *
 * Two delegated listeners on the document act on every rendered link (lib/local-file-links.ts,
 * lib/thread-links.ts), and both act on the PAGE's project: a file link opens through the page's `rpc`,
 * a `/thread/<slug>` link opens a drawer this page does not have. This intercepts both first, in the
 * capture phase, and sends them to the thread's own project — a file to the same viewers every link
 * uses, read or opened through that project, a thread link to that thread's drawer, opened in place.
 */
function ProjectLinkScope({ project, children }: { project: QueuesProject; children: ReactNode }) {
  const navigate = useNavigate()
  const openInPlace = useOpenThreadInPlace()
  const onClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const target = event.target instanceof Element ? event.target : null
    const file = target?.closest<HTMLElement>("[data-local-path]")
    const path = file?.dataset.localPath
    if (file && path) {
      event.preventDefault()
      event.stopPropagation()
      // The one router every file click takes (lib/local-file-links.ts) — the picture viewer, the reader,
      // or the desktop opener — scoped to THIS card's project: its gate reads the file and its opener
      // opens it, since a checkout outside home is inside that project's roots and no other's.
      openLocalPath(path, file, projectMarkdownScope(project))
      return
    }
    const anchor = target?.closest<HTMLAnchorElement>("a[href^='/']")
    const href = anchor?.getAttribute("href")
    if (!anchor || !href || href.startsWith("//") || !isPlainLeftClick(event)) return
    // The markdown scope already pointed every in-app link at this project on this page (`/all/<slug>/…`),
    // and a worker may have spelled one out itself for another project. Either way it is a same-app
    // navigation — done by the router rather than a document load — and a thread link opens the thread
    // in place, on this page. An address from before 2026-09-28 (`/project/<slug>/thread/…`) names no
    // project any more (base-path.ts isRetiredAppPath), so it is left to the browser, which lands it on
    // the page untranslated, like any other retired address.
    const linked = projectSlug(href)
    if (!linked) return
    event.preventDefault()
    event.stopPropagation()
    const inner = innerPath(href)
    // A thread of this card's own project — the card's "Show earlier messages" and title among them, which
    // this capture reaches before their own handlers — opens through the one in-place verb, so its drawer's
    // frame is up at the click rather than seconds later (useOpenThreadInPlace).
    const thread = inner.match(/^\/thread\/([^/?#]+)\/?$/)
    if (thread && linked === project.slug) {
      const slug = decodeURIComponent(thread[1]!)
      const t = queueThread(project, slug)
      openInPlace(project, slug, t ? displayTitle(t) : undefined)
      return
    }
    navigate(inner.startsWith("/thread/") ? `${crossProjectHref(linked)}${inner}` : href)
  }
  return <div className="contents" onClickCapture={onClickCapture}>{children}</div>
}

/**
 * THE TERMINAL NET on the card: a frozen native ask, or the generic permission banner — the two states the
 * server queues a thread on (board.ts deriveNeedsYou) that journal nothing InteractionStack could draw. The
 * card showed only InteractionStack from 2026-09-28, so a session parked on a terminal-only prompt queued
 * with its last progress line and a reply box that cannot land, and never said why. The rungs are the
 * drawer's own (ChatView TerminalNetCard), and they stand down the same way when an answerable
 * interaction is on screen. PermPolicyDenialCard is deliberately absent: a denial already happened,
 * queues nothing, and is one click away in the drawer.
 */
function CardTerminalNet({ thread }: { thread: ThreadView }) {
  return <TerminalNetCard thread={thread} />
}

/** The human's last message, as the transcript draws it — their own bubble — clipped to a few lines. */
function AskedBubble({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const [clamps, setClamps] = useState(false)
  const words = useRef<HTMLSpanElement>(null)
  // Only a message the clamp actually cut is a toggle; a short one is plain, selectable text.
  useLayoutEffect(() => {
    const el = words.current
    if (!el || open) return
    const measure = () => setClamps(el.scrollHeight > el.clientHeight + 1)
    // Once the card is drawn, as ClampedBody does (lib/cardVisibility.ts).
    const cancel = whenCardRendered(el, measure)
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => {
      cancel()
      observer.disconnect()
    }
  }, [open, text])
  const toggle = () => setOpen((value) => !value)
  return (
    <div className="flex max-w-[85%] flex-col items-end gap-0.5 self-end">
      {/* A div with role=button, NOT a <button>: browsers refuse to start a text selection inside a
          <button>, so the human could not copy a word of their own message. The click is ignored while
          a selection is live, because a drag across the words ends in a click on this same node. */}
      <div
        {...(clamps || open ? {
          role: "button",
          tabIndex: 0,
          "aria-expanded": open,
          title: open ? "Show less" : "Show the whole message",
          onClick: () => {
            if (window.getSelection()?.toString()) return
            toggle()
          },
          onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => {
            if (e.key !== "Enter" && e.key !== " ") return
            e.preventDefault()
            toggle()
          },
        } : {})}
        className={`${BLOCK_RADIUS} rounded-br-sm bg-user-bubble px-3.5 py-2.5 text-left text-[13px] leading-5 whitespace-pre-wrap [overflow-wrap:anywhere] text-user-bubble-fg outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg${clamps || open ? " cursor-pointer" : ""}`}
      >
        {/* The clamp sits INSIDE the padding. On the bubble itself, its overflow clip ran to the padding
            edge, so the fourth line showed half its height in the bubble's bottom padding. */}
        <span ref={words} className={open ? "" : "line-clamp-3"}>{text}</span>
      </div>
    </div>
  )
}

function Prose({ md }: { md: string }) {
  const html = useMarkdownHtml(md)
  return <LinkedHtml className={`md-body ${QUEUE_WRAP}`} html={html} />
}

/** Fold the card to its header, or open it again — upstream's IconBtn (HeaderActions) in this strip's chrome.
 *
 *  THE `-mx-0.5` IS INK, NOT TASTE. Both chevron pairs paint ~10 of lucide's 24 units across, so at
 *  upstream's 13px the glyph is ~6.5px of ink centred in the 28px square where its neighbours paint 12px:
 *  on the strip's uniform `gap-0.5` it drew 20.5px of ink to the spinoff and to the fullscreen door,
 *  against 17.5px terminal→spinoff and 18.25px fullscreen→⋯ (scripts/ink-gaps.mjs, dsf 4, sans,
 *  2026-10-06). Two pixels in from each side brings both to ~18.5px; the hover square keeps its size.
 *  The fullscreen door went 2026-10-15, so collapse's right-hand neighbour is the ⋯ now, unmeasured. */
function CollapseCardButton({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const label = collapsed ? "Expand" : "Collapse"
  const Icon = collapsed ? ChevronsUpDown : ChevronsDownUp
  return (
    <Tooltip label={label}>
      <button type="button" data-xq-collapse aria-label={label} aria-expanded={!collapsed} onMouseDown={(event) => event.preventDefault()} onClick={onToggle} className={`${HEADER_ICON_CLASS} -mx-0.5`}>
        <Icon size={13} strokeWidth={2} />
      </button>
    </Tooltip>
  )
}

/** Does the card read its transcript (hooks/useCardTranscript.ts)? While the thread has a held question,
 *  to place it at its rest — the handoff alone cannot say which rest that is. */
function cardNeedsTranscript(thread: Pick<ThreadView, "questions">): boolean {
  return heldQuestionViews(thread.questions).length > 0
}

/** Answered questions at their rest, greyed (the drawer's SettledQuestionStack) — minus any this card's
 *  answering state sent itself, which its open stack still draws greyed in the very slot it was answered
 *  in (RegisteredQuestionStack `keepAnswered`), so a card holding for the rest never moves under the
 *  cursor and never draws one answer twice. */
function CardSettledStack({ questions, className }: { questions: readonly SettledQuestion[]; className?: string }) {
  const answering = useContext(RegisteredAnsweringContext)
  const shown = answering && answering.sent.size > 0 ? questions.filter((q) => !answering.sent.has(q.id)) : questions
  return <SettledQuestionStack questions={shown} wrap className={className} />
}

/** A card verb's reply (the steps' Done, Keep working), sent into the card's own project — the reply box's
 *  send — with its failure toasted and rethrown so the verb can roll back. */
function useCardReply(project: QueuesProject, thread: ThreadView, onLanded: () => void) {
  const queryClient = useQueryClient()
  return useCallback((message: string) => deliverFollowUp(project, thread, message).then(
    () => {
      onLanded()
      void queryClient.invalidateQueries({ queryKey: ["projectsQueues"] })
    },
    (error: unknown) => {
      if (!pageUnloading()) showToast(`Reply failed: ${(error instanceof Error ? error.message : "unknown error").slice(0, 80)}`)
      throw error
    },
  ), [onLanded, project, queryClient, thread])
}

/**
 * THE DRAWER'S AWAITING CARD ON THE QUEUE CARD (AwaitingBackgroundCard) — the resting card when `fence` is
 * absent, the card stating a fence the thread is no longer at rest on when it is given — wired to THIS
 * card's project and exits, because everything it does would otherwise reach the page's:
 *
 *   • the steps' Done and Keep working are ordinary replies, sent into the card's project (lib/projectFollowUp.ts, the
 *     reply box's own send). The card LEAVES on the click — upstream's optimistic exit (TodosView
 *     AwaitingBackgroundBanner) — stays gone while the reply is on the wire, and comes back if it fails;
 *   • its Stop and Ask for update read the card's client through the ThreadProjectScope here;
 *   • a row opens its thread in place, and the row's own drawer over it only when the card's project is
 *     the one in focus (WaitRowOpenContext) — the terminal rows' route (`openProcess` above).
 */
function CardAwaiting({ project, thread, fence, onLeave, onSent, onLanded, onReturn }: {
  project: QueuesProject
  thread: ThreadView
  fence?: { body: string; hints: AwaitingHint[] }
  onLeave: () => void
  onSent: () => void
  onLanded: () => void
  onReturn: () => void
}) {
  const openInPlace = useOpenThreadInPlace()
  const openRow = useCallback((push: () => void) => {
    const here = focusedProject(project.slug)
    openInPlace(project, thread.id, displayTitle(thread))
    if (here) push()
  }, [openInPlace, project, thread])
  const reply = useCardReply(project, thread, onLanded)
  return (
    <ThreadProjectScope projectId={project.id} projectDir={project.projectDir}>
      <WaitRowOpenContext.Provider value={openRow}>
        <AwaitingBackgroundCard
          thread={thread}
          fence={fence}
          onReplied={onSent}
          onReplyFailed={onReturn}
          reply={reply}
        />
      </WaitRowOpenContext.Provider>
    </ThreadProjectScope>
  )
}

/** A ```done fence (or a registered done), drawn as the transcript's fence card — presentation only; the
 *  verb is the header's check. An ```awaiting fence is CardAwaiting's. */
function FenceBody({ body, project, thread }: { body: string; project: QueuesProject; thread: ThreadView }) {
  const html = useMarkdownHtml(body)
  // The one verb a done card carries here: "Watch #N" for each PR or issue it links (DoneWatchButtons).
  // Mark as done is the header's check. In the card's own project scope, and its click takes the card
  // out the way the header's Snooze does.
  const watchRefs = useDoneWatchRefs(html)
  const dismiss = useContext(QueueDismissContext)
  const watchable = watchRefs.length > 0 && doneWatchable(thread, body)
  return (
    <TranscriptCard icon={Check} label="Done">
      {/* null, not a falsy "": an empty body (registeredDoneBody) is a header-only card, not a blank content gap. */}
      {html ? <LinkedHtml className={`md-body ${QUEUE_WRAP}`} html={html} /> : null}
      {watchable && (
        <ThreadProjectScope projectId={project.id} projectDir={project.projectDir}>
          <CardActions>
            <DoneWatchButtons thread={thread} refs={watchRefs} onWatched={dismiss?.dismiss} onWatchFailed={dismiss?.cancel} />
          </CardActions>
        </ThreadProjectScope>
      )}
    </TranscriptCard>
  )
}

/**
 * The glance, and the first step of the drill-down: a long handoff is clipped to its opening lines with
 * a fade, and "Show more" opens the rest in place. Short ones are never clipped and show no control.
 */
function ClampedBody({ resetKey, children }: { resetKey: string; children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null)
  const [overflows, setOverflows] = useState(false)
  const [open, setOpen] = useState(false)
  const [seenKey, setSeenKey] = useState(resetKey)
  // A NEW handoff starts clipped again: opening the last one is not a vote to open every one after it.
  if (seenKey !== resetKey) {
    setSeenKey(resetKey)
    setOpen(false)
  }
  useLayoutEffect(() => {
    const el = inner.current
    if (!el) return
    const measure = () => setOverflows(el.scrollHeight > CLAMP_PX + 24)
    // Measured once the card is drawn: in a card the browser is skipping, `scrollHeight` would lay the card
    // out just to answer (lib/cardVisibility.ts). The observer reports nothing while it is skipped.
    const cancel = whenCardRendered(el, measure)
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => {
      cancel()
      observer.disconnect()
    }
  }, [])
  const clipped = overflows && !open
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div
        className="relative min-w-0 overflow-hidden"
        style={clipped ? { maxHeight: CLAMP_PX, maskImage: "linear-gradient(to bottom, black 62%, transparent)" } : undefined}
        // KEYBOARD FOCUS OPENS IT. The clipped half still holds links, and tabbing onto one scrolled this
        // overflow box to show it — an overflow:hidden box is still a scroll container — leaving the
        // collapsed card showing the middle of the message. A reader who tabbed in wants the rest.
        onFocus={(event) => {
          if (!clipped || !(event.target instanceof Element) || !event.target.matches(":focus-visible")) return
          event.currentTarget.scrollTop = 0
          setOpen(true)
        }}
      >
        <div ref={inner} className="flex min-w-0 flex-col gap-4">{children}</div>
      </div>
      {overflows && (
        // The transcript's disclosure row ("Ran 3 tool calls ›", ChatView.tsx): its label type, its hover, and
        // its measured chevron (transcriptMetaChevronClass carries the ink trims and the cap-band shift),
        // so this toggle and the transcript's read as one control.
        <button
          type="button"
          data-xq-show-more
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className={`${TRANSCRIPT_META_LABEL_CLASS} group flex items-baseline gap-1.5 self-start rounded outline-none transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60`}
        >
          <span>{open ? "Show less" : "Show more"}</span>
          <ChevronRight aria-hidden="true" size={13} className={transcriptMetaChevronClass(open)} />
        </button>
      )}
    </div>
  )
}

/**
 * Reply to the agent, from here — the drawer's own prompt box (`Composer`: the same Enter keys, paste
 * and drop of attachments, auto-growth) with the drawer's model/effort and permission strip under it
 * (useThreadComposerControls, handed this card's thread and scoped to its project by the caller's
 * ThreadProjectScope), so a thread can be re-pointed mid-flight from here without opening its drawer.
 *
 * THE DRAFT IS THE DRAWER'S DRAFT. It is keyed exactly as that thread's composer keys it — its project's
 * directory, its slug, its session — so a reply half-typed here is waiting in the thread's drawer, and
 * the other way round. An attachment uploads to the THREAD's project (`attachBase`), not the page's,
 * which on this page is the focused project.
 */
function ReplyBox({ project, thread, onSent, onLanded, onFailed, fileDrop }: { project: QueuesProject; thread: ThreadView; onSent: () => void; onLanded: () => void; onFailed: () => void; fileDrop?: SurfaceFileDrop }) {
  const queryClient = useQueryClient()
  const key = draftKey.followUp(project.projectDir, thread.id, thread.sessionId)
  const text = useDraftValues([key]).get(key) ?? ""
  const [error, setError] = useState<string>()
  const controls = useThreadComposerControls(thread.id, thread)
  const [signInFor, setSignInFor] = useState<AccountBackend | null>(null)
  const [logoutFor, setLogoutFor] = useState<AccountBackend | null>(null)
  const answering = useContext(RegisteredAnsweringContext)
  // `@` mentions of this card's project's threads — offered only when the page's board IS that project.
  // LIVE ONLY ONCE THE DRAFT HOLDS AN `@`, which is the only time the menu or a mention's link can draw:
  // a live candidate list walks the whole board and so re-rendered every card on the page at every board
  // delta and poll (hooks/useMentionCandidates.ts). The keystroke that types the `@` re-renders this box
  // with them already in hand.
  const mentionsLive = text.includes("@")
  const mentions = useMentionCandidates(thread.id, project.slug, mentionsLive)
  const ownMention = useOwnMention(thread.id, project.slug, mentionsLive)
  // The drawer's chips, on the drawer's draft: a selection staged in the thread's drawer (⌘I, or sent from
  // an editor) is the same staging here, and rides this box's send the same way (lib/stagedContext.ts).
  const contextTokens = useStagedContextTokens(key, text)
  const contextSources = useStagedContextSources(key, project.projectDir)
  // The `/` menu and the send's expansion, as the drawer's box has them (ThreadComposerBox.tsx) — asked
  // of the THREAD's project, which on All projects is not the page's.
  const api = useMemo(() => projectRpc(project.id), [project.id])
  const userCommandsQuery = useUserCommands({ projectDir: project.projectDir, api })
  const userCommands = userCommandsQuery.data?.commands
  const slashSuggest = useMemo(
    () => () => Promise.all([fetchThreadSkills(thread.id, api), fetchUserCommands(queryClient, project.projectDir, api)]).then(([skills, commands]) => mergeSlashItems(skills, commands)),
    [thread.id, api, queryClient, project.projectDir],
  )
  const send = useMutation({
    mutationFn: ({ outgoing }: { outgoing: string; typed: string; staged: ComposerContextItem[] }) => deliverFollowUp(project, thread, outgoing),
    onSuccess: () => {
      onLanded()
      void queryClient.invalidateQueries({ queryKey: ["projectsQueues"] })
    },
    onError: (cause, { typed, staged }) => {
      // A reload aborting the send: the next page replays it (lib/pendingSends.ts), so no rollback.
      if (pageUnloading()) return
      // The card faded on send; the message did not land, so bring it back with the text still in it —
      // unless something new was typed meanwhile, which is not ours to overwrite — and its chips with it.
      if (!draftStore.get(key)) draftStore.set(key, typed)
      restoreContextItems(key, staged)
      onFailed()
      const reason = cause instanceof Error ? cause.message : "The reply could not be sent."
      // A TOAST as well as the inline line: by the time a failure lands the card has usually finished its
      // exit, and the one that comes back is a fresh mount that never saw this error.
      showToast(`Reply failed: ${reason.slice(0, 80)}`)
      setError(reason)
    },
  })
  const submit = () => {
    const message = text.trim()
    if (!message) return
    // `/login` / `/logout` are ntwine-owned account actions for this thread's backend, invoked here and
    // never delivered to the worker as a prompt — as the drawer's box does (ThreadComposerBox.tsx). The
    // board's queue card intercepted them too; this card did not, so with the board gone a `/login`
    // typed into a card went into the worker's stdin.
    const alias = parseAccountAlias(message)
    if (alias) {
      draftStore.set(key, "")
      if (thread.backend === "acp") {
        showToast("An ACP agent signs in through its own CLI — ntwine holds no account for it")
        return
      }
      const backend: AccountBackend = thread.backend === "codex" ? "codex" : "claude"
      if (alias === "login") setSignInFor(backend)
      else setLogoutFor(backend)
      return
    }
    if (!thread.sessionId || send.isPending) return
    setError(undefined)
    const deliver = () => {
      // Local truth first, then the network — the order every send on the board's card obeyed.
      const staged = takeContextItems(key)
      draftStore.set(key, "")
      onSent()
      const expanded = expandUserCommandDraft(message, userCommands ?? []) ?? message
      send.mutate({ outgoing: buildMessageWithContext(expanded, staged, project.projectDir), typed: message, staged })
    }
    // Picked answers ride the reply rather than being replied past — ThreadComposerBox's send has the why.
    if (answering?.slug === thread.id && answering.staged > 0) {
      if (answering.sending) return
      answering.submit(deliver)
      return
    }
    deliver()
  }
  return (
    <div className="min-w-0">
      <Composer
        surface="queueComposer"
        contextTokens={contextTokens}
        contextSources={contextSources}
        value={text}
        onChange={(value) => draftStore.set(key, value)}
        onSubmit={submit}
        placeholder={answering?.staged ? "Add a note to your answers…" : heldQuestionViews(thread.questions).length > 0 ? "Or reply without answering…" : "Reply to the agent…"}
        attachBase={projectApiBase(project.id)}
        fileDrop={fileDrop}
        mentionCandidates={mentions}
        ownMention={ownMention}
        slashSuggest={slashSuggest}
        // A command saved in Settings refreshes the menu on the next `/`.
        slashSuggestVersion={userCommandsQuery.dataUpdatedAt}
        busy={controls.busy}
        footer={controls.footer}
        onEffortStep={controls.stepEffort}
        // THE GOAL at the rail's left end, as on every thread prompt box (ThreadComposerBox) — for a
        // ntwine-owned session. It reaches the card's project through the scope this box renders in.
        railLead={thread.kind === "session" && thread.foreign !== true ? <RecurringPromptControl thread={thread} /> : undefined}
      />
      {controls.status}
      {error && <div role="alert" className="mt-1.5 break-words text-[11px] leading-snug text-danger-soft">{error}</div>}
      {signInFor && <SignInModal backend={signInFor} onClose={() => setSignInFor(null)} onAuthed={() => setSignInFor(null)} />}
      {logoutFor && <LogoutConfirmModal backend={logoutFor} onClose={() => setLogoutFor(null)} />}
    </div>
  )
}
