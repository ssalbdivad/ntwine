import type { EmbedCommandMessage } from "@ntwine/shared"
import { closeDrawersById, closeImageViewer, store } from "../store.ts"
import { innerPath } from "./base-path.ts"
import { openDispatch } from "./newThreadDoor.ts"
import { closeSettingsAnimated } from "./overlays.ts"
import { homeHref } from "./pageView.ts"
import { spaNavigate } from "./router.ts"
import { parseStandaloneThreadPath } from "./standaloneThreadRoute.ts"

// THE TITLE ROW'S BUTTONS — VS Code's own row above the sidebar's frame carries what an ntwine header would
// (ARCHITECTURE.md § VS Code extension), and each button arrives here as a
// `ntwine:command`. Each is the app's own door, called rather than re-implemented, so a button and the key
// or menu item it stands for cannot drift:
//
//   new-thread  `c`'s door (lib/newThreadDoor.ts): the caret in the page's prompt box, or, over an open
//               thread, the new-thread dialog over it.
//   queue       the palette's Queue: every drawer closed, back to the page under them.
//   jump        ⌘K: the palette.
//   settings    ⌘,: Settings.
//   shortcuts   `?`: the keyboard shortcuts sheet, from the row's ⋯ — the status row's ⌨ button is not
//               drawn in the sidebar (StatusRow.tsx).
//   prompt      Ctrl+L / ⌘L in the editor with nothing selected (Cursor's chord to its chat): the caret into
//               the prompt box in front — the New thread dialog's while it is up, else the open thread's
//               reply box, else the page's new-thread box — at the end of what is there, where the human
//               left off. Not a door that opens anything: with a thread open the reply box is the one meant.
//
// A button is pressed in VS Code, not in the frame, so whatever transient layer the page had up (the
// palette, the shortcuts sheet, the picture viewer, a dialog) goes first, as a click outside it would
// have closed it.
//
// ON A THREAD'S /full PAGE the frame has no page under it to go back to: its route is outside the page's,
// with no drawers to close and no prompt box. A frame lands there from a routed address naming a thread
// that has since gone (store.ts resolveRoutedThread) and from that page's locator, and its title row
// offers Back to queue like any thread's — which did nothing (sweep 2026-10-01). There Back goes home, as
// a navigate to the queue does, and New thread goes home and then opens the door.

export function runHostCommand(command: EmbedCommandMessage["command"]): void {
  store.showShortcuts = false
  closeImageViewer()
  if (command === "jump") {
    store.showPalette = true
    return
  }
  store.showPalette = false
  if (command === "settings") {
    store.showSettings = true
    return
  }
  // The rest are about the page under Settings, so Settings goes too — by its own close, which sends a
  // change still waiting in its debounce rather than dropping it with the drawer.
  if (store.showSettings && !closeSettingsAnimated()) store.showSettings = false
  // The sheet over the page as it is, an open thread included — where `?` opens it in a browser, which
  // waits for Settings to close first (keyboardRuntime.ts overlayOpen).
  if (command === "shortcuts") {
    store.showShortcuts = true
    return
  }
  if (command === "prompt") {
    focusFrontPrompt()
    return
  }
  const fullPage = parseStandaloneThreadPath(innerPath()) !== null
  if (command === "queue") {
    store.showNewThread = false
    if (fullPage) spaNavigate(homeHref())
    else closeDrawersById(store.drawers.map((drawer) => drawer.id))
    return
  }
  if (!fullPage) {
    openDispatch()
    return
  }
  spaNavigate(homeHref())
  void untilPagePromptBox().then(openDispatch)
}

/** The page's own prompt box, once the page is up after leaving /full — or 3s, after which the door opens the dialog. */
function untilPagePromptBox(): Promise<void> {
  const deadline = Date.now() + 3_000
  return new Promise((resolve) => {
    const check = () => {
      const box = [...document.querySelectorAll("[data-dispatch-form]")].some((form) => !form.closest('[role="dialog"]'))
      if (box || Date.now() > deadline) resolve()
      else window.setTimeout(check, 30)
    }
    check()
  })
}

const DIALOG_BOX = '[role="dialog"]:not([data-drawer-layer]) textarea[data-surface="newComposer"]'
const REPLY_BOX = 'textarea[data-surface="chatComposer"]'
const PAGE_BOX = 'textarea[data-surface="newComposer"]'

/**
 * The caret into the prompt box in front, after what it holds. A box with no rendered box (behind a
 * closing drawer, unmounted) is not in front of anyone. With a thread open whose drawer has no reply box,
 * and on a /full page with none, `c`'s door opens the new-thread box instead — the chord always ends in a
 * prompt box.
 */
export function focusFrontPrompt(): void {
  const shown = (selector: string) => [...document.querySelectorAll<HTMLTextAreaElement>(selector)].filter((box) => box.getClientRects().length > 0)
  const drawer = store.drawers.some((each) => !each.closing)
  const box = store.showNewThread ? shown(DIALOG_BOX)[0] : drawer ? shown(REPLY_BOX).at(-1) : shown(PAGE_BOX).find((each) => !each.closest('[role="dialog"]'))
  if (!box) {
    openDispatch()
    return
  }
  box.focus()
  box.setSelectionRange(box.value.length, box.value.length)
}
