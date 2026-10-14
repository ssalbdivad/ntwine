import { EMBED_PROBLEMS_PATH, type EmbedHostMessage } from "@ntwine/shared"
import { closeImageViewer, pushDrawer, showToast, store } from "../store.ts"
import { boardOrTimeout, composeInto, holdsBoardOf, openNamedThread, threadIsThere } from "./editorBridge.ts"
import { isTerminalPath } from "./composerContext.ts"
import { setEditorContext, setHostState, takePendingAdd } from "./editorContext.ts"
import { setEditorExtras, takeContextPicks } from "./editorReach.ts"
import { runHostCommand } from "./embedCommand.ts"
import { hostFocusGate } from "./hostFocusGate.ts"
import { finishStuckTransitions } from "./stuckTransitions.ts"
import { repostRoute } from "./embedRoute.ts"
import { closeSettingsAnimated } from "./overlays.ts"
import { EMBED_READY, embedded, hostKeyChord, parseHostMessage, postToHost } from "./embed.ts"
import { bindingLookup, effectiveBindings, matchAction } from "./keybindings.ts"
import { basename } from "./paths.ts"
import { homeHref, projectViewHref } from "./pageView.ts"
import { prefs } from "./prefs.ts"
import { spaNavigate } from "./router.ts"
import { setHostTheme } from "./theme.ts"

// THE PAGE'S SIDE OF THE SIDEBAR'S WIRE, live (lib/embed.ts holds the state and the pure checks;
// packages/shared/src/embed-protocol.ts the contract). Installed once, at boot, and only in embed mode:
//
//  - host → page: `ntwine:theme`, `ntwine:compose`, `ntwine:navigate`, `ntwine:editor-context` (lib/
//    editorContext.ts), `ntwine:command` (lib/embedCommand.ts), and `ntwine:editor-extras` and
//    `ntwine:context-picks` (lib/editorReach.ts), accepted only from `window.parent`
//    — the relay the extension's webview runs — and only in a shape the contract defines.
//  - page → host: `ntwine:ready` once the page can act on those, and `ntwine:key` for the chords the
//    page left alone. (`ntwine:open-file` and `ntwine:open-external` leave from the link handlers that
//    decide them, lib/local-file-links.ts and lib/external-links.ts; `ntwine:add-context` from the
//    context bar over the sidebar's composers, lib/editorContext.ts.)

export function initEmbedHost(): void {
  if (!embedded() || typeof window === "undefined") return
  document.documentElement.dataset.embed = "vscode"
  window.addEventListener("message", (event) => {
    // The parent, and nothing else: another frame or a popup could post the same shapes, and a compose
    // from one would put its text into the human's prompt box.
    if (event.source !== window.parent || window.parent === window) return
    const message = parseHostMessage(event.data)
    if (message) void handle(message)
  })
  // Heard in the CAPTURE phase, before any element can stop the keydown, and asked once it has been
  // everywhere it goes, so `defaultPrevented` says whether one of the page's own handlers took it.
  //
  // Capture, because stopping a key is not taking it: a question's answer box stops every key it sees
  // (QuestionBlockCard), so that its letters never reach the page's shortcuts — and a listener on the
  // window's bubble phase then never heard Ctrl+Shift+P, Ctrl+B or Ctrl+` typed there, while the options
  // grid and the prompt box forwarded them (sweep 2026-10-01). What ntwine handles itself still stays home:
  // ⌘K, ⌘I, ⌘, and Ctrl+Enter in a box are prevented by their handlers, and so is a chord the ? sheet is
  // recording.
  //
  // Asked after dispatch, because neither phase is late enough by itself: the shortcut runtime listens on
  // the window too (keyboardRuntime useShortcutListener), and a listener installed at boot runs before
  // it — so every chord ntwine binds went to VS Code as well as to ntwine (driven 2026-10-01,
  // build2-shell.md). The next task runs after dispatch has finished, and the event keeps its
  // `defaultPrevented` after it. A chord ntwine binds stays home even where nothing prevented it — the
  // answer box stops ⌘K before the shortcut runtime can hear it — since it is ntwine's, not VS Code's.
  window.addEventListener("keydown", (event) => {
    setTimeout(() => {
      const chord = hostKeyChord(event)
      if (chord && !ntwineChord(event)) postToHost(chord)
    }, 0)
  }, true)
  // ⌘L / Ctrl+L, the chord the context bar names, is Cursor's TOGGLE: from the editor it comes here (with a
  // selection, bringing it as a chip), and pressed here it goes back — forwarded like any VS Code chord
  // above, and run by the extension as "focus the editor" (packages/vscode embed.ts CHORDS). Until
  // 2026-10-02 the page took it to add the editor's selection again, which ⌘I does here (App.tsx
  // app.details), so a human who pressed ⌘L to get into the box had no chord to get back out.
  guardFocus()
  // A slide the frame was hidden in the middle of can stay pending for good, the drawer laid out a frame
  // to the right of where it is drawn, and every click on it missing (lib/stuckTransitions.ts).
  finishStuckTransitions()
  // Ready once a board is in — the page's drafts and its drawer are keyed by it, and the router that
  // navigation goes through is mounted by then — or after 5s regardless, for a machine with nothing open.
  // The extension posts nothing before this; a compose that still beats the board waits for it (composeInto).
  // The title row's reading (lib/embedRoute.ts) goes again right behind it: the page has drawn its view
  // by then, and said so to a host that may not have been listening yet.
  void boardOrTimeout().then(() => {
    postToHost(EMBED_READY)
    repostRoute()
  })
}

