// THE MACHINE'S PROJECT MANAGEMENT — one project's menu (its icon, rename, delete), the dialogs behind
// it, and the one hook that adds a project.
//
// All of it lived on the project grid until 2026-09-24, when the grid was folded into Everything and `/`
// became that page (AllQueues.tsx). The grid spread it over three controls per card — an image overlay
// on the square, an ellipsis menu, and the card itself; on a list row that is 16px tall there is room for
// one, so everything that is not "open this project" is behind the row's ellipsis now. The dialogs name
// the project they act on in full, because the row that opened them may be a truncated name.
import * as RadixDialog from "@radix-ui/react-dialog"
import * as RadixDropdown from "@radix-ui/react-dropdown-menu"
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useDeferredValue, useEffect, useRef, useState, type ReactNode } from "react"
import { Ellipsis, Loader2 } from "lucide-react"
import { useNavigate } from "react-router"
import { useSnapshot } from "valtio"
import { PROJECT_ICON_EXTENSIONS, slugify, type ProjectAddResult, type ProjectCard, type ProjectEnclosed } from "@ntwine/shared"
import { projectRpc, rpc } from "../api/rpc.ts"
import { innerPath, projectSlug } from "../lib/base-path.ts"
import { showToast, store } from "../store.ts"
import { rememberCrossProjectFocus } from "../lib/crossProject.ts"
import { ALL_PROJECTS, currentView, homeHref, projectViewHref, usePageView, viewHref } from "../lib/pageView.ts"
import { projectBoardKey } from "../lib/projectBoards.ts"
import { relativeAge } from "../lib/activityTime.ts"
import { useShortcut } from "../lib/keyboardRuntime.ts"
import { Dialog } from "./ui/Dialog.tsx"
import { ProjectSquare } from "./ProjectSquare.tsx"
import { ROW_ACTION_CLASS } from "./Sidebar.tsx"

