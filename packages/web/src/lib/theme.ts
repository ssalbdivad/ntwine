import { EMBED_THEME_COLORS } from "@ntwine/shared"
import { embedPalette, embedTheme, rememberEmbedTheme, type HostPalette } from "./embed.ts"
import { derivedTokens } from "./hostPalette.ts"

export type ThemePreference = "system" | "light" | "dark"
export type ResolvedTheme = "light" | "dark"

export interface ThemeSnapshot {
  preference: ThemePreference
  resolved: ResolvedTheme
}

export const THEME_STORAGE_KEY = "ntwine-theme"

const DARK_CANVAS = "#0d0e10"
const LIGHT_CANVAS = "#f7f7f7"
const listeners = new Set<() => void>()
let snapshot: ThemeSnapshot = { preference: "system", resolved: "dark" }
let media: MediaQueryList | undefined
let dispose: (() => void) | undefined
// THE EDITOR'S THEME, while this page is framed by one (lib/embed.ts): VS Code says light or dark, by the
// frame's query at boot and by `ntwine:theme` whenever its own theme changes, and that wins over the
// stored preference and the OS for this session. It is never written to `ntwine-theme` — the preference
// stays what the human chose, and the Settings control still shows that choice; only the RESOLVED theme
// follows the editor. index.html's guard reads the same override before first paint.
let hostTheme: ResolvedTheme | undefined
// …and its COLOURS, while the editor sends them (`ntwine.matchEditorTheme`, on by default): each one set on
// the root as the custom property VS Code itself names it (`--vscode-sideBar-background`), and the root
// marked `data-host-colors="<surface>"`, which is what theme.css § The editor's colours keys on to map them
// onto ntwine's own tokens. Values arrive checked (embed.ts parsePalette), so a property is never anything
// but a colour. Cleared when a theme message comes without them: the setting turned off.

// Three tokens hang on a contrast no theme promises (lib/hostPalette.ts says which and why): those are
// computed here, as `--host-<token>`, which theme.css prefers to its own fixed mix.
let paletteApplied = false

function applyPalette(palette: HostPalette | undefined, theme: ResolvedTheme): void {
  // A page that never wore one (every browser tab) has nothing to clear and is never touched.
  if (!palette && !paletteApplied) return
  paletteApplied = palette !== undefined
  const root = document.documentElement
  for (const name of EMBED_THEME_COLORS) {
    const value = palette?.colors[name]
    if (value) root.style.setProperty(`--vscode-${name}`, value)
    else root.style.removeProperty(`--vscode-${name}`)
  }
  const derived = palette ? derivedTokens(palette.colors, palette.surface ?? "sideBar", theme) : null
  for (const token of ["muted", "faint", "accent"] as const) {
    const value = derived?.[token]
    if (value) root.style.setProperty(`--host-${token}`, value)
    else root.style.removeProperty(`--host-${token}`)
  }
  if (palette) root.dataset.hostColors = palette.surface ?? "sideBar"
  else delete root.dataset.hostColors
  if (palette?.contrast) root.dataset.hostContrast = ""
  else delete root.dataset.hostContrast
}

export function parseThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" || value === "system" ? value : "system"
}

export function resolveTheme(preference: ThemePreference, dark = systemPrefersDark()): ResolvedTheme {
  return preference === "system" ? (dark ? "dark" : "light") : preference
}

function systemPrefersDark(): boolean {
  try { return media?.matches ?? window.matchMedia("(prefers-color-scheme: dark)").matches } catch { return false }
}

function storedPreference(): ThemePreference {
  try {
    return parseThemePreference(localStorage.getItem(THEME_STORAGE_KEY))
  } catch {
    return "system"
  }
}

function apply(next: ThemeSnapshot) {
  const root = document.documentElement
  root.dataset.theme = next.resolved
  root.style.colorScheme = next.resolved
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", next.resolved === "dark" ? DARK_CANVAS : LIGHT_CANVAS)
}

function publish(preference: ThemePreference, dark = systemPrefersDark()) {
  const next = { preference, resolved: hostTheme ?? resolveTheme(preference, dark) }
  const changed = next.preference !== snapshot.preference || next.resolved !== snapshot.resolved
  if (changed) snapshot = next
  apply(next)
  if (changed) for (const listener of listeners) listener()
}

export function getThemeSnapshot(): ThemeSnapshot {
  return snapshot
}

export function setThemePreference(preference: ThemePreference) {
  publish(parseThemePreference(preference))
  try {
    localStorage.setItem(THEME_STORAGE_KEY, snapshot.preference)
  } catch {
    // A private or quota-limited browser still retains the selected theme for this document.
  }
}

/**
 * The editor framing this page changed its theme (lib/embedHost.ts): apply it, for this session only —
 * its kind, and its colours when it sent them (none: ntwine's own palette).
 */
export function setHostTheme(theme: ResolvedTheme, palette?: HostPalette): void {
  hostTheme = theme
  rememberEmbedTheme(theme, palette)
  applyPalette(palette, theme)
  publish(snapshot.preference)
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function initTheme() {
  if (dispose || typeof window === "undefined") return dispose
  try { media = window.matchMedia("(prefers-color-scheme: dark)") } catch { media = undefined }
  hostTheme = embedTheme()
  applyPalette(embedPalette(), hostTheme ?? resolveTheme(storedPreference()))
  publish(storedPreference())
  const mediaChange = (event: MediaQueryListEvent) => { if (snapshot.preference === "system") publish("system", event.matches) }
  media?.addEventListener("change", mediaChange)
  const storageChange = (event: StorageEvent) => {
    try { if (event.storageArea && event.storageArea !== localStorage) return } catch { return }
    if (event.key === THEME_STORAGE_KEY) publish(parseThemePreference(event.newValue))
    else if (event.key === null) publish("system")
  }
  window.addEventListener("storage", storageChange)
  dispose = () => {
    media?.removeEventListener("change", mediaChange)
    window.removeEventListener("storage", storageChange)
    dispose = undefined
    media = undefined
  }
  import.meta.hot?.dispose(dispose)
  return dispose
}
