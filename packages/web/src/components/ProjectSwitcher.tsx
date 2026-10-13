import { useState, type CSSProperties, type ReactNode } from "react"
import { Bot, Check, ChevronDown, Layers, Plus } from "lucide-react"
import type { ProjectCard } from "@ntwine/shared"
import { ProjectSquare } from "./ProjectSquare.tsx"
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "./ui/Menu.tsx"
import { useTourHoldsSwitcher } from "../lib/tour.ts"

// THE PROJECT SWITCHER — the page's TITLE, at the left end of the status row over the prompt box
// (StatusRow.tsx): which project the page is focused on, or All projects (lib/pageView.ts). It was the
// queue's FILTER until 2026-09-29, scoping the cards and nothing else while the list kept every project;
// focus mode made one project the page's default view, and the control that chose one project's cards
// became the control that chooses the page's project. It sat at the right end of the READY header until
// later that day, muted — which read as a filter on the queue, not the scope of the whole page, while the
// list's project header named the project a second time. Now it is the one place the focused project's
// name is drawn, and it is drawn as a title: full weight, in the list's project-name type.
//
//   focused:        ▣ acme-api ▾        — the page's project: its list, its queue, where a new thread goes
//   All projects:   ◫ All projects ▾
//
// The menu lists every project in the list's order, then the Home workspace under a rule with the folder
// its agents run in (as the prompt box's picker lists it), with All projects above them all as the one
// view that is not a project. Each wears its counts — its asks, its Running, and its Queue, the accent
// badge (SwitcherCounts) — as upstream's rail wore each project's on its square. Choosing one is a
// NAVIGATION (`/project/<slug>`, `/`), so Back returns to the view before.
//
// It must not read like the prompt box's project picker (AllQueues.tsx ProjectPicker), which All projects
// still has: that one says where a new thread GOES, this one what the page SHOWS. So this one is the
// page's title, above the box, and that one a pill inside the box's bottom strip beside the model.

export interface SwitcherProject {
  id: string
  slug: string
  name: string
  card: ProjectCard
  /** Its Queue — the threads at rest, one card each: the accent badge. */
  ready: number
  /** Its Running threads — spinning, the agents' move. */
  running: number
  /** The rows marked "?" (lib/phonePage.ts isAsk) — a question or a permission waiting on the human. */
  asks: number
  /** Why it cannot be chosen as a place to work — its directory is gone, or this server has not opened it. */
  note?: string
}

/** The accent count the switcher and the project list wear. */
export function QueueBadge({ count }: { count: number }) {
  return (
    <span
      aria-label={`${count} in the queue`}
      data-xq-queue-count={count}
      className="flex h-[16px] min-w-[16px] shrink-0 items-center justify-center rounded-full bg-accent-fill px-[4px] text-[10px] font-semibold leading-none proportional-nums text-on-accent"
    >
      {/* The cap band, not the line box: `items-center` centres the digits' line box, and their ink rode
          ~0.5px low in the sans UI font. Trimming to baseline→cap height makes the box the ink. */}
      <span style={{ textBox: "trim-both cap alphabetic" } as CSSProperties}>{count}</span>
    </span>
  )
}

