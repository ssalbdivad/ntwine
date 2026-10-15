import { useContext, useEffect, useId, useRef, useState, type ReactNode } from "react"
import { ArrowRight, Check, ChevronDown, ChevronRight, Loader2, Split } from "lucide-react"
import { useQuery } from "@tanstack/react-query"
import { type ProjectCard, type SpinoffView, type ThreadView } from "@ntwine/shared"
import { rpc } from "../api/rpc.ts"
import { projectsQueuesQuery } from "../lib/projectsQueuesRead.ts"
import { useThreadApi, useThreadProjectDir } from "../api/threadApi.tsx"
import { stepPick } from "../lib/crossProject.ts"
import { useShortcutLabel, withShortcut } from "../lib/keyboardRuntime.ts"
import { PROJECT_STEP_CHORDS, detectPlatform, formatChord, parseChord } from "../lib/keybindings.ts"
import { mentionHref } from "../lib/mentionAutolink.ts"
import { spaNavigate } from "../lib/router.ts"
import { displayTitle, threadHandleOf } from "../groups.ts"
import { useBoard } from "../hooks.ts"
import { draftKey, useDraft } from "../lib/drafts.ts"
import { transcriptMetaChevronClass } from "../lib/transcriptMetaLabels.ts"
import { threadBySlug } from "../store.ts"
import { ThreadHandleLink } from "./MentionLinks.tsx"
import { ThreadSlugContext } from "./threadSlugContext.ts"
import { ProjectSquare } from "./ProjectSquare.tsx"
import { Dialog } from "./ui/Dialog.tsx"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "./ui/Menu.tsx"
import { Tooltip } from "./Tooltip.tsx"
import { BLOCK_RADIUS } from "./TranscriptCard.tsx"
import { TextareaCodeFences } from "./TextareaCodeFences.tsx"

// SPINOFFS — a new thread the human asks for from this one ("fix this", "investigate perf"), with this
// thread supplying the context. Three surfaces, one concept:
//
//   · SpinoffButton — the icon in every thread header: each queue card's and the drawer's.
//     It opens the one-field dialog, and the `spinoff` RPC starts the new thread — a fork of this one's
//     session, or a fresh thread on context ntwine assembles — without sending this one anything.
//   · SpinoffCard — the request, in this thread's timeline where the human sent it: the human's
//     instructions under the `@handle` of the thread it became.
//   · SpinoffOriginCard — the same card at the other end, heading the new thread: whose spinoff it is,
//     the human's instructions, and the context it started with folded beneath them.
//   · SpinoffOf — the child's way back, on its header's second line (and its queue card's meta line).
//
// A spinoff belongs to the THREAD. On its first day (2026-09-29) it was a hover action on every message,
// quoting the one it was clicked from; the maintainer moved it to the thread that evening. The human
// writes instructions either way, and those say what to spin off — so a control on every row bought
// only a quote. It went into the ⋯ menu first, then straight out onto the header strip (maintainer:
// "spinoff should appear on every card and in the drawer without having to expand"). "Spinoff" is one
// word, verb and noun alike.
//
// The server holds the edge (`thread_spinoff`, carried on ThreadView.spinoffs at both ends), so every
// surface reads the same row and none of them has to find the other thread in a transcript.

/** The mark every spinoff surface wears: lucide's Split turned to branch sideways. */
function SpinoffMark({ size, className = "" }: { size: number; className?: string }) {
  return <Split size={size} strokeWidth={2} aria-hidden className={`shrink-0 rotate-90 ${className}`} />
}

/** Whether a thread can be asked for a spinoff: a live ntwine session. A foreign row is not ours to read,
 *  and a held thread that has not started has nothing to spin off. */
function canSpinoff(thread: ThreadView | undefined): thread is ThreadView & { sessionId: string } {
  return Boolean(thread && thread.kind === "session" && thread.foreign !== true && thread.held === undefined && thread.sessionId)
}

