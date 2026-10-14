// Headless Chrome has no pointing device, so it answers `(hover: none)` and `(pointer: none)`: every
// headless shot is a TOUCH screen. That matters twice over here. Tailwind v4 gates every `hover:` / `group-hover:` style on
// `(hover: hover)`, so parking the pointer with page.hover() fires the events and paints none of the hover
// styles — a "hover" shot of a pill came back identical to its resting state (2026-09-28). And this app's
// touch rules key on `(hover: none)` (a board's ⋯ menu in BoardIdentity.tsx, the code-block copy button), so a desktop
// shot shows controls a desktop hides until hover.
//
// These Blink settings make the page a desktop with a mouse: hover-capable, fine pointer (Blink's
// HoverType HOVER = 2, PointerType FINE = 4). Launch-time only — a browser you CONNECT to keeps its own.
// Pass `launchHeadless({ mouse: true })` (lib/headless-browser.mjs), which joins these with the colour
// scheme into ONE `--blink-settings`: Chrome keeps only the last of a repeated switch.
export const MOUSE_POINTER_SETTINGS = "primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4"
