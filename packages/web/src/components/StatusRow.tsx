import type { ReactNode } from "react"
import { House, Settings as SettingsIcon } from "lucide-react"
import { Link } from "react-router"
import { store } from "../store.ts"
import { ALL_PROJECTS_HREF } from "../lib/pageView.ts"
import { STATUS_ROW_ACTION, STATUS_ROW_ICON } from "../lib/statusRow.ts"
import { QuotaChips, useQuotaChipsVisible } from "./QuotaBar.tsx"
import { RestartNtwineButton } from "./RestartNtwineButton.tsx"
import { RunningTimeLimitButton } from "./RunningTimeLimitDialog.tsx"
import { KeyboardShortcutsButton } from "./KeyboardShortcuts.tsx"
import { useShortcutLabel, withShortcut } from "../lib/keyboardRuntime.ts"
import { canRestart } from "../api/restart.ts"
import { useSupervisorStatus } from "../api/supervisorStatus.ts"

// THE STATUS ROW — one loose line along the TOP OF THE PROMPT BOX: the page's title at the left, then,
// pushed to the right end, the app's controls and its readouts:
//
//   ▣ acme-api ▾                settings · shortcuts · reload │ Claude 83% · Codex 59%
//
// and on a project's BOARD (`/project/<slug>`, ProjectBoard.tsx), led by the door home and followed by the
// project's repo — upstream's crumb and identity, which the board brought back on 2026-10-06:
//
//   ⌂ │ ▣ acme-api ▾  acme/api …      settings · shortcuts · reload │ Claude 83% · Codex 59%
//
// THE TITLE is the project switcher (ProjectSwitcher.tsx), handed in as `title` — the page's one name for
// what it shows, where a workspace switcher sits in Linear, Slack or Vercel (David 2026-09-29). It
// sat over the queue until then, muted, and read as a filter on the cards rather than the scope of the
// whole page; the list's own project header repeated the name 180px away.
//
// It rides the page's prompt box, at the top of its left column (AllQueues.tsx).
//
// IT IS LOOSE, NOT A CHIP. Until 2026-08-19 this was a FIXED bar pinned to the page's upper-left
// corner with its own fill, hairline and shadow — a screen's width away from the column it described,
// and opaque because a full sidebar or a scrolling narrow rail would otherwise paint through it
// (maintainer: "move the top left status bar contents s.t. they are loose along the top of the sidebar
// prompt box"). In the column there is nothing to pass behind it, so the surface is gone: no fill, no
// border, no shadow, no z-index. Its two ends land on the composer's own border, which is what makes a
// borderless strip read as belonging to the box below it.
//
// THE DOOR HOME, ON A BOARD ONLY (`crumb`). It goes to All projects, at `/all`: the level above the board,
// the one that holds every board (2026-10-06; it was the bare `/` until then, and `/` now only goes back
// to the last view, which from a board is the board). All
// projects has no door: there is nowhere above it to go (David 2026-09-28: "there should no longer be
// an everything or an infinity button on the threads view on the left"). Upstream led its board's row
// with ⌂, the way out to its projects page at `/` (upstream 0a3b9139 StatusRow.tsx) — a router
// Link, so leaving keeps the socket and the query cache. A divider follows it: home LEAVES the board, the
// rest act on what you are in. The
// board's `identity` (ProjectBoard.tsx BoardIdentity) rides beside the switcher: the project's owner/repo
// linking to it on GitHub (upstream maintainer 2026-08-28: "Perhaps it should actually be showing
// owner/repo if a repo is detected"), and its ⋯ menu, which in All projects is on the project's row. The
// connection indicator went on 2026-08-28: its one informative state, disconnected, is one the page also
// shows by going stale.
//
// ONE DIVIDER, between the buttons and the readouts.
//
// THE GAP IS 12px OF INK, not 12px of box — the same law lib/iconRhythm.ts states for the thread
// footer, solved for a strip that mixes 24px icon squares, hairlines, quota pills and a name. Each of
// those wears a different amount of dead space inside its own layout box, so a uniform `gap-2` drew six
// different distances (measured 2026-08-14, `scripts/ink-gaps.mjs --pad=0`, every CSS gap 8px) ranging
// 8.00px to 20.00px — a 2.5× spread on one provably uniform gap. The fix is per-mark, not per-gap:
// STATUS_ROW_ACTION collapses each icon square onto its glyph's ink, and then this one `gap-3` is the
// whole rhythm. Readings for the current row are in StatusRow.test.ts.

