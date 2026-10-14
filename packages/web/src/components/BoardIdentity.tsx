import { useState } from "react"
import { Ellipsis } from "lucide-react"
import { useNavigate } from "react-router"
import type { QueuesProject } from "../lib/allQueues.ts"
import { rememberCrossProjectFocus } from "../lib/crossProject.ts"
import { ALL_PROJECTS, viewHref } from "../lib/pageView.ts"
import { STATUS_ROW_ACTION } from "../lib/statusRow.ts"
import { glideTo } from "../lib/viewportLock.ts"
import { ProjectMenu } from "./ProjectActions.tsx"

/**
 * THE BOARD'S IDENTITY, beside the project's title in the status row (StatusRow.tsx `identity`): the project's
 * `owner/repo`, a link to it on GitHub when its origin is there (upstream's StatusRow, maintainer
 * 2026-08-28: "Perhaps it should actually be showing owner/repo if a repo is detected"), and the project's
 * "…" menu — its icon, rename, delete and the way back to All projects — which in All projects rides the
 * project's square in the dock (ProjectDock.tsx). The menu shows on hover and
 * focus, as it does on that row.
 */
export function BoardIdentity({ project, home }: { project: QueuesProject; home: string | undefined }) {
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const repo = project.githubRepo
  return (
    <span data-xq-board-identity className="group/identity flex min-w-0 items-center gap-3">
      {repo && (
        <a
          href={`https://github.com/${repo}`}
          target="_blank"
          rel="noopener"
          data-xq-board-repo
          title={`Open ${repo} on GitHub`}
          aria-label={`Open ${repo} on GitHub`}
          // Muted beside the title's name: the name is the page's title, the repo its address.
          className="block min-w-0 rounded-sm text-[12px] text-muted-70 underline-offset-2 outline-none transition-colors hover:text-fg hover:underline focus-visible:ring-1 focus-visible:ring-border-strong"
        >
          <StartTruncated text={repo} />
        </a>
      )}
      {project.card && (
        <span className={`shrink-0 items-center group-hover/identity:flex group-has-[:focus-visible]/identity:flex [@media(hover:none)]:flex ${menuOpen ? "flex" : "hidden"}`}>
          <ProjectMenu
            project={project.card}
            home={home}
            githubRepo={repo}
            focused
            onFocus={() => {
              // Leaving a project for All projects carries it over as the prompt box's pick, as the
              // dock does (AllQueues.tsx useChooseView).
              rememberCrossProjectFocus(project.id)
              navigate(viewHref(ALL_PROJECTS))
              glideTo(() => 0)
            }}
            onOpenChange={setMenuOpen}
          >
            <button type="button" aria-label={`More actions for ${project.name}`} className={`${STATUS_ROW_ACTION} data-[state=open]:text-fg`}>
              <Ellipsis size={13} />
            </button>
          </ProjectMenu>
        </span>
      )}
    </span>
  )
}

/**
 * `owner/repo` clipped from the START, so it is the owner that gives way — "…divad/ntwine", never
 * "ssalbdivad/n…" (upstream StatusRow.tsx StartTruncated): `direction: rtl` moves the overflow and its
 * ellipsis to the left, and the text is re-isolated LTR so its letters and slash keep their order. A repo
 * name ends in a strong LTR character, which this needs.
 */
function StartTruncated({ text }: { text: string }) {
  return (
    <span dir="rtl" className="block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
      <span dir="ltr" className="[unicode-bidi:isolate]">{text}</span>
    </span>
  )
}
