// ONE QUEUE CARD ON THE ALL QUEUES PAGE — a thread of ANY project, on a page that names none.
//
// It wears the board's queue card (TodosView QueueCard): the same bordered, shadowed shell, the same
// header with the title and its rest time, the human's last message as their bubble, the handoff as
// prose with its ```done card, the thread's registered questions, a reply box, and the lifecycle footer's
// Snooze and Mark as done. What it deliberately does NOT carry is the transcript — the tool calls, the
// earlier rounds, the sub-agent rows. That is the next level down, one click away on the thread's own
// board (the header's ↗), and it is what makes a page of every project's queue readable at all.
//
// THE CARD NEVER ASKS THE PAGE WHICH PROJECT IT IS. Everything that could — the RPC client, the query
// cache, the markdown's repo and paths, the lifecycle buttons, the question drafts — is handed the
// card's own project explicitly (see the provider stack at the bottom). The board's queue card cannot be
// reused here for exactly that reason: it reads its project from the address bar, the store and the
// page's socket, and on this page all three name the LAUNCHING project.
import { memo, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowUpRight, Check, ChevronRight, Hourglass, Maximize2, RotateCcw } from "lucide-react"
import { useNavigate } from "react-router"
import type { ThreadView } from "@frizz/shared"
import { projectApiBase, projectRpc } from "../api/rpc.ts"
import { ThreadProjectScope } from "../api/threadApi.tsx"
import { displayTitle, lastActiveLabelAt, offersRetry } from "../groups.ts"
import { threadKey, type QueuesProject } from "../lib/allQueues.ts"
import { copyTextToClipboard } from "../lib/clipboard.ts"
import { draftKey, draftStore, useDraftValues } from "../lib/drafts.ts"
import { splitFenceBlocks } from "../lib/fenceBlocks.ts"
import { rememberFullscreenOrigin } from "../lib/fullscreenHandoff.ts"
import { STALLED_RETRY_MESSAGE } from "../lib/retrySession.ts"
import { TRANSCRIPT_META_LABEL_CLASS, transcriptMetaChevronClass } from "../lib/transcriptMetaLabels.ts"
import { HEADER_ICON_CLASS } from "../lib/headerIcon.ts"
import { splitQuestionBlocks } from "../lib/questionBlocks.ts"
import { isPlainLeftClick } from "../lib/standaloneThreadRoute.ts"
import { useMarkdownHtml } from "../lib/useMarkdown.ts"
import { showToast } from "../store.ts"
import { QueueDismissContext } from "./ChatView.tsx"
import { Composer } from "./Composer.tsx"
import { LastActive } from "./LastActive.tsx"
import { LinkedHtml } from "./LinkedHtml.tsx"
import { RegisteredAnsweringProvider, RegisteredQuestionStack } from "./RegisteredQuestionCards.tsx"
import { RestedCard, showsRestedCard } from "./RestedCard.tsx"
import { SnoozeButton } from "./SnoozeButton.tsx"
import { StateButton } from "./ThreadLifecycleFooter.tsx"
import { Tooltip } from "./Tooltip.tsx"
import { BLOCK_RADIUS, BLOCK_RADIUS_INNER_BOTTOM, QUEUE_WRAP, TranscriptCard } from "./TranscriptCard.tsx"

/** Where a thread lives on its own board — the next level down from this card. */
export function threadBoardHref(project: Pick<QueuesProject, "slug">, slug: string): string {
  return `/project/${encodeURIComponent(project.slug)}/thread/${encodeURIComponent(slug)}`
}

/**
 * A handoff, split the way the board's card draws it: the prose, then each ```done / ```awaiting fence
 * as its own card. The EMPTY ```question qst_… markers a worker writes to PLACE its registered cards are
 * dropped — this card draws every open question at its tail, so a marker left in would render as an
 * empty code block in the middle of the prose.
 */
export function handoffParts(text: string): { prose: string; fences: { kind: "done" | "awaiting"; body: string }[] } {
  const unmarked = text.includes("```question")
    ? splitQuestionBlocks(text).map((seg) => (seg.kind === "question" && seg.registeredId && seg.text.trim() === "" ? "" : seg.kind === "prose" ? seg.text : null)).filter((part): part is string => part !== null).join("\n")
    : text
  let prose = ""
  const fences: { kind: "done" | "awaiting"; body: string }[] = []
  for (const segment of splitFenceBlocks(unmarked)) {
    if (segment.kind === "prose") prose += segment.text
    else fences.push({ kind: segment.fenceKind, body: segment.body })
  }
  return { prose: prose.trim(), fences }
}