function Divider() {
  return <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border" />
}

/**
 * Reads its live values itself; `title` is the page's name, drawn first. `settings` and `shortcuts` false
 * drop the gear and the ⌨: in an editor's sidebar the title row VS Code draws over the frame carries both
 * (Settings as a button, Keyboard shortcuts under its ⋯), and the page's name (SidebarPage.tsx), so the
 * row there is the rest of it, at the right end — and NOTHING when there is no rest. With no supervisor to
 * restart (an Ntwine run from source) and no quota to read, the ⌨ stood alone on a 36px row above the prompt
 * box, a stray glyph the real-page run flagged as debris (scripts/e2e-sidebar.ts, 2026-10-01); a row of
 * nothing would still hold the box 10px down, so the row is not drawn at all.
 */
export function StatusRow({ title, identity, crumb = false, settings = true, shortcuts = true }: {
  title?: ReactNode
  /** Beside the title, in its slack: a board's repo and menu (ProjectBoard.tsx BoardIdentity). */
  identity?: ReactNode
  /** Lead with the door home to All projects, `/all` — a project's board, one level in. */
  crumb?: boolean
  settings?: boolean
  shortcuts?: boolean
} = {}) {
  // Whether there is a quota group behind the second divider at all. Every chip hides itself when it
  // has no reading, so without this a row with neither provider reporting draws a trailing hairline
  // with nothing after it.
  const quotaVisible = useQuotaChipsVisible()
  const settingsKeys = useShortcutLabel("app.settings")
  // RestartNtwineButton's own test, on the poll it shares (api/supervisorStatus.ts): one request however
  // many read it.
  const restartVisible = canRestart(useSupervisorStatus().data ?? null)
  if (!title && !settings && !shortcuts && !restartVisible && !quotaVisible) return null

  return (
    <div
      data-status-row
      // `mb-2.5` is the only thing holding the row off the prompt box, and the row carries no padding
      // of its own: it is flush with the composer's border on both sides, so the column reads as one
      // block rather than a strip parked above a box.
      className="mb-2.5 flex min-w-0 items-center gap-3 text-[12px]"
    >
      {crumb && (
        <>
          {/* `-ml-px` is the ink trim upstream measured: the square's own `-mx-1.5` left the house's ink 1px
              outside the prompt box's border, and the left edge is where a pixel of overhang shows. */}
          <Link to={ALL_PROJECTS_HREF} data-status-home title="All projects" aria-label="All projects" className={`${STATUS_ROW_ACTION} -ml-px`}>
            <House size={STATUS_ROW_ICON} aria-hidden="true" />
          </Link>
          <Divider />
        </>
      )}
      {/* Takes the row's slack, so the controls after it stand at the right end. */}
      {title ? (
        <div data-status-title className="flex min-w-0 flex-1 items-center gap-2">
          {title}
          {identity}
        </div>
      ) : (
        <span aria-hidden="true" className="flex-1" />
      )}
      {settings && (
        <button
          type="button"
          aria-label="Settings"
          title={withShortcut("Settings", settingsKeys)}
          className={STATUS_ROW_ACTION}
          onClick={() => (store.showSettings = true)}
        >
          <SettingsIcon size={STATUS_ROW_ICON} aria-hidden="true" />
        </button>
      )}
      {/* The keyboard shortcuts sheet — also `?` from anywhere, which its title names. */}
      {shortcuts && <KeyboardShortcutsButton />}
      {/* Greyed when there is no update to install; null only before a supervisor has answered, when
          the gap collapses and the row stays even. */}
      {/* A time limit on every running thread, the wind-down before a machine restart — beside the restart
          button. Off in an editor's sidebar with the gear: that row is VS Code's to fill. */}
      {settings && <RunningTimeLimitButton />}
      <RestartNtwineButton />
      {quotaVisible && (
        <>
          <Divider />
          <QuotaChips />
        </>
      )}
    </div>
  )
}