/** The Spinoff icon in a thread's header strip, and its dialog; nothing for a thread that cannot take one.
 *  `className` is the strip's own icon class (HEADER_ICON_CLASS, plus whatever trim its place asks for).
 *  A queue card of another project must render this inside that project's ThreadProjectScope, or the
 *  request would go to the focused project's thread of the same slug. */
export function SpinoffButton({ thread, className }: { thread: ThreadView; className: string }) {
  const [open, setOpen] = useState(false)
  const keys = useShortcutLabel("thread.spinoff")
  if (!canSpinoff(thread)) return null
  return (
    <>
      <SpinoffDialog thread={thread} open={open} onOpenChange={setOpen} />
      <Tooltip label={withShortcut("Spinoff a new thread from this one", keys)}>
        <button
          type="button"
          aria-label="Spinoff"
          data-spinoff-button={thread.id}
          // `→` on this surface presses it (lib/keyboardRuntime.ts).
          data-command="spinoff"
          // The strip's shared focus behaviour: a click here must not take the keyboard away from the
          // prompt box below it.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setOpen(true)}
          className={className}
        >
          <SpinoffMark size={14} />
        </button>
      </Tooltip>
    </>
  )
}

/** The dialog behind SpinoffButton: one field, the instructions. The draft is kept per thread, so a
 *  dialog closed by accident reopens on what was typed. */
function SpinoffDialog({ thread, open, onOpenChange }: { thread: ThreadView & { sessionId: string }; open: boolean; onOpenChange: (open: boolean) => void }) {
  const api = useThreadApi()
  const projectDir = useThreadProjectDir()
  const [instructions, setInstructions, clearInstructions] = useDraft(draftKey.spinoff(projectDir, thread.id))
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  // WHERE THE NEW THREAD STARTS (2026-09-30: "spinoff threads should be able to be created cross
  // project"). This thread's project unless the human picks another open one; undefined is "here".
  const projects = useOpenProjects(open)
  const home = projects.find((p) => p.dir === projectDir)
  const [targetId, setTargetId] = useState<string | undefined>(undefined)
  const target = targetId && targetId !== home?.id ? projects.find((p) => p.id === targetId) : undefined
  const routeOwnRow = useRouteOwnRow()
  const route = home && projects.length > 1
    ? <SpinoffProjectRoute from={home} projects={projects} current={target ?? home} disabled={pending} onPick={(p) => setTargetId(p.id)} />
    : null
  useEffect(() => {
    if (!open) {
      setError(null)
      setTargetId(undefined)
    }
  }, [open])

  // ⌥↓ / ⌥↑ — the next or previous project, as in the new-thread box (AllQueues.tsx onColumnKeyDown):
  // the same list order, wrapping at either end, and the key stays the browser's when there is nowhere
  // else to go. Read off the document for as long as the dialog is up, not off the field, so the chord
  // still steps after a click has moved focus to a footer button or the dialog's own body. Capture
  // phase, and stopped there, so nothing behind the modal reads the same chord.
  useEffect(() => {
    if (!open || !home || pending || projects.length < 2) return
    const from = (target ?? home).slug
    function onKeyDown(event: KeyboardEvent) {
      const step = projectStep(event)
      if (!step) return
      const next = stepPick(projects.map((p) => ({ ...p, open: true, stale: false })), from, step)
      if (!next) return
      event.preventDefault()
      event.stopPropagation()
      setTargetId(next.id)
    }
    document.addEventListener("keydown", onKeyDown, true)
    return () => document.removeEventListener("keydown", onKeyDown, true)
  }, [open, home, pending, projects, target])

  function submit() {
    const text = instructions.trim()
    if (!text || pending) return
    setPending(true)
    setError(null)
    api.spinoff({ slug: thread.id, sessionId: thread.sessionId, instructions: text, ...(target ? { project: target.id } : {}) })
      .then(() => {
        clearInstructions()
        onOpenChange(false)
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPending(false))
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!pending) onOpenChange(next) }}
      title="Spinoff"
      className="w-[460px] max-w-[92vw]"
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        fieldRef.current?.focus()
      }}
      footer={
        <>
          {/* Only where there is somewhere else to start: one open project has nothing to choose. */}
          {!routeOwnRow && route}
          <button
            type="button"
            disabled={pending}
            onClick={() => onOpenChange(false)}
            className="button-outline rounded-md px-3 py-1.5 text-[12px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-45"
          >
            Cancel
          </button>
          <button
            type="button"
            data-spinoff-submit
            disabled={pending || !instructions.trim()}
            onClick={submit}
            className="button-outline flex items-center gap-1.5 rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-bg outline-none transition-opacity hover:opacity-90 disabled:opacity-45"
          >
            {pending && <Loader2 size={12} className="animate-spin" />}
            Spinoff
          </button>
        </>
      }
    >
      <div data-spinoff-dialog className="flex flex-col gap-1.5 p-4">
        <textarea
          ref={fieldRef}
          data-spinoff-instructions
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          rows={3}
          placeholder="What should the new thread do?"
          aria-label="What the new thread should do"
          data-1p-ignore
          className={`w-full resize-none ${BLOCK_RADIUS} border border-border bg-bg px-3 py-2 text-[13px] leading-5 text-fg outline-none transition-colors placeholder:text-muted focus:border-accent`}
        />
        <TextareaCodeFences value={instructions} />
        {error
          ? <p role="alert" className="text-[11px] leading-4 text-danger">{error}</p>
          : <p className="text-[11px] leading-4 text-muted-60">{target ? `It starts in ${target.name}, with this thread's context.` : "It starts with this thread's context."}</p>}
        {routeOwnRow && route && <div className="flex pt-1.5">{route}</div>}
      </div>
    </Dialog>
  )
}

