import { useState, type ReactNode } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import type { PeerView, ThreadMovePreview, ThreadMoveResult, ThreadView } from "@ntwine/shared"
import { useThreadApi, useThreadProjectId } from "../api/threadApi.tsx"
import { errorText } from "../api/peers.ts"
import { displayTitle } from "../groups.ts"
import { relativeAge } from "../lib/activityTime.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { OPAQUE_PORTAL_SURFACE_ABOVE_DIALOG_Z } from "../lib/overlaySurface.ts"
import { showToast } from "../store.ts"
import { Dialog } from "./ui/Dialog.tsx"
import { Select } from "./ui/Select.tsx"

// MOVING A THREAD TO ANOTHER MACHINE, as the human sees it (plans/thread-handoff.md § 6). Three pieces:
//
//   · MoveThreadDialog — the ⋯ menu's "Move to <machine>…" (ThreadMenu.tsx). It asks both machines first
//     (`threadMovePreview`, which runs the destination's own checks) and shows what would happen before
//     anything does: where the thread lands, which checkout and branch, which uncommitted files go and
//     which stay. A refusal is shown in the server's words with Move disabled.
//   · MovedThreadNotice — in place of the prompt box (ThreadComposerBox.tsx) on the machine a thread LEFT:
//     the stub here can be read but not continued, so the one useful thing to say is where it went. A move
//     whose answer never came back (`movedTo.pending`) is held here, and the other machine may or may not
//     have committed it, so the notice says so and carries the two ways out: retry the move (idempotent
//     there: it answers a move it already holds without writing again) or keep it here.
//   · MovedFromFact — on the machine it ARRIVED at, a quiet "From <machine>" on the header's facts line
//     (ThreadHeaderFacts.tsx), with when on hover.
//
// Every call goes through the thread's own project's client (useThreadApi), as the ⋯ menu's other verbs do.

/** Paths a preview lists before it counts the rest ("and 12 more"). */
const LIST_CAP = 8

const SECONDARY_BUTTON =
  "button-outline rounded-md px-3 py-1.5 text-[12px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-45"
const PRIMARY_BUTTON =
  "button-outline flex items-center gap-1.5 rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-bg outline-none transition-opacity hover:opacity-90 disabled:opacity-45"

/** The toast a finished move raises, the same from the dialog and from the notice's retry. */
function toastMoved(result: ThreadMoveResult): void {
  showToast(`Moved to ${result.peer.name}`, result.notes.length > 0 ? { detail: result.notes.join(" ") } : undefined)
}

/** The ⋯ menu's label for the move: the machine's name when there is only one to go to. */
export function moveMenuLabel(peers: readonly PeerView[]): string {
  return peers.length === 1 ? `Move to ${peers[0]!.name}…` : "Move to another machine…"
}

/** Whether a thread may be offered the move at all: it has not already left, and there is somewhere to go.
 *  A move whose answer was lost is retried from the notice in its drawer, not from here. */
export function offersMove(thread: ThreadView, peers: readonly PeerView[] | undefined): boolean {
  return thread.movedTo === undefined && (peers?.length ?? 0) > 0
}

export function MoveThreadDialog({ thread, peers, onClose, onMoved }: {
  thread: ThreadView
  peers: readonly PeerView[]
  onClose: () => void
  /** After a move lands and the dialog has closed — the phone's ⋯ sheet closes itself here. */
  onMoved?: () => void
}) {
  const api = useThreadApi()
  const projectId = useThreadProjectId()
  const [peerId, setPeerId] = useState(peers[0]!.id)
  const peer = peers.find((candidate) => candidate.id === peerId) ?? peers[0]!
  const name = displayTitle(thread)
  // A mutation on the server (it asks the other machine), read here as a query so it re-asks when the
  // machine changes and never answers from a cache: keyed by the thread's project, since slugs repeat
  // across projects and this dialog opens from other projects' queue cards too.
  const preview = useQuery<ThreadMovePreview>({
    queryKey: ["threadMovePreview", projectId ?? "", thread.id, peer.id],
    queryFn: () => api.threadMovePreview({ slug: thread.id, peerId: peer.id }),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  })
  const move = useMutation({
    mutationFn: () => api.threadMove({ slug: thread.id, peerId: peer.id }),
    onSuccess: (result) => {
      toastMoved(result)
      onClose()
      onMoved?.()
    },
  })
  const ready = preview.data !== undefined && preview.data.refusal === undefined
  const failure = move.error ? errorText(move.error) : preview.error ? errorText(preview.error) : null
  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open && !move.isPending) onClose() }}
      title={`Move ${name} to ${peer.name}?`}
      className="w-[480px] max-w-[92vw] max-h-[80vh]"
      footer={
        <>
          <button type="button" onClick={onClose} disabled={move.isPending} className={SECONDARY_BUTTON}>
            Cancel
          </button>
          <button type="button" onClick={() => move.mutate()} disabled={!ready || move.isPending} className={PRIMARY_BUTTON} data-move-confirm>
            {move.isPending && <Loader2 size={12} className="animate-spin" aria-hidden />}
            {move.isPending ? "Moving…" : "Move"}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3 p-4 text-[12.5px] leading-relaxed text-muted" data-move-dialog>
        {peers.length > 1 ? (
          <Select
            variant="bordered"
            value={peer.id}
            onValueChange={(next) => { setPeerId(next); move.reset() }}
            options={peers.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
            indicatorPosition="right"
            ariaLabel="Machine"
            menuZClass={OPAQUE_PORTAL_SURFACE_ABOVE_DIALOG_Z}
            disabled={move.isPending}
          />
        ) : null}
        {preview.isPending ? (
          <p className="m-0 flex items-center gap-1.5" data-move-checking>
            <Loader2 size={12} className="animate-spin" aria-hidden />
            Checking with {peer.name}…
          </p>
        ) : preview.data?.refusal ? (
          <p className="m-0 text-fg" data-move-refusal>{preview.data.refusal}</p>
        ) : preview.data ? (
          <MovePlan plan={preview.data} />
        ) : null}
        {failure ? <p className="m-0 text-[11.5px] text-danger" data-move-error>{failure}</p> : null}
      </div>
    </Dialog>
  )
}