export function ProjectSwitcher({
  projects,
  home,
  current,
  onAll,
  onProject,
  onAdd,
  homeHint,
  row = false,
}: {
  projects: SwitcherProject[]
  /** The Home workspace, listed last under its own rule. */
  home: SwitcherProject | undefined
  /** The project the page is focused on, or undefined for All projects. */
  current: SwitcherProject | undefined
  onAll: () => void
  onProject: (project: SwitcherProject) => void
  /** "Add a project", under the list: in focus mode the list's own add row is not on the page. */
  onAdd?: () => void
  /** Home's folder, beside its name. */
  homeHint?: ReactNode
  /**
   * Drawn as the project list's own head row rather than the status row's title — in an editor's sidebar,
   * which has no status row (AllQueues.tsx SidebarPage): the mark in the list's 16px indicator column and
   * the list's 8px gap to the name (ProjectList.tsx ProjectRow), so the scope reads as the list's first row.
   */
  row?: boolean
}) {
  // The first-run tour holds the menu open to point at its rows (components/Onboarding.tsx); while it does,
  // nothing closes it — the tour's own overlay takes the clicks and keys that would.
  const [open, setOpen] = useState(false)
  const held = useTourHoldsSwitcher() && !row
  const every = [...projects, ...(home ? [home] : [])]
  const total = (key: "ready" | "running" | "asks") => every.reduce((sum, project) => sum + project[key], 0)
  const name = current ? current.name : "All projects"
  const item = (project: SwitcherProject, hint?: ReactNode) => {
    const selected = current?.id === project.id
    return (
      <MenuItem key={project.id} value={project.slug} onSelect={() => onProject(project)} icon={<ProjectSquare project={project.card} size={14} />}>
        <span className={`min-w-0 flex-1 truncate ${selected ? "text-fg" : ""}`}>{project.name}</span>
        {hint && <span className="min-w-0 shrink truncate font-mono text-[10.5px] text-muted-55">{hint}</span>}
        {project.note && <span className="shrink-0 text-[10.5px] text-muted-55">{project.note}</span>}
        <SwitcherCounts asks={project.asks} running={project.running} ready={project.ready} />
        <span className="flex w-3 shrink-0 justify-center">{selected && <Check size={12} aria-label="Current" className="text-fg" />}</span>
      </MenuItem>
    )
  }
  return (
    <Menu open={held || open} onOpenChange={(next) => { if (!held) setOpen(next) }}>
      <MenuTrigger asChild>
        <button
          type="button"
          data-xq-switcher={current ? "project" : "all"}
          title={current ? `Showing ${current.name}. Switch project` : "Showing every project. Switch project"}
          aria-label={`Showing ${current ? current.name : "every project"}. Switch project`}
          // The list's project-name type (ProjectList.tsx ProjectRow), since it IS the project's name now.
          // `-ml-1.5` hangs the hover wash past the square, so the square's ink stands on the column's
          // left edge, flush with the prompt box's border below it.
          className={`-ml-1.5 flex min-w-0 items-baseline ${row ? "gap-2" : "gap-1.5"} rounded-md px-1.5 py-0.5 text-[13px] font-semibold text-fg outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60 data-[state=open]:bg-hover data-[state=open]:text-fg`}
        >
          {/* Both marks on the NAME's cap band, computed by the browser from the resolved font: the square
              has no baseline of its own, so it sits ON the name's and is lowered by half its height less
              half a cap; the 1em glyphs by half an em less half a cap (lucide's layers and chevron are
              symmetric in their boxes, so the box centre is the ink centre). */}
          {current ? (
            <span className="flex shrink-0 self-baseline translate-y-[calc(8px_-_0.5cap)]">
              <ProjectSquare project={current.card} size={16} />
            </span>
          ) : row ? (
            // The list's indicator column is 16px, the square's size; the glyph is centred in it.
            <span className="flex w-4 shrink-0 justify-center self-baseline translate-y-[calc(0.5em_-_0.5cap)]">
              <Layers size={14} aria-hidden data-xq-switcher-glyph className="text-muted" />
            </span>
          ) : (
            <Layers size={14} aria-hidden data-xq-switcher-glyph className="shrink-0 self-baseline translate-y-[calc(0.5em_-_0.5cap)] text-muted" />
          )}
          <span data-xq-switcher-label className="min-w-0 truncate">{name}</span>
          {/* Its ink 4px off the name's, closer than the square's 6px, so it reads as the name's handle rather
              than floating between the two (at `-ml-[3.5px]` both gaps measured 6.1px; scripts/ink-gaps.mjs,
              sans 13px semibold, 2026-09-29). In the list's row (`row`) the gap is the list's 8px, so the
              chevron comes 2px further back to keep the same 4px: 5.97px → 3.97px beside "acme-api", 5.24px →
              3.24px beside "All projects" — the status row's own reading there (2026-10-01, sidebar, 300px). */}
          <ChevronDown size={12} aria-hidden data-xq-switcher-chevron className={`${row ? "-ml-[7.5px]" : "-ml-[5.5px]"} shrink-0 self-baseline translate-y-[calc(0.5em_-_0.5cap)] text-muted`} />
        </button>
      </MenuTrigger>
      <MenuContent align="start">
        <div className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-medium text-muted-55">Show</div>
        {/* Every item outside the scrolling list is inset by the gutter that list reserves (styles.css
            `scrollbar-gutter: stable`), so the badges and check marks stand in one column. */}
        <div data-tour="switcher-all" className="pr-[var(--sbw)]">
          <MenuItem onSelect={onAll} icon={<Layers size={14} aria-hidden />} value="all-projects">
            <span className={`min-w-0 flex-1 truncate ${current ? "" : "text-fg"}`}>All projects</span>
            <SwitcherCounts asks={total("asks")} running={total("running")} ready={total("ready")} />
            <span className="flex w-3 shrink-0 justify-center">{!current && <Check size={12} aria-label="Current" className="text-fg" />}</span>
          </MenuItem>
        </div>
        <MenuSeparator />
        <div data-tour="switcher-projects" className="max-h-[min(50vh,360px)] overflow-y-auto">{projects.map((project) => item(project))}</div>
        {home && (
          <>
            {projects.length > 0 && <MenuSeparator />}
            {/* Outside the scrolling list, so it never scrolls away. */}
            <div className="pr-[var(--sbw)]">{item(home, homeHint)}</div>
          </>
        )}
        {onAdd && (
          <>
            <MenuSeparator />
            <div data-tour="switcher-add" className="pr-[var(--sbw)]">
              <MenuItem onSelect={onAdd} icon={<Plus size={14} aria-hidden />} value="add-project">
                <span className="min-w-0 flex-1 truncate">Add a project</span>
              </MenuItem>
            </div>
          </>
        )}
      </MenuContent>
    </Menu>
  )
}

