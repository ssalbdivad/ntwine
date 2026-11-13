import { store, topRoutedSlug } from "../store.ts"
import { appPushedCurrentEntry } from "./router.ts"

// FOCUS MODE: one thread and nothing else. The thread's own drawer grows to fill the window — the board,
// the list and the scrim are all behind it — until the reader leaves by its ⤡, Escape, or Back.
//
// It is the drawer, not a page of its own. The fullscreen page this replaces (`StandaloneThreadPage`, a
// separate route outside the layout with its own rail and file viewer) was removed on 2026-10-15
// (maintainer: "the fullscreen view sucks"), and asked back on 2026-11-12 as "the full-focus mode for a
// single thread where it is all you see until you exit/nav back". Keeping it the drawer means nothing
// remounts on the way in or out — the transcript keeps its scroll, the prompt box its draft — and the
// layers a thread opens (a sub-agent, a file) still stack over it as they do over any drawer.
//
// The address is the drawer's plus `/full` (lib/router.ts), the same address the old page had, so its
// bookmarks work again. Entering PUSHES that address, so Back leaves focus mode for the drawer.

// The thread this tab entered focus on by its own push — so its exit can POP back to the drawer's entry
// rather than replace `/full` and leave the drawer's address twice in the history.
let pushedFor: string | null = null

export function enterFocus(slug: string): void {
  if (topRoutedSlug() !== slug) return
  pushedFor = slug
  store.focusSlug = slug
}

export function exitFocus(): void {
  const slug = store.focusSlug
  if (slug === null) return
  const popToDrawer = pushedFor === slug && appPushedCurrentEntry() && typeof history !== "undefined"
  pushedFor = null
  if (popToDrawer) history.back()
  // A cold `/full` link (or one reached some other way) has no drawer entry of ours beneath it: the
  // store→URL writer REPLACES the address with the drawer's.
  else store.focusSlug = null
}
