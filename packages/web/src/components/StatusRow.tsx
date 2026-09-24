import { House, Inbox, Settings as SettingsIcon } from "lucide-react"
import { Link } from "react-router"
import { store } from "../store.ts"
import { useBoard } from "../hooks.ts"
import { STATUS_ROW_ACTION, STATUS_ROW_ICON } from "../lib/statusRow.ts"
import { projectIdentity } from "./Sidebar.tsx"
import { QuotaChips, useQuotaChipsVisible } from "./QuotaBar.tsx"
import { RestartFrizzButton } from "./RestartFrizzButton.tsx"

// THE STATUS ROW — one loose line along the TOP OF THE PROMPT BOX, controls at the left edge and the
// project at the right:
//
//   home │ settings · reload │ Claude 83% · Codex 59%                         owner/repo
//
// It rides the dispatch composer wherever that composer is: the sidebar's own top on a normal board,
// and the centered first-task box on a brand-new project (TodosView's `nothingAtAll` branch), which
// hides the sidebar entirely. Anywhere you can start a thread, this is above it.
//
// IT IS LOOSE, NOT A CHIP. Until 2026-08-19 this was a FIXED bar pinned to the page's upper-left
// corner with its own fill, hairline and shadow — a screen's width away from the column it described,
// and opaque because a full sidebar or a scrolling narrow rail would otherwise paint through it
// (maintainer: "move the top left status bar contents s.t. they are loose along the top of the sidebar
// prompt box"). In the column there is nothing to pass behind it, so the surface is gone: no fill, no
// border, no shadow, no z-index. Its two ends land on the composer's own border, which is what makes a
// borderless strip read as belonging to the box below it.
//
// CONTROLS LEFT, IDENTITY RIGHT (maintainer 2026-08-19). The row briefly ran the other way — identity
// leading, controls and quota trailing — which reads as a heading with its buttons pushed away. This
// way the left edge is one uninterrupted run of things you can press, and the project name anchors the
// right edge as the row's one piece of prose.
//
// TWO DIVIDERS, NOT ONE, and the first one is the point: home LEAVES this project, while settings and
// reload act on the app you are already in. One divider would group all three as "buttons"; two say
// the first one is a door out. The second divider separates the buttons from the readouts.
//
// THE PROJECT IS A LINK TO ITS REPO, AND THE CONNECTION INDICATOR IS GONE (maintainer 2026-08-28:
// "There should be a way to open up the GitHub repo for a given project if one is detected … Perhaps
// it should actually be showing owner/repo if a repo is detected … then maybe we should just drop the
// status indicator"). The connection had already been reduced from a green dot plus the word
// "connected" to the dot alone on 2026-08-19 ("drop the connected indicator, certainly. It's pretty
// useless"); the dot then said "green" every second of every session, and its one informative state —
// disconnected — is something the page ALSO tells you by going stale. The name is a real
// `<a target=_blank>` rather than a scripted window.open, so ⌘-click, middle-click and copy-link all
// work — and it links only when the board carries `githubRepo` (origin is github.com), so a GitLab
// origin or a remote-less directory shows its name as plain text.
//
// NO GITHUB MARK BESIDE IT. The first cut put GitHub's mark in the dot's old slot as the link's
// affordance; the maintainer pulled it the same day ("it kind of conflicts with the GitHub icon that
// shows up in the prompt box" — the picker's door, a few px below this row, is the one GitHub glyph
// on the surface and it means "browse issues and PRs", not "this repo"). The link shows itself the
// way every other text link in the app does: full-fg + underline on hover, and a title that says
// where it goes.
//
// THE 272px SIDEBAR IS THE BINDING WIDTH, not the viewport. The old bar was capped to the VIEWPORT, so
// it never ran out of room; this row lives in a column that floors at 272px in the tablet band. With
// the connection word still in it the repo name truncated to "f…" at an 820px viewport — the one
// reading that must survive was the first one dropped. Showing owner/repo makes that binding again:
// "colinhacks/frizz" does not fit beside two quota chips at 272px, so the name truncates from the
// START (`direction: rtl` on the clipping span, the text isolated LTR inside it) and it is the OWNER
// that gives way — "…hacks/frizz", never "colinhacks/f…". Any NEW mark added here has to be re-checked
// at 820px.
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

// The name, clipped from the START. A plain `truncate` keeps the head of the string and drops the
// tail, which for "owner/repo" throws away the repo — the one half worth keeping. `direction: rtl` on
// the clipping box moves the overflow (and the ellipsis) to the left edge; the text itself is
// re-isolated LTR (`unicode-bidi: isolate` + `direction: ltr`) so its letters and the slash keep their
// order. NOTE the string must end in a strong LTR character for this to hold — a trailing neutral
// (punctuation) would jump to the other end under rtl, and a repo name cannot end in one.
function StartTruncated({ text, title, className }: { text: string; title?: string; className?: string }) {
  return (
    <span dir="rtl" className={`block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap ${className ?? ""}`} title={title}>
      <span dir="ltr" className="[unicode-bidi:isolate]">{text}</span>
    </span>
  )
}

/**
 * Takes no props, and reads its live values itself. Both call sites are leaves of very different trees
 * — the sidebar column and the fresh-project centered box — and the second one (TodosView) subscribes
 * to no store state of its own. Threading identity down from there would have newly subscribed the
 * whole queue column to the store to feed a 24px strip. valtio's useSnapshot tracks the properties
 * actually READ, so this re-renders on a board change and on nothing else.
 */
