// Keep application text sans-serif, including during a Vite stylesheet replacement.
// Code and terminal surfaces declare their own monospace family.
export function initFont() {
  document.documentElement.dataset.font = "sans"
  document.body.style.fontFamily =
    'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
  try {
    localStorage.removeItem("ntwine-font")
  } catch {
    // Typography does not depend on browser storage.
  }
}
