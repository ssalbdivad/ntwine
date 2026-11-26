import * as RadixMenu from "@radix-ui/react-dropdown-menu"
import { ChevronRight } from "lucide-react"
import type { ComponentProps, ReactNode } from "react"
import { OPAQUE_PORTAL_SURFACE_ABOVE_DIALOG_Z, OPAQUE_PORTAL_SURFACE_Z, OPAQUE_SURFACE_BASE } from "../../lib/overlaySurface.ts"

// Thin styled wrappers over Radix DropdownMenu so call sites read declaratively. The popover
// matches the Select: elevated bg, soft shadow, padded rounded items. These are anchored popovers,
// not modal dialogs: keep the surrounding app visible to assistive technology and pointer-capable
// while the menu is open. Radix defaults DropdownMenu to modal, which otherwise aria-hides #root and
// disables body pointer events even though no visual overlay is rendered.
export function Menu({ modal = false, ...props }: ComponentProps<typeof RadixMenu.Root>) {
  return <RadixMenu.Root modal={modal} {...props} />
}
export const MenuTrigger = RadixMenu.Trigger

export function MenuContent({
  children,
  align = "end",
  sideOffset = 6,
  aboveDialog = false,
  collisionPadding = 8,
}: {
  children: ReactNode
  align?: "start" | "center" | "end"
  sideOffset?: number
  /** Opened from inside the shared z-[200] Dialog, whose backdrop the default z-[110] paints beneath. */
  aboveDialog?: boolean
  /** Room to keep between the menu and the viewport's edges when it is shifted to fit. Radix's own default
   *  is 0, which pinned a menu flush against the window's edge wherever it had to shift — in an editor's
   *  narrow sidebar that was every menu: the drawer's ⋯ sat at x=0 at 300 and 450px. */
  collisionPadding?: number
}) {
  return (
    <RadixMenu.Portal>
      <RadixMenu.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        // Escape closes ONLY the menu — the pattern ui/Popover.tsx and ui/Select.tsx already follow. Radix
        // dismisses it from a document-CAPTURE listener, so without this the same key went on to
        // DrawerStack's window listener, which popped the drawer the menu was opened from: one Esc on a
        // thread's ⋯ or Snooze ▾ closed the menu AND the thread (sidebar and desktop alike, 2026-10-01). Not
        // `preventDefault` — Radix still closes the menu — and not a `defaultPrevented` guard in DrawerStack,
        // which would kill Escape on every sheet stacked over a thread (ThreadSheet prevents it on purpose to
        // hand the key to DrawerStack).
        onEscapeKeyDown={(event) => event.stopPropagation()}
        // Never wider than the room Radix measured on the menu's side of the trigger (the viewport less the
        // collision padding). A menu sized to its longest row — a long project name, Home's folder — ran
        // off a 300px sidebar by 35px and hid the counts and "Not open" at the rows' ends; capped, the
        // rows' `min-w-0 truncate` names give way and what follows them stays.
        className={`${aboveDialog ? OPAQUE_PORTAL_SURFACE_ABOVE_DIALOG_Z : OPAQUE_PORTAL_SURFACE_Z} ${OPAQUE_SURFACE_BASE} min-w-[min(184px,var(--radix-dropdown-menu-content-available-width))] max-w-[var(--radix-dropdown-menu-content-available-width)] overflow-hidden rounded-lg p-1`}
      >
        {children}
      </RadixMenu.Content>
    </RadixMenu.Portal>
  )
}