/** The collapsed body's height: enough for a verdict line and the paragraph under it, never a wall. */
const CLAMP_PX = 188

export const AllQueuesCard = memo(function AllQueuesCard({
  project,
  thread,
  leaving,
  onLeave,
  onReturn,
}: {
  project: QueuesProject
  thread: ThreadView
  leaving: boolean
  /** The card has been acted on — answered, replied to, snoozed or finished — so it fades out now. */
  onLeave: () => void
  /** The action failed after the card had already faded: put it back. */
  onReturn: () => void
}) {
  const api = projectRpc(project.id)
  const key = threadKey(project.id, thread.id)
  const navigate = useNavigate()
  // KEYED ON THE REST, so a thread that rests again fetches its new handoff, and one that has not moved
  // is read exactly once however often the page polls. The previous handoff stays on screen while the
  // next one loads rather than blanking the card.
  const handoff = useQuery({
    queryKey: ["ofProject", project.id, "handoff", thread.id, thread.lastAssistantAt ?? ""],
    queryFn: () => api.threadHandoff({ slug: thread.id }),
    staleTime: Infinity,
    placeholderData: (previous) => previous,
  })
  const text = handoff.data?.text
  const parts = useMemo(() => (text ? handoffParts(text) : null), [text])
  const boardHref = threadBoardHref(project, thread.id)
  const fullHref = `${boardHref}/full`
  const dismiss = useMemo(() => ({ dismiss: onLeave, cancel: onReturn }), [onLeave, onReturn])
  const answeringScope = useMemo(() => ({ api, projectDir: project.projectDir }), [api, project.projectDir])

  const openBoard = (event: ReactMouseEvent<HTMLAnchorElement>, href: string, full: boolean) => {
    if (!isPlainLeftClick(event)) return
    event.preventDefault()
    // The way OUT of /full leads back here rather than to the thread's board (fullscreenHandoff.ts).
    if (full) rememberFullscreenOrigin(thread.id, "/queues")
    navigate(href)
  }

  return (
    <div data-xq-card={key} data-queue-leaving={leaving} className="frizz-card-slot min-w-0">
      <div className="frizz-card-clip min-h-0 min-w-0">
        <article
          data-xq-card-root
          aria-label={displayTitle(thread)}
          className={`frizz-card-body flex min-w-0 max-w-full flex-col ${BLOCK_RADIUS} border border-border-strong bg-panel shadow-lg shadow-shadow-ink/25`}
        >
          <header className="flex items-center gap-2 rounded-t-xl border-b border-border/60 px-5 py-3.5">
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-[15px] font-semibold leading-snug" title={displayTitle(thread)}>
                <a href={boardHref} onClick={(event) => openBoard(event, boardHref, false)} className="rounded-sm outline-none hover:underline hover:underline-offset-2 focus-visible:ring-1 focus-visible:ring-focus-ink-60">
                  {displayTitle(thread)}
                </a>
              </h3>
              <LastActive at={lastActiveLabelAt(thread)} fallbackAt={thread.spawnedAt} className="mt-0.5 block truncate text-[11px] leading-tight text-muted-75" />
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              {offersRetry(thread) && <RetryButton project={project} thread={thread} onSent={onLeave} onFailed={onReturn} />}
              <Tooltip label={`Open in ${project.name}`}>
                <a href={boardHref} aria-label={`Open in ${project.name}`} onClick={(event) => openBoard(event, boardHref, false)} className={HEADER_ICON_CLASS}>
                  <ArrowUpRight size={15} />
                </a>
              </Tooltip>
              <Tooltip label="Open fullscreen">
                <a href={fullHref} aria-label="Open fullscreen" onClick={(event) => openBoard(event, fullHref, true)} className={HEADER_ICON_CLASS}>
                  <Maximize2 size={14} />
                </a>
              </Tooltip>
            </div>
          </header>

          <ProjectLinkScope project={project} threadSlug={thread.id}>
            <div className="flex min-w-0 flex-col gap-4 px-5 pt-5 pb-4">
              {handoff.data?.asked && <AskedBubble text={handoff.data.asked} />}
              {/* Only the PROSE clamps. The fence card under it is the handoff's ledger — what shipped, or
                  what it is waiting on — and the rested notice is its state; both are the glance. */}
              {parts ? (
                parts.prose && (
                  <ClampedBody resetKey={thread.lastAssistantAt ?? ""}>
                    <Prose md={parts.prose} />
                  </ClampedBody>
                )
              ) : thread.lastAssistant || handoff.isError ? (
                // The board's own 200-character preview, until the whole message lands: a card that shows
                // the gist at once beats one that is blank for a round trip.
                <p className="text-[13px] leading-5 text-muted-80">{thread.lastAssistant ?? "The handoff could not be read."}</p>
              ) : null}
              {parts?.fences.map((fence, index) => <FenceBody key={index} kind={fence.kind} body={fence.body} />)}
              {/* Not gated on the handoff: a STALL's last record is often a tool call with no prose at
                  all, and its notice is about the process, not the message (showsRestedCard). */}
              {showsRestedCard(thread, text) && <RestedCard thread={thread} />}
            </div>

            {thread.questions && thread.questions.length > 0 && (
              <QueueDismissContext.Provider value={dismiss}>
                <RegisteredAnsweringProvider thread={thread} scope={answeringScope}>
                  <RegisteredQuestionStack thread={thread} className="shrink-0 px-5 pb-4 pt-0" />
                </RegisteredAnsweringProvider>
              </QueueDismissContext.Provider>
            )}
          </ProjectLinkScope>

          <ReplyBox project={project} thread={thread} onSent={onLeave} onFailed={onReturn} />

          <ThreadProjectScope projectId={project.id}>
            <footer className={`${BLOCK_RADIUS_INNER_BOTTOM} flex min-h-10 flex-wrap items-center justify-end gap-3 border-t border-border/70 bg-panel/95 px-3 py-2 text-[12px]`}>
              <SnoozeButton thread={thread} onSnoozed={onLeave} />
              <StateButton thread={thread} onArchived={onLeave} onDismissCancel={onReturn} />
            </footer>
          </ThreadProjectScope>
        </article>
      </div>
    </div>
  )
})