export function StatusRow() {
  const board = useBoard()
  // A missing board is not evidence that this project is named "frizz". Keep the row neutral until a
  // board keyframe supplies an actual name; reconnects retain their adopted board.
  const identity = projectIdentity(board)
  // Whether there is a quota group behind the second divider at all. Every chip hides itself when it
  // has no reading, so without this a board with neither provider reporting draws a trailing hairline
  // with nothing after it.
  const quotaVisible = useQuotaChipsVisible()
  // Host-STRICT: the board carries `githubRepo` only when the origin remote is github.com (see
  // BoardSnapshot), which is exactly the case where a link to github.com is a right destination. The
  // display label alone cannot decide this — a GitLab origin yields an owner/repo there too.
  const githubRepo = board?.githubRepo ?? null

  const name = identity.state === "verified" ? identity.label : identity.state === "local" ? identity.name : null
  const accessibleName =
    identity.state === "verified"
      ? `Project: ${identity.label}`
      : identity.state === "local"
        ? `Project: ${identity.name}; local repository with no git remote`
        : identity.state === "loading"
          ? "Project identity loading"
          : "Project identity unavailable"

  return (
    <div
      data-status-row
      // `mb-2.5` is the only thing holding the row off the prompt box, and the row carries no padding
      // of its own: it is flush with the composer's border on both sides, so the column reads as one
      // block rather than a strip parked above a box.
      className="mb-2.5 flex min-w-0 items-center gap-3 text-[12px]"
    >
      {/* THE DOOR OUT. A 24px target like its neighbours rather than the bare 12px glyph it was inside
          the old identity cluster: at the head of a run of buttons it reads as one of them, and a 12px
          hit area beside two 24px ones is a target you miss. `-ml-px` is the ink trim — the square's
          own `-mx-1.5` leaves the house glyph's ink 1px OUTSIDE the composer's border (measured), and
          the left edge is the one place in this row where a pixel of overhang is visible. */}
      {/* A ROUTER Link, like the rail's identical door at ProjectRail.tsx. It was a raw `<a href="/">`
          from 2026-08-19 until 2026-09-04, which hard-loaded the document: measured at 116-411ms with a
          0.15 CLS, and it threw away the app socket and the whole query cache on the way out. That was
          an oversight rather than a decision — the router refactor that made the rail outlive a
          navigation predates this row by a fortnight, and `/` has had its own SPA route the whole time.
          The rail is hidden under 800px and off by default, so THIS was the door most operators used. */}
      <Link to="/" title="All projects" aria-label="All projects" className={`${STATUS_ROW_ACTION} -ml-px`}>
        <House size={STATUS_ROW_ICON} aria-hidden="true" />
      </Link>
      {/* The other door out, one level down from the grid: every project's queue on one page. */}
      <Link to="/queues" title="Everything" aria-label="Everything" className={STATUS_ROW_ACTION}>
        <Inbox size={STATUS_ROW_ICON} aria-hidden="true" />
      </Link>
      <Divider />
      <button
        type="button"
        aria-label="Settings"
        title="Settings"
        className={STATUS_ROW_ACTION}
        onClick={() => (store.showSettings = true)}
      >
        <SettingsIcon size={STATUS_ROW_ICON} aria-hidden="true" />
      </button>
      {/* Renders null on a supervisor that can't restart — the gap collapses and the row stays even. */}
      <RestartFrizzButton />
      {quotaVisible && (
        <>
          <Divider />
          <QuotaChips />
        </>
      )}
      {/* THE PROJECT, pinned to the right edge. min-w-0 so a long name gives way before anything to its
          left does; every mark before it is shrink-0 and therefore always reachable. */}
      <span
        className="ml-auto flex min-w-0 items-center"
        data-project-identity-state={identity.state}
        aria-label={accessibleName}
        aria-busy={identity.state === "loading" || undefined}
      >
        {name && githubRepo ? (
          // The name IS the anchor: the same hover every other text link in the app wears
          // (GithubPickerModal's rows, ChildOpRow's labels) — full fg plus an underline — is what tells
          // a reader this one is a control, and the title says where it goes. `text-fg/90` at rest is
          // the weight and tone the name always had, so a linked and an unlinked project read alike
          // until you reach for one.
          <a
            href={`https://github.com/${githubRepo}`}
            target="_blank"
            rel="noopener"
            title={`Open ${name} on GitHub`}
            aria-label={`Open ${name} on GitHub`}
            className="block min-w-0 rounded-sm font-semibold text-fg/90 underline-offset-2 outline-none transition-colors hover:text-fg hover:underline focus-visible:ring-1 focus-visible:ring-border-strong"
          >
            <StartTruncated text={name} />
          </a>
        ) : name ? (
          // A verified NON-GitHub origin (owner/repo from GitLab, say) or a remote-less directory: the
          // name is prose, not a control, so nothing to hover.
          <StartTruncated text={name} title={name} className="font-semibold text-fg/90" />
        ) : (
          // Only before the first board keyframe, or on a keyframe with nothing nameable in it. A repo
          // with no git remote is NOT this case — it has a name (its directory) and shows it.
          <span className="identity-placeholder w-24" aria-hidden="true" />
        )}
      </span>
    </div>
  )
}
