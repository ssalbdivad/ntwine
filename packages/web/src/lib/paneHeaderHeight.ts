// THE ONE HEIGHT EVERY PANE HEADER IS. The side-sheet bar (ui/SheetHeader), the thread header
// (ChatView, via threadHeaderLayout) and the "Thread unavailable" fallback all read this token, so every
// pane closes on the same bottom rule.
//
// It is a FIXED height, never a minimum: the thread header carried `min-h-12 py-1.5` and measured
// 52.75px beside the viewer's 48 (2026-09-03, maintainer: "headers should have consistent height"),
// because the AI-rename mark's 24px hover square (since removed) grew the title row past the 15px
// title's own line box, and the padding then pushed the stack
// past the minimum. A fixed bar centres whatever the row holds instead of growing with it.
export const PANE_HEADER_HEIGHT_CLASS = "h-12"