/** `/Users/me/code/nub` → `~/code/nub`. The home prefix is noise on every row. */
export function shortPath(path: string, home: string | undefined): string {
  if (home && path === home) return "~"
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/**
 * UPSTREAM'S PROJECT CARD, in one line (U:ProjectGrid.tsx Card, the grid the fork's home replaced): its
 * `/slug` when that is not simply its name — a directory called "app" under "pullfrog" lives at
 * `/pullfrog-app`, worth saying, while "nub" would just repeat itself — and when it was last opened, in the
 * house age grammar (`Opened 2h ago`), or that its directory is missing. Its path is the line above it,
 * wherever it is drawn: the head of its menu.
 */
export function projectFacts(project: Pick<ProjectCard, "slug" | "name" | "lastOpenedAt" | "stale">, nowMs = Date.now()): string {
  const opened = relativeAge(project.lastOpenedAt || undefined, nowMs)
  const when = project.stale ? "Directory is missing" : opened ? `Opened ${opened}` : "Never opened"
  return project.slug !== project.name ? `/${project.slug} · ${when}` : when
}

const MENU_ITEM = "block cursor-default rounded px-2 py-1.5 text-[12.5px] text-fg outline-none data-[highlighted]:bg-panel-2"

/**
 * Everything you can do to a project besides work in it: open its repo, change its picture, rename it,
 * delete it.
 *
 * ONE MENU, on the project's row on the cross-project page. The grid split these between an image
 * overlay on the square ("change the picture") and an ellipsis ("rename, delete"), because a 34px square
 * had room for a control of its own; a 16px one does not, and two menus on one row is the clutter the
 * merge was for. It rides the project's square in the dock (ProjectDock.tsx), on right-click. Its repo on GitHub
 * leads the menu when it has one — the link a project view's status row carried, which went with it on
 * 2026-09-28 when the project view folded into Everything. Delete is
 * last and red, the one irreversible act here, kept apart from those that only change what ntwine calls
 * a project.
 *
 * The short path heads the menu: it is the one place a project's directory is still shown, and it is
 * what tells two projects with the same folder name apart.
 *
 * THE ICON: the NATIVE picker, opened standing in the project's own directory — a browser file input
 * cannot be aimed anywhere, and an icon almost always lives inside the project. The hidden input stays
 * as the fallback for a platform with no native dialog, so the item never becomes a dead end. A project
 * whose directory is gone gets neither icon item: there is nowhere to pick from. Failures are toasts —
 * the trigger is a row's ellipsis, and a paragraph beside it has nowhere to go.
 *
 * HELD FROM OUTSIDE, IT IS BUILT ON ITS FIRST OPENING. The dock draws one per project and opens it only on a
 * right-click, and ten closed menus — each a Radix tree and three mutations — were most of what the dock
 * cost to render: 60-130ms of every page render in a dev build with ten projects, re-paid on each switch of
 * the prompt box's project (2026-10-14, a `#slug` Tab). Once built it stays, so a rename or delete dialog, or
 * an icon pick still on the wire, outlives the menu closing.
 */
export function ProjectMenu(props: ProjectMenuProps) {
  const [built, setBuilt] = useState(props.open !== false)
  if (props.open && !built) setBuilt(true)
  return built ? <ProjectMenuBody {...props} /> : <>{props.children}</>
}

type ProjectMenuProps = {
  project: ProjectCard
  home: string | undefined
  /** `owner/repo` when the project's origin is github.com — its board's `githubRepo`, host-strict. */
  githubRepo?: string
  /** The page is focused on this project (lib/pageView.ts); with `onFocus`, the menu switches the view. */
  focused?: boolean
  onFocus?: () => void
  onOpenChange?: (open: boolean) => void
  /** Held open from outside — the dock opens it on a right-click, not from its trigger. */
  open?: boolean
  align?: "start" | "end"
  children: ReactNode
}

function ProjectMenuBody({
  project,
  home,
  githubRepo,
  focused = false,
  onFocus,
  onOpenChange,
  open,
  align = "end",
  children,
}: ProjectMenuProps) {
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const queryClient = useQueryClient()
  const backburner = useBackburner()
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["projectsList"] })
  const report = (cause: unknown) => showToast(cause instanceof Error ? cause.message : String(cause), { duration: 7000 })
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const bytes = new Uint8Array(await file.arrayBuffer())
      // Chunked: `String.fromCharCode(...bytes)` on a 4 MB icon blows the argument limit and throws
      // a RangeError that reads like a network failure.
      let binary = ""
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
      return rpc.projectIconSet({ id: project.id, name: file.name, data: btoa(binary) })
    },
    onSuccess: () => void invalidate(),
    onError: report,
  })
  const clear = useMutation({
    mutationFn: () => rpc.projectIconClear({ id: project.id }),
    onSuccess: () => void invalidate(),
    onError: report,
  })
  const pick = useMutation({
    mutationFn: () => rpc.projectIconPick({ id: project.id }),
    onSuccess: (result) => {
      if (result.kind === "cancelled") return
      if (result.kind === "unavailable") { input.current?.click(); return }
      void invalidate()
    },
    onError: () => input.current?.click(),
  })
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={PROJECT_ICON_EXTENSIONS.map((extension) => `.${extension}`).join(",")}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          // Reset first: picking the same file twice in a row fires no change event otherwise, so a
          // failed upload could not be retried with the same file.
          event.target.value = ""
          if (file) upload.mutate(file)
        }}
      />
      {/* Opening the menu is the cue: "Choose an icon…" is one move away, and on macOS a panel built at the
          click took most of a second to draw (server/directory-picker.ts). Speculative, so a failed
          request is dropped — the click builds its own panel. */}
      <RadixDropdown.Root open={open} onOpenChange={(next) => {
        if (next) rpc.projectIconPickWarm({ id: project.id }).catch(() => {})
        onOpenChange?.(next)
      }}>
        <RadixDropdown.Trigger asChild>{children}</RadixDropdown.Trigger>
        <RadixDropdown.Portal>
          {/* The items do NOT name the project: a name is a directory basename of any length, and this
              content has a min width and no max, so a long one would stretch the menu past its row. The
              row is the subject and each dialog names it in full. */}
          <RadixDropdown.Content
            align={align}
            sideOffset={6}
            className="z-[220] min-w-[190px] max-w-[280px] rounded-lg border border-border bg-panel p-1 shadow-xl shadow-shadow-ink/40"
          >
            <RadixDropdown.Label title={project.path} className="truncate px-2 pt-1 font-mono text-[11px] text-muted-70">
              {shortPath(project.path, home)}
            </RadixDropdown.Label>
            <RadixDropdown.Label data-project-facts className="truncate px-2 pb-1.5 text-[11px] text-muted-55">
              {projectFacts(project)}
            </RadixDropdown.Label>
            {onFocus && (
              <>
                {/* The page's view, from the project it names — the dock, said here
                    too: focused on this project it offers every project back, and otherwise this one. */}
                <RadixDropdown.Item className={MENU_ITEM} onSelect={onFocus}>
                  {focused ? "Show all projects" : "Focus on this project"}
                </RadixDropdown.Item>
                <RadixDropdown.Separator className="mx-1 my-1 h-px bg-border" />
              </>
            )}
            {githubRepo && (
              <>
                {/* A real anchor, so ⌘-click, middle-click and copy-link behave as a link does. */}
                <RadixDropdown.Item asChild className={MENU_ITEM}>
                  <a href={`https://github.com/${githubRepo}`} target="_blank" rel="noopener">
                    Open on GitHub
                  </a>
                </RadixDropdown.Item>
                <RadixDropdown.Separator className="mx-1 my-1 h-px bg-border" />
              </>
            )}
            {project.home ? (
              // The Home workspace is ntwine's, not a folder the operator registered: it has no icon to
              // choose, its name is fixed, and it cannot be deleted. What CAN change is the folder its
              // agents run in, which is a setting — so the menu opens Settings there.
              <RadixDropdown.Item className={MENU_ITEM} onSelect={() => { store.showSettings = true }}>
                Change folder…
              </RadixDropdown.Item>
            ) : (
            <>
            {!project.stale && (
              <>
                <RadixDropdown.Item className={MENU_ITEM} onSelect={() => pick.mutate()}>
                  {upload.isPending ? "Uploading…" : "Choose an icon…"}
                </RadixDropdown.Item>
                <RadixDropdown.Item className={MENU_ITEM} onSelect={() => clear.mutate()}>
                  {project.iconIsCustom ? "Use the detected icon" : "Look for an icon again"}
                </RadixDropdown.Item>
              </>
            )}
            <RadixDropdown.Item className={MENU_ITEM} onSelect={() => setRenaming(true)}>
              Rename…
            </RadixDropdown.Item>
            <RadixDropdown.Item data-project-backburner className={MENU_ITEM} onSelect={() => backburner.mutate({ project, on: !project.backburner })}>
              {project.backburner ? "Take off the backburner" : "Move to the backburner"}
            </RadixDropdown.Item>
            <RadixDropdown.Item
              className="cursor-default rounded px-2 py-1.5 text-[12.5px] text-danger outline-none data-[highlighted]:bg-danger-fill/10 data-[highlighted]:text-danger-soft"
              onSelect={() => setDeleting(true)}
            >
              Delete project…
            </RadixDropdown.Item>
            </>
            )}
          </RadixDropdown.Content>
        </RadixDropdown.Portal>
      </RadixDropdown.Root>
      {renaming ? <RenameProjectDialog project={project} home={home} onClose={() => setRenaming(false)} /> : null}
      {deleting ? <DeleteProjectDialog project={project} home={home} onClose={() => setDeleting(false)} /> : null}
    </>
  )
}

