// THE DOCK — every project as a square at the head of the list (plans/all-projects-first.md § Dock and
// lenses). The list below it orders threads by what they need, not by project, so this is where a project
// is found, opened and managed:
//
//   click            that project's own page (`/project/<slug>`); its square again, back to All projects
//   shift/⌘-click    add it to, or take it out of, a LENS — All projects narrowed to the projects picked
//                    (lib/lens.ts); a lens can be saved by name and comes back as a chip
//   right-click      the project's menu (ProjectActions.tsx ProjectMenu): its folder, repo, icon, rename,
//                    remove — what each project row's "…" carried before the list stopped having them
//   drag, ⌥←/⌥→      the machine-wide order, which the dock and the prompt box's picker both read
//
// A square says, without a hover: how many of its threads are Ready (the accent badge, the one number that
// wants you), and whether any is working (a tick under it). Outside the view — another project's page, or
// not in the lens — it is dimmed, not hidden: every project is always one click away.
//
// It is the page's ONE place to choose a view: the title over the prompt box was a dropdown of the same
// projects until 2026-10-14, and was dropped as a second copy of this.
import { useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Plus, X } from "lucide-react"
import type { ProjectCard } from "@ntwine/shared"
import { rpc } from "../api/rpc.ts"
import { squareCard, threadKey, type QueuesProject } from "../lib/allQueues.ts"
import { deleteLens, saveLens, savedNameOf, setLens, useLens, useSavedLenses } from "../lib/lens.ts"
import { usePageView } from "../lib/pageView.ts"
import { ProjectMenu, useAddProject } from "./ProjectActions.tsx"
import { AllProjectsSquare, ProjectSquare } from "./ProjectSquare.tsx"

const SQUARE = 20