// The shortcut runtime's own reading of a key (lib/keyboardRuntime.ts), cached the same way: the overrides
// object is replaced whole on every change, so its identity says when the map is stale.
let cachedOverrides: unknown = null
let cachedLookup = bindingLookup(effectiveBindings({}))

function ntwineChord(event: KeyboardEvent): boolean {
  if (prefs.keybindings !== cachedOverrides) {
    cachedOverrides = prefs.keybindings
    cachedLookup = bindingLookup(effectiveBindings(prefs.keybindings))
  }
  return matchAction(event, cachedLookup) !== null
}

// ── focus: the keyboard is the editor's until the human (or the host) hands it over ──────────────────
//
// A frame inside VS Code is not a browser tab. In a tab, a script calling `focus()` while the human is in
// another window moves nothing; in a VS Code webview it takes the keyboard from the EDITOR. Driven in real
// VS Code 1.140 and 1.90 (scripts/e2e-sidebar.ts, 2026-10-01): with a thread open, every selection in the
// editor posted `ntwine:editor-context`, the context bar re-rendered inside the drawer, Radix's focus trap
// saw the frame's `activeElement` fall back to <body> (Chromium does that in a frame that has lost focus)
// and called `focus()` on the drawer — and 150-300ms after the selection the webview had the keyboard,
// even with the sidebar hidden. Ctrl+I then never reached the editor, and the next letters typed were the
// page's shortcuts: `d` marked the thread done. 6 runs of 6.
//
// So while the page does not have focus, a programmatic `focus()` is dropped — unless the host just asked
// for the page to take it (a compose with the caret, a title-row command, a navigation), when the relay
// focuses the frame first (packages/vscode/src/sidebar-html.ts) and the page's own focus lands after, and
// only until the human leaves the page again (lib/hostFocusGate.ts, which says why that matters). This
// guards every focus thief, the one found and the ones not written yet. The drawer's trap itself stays on
// in the sidebar, where a thread is modal (ui/Sheet.tsx useNarrowDrawer); a CLOSING drawer lets go of it
// (ThreadSheet.tsx).
//
// And the reverse: a frame that gets focus back (the human clicks the view's edge, VS Code re-focuses the
// view after a title-row button) comes back with nothing focused — Chromium does not restore an iframe's
// focused element the way it restores a window's. So the last element that had focus gets it again, unless
// the human is pressing somewhere in the page, whose click decides.

const hostFocus = hostFocusGate()
let lastFocused: HTMLElement | null = null
let pointerAt = 0

/** The host asked for the page to take the keyboard: a focus the page makes in the next moment is welcome. */
function allowHostFocus(): void {
  hostFocus.ask(Date.now(), typeof document !== "undefined" && document.hasFocus())
}