export function MenuItem({
  children,
  onSelect,
  icon,
  danger,
  disabled,
  value,
  shortcut,
  trailing,
}: {
  children: ReactNode
  onSelect: () => void
  icon?: ReactNode
  danger?: boolean
  disabled?: boolean
  /** The item's key, formatted (useShortcutLabel), drawn muted at the row's end. */
  shortcut?: string | null
  /** Optional trailing mark/hint at the row's end (e.g. a checkmark or disabled reason). */
  trailing?: ReactNode
  /** Rendered as `data-value`, so a caller (or a test) can find one item by its key. */
  value?: string
}) {
  return (
    <RadixMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      data-value={value}
      // `[&>*]:basis-auto`: when a capped menu (MenuContent's max width) is narrower than a row, its parts give
      // way in proportion to their length. A `flex-1` name has a 0 basis, so beside a shrinkable hint it gave
      // way FIRST and entirely — Home's row in a 300px sidebar read "H…" beside its whole folder path, or
      // lost its name altogether. With room to spare the row lays out exactly as before: the name is still
      // its only growing part, so it still takes all the free space.
      className={`flex select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] outline-none transition-colors [&>*]:basis-auto ${
        disabled
          ? "cursor-default text-muted opacity-55"
          : danger
            ? "cursor-pointer text-danger data-[highlighted]:bg-panel-2 data-[highlighted]:text-danger-soft"
            : "cursor-pointer text-muted data-[highlighted]:bg-panel-2 data-[highlighted]:text-fg"
      }`}
    >
      {icon && <span className="flex w-3.5 shrink-0 items-center justify-center">{icon}</span>}
      {children}
      {shortcut && <span className="ml-auto pl-4 text-[11px] text-muted-55">{shortcut}</span>}
      {trailing && <span className="ml-auto flex shrink-0 items-center pl-4 text-[11px] text-muted-55">{trailing}</span>}
    </RadixMenu.Item>
  )
}

export const MenuSub = RadixMenu.Sub

export function MenuSubTrigger({
  children,
  icon,
  disabled,
  value,
  trailing,
}: {
  children: ReactNode
  icon?: ReactNode
  disabled?: boolean
  value?: string
  trailing?: ReactNode
}) {
  return (
    <RadixMenu.SubTrigger
      disabled={disabled}
      data-value={value}
      className={`flex select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] outline-none transition-colors [&>*]:basis-auto ${
        disabled
          ? "cursor-default text-muted opacity-55"
          : "cursor-pointer text-muted data-[highlighted]:bg-panel-2 data-[highlighted]:text-fg data-[state=open]:bg-panel-2 data-[state=open]:text-fg"
      }`}
    >
      {icon && <span className="flex w-3.5 shrink-0 items-center justify-center">{icon}</span>}
      {children}
      <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-4 text-[11px] text-muted-55">
        {trailing}
        <ChevronRight size={12} aria-hidden className="text-muted-60" />
      </span>
    </RadixMenu.SubTrigger>
  )
}

export function MenuSubContent({
  children,
  sideOffset = 6,
  alignOffset = -4,
  aboveDialog = false,
  collisionPadding = 8,
}: {
  children: ReactNode
  sideOffset?: number
  alignOffset?: number
  aboveDialog?: boolean
  collisionPadding?: number
}) {
  return (
    <RadixMenu.Portal>
      <RadixMenu.SubContent
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        collisionPadding={collisionPadding}
        onEscapeKeyDown={(event) => event.stopPropagation()}
        className={`${aboveDialog ? OPAQUE_PORTAL_SURFACE_ABOVE_DIALOG_Z : OPAQUE_PORTAL_SURFACE_Z} ${OPAQUE_SURFACE_BASE} min-w-[min(184px,var(--radix-dropdown-menu-content-available-width))] max-w-[var(--radix-dropdown-menu-content-available-width)] overflow-hidden rounded-lg p-1`}
      >
        {children}
      </RadixMenu.SubContent>
    </RadixMenu.Portal>
  )
}

/** A muted heading over a run of items — what the menu is asking, when it opened without being clicked. */
export function MenuLabel({ children }: { children: ReactNode }) {
  return <RadixMenu.Label className="px-2.5 pb-1 pt-1.5 text-[11px] text-muted-55">{children}</RadixMenu.Label>
}

export function MenuSeparator() {
  return <RadixMenu.Separator className="my-1 h-px bg-border" />
}
