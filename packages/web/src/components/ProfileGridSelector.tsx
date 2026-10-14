import * as RadixMenu from "@radix-ui/react-dropdown-menu"
import { ChevronDown, Loader2 } from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import {
  moveProfileGridSelection,
  PROFILE_GRID_CELL_CLASS,
  PROFILE_GRID_COMPACT_TYPOGRAPHY_CLASS,
  PROFILE_GRID_TYPOGRAPHY_CLASS,
  profileGridColumns,
  profileGridDisplayLabel,
  profileGridDisplayParts,
  profileGridEffortLabel,
  profileGridRowSlots,
  profileGridSelectionFromKey,
  profileGridSelectionKey,
  profileGridSelectionKnown,
  profileGridStacks,
  profileGridTemplateColumns,
  type ProfileGridGroup,
  type ProfileGridMoveKey,
  type ProfileGridOption,
  type ProfileGridDisplayParts,
  type ProfileGridSelection,
  profileGridSelections,
} from "../lib/profileGrid.ts"
import { dismissOpenSelect, registerOpenSelect } from "../lib/selectOverlay.ts"
import { OPAQUE_PORTAL_SURFACE_Z, OPAQUE_SURFACE_BASE } from "../lib/overlaySurface.ts"
import { AgentSettingsPopover } from "./AgentSettingsPopover.tsx"
import { PhoneProfileSelector } from "./MobileModelSheet.tsx"
import { useIsMobile } from "../lib/mobile.ts"

const effortLabel = profileGridEffortLabel

// The model column's label: the family word, then its version one step dimmer (maintainer 2026-09-24,
// picking candidate A of the version mockups: "a grade-out version after the model name in the left
// column of the selector"). A label that does not END in its edition renders whole — never a guess.
function ModelLabel({ label, edition }: { label: string; edition?: string }) {
  const suffix = edition ? ` ${edition}` : ""
  if (!suffix || !label.endsWith(suffix)) return <>{label}</>
  return <>{label.slice(0, -suffix.length)} <span className="profile-grid-edition text-edition">{edition}</span></>
}

// The trigger's readout: the model, its version in the same dim ink as the menu's model column, then the
// effort — "Opus 5.5 › high" with the 5.5 grayed, in the dispatch composer and a running thread's alike.
function TriggerLabel({ name, edition, effort }: ProfileGridDisplayParts) {
  return (
    <>
      {name}
      {edition && <> <span className="profile-grid-edition text-edition">{edition}</span></>}
      {effort && ` › ${effort}`}
    </>
  )
}

// "Opus 5.5" must never break between the family and its version when a sentence wraps.
function unbroken(label: string): string {
  return label.replace(/ /g, "\u00a0")
}

/** A running Claude thread on an older edition of its family than the pinned runtime now resolves. The
 *  edition it runs is the trigger's own readout (`runningModelLabel`), so the row names only the target. */
export interface ProfileGridUpgrade {
  /** "Opus 5.5" — what the family resolves to now. */
  latest: string
  /** No live worker holds the old edition: the next turn starts on `latest` with nothing to do. */
  staged: boolean
  /** Why the upgrade cannot run right now (a turn in flight, background work), or null. */
  blockedReason: string | null
  pending: boolean
  onUpgrade: () => void
}

type ProfileGridSelectorProps = {
  groups: readonly ProfileGridGroup[]
  value?: Partial<ProfileGridSelection>
  pending?: Partial<ProfileGridSelection>
  onValueChange: (selection: ProfileGridSelection) => void
  placeholder?: string
  ariaLabel: string
  menuAriaLabel?: string
  title?: string
  disabled?: boolean
  compact?: boolean
  side?: "top" | "bottom"
  // EXACTLY ONE z utility for the portaled menu (see lib/overlaySurface.ts — two z-* classes on one
  // element resolve by CSS source order, not class order). Override only to clear a higher surface
  // the trigger lives inside, e.g. OPAQUE_PORTAL_SURFACE_ABOVE_DIALOG_Z inside the z-[200] Overlay.
  menuZClass?: string
  className?: string
  // A gear on each runtime's band opening that runtime's settings for NEW workers in this project
  // (AgentSettingsPopover) — never a promise to retune a running thread. The dispatch surfaces set it;
  // a live thread's own picker does not.
  agentSettings?: boolean
  // A running thread's readout names the edition its worker RUNS (profileGridDisplayLabel), and its menu
  // offers the move to the family's current edition — both only on a live thread's own picker.
  runningModelLabel?: string
  upgrade?: ProfileGridUpgrade
}