/**
 * Put a project on the backburner or take it off (server RegistryEntry.backburner). The `projectsList`
 * cache is written at once, so its square leaves the dock — or comes back — on the click; a failure
 * puts back what was there.
 */
export function useBackburner() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ project, on }: { project: ProjectCard; on: boolean }) => rpc.projectBackburner({ id: project.id, backburner: on }),
    onMutate: async ({ project, on }) => {
      await queryClient.cancelQueries({ queryKey: ["projectsList"] })
      const before = queryClient.getQueryData<ProjectCard[]>(["projectsList"])
      if (before) {
        queryClient.setQueryData<ProjectCard[]>(["projectsList"], before.map((card) => {
          if (card.id !== project.id) return card
          const { backburner: _, ...rest } = card
          return on ? { ...rest, backburner: true as const } : rest
        }))
      }
      return { before }
    },
    onSuccess: (_card, { project, on }) => showToast(on ? `Moved ${project.name} to the backburner` : `Took ${project.name} off the backburner`),
    onError: (cause, _vars, context) => {
      if (context?.before) queryClient.setQueryData(["projectsList"], context.before)
      showToast(cause instanceof Error ? cause.message : String(cause), { duration: 7000 })
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["projectsList"] }),
  })
}

/** The last path segment, on either separator: the registry stores native paths and Windows uses `\\`. */
function folderName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).pop() ?? path
}

/**
 * Rename a project.
 *
 * ONE FIELD, AND IT RENAMES TWO THINGS: the name on the card and the slug in the URL, because a project
 * whose card says one thing and whose address says another is what this dialog exists to fix (a
 * checkout renamed in the terminal keeps its old slug — `deriveSlug` never re-derives, by design — so
 * `porg` was still answering on `/project/hypergres`, its page's address until project pages went,
 * 2026-09-28). The slug now names the project in its threads' addresses (`/all/<slug>/thread/<t>`), and
 * the one they will get is shown before saving.
 *
 * THE FOLDER IS NOT TOUCHED BY DEFAULT. The checkbox appears only when the folder is already named
 * after the project, so the offer reads "keep these in step" and never "move your directory": a folder
 * called something else was named deliberately, and this is not the place to second-guess it.
 */
