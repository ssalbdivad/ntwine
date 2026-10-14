import { useSyncExternalStore } from "react"

// A LENS — All projects narrowed to a SET of projects (plans/all-projects-first.md § Dock and lenses), made
// by shift-clicking squares in the dock. A lens of one is the first pick of a bigger one (a plain click is
// that project's own page, `/project/<slug>`), so it holds too. It is kept for this tab only
// (components/ProjectDock.tsx): a drawer's address carries no query, so a lens in the URL was dropped by every thread opened under it. A lens the human wants back
// tomorrow is SAVED, by name, per browser.

const LENS_KEY = "ntwine.lens"
const SAVED_KEY = "ntwine.savedLenses"

export interface SavedLens {
  name: string
  ids: string[]
}

function readSession(): string[] | null {
  try {
    const raw = sessionStorage.getItem(LENS_KEY)
    const ids = raw ? (JSON.parse(raw) as unknown) : null
    return Array.isArray(ids) && ids.length > 0 ? ids.filter((id): id is string => typeof id === "string") : null
  } catch {
    return null
  }
}

function readSaved(): SavedLens[] {
  try {
    const raw = localStorage.getItem(SAVED_KEY)
    const list = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(list) ? list.filter((lens): lens is SavedLens => typeof lens?.name === "string" && Array.isArray(lens?.ids)) : []
  } catch {
    return []
  }
}

let lens: ReadonlySet<string> | null = (() => {
  const ids = readSession()
  return ids ? new Set(ids) : null
})()
let saved: readonly SavedLens[] = readSaved()
const listeners = new Set<() => void>()
const notify = () => {
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Narrow All projects to these projects, or (null, or none) widen it back to every project. */
export function setLens(ids: Iterable<string> | null): void {
  const next = ids ? [...new Set(ids)] : []
  lens = next.length > 0 ? new Set(next) : null
  try {
    if (lens) sessionStorage.setItem(LENS_KEY, JSON.stringify([...lens]))
    else sessionStorage.removeItem(LENS_KEY)
  } catch {
    // Storage disabled: the lens still holds for this page.
  }
  notify()
}

/** The projects All projects is narrowed to, by id, or null for every project. */
export function useLens(): ReadonlySet<string> | null {
  return useSyncExternalStore(subscribe, () => lens, () => null)
}

/** The lens as of now, for a handler. */
export function currentLens(): ReadonlySet<string> | null {
  return lens
}

function writeSaved(next: readonly SavedLens[]): void {
  saved = next
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(next))
  } catch {
    // Storage disabled: kept for this page only.
  }
  notify()
}

/** Save a lens under a name, replacing one of the same name. */
export function saveLens(name: string, ids: Iterable<string>): void {
  const trimmed = name.trim()
  if (!trimmed) return
  writeSaved([...saved.filter((entry) => entry.name !== trimmed), { name: trimmed, ids: [...new Set(ids)] }])
}

export function deleteLens(name: string): void {
  writeSaved(saved.filter((entry) => entry.name !== name))
}

export function useSavedLenses(): readonly SavedLens[] {
  return useSyncExternalStore(subscribe, () => saved, () => saved)
}

/** The saved lens the current one is, if any: the same projects, whatever order they were picked in. */
export function savedNameOf(current: ReadonlySet<string> | null, list: readonly SavedLens[]): string | undefined {
  if (!current) return undefined
  return list.find((entry) => entry.ids.length === current.size && entry.ids.every((id) => current.has(id)))?.name
}
