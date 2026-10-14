import { useSyncExternalStore } from "react"
import type { ProjectCard } from "@ntwine/shared"

// A MONOGRAM IS UNIQUE ACROSS THE PROJECTS, not just derived from one name. Each project's two letters
// came from its own name alone until 2026-10-14, so `local` and `look4` were both LO — and the dock,
// where a square is the only thing naming its project, drew two squares nobody could tell apart. The
// hue is per-id and differs, but two dim tiles a few degrees apart are not a distinction.
//
// So the letters are assigned over the whole set: a project whose own monogram is unique keeps it, and
// the members of a collision take, in id order, the first candidate no other project holds — its first
// letter beside each later letter of its name in turn (LO, LC, LA… for `local`; LO, LK, L4 for
// `look4`). Id order, because ids never change: a rename or a reorder does not reshuffle anyone else's
// letters, and every machine sharing the registry draws the same ones.

/**
 * One or two letters, from word boundaries rather than the first two characters.
 *
 * `standard-schema` reads as SS and `fray` as F. Two letters is the ceiling: three stops being a
 * monogram and starts being unreadable text at 40px.
 */
export function monogram(name: string): string {
  const words = name.split(/[\s\-_./]+/u).filter(Boolean)
  if (words.length === 0) return "?"
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase()
  return (words[0]![0]! + words[1]![0]!).toUpperCase()
}

/** A name's monogram, then its first letter beside each later letter or digit, without repeats. */
function candidates(name: string): string[] {
  const chars = [...name.toUpperCase().replace(/[^\p{L}\p{N}]/gu, "")]
  const out = new Set([monogram(name)])
  for (const later of chars.slice(1)) out.add(chars[0]! + later)
  return [...out]
}

/** Every project's monogram, unique across the set wherever its name allows. */
export function distinctMonograms(projects: readonly { id: string; name: string }[]): Map<string, string> {
  const byOwn = new Map<string, { id: string; name: string }[]>()
  for (const project of projects) {
    const own = monogram(project.name)
    byOwn.set(own, [...(byOwn.get(own) ?? []), project])
  }
  const assigned = new Map<string, string>()
  // Every project's own monogram is reserved first, so resolving one collision never makes another.
  const taken = new Set(byOwn.keys())
  for (const [own, group] of byOwn) {
    if (group.length === 1) {
      assigned.set(group[0]!.id, own)
      continue
    }
    const [first, ...rest] = [...group].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    assigned.set(first!.id, own)
    for (const project of rest) {
      // Identical names have nothing left to tell them apart by: they keep their own, and the hue differs.
      const free = candidates(project.name).find((candidate) => !taken.has(candidate)) ?? own
      taken.add(free)
      assigned.set(project.id, free)
    }
  }
  return assigned
}

// The set, fed from the app's one projects read (main.tsx), so every square anywhere draws the same letters.
let current = new Map<string, string>()
const listeners = new Set<() => void>()

export function setProjectMonograms(cards: readonly ProjectCard[] | undefined): void {
  current = distinctMonograms((cards ?? []).filter((card) => !card.home))
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** A project's letters: its assigned ones once the set is known, its own until then. */
export function useMonogram(project: { id: string; name: string }): string {
  const assigned = useSyncExternalStore(subscribe, () => current.get(project.id), () => undefined)
  return assigned ?? monogram(project.name)
}