const PROJECT_STEP_KEYS = [PROJECT_STEP_CHORDS.previous, PROJECT_STEP_CHORDS.next].map((chord) => formatChord(parseChord(chord)!, detectPlatform())).join("/")

/** ⌥↓ is a step down the project menu, ⌥↑ one up; 0 for any other key. The new-thread box's own reading
 *  of the chord (AllQueues.tsx projectStep). */
function projectStep(event: KeyboardEvent): 1 | -1 | 0 {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing || event.defaultPrevented) return 0
  return event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0
}

/** A project this server has OPEN — the only kind a spinoff can start in (the server refuses the rest). */
interface OpenProject { id: string; slug: string; name: string; dir: string; card: ProjectCard; threads: readonly ThreadView[] }

/** Every open project, from the machine-wide polls the All projects page already runs (same keys, so
 *  one fetch serves both). Joined with the project list for each one's icon; the Home workspace last. */
function useOpenProjects(enabled: boolean): OpenProject[] {
  const queues = useQuery({ ...projectsQueuesQuery, enabled, staleTime: 5_000 })
  const cards = useQuery({ queryKey: ["projectsList"], queryFn: () => rpc.projectsList(), enabled })
  const out: OpenProject[] = []
  for (const q of queues.data ?? []) {
    const card = cards.data?.find((c) => c.id === q.projectId)
    if (card?.stale) continue
    out.push({
      id: q.projectId, slug: q.projectSlug, name: card?.name ?? q.projectName, dir: q.projectDir, threads: q.threads,
      card: card ?? { id: q.projectId, slug: q.projectSlug, name: q.projectName, path: q.projectDir, lastOpenedAt: "", stale: false, iconStatus: "unknown" },
    })
  }
  // The project list's own order — the prompt box's picker and its ⌥↑/⌥↓ walk the same one.
  const rank = (p: OpenProject) => { const i = cards.data?.findIndex((c) => c.id === p.id) ?? -1; return i === -1 ? Infinity : i }
  out.sort((a, b) => rank(a) - rank(b))
  return [...out.filter((p) => !p.card.home), ...out.filter((p) => p.card.home)]
}