function RenameProjectDialog({
  project,
  home,
  onClose,
}: {
  project: ProjectCard
  home: string | undefined
  onClose: () => void
}) {
  const [name, setName] = useState(project.name)
  const [renameDirectory, setRenameDirectory] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const rename = useMutation({
    mutationFn: () => rpc.projectRename({ id: project.id, name: name.trim(), renameDirectory }),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: ["projectsList"] })
      void queryClient.invalidateQueries({ queryKey: ["projectsQueues"] })
      showToast(`Renamed ${project.name} to ${updated.name}`)
      onClose()
      // The OLD slug no longer names anything. A board of the project follows it to the new one; a drawer
      // of it on All projects (its address names the project) closes, home. The pick is kept by id, so All
      // projects needs nothing.
      if (updated.slug !== project.slug) {
        const view = currentView()
        const focused = view.kind === "project" && view.slug === project.slug
        if (focused) navigate(projectViewHref(updated.slug), { replace: true })
        else if (projectSlug() === project.slug && innerPath() !== "/") navigate(homeHref(), { replace: true })
      }
    },
  })
  const error = rename.error instanceof Error ? rename.error.message : rename.error ? String(rename.error) : null
  const trimmed = name.trim()
  const folder = folderName(project.path)
  const parent = project.path.slice(0, project.path.length - folder.length)
  // Offered only when the folder already tracks the name AND the new name would leave it behind.
  const offerFolder = folder === project.name && trimmed.length > 0 && trimmed !== folder
  const slug = slugify(trimmed)

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open && !rename.isPending) onClose() }}
      title={`Rename ${project.name}`}
      className="w-[440px] max-w-[92vw]"
      // The field, selected, so typing replaces the name — the header's Close button is what Radix
      // would focus otherwise, and a rename dialog that opens with nothing to type into is a click short.
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={rename.isPending}
            className="button-outline rounded-md px-3 py-1.5 text-[12px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-45"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="rename-project"
            disabled={rename.isPending || trimmed.length === 0}
            className="flex items-center gap-1.5 rounded-md border border-accent-fill bg-accent-fill px-3 py-1.5 text-[12.5px] font-medium text-on-accent outline-none hover:brightness-110 focus-visible:ring-1 focus-visible:ring-focus-accent-60 disabled:opacity-50"
          >
            {rename.isPending && <Loader2 size={12} className="animate-spin" />}
            {offerFolder && renameDirectory ? "Rename project and folder" : "Rename project"}
          </button>
        </>
      }
    >
      <form
        id="rename-project"
        onSubmit={(event) => {
          event.preventDefault()
          if (!rename.isPending && trimmed.length > 0) rename.mutate()
        }}
        className="flex flex-col gap-3 p-4 text-[12.5px] leading-relaxed text-muted"
      >
        <input
          ref={inputRef}
          value={name}
          onChange={(event) => setName(event.target.value)}
          spellCheck={false}
          aria-label="Project name"
          className={`w-full rounded-md border bg-bg px-2.5 py-2 text-[12.5px] text-fg outline-none placeholder:text-muted-50 focus-visible:ring-1 focus-visible:ring-focus-accent-60 ${
            error ? "border-danger-fill/60" : "border-border-strong"
          }`}
        />
        <p>
          Its threads&rsquo; addresses become{" "}
          <span className="font-mono text-[11.5px] text-fg/80">/all/{slug}/…</span>
          {slug !== project.slug ? <> — links to <span className="font-mono text-[11.5px]">/all/{project.slug}/…</span> stop working.</> : "."}
        </p>
        {offerFolder ? (
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-bg/30 px-2.5 py-2 text-fg/85">
            <input
              type="checkbox"
              checked={renameDirectory}
              onChange={(event) => setRenameDirectory(event.target.checked)}
              // Same cap-band correction as the delete dialog's checkbox — see the readings there.
              className="mt-[3px] accent-[var(--color-accent)]"
            />
            <span className="flex flex-col gap-0.5">
              <span>Also rename the folder</span>
              <span className="text-[11.5px] text-muted-80">
                {renameDirectory
                  ? <><span className="font-mono text-[11px]">{shortPath(project.path, home)}</span> becomes <span className="font-mono text-[11px]">{shortPath(parent + trimmed, home)}</span>. Running workers keep going.</>
                  : "Left off, the folder keeps its name and only what ntwine calls it changes."}
              </span>
            </span>
          </label>
        ) : null}
        {error ? <p className="text-[11.5px] text-danger">{error}</p> : null}
      </form>
    </Dialog>
  )
}

/**
 * The confirmation, and the one place the two levels of "delete" are spelled out.
 *
 * THE FOLDER IS NEVER TOUCHED, and saying so is the dialog's first job: "delete" beside a card that
 * shows a path reads as "delete that directory" until something says otherwise. The second job is the
 * checkbox, which is the whole difference between an act that is undone by adding the folder again and
 * one that is not undone at all.
 */
function DeleteProjectDialog({
  project,
  home,
  onClose,
}: {
  project: ProjectCard
  home: string | undefined
  onClose: () => void
}) {
  const [deleteData, setDeleteData] = useState(false)
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const remove = useMutation({
    mutationFn: () => rpc.projectRemove({ id: project.id, deleteData }),
    onSuccess: (result) => {
      // Every machine-wide read that still names it, so its row and its lane go at once.
      for (const queryKey of [["projectsList"], ["projectsQueues"]]) void queryClient.invalidateQueries({ queryKey })
      // The worker count is the part the operator could not have known they were asking for, so it is
      // reported rather than folded into a generic success.
      showToast(
        result.stoppedWorkers > 0
          ? `Deleted ${project.name} — ${result.stoppedWorkers} ${result.stoppedWorkers === 1 ? "worker" : "workers"} stopped`
          : `Deleted ${project.name}`,
      )
      onClose()
      // Deleting the project the page is focused on leaves it showing nothing: All projects. Deleting the
      // one it is merely bound to (All projects' pick, a drawer's) goes home, which binds another.
      const view = currentView()
      if (view.kind === "project" && view.slug === project.slug) navigate(viewHref(ALL_PROJECTS), { replace: true })
      else if (projectSlug() === project.slug) navigate(homeHref(), { replace: true })
    },
  })
  const error = remove.error instanceof Error ? remove.error.message : remove.error ? String(remove.error) : null

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open && !remove.isPending) onClose() }}
      title={`Delete ${project.name}?`}
      className="w-[440px] max-w-[92vw]"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={remove.isPending}
            className="button-outline rounded-md px-3 py-1.5 text-[12px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-45"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
            className="button-outline flex items-center gap-1.5 rounded-md bg-danger-button/90 px-3 py-1.5 text-[12.5px] font-medium text-white outline-none transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {remove.isPending && <Loader2 size={12} className="animate-spin" />}
            {deleteData ? "Delete project and threads" : "Delete project"}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3 p-4 text-[12.5px] leading-relaxed text-muted">
        <p>
          ntwine forgets this project. The folder itself is not touched — nothing inside{" "}
          <span className="font-mono text-[11.5px] text-fg/80">{shortPath(project.path, home)}</span> is
          changed or removed.
        </p>
        <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-bg/30 px-2.5 py-2 text-fg/85">
          <input
            type="checkbox"
            checked={deleteData}
            onChange={(event) => setDeleteData(event.target.checked)}
            // `mt-[3px]` sets the 13px box on the first line's CAP BAND rather than its line box — the
            // same ink-over-box correction every mark beside text here gets. Measured 2026-08-26
            // against a `1cap` probe on the label's own baseline, with the inline body font cleared so
            // both settings are really exercised: 0.48px low in mono, 0.10px high in sans. Both are
            // inside the instrument's ±0.75px floor, so there is nothing left to correct.
            className="mt-[3px] accent-[var(--color-accent)]"
          />
          <span className="flex flex-col gap-0.5">
            <span>Also delete its threads and history</span>
            <span className="text-[11.5px] text-muted-80">
              {deleteData
                ? "Everything ntwine has stored for this project, and any workers still running are stopped. This cannot be undone."
                : "Left off, its threads are kept — adding the folder again brings them back."}
            </span>
          </span>
        </label>
        {error ? <p className="text-[11.5px] text-danger">{error}</p> : null}
      </div>
    </Dialog>
  )
}

