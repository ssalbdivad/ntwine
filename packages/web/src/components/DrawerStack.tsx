import { useEffect } from "react"
import { useSnapshot } from "valtio"
import { store, threadBySlug } from "../store.ts"
import { displayTitle } from "../groups.ts"
import type { BoardSnapshot } from "@ntwine/shared"
import { closeDrawerAnimated, closeSettingsAnimated } from "../lib/overlays.ts"
import { dismissOpenSelect } from "../lib/selectOverlay.ts"
import { ThreadSheet } from "./ThreadSheet.tsx"
import { SubAgentSheet } from "./SubAgentSheet.tsx"
import { FileReaderDrawer } from "./FileReaderDrawer.tsx"
import { ImageViewer } from "./ImageViewer.tsx"
import { ThreadDrawer } from "./ThreadDrawer.tsx"
import { TerminalSheet } from "./TerminalSheet.tsx"
import { ScheduleDrawer } from "./ScheduleDrawer.tsx"
import { ErrorBoundary, DrawerErrorSheet } from "./ErrorBoundary.tsx"

// The side-drawer STACK, and the Escape chain that unwinds it. The picture viewer is mounted here too,
// though it is no layer of the stack: it is modal, and owns its own Escape.
//
// Two DIFFERENT depths: `depth` = the layer's true stack position (array index) drives z-index — it must
// stay strictly monotonic so a layer always paints above everything below it, including the ~210ms window
// while a lower layer slides OUT. `widthDepth` = the count of layers below that are STAYING (non-closing)
// drives the width/inset (each step 28px narrower). A closing layer keeps its array slot for its
// slide-out, so counting it toward WIDTH made the layer above open one step too narrow, then JUMP wider
// (content reflow) the instant the closer was removed; excluding it lets the new layer render at its
// FINAL width and slide in from off-screen with no end-of-animation reflow. z and width are decoupled
// because ThreadSheet alone is portaled + split-z (overlay/content) while the others are single-z inline
// — tying z to the non-closing count let a closing ThreadSheet outrank a drawer opened above it.
export function DrawerStack() {
  const snap = useSnapshot(store)

  // Esc unwinding. Exactly ONE of these is ever live per page, so the whole overlay precedence chain
  // lives here rather than being split across window listeners that would both fire on the same
  // physical Escape. (App keeps the ⌘K/⌘I chords; those are its own.)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return
      // YOUR terminal is a native TUI surface: its Escape belongs to the program in it, never to this layer.
      // An agent terminal's log is read-only — nothing in it can take an Escape — so there it closes the
      // drawer as it does anywhere else.
      if (e.target instanceof Element && e.target.closest(".xterm") && !e.target.closest("[data-shell-log-pane]")) return
      // Portaled selectors are not descendants of their owning dialog/drawer. Give the topmost
      // model/effort matrix or Select this physical Escape before unwinding the app overlay stack.
      if (dismissOpenSelect()) {
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        return
      }
      // Overlays soak up Esc first (outermost wins). A focused composer handles its own Esc (blur)
      // and stops propagation, so reaching here otherwise means the page is at rest. Settings + the
      // open-thread sheet route through their OWN animated close (fall back to the store write if
      // nothing registered) so Esc slides them out instead of unmounting instantly.
      if (store.showPalette) store.showPalette = false
      else if (store.showNewThread) store.showNewThread = false
      else if (store.showSettings) { if (!closeSettingsAnimated()) store.showSettings = false }
      // The drawer STACK unwinds topmost-first, one layer per Esc.
      else if (store.drawers.length > 0) {
        const top = store.drawers[store.drawers.length - 1]
        if (!closeDrawerAnimated(top.id)) store.drawers.pop()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  let below = 0
  return (
    <>
      {snap.drawers.map((d, i) => {
        const widthDepth = below
        if (!d.closing) below++
        const layer = d.kind === "thread" ? (
          <ThreadSheet key={d.id} id={d.id} slug={d.slug} depth={i} widthDepth={widthDepth} initiallyOpen={d.routed} />
        ) : d.kind === "subagent" ? (
          <SubAgentSheet
            key={d.id}
            id={d.id}
            slug={d.slug}
            subId={d.subId ?? ""}
            label={d.label ?? d.slug}
            subagentType={d.subagentType}
            startedAt={d.startedAt}
            depth={i}
            widthDepth={widthDepth}
          />
        ) : d.kind === "shell" ? (
          // An AGENT's terminal and yours open the same drawer; the layer kinds stay distinct only because
          // drawer stacks persist and a stored "shell" layer must still reopen.
          <TerminalSheet key={d.id} id={d.id} slug={d.slug} source={{ owner: "agent", shellId: d.subId ?? "" }} label={d.label} startedAt={d.startedAt} depth={i} widthDepth={widthDepth} />
        ) : d.kind === "terminal" ? (
          <TerminalSheet key={d.id} id={d.id} slug={d.slug} source={{ owner: "human", terminalId: d.subId ?? "" }} depth={i} widthDepth={widthDepth} />
        ) : d.kind === "schedule" ? (
          <ScheduleDrawer key={d.id} id={d.id} scheduleId={d.slug} projectId={d.projectId} depth={i} widthDepth={widthDepth} />
        ) : d.kind === "file" ? (
          <FileReaderDrawer key={d.id} id={d.id} path={d.path ?? d.slug} title={d.label ?? d.slug} scope={d.scope} depth={i} widthDepth={widthDepth} />
        ) : (
          // The board is read HERE, on the one path that needs it, and not at the top: valtio counts an
          // object read by reference, with none of its fields touched, as changed by ANY change inside it,
          // so a top-level `useBoard()` re-rendered the whole stack — every open drawer, its transcript and
          // its prompt box — on every delta of every thread (2026-10-16, a phone while another thread streamed).
          <ThreadDrawer
            key={d.id}
            id={d.id}
            slug={d.slug}
            depth={i}
            widthDepth={widthDepth}
            title={(() => { const t = threadBySlug(snap.board as BoardSnapshot | null, d.slug); return t ? displayTitle(t) : d.slug })()}
          />
        )
        // A drawer that throws while rendering used to blank the whole window — the board it was
        // opened FROM included. Now the failure stays inside its own layer: the fallback re-mounts
        // the same Sheet geometry, so it still slides in, still closes, and still leaves everything
        // underneath it alive. Reset on the layer's identity so re-opening it is a real retry.
        return (
          <ErrorBoundary
            key={d.id}
            label="this drawer"
            resetKeys={[d.kind, d.slug, d.subId, d.path]}
            fallback={(error, retry) => (
              <DrawerErrorSheet id={d.id} depth={i} widthDepth={widthDepth} error={error} onRetry={retry} />
            )}
          >
            {layer}
          </ErrorBoundary>
        )
      })}
      <ImageViewer />
    </>
  )
}