/** WHERE THE ROUTE GOES: the footer's left end, unless the dialog is too narrow to hold it beside Cancel and
 *  Spinoff — then its own row, under the field. At a 300px VS Code sidebar the dialog is 276px, the buttons
 *  leave the route ~98px, and the source chip's 45% left the picker's name 0px: "ac… → [ ⌄ ]", nowhere
 *  saying where the new thread starts. The dialog is `min(460px, 92vw)`, a function of the window alone, so
 *  the window decides: under 440px (a dialog under 405px, a route under ~224px — "acme-api → acme-api" needs
 *  ~196px) the route takes the row, whole; from 440 up (a 450px sidebar, the desktop) it stays in the footer.
 *  ONE route is mounted, never a hidden twin, so there is one picker and one menu. */
const ROUTE_OWN_ROW_QUERY = "(max-width: 439.98px)"
function useRouteOwnRow(): boolean {
  const [ownRow, setOwnRow] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.(ROUTE_OWN_ROW_QUERY).matches)
  useEffect(() => {
    const query = window.matchMedia?.(ROUTE_OWN_ROW_QUERY)
    if (!query) return
    const update = () => setOwnRow(query.matches)
    update()
    query.addEventListener("change", update)
    return () => query.removeEventListener("change", update)
  }, [])
  return ownRow
}

/** The dialog's "start in" pill: the footer's left end, in the footer buttons' own chrome and size, so it
 *  reads as a setting of the request rather than a third action. Ink gaps (sans 12px, scripts/ink-gaps.mjs,
 *  2026-09-30): square→name at `gap-[5px]` to match the prompt box's project picker (it drew 6.50px at
 *  `gap-1.5`); name→chevron 6.31px against that picker's 6.00px, left alone. */
/** FROM → INTO, at the footer's left end: this thread's project, then where the new thread starts (the
 *  picker, this project by default). A spinoff carries context ONE way, out of this thread into the new
 *  one, so the arrow points at the destination — the reading order, source first. A left-pointing merge
 *  arrow (GitHub's `base ← compare`) would say the chosen project flows back into this one. The source is
 *  plain text, not a control: it is a fact about this thread, and only the destination is a choice. */
function SpinoffProjectRoute({ from, ...picker }: { from: OpenProject } & Parameters<typeof SpinoffProjectPicker>[0]) {
  return (
    <div data-spinoff-route className="flex min-w-0 flex-1 items-center gap-1.5 text-[12px] text-muted">
      <span data-spinoff-from={from.slug} title={`From ${from.name}`} className="flex min-w-0 max-w-[45%] shrink-0 items-center gap-[5px]">
        <ProjectSquare project={from.card} size={12} />
        <span className="min-w-0 truncate">{from.name}</span>
      </span>
      {/* The arrow's box is mostly dead space: at `gap-1.5` alone it drew 9.06px of ink after the name and
          8.00px before the pill's border (scripts/ink-gaps.mjs, sans 12px, 2026-09-30). The margins take
          both to ~6px, so it sits evenly between the two ends it joins. */}
      <ArrowRight size={12} aria-label="into" className="-ml-[0.25em] -mr-[0.17em] shrink-0 text-muted-60" />
      <SpinoffProjectPicker {...picker} />
    </div>
  )
}

