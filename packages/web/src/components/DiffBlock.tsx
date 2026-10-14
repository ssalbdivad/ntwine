import { useEffect, useId, useMemo, useState } from "react"
import { useSnapshot } from "valtio"
import type { TranscriptEdit } from "@ntwine/shared"
import { renderDiff, type DiffHunk } from "../lib/diff/index.ts"
import "../lib/diff/diff.css"
import { openLocalPath } from "../lib/local-file-links.ts"
import { basename } from "../lib/paths.ts"
import { prefs } from "../lib/prefs.ts"
import { ToolDisclosureHeader } from "./ToolDisclosureHeader.ts"

// A file path rendered as an openable link. Plain (inherits the surrounding gray); brightens +
// underlines on hover. Used by the tool-call one-liners and the diff header.
//
// It opens through `openLocalPath`, the same route every other local-path click in the app takes, so it
// honours the "Local file links" setting. It used to render `<a href="cursor://file/Users/…">` and let
// the OS resolve the scheme — which meant it ALWAYS landed in Cursor, whatever the setting said.
export function PathLink({ path, className = "", children }: { path: string; className?: string; children?: React.ReactNode }) {
  return (
    // A button, not an anchor: there is no URL to navigate to, and ToolDisclosureHeader recognises a
    // button as an action of its own and stands down, so the click opens the file instead of toggling
    // the row. It TRUNCATES ITSELF rather than leaning on the ancestor `truncate` the anchor sat under:
    // Blink blockifies a button (`display: inline` computes to `inline-block` however you ask), so an
    // over-long path stopped being part of the parent's line box and got hard-clipped mid-glyph with no
    // ellipsis. Measured at a 240px width: the inline-block overflowed its 174px wrapper by 350px; block
    // + truncate lands on 174px exactly, and sits 0.2px off the label's box instead of the anchor's
    // 2.4px. File paths ALWAYS render mono, even under the sans app font.
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); openLocalPath(path) }}
      title={path}
      className={`font-mono-keep block max-w-full cursor-pointer truncate text-left hover:underline hover:text-fg/80 ${className}`}
    >
      {children ?? path}
    </button>
  )
}

// The header shows the basename (lib/paths.ts — either separator); the full path stays in the link title.

// A gent-style rendered diff for a group of Edit/Write/MultiEdit calls that all touch ONE file
// (consecutive same-file edits merge upstream in collapseTools): a bordered block with a header row
// (clickable file path + summed +N/−N counts) and a syntax-highlighted, line-numbered body. Multiple
// edits stack as sequential hunk groups under the one header, divided by a hairline. Wide diffs
// scroll horizontally INSIDE the body (never the page). In compact mode the body is hidden — the
// header alone shows — and its explicit chevron control expands that one block.
export function DiffBlock({ edits, meta }: { edits: TranscriptEdit[]; meta?: React.ReactNode }) {
  const { compactDiffs } = useSnapshot(prefs)
  const bodyId = useId()
  const file = edits[0].file
  const diffs = useMemo(() => edits.map((e) => renderDiff(e.old, e.new, e.file)), [edits])
  const additions = diffs.reduce((n, d) => n + d.additions, 0)
  const deletions = diffs.reduce((n, d) => n + d.deletions, 0)

  // COLLAPSED BY DEFAULT — full card-family consistency (Bash/Read/Agent all open on demand; the
  // maintainer settled the deferred question 2026-07-09). The Settings "compact diffs" toggle is the
  // escape hatch: switching it OFF returns to expanded-by-default. A per-block click overrides either
  // way, and re-syncing the override to null when the global flips lets the switch drive every block.
  const [override, setOverride] = useState<boolean | null>(null)
  useEffect(() => setOverride(null), [compactDiffs])
  const open = override ?? !compactDiffs

  return (
    <div className="ntwine-diff">
      <ToolDisclosureHeader
        className="ntwine-diff-header"
        controls={bodyId}
        expanded={open}
        label={`${open ? "Collapse" : "Expand"} Edit diff: ${file}`}
        onToggle={() => setOverride(!open)}
        meta={meta}
      >
        {/* Left group: petite-caps "Edit" label (sibling of Bash/Read), file path, +N −M summary. The
            chevron is pushed to the far right by the header's space-between (aligns the three families). */}
        <span className="petite-caps ntwine-bash-label shrink-0">Edit</span>
        <span className="ntwine-diff-file">
          <PathLink path={file} className="text-inherit no-underline">
            {basename(file)}
          </PathLink>
        </span>
        {additions > 0 && <span className="ntwine-diff-add tabular-nums shrink-0">+{additions}</span>}
        {deletions > 0 && <span className="ntwine-diff-del tabular-nums shrink-0">−{deletions}</span>}
      </ToolDisclosureHeader>
      <div id={bodyId} className="ntwine-diff-body" hidden={!open}>
        {open && diffs.map((d, i) => (
          <div key={i} className={i > 0 ? "ntwine-diff-editsep" : undefined}>
            <DiffBody hunks={d.hunks} collapsedAfter={d.collapsedAfter} />
          </div>
        ))}
      </div>
    </div>
  )
}

function DiffBody({ hunks, collapsedAfter }: { hunks: DiffHunk[]; collapsedAfter: number }) {
  // collapsedBefore is an absolute start index; the count of unchanged lines hidden immediately
  // before a hunk is that index minus where the previous hunk ended.
  let prevEnd = 0
  const rows: React.ReactNode[] = []
  hunks.forEach((h, hi) => {
    const gap = h.collapsedBefore - prevEnd
    if (gap > 0) rows.push(<Sep key={`s${hi}`} n={gap} />)
    for (const l of h.lines) {
      const num = l.type === "del" ? l.oldLine : l.newLine
      const sign = l.type === "add" ? "+" : l.type === "del" ? "-" : " "
      rows.push(
        <div key={`${hi}:${l.oldLine}:${l.newLine}`} className="ntwine-diff-line" data-type={l.type}>
          <span className="ntwine-diff-gutter">{num}</span>
          <span className="ntwine-diff-sign">{sign}</span>
          <span className="ntwine-diff-code">
            {l.tokens.map((t, i) => (
              <span key={i} className={`ftk-${t.kind}`}>{t.text}</span>
            ))}
          </span>
        </div>,
      )
    }
    prevEnd = h.collapsedBefore + h.lines.length
  })
  if (collapsedAfter > 0) rows.push(<Sep key="safter" n={collapsedAfter} />)
  return <>{rows}</>
}

function Sep({ n }: { n: number }) {
  return <div className="ntwine-diff-sep">{n} unchanged line{n === 1 ? "" : "s"}</div>
}