function AddProjectDialog({
  reason,
  proposed,
  onClose,
}: {
  reason?: string
  /** A directory `ntwine` was just run in. Pre-filled, never pre-registered. */
  proposed?: string
  onClose: () => void
}) {
  const [path, setPath] = useState(proposed ?? "")
  const [listOpen, setListOpen] = useState(false)
  const openAdded = useOpenAddedProject()
  const add = useMutation({
    mutationFn: (input: string) => rpc.projectAdd({ path: input }),
    onSuccess: (result) => {
      // Inside another project root: the same host asks which one was meant (EnclosedProjectDialog).
      if (result.kind === "enclosed") {
        store.addProject = { enclosed: result }
        return
      }
      onClose()
      openAdded(result.project)
    },
  })
  const error = add.error instanceof Error ? add.error.message : add.error ? String(add.error) : null

  return (
    <RadixDialog.Root open onOpenChange={(open) => { if (!open && !add.isPending) onClose() }}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-[210] bg-scrim-30 backdrop-blur-md backdrop-saturate-150" />
        <RadixDialog.Content
          aria-modal="true"
          aria-describedby={undefined}
          // Escape closes the suggestions first; only a second one closes the dialog.
          onEscapeKeyDown={(event) => { if (listOpen) event.preventDefault() }}
          className="fixed left-1/2 top-1/2 z-[210] w-[460px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-panel p-5 shadow-2xl shadow-shadow-ink/50 outline-none"
        >
          <RadixDialog.Title className="mb-1 text-[14px] font-medium">
            {proposed ? "Add this folder as a project?" : "Add a project"}
          </RadixDialog.Title>
          <p className="mb-3.5 text-[12.5px] leading-relaxed text-muted">
            {proposed
              ? "You ran ntwine here and it is not a project yet. Nothing has been written — adding it is what makes it one."
              : reason
                ? `${reason}. Paste the folder instead — ntwine walks up to the repository root, the same way it does when you run it in a terminal.`
                : "Paste the folder you want to add. ntwine walks up to the repository root, the same way it does when you run it in a terminal."}
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (!add.isPending) add.mutate(path)
            }}
          >
            <PathField value={path} error={error} onChange={(next) => { setPath(next); if (add.error) add.reset() }} onListOpenChange={setListOpen} />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={add.isPending}
                className="rounded-md border border-border-strong bg-elevated px-3 py-1.5 text-[12.5px] text-fg outline-none hover:bg-panel-2 focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:opacity-50"
              >
                {proposed ? "Not now" : "Cancel"}
              </button>
              <button
                type="submit"
                disabled={add.isPending || path.trim().length === 0}
                className="rounded-md border border-accent bg-accent-fill px-3 py-1.5 text-[12.5px] font-medium text-on-accent outline-none hover:brightness-110 focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:opacity-50"
              >
                {add.isPending ? "Adding…" : proposed ? "Add it" : "Add project"}
              </button>
            </div>
          </form>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

/**
 * The chosen folder sits inside another project — `~/app/action/yes` inside `app` — so adding it as-is
 * would open that project instead. The server names the registered project over a nearer package root,
 * because that is what the operator calls it. Until 2026-09-28 that happened without a word: the add
 * reopened `~/app`, navigated to a board the operator already had open, and read as a silent failure.
 * Both answers are real ones: a package folder usually means its repository, but someone who pointed
 * at a folder may mean exactly that folder, and `exact` adopts it with its own `.ntwine/.id`.
 */