function SpinoffProjectPicker({ projects, current, disabled, onPick }: {
  projects: OpenProject[]
  current: OpenProject
  disabled: boolean
  onPick: (project: OpenProject) => void
}) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          data-spinoff-project={current.slug}
          aria-label={`The new thread starts in ${current.name}. Choose a project`}
          title={`The new thread starts in ${current.name} (${PROJECT_STEP_KEYS} in the field)`}
          className="button-outline flex min-w-0 shrink items-center gap-[5px] rounded-md px-2.5 py-1.5 text-[12px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-45 data-[state=open]:bg-panel-2 data-[state=open]:text-fg"
        >
          <ProjectSquare project={current.card} size={12} />
          <span className="min-w-0 truncate">{current.name}</span>
          <ChevronDown size={12} aria-hidden className="-ml-[3px] shrink-0 text-fg/65" />
        </button>
      </MenuTrigger>
      <MenuContent align="start" aboveDialog>
        <div className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-medium text-muted-55">Start in</div>
        <div className="max-h-[min(60vh,420px)] overflow-y-auto">
          {projects.map((project) => (
            <MenuItem key={project.id} value={project.slug} onSelect={() => onPick(project)} icon={<ProjectSquare project={project.card} size={14} />}>
              <span className={`min-w-0 flex-1 truncate ${project.id === current.id ? "text-fg" : ""}`}>{project.name}</span>
              {project.id === current.id && <Check size={12} aria-label="Current" className="shrink-0 text-fg" />}
            </MenuItem>
          ))}
        </div>
      </MenuContent>
    </Menu>
  )
}

type FarEnd = NonNullable<ReturnType<typeof useFarEnd>>

/** What a far end is called when its thread is not among the open threads the poll carries (it is done,
 *  or the poll has not landed yet). */
function farFallback(far: FarEnd): string {
  return far.projectName ? `a thread in ${far.projectName}` : "a thread in another project"
}

/** A spinoff's other thread: the board's own link for an end in this project (`projectId` undefined); for
 *  one in another, that project's thread and address (CrossProjectEnd). */
function SpinoffEndLink({ slug, projectId, className = HEADER_LINK, named = true }: { slug: string; projectId: string | undefined; className?: string; named?: boolean }) {
  return projectId
    ? <CrossProjectEnd slug={slug} projectId={projectId} className={className} named={named} />
    : <ThreadHandleLink slug={slug} className={className} />
}

/** Its own component so the machine-wide lookup mounts only for a cross-project edge — a surface drawing a
 *  same-project one may have no query client. The project is named after a resolved handle, since the
 *  handle alone could be a thread of this one; a project not open here has no address, so it is text. */
function CrossProjectEnd({ slug, projectId, className, named }: { slug: string; projectId: string; className: string; named: boolean }) {
  const far = useFarEnd(projectId, slug)!
  if (!far.href) return <span className="min-w-0 truncate">{farFallback(far)}</span>
  return (
    <>
      <ThreadHandleLink slug={slug} thread={far.thread} href={far.href} onOpen={far.onOpen} fallback={farFallback(far)} className={className} />
      {/* The underlined link's ink runs to its box edge, so the row's gap drew 6.98px of ink before "in"
          where the row's other word spaces draw ~5.4px; the margin takes the difference back. */}
      {named && far.thread && <span className="-ml-[0.115em] min-w-0 shrink truncate">in {far.projectName}</span>}
    </>
  )
}

/** The link to a spinoff's far end when it is in ANOTHER project (SpinoffView.parentProjectId /
 *  childProjectId): that project's thread off the machine-wide poll, and its address there, opened in
 *  place as a cross-project mention is. Undefined for an end in this project. */
function useFarEnd(projectId: string | undefined, slug: string | null | undefined) {
  const projects = useOpenProjects(projectId !== undefined)
  if (!projectId || !slug) return undefined
  const project = projects.find((p) => p.id === projectId)
  if (!project) return { thread: null, projectName: undefined, href: undefined, onOpen: undefined }
  const href = mentionHref(slug, undefined, project.slug)
  return { thread: project.threads.find((t) => t.id === slug) ?? null, projectName: project.name, href, onOpen: () => spaNavigate(href) }
}

