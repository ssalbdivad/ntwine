import { Check, Shield, ShieldOff } from "lucide-react"
import type { PermissionMode } from "@ntwine/shared"
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "./ui/Menu.tsx"
import { CLAUDE_DISPATCH_PERMISSION_OPTIONS } from "../lib/options.ts"

/** A Claude thread's Auto/Bypass choice as a glyph in the composer's rail, beside the Goal. It was a
 *  labelled pill beside the model picker until 2026-10-14, which gave a control that is almost never
 *  changed the same weight as the one that is (maintainer: "seems kind of prominent for something that
 *  is almost never used"). The shield is crossed out under bypass, so the mode still reads at a glance. */
export function ThreadPermissionControl({ value, onChange, title, disabled }: {
  value: PermissionMode
  onChange: (next: PermissionMode) => void
  title: string
  disabled?: boolean
}) {
  const Glyph = value === "bypassPermissions" ? ShieldOff : Shield
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          data-thread-permission={value}
          aria-label={`Permissions: ${value === "bypassPermissions" ? "bypass" : "auto"}`}
          title={title}
          disabled={disabled}
          // The Goal's and paperclip's own square, hover fill and tone, so the rail reads as one family.
          className="icon-hover-outline flex h-7 w-7 items-center justify-center rounded-lg text-muted outline-none transition-[color,background-color] hover:bg-panel-2/70 hover:text-fg disabled:opacity-50 disabled:hover:bg-transparent"
        >
          <Glyph size={15} strokeWidth={2} aria-hidden />
        </button>
      </MenuTrigger>
      <MenuContent align="end">
        <MenuLabel>Permissions</MenuLabel>
        {CLAUDE_DISPATCH_PERMISSION_OPTIONS.map((o) => (
          <MenuItem
            key={o.value}
            value={o.value}
            onSelect={() => onChange(o.value as PermissionMode)}
            icon={o.value === value ? <Check size={13} aria-hidden /> : <span />}
          >
            <span title={o.title}>{o.label}</span>
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  )
}
