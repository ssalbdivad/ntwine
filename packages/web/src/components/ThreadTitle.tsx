import { useEffect, useId, useRef, useState } from "react"
import { useMutation } from "@tanstack/react-query"
import type { ThreadView } from "@ntwine/shared"
import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"
import { displayName, displayTitle } from "../groups.ts"
import { THREAD_TITLE_MAX_LENGTH, manualThreadTitleSeed, threadTitleToCommit } from "../lib/threadTitle.ts"
import { AiRenameButton } from "./AiRenameButton.tsx"

// THE THREAD'S NAME, AND BOTH WAYS OF CHANGING IT — click the name to type a new one, or point at it
// and press the refresh mark to have Claude re-derive one. Rendered by the thread header (ChatView),
// and by the project board's queue card header (TodosView) from this ONE component until that board
// went on 2026-09-28, so the two surfaces could not drift. The cross-project card (AllQueuesCard)
// does NOT render it — its title is a link that opens the drawer — so the queue has no rename in place
// today, which is the asymmetry below come back. They drifted once before: the queue card carried only
// the refresh mark until 2026-09-13 — its title was a plain div, on the theory that the queue is a
// triage surface and a manual rename belongs in the drawer — and the maintainer met the asymmetry on
// the first card they wanted to retitle ("It only lets me rename. I should be able to click on it to
// retitle it.").
//
// The editor is the title's OWN box: the name is a button, the click swaps in an input seeded with
// the current title (never the slug or a placeholder — lib/threadTitle.ts), Enter or blur commits,
// Escape cancels. Empty and unchanged commits are no-ops, so a stray click cannot erase a good name.
//
// Foreign rows and legacy docs have no registry row to rename, so the name is plain text there; the
// refresh mark makes its own call (AiRenameButton) and hides while the editor is open.
// The name's two-line wrap in the narrow (two-row) thread header: `line-clamp-2` brings its own overflow
// and box, `whitespace-normal` undoes `truncate`'s nowrap, and `overflow-wrap:anywhere` breaks a slug-like
// run with no space in it rather than letting it run out of the row.
const NARROW_WRAP = "@max-[27.5rem]/thread-header:line-clamp-2 @max-[27.5rem]/thread-header:whitespace-normal @max-[27.5rem]/thread-header:[overflow-wrap:anywhere]"