// ── The two ends of a spinoff, as cards ────────────────────────────────────────────────────────────
//
// A DEDICATED CARD, NOT THE HUMAN'S BUBBLE (David 2026-09-30, on both ends at once: "there needs to
// be a special UI affordance for referencing spinoff context … Make a dedicated spinoff header UI", and
// of the parent, "dedicated UI and link to the spinoff, much cleaner"). The request drew as the human's
// filled bubble with a small caption under it, and the child's first turn as one giant bubble holding
// the whole brief — another thread's words wearing the human's voice.
//
// So both ends wear one card, and it borrows exactly half of the bubble: its PLACE (right-aligned, 85%,
// the tail corner — the human asked for this) and its type size, but an OUTLINE where the bubble has a
// fill, so it reads as an action taken rather than a thing said. The two ends share the shell and the
// header row, so a reader who has seen one recognises the other as the same feature.

/** The card shell both ends share. `data-spinoff-card` names which end. */
const CARD_SHELL = `${BLOCK_RADIUS} rounded-br-sm border border-border-strong px-3.5 py-3 text-[14px] text-fg`

// THE HEADER ROW: the mark, the word, the other thread. 13px — one step under the instructions it heads
// (14px, the bubble's own size), so the human's words stay the body and the row reads as their label.
//
// `items-baseline` + the glyph's `self-baseline translate-y-[calc(0.5em_-_0.5cap)]` puts a symmetric 1em
// glyph's ink on the text's cap band in whatever font resolved (lib/transcriptMetaLabels.ts carries the
// derivation); the negative top margin stops the 1em box, which reaches above the text's ascent, from
// growing the row. The same rule every mark-beside-text in the transcript uses. Measured ink-to-cap-band
// residual, sans at 13px: -0.26px for the Split mark and the disclosure chevron alike —
// under the device grid, so left alone.
//
// HORIZONTAL: `gap-1.5` is a BOX distance. Between "Spinoff" and the handle it draws 5.3–5.5px of ink (a
// word space, which is what it should read as), but between the mark and "Spinoff" it drew 8.25px — the
// glyph's own 1px of dead box on its right plus the S's side bearing — so the mark floated off the word
// it labels. `-mr-[0.2em]` takes the difference back, putting the three marks of the row on one even
// rhythm (scripts/ink-gaps.mjs, dsf 4, sans, 2026-09-30).
const HEADER_ROW = "flex min-w-0 items-baseline gap-1.5 text-[13px] leading-5 text-muted"
const HEADER_GLYPH = "size-[1em] shrink-0 self-baseline -mt-[calc(1em_-_1cap)] -mr-[0.2em] translate-y-[calc(0.5em_-_0.5cap)]"
// The other thread is the row's prominent element — the thing the card exists to point at.
const HEADER_LINK = "min-w-0 truncate rounded-sm font-medium text-fg underline decoration-muted/40 underline-offset-2 outline-none hover:decoration-fg/70 focus-visible:ring-1 focus-visible:ring-focus-ink-60"
// The instructions: verbatim, so their line breaks survive, and never allowed to push the card wide.
const BODY = "mt-1.5 whitespace-pre-wrap [overflow-wrap:anywhere]"

/** Where a spinoff request stands, as its card shows it. */
export type SpinoffCardState = "started" | "unstarted" | "detached"

/** A request with a child has STARTED — every request ntwine makes now, since the row is written once the
 *  child exists (server router.ts `spinoff`). The other two are older rows:
 *   · UNSTARTED — a request an older build handed to the parent's worker, which never started a thread.
 *   · DETACHED — the board row lists the thread's spinoffs and this request is not among them: the row is
 *     gone, which in practice means its child was forgotten (storage drops the edge with the child so a
 *     thread that later reuses the slug is not mistaken for it). The card then states only that it was a
 *     spinoff — not "didn't start", which would be false, and no link to a thread that no longer exists.
 *  `edgeGone` says the thread's board row carries its spinoff edges, but none for this request. */
export function spinoffCardState(edge: SpinoffView | undefined, edgeGone: boolean): SpinoffCardState {
  if (edge?.childSlug) return "started"
  return !edge && edgeGone ? "detached" : "unstarted"
}

/** The thread a transcript belongs to, off the board — the card's own read of the edge, so Message passes
 *  nothing through for it and its memo holds on every board tick. */
