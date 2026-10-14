// The opaque overlay surface WITHOUT a z-index. Portal menus/popovers must be an opaque layer from
// their first painted frame — the older `pop-in` animation starts at opacity: 0, which makes a
// just-opened menu look transparent over the sidebar/composer. This base owns everything BUT the
// stacking level, so a caller applies EXACTLY ONE z utility on top (never two conflicting z-* classes
// on one element — Tailwind resolves same-property collisions by CSS source order, not class order,
// so stacking z-[110] and z-[250] would be a coin-flip). Motion-free (no pop-in) by contract.
export const OPAQUE_SURFACE_BASE =
  "isolate bg-elevated opacity-100 border border-border shadow-2xl shadow-overlay-shadow"

// THE STACKING ORDER, low → high. The sidebar/board rail deliberately has NO z-index (default
// stacking): it and the workpane are side-by-side columns that never overlap, and its old desktop
// z-[100] is what forced every overlay to escalate past it — the recurring "hidden underneath the
// prompt box" bug. Anything below is an OVERLAY and therefore already outranks the rail:
//   z-20  fixed corner chrome · 50 + 2·depth the drawer stack (a layer's scrim; a thread's panel one above)
//   aboveDrawersZ(n) the New thread dialog and the ⌘K palette · z-[70] toasts
//   z-[110] portaled selector surfaces · z-[200] shared Dialog · z-[250] anchored popovers/tooltips
//   z-[260] a selector opened from INSIDE a popover · z-[300] restart scrim (alone must cover the whole app)
// Never re-elevate a persistent layer to "win" a collision — raise the specific overlay instead.

// THE TIER JUST ABOVE THE DRAWER STACK, for a modal that can be opened over an open drawer: the New thread
// dialog (`c`, the palette's New thread, an editor's New thread button) and the ⌘K palette. Drawers climb
// two steps a layer (DrawerStack: a layer at depth d paints its scrim at 50 + 2d and a thread's panel at
// 51 + 2d), so a fixed z loses to a deep enough stack: the dialog sat at z-50 and the palette at z-[60], and
// with a thread open the dialog painted UNDER it — invisible in an editor's sidebar while its textarea held
// focus, so typing went into a box nobody could see (2026-10-01). One step above the top layer instead: the
// returned z is the scrim's and the next one up the panel's.
//
// Never the shared z-[200] tier, which looks like the obvious fix: the pickers these surfaces open (the
// model/effort grid, every menu) are z-[110] portals and would land beneath them, and toasts (z-[70]) would
// vanish behind the scrim. So the tier is capped below toasts — reached only past nine open drawers, where a
// dialog under the tenth beats a toast nobody can read.
export function aboveDrawersZ(drawerCount: number): number {
  return Math.min(52 + 2 * Math.max(0, drawerCount), TOAST_Z - 2)
}

// Toasts (Toaster.tsx `z-[70]`): above every modal that opens over a drawer, below the selector surfaces.
export const TOAST_Z = 70

// The selector-surface contract for Select, DropdownMenu, and the profile grid: the opaque base at
// z-[110]. Portal content mounts at document.body, so it must clear the modal surfaces it can be
// opened from (a selector inside a z-50 dialog) rather than paint beneath them.
export const OPAQUE_PORTAL_SURFACE_Z = "z-[110]"
export const OPAQUE_PORTAL_SURFACE_CLASS = `${OPAQUE_PORTAL_SURFACE_Z} ${OPAQUE_SURFACE_BASE}`

// The stacking level a selector must take when it is opened from INSIDE the shared z-[200] surface
// (a Dialog). Its portal still mounts at document.body, so the default z-[110]
// would paint the menu BENEATH that overlay's frosted backdrop — the classic "hidden underneath"
// bug. This is the raise-the-specific-overlay fix, not a re-elevation of the z-[110] tier itself:
// it borrows the anchored-overlay level, which is defined to clear z-[200].
export const OPAQUE_PORTAL_SURFACE_ABOVE_DIALOG_Z = "z-[250]"

// The stacking level a selector takes when it is opened from INSIDE an anchored popover (the model
// picker's agent-settings panel carries three Selects). Its portal still mounts at document.body, so
// at the popover's own z-[250] it would resolve by source order against the panel it was opened from
// — a coin flip that lands the menu beneath its own trigger. One step above, and still below the
// restart scrim.
export const OPAQUE_PORTAL_SURFACE_ABOVE_POPOVER_Z = "z-[260]"

// The z-index for ANCHORED transient overlays that pop off a trigger — tooltips and popovers. They
// must clear every surface they can be opened from: the opaque selector surface (z-[110]) and the
// modal Dialog (z-[200], so a popover opened from inside a dialog still shows). It sits just below
// the restart scrim (z-[300]). This is also the fix for the quota popover that used to render at
// z-50 and got clipped away "underneath the prompt box".
export const OVERLAY_Z_CLASS = "z-[250]"
