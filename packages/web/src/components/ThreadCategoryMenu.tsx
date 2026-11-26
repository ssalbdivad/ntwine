import { useEffect, useState } from "react"
import { Check, ChevronDown, Pin, PinOff } from "lucide-react"
import type { ThreadView } from "@ntwine/shared"
import { bandOf, futureSnoozedUntil, isActivelyRunning } from "../groups.ts"
import { optimisticallyArchived, useArchivingAt } from "../lib/optimisticArchive.ts"
import { usePinToggle } from "../lib/pinThread.ts"
import { optimisticallySteered, useSteeredAt } from "../lib/steering.ts"
import { canMoveToReady } from "../lib/threadLifecycle.ts"
import { BANDS, BandLabel } from "./BandLabel.tsx"
import { CustomSnoozeDialog, SnoozePresetItems, useApplySnooze } from "./SnoozeMenu.tsx"
import { CompletionConfirmDialog, useCompleteThread, useMoveToReady } from "./ThreadLifecycle.tsx"
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger, MenuTrigger } from "./ui/Menu.tsx"

type CategoryCallbacks = {
  onArchived?: () => void
  onSnoozed?: () => void
  onMovedToReady?: () => void
}

type CategoryControllerArgs = {
  thread: ThreadView
  projectName?: string
} & CategoryCallbacks

function useCategoryActions({ thread, projectName, onArchived, onSnoozed, onMovedToReady }: CategoryControllerArgs) {
  const [customSnoozeOpen, setCustomSnoozeOpen] = useState(false)
  const [customSnoozeError, setCustomSnoozeError] = useState("")
  const snooze = useApplySnooze({
    thread,
    projectName,
    onSnoozed,
    onError: setCustomSnoozeError,
    onApplied: () => {
      setCustomSnoozeOpen(false)
      setCustomSnoozeError("")
    },
  })
  const ready = useMoveToReady({ thread, onMoved: onMovedToReady })
  const completion = useCompleteThread({ thread, onArchived })
  const pin = usePinToggle(thread)
  return {
    customSnoozeOpen,
    setCustomSnoozeOpen,
    customSnoozeError,
    setCustomSnoozeError,
    snooze,
    ready,
    completion,
    pin,
  }
}

type CategoryMenuItemsProps = {
  thread: ThreadView
  open: boolean
  actions: ReturnType<typeof useCategoryActions>
}

function CategoryMenuItems({ thread, open, actions }: CategoryMenuItemsProps) {
  const steeredAt = useSteeredAt()
  const archivingAt = useArchivingAt()
  const band = bandOf(optimisticallyArchived(optimisticallySteered(thread, steeredAt[thread.id]), archivingAt[thread.id]))
  const done = thread.state === "archived" || thread.archived === true
  const snoozed = Boolean(futureSnoozedUntil(thread))
  const working = isActivelyRunning(thread)
  const readyAllowed = canMoveToReady(thread)
  const ReadyIcon = BANDS.ready.Icon
  const SnoozeIcon = BANDS.snoozed.Icon
  const DoneIcon = BANDS.done.Icon

  return (
    <>
      <MenuLabel>Move to</MenuLabel>
      <MenuItem
        value="category-ready"
        icon={<ReadyIcon size={12} />}
        disabled={band === "ready" || !readyAllowed || actions.ready.busy}
        trailing={band === "ready" ? <Check size={12} /> : !readyAllowed ? (thread.schedule?.pending ? "Scheduled" : "Working") : undefined}
        onSelect={() => void actions.ready.moveToReady()}
      >
        Ready
      </MenuItem>
      <MenuSub>
        <MenuSubTrigger
          value="category-snoozed"
          icon={<SnoozeIcon size={12} />}
          disabled={working && !snoozed}
          trailing={snoozed ? <Check size={12} /> : working ? "Working" : undefined}
        >
          Snoozed
        </MenuSubTrigger>
        <MenuSubContent>
          <SnoozePresetItems
            thread={thread}
            open={open}
            onPick={(until) => void actions.snooze.apply(until)}
            onCustom={() => actions.setCustomSnoozeOpen(true)}
          />
        </MenuSubContent>
      </MenuSub>
      <MenuItem
        value="category-done"
        icon={<DoneIcon size={12} />}
        disabled={done || actions.completion.pending}
        trailing={done ? <Check size={12} /> : undefined}
        onSelect={() => actions.completion.complete(false, false)}
      >
        Done
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        value="category-pin"
        icon={actions.pin.pinned ? <PinOff size={12} aria-hidden /> : <Pin size={12} aria-hidden />}
        onSelect={actions.pin.toggle}
      >
        {actions.pin.pinned ? "Unpin" : "Pin to top"}
      </MenuItem>
    </>
  )
}