function useTranscriptThread(): ThreadView | undefined {
  const board = useBoard()
  return threadBySlug(board, useContext(ThreadSlugContext))
}

/** The request as it sits in the parent's timeline where the human asked for it: the thread it became,
 *  and the human's instructions under it. */
export function SpinoffCard({ id, instructions, sourceId }: { id: string; instructions: string; sourceId?: string }) {
  const thread = useTranscriptThread()
  const edge = thread?.spinoffs?.find((o) => o.id === id)
  const state = spinoffCardState(edge, thread?.spinoffs !== undefined)
  return (
    <div data-ntwine-msg={sourceId} data-spinoff={id} data-spinoff-card="request" data-spinoff-state={state} className="self-end flex min-w-0 max-w-[85%] flex-col">
      <div className={CARD_SHELL}>
        <div className={HEADER_ROW}>
          <SpinoffMark size={14} className={HEADER_GLYPH} />
          <span className="shrink-0">Spinoff</span>
          {state === "started" ? (
            <SpinoffEndLink slug={edge!.childSlug!} projectId={edge!.childProjectId} />
          ) : state === "unstarted" ? (
            <span data-spinoff-pending className="min-w-0 truncate text-muted-70">didn't start</span>
          ) : null}
        </div>
        <p className={BODY}>{instructions}</p>
      </div>
    </div>
  )
}

/** The head of a spinoff child's transcript: whose spinoff it is, what the human asked for, and — folded,
 *  one click away — the context it started with. `context` is that context already rendered (the
 *  transcript's markdown renderer, which lives in ChatView). */
export function SpinoffOriginCard({ instructions, context, sourceId }: { instructions: string; context: ReactNode; sourceId?: string }) {
  const thread = useTranscriptThread()
  const edge = thread?.spinoffs?.find((o) => o.childSlug === thread.id && !o.childProjectId)
  const board = useBoard()
  const parent = edge && !edge.parentProjectId ? threadBySlug(board, edge.parentSlug) : undefined
  const parentHandle = parent ? threadHandleOf(parent) : undefined
  // The disclosure names the parent as TEXT: a link inside the toggle would be a control inside a control,
  // and the header right above it already links the thread. A parent in another project is named by the
  // header alone.
  const parentName = parentHandle ? `@${parentHandle}` : parent ? displayTitle(parent) : edge && !edge.parentProjectId ? edge.parentSlug : undefined
  const [open, setOpen] = useState(false)
  const contextId = useId()
  return (
    <div data-ntwine-msg={sourceId} data-spinoff-card="origin" className="self-end flex min-w-0 max-w-[85%] flex-col">
      <div className={CARD_SHELL}>
        <div className={HEADER_ROW}>
          <SpinoffMark size={14} className={HEADER_GLYPH} />
          {edge ? (
            <>
              <span className="shrink-0">Spinoff of</span>
              <SpinoffEndLink slug={edge.parentSlug} projectId={edge.parentProjectId} />
            </>
          ) : (
            <span className="shrink-0">Spinoff</span>
          )}
        </div>
        <p className={BODY}>{instructions}</p>
        {/* THE CONTEXT, FOLDED. It is the parent's request and latest handoff ntwine quoted for this thread
            (or, on an older child, the brief the parent's worker wrote) — often thousands of characters —
            and the human already knows what it says, having been in that conversation; the instructions
            above are the part they wrote. Collapsed it is one quiet line, the transcript's own disclosure
            (label, then the chevron, as `Ran N tool calls ›` reads); open, the ruled muted aside another
            thread's words wear everywhere else in the chat (PeerSessionMessageLine). A forked child has no
            context to fold, and no disclosure. */}
        {context != null && (
        <div className="mt-2.5 border-t border-border/60 pt-2">
          <button
            type="button"
            data-spinoff-context-toggle
            aria-expanded={open}
            aria-controls={contextId}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setOpen((v) => !v)}
            className="group flex max-w-full min-w-0 items-baseline gap-1.5 rounded-sm text-left text-[13px] leading-5 text-muted outline-none transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60"
          >
            <span className="min-w-0 truncate">{parentName ? `Context from ${parentName}` : "Context"}</span>
            <ChevronRight aria-hidden size={13} className={transcriptMetaChevronClass(open)} />
          </button>
          {open ? (
            <div id={contextId} data-spinoff-context className="card-md mt-2 border-l border-border/70 pl-3 text-muted">
              {context}
            </div>
          ) : <div id={contextId} hidden />}
        </div>
        )}
      </div>
    </div>
  )
}

