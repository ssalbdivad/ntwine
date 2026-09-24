import { useEffect, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router"
import { useSnapshot } from "valtio"
import { useQuery } from "@tanstack/react-query"
import { closeGithubPicker, store, seedBoard, openNewThread, pushDrawer, resolveRoutedThread, topDrawer, topThreadSlug, showToast } from "./store.ts"
import { useBoard } from "./hooks.ts"
import { closeDrawerAnimated } from "./lib/overlays.ts"
import { useShortcut } from "./lib/keyboardRuntime.ts"
import { takeScrollAfterUnlock } from "./lib/pageScrollLock.ts"
import { startRouter } from "./lib/router.ts"
import { nextSidebarPresence, readSidebarMirror, writeSidebarMirror, type SidebarPresence } from "./lib/sidebarPresence.ts"
import { projectSlug } from "./lib/base-path.ts"
import { AllQueuesPage } from "./components/AllQueues.tsx"
import { rpc } from "./api/rpc.ts"
import { SIDEBAR_COLUMN_CLASS, Sidebar } from "./components/Sidebar.tsx"
import { MobileBoard } from "./components/MobileBoard.tsx"
import { useIsMobile } from "./lib/mobile.ts"
import { DrawerStack } from "./components/DrawerStack.tsx"
import { TodosView } from "./components/TodosView.tsx"
import { NewThreadDialog, preferDispatchMode, type DispatchMode } from "./components/NewThreadModal.tsx"
import { GithubPickerModal } from "./components/GithubPickerModal.tsx"
import { useGithubStatus } from "./components/GithubTrigger.tsx"
import { SettingsDrawer } from "./components/SettingsDrawer.tsx"
import { CommandPalette } from "./components/CommandPalette.tsx"
import { StatusListView } from "./components/StatusListView.tsx"
import { ErrorBoundary } from "./components/ErrorBoundary.tsx"
import { RestartOverlay } from "./components/RestartOverlay.tsx"
import { useSupervisorStatus } from "./api/supervisorStatus.ts"
import {
  frizzBuildIdentity,
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
// keeps it from re-firing across re-renders, effect re-runs, or a StrictMode double-invoke.
let signInHintShown = false
function maybeShowSignInHint() {
  if (signInHintShown) return
  signInHintShown = true
  showToast("Sign in to the GitHub CLI (`gh auth login`) to dispatch from issues/PRs.", { duration: 6000 })
}

// The new-thread keys: `c` for a prompt, `t` for a terminal command. With the page in front of you the
// prompt box at the top of the rail IS the new-thread door (on a fresh board, the same box centered), so
// the key presses that box's own tab and puts the caret in it. With a drawer over the page the rail sits
// behind its scrim, so the anywhere-modal opens on that tab instead and the drawer stays where it was —
// Gmail's compose window over the conversation you were reading.
function openDispatch(mode: DispatchMode): void {
  if (!store.drawers.some((drawer) => !drawer.closing)) {
    const form = [...document.querySelectorAll<HTMLElement>("[data-dispatch-form]")].find((el) => !el.closest('[role="dialog"]'))
    if (form) {
      const tab = form.querySelector<HTMLElement>(`[data-dispatch-tab="${mode}"]`)
      if (tab?.getAttribute("aria-selected") !== "true") tab?.click()
      // After the tab's own render: switching tabs mounts the other box.
      requestAnimationFrame(() => {
        form.querySelector<HTMLElement>(mode === "prompt" ? '[data-surface="newComposer"]' : '[data-surface="commandComposer"]')?.focus()
      })
      return
    }
  }
  preferDispatchMode(mode)
  openNewThread()
}


/**
 * WHICH PAGE THIS SHELL IS HOSTING. A project's BOARD (single-project mode) and the CROSS-PROJECT page
 * share everything here except the standing surfaces: the drawer stack, the modals, the palette, the
 * restart overlay, the keyboard, the router sync and the board seed are the page project's either way —
 * on the cross-project page the page project is its FOCUS (routes.tsx CrossProjectRoute), which is what
 * lets a thread of any project open in place there with the board's own drawers.
 */
export type AppMode = "board" | "cross-project"

export function App({ mode = "board" }: { mode?: AppMode }) {
  const crossProject = mode === "cross-project"
  const snap = useSnapshot(store)
  const sidebarPresence = useRef<SidebarPresence>({ projectDir: null, hasBeenVisible: false })
  // The page project. A board is keyed by it and remounts when it changes; the cross-project shell is
  // not (the page must survive a focus change), so anything that has to follow the project names it.
  const pageSlug = projectSlug(useLocation().pathname)

  // Seed the board once at startup so the first paint doesn't wait on the SSE connect; SSE keeps it
  // fresh afterward. seedBoard (not setBoard) so a late-resolving seed can't clobber a board the SSE
  // stream has already established + advanced with deltas. Per page project: a focus change on the
  // cross-project page resets the store (routes.tsx useProjectBinding) and wants the new board as fast.
  useEffect(() => {
    rpc.board().then(seedBoard).catch(() => {})
  }, [pageSlug])

  // STORE → URL (opening a drawer writes the address bar). The other direction is the route tree's —
  // see routes.tsx useRouteToStore. Navigation goes through the router so its history stack and its
  // rendered match stay the same thing.
  const navigate = useNavigate()
  useEffect(() => startRouter((path, options) => navigate(path, options)), [navigate])

  // The public supervisor survives replacement of the app child. It is consequently the only
  // trustworthy transition signal: an old child can still say ready while the next artifact builds.
  // The READ is shared — api/supervisorStatus.ts owns the one poll (gentle at rest, prompt across a
  // handoff) that this board, the Restart Frizz button and the dev-build probe all observe; this effect
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
      if (seenBuild.current === null) seenBuild.current = frizzBuildIdentity(status)
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
  const overlayOpen = snap.drawers.length > 0 || snap.showSettings || snap.showNewThread || snap.showGithubPicker || snap.showPalette || snap.showShortcuts
  useEffect(() => {
    // Scroll lock via the body-fixed dance, NOT overflow:hidden on the root — hiding root overflow
    // dropped the scrollbar (and with it the layout width) every time a drawer opened. With the
    // track permanently reserved (html overflow-y: scroll) and the body pinned at its scroll
    // offset, locking is pixel-invisible; unlocking restores the exact scroll position.
    if (!overlayOpen) return
    const y = window.scrollY
    const body = document.body
    // Drop any landing a previous lock left unconsumed, so a stale one can never fire against a page
    // the reader has since moved on from.
    takeScrollAfterUnlock()
    body.style.position = "fixed"
    body.style.top = `-${y}px`
    body.style.left = "0"
    body.style.right = "0"
    body.style.width = "100%"
    return () => {
      body.style.position = ""
      body.style.top = ""
      body.style.left = ""
      body.style.right = ""
      body.style.width = ""
      // A scroll requested WHILE the page was locked couldn't be applied (the body was pinned) and this
      // restore would have undone it anyway — so it parked its landing. Honour it over the captured
      // offset: that is what lets a queued sidebar row dismiss its drawer and auto-scroll in one move.
      window.scrollTo(0, takeScrollAfterUnlock() ?? y)
    }
  }, [overlayOpen])

  // Mirror settings.notifications onto the store so the (React-free) SSE handler can gate desktop
  // notifications. Refetched whenever the settings query is invalidated (e.g. after a save).
  const settings = useQuery({ queryKey: ["settingsGet"], queryFn: () => rpc.settingsGet() })
  useEffect(() => {
    store.notificationsEnabled = settings.data?.notifications ?? false
  }, [settings.data?.notifications])

  // GitHub availability drives two things: the picker TRIGGER (in the sidebar / brand-new view, gated
  // in GithubTrigger off this same cached query) and — when the repo IS a GitHub repo but gh is NOT
  // signed in — ONE subtle, self-fading hint on app open nudging the user to `gh auth login`. The hint
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
    // The frizz document for the topmost open thread (stacks another layer / pops its own).
    const top = topDrawer()
    const target = topThreadSlug()
    if (top?.kind === "doc") {
      if (!closeDrawerAnimated(top.id)) store.drawers.pop()
      return
    }
    if (!target) return false
    pushDrawer("doc", target)
  })
  // ⌘, OPENS settings and leaves closing to Esc, the way it brings a Mac app's preferences forward
  // rather than toggling them — and so that DrawerStack stays the one place a layer is closed from.
  useShortcut("app.settings", () => {
    store.showSettings = true
  })
  useShortcut("app.newThread", () => openDispatch("prompt"))
  useShortcut("app.newTerminal", () => openDispatch("terminal"))

  const board = useBoard()
  // The phone gets its own shell. Everything BELOW the layout — the drawer stack, the modals, the
  // restart overlay — is shared, so only the standing surfaces branch (see the return below).
  const isMobile = useIsMobile()

  // Settle a parked `/thread/<slug>` URL. It waits for the board because the destination depends on
  // whether the thread is QUEUED — a needsYou thread's whole panel is already in the main column, so
  // the URL scrolls to that card instead of stacking an identical drawer over it. Deliberately an
  // EFFECT and not a store subscription: scrollToQueueCard measures a mounted `[data-queue-card]`, so
  // it has to run after the queue commits, which for a cold deep link is the same render the board
  // first arrives. (resolveRoutedThread no-ops unless there is a parked slug AND a board.)
  useEffect(() => { resolveRoutedThread() }, [board, snap.routeThreadSlug])

  sidebarPresence.current = nextSidebarPresence(sidebarPresence.current, board)
  const showSidebar = board !== null && sidebarPresence.current.hasBeenVisible
  // Before the first board lands, hold the sidebar's column open if this project had one last time —
  // the workpane then renders in its final place on the first frame instead of centering alone and
  // jumping when the sidebar mounts. Written back on every board so the mirror tracks the answer.
  const reserveSidebar = board === null && readSidebarMirror(projectSlug())
  const hasBeenVisible = sidebarPresence.current.hasBeenVisible
  useEffect(() => {
    // The mirror describes the BOARD's layout; the cross-project page has its own column either way.
    if (board !== null && !crossProject) writeSidebarMirror(projectSlug(), hasBeenVisible)
  }, [board, hasBeenVisible, crossProject])
  // Window title carries the project identity. In the INSTALLED APP window (display-mode:
  // standalone) Chrome prefixes the title bar with the app name itself ("Frizz - <title>"), so the
  // page title must NOT repeat the wordmark — just the repo label ("Frizz - nubjs/nub"). In an
  // ordinary browser tab there's no prefix, so the title carries it as a trailing mark
  // ("nubjs/nub — Frizz") — the repo LEADS because a tab truncates from the end, and it is the repo
  // that tells two open boards apart. StandaloneThreadPage uses the same trailing mark.
  const projectLabel = crossProject ? "Everything" : (board?.projectLabel ?? board?.projectName)
  useEffect(() => {
    const standalone = window.matchMedia?.("(display-mode: standalone)").matches
    document.title = standalone ? (projectLabel ?? "Frizz") : projectLabel ? `${projectLabel} — Frizz` : "Frizz"
  }, [projectLabel])

  // NOTE: there is deliberately NO "this repo has no .frizz/" branch here. Threads are session-first
  // (the registry in ui.db IS the board); `.frizz/` only holds thread scratch dirs, and dispatch
  // creates it on the way (writeScratchDir → ensureSafeDirectDirectory). Gating the shell on it
  // inverted the fresh-repo experience: a repo with an EMPTY `.frizz/` got the real first-run view,
  // while a repo without one got a dead end that said "dispatch a first thread" with no composer to
  // do it in. A `.frizz`-less repo is simply a board with zero threads — TodosView's `nothingAtAll`
  // branch already renders exactly the right thing for it (centered prompt box, sidebar hidden).
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
      {/* NO FIXED CHROME IN EITHER TOP CORNER. Identity, settings, reload and both quota chips used to
          be a bar pinned to the upper-left, a screen's width from the column they describe; they are
          the StatusRow along the top of the prompt box now (Sidebar.tsx, and TodosView's centered
          first-task box on a brand-new project). Everything flows; the PAGE is the one and only scroll
          container — a tall card simply runs off both edges. On a phone none of it renders at all: the
          project and the way to settings are already in the mobile nav bar. */}
      {/* (The old fixed "New thread" pill moved INTO the sidebar's top — one entry point, same modal
          flow; the ⌘K palette's "New thread" item and the always-visible dispatch box are the
          other doors — deliberately NOT ⌘N, which belongs to the browser.) */}

      {crossProject ? (
        // The cross-project page at every width: it lays itself out for a phone (a single column), and
        // MobileBoard is a BOARD's phone shell — one project's queue, nothing of the others.
        <ErrorBoundary label="the cross-project page">
          <AllQueuesPage />
        </ErrorBoundary>
      ) : isMobile ? (
        <MobileBoard />
      ) : (
        <>
      {/* CENTERED PAIR with a SCALING GUTTER: the floating sidebar column and the workpane sit side by
          side ("space-around looked weird" — a deliberate gutter reads calmer), and the PAIR as a unit
          centers horizontally — leftover space distributes on the far sides. The sidebar is VERTICALLY
          CENTERED in the viewport (sticky, set in Sidebar.tsx) and scales clamp(272px → 34vw → 680px)
          so titles get real room on large screens; the workpane keeps its readable 720px measure
          (shrinking first when space runs out) and scrolls as normal top-anchored page flow.
          TABLET BAND (801px–~1170px) — the pair used to be WIDER than the viewport there, so both
          outer edges sat FLUSH against it while a 52px gutter ate the middle (maintainer 2026-08-01:
          "we should never have it so the left and right edges are flush against the viewport", and
          "reduce the gap between the sidebar and the Queue on smaller screens"). Two things keep that
          from recurring, both CONTINUOUS so nothing jumps at a breakpoint:
            · px-5 on the container at EVERY width — the pair centers inside the padded box and the
              workpane (min-w-0) shrinks into it, so a side margin can never reach 0. Above ~1170px
              there is leftover space anyway and the padding stops binding.
            · the gutter scales clamp(28px → 3.4vw → 52px): ~28px where space is scarce, back to the
              tuned 52px by ~1530px, where the pair has margins to spare. Wide layouts are unchanged. */}
      <div className="flex min-h-screen justify-center gap-[clamp(28px,3.4vw,52px)] px-5 max-[800px]:flex-col max-[800px]:justify-start max-[800px]:gap-0 max-[800px]:px-3">
        {/* A genuinely fresh project keeps its centered first-task view. Once this project has had a
            Frizz-owned thread, the sidebar remains mounted through transient empty keyframes;
            navigation must not vanish while the live board stream reconnects or catches up. */}
        {/* Each of the three standing surfaces catches its OWN render errors (see ErrorBoundary.tsx):
            a bad row in the sidebar must not take the workpane with it, and vice versa. */}
        {showSidebar && (
          <ErrorBoundary label="the sidebar">
            <Sidebar />
          </ErrorBoundary>
        )}
        {reserveSidebar && <aside aria-hidden className={SIDEBAR_COLUMN_CLASS} data-sidebar-reserved />}
        <main
          id="workpane"
          // min-h-screen where content is vertically CENTERED: the boot loader and the empty queue's
          // prompt box (TodosView's flex-1 centering needs a full-height parent); populated queues just
          // top-align and grow past. Threads render in DRAWERS, never here.
          className={`w-[720px] max-w-[62vw] min-w-0 flex flex-col py-5 max-[800px]:w-full max-[800px]:max-w-none ${
            snap.view === "todos" || !board ? "min-h-screen" : ""
          } ${
            // Queue recedes: the CARD carries its own chrome (a sticky header), so the bordered panel
            // frame drops away. Status lists (URL-only views) keep the panel on main.
            snap.view === "todos" ? "" : "rounded-lg border border-border bg-panel"
          }`}
        >
          {/* Until the first board snapshot lands, show a quiet loader — NEVER a view's empty state
              (which would flash "Nothing pending" on every hard reload). Only board !== null renders
              real views. */}
          {!board ? (
            <div className="flex-1 flex items-center justify-center">
              <span className="block h-5 w-5 rounded-full border-2 border-muted/50 border-t-transparent animate-spin" />
            </div>
          ) : (
            <ErrorBoundary label="the queue" resetKeys={[snap.view]}>
              {snap.view.startsWith("status:") && <StatusListView status={snap.view.slice(7)} />}
              {snap.view === "todos" && <TodosView />}
            </ErrorBoundary>
          )}
        </main>
      </div>
        </>
      )}

      {/* The side-drawer STACK — and the Escape chain that unwinds it — lives in <DrawerStack> so the
          standalone `/thread/<slug>/full` page can mount the identical thing. See DrawerStack.tsx. */}
      <DrawerStack />
      {snap.showSettings && <SettingsDrawer />}
      {snap.showNewThread && <NewThreadDialog onClose={() => { store.showNewThread = false }} />}
      {snap.showGithubPicker && <GithubPickerModal onClose={closeGithubPicker} />}
      <CommandPalette />
    </div>
    </>
  )
}
