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
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useRef, useState, type ReactNode } from "react"
import { Loader2 } from "lucide-react"
import { useNavigate } from "react-router"
import { PROJECT_ICON_EXTENSIONS, slugify, type ProjectCard } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { projectHref } from "../lib/base-path.ts"
import { showToast } from "../store.ts"
import { Dialog } from "./ui/Dialog.tsx"

/** `/Users/me/code/nub` → `~/code/nub`. The home prefix is noise on every row. */
export function shortPath(path: string, home: string | undefined): string {
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

const MENU_ITEM = "cursor-default rounded px-2 py-1.5 text-[12.5px] text-fg outline-none data-[highlighted]:bg-panel-2"

/**
 * Everything you can do to a project besides open it: change its picture, rename it, delete it.
 *
 * ONE MENU. The grid split these between an image overlay on the square ("change the picture") and an
 * ellipsis ("rename, delete"), because a 34px square had room for a control of its own. A 16px one does
 * not, and two menus on one row is exactly the clutter the merge was for. Delete is last and red — the
 * one irreversible act here, kept away from the two that only change what Frizz calls a project.
 *
 * THE ICON: the NATIVE picker, opened standing in the project's own directory — a browser file input
 * cannot be aimed anywhere, and an icon almost always lives inside the project. The hidden input stays
 * as the fallback for a platform with no native dialog, so the item never becomes a dead end. Failures
 * are toasts: the trigger is a row's ellipsis, and a paragraph beside it has nowhere to go.
 */
export function ProjectMenu({ project, home, children }: { project: ProjectCard; home: string | undefined; children: ReactNode }) {
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const queryClient = useQueryClient()
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
      <RadixDropdown.Root>
        <RadixDropdown.Trigger asChild>{children}</RadixDropdown.Trigger>
        <RadixDropdown.Portal>
          {/* The items do NOT name the project: a name is a directory basename of any length, and this
              content has a min width and no max, so a long one would stretch the menu past its row. The
              row is the subject and each dialog names it in full. */}
          <RadixDropdown.Content
            align="end"
            sideOffset={6}
            className="z-[220] min-w-[190px] rounded-lg border border-border bg-panel p-1 shadow-xl shadow-shadow-ink/40"
          >
            <RadixDropdown.Item className={MENU_ITEM} onSelect={() => pick.mutate()}>
              {upload.isPending ? "Uploading…" : "Choose an icon…"}
            </RadixDropdown.Item>
            <RadixDropdown.Item className={MENU_ITEM} onSelect={() => clear.mutate()}>
              {project.iconIsCustom ? "Use the detected icon" : "Look for an icon again"}
            </RadixDropdown.Item>
            <RadixDropdown.Separator className="mx-1 my-1 h-px bg-border" />
            <RadixDropdown.Item className={MENU_ITEM} onSelect={() => setRenaming(true)}>
              Rename…
            </RadixDropdown.Item>
            <RadixDropdown.Item
              className="cursor-default rounded px-2 py-1.5 text-[12.5px] text-danger outline-none data-[highlighted]:bg-danger-fill/10 data-[highlighted]:text-danger-soft"
              onSelect={() => setDeleting(true)}
            >
              Delete project…
            </RadixDropdown.Item>
          </RadixDropdown.Content>
        </RadixDropdown.Portal>
      </RadixDropdown.Root>
      {renaming ? <RenameProjectDialog project={project} home={home} onClose={() => setRenaming(false)} /> : null}
      {deleting ? <DeleteProjectDialog project={project} home={home} onClose={() => setDeleting(false)} /> : null}
    </>
  )
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
 * `porg` was still answering on `/project/hypergres`). The URL it will get is shown before saving.
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
  const rename = useMutation({
    mutationFn: () => rpc.projectRename({ id: project.id, name: name.trim(), renameDirectory }),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: ["projectsList"] })
      showToast(`Renamed ${project.name} to ${updated.name}`)
      onClose()
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
          Its address becomes{" "}
          <span className="font-mono text-[11.5px] text-fg/80">/project/{slug}</span>
          {slug !== project.slug ? <> — links to <span className="font-mono text-[11.5px]">/project/{project.slug}</span> stop working.</> : "."}
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
                  : "Left off, the folder keeps its name and only what Frizz calls it changes."}
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
  const remove = useMutation({
    mutationFn: () => rpc.projectRemove({ id: project.id, deleteData }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["projectsList"] })
      // The worker count is the part the operator could not have known they were asking for, so it is
      // reported rather than folded into a generic success.
      showToast(
        result.stoppedWorkers > 0
          ? `Deleted ${project.name} — ${result.stoppedWorkers} ${result.stoppedWorkers === 1 ? "worker" : "workers"} stopped`
          : `Deleted ${project.name}`,
      )
      onClose()
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
          Frizz forgets this project. The folder itself is not touched — nothing inside{" "}
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
                ? "Everything Frizz has stored for this project, and any workers still running are stopped. This cannot be undone."
                : "Left off, its threads are kept — adding the folder again brings the board back."}
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
  /** A directory `frizz` was just run in. Pre-filled, never pre-registered. */
  proposed?: string
  onClose: () => void
}) {
  const [path, setPath] = useState(proposed ?? "")
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const add = useMutation({
    mutationFn: (input: string) => rpc.projectAdd({ path: input }),
    onSuccess: (project) => {
      void queryClient.invalidateQueries({ queryKey: ["projectsList"] })
      // Adding a project is only ever a step towards opening it. `navigate`, not location.assign:
      // the rail is already showing and must not be torn down to open what was just added.
      navigate(projectHref(project.slug))
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
          className="fixed left-1/2 top-1/2 z-[210] w-[460px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-panel p-5 shadow-2xl shadow-shadow-ink/50 outline-none"
        >
          <RadixDialog.Title className="mb-1 text-[14px] font-medium">
            {proposed ? "Add this folder as a project?" : "Add a project"}
          </RadixDialog.Title>
          <p className="mb-3.5 text-[12.5px] leading-relaxed text-muted">
            {proposed
              ? "You ran Frizz here and it is not a project yet. Nothing has been written — adding it is what creates its board."
              : reason
                ? `${reason}. Paste the folder instead — Frizz walks up to the repository root, the same way it does when you run it in a terminal.`
                : "Paste the folder you want a board for. Frizz walks up to the repository root, the same way it does when you run it in a terminal."}
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (!add.isPending) add.mutate(path)
            }}
          >
            <input
              autoFocus
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="~/code/my-project"
              spellCheck={false}
              className={`w-full rounded-md border bg-bg px-2.5 py-2 font-mono text-[12px] text-fg outline-none placeholder:text-muted-50 focus-visible:ring-1 focus-visible:ring-focus-ink-60 ${
                error ? "border-danger-fill/60" : "border-border-strong"
              }`}
            />
            {error ? <p className="mt-1.5 text-[11.5px] text-danger">{error}</p> : null}
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
 * Adding a project: the native folder picker first, the typed-path dialog as the FALLBACK — it opens
 * only when the machine has no picker, or the picker failed to open and said why.
 *
 * `proposed` is the LAUNCHER asking (`/?add=<dir>`): running `frizz` in an unknown folder does not adopt
 * it, it sends the operator home to say yes, so the dialog opens at once, pre-filled.
 */
export function useAddProject(proposed?: string): { start: () => void; pending: boolean; dialog: ReactNode } {
  const [fallback, setFallback] = useState<{ reason?: string } | null>(proposed ? {} : null)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const pick = useMutation({
    mutationFn: () => rpc.projectPick({}),
    onSuccess: (result) => {
      if (result.kind === "cancelled") return
      if (result.kind === "unavailable") {
        setFallback({ reason: result.reason })
        return
      }
      void queryClient.invalidateQueries({ queryKey: ["projectsList"] })
      navigate(projectHref(result.project.slug))
    },
    // A picker that throws is still a machine without a working picker.
    onError: (error) => setFallback({ reason: error instanceof Error ? error.message : String(error) }),
  })
  return {
    start: () => { if (!pick.isPending) pick.mutate() },
    pending: pick.isPending,
    dialog: fallback ? <AddProjectDialog reason={fallback.reason} proposed={proposed} onClose={() => setFallback(null)} /> : null,
  }
}

/** The home directory, from the registry's own paths — only ever used to shorten a path for display. */
export function homeOf(projects: readonly { path: string }[] | undefined): string | undefined {
  return projects?.[0]?.path.match(/^(\/(?:Users|home)\/[^/]+)\//u)?.[1]
}