function EnclosedProjectDialog({ enclosed, onClose }: { enclosed: ProjectEnclosed; onClose: () => void }) {
  const openAdded = useOpenAddedProject()
  const add = useMutation({
    mutationFn: (input: { path: string; exact?: boolean }) => rpc.projectAdd(input),
    onSuccess: (result: ProjectAddResult) => {
      // Cannot happen for either button — the root resolves to itself, and `exact` never asks — but a
      // stale answer must not strand the dialog on a spinner.
      if (result.kind === "enclosed") {
        store.addProject = { enclosed: result }
        return
      }
      onClose()
      openAdded(result.project)
    },
  })
  const error = add.error instanceof Error ? add.error.message : add.error ? String(add.error) : null
  const root = enclosed.rootName

  return (
    <RadixDialog.Root open onOpenChange={(open) => { if (!open && !add.isPending) onClose() }}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-[210] bg-scrim-30 backdrop-blur-md backdrop-saturate-150" />
        <RadixDialog.Content
          aria-modal="true"
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[210] w-[460px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-panel p-5 shadow-2xl shadow-shadow-ink/50 outline-none"
        >
          <RadixDialog.Title className="mb-1 text-[14px] font-medium">
            {enclosed.rootRegistered ? `That folder is inside the “${root}” project` : `That folder is inside “${root}”`}
          </RadixDialog.Title>
          <p className="mb-3.5 text-[12.5px] leading-relaxed text-muted">
            Create a separate project for <span className="font-mono text-fg/80">{enclosed.path}</span>?
          </p>
          {error ? <p className="mb-2 text-[11.5px] text-danger">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={add.isPending}
              className="rounded-md border border-border-strong bg-elevated px-3 py-1.5 text-[12.5px] text-fg outline-none hover:bg-panel-2 focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => add.mutate({ path: enclosed.root })}
              disabled={add.isPending}
              className="rounded-md border border-border-strong bg-elevated px-3 py-1.5 text-[12.5px] text-fg outline-none hover:bg-panel-2 focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:opacity-50"
            >
              {enclosed.rootRegistered ? `Open ${root}` : `Add ${root}`}
            </button>
            <button
              type="button"
              autoFocus
              onClick={() => add.mutate({ path: enclosed.path, exact: true })}
              disabled={add.isPending}
              className="rounded-md border border-accent bg-accent-fill px-3 py-1.5 text-[12.5px] font-medium text-on-accent outline-none hover:brightness-110 focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:opacity-50"
            >
              {add.isPending ? "Adding…" : "Create separate project"}
            </button>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

/**
 * The typed path, with the folders that continue it and a one-line reading of what is there.
 *
 * The server does the looking (`pathComplete`, path-complete.ts) — a page cannot see the filesystem.
 * The list OVERLAYS the dialog rather than pushing its buttons down on every keystroke, and the status
 * line always keeps its height for the same reason. Tab or Enter takes a suggestion (the first, unless
 * the arrows chose another); a suggestion ends in `/`, so taking one opens the next level straight away.
 * Enter with nothing chosen still submits, so typing a full path and pressing Enter never changes meaning.
 */
function PathField({
  value,
  error,
  onChange,
  onListOpenChange,
}: {
  value: string
  error: string | null
  onChange: (next: string) => void
  onListOpenChange: (open: boolean) => void
}) {
  const deferred = useDeferredValue(value)
  const completion = useQuery({
    queryKey: ["pathComplete", deferred],
    queryFn: () => rpc.pathComplete({ path: deferred }),
    placeholderData: keepPreviousData,
    staleTime: 2_000,
  })
  const [focused, setFocused] = useState(true)
  const [dismissed, setDismissed] = useState(false)
  const [highlight, setHighlight] = useState(-1)
  const status = value.trim() ? completion.data?.status : "empty"
  // The previous answer stays up while the next is in flight; drop the rows it no longer continues.
  const typed = value.toLowerCase()
  const suggestions = value.trim() ? (completion.data?.suggestions ?? []).filter((s) => s.toLowerCase().startsWith(typed)) : []
  const open = focused && !dismissed && suggestions.length > 0
  useEffect(() => onListOpenChange(open), [open, onListOpenChange])

  const change = (next: string) => {
    onChange(next)
    setDismissed(false)
    setHighlight(-1)
  }
  const accept = (index: number) => {
    const chosen = suggestions[index]
    if (chosen !== undefined) change(chosen)
  }

  return (
    <div>
      <div className="relative">
      <input
        autoFocus
        role="combobox"
        aria-label="Folder path"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls="add-project-suggestions"
        aria-activedescendant={open && highlight >= 0 ? `add-project-suggestion-${highlight}` : undefined}
        value={value}
        onChange={(event) => change(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(event) => {
          if (!open) return
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault()
            // -1 is "none chosen" (Enter submits), one stop in the cycle like a native combobox.
            const next = highlight + (event.key === "ArrowDown" ? 1 : -1)
            setHighlight(next >= suggestions.length ? -1 : next < -1 ? suggestions.length - 1 : next)
          } else if (event.key === "Tab" && !event.shiftKey) {
            event.preventDefault()
            accept(Math.max(highlight, 0))
          } else if (event.key === "Enter" && highlight >= 0) {
            event.preventDefault()
            accept(highlight)
          } else if (event.key === "Escape") {
            setDismissed(true)
          }
        }}
        placeholder="~/code/my-project"
        spellCheck={false}
        autoComplete="off"
        className={`w-full rounded-md border bg-bg px-2.5 py-2 font-mono text-[12px] text-fg outline-none placeholder:text-muted-50 focus-visible:ring-1 focus-visible:ring-focus-ink-60 ${
          error ? "border-danger-fill/60" : "border-border-strong"
        }`}
      />
      {open ? (
        <ul
          id="add-project-suggestions"
          role="listbox"
          // Pressing a row must not blur the input first, or the list unmounts under the click.
          onMouseDown={(event) => event.preventDefault()}
          className="absolute inset-x-0 top-full z-10 mt-1 max-h-[164px] overflow-y-auto rounded-md border border-border bg-elevated p-1 shadow-lg shadow-shadow-ink/30"
        >
          {suggestions.map((suggestion, index) => {
            // Just the folder: the parent is already in the field, and repeating it on every row buries
            // the one part that differs.
            const name = suggestion.slice(suggestion.lastIndexOf("/", suggestion.length - 2) + 1, -1)
            return (
              <li
                key={suggestion}
                id={`add-project-suggestion-${index}`}
                role="option"
                aria-selected={index === highlight}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => accept(index)}
                className={`cursor-default truncate rounded px-2 py-1 font-mono text-[12px] ${index === highlight ? "bg-panel-2 text-fg" : "text-fg/80"}`}
              >
                {name}
                <span className="text-muted-55">/</span>
              </li>
            )
          })}
        </ul>
      ) : null}
      </div>
      {/* Green for a folder that is there, a muted red for one that is not — but not while a suggestion
          still continues the text: half a folder name is not a mistake yet. */}
      <p className={`mt-1.5 min-h-[1.4em] text-[11.5px] ${error ? "text-danger" : status === "directory" ? "text-success/85" : "text-danger/70"}`}>
        {error ??
          (status === "directory"
            ? "Folder found"
            : status === "file"
              ? "That is a file, not a folder"
              : status === "missing" && suggestions.length === 0
                ? "No folder at this path"
                : "")}
      </p>
    </div>
  )
}

/**
 * Have the server build the folder picker NOW, because the pointer or keyboard focus has reached an
 * "Add a project" control and the click is a moment behind it. On macOS a panel built at the click
 * took 0.8-1.0s to draw — the whole delay the operator saw after pressing the button — and a panel
 * built ahead draws in ~0.09s (server/directory-picker.ts).
 *
 * At most once every 10s: the server keeps a built panel for a minute and answers a repeat by keeping
 * it, so asking more often only adds requests. A failed ask clears the stamp, so the next hover retries.
 */
let pickerWarmedAt = 0
export function warmProjectPicker(): void {
  const now = Date.now()
  if (now - pickerWarmedAt < 10_000) return
  pickerWarmedAt = now
  rpc.projectPickWarm({}).catch(() => { pickerWarmedAt = 0 })
}

/**
 * Adding a project: the native folder picker first, the typed-path dialog as the FALLBACK — it opens
 * only when the machine has no picker, or the picker failed to open and said why. Every door that adds a
 * project (the list's last row, the empty machine's box) calls this, and the fallback is
 * the ONE dialog the layout hosts (AddProjectHost), so none of them grows a copy of it.
 */
export function useAddProject(): { start: () => void; pending: boolean } {
  const openAdded = useOpenAddedProject()
  const pick = useMutation({
    mutationFn: () => rpc.projectPick({}),
    onSuccess: (result) => {
      if (result.kind === "cancelled") return
      if (result.kind === "unavailable") {
        store.addProject = { reason: result.reason }
        return
      }
      if (result.kind === "enclosed") {
        store.addProject = { enclosed: result }
        return
      }
      openAdded(result.project)
    },
    // A picker that throws is still a machine without a working picker.
    onError: (error) => { store.addProject = { reason: error instanceof Error ? error.message : String(error) } },
  })
  return { start: () => { if (!pick.isPending) pick.mutate() }, pending: pick.isPending }
}

/**
 * Adding a project is only ever a step towards working in it, so it lands there — WITHOUT changing the
 * view. Focused on a project, the page moves to the new one's board (`/project/<slug>`, lib/pageView.ts).
 * Showing All projects, it stays on All projects and aims the prompt box at the new project, the way a
 * pick in the box's own picker does (David 2026-10-01: adding `local` from All projects dropped
 * the page into `local`'s own view).
 *
 * The new project's board is READ before anything moves. A project is not open on the server until a
 * request addresses it (tenant-prime.ts), and All projects only aims at, and draws, projects the server
 * has open (crossProject.ts defaultCrossProjectFocus) — so without this read the pick was ignored and
 * the new project stayed off the page until something else happened to open it.
 * `navigate`, not location.assign: the page must not be torn down on the way.
 */
function useOpenAddedProject(): (project: { id: string; slug: string }) => void {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const view = usePageView()
  return (project) => {
    void (async () => {
      await queryClient.fetchQuery({ queryKey: projectBoardKey(project.id), queryFn: () => projectRpc(project.id).board() }).catch(() => undefined)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["projectsList"] }),
        queryClient.invalidateQueries({ queryKey: ["projectsQueues"] }),
      ])
      if (view.kind === "project") {
        navigate(projectViewHref(project.slug))
        return
      }
      rememberCrossProjectFocus(project.id)
      // A drawer binds the page to its own project, so aiming the box goes home (AllQueues usePickProject).
      if (innerPath() !== "/") navigate(homeHref(), { replace: true })
    })()
  }
}