/**
 * A PROJECT'S COUNTS in the switcher's menu, right to left from the check column: its Queue (the accent
 * badge — the one number in the menu that is the human's to clear), its Running (the bot, the band's own
 * glyph, BandLabel.tsx), and its asks (the "?" a waiting question or permission wears on its row, in the
 * accent: those are the Queue rows that cannot move without the human). Each only when non-zero, so a quiet
 * project's line is its name alone. Upstream's rail counted the same three per project (ProjectRail.tsx
 * useRailCounts: queued, running, asks); the menu is where the fork lists every project.
 */
function SwitcherCounts({ asks, running, ready }: { asks: number; running: number; ready: number }) {
  if (asks + running + ready === 0) return null
  const said = [asks ? `${asks} waiting on you` : null, running ? `${running} running` : null, ready ? `${ready} in the queue` : null].filter(Boolean).join(", ")
  return (
    <span data-xq-switcher-counts title={said} className="flex shrink-0 items-center gap-2 text-[10.5px] text-muted-55">
      {asks > 0 && (
        <span data-xq-switcher-asks={asks} aria-label={`${asks} waiting on you`} className="flex items-baseline gap-[3px] font-semibold text-accent">
          <span aria-hidden>?</span>
          <span className="tabular-nums">{asks}</span>
        </span>
      )}
      {running > 0 && (
        <span data-xq-switcher-running={running} aria-label={`${running} running`} className="flex items-baseline gap-[3px]">
          {/* The bot's face on the digits' cap band (Sidebar.tsx SubAgentCount measured it: the face centres
              4.17px above the bottom of a 10px box). */}
          <span aria-hidden className="flex self-baseline translate-y-[calc(4.17px_-_0.5cap)]">
            <Bot size={10} />
          </span>
          <span className="tabular-nums">{running}</span>
        </span>
      )}
      {ready > 0 && <QueueBadge count={ready} />}
    </span>
  )
}