export function ThreadTitle({ thread, className = "" }: { thread: ThreadView; className?: string }) {
  const slug = thread.id
  const renameTitle = useMutation({ mutationFn: (title: string) => rpc.renameThread({ slug, title }) })
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  // Why the last commit was refused — above all a name another open thread already carries (names are
  // never duplicated; server thread-names.ts). Shown INLINE beside the reopened editor, not in a toast
  // that leaves with the reason while the draft is still in the box; cleared by the next keystroke.
  const [refusal, setRefusal] = useState<string>()
  const inputRef = useRef<HTMLInputElement>(null)
  const refusalId = useId()
  useEffect(() => {
    if (!editing) return
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [editing])
  // A drawer can switch slugs without remounting this header. Never carry a half-entered title into
  // another thread; changing selection has the same semantics as cancelling with Escape.
  useEffect(() => {
    setEditing(false)
    setDraft("")
    setRefusal(undefined)
  }, [slug])
  // Manual rename is registry metadata for either backend; the AI rename is Claude-only and gated
  // inside AiRenameButton.
  const canRename = thread.kind === "session" && thread.foreign !== true
  // The name SHOWS as its `@` handle (`shell-budgets`) but is stored as the words it was minted as
  // ("Shell budgets"), and a rename writes words — so the editor opens on the words, and "unchanged" is
  // judged against them. Seeding the handle would have every rename store a hyphenated run.
  const shown = displayTitle(thread)
  const stored = displayName(thread)
  function cancel(): void {
    setEditing(false)
    setDraft("")
    setRefusal(undefined)
  }
  function commit(): void {
    const title = threadTitleToCommit(draft, stored)
    setEditing(false)
    if (!title) {
      setDraft("")
      setRefusal(undefined)
      return
    }
    renameTitle.mutate(title, {
      onSuccess: () => {
        setDraft("")
        setRefusal(undefined)
        showToast("Thread renamed")
      },
      onError: (error) => {
        setDraft(title)
        setEditing(true)
        setRefusal(error instanceof Error ? error.message : "Could not rename thread")
      },
    })
  }
  // `group/thread-title` is the refresh mark's hover zone. `min-w-0 shrink` on the name rather than
  // `flex-1`, so a short title does not push the mark to the far side of the row — and so a short
  // name does not claim the whole row as a click target.
  //
  // IN THE TWO-ROW HEADER THE NAME WRAPS to a second line (`NARROW_WRAP`), on the header's own condition
  // (lib/threadHeaderLayout.ts THREAD_HEADER_NARROW — spelled out in full, since Tailwind generates a class
  // from its literal text). There the name has a row to itself, and in a 300px VS Code sidebar that row
  // is 268px: "Return rate-limit headers on every response" was cut to "Return rate-limit headers ..."
  // with no way to read the rest short of opening the rename box — the button's tooltip names its
  // action, not the title. Two lines, then the ellipsis; anywhere else (the desktop's one-row bar) it
  // truncates on one line exactly as before.
  return (
    <div className="group/thread-title flex min-w-0 items-center gap-2">
      {editing ? (
        <input
          ref={inputRef}
          aria-label="Thread title"
          value={draft}
          maxLength={THREAD_TITLE_MAX_LENGTH}
          aria-invalid={refusal ? true : undefined}
          aria-describedby={refusal ? refusalId : undefined}
          onChange={(event) => {
            setDraft(event.target.value)
            setRefusal(undefined)
          }}
          onBlur={commit}
          // Every key stops here. Above this input sit handlers that would otherwise read the
          // editor's keys as their own: the queue card's root submits staged answers on an Enter from
          // any non-button target, and the drawer stack's window listener unwinds a drawer on Escape
          // — so "cancel the rename" would also have closed the thread. The drawer's Radix dialog
          // sees Escape BEFORE this handler (document capture), so it is told by the attribute.
          data-claims-escape
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === "Enter") {
              event.preventDefault()
              commit()
            } else if (event.key === "Escape") {
              event.preventDefault()
              cancel()
            }
          }}
          // The box grows OUT from the name, not the name into the box: `-mx-1.5` cancels the padding
          // and `-my-px` the border, so the text stays where the button drew it (a 1px shift, the
          // border's own width) and the row keeps its height while the editor is open. The drawer's
          // editor used to jump the text 8px right and the "Last active" line 3px down.
          className={`min-w-0 flex-1 -mx-1.5 -my-px rounded-md border bg-elevated px-1.5 py-0 font-semibold text-[15px] text-fg outline-none ${refusal ? "border-danger" : "border-border focus:border-accent"} ${className}`}
        />
      ) : canRename ? (
        <button
          type="button"
          title="Edit title"
          aria-label={`Edit thread title: ${shown}`}
          disabled={renameTitle.isPending}
          onClick={() => {
            setDraft(manualThreadTitleSeed(stored, slug))
            setEditing(true)
          }}
          className={`min-w-0 max-w-full shrink truncate rounded px-0.5 -mx-0.5 font-semibold text-[15px] text-left outline-none transition-colors hover:bg-panel-2 focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:cursor-not-allowed disabled:opacity-40 ${NARROW_WRAP} ${className}`}
        >
          {shown}
        </button>
      ) : (
        <div className={`min-w-0 max-w-full shrink truncate px-0.5 -mx-0.5 font-semibold text-[15px] ${NARROW_WRAP} ${className}`} title={shown}>
          {shown}
        </div>
      )}
      {editing && refusal && (
        // Beside the box, not under it: the header's second line sits right below, and the row keeps its
        // height. Truncated with the whole reason on hover, since the box needs most of the width (the
        // server leads with the taken name, so the cut falls on the words that matter least).
        // `ml-1.5` puts back what the box's own `-mx-1.5` takes from the row's `gap-2`: without it the
        // message's ink sat 2.9px from the red border (dsf 4, sans), where every other pair in this row
        // reads 8px.
        <span id={refusalId} role="alert" data-rename-refusal className="ml-1.5 min-w-0 max-w-[50%] shrink truncate text-[11px] leading-tight text-danger" title={refusal}>
          {refusal}
        </span>
      )}
      <AiRenameButton thread={thread} hidden={editing} />
    </div>
  )
}