// ONE selector, two presentations. Below the phone breakpoint the grid popover gives way to a chip and
// a bottom sheet (MobileModelSheet): the grid's six effort columns do not fit a 390px screen. Both write
// the same selection through the same `onValueChange`, so no call site knows which one it rendered — and
// a separate component per branch keeps each one's hooks its own when a window crosses the breakpoint.
export function ProfileGridSelector(props: ProfileGridSelectorProps) {
  return useIsMobile() ? <PhoneProfileSelector {...props} /> : <DesktopProfileGridSelector {...props} />
}

function DesktopProfileGridSelector({
  groups,
  value,
  pending,
  onValueChange,
  placeholder,
  ariaLabel,
  menuAriaLabel = "Choose model and effort",
  title,
  disabled = false,
  compact = false,
  side = "bottom",
  menuZClass = OPAQUE_PORTAL_SURFACE_Z,
  className = "",
  agentSettings = false,
  runningModelLabel,
  upgrade,
}: ProfileGridSelectorProps) {
  const [open, setOpen] = useState(false)
  const [settingsGroup, setSettingsGroup] = useState<string | null>(null)
  const settingsGroupRef = useRef(settingsGroup)
  settingsGroupRef.current = settingsGroup
  const openRef = useRef(open)
  const disabledRef = useRef(disabled)
  const unregisterOpenRef = useRef<(() => void) | undefined>(undefined)
  const cellRefs = useRef(new Map<string, HTMLElement>())
  const committedKeyRef = useRef<string | undefined>(undefined)
  // STACKED when the matrix does not fit the menu (profileGridStacks): each model's name on its own line,
  // its effort words wrapping under it. Decided by MEASURING, never by a breakpoint, because the matrix's
  // width is the catalogue's: the menu opens as the matrix, `fitMenu` reads its widest row against the
  // menu's resolved max-width in the same commit, and a matrix that overflows re-renders stacked before
  // the browser paints. That natural width can only be read while the matrix is drawn, so it is kept for
  // the way back — a resize that gives it room draws the matrix again — and a closed menu forgets the
  // decision, so a catalogue that changed meanwhile is measured afresh on the next open.
  const [stacked, setStacked] = useState(false)
  const stackedRef = useRef(stacked)
  stackedRef.current = stacked
  const menuNodeRef = useRef<HTMLDivElement | null>(null)
  const naturalWidthRef = useRef(0)
  const fitMenu = useCallback(() => {
    const menu = menuNodeRef.current
    if (!menu) return
    const style = getComputedStyle(menu)
    const cap = parseFloat(style.maxWidth)
    if (!Number.isFinite(cap)) return
    if (!stackedRef.current) {
      const rows = [...menu.querySelectorAll<HTMLElement>("[data-profile-grid-row]")]
      if (rows.length === 0) return
      // A matrix row is `w-max`, so its box IS its natural width. Around the widest, the menu adds its
      // padding, its border and any vertical scrollbar (offsetWidth less clientWidth less the borders).
      const borders = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)
      const scrollbar = Math.max(0, menu.offsetWidth - menu.clientWidth - borders)
      naturalWidthRef.current = Math.max(...rows.map((row) => row.getBoundingClientRect().width))
        + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + borders + scrollbar
    }
    const next = profileGridStacks(naturalWidthRef.current, cap)
    if (next !== stackedRef.current) {
      stackedRef.current = next
      setStacked(next)
    }
  }, [])
  // The content mounts a commit after `open` flips (Radix portals it in a layout effect of its own), so
  // the first measurement runs from its ref, not from the effect below.
  const menuRef = useCallback((node: HTMLDivElement | null) => {
    menuNodeRef.current = node
    if (node) fitMenu()
  }, [fitMenu])
  const columns = useMemo(() => profileGridColumns(groups), [groups])
  const selections = useMemo(() => profileGridSelections(groups), [groups])
  const typography = compact ? PROFILE_GRID_COMPACT_TYPOGRAPHY_CLASS : PROFILE_GRID_TYPOGRAPHY_CLASS
  const triggerInteraction = disabled
    ? "cursor-not-allowed opacity-45"
    : "cursor-pointer transition-colors hover:border-border hover:bg-panel-2 hover:text-fg"
  const known = profileGridSelectionKnown(groups, value)
  // `known` has already checked the effort against the row, and a row with no effort axis (an ACP
  // agent) is keyed on `effort: ""` — so the key is built whenever the model is known, not only when
  // the effort is non-empty.
  const currentKey = known && value?.provider && value.model
    ? profileGridSelectionKey({ provider: value.provider, model: value.model, effort: value.effort ?? "" })
    : undefined
  const pendingLabel = pending?.model || pending?.effort
    ? profileGridDisplayLabel(groups, pending, "Pending profile")
    : undefined
  openRef.current = open
  disabledRef.current = disabled

  function closeFromRegistry() {
    setSettingsGroup(null)
    openRef.current = false
    unregisterOpenRef.current = undefined
    setOpen(false)
  }

  // Escape peels ONE layer: the agent-settings panel if it is open, else the menu. A Select open
  // INSIDE that panel registered itself after this menu did, so `dismissOpenSelect` closes it and
  // nothing else — the keydown handler below checks the registry before touching a layer of its own.
  function dismissTopLayer() {
    if (settingsGroupRef.current) {
      settingsGroupRef.current = null
      setSettingsGroup(null)
      unregisterOpenRef.current = registerOpenSelect(dismissTopLayer)
    } else closeFromRegistry()
  }

  useLayoutEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || !openRef.current || disabledRef.current) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      // The registry holds whichever layer opened LAST — this menu's own entry (its dismiss is
      // dismissTopLayer) or a Select inside the settings panel. Either way one press, one layer.
      if (dismissOpenSelect()) return
      unregisterOpenRef.current?.()
      dismissTopLayer()
    }
    window.addEventListener("keydown", onKeyDown, { capture: true })
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true })
  }, [])

  useLayoutEffect(() => {
    if (!disabled || !open) return
    unregisterOpenRef.current?.()
    closeFromRegistry()
  }, [disabled, open])

  useLayoutEffect(() => () => unregisterOpenRef.current?.(), [])

  // Re-measure when the catalogue changes under an open menu and when a resize draws the matrix again;
  // forget the decision on close.
  useLayoutEffect(() => {
    if (open) fitMenu()
    else if (stackedRef.current) {
      stackedRef.current = false
      setStacked(false)
    }
  }, [open, groups, stacked, fitMenu])

  useEffect(() => {
    if (!open) return
    window.addEventListener("resize", fitMenu)
    return () => window.removeEventListener("resize", fitMenu)
  }, [open, fitMenu])

  // A pointer selection also reaches RadioGroup's onValueChange. Clear the one-event guard once
  // its controlled value has caught up, so keyboard activation remains available while one click
  // can never enqueue two preference writes.
  useLayoutEffect(() => {
    if (currentKey === committedKeyRef.current) committedKeyRef.current = undefined
  }, [currentKey])

  function commitSelection(selection: ProfileGridSelection) {
    const key = profileGridSelectionKey(selection)
    if (committedKeyRef.current === key) return
    committedKeyRef.current = key
    onValueChange(selection)
  }

  function handleCellKeyDown(event: KeyboardEvent<HTMLElement>, current: ProfileGridSelection) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return
    const next = moveProfileGridSelection(groups, current, event.key as ProfileGridMoveKey)
    if (!next) return
    event.preventDefault()
    event.stopPropagation()
    cellRefs.current.get(profileGridSelectionKey(next))?.focus()
  }

  // A row with NO effort axis — an ACP agent runs on whatever model and effort its own CLI is configured
  // for — is one cell, keyed on `effort: ""` (profileGridOptionEfforts). In the matrix it spans every
  // effort column. "Default" is the honest label: ntwine sets nothing, the agent's own defaults apply.
  function renderDefaultCell(group: ProfileGridGroup, option: ProfileGridOption) {
    const selection = { provider: group.id, model: option.model, effort: "" }
    const key = profileGridSelectionKey(selection)
    return (
      <RadixMenu.RadioItem
        key="default"
        value={key}
        ref={(node) => {
          if (node) cellRefs.current.set(key, node)
          else cellRefs.current.delete(key)
        }}
        onKeyDown={(event) => handleCellKeyDown(event, selection)}
        onSelect={(event) => {
          event.preventDefault()
          commitSelection(selection)
          unregisterOpenRef.current?.()
          closeFromRegistry()
        }}
        aria-label={`${option.label}, the agent's own defaults`}
        title={`${option.label} › the agent's own model and effort`}
        className={PROFILE_GRID_CELL_CLASS}
        style={stacked ? undefined : { gridColumn: "2 / -1", justifySelf: "start" }}
      >
        <span className="grid">
          <span aria-hidden="true" className="invisible col-start-1 row-start-1 font-medium">Default</span>
          <span className="col-start-1 row-start-1">Default</span>
        </span>
      </RadixMenu.RadioItem>
    )
  }

  function renderEffortCell(group: ProfileGridGroup, option: ProfileGridOption, effort: string) {
    const selection = { provider: group.id, model: option.model, effort }
    const key = profileGridSelectionKey(selection)
    return (
      <RadixMenu.RadioItem
        key={effort}
        value={key}
        ref={(node) => {
          if (node) cellRefs.current.set(key, node)
          else cellRefs.current.delete(key)
        }}
        onKeyDown={(event) => handleCellKeyDown(event, selection)}
        onSelect={(event) => {
          // Radix dismisses a DropdownMenu as part of selection. Commit this
          // pointer path first and own the close, otherwise a controlled menu
          // can close with its RadioGroup callback already unmounted.
          event.preventDefault()
          commitSelection(selection)
          unregisterOpenRef.current?.()
          closeFromRegistry()
        }}
        aria-label={`${option.label}, ${effortLabel(effort)} effort`}
        title={`${option.label} › ${effortLabel(effort)}`}
        className={PROFILE_GRID_CELL_CLASS}
      >
        <span className="grid">
          {/* A checked cell sets its label in `font-medium`, which is 0.82px wider
              here — enough to push every cell to its right along the moment the
              selection moves, now that a cell is only as wide as its word. Stack an
              invisible copy at the heavier weight in the same grid cell so the cell
              always reserves its widest state and never resizes. */}
          <span aria-hidden="true" className="invisible col-start-1 row-start-1 font-medium">{effortLabel(effort)}</span>
          <span className="col-start-1 row-start-1">{effortLabel(effort)}</span>
        </span>
      </RadixMenu.RadioItem>
    )
  }

  return (
    <RadixMenu.Root
      modal={false}
      open={open}
      onOpenChange={(next) => {
        unregisterOpenRef.current?.()
        unregisterOpenRef.current = undefined
        openRef.current = next
        setOpen(next)
        if (next) unregisterOpenRef.current = registerOpenSelect(dismissTopLayer)
        else setSettingsGroup(null)
      }}
    >
      <RadixMenu.Trigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={ariaLabel}
          aria-invalid={!known && Boolean(value?.model || value?.effort) ? true : undefined}
          aria-description={pendingLabel ? `Pending ${pendingLabel}` : undefined}
          title={title}
          data-profile-known={known ? "true" : "false"}
          data-profile-pending={pendingLabel ? "true" : undefined}
          className={`profile-grid-trigger group inline-flex min-w-0 max-w-full items-center gap-[3px] rounded-md border border-border/50 bg-transparent px-2 py-1 text-left text-muted outline-none data-[state=open]:border-border data-[state=open]:bg-panel-2 ${triggerInteraction} ${className} ${typography}`}
        >
          {/* Sans cap-band residual is 0.23px without a text nudge; 3px box gap paints 6.69px of ink. */}
          <span className={`profile-grid-value min-w-0 flex-1 truncate text-left ${typography}`}>
            <TriggerLabel {...profileGridDisplayParts(groups, value, placeholder, runningModelLabel)} />
          </span>
          {pendingLabel && <Loader2 aria-hidden="true" size={compact ? 10 : 11} className="shrink-0 animate-spin text-muted-65" />}
          <ChevronDown aria-hidden="true" size={compact ? 11 : 13} className="shrink-0 text-fg/65 transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content
          ref={menuRef}
          aria-label={menuAriaLabel}
          align="start"
          side={side}
          sideOffset={5}
          collisionPadding={8}
          onEscapeKeyDown={(event) => event.stopPropagation()}
          // While the agent-settings panel is open it owns every outside interaction: it is modal, so
          // this menu's layer has its pointer events disabled anyway, and a focus wander into a Select
          // the panel opened must not read as leaving the menu.
          onInteractOutside={(event) => {
            if (settingsGroupRef.current) event.preventDefault()
            else if (event.target instanceof Element && event.target.closest("[data-agent-settings-menu]")) event.preventDefault()
          }}
          className={`profile-grid-menu ${menuZClass} ${OPAQUE_SURFACE_BASE} max-h-[min(360px,var(--radix-dropdown-menu-content-available-height))] max-w-[calc(100vw-1rem)] overflow-auto rounded-lg p-1.5 ${typography}`}
        >
          {/* THE GRID IS BUILT ONLY WHILE THE MENU IS OPEN. Closed, Radix mounts none of it, but the
              elements were still CREATED on every render of every picker — one per model × effort cell,
              with its ghosts. The one page draws a closed picker in every queue card's reply box, and
              opening another project's thread re-renders all of them; in the dev build (jsxDEV and a
              console task per element) that was 121–189ms of a 1.3–2.6s open, the largest single cost in
              the profile (2026-09-28). The menu has no exit animation, so Radix unmounts the content the
              moment `open` goes false and nothing can see the gate. */}
          {open && groups.map((group) => (
            <RadixMenu.Group key={group.id}>
              {group.label && (
                <div className="profile-grid-header sticky left-0 flex items-baseline justify-between gap-4 px-1.5 pb-1 pt-1 first:pt-0.5">
                  <RadixMenu.Label className="text-left font-medium tracking-[0.07em] text-muted-55">
                    {group.label}
                  </RadixMenu.Label>
                  {agentSettings && (group.id === "claude" || group.id === "codex") && (
                    <AgentSettingsPopover
                      backend={group.id}
                      open={settingsGroup === group.id}
                      onOpenChange={(next) => setSettingsGroup(next ? group.id : null)}
                    />
                  )}
                </div>
              )}
              <RadixMenu.RadioGroup
                value={currentKey}
                // RadioGroup keeps keyboard selection semantic. Pointer activation also commits
                // from RadioItem's own select event below, before DropdownMenu tears this
                // controlled subtree down during dismissal.
                onValueChange={(key) => {
                  const selection = profileGridSelectionFromKey(groups, key)
                  if (selection) commitSelection(selection)
                }}
              >
                {group.options.map((option) => {
                  // Matrix and stack draw the same cells in the same order; only the frame around them
                  // differs, so selection, keys and the checked ring cannot drift between the two.
                  const cells = option.efforts.length === 0
                    ? [renderDefaultCell(group, option)]
                    : profileGridRowSlots(option, columns, { stacked }).map((slot) => slot.ghost
                      ? (
                          // Same box as a real cell (border + padding + type), just invisible — a
                          // ghost that is 2px narrower still drags the column out of true.
                          <span
                            key={slot.effort}
                            aria-hidden="true"
                            className={`invisible cursor-default border border-transparent px-1 text-left font-medium ${typography}`}
                          >
                            {effortLabel(slot.effort)}
                          </span>
                        )
                      : renderEffortCell(group, option, slot.effort))
                  if (stacked) {
                    return (
                      // Spacing does the grouping, since name and effort share one type and tone. Text to
                      // text: a name sits 20px over its first line of cells, a wrapped line follows at 26px
                      // (the 24px cell plus 2px), and the next model's name starts 34px down (12px clear).
                      // The cells sit 8px in under the name, so a wrapped ULTRACODE alone on its line reads
                      // as the row's tail, not as the next model.
                      <div key={option.model} data-profile-grid-row={option.model} data-profile-grid-stacked="" className="py-0.5 not-first:pt-3">
                        <span className={`profile-grid-model-label block truncate px-1.5 text-left text-muted ${typography}`} title={option.label}>
                          <ModelLabel label={option.label} edition={option.edition} />
                        </span>
                        <div className="flex flex-wrap gap-x-1 gap-y-0.5 pl-2">{cells}</div>
                      </div>
                    )
                  }
                  return (
                    <div
                      key={option.model}
                      data-profile-grid-row={option.model}
                      // `w-max`, not `min-w-max`: a stretched row hands its leftover width to its own
                      // `auto` tracks, so a row shorter or narrower than the widest one slid every cell
                      // in it out of line with the rows above. Sized to its content, a row has no
                      // leftover to spread, and each column lands where its content puts it.
                      className="grid w-max items-center gap-1 py-0.5"
                      style={{ gridTemplateColumns: profileGridTemplateColumns(columns.length) }}
                    >
                      <span className={`profile-grid-model-label min-w-0 max-w-[9.5rem] truncate px-1.5 text-left text-muted ${typography}`} title={option.label}>
                        <ModelLabel label={option.label} edition={option.edition} />
                      </span>
                      {cells}
                    </div>
                  )
                })}
              </RadixMenu.RadioGroup>
              {group !== groups.at(-1) && <RadixMenu.Separator className="my-1 h-px bg-border" />}
            </RadixMenu.Group>
          ))}
          {selections.length === 0 && (
            <div className="px-2 py-1.5 text-muted-60">No profiles available</div>
          )}
          {upgrade && (
            <>
              <RadixMenu.Separator className="my-1 h-px bg-border" />
              {/* `w-0 min-w-full`: the effort grid sets the menu's width and this row fills it, wrapping its
                  sentence rather than widening the menu to fit it on one line. */}
              <div data-profile-grid-upgrade="" className="flex w-0 min-w-full items-center gap-2 px-1.5 py-0.5">
                {/* `text-balance`: the sentence wraps at the menu's width, and unbalanced it left one word
                    alone on its second line. */}
                <span className="min-w-0 flex-1 text-balance text-muted">
                  {upgrade.staged
                    ? `This thread will upgrade to ${unbroken(upgrade.latest)} on its next turn`
                    : `This thread will auto-upgrade to ${unbroken(upgrade.latest)} after its next compaction`}
                </span>
                {!upgrade.staged && (
                  <RadixMenu.Item
                    disabled={upgrade.blockedReason !== null || upgrade.pending}
                    onSelect={(event) => {
                      event.preventDefault()
                      upgrade.onUpgrade()
                      unregisterOpenRef.current?.()
                      closeFromRegistry()
                    }}
                    title={upgrade.blockedReason
                      ?? `Restart this thread's worker on ${upgrade.latest}. The conversation resumes from disk on the next turn; the prompt cache is re-read once.`}
                    className={`flex h-6 shrink-0 cursor-pointer select-none items-center rounded border border-border bg-transparent px-1.5 text-fg outline-none transition-colors data-[highlighted]:bg-panel-2 data-[highlighted]:outline data-[highlighted]:outline-1 data-[highlighted]:outline-offset-1 data-[highlighted]:outline-fg/55 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45 ${typography}`}
                  >
                    Upgrade now
                  </RadixMenu.Item>
                )}
              </div>
            </>
          )}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  )
}
