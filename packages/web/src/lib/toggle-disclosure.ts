import { recordDisclosureToggle } from "./disclosure.ts"

// One delegated listener for every `<details>` in every sanitized markdown surface, for the reason
// lib/switch-code-tab.ts is delegated: the section is injected as an HTML string (lib/markdown.ts), so
// there is no React element to hang a handler on, and the transcript rebuilds those nodes as it
// re-renders.
//
// The browser does the toggling. This only RECORDS it (lib/disclosure.ts), which is what the next render
// of the same summary opens or closes on, so nothing here moves the DOM and nothing re-renders.
//
// `toggle`, not `click`: it is the one event that fires however the section changed — a click, Enter or
// Space on the focused summary, and the browser opening a closed section itself to show a find-in-page
// match. CAPTURE phase because `toggle` does not bubble; a listener on the document sees it only on the
// way down.
export function installDisclosureInterceptor(): () => void {
  const toggle = (event: Event) => {
    if (event.target instanceof HTMLDetailsElement) recordDisclosureToggle(event.target)
  }
  document.addEventListener("toggle", toggle, true)
  return () => document.removeEventListener("toggle", toggle, true)
}