type CategoryDialogsProps = {
  thread: ThreadView
  actions: ReturnType<typeof useCategoryActions>
}

function CategoryDialogs({ thread, actions }: CategoryDialogsProps) {
  return (
    <>
      <CustomSnoozeDialog
        open={actions.customSnoozeOpen}
        onOpenChange={actions.setCustomSnoozeOpen}
        thread={thread}
        busy={actions.snooze.busy}
        error={actions.customSnoozeError}
        onErrorChange={actions.setCustomSnoozeError}
        onSubmit={(until, bump) => void actions.snooze.apply(until, bump)}
      />
      <CompletionConfirmDialog
        open={actions.completion.dialogOpen}
        pending={actions.completion.pending}
        hold={actions.completion.hold}
        stops={actions.completion.stops}
        onToggleStop={actions.completion.toggleStop}
        onClose={actions.completion.closeDialog}
        onConfirm={() => actions.completion.complete(true, false)}
      />
    </>
  )
}

export type ThreadBandPickerProps = {
  thread: ThreadView
  projectName?: string
  onArchived?: () => void
  onSnoozed?: () => void
  onMovedToReady?: () => void
}

/**
 * Interactive band stamp in the thread drawer header: displays the thread's current band
 * (READY, WORKING, WAITING, SNOOZED, DONE) and opens a category menu on click for any owned
 * thread so the user can move between Done, Snoozed, Ready, and Pinned in place.
 */
export function ThreadBandPicker({ thread, projectName, onArchived, onSnoozed, onMovedToReady }: ThreadBandPickerProps) {
  const steeredAt = useSteeredAt()
  const archivingAt = useArchivingAt()
  const band = bandOf(optimisticallyArchived(optimisticallySteered(thread, steeredAt[thread.id]), archivingAt[thread.id]))
  const [open, setOpen] = useState(false)
  const owned = (thread.kind === "session" || thread.kind === "terminal") && thread.foreign !== true
  const editable = owned && thread.schedule?.pending !== true
  const actions = useCategoryActions({ thread, projectName, onArchived, onSnoozed, onMovedToReady })

  if (!band) return null
  if (band === "working" && thread.held !== undefined) return null
  if (!editable) return <BandLabel band={band} className="shrink-0" data-thread-band={band} />

  return (
    <>
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger asChild>
          <button
            type="button"
            data-thread-band={band}
            data-thread-category-trigger
            aria-label={`Category: ${BANDS[band].label}. Click to move`}
            title="Move to another category"
            onMouseDown={(event) => event.preventDefault()}
            className={`group/band inline-flex shrink-0 cursor-pointer items-center gap-0.5 rounded px-1 -mx-1 py-0.5 -my-0.5 outline-none transition-colors hover:bg-panel-2 focus-visible:ring-1 focus-visible:ring-focus-ink-60 ${open ? "bg-panel-2" : ""}`}
          >
            <BandLabel band={band} className="shrink-0 group-hover/band:text-fg" />
            <ChevronDown
              size={10}
              aria-hidden
              className="shrink-0 -translate-y-[0.06em] text-muted-55 transition-colors group-hover/band:text-fg"
            />
          </button>
        </MenuTrigger>
        <MenuContent align="start">
          <CategoryMenuItems thread={thread} open={open} actions={actions} />
        </MenuContent>
      </Menu>
      <CategoryDialogs thread={thread} actions={actions} />
    </>
  )
}

export type ContextMenuAnchor = {
  x: number
  y: number
}

export type ThreadContextMenuProps = {
  thread: ThreadView
  anchor: ContextMenuAnchor
  projectName?: string
  onClose: () => void
}

/**
 * Right-click category menu for sidebar rail rows and History rows. Mounted lazily only after a
 * context-menu click (zero idle cost per row) and unmounted once the menu and any dialog it opened
 * have both closed.
 */
export function ThreadContextMenu({ thread, anchor, projectName, onClose }: ThreadContextMenuProps) {
  const [open, setOpen] = useState(true)
  const actions = useCategoryActions({ thread, projectName })
  const dialogOpen = actions.customSnoozeOpen || actions.completion.dialogOpen

  useEffect(() => {
    if (!open && !dialogOpen) onClose()
  }, [open, dialogOpen, onClose])

  return (
    <>
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger asChild>
          <span
            aria-hidden
            tabIndex={-1}
            className="pointer-events-none fixed h-0 w-0"
            style={{ left: anchor.x, top: anchor.y }}
          />
        </MenuTrigger>
        <MenuContent align="start" sideOffset={2}>
          <CategoryMenuItems thread={thread} open={open} actions={actions} />
        </MenuContent>
      </Menu>
      <CategoryDialogs thread={thread} actions={actions} />
    </>
  )
}