function guardFocus(): void {
  if (typeof HTMLElement === "undefined" || typeof document === "undefined") return
  const native = HTMLElement.prototype.focus
  HTMLElement.prototype.focus = function focus(this: HTMLElement, options?: FocusOptions) {
    if (!hostFocus.allows(Date.now(), document.hasFocus())) return
    native.call(this, options)
  }
  window.addEventListener("focus", () => hostFocus.focused(Date.now()))
  window.addEventListener("blur", () => hostFocus.blurred())
  document.addEventListener("focusin", (event) => {
    if (event.target instanceof HTMLElement && event.target !== document.body) lastFocused = event.target
  }, true)
  document.addEventListener("pointerdown", () => {
    pointerAt = Date.now()
  }, true)
  window.addEventListener("focus", () => setTimeout(() => {
    if (document.activeElement !== document.body || Date.now() - pointerAt < 300) return
    if (lastFocused?.isConnected) native.call(lastFocused, { preventScroll: true })
  }))
}

async function handle(message: EmbedHostMessage): Promise<void> {
  if (message.type === "ntwine:command" || message.type === "ntwine:navigate" || (message.type === "ntwine:compose" && message.focus)) allowHostFocus()
  if (message.type === "ntwine:theme") {
    const { colors, surface, contrast } = message
    setHostTheme(message.theme, colors ? { colors, ...(surface ? { surface } : {}), ...(contrast ? { contrast } : {}) } : undefined)
    return
  }
  if (message.type === "ntwine:editor-context") {
    setEditorContext(message)
    return
  }
  if (message.type === "ntwine:host-state") {
    setHostState(message)
    return
  }
  if (message.type === "ntwine:editor-extras") {
    setEditorExtras(message)
    return
  }
  if (message.type === "ntwine:context-picks") {
    takeContextPicks(message)
    return
  }
  if (message.type === "ntwine:command") {
    runHostCommand(message.command)
    return
  }
  if (message.type === "ntwine:navigate") {
    // Whatever is over the page goes: the human asked to see a thread or a queue, not Settings — closed
    // by its own close, which sends a change still in its debounce. The picture viewer too, which sits
    // over every drawer: left up, it covered the queue it was sent back to, and the thread it was sent to.
    if (store.showSettings && !closeSettingsAnimated()) store.showSettings = false
    store.showPalette = false
    store.showShortcuts = false
    store.showNewThread = false
    closeImageViewer()
    const { to } = message
    if (to === "queue") spaNavigate(homeHref())
    else if ("thread" in to) {
      // Opened the way the page opens its own threads (openNamedThread). One its project lacks is not
      // navigated to, which would reload the frame (threadIsThere): on this page's own board it opens
      // the drawer that says so, as a link to it does; another project's is a toast.
      if (await threadIsThere(to.thread, to.project)) openNamedThread(to.thread, to.project, "open")
      else if (holdsBoardOf(to.project)) pushDrawer("thread", to.thread)
      else showToast("That thread isn't in ntwine.")
    }
    else spaNavigate(projectViewHref(to.project))
    return
  }
  // The host answers a context bar's click with a compose aimed at "front"; it goes back to the box whose
  // bar was clicked (lib/editorContext.ts requestEditorContext). Any other compose keeps its own target.
  const box = message.target === "front" ? takePendingAdd() : null
  let outcome: Awaited<ReturnType<typeof composeInto>>
  try {
    outcome = await composeInto(message.item, { target: box ? { box } : message.target, focus: message.focus, ...(message.note ? { note: message.note } : {}) })
  } catch (error) {
    outcome = { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  const what = isTerminalPath(message.item.path) ? "the terminal output" : message.item.path === EMBED_PROBLEMS_PATH ? "the problems" : basename(message.item.path)
  postToHost(
    outcome.ok
      ? { type: "ntwine:composed", id: message.id, ok: true }
      : { type: "ntwine:composed", id: message.id, ok: false, error: `Couldn't add ${what} to ntwine's prompt box. ${outcome.reason}` },
  )
}