export function ProjectDock({
  projects,
  hidden,
  home,
  onAll,
  onProject,
  inline = false,
}: {
  projects: readonly QueuesProject[]
  hidden: (key: string) => boolean
  home: string | undefined
  /** Back to All projects, from the project the page was on. */
  onAll: (from: QueuesProject | undefined) => void
  onProject: (slug: string) => void
  /** Drawn as the status row's title (StatusRow.tsx) rather than a block over the list: the row sets its
   *  own edges and line, so the dock brings no padding or margin of its own. */
  inline?: boolean
}) {
  const view = usePageView()
  const lens = useLens()
  const saved = useSavedLenses()
  const add = useAddProject()
  const reorder = useDockReorder(projects)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const focused = view.kind === "project" ? projects.find((p) => p.slug === view.slug) : undefined
  const inView = (project: QueuesProject) => (focused ? focused.id === project.id : lens ? lens.has(project.id) : true)
  const lensName = savedNameOf(lens, saved)

  const click = (project: QueuesProject, additive: boolean) => {
    if (additive) {
      // A lens is All projects', so building one from a project's page starts from that project.
      const base = new Set(lens ?? (focused ? [focused.id] : []))
      if (base.has(project.id)) base.delete(project.id)
      else base.add(project.id)
      setLens(base)
      if (focused) onAll(focused)
      return
    }
    if (focused?.id === project.id) onAll(focused)
    else onProject(project.slug)
  }

  return (
    <div data-xq-dock className={`flex min-w-0 flex-col gap-1.5 ${inline ? "flex-1" : "mb-2 pl-5 pr-1.5"}`}>
      {(saved.length > 0 || (lens && !lensName)) && (
        <div data-xq-lenses className="flex min-w-0 flex-wrap items-center gap-1">
          {saved.map((entry) => (
            <LensChip
              key={entry.name}
              label={entry.name}
              active={!focused && lensName === entry.name}
              onClick={() => { setLens(entry.ids); onAll(focused) }}
              onRemove={() => deleteLens(entry.name)}
            />
          ))}
          {lens && !lensName && <SaveLens count={lens.size} onSave={(name) => saveLens(name, lens)} onClear={() => setLens(null)} />}
        </div>
      )}
      <div data-xq-dock-squares data-tour="dock-squares" className={`flex min-w-0 flex-wrap items-center gap-x-[10px] gap-y-2 ${inline ? "py-[3px]" : "pt-[8px]"}`}>
        {/* All LEADS the squares, a square itself (the phone's layers tile): one row reading "All, or one
            of these" is what says a square narrows the page, and it is the way back from a project's page.
            Ringed while it is the view, dimmed like any square outside it. It was a text chip until 2026-10-14. */}
        <button
          type="button"
          data-tour="dock-all"
          data-xq-dock-all
          aria-pressed={!focused && !lens}
          aria-label="All projects"
          title="All projects"
          onClick={() => { setLens(null); onAll(focused) }}
          className={`relative flex shrink-0 rounded-[5px] outline-none transition-opacity focus-visible:ring-1 focus-visible:ring-focus-ink-60 ${!focused && !lens ? "ring-1 ring-fg/70 ring-offset-2 ring-offset-bg" : "opacity-40 hover:opacity-90"}`}
        >
          <AllProjectsSquare size={SQUARE} />
        </button>
        {reorder.ordered.map((project) => {
          const ready = project.queued.filter((t) => !hidden(threadKey(project.id, t.id))).length
          const working = project.running.length
          const card = project.card ?? squareCard(project)
          const grip = reorder.grip(project.id)
          const square = (
            <button
              type="button"
              data-xq-dock-square={project.slug}
              data-xq-dock-in-view={inView(project) || undefined}
              data-xq-reshape
              aria-current={focused?.id === project.id ? "page" : undefined}
              aria-label={`${project.name}: ${ready} ready, ${working} working`}
              title={`${project.name}\n${ready} ready · ${working} working\nShift-click to view it beside others · right-click for its menu`}
              onClick={(event) => {
                if (grip.justDragged()) return
                click(project, event.shiftKey || event.metaKey || event.ctrlKey)
              }}
              onContextMenu={(event) => {
                if (!project.card) return
                event.preventDefault()
                setMenuFor(project.id)
              }}
              onPointerDown={grip.onPointerDown}
              onKeyDown={grip.onKeyDown}
              ref={grip.ref}
              style={{ transform: grip.offset ? `translate(${grip.offset.x}px, ${grip.offset.y}px)` : undefined, zIndex: grip.held ? 10 : undefined }}
              className={`relative flex shrink-0 rounded-[5px] outline-none transition-opacity focus-visible:ring-1 focus-visible:ring-focus-ink-60 ${inView(project) ? "" : "opacity-40 hover:opacity-90"} ${focused?.id === project.id || (lens?.has(project.id) ?? false) ? "ring-1 ring-fg/70 ring-offset-2 ring-offset-bg" : ""} ${grip.held ? "cursor-grabbing" : ""}`}
            >
              <span className={project.stale ? "grayscale" : ""}>
                <ProjectSquare project={card} size={SQUARE} />
              </span>
              {ready > 0 && (
                <span data-xq-dock-ready={ready} className="absolute -right-[7px] -top-[6px] flex h-[13px] min-w-[13px] items-center justify-center rounded-full bg-accent-fill px-[3px] text-[9px] font-semibold leading-none tabular-nums text-on-accent shadow-[0_0_0_1.5px_var(--color-bg)]">
                  {ready}
                </span>
              )}
              {working > 0 && <span data-xq-dock-working={working} aria-hidden className="absolute -bottom-[4px] left-1/2 h-[2px] w-[10px] -translate-x-1/2 rounded-full bg-fg/70" />}
            </button>
          )
          // The menu ANCHORS on an inert overlay of the square rather than wrapping it: as the trigger, the
          // square would open the menu on every left press, which is the click that opens the project.
          return (
            <span key={project.id} className="relative flex">
              {project.card && (
                <ProjectMenu
                  project={project.card}
                  home={home}
                  githubRepo={project.githubRepo}
                  focused={focused?.id === project.id}
                  onFocus={() => click(project, false)}
                  open={menuFor === project.id}
                  onOpenChange={(open) => !open && setMenuFor(null)}
                  align="start"
                >
                  <span aria-hidden tabIndex={-1} className="pointer-events-none absolute inset-0" />
                </ProjectMenu>
              )}
              {square}
            </span>
          )
        })}
        <button
          type="button"
          data-xq-dock-add
          data-tour="dock-add"
          aria-label="Add a project"
          title="Add a project"
          disabled={add.pending}
          onClick={add.start}
          className="flex h-5 w-5 items-center justify-center rounded-[5px] border border-dashed border-border-strong text-muted outline-none transition-colors hover:border-muted hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60"
        >
          <Plus size={12} />
        </button>
      </div>
    </div>
  )
}

const CHIP = "flex h-[19px] items-center gap-1 rounded-[5px] px-1.5 text-[11.5px] outline-none transition-colors focus-visible:ring-1 focus-visible:ring-focus-ink-60"

function LensChip({ label, active, onClick, onRemove }: { label: string; active: boolean; onClick: () => void; onRemove?: () => void }) {
  return (
    <span className={`group/chip ${CHIP} ${active ? "bg-hover-strong text-fg" : "text-muted hover:bg-hover hover:text-fg"}`}>
      <button type="button" data-xq-lens={label} aria-pressed={active} onClick={onClick} className="outline-none">
        {label}
      </button>
      {onRemove && (
        <button type="button" aria-label={`Forget ${label}`} title={`Forget ${label}`} onClick={onRemove} className="hidden text-muted-60 hover:text-fg group-hover/chip:flex">
          <X size={10} />
        </button>
      )}
    </span>
  )
}