/** The child's header line back to the thread it came from, or nothing. On a queue card of another
 *  project the card passes its own `resolve`, `href` and `onOpen`: the page's board is not that
 *  project's. `compact` is the queue card's form — see below. */
export function SpinoffOf({ thread, lead, resolve, href, onOpen, compact = false }: {
  thread: ThreadView
  lead?: ReactNode
  resolve?: (slug: string) => ThreadView | undefined
  href?: (slug: string) => string
  onOpen?: (slug: string) => void
  compact?: boolean
}) {
  const edge = thread.spinoffs?.find((o) => o.childSlug === thread.id && !o.childProjectId)
  if (!edge) return null
  const parentSlug = edge.parentSlug
  const linkClass = `${compact ? "min-w-0 truncate " : ""}rounded-sm underline decoration-muted/30 underline-offset-2 outline-none hover:text-fg hover:decoration-fg/60 focus-visible:ring-1 focus-visible:ring-focus-ink-60`
  // A parent in ANOTHER project is that project's thread wherever this line is drawn, whichever board
  // `resolve` reads.
  const link = edge.parentProjectId ? <SpinoffEndLink slug={parentSlug} projectId={edge.parentProjectId} className={linkClass} named={!compact} /> : (
    <ThreadHandleLink
      slug={parentSlug}
      thread={resolve ? resolve(parentSlug) ?? null : undefined}
      href={href?.(parentSlug)}
      onOpen={onOpen ? () => onOpen(parentSlug) : undefined}
      className={linkClass}
    />
  )
  return (
    <>
      {lead}
      {/* BEFORE the status line, never after it: that line is `flex-1` so it can take whatever the row
          has left, and anything placed after it was pushed to the far end of the row with a hole in
          front of it. Capped so a long handle truncates before the live status does — by the caller, on
          the facts line's `Fact` that holds this (ThreadHeaderFacts): a percentage here would be a share
          of that fact's own width, not the line's. */}
      {compact ? (
        // THE QUEUE CARD'S FORM: the mark stands for the words. The card's meta line already carries the
        // ready time and the live status, and at a phone's 420px the full "Spinoff of @handle" left the
        // status one letter and an ellipsis (screenshot 2026-09-30). The mark is the one every spinoff
        // surface wears — the same glyph as the Spinoff button at the other end of this card's header —
        // and the words stay for a screen reader and on hover. The row is `items-baseline`, so the
        // glyph takes the cap-band rule every mark-beside-text uses. Horizontally it keeps MORE room than
        // the cards' header glyph: the handle beside it is underlined from its first pixel, and at the
        // cards' 0.2em trim (3.2px of ink to the `@`) the underline read as touching the mark's arrow.
        // At 0.1em: 4.3px, measured by geometry (the glyph's path boxes against the text's canvas ink),
        // sans 11px, 2026-09-30.
        <span data-spinoff-of={parentSlug} title="Spinoff of" className="flex min-w-0 items-baseline gap-1">
          <SpinoffMark size={11} className="size-[1em] self-baseline -mr-[0.1em] translate-y-[calc(0.5em_-_0.5cap)]" />
          <span className="sr-only">Spinoff of </span>
          {link}
        </span>
      ) : (
        <span data-spinoff-of={parentSlug} className="min-w-0 truncate">
          Spinoff of {link}
        </span>
      )}
    </>
  )
}
