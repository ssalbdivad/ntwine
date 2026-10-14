import { useEffect, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router"
import { useSnapshot } from "valtio"
import { useQuery } from "@tanstack/react-query"
import { store, seedBoard, pushDrawer, resolveRoutedThread, topDrawer, topThreadSlug, showToast } from "./store.ts"
import { embedded, hostTerminalHint } from "./lib/embed.ts"
import { addEditorContextByKey } from "./lib/editorContext.ts"
import { detectPlatform } from "./lib/keybindings.ts"
import { openDispatch } from "./lib/newThreadDoor.ts"
import { useBoard } from "./hooks.ts"
import { closeDrawerAnimated } from "./lib/overlays.ts"
import { useShortcut } from "./lib/keyboardRuntime.ts"
import { clampPinnedPage, pageScrollY, pinPageAt } from "./lib/pageScrollLock.ts"
import { startRouter } from "./lib/router.ts"
import { projectSlug } from "./lib/base-path.ts"
import { AllQueuesPage } from "./components/AllQueues.tsx"
import { rpc } from "./api/rpc.ts"
import { useCrossProjectNotifications } from "./lib/crossProjectNotify.ts"
import { DrawerStack } from "./components/DrawerStack.tsx"
import { PendingThreadSheet } from "./components/PendingThreadSheet.tsx"
import { NewThreadDialog } from "./components/NewThreadModal.tsx"
import { useGithubStatus } from "./hooks/useGithubStatus.ts"
import { SettingsDrawer } from "./components/SettingsDrawer.tsx"
import { RunningTimeLimitHost } from "./components/RunningTimeLimitDialog.tsx"
import { CommandPalette } from "./components/CommandPalette.tsx"
import { ErrorBoundary } from "./components/ErrorBoundary.tsx"
import { RestartOverlay } from "./components/RestartOverlay.tsx"
import { useSupervisorStatus } from "./api/supervisorStatus.ts"
import {
  ntwineBuildIdentity,
  IDLE_RESTART_HOLD,
  nextControlPlane,
  nextRestartHold,
  readyBelieved,
  RELOAD_AFTER_UPDATE_RESTART,
  restartFailureCopy,
  restartFailureOutcome,
  shouldReloadForNewBuild,
  UPDATE_RESTART_FROM_VERSION,
  type RestartHold,
} from "./api/restart.ts"
import { formatCompactElapsed } from "./lib/durationLabels.ts"

// The not-signed-in hint fires at most once per page load. A module-scoped flag (not React state)
// keeps it from re-firing across re-renders, effect re-runs, or a StrictMode double-invoke. In an
// editor's sidebar it says where a terminal is: VS Code's, one chord away (lib/embed.ts).
let signInHintShown = false
let clientZoneReported = false
function reportClientZoneOnce() {
  if (clientZoneReported) return
  clientZoneReported = true
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (tz) rpc.reportClientZone({ tz }).catch(() => {})
}
function maybeShowSignInHint() {
  if (signInHintShown) return
  signInHintShown = true
  showToast("Sign in to the GitHub CLI (`gh auth login`) so threads can read and watch issues and PRs.", {
    duration: 6000,
    ...(embedded() ? { detail: hostTerminalHint(detectPlatform() === "mac") } : {}),
  })
}

/**
 * THE SHELL AROUND THE ONE PAGE (AllQueues.tsx), focused on one project or showing All projects
 * (lib/pageView.ts). It hosts the standing surfaces the page does not draw itself — the drawer stack, the
 * modals, the palette, the restart overlay, the keyboard, the router sync and the board seed — and all of
 * them are the PAGE PROJECT's (routes.tsx CrossProjectPage: the focused project, All projects' pick, or a
 * drawer's project), which is what lets a thread of any project open in place with the whole drawer stack.
 * A project's own board shared this shell until 2026-09-28, when it went with the project view.
 */
export function App() {
  const snap = useSnapshot(store)
  // The page project. The shell is not keyed by it (the page must survive a focus change), so anything
  // that has to follow the project names it.
  const pageSlug = projectSlug(useLocation().pathname)

  // Seed the board once at startup so the first paint doesn't wait on the SSE connect; SSE keeps it
  // fresh afterward. seedBoard (not setBoard) so a late-resolving seed can't clobber a board the SSE
  // stream has already established + advanced with deltas. Per page project: a focus change on the
  // cross-project page resets the store (routes.tsx useProjectBinding) and wants the new board as fast.
  useEffect(() => {
    rpc.board().then(seedBoard).catch(() => {})
  }, [pageSlug])

  // THE HUMAN'S TIME ZONE, once per page load (ARCHITECTURE.md § Scheduled threads). A server under WSL or in a
  // container often runs in UTC while the human does not, and "every Monday at 9am" means THEIR 9am: the
  // latest zone a browser reported is the default for every new schedule. Machine-scoped, so the page
  // project's client is as good as any. Best-effort — a server that predates it, or a failed write, leaves
  // schedules on the zone the server already knows.
  useEffect(() => {
    reportClientZoneOnce()
  }, [])

  // STORE → URL (opening a drawer writes the address bar). The other direction is the route tree's —
  // see routes.tsx useRouteToStore. Navigation goes through the router so its history stack and its
  // rendered match stay the same thing.
  const navigate = useNavigate()
  useEffect(() => startRouter((path, options) => navigate(path, options)), [navigate])

  // The public supervisor survives replacement of the app child. It is consequently the only
  // trustworthy transition signal: an old child can still say ready while the next artifact builds.
  // The READ is shared — api/supervisorStatus.ts owns the one poll (gentle at rest, prompt across a
  // handoff) that this board, the Restart Ntwine button and the dev-build probe all observe; this effect
  // is only what the BOARD does with each answer. Writes are gated in rpc.ts but drafts remain
  // session-backed and editable throughout.
  const { data: supervisorStatus, dataUpdatedAt: supervisorAnsweredAt } = useSupervisorStatus()
  const announcedFailure = useRef<string | null>(null)
  // The hold's clock (finding 1, audit 2026-09-11): how long the supervisor has been silent while the
  // board shows "restarting", and whether that has run past the deadline. Stepped once per poll by the
  // pure reducer in api/restart.ts; a null answer used to be ignored here outright, which is how a
  // successor that never came up left every tab behind the blocking overlay forever.
  const [hold, setHold] = useState<RestartHold>(IDLE_RESTART_HOLD)
  // The build this page was served by (finding 8): the first identity any answer named. A later READY
  // answer naming a different one means a new server is up under an old bundle — reload, whichever
  // tab clicked. Cleared by the reload itself, since the next page captures the new identity first.
  const seenBuild = useRef<string | null>(null)
  const reloading = useRef(false)
  useEffect(() => {
    const status = supervisorStatus
    if (status) {
      // An optimistic, user-initiated restart raised the overlay before the supervisor confirmed the
      // transition. HOLD it until a poll actually OBSERVES a server-confirmed non-"ready" status: a
      // "ready" read while pending is either the pre-flip state or a stale in-flight response, and
      // applying it would drop the overlay and (with a destination armed) reload onto the old child.
      // And not just any non-"ready": one whose request STARTED after the supervisor acked the POST.
      // A "failed" that was already in flight at the click — real, because the board offers retry
      // from "failed" — used to clear the guard for the new attempt, after which the launcher's
      // deliberate "ready" (`preparing`) reloaded the tab onto the old bundle (pullfrog on #35,
      // 2026-09-11). The verdict is the pure reducer's; this effect only applies it.
      const plane = nextControlPlane({ state: store.controlPlaneState, message: store.controlPlaneMessage, attempt: store.controlPlaneRestartAttempt }, status)
      store.controlPlaneState = plane.state
      store.controlPlaneMessage = plane.message
      store.controlPlaneRestartAttempt = plane.attempt
      if (seenBuild.current === null) seenBuild.current = ntwineBuildIdentity(status)
    }
    // Step the hold on EVERY answer, null included — the null ones are the whole point. `restarting`
    // is what the board shows after applying this poll, so silence only ever accrues under the overlay.
    setHold((prev) => nextRestartHold(prev, { restarting: store.controlPlaneState === "restarting", answered: status != null, at: Date.now() }))
    if (!status || reloading.current) return
    const destination = sessionStorage.getItem(RELOAD_AFTER_UPDATE_RESTART)
    if (readyBelieved({ state: store.controlPlaneState, message: store.controlPlaneMessage, attempt: store.controlPlaneRestartAttempt }, status)) {
      if (destination) {
        sessionStorage.removeItem(RELOAD_AFTER_UPDATE_RESTART)
        sessionStorage.removeItem(UPDATE_RESTART_FROM_VERSION)
        reloading.current = true
        window.location.replace(destination)
        return
      }
      // Every OTHER tab: no destination was armed here, but the server answering is not the one that
      // served this bundle. `reload()` rather than `replace(href)`, which is a same-document jump when
      // the URL carries a fragment and would load nothing.
      if (shouldReloadForNewBuild(seenBuild.current, status)) {
        reloading.current = true
        window.location.reload()
        return
      }
    }
    if (status.state === "failed" && destination) {
      const fromVersion = sessionStorage.getItem(UPDATE_RESTART_FROM_VERSION) ?? undefined
      sessionStorage.removeItem(RELOAD_AFTER_UPDATE_RESTART)
      sessionStorage.removeItem(UPDATE_RESTART_FROM_VERSION)
      if (announcedFailure.current !== status.message) {
        // Announce the failure, never its REASON: the supervisor's message is raw build output —
        // a `nub run typecheck` failure arrives as several hundred characters of absolute
        // snapshot paths — and pasting that into a toast stretched a strip across the entire
        // viewport, four lines deep, saying the same thing the failure panel beside the reload
        // button was already showing properly. The panel owns the detail; this owns the attention.
        // Which failure it was (the old version giving up, or the new one failing to start) is judged
        // by the version the failed answer names against the one at click — finding 11.
        announcedFailure.current = status.message ?? "Update & Restart failed"
        showToast(`Update & Restart failed — ${restartFailureCopy(restartFailureOutcome(fromVersion, status)).summary}`, { duration: 7000 })
      }
    }
    // `supervisorAnsweredAt`, not the status alone: react-query's structural sharing hands back the SAME
    // object when a poll's answer is unchanged, and this body has to run on EVERY answer the way the
    // interval loop it replaces did — the reload destination is armed between two reads, so a run keyed
    // on the status object could miss it.
  }, [supervisorStatus, supervisorAnsweredAt])

  // While ANY overlay is open (thread sheet, doc drawer, settings, new-thread modal, palette), the
  // PAGE must not scroll — only the overlay's own pane does.
  const overlayOpen = snap.drawers.length > 0 || snap.showSettings || snap.showNewThread || snap.showPalette || snap.showShortcuts || snap.showRunningTimeLimit
  useEffect(() => {
    // Scroll lock via the body-fixed dance, NOT overflow:hidden on the root — hiding root overflow
    // dropped the scrollbar (and with it the layout width) every time a drawer opened. With the
    // track permanently reserved (html overflow-y: scroll) and the body pinned at its scroll
    // offset, locking is pixel-invisible; unlocking restores the exact scroll position.
    if (!overlayOpen) return
    const y = window.scrollY
    const body = document.body
    body.style.position = "fixed"
    pinPageAt(-y)
    body.style.left = "0"
    body.style.right = "0"
    body.style.width = "100%"
    // The pinned body is as tall as the page, so it reports every change in the page's height.
    const resize = new ResizeObserver(clampPinnedPage)
    resize.observe(body)
    return () => {
      resize.disconnect()
      // The offset to come back to is the body's pinned top NOW, not the one captured at the lock: the
      // queue's viewport lock (lib/viewportLock.ts) moves that top when a card arrives or leaves above the
      // one behind the drawer, and restoring the old offset displaced the reader by exactly that card.
      const current = pageScrollY()
      body.style.position = ""
      pinPageAt(null)
      body.style.left = ""
      body.style.right = ""
      body.style.width = ""
      // Until 2026-09-28 a scroll requested under the lock could also park a landing for this restore to
      // honour (lib/pageScrollLock.ts requestScrollAfterUnlock), so a board's queued row could dismiss its
      // drawer and auto-scroll in one move. Nothing asks for one any more (Everything's scroll-to-card,
      // AllQueues.tsx, never did), so the restore is the held offset, always.
      window.scrollTo(0, current)
    }
  }, [overlayOpen])

  // Mirror settings.notifications onto the store so the (React-free) SSE handler can gate desktop
  // notifications. Refetched whenever the settings query is invalidated (e.g. after a save).
  const settings = useQuery({ queryKey: ["settingsGet"], queryFn: () => rpc.settingsGet() })
  useEffect(() => {
    store.notificationsEnabled = settings.data?.notifications ?? false
  }, [settings.data?.notifications])
  // …and for every project the page is NOT bound to, whose events never reach this socket.
  useCrossProjectNotifications(settings.data?.notifications ?? false)

  // When the repo IS a GitHub repo but gh is NOT signed in, ONE subtle, self-fading hint on app open
  // nudges the user to `gh auth login`. The hint
  // fires at most once per page load (a module flag survives re-renders / StrictMode double-invoke),
  // stays a beat longer than a normal toast so it's readable, and never nags again.
  const github = useGithubStatus()
  useEffect(() => {
    if (github.data?.inRepo && !github.data.authed) maybeShowSignInHint()
  }, [github.data?.inRepo, github.data?.authed])

  // THE KEYBOARD MODEL. The sidebar is mouse-driven and text surfaces own their own keys; on top of
  // that sits ONE rebindable shortcut layer (lib/keybindings.ts for the defaults and why each one,
  // lib/keyboardRuntime.ts for how a key reaches its act, `?` for the sheet). This board registers the
  // actions only it can serve — the palette, settings, thread details and the new-thread door — and
  // the runtime handles the card keys (j/k, e, h, r, f) against whatever the reader is looking at.
  //   NOTE: no ⌘N. It is the BROWSER's new-window shortcut — reserved, and ours to leave alone.
  //   Hijacking it either loses to the browser outright (a plain tab never delivers the event) or, in
  //   a standalone/PWA window, steals a system shortcut the user expects. New thread is `c` instead
  //   (Gmail's compose), plus ⌘K → "New thread", and the always-visible prompt box.
  //   Esc — overlays first (palette/modal/settings), then the drawer stack topmost-first. That chain
  //   belongs to <DrawerStack> (the standalone /full page needs the identical unwinding), and it is
  //   deliberately NOT rebindable: Esc is how every layer in the app is left.
  //   Enter / Shift-Enter / ⌘-Enter belong to the composer (lib/composerKeyboard.ts).
  // (The xstate focus machine — nav selection, arrow-walk, chevron, step-in/out, focus registry — was
  // DELETED when the sidebar went mouse-only. The card keys do not bring it back: there is no virtual
  // focus, only the card the rail's reading marker already points at.)
  useShortcut("app.palette", () => {
    store.showPalette = !store.showPalette
  })
  useShortcut("app.details", () => {
    // A sidebar-only binding (keybindings.ts sidebarOnly): in a browser ⌘I goes on to the browser.
    if (!embedded()) return false
    // In an editor's sidebar ⌘I is first the editor's chord — the code in front into the prompt box it was
    // typed in, or with no thread open into the new-thread box — and Thread details only where it is not
    // that (lib/editorContext.ts addEditorContextByKey). Consumed either way, so it never leaves the page.
    if (embedded()) {
      const added = addEditorContextByKey(document.activeElement, store.drawers.some((drawer) => !drawer.closing), store.showNewThread)
      if (added === "nothing") showToast("Open a file in the editor to add it.")
      if (added) return
    }
    // The ntwine document for the topmost open thread (stacks another layer / pops its own).
    const top = topDrawer()
    const target = topThreadSlug()
    if (top?.kind === "doc") {
      if (!closeDrawerAnimated(top.id)) store.drawers.pop()
      return
    }
    // Nothing to show; the key still stays in the page.
    if (!target) return
    pushDrawer("doc", target)
  })
  // ⌘, OPENS settings and leaves closing to Esc, the way it brings a Mac app's preferences forward
  // rather than toggling them — and so that DrawerStack stays the one place a layer is closed from.
  useShortcut("app.settings", () => {
    store.showSettings = true
  })
  useShortcut("app.newThread", () => openDispatch())

  const board = useBoard()

  // Settle a parked `/thread/<slug>` URL once the page project's board has landed — a cold deep link
  // opens its drawer painted open on the render the board first arrives. Deliberately an EFFECT and not a
  // store subscription, so it runs after the page commits. (resolveRoutedThread no-ops unless there is a
  // parked slug AND a board.)
  useEffect(() => { resolveRoutedThread() }, [board, snap.routeThreadSlug])

  // The window title is set by what is showing: the page names its view (AllQueues.tsx), StandaloneThreadPage
  // its thread, and index.html's "Ntwine" stands elsewhere. No effect here — it would run after the page's on
  // mount and overwrite it.

  return (
    <>
    <RestartOverlay
      open={snap.controlPlaneState === "restarting"}
      message={snap.controlPlaneMessage}
      stalled={hold.stalled}
      silentFor={hold.silentSince === null ? undefined : formatCompactElapsed(hold.silentForMs)}
    />
    {/* While restarting, the whole app subtree goes inert so nothing behind the scrim is focusable or
        clickable; the overlay above is a sibling OUTSIDE it so it stays interactive. Once the hold has
        stalled the overlay stops blocking, and so does this. */}
    <div inert={snap.controlPlaneState === "restarting" && !hold.stalled} className="relative min-h-screen bg-bg text-fg text-sm">
      {/* NO FIXED CHROME IN EITHER TOP CORNER: identity, settings, reload and both quota chips are the
          StatusRow along the top of the page's prompt box. Everything flows; the PAGE is the one and only
          scroll container. The page lays itself out for a phone too (a single column): there is no
          separate mobile shell. */}
      <ErrorBoundary label="the cross-project page">
        <AllQueuesPage />
      </ErrorBoundary>

      {/* The side-drawer STACK — and the Escape chain that unwinds it — lives in <DrawerStack> so the
          standalone `/thread/<slug>/full` page can mount the identical thing. See DrawerStack.tsx. */}
      <DrawerStack />
      <PendingThreadSheet />
      {snap.showSettings && <SettingsDrawer offerUpdate />}
      {snap.showNewThread && <NewThreadDialog onClose={() => { store.showNewThread = false }} />}
      <CommandPalette />
      <RunningTimeLimitHost />
    </div>
    </>
  )
}