/** An unsaved lens: how many projects it shows, a way to name and keep it, and a way out. */
function SaveLens({ count, onSave, onClear }: { count: number; onSave: (name: string) => void; onClear: () => void }) {
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState("")
  if (naming) {
    return (
      <form
        className={`${CHIP} bg-hover-strong`}
        onSubmit={(event) => {
          event.preventDefault()
          onSave(name)
          setNaming(false)
          setName("")
        }}
      >
        <input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => !name.trim() && setNaming(false)}
          onKeyDown={(event) => event.key === "Escape" && setNaming(false)}
          placeholder="Name this view"
          aria-label="Name this view"
          className="w-[110px] bg-transparent text-[11.5px] text-fg outline-none placeholder:text-muted-50"
        />
      </form>
    )
  }
  return (
    <span className={`${CHIP} bg-hover-strong text-fg`}>
      <span>{count} projects</span>
      <button type="button" data-xq-lens-save onClick={() => setNaming(true)} className="text-muted hover:text-fg">
        Save
      </button>
      <button type="button" data-xq-lens-clear aria-label="Show every project" title="Show every project" onClick={onClear} className="text-muted-60 hover:text-fg">
        <X size={10} />
      </button>
    </span>
  )
}

// ---- Reordering ---------------------------------------------------------------------------------------

/** A press travels this far before it is a drag rather than a click. */
const DRAG_THRESHOLD_PX = 4

/**
 * The dock's drag and ⌥←/⌥→ reorder, writing the machine-wide order (`projectsReorder`). The new order is
 * written into the `projectsList` cache at once, so the dock and the picker move before the server answers;
 * a failure puts back what was there. A drop lands where the square nearest the pointer was.
 */
function useDockReorder(projects: readonly QueuesProject[]) {
  const queryClient = useQueryClient()
  const elements = useRef(new Map<string, HTMLElement>())
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null)
  const draggedAt = useRef(0)
  const reorder = useMutation({
    mutationFn: ({ ids }: { ids: string[]; before: ProjectCard[] | undefined }) => rpc.projectsReorder({ ids }),
    onSuccess: (cards) => queryClient.setQueryData(["projectsList"], cards),
    onError: (_error, { before }) => {
      if (before) queryClient.setQueryData(["projectsList"], before)
      void queryClient.invalidateQueries({ queryKey: ["projectsList"] })
    },
  })
  const order = projects.filter((p) => p.card).map((p) => p.id)
  const commit = (id: string, toIndex: number) => {
    const from = order.indexOf(id)
    if (from < 0 || toIndex === from || toIndex < 0 || toIndex >= order.length) return
    const next = [...order]
    next.splice(from, 1)
    next.splice(toIndex, 0, id)
    void queryClient.cancelQueries({ queryKey: ["projectsList"] })
    const before = queryClient.getQueryData<ProjectCard[]>(["projectsList"])
    if (before) {
      const rank = new Map(next.map((cardId, index) => [cardId, index]))
      queryClient.setQueryData(["projectsList"], [...before].sort((a, b) => (rank.get(a.id) ?? next.length) - (rank.get(b.id) ?? next.length)))
    }
    reorder.mutate({ ids: next, before })
  }

  const grip = (id: string) => ({
    ref: (element: HTMLElement | null) => {
      if (element) elements.current.set(id, element)
      else elements.current.delete(id)
    },
    held: drag?.id === id,
    offset: drag?.id === id ? { x: drag.dx, y: drag.dy } : null,
    justDragged: () => Date.now() - draggedAt.current < 250,
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || !order.includes(id)) return
      const startX = event.clientX
      const startY = event.clientY
      const button = event.currentTarget
      let started = false
      const onMove = (move: PointerEvent) => {
        const dx = move.clientX - startX
        const dy = move.clientY - startY
        if (!started) {
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
          started = true
          button.setPointerCapture(move.pointerId)
        }
        setDrag({ id, dx, dy })
      }
      const onUp = (up: PointerEvent) => {
        window.removeEventListener("pointermove", onMove)
        window.removeEventListener("pointerup", onUp)
        window.removeEventListener("pointercancel", onUp)
        setDrag(null)
        if (!started) return
        draggedAt.current = Date.now()
        // The square whose centre is nearest the drop takes the dragged one's place.
        let best = -1
        let bestDistance = Infinity
        order.forEach((otherId, index) => {
          const box = elements.current.get(otherId)?.getBoundingClientRect()
          if (!box) return
          const distance = Math.hypot(box.left + box.width / 2 - up.clientX, box.top + box.height / 2 - up.clientY)
          if (otherId !== id && distance < bestDistance) {
            bestDistance = distance
            best = index
          }
        })
        if (best >= 0) commit(id, best)
      }
      window.addEventListener("pointermove", onMove)
      window.addEventListener("pointerup", onUp)
      window.addEventListener("pointercancel", onUp)
    },
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
      if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return
      // Claimed even at either end: unclaimed, the page would hear ⌥←/⌥→ as something else.
      event.preventDefault()
      commit(id, order.indexOf(id) + (event.key === "ArrowLeft" ? -1 : 1))
    },
  })

  return { ordered: projects, grip }
}