/**
 * The board card's stall recovery (HeaderActions.tsx RetryButton): the same message through the same
 * follow-up, sent to the thread's own project. The thread goes back to work, so the card leaves.
 */
function RetryButton({ project, thread, onSent, onFailed }: { project: QueuesProject; thread: ThreadView; onSent: () => void; onFailed: () => void }) {
  const queryClient = useQueryClient()
  const retry = useMutation({
    mutationFn: () =>
      projectRpc(project.id).followUp({ slug: thread.id, sessionId: thread.sessionId ?? "", message: STALLED_RETRY_MESSAGE, deliveryId: crypto.randomUUID() }),
    onMutate: onSent,
    onSuccess: () => {
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
        // `mr-[9px]`: the pill's border IS its ink, and the ↗ beside it carries ~9.4px of dead box on its
        // left, so this puts Retry at the cluster's own rhythm — MEASURED 2026-09-23 (ink-gaps.mjs, dsf 4,
        // sans): ↗ → ⤢ 20.50px of ink; Retry → ↗ 15.43px at `mr-1`, 20.43px here.
        className="mr-[9px] flex items-center gap-1.5 rounded-md border border-accent/45 bg-accent/10 px-2.5 py-1 text-[12px] font-medium text-accent outline-none transition-colors hover:border-accent/70 hover:bg-accent/15 disabled:opacity-50"
      >
        <RotateCcw size={12} />
        Retry
      </button>
    </Tooltip>
  )
}

/**
 * Markdown links inside this card, pointed at the card's project.
 *
 * Two delegated listeners on the document act on every rendered link (lib/local-file-links.ts,
 * lib/thread-links.ts), and both act on the PAGE's project: a file link opens through the page's `rpc`,
 * a `/thread/<slug>` link opens a drawer this page does not have. This intercepts both first, in the
 * capture phase, and sends them to the thread's own project — a file through that project's opener, a
 * thread link to that project's board.
 */
function ProjectLinkScope({ project, threadSlug, children }: { project: QueuesProject; threadSlug: string; children: ReactNode }) {
  const navigate = useNavigate()
  const onClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const target = event.target instanceof Element ? event.target : null
    const file = target?.closest<HTMLElement>("[data-local-path]")
    const path = file?.dataset.localPath
    if (file && path) {
      event.preventDefault()
      event.stopPropagation()
      // The same two outcomes lib/local-file-links.ts handles: opened by the project's opener, or no
      // opener configured and the path goes on the clipboard instead.
      projectRpc(project.id)
        .openLocalFile({ path, ...(file.dataset.localImage === "true" ? { image: true } : {}) })
        .then(async (result) => {
          if (result.action !== "copy") return
          await copyTextToClipboard(result.path)
          showToast("Copied local path")
        })
        .catch((error: unknown) => showToast(`Could not open local file: ${error instanceof Error ? error.message.slice(0, 100) : "unknown error"}`))
      return
    }
    const anchor = target?.closest<HTMLAnchorElement>("a[href^='/']")
    const href = anchor?.getAttribute("href")
    if (!anchor || !href || href.startsWith("//") || !isPlainLeftClick(event)) return
    // The markdown scope already pointed every in-app link at this project's `/project/<slug>`, so this
    // is a same-app navigation — done by the router rather than a document load.
    if (href.startsWith(`/project/${encodeURIComponent(project.slug)}/`)) {
      event.preventDefault()
      event.stopPropagation()
      if (href.endsWith("/full")) rememberFullscreenOrigin(threadSlug, "/queues")
      navigate(href)
    }
  }
  return <div className="contents" onClickCapture={onClickCapture}>{children}</div>
}

/** The human's last message, as the board draws it — their off-white bubble — clipped to a few lines. */
function AskedBubble({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex max-w-[85%] flex-col items-end gap-0.5 self-end">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        title={open ? "Show less" : "Show the whole message"}
        className={`${BLOCK_RADIUS} rounded-br-sm bg-user-bubble px-3.5 py-2.5 text-left text-[13px] leading-5 whitespace-pre-wrap [overflow-wrap:anywhere] text-user-bubble-fg outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg ${
          open ? "" : "line-clamp-3"
        }`}
      >
        {text}
      </button>
    </div>
  )
}

function Prose({ md }: { md: string }) {
  const html = useMarkdownHtml(md)
  return <LinkedHtml className={`md-body ${QUEUE_WRAP}`} html={html} />
}

/** A signal fence, drawn as the board's fence card — presentation only; the verbs live in the footer. */
function FenceBody({ kind, body }: { kind: "done" | "awaiting"; body: string }) {
  const html = useMarkdownHtml(body)
  return (
    <TranscriptCard icon={kind === "done" ? Check : Hourglass} label={kind === "done" ? "Done" : "Awaiting"}>
      {html && <LinkedHtml className={`md-body ${QUEUE_WRAP}`} html={html} />}
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
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const clipped = overflows && !open
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div
        className="relative min-w-0 overflow-hidden"
        style={clipped ? { maxHeight: CLAMP_PX, maskImage: "linear-gradient(to bottom, black 62%, transparent)" } : undefined}
      >
        <div ref={inner} className="flex min-w-0 flex-col gap-4">{children}</div>
      </div>
      {overflows && (
        // The board's disclosure row ("Ran 3 tool calls ›", ChatView.tsx): its label type, its hover, and
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
 * Reply to the agent, from here — the board's own prompt box (`Composer`: the same Enter keys, paste
 * and drop of attachments, auto-growth), without the model and permission readouts, which are one level
 * down on the thread's own board.
 *
 * THE DRAFT IS THE BOARD'S DRAFT. It is keyed exactly as that thread's composer keys it — its project's
 * directory, its slug, its session — so a reply half-typed here is waiting in the composer on its own
 * board, and the other way round. An attachment uploads to the THREAD's project (`attachBase`), not the
 * page's, which on this page would be the launching project.
 */
function ReplyBox({ project, thread, onSent, onFailed }: { project: QueuesProject; thread: ThreadView; onSent: () => void; onFailed: () => void }) {
  const queryClient = useQueryClient()
  const key = draftKey.followUp(project.projectDir, thread.id, thread.sessionId)
  const text = useDraftValues([key]).get(key) ?? ""
  const [error, setError] = useState<string>()
  const send = useMutation({
    mutationFn: (message: string) =>
      projectRpc(project.id).followUp({ slug: thread.id, sessionId: thread.sessionId ?? "", message, deliveryId: crypto.randomUUID() }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["projectsQueues"] }),
    onError: (cause, message) => {
      // The card faded on send; the message did not land, so bring it back with the text still in it —
      // unless something new was typed meanwhile, which is not ours to overwrite.
      if (!draftStore.get(key)) draftStore.set(key, message)
      onFailed()
      setError(cause instanceof Error ? cause.message : "The reply could not be sent.")
    },
  })
  const submit = () => {
    const message = text.trim()
    if (!message || !thread.sessionId || send.isPending) return
    setError(undefined)
    // Local truth first, then the network — the order every send on the board's card obeys.
    draftStore.set(key, "")
    onSent()
    send.mutate(message)
  }
  return (
    <div className="shrink-0 px-5 pb-3 pt-0">
      <Composer
        surface="queueComposer"
        value={text}
        onChange={(value) => draftStore.set(key, value)}
        onSubmit={submit}
        placeholder={(thread.questions?.length ?? 0) > 0 ? "Or skip the questions and reply…" : "Reply to the agent…"}
        attachBase={projectApiBase(project.id)}
      />
      {error && <div role="alert" className="mt-1.5 break-words text-[11px] leading-snug text-danger-soft">{error}</div>}
    </div>
  )
}