function MovePlan({ plan }: { plan: ThreadMovePreview }) {
  return (
    <>
      <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2" data-move-plan>
        {plan.destination ? (
          <>
            <dt>Goes to</dt>
            <dd className="m-0 break-all font-mono text-[11.5px] text-fg" title={plan.destination.project}>{plan.destination.dir}</dd>
          </>
        ) : null}
        {plan.checkout ? (
          <>
            <dt>Checkout</dt>
            <dd className="m-0 text-fg">
              {plan.checkout.rel === "." ? "Main checkout" : <span className="break-all font-mono text-[11.5px]">{plan.checkout.rel}</span>}
              {plan.checkout.branch ? (
                <>
                  <span className="text-muted"> on </span>
                  <span className="break-all font-mono text-[11.5px]">{plan.checkout.branch}</span>
                </>
              ) : null}
            </dd>
          </>
        ) : null}
        <dt>Uncommitted</dt>
        <dd className="m-0">
          {plan.wipPaths.length > 0 ? <PathList paths={plan.wipPaths} data="data-move-wip" /> : <span className="text-fg">Nothing to carry</span>}
        </dd>
        {plan.leftBehind.length > 0 ? (
          <>
            <dt>Stays here</dt>
            <dd className="m-0 flex flex-col gap-1">
              <PathList paths={plan.leftBehind} data="data-move-left-behind" />
              <span className="text-[11px] text-muted-70">Uncommitted, but not this thread's edits.</span>
            </dd>
          </>
        ) : null}
      </dl>
      <p className="m-0 text-[11.5px] text-muted-70">The thread stays readable here, and continues on the other machine.</p>
    </>
  )
}

function PathList({ paths, data }: { paths: readonly string[]; data: string }) {
  const shown = paths.slice(0, LIST_CAP)
  const rest = paths.length - shown.length
  return (
    <ul className="m-0 flex list-none flex-col p-0" {...{ [data]: "" }}>
      {shown.map((path) => (
        <li key={path} className="break-all font-mono text-[11.5px] leading-[18px] text-fg">{path}</li>
      ))}
      {rest > 0 ? <li className="text-[11.5px] leading-[18px] text-muted">and {rest} more</li> : null}
    </ul>
  )
}

/** In place of the prompt box on a thread that left this machine (see the header). */
export function MovedThreadNotice({ thread }: { thread: ThreadView }) {
  const stamp = thread.movedTo!
  const api = useThreadApi()
  const now = useNowMs()
  const retry = useMutation({
    mutationFn: () => api.threadMove({ slug: thread.id, peerId: stamp.peerId }),
    onSuccess: toastMoved,
  })
  const keep = useMutation({
    mutationFn: () => api.threadMoveKeepHere({ slug: thread.id }),
    onSuccess: () => showToast("Kept on this machine"),
  })
  if (!stamp.pending) {
    const age = relativeAge(stamp.at, now)
    return (
      <div className="rounded-xl border border-border bg-bg px-3.5 py-3 text-[12.5px] leading-[18px] text-muted" data-moved-notice="moved">
        Moved to <span className="text-fg">{stamp.peerName}</span>{age ? ` ${age}` : ""}. Continue it there.
      </div>
    )
  }
  const busy = retry.isPending || keep.isPending
  const failure = retry.error ? errorText(retry.error) : keep.error ? errorText(keep.error) : null
  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-bg px-3.5 py-3 text-[12.5px] leading-[18px] text-muted" data-moved-notice="pending">
      <p className="m-0">
        The move to <span className="text-fg">{stamp.peerName}</span> wasn't confirmed, and it may already be there. Retry to finish it, or keep it here.
      </p>
      <div className="flex items-center gap-2">
        <button type="button" className={PRIMARY_BUTTON} disabled={busy} onClick={() => retry.mutate()} data-moved-retry>
          {retry.isPending && <Loader2 size={12} className="animate-spin" aria-hidden />}
          Retry the move
        </button>
        <button type="button" className={SECONDARY_BUTTON} disabled={busy} onClick={() => keep.mutate()} data-moved-keep>
          Keep it here
        </button>
      </div>
      {failure ? <p className="m-0 text-[11.5px] text-danger">{failure}</p> : null}
    </div>
  )
}

/** "From desktop", on the facts line of a thread that arrived from another machine. */
export function MovedFromFact({ thread, lead }: { thread: ThreadView; lead?: ReactNode }) {
  const now = useNowMs()
  const stamp = thread.movedFrom
  if (!stamp) return null
  const age = relativeAge(stamp.at, now)
  return (
    <>
      {lead}
      <span data-moved-from className="min-w-0 truncate whitespace-nowrap" title={`Moved here from ${stamp.peerName}${age ? ` ${age}` : ""}`}>
        From {stamp.peerName}
      </span>
    </>
  )
}