/**
 * The typed-path dialog, whenever something asked for it (`store.addProject`). Mounted once, by the layout
 * — which is also why `p` (New project) is registered here: every page under the layout has this host,
 * and the key opens the same folder picker the list's add row does.
 */
export function AddProjectHost() {
  const request = useSnapshot(store).addProject
  const add = useAddProject()
  useShortcut("app.newProject", add.start)
  if (!request) return null
  // Keyed on the folder so a second enclosed answer mounts fresh rather than inheriting a spent mutation.
  if (request.enclosed) return <EnclosedProjectDialog key={request.enclosed.path} enclosed={request.enclosed} onClose={() => (store.addProject = null)} />
  return <AddProjectDialog reason={request.reason} proposed={request.proposed} onClose={() => (store.addProject = null)} />
}

/** The home directory, from the registry's own paths — only ever used to shorten a path for display. */
export function homeOf(projects: readonly { path: string }[] | undefined): string | undefined {
  // Up to a `/` OR the end: the Home workspace's folder is, by default, the home folder itself.
  return projects?.[0]?.path.match(/^(\/(?:Users|home)\/[^/]+)(?:\/|$)/u)?.[1]
}

/**
 * The mark, at the size where it is legible AS a mark.
 *
 * Measured against the shipped favicon at 40 / 56 / 76 / 96: it is five fibers pulling loose from a
 * wrapped bundle, and below ~70px the strands collapse into a silhouette that reads as a HAND. 76 is
 * the first size where the bundle's wrap and the gaps between strands both survive.
 */
