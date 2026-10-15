/**
 * Is this click one the SPA should handle itself? An in-app link is a real `<a href>` so the browser
 * owns every "open elsewhere" gesture — ⌘/Ctrl-click, middle-click, shift-click, right-click → Open in
 * new tab — and only an unmodified primary click is intercepted to navigate in place (maintainer
 * 2026-08-28: "if you click it normally, it just happens in the same tab; right-click or command-click
 * opens a new tab").
 */
export function isPlainLeftClick(event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented: boolean }): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.defaultPrevented
}