const MARK_PX = 76

/**
 * `/` (or `/all`) with no project to land on — the one time the page has nothing to show, so it says what a
 * project is and offers the one thing to do. The add button is dashed and never filled: an affordance,
 * not a project.
 *
 * "Nothing to land on" is usually an empty machine, but it is also a machine whose every project's
 * directory is gone. Those are listed under the button with their menus, since deleting them (or finding
 * the folder again) is the way out, and a page that pretended they did not exist would strand them.
 */
export function Welcome({ projects: cards }: { projects: readonly ProjectCard[] }) {
  const add = useAddProject()
  const navigate = useNavigate()
  const home = homeOf(cards)
  // The Home workspace is always registered, so it is not what this page counts: a machine with only
  // Home still has no project. It is offered below instead, as the other way to start.
  const projects = cards.filter((card) => !card.home)
  const homeCard = cards.find((card) => card.home && !card.stale)
  return (
    // m-auto rather than justify-center: a centred flex column clips its overflow at the top once the
    // content is taller than the viewport, and auto margins centre while still scrolling from the top.
    <div className="flex min-h-dvh w-full">
      <div data-home-welcome className="m-auto flex w-full max-w-[420px] flex-col items-center gap-2.5 px-6 py-14 text-center">
        <img src="/favicon.svg" width={MARK_PX} height={MARK_PX} alt="" className="rounded-[17px]" />
        <h1 className="text-[19px] font-semibold tracking-[-0.01em] text-fg">
          {projects.length === 0 ? "Welcome to ntwine" : "No project folder can be found"}
        </h1>
        <p className="text-[13px] leading-relaxed text-muted">
          {projects.length === 0
            ? "A project is a folder on this machine. ntwine keeps each project's threads together."
            : "Every registered project's folder is missing. Add a folder, or delete the projects that are gone."}
        </p>
        <button
          type="button"
          onPointerEnter={warmProjectPicker}
          onFocus={warmProjectPicker}
          onClick={add.start}
          disabled={add.pending}
          className="mt-4 flex min-h-[96px] w-full max-w-[360px] flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border-strong bg-transparent px-3 py-2.5 text-muted outline-none transition-colors hover:border-fg/40 hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:opacity-60"
        >
          <span className="text-[17px] leading-none text-muted-70">+</span>
          <span className="text-[12.5px]">{add.pending ? "Choosing a folder…" : "Add a project"}</span>
        </button>
        {projects.length > 0 && (
          <ul className="mt-2 flex w-full max-w-[360px] flex-col text-left">
            {projects.map((project) => (
              <li key={project.id} className="group relative flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] hover:bg-hover">
                <span className="shrink-0 opacity-60 grayscale"><ProjectSquare project={project} size={16} /></span>
                <span className="min-w-0 flex-1 truncate text-fg/75" title={project.path}>{project.name}</span>
                <span className="shrink-0 text-[10.5px] text-muted-55">Directory is missing</span>
                <ProjectMenu project={project} home={home}>
                  <button type="button" aria-label={`More actions for ${project.name}`} className={ROW_ACTION_CLASS}>
                    <Ellipsis size={13} />
                  </button>
                </ProjectMenu>
              </li>
            ))}
          </ul>
        )}
        {/* Not "it registers itself": the launcher adopts no folder. Run in a repository it sends you here
            with that folder proposed (`/?add=<dir>`), and nothing is written until yes; anywhere else it
            just opens ntwine (upstream 49000c91). */}
        <p className="mt-4 text-[11.5px] text-muted-70">
          Or run{" "}
          <code className="rounded border border-border bg-panel px-1.5 py-0.5 font-mono text-muted">ntwine</code>{" "}
          inside a repository, and this page offers to add it.
        </p>
        {/* Choosing Home focuses the page on it (and makes it All projects' pick too) — the way to clone a
            first repository without adding a project to hold it. */}
        {homeCard && (
          <p className="text-[11.5px] text-muted-70">
            Or{" "}
            <button
              type="button"
              data-welcome-home
              onClick={() => {
                rememberCrossProjectFocus(homeCard.id)
                navigate(projectViewHref(homeCard.slug))
              }}
              className="rounded-sm text-fg/85 underline decoration-muted/40 underline-offset-2 outline-none transition-colors hover:text-fg hover:decoration-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60"
            >
              start a thread in {shortPath(homeCard.path, home)}
            </button>{" "}
            without a project.
          </p>
        )}
      </div>
    </div>
  )
}
