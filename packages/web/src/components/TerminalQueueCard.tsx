import { lazy, Suspense, useState, type MouseEvent as ReactMouseEvent } from "react"
import { RotateCcw } from "lucide-react"
import { terminalOutcome } from "@ntwine/shared"
import { projectRpc } from "../api/rpc.ts"
import { ThreadProjectScope, useThreadApiBase } from "../api/threadApi.tsx"
import { displayTitle, queueLabelAt, queueLabelWord } from "../groups.ts"
import { HEADER_ICON_CLASS } from "../lib/headerIcon.ts"
import { abbreviateHome } from "../lib/paths.ts"
import { isPlainLeftClick } from "../lib/plainClick.ts"
import { terminalStateLabel } from "../lib/threadTerminals.ts"
import { showToast } from "../store.ts"
import { crossProjectThreadHref, ProjectChip, ProjectMark, useOpenThreadInPlace, type AllQueuesCardProps } from "./AllQueuesCard.tsx"
import { LastActive } from "./LastActive.tsx"
import { TerminalFollowUp } from "./TerminalFollowUp.tsx"
import { TerminalControlBar, terminalDriver } from "./TerminalControlBar.tsx"
import { FACTS_LINE_CLASS, Fact, FactSep } from "./ThreadHeaderFacts.tsx"
import { ThreadLifecycleActions } from "./ThreadLifecycle.tsx"
import { Tooltip } from "./Tooltip.tsx"
import { BLOCK_RADIUS } from "./TranscriptCard.tsx"

// LAZY for the same reason every xterm consumer is: @xterm/xterm is browser-only.
const TerminalPane = lazy(() => import("./TerminalPane.tsx").then((m) => ({ default: m.TerminalPane })))

// A TERMINAL THREAD'S QUEUE CARD (plans/terminal-threads.md § Lifecycle). It is in the queue for one of three
// reasons, and the card is the answer to each: at a PROMPT, its live screen to type the answer into; FAILED
// or INTERRUPTED, its last screen, Restart, and a `$` line for the next command. The header carries the
// lifecycle verbs every card does — snooze to a time, Mark as done — so nothing here is only dismissible.
export function TerminalCardArticle({ project, thread, onLeave, onReturn, onSent = onLeave, onLanded = () => {}, chip = false, onChoose }: AllQueuesCardProps) {
  const terminal = thread.terminal
  const openInPlace = useOpenThreadInPlace()
  if (!terminal) return null
  const outcome = terminalOutcome(terminal)
  const href = crossProjectThreadHref(project, thread.id)
  const openHere = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (!isPlainLeftClick(event)) return
    event.preventDefault()
    openInPlace(project, thread.id, displayTitle(thread))
  }
  const said = terminalStateLabel(terminal)
  const tone = outcome === "prompt" || outcome === "interrupted" ? "text-attention" : outcome === "failed" ? "text-danger-soft" : ""
  // The folder only off the project root, as its row names it: at the root it would repeat the project chip.
  const folder = terminal.cwd && !terminal.atRoot ? abbreviateHome(terminal.cwd, project.homeDir) : undefined
  // A thread drives it (plans/terminal-threads.md § Control): its screen and `$` line are read-only until the
  // human takes control, from the bar over the screen.
  const driver = terminalDriver(terminal)
  const threads = [...project.queued, ...project.running, ...project.snoozed, ...project.pinnedDone, ...project.recentDone]
  const move = (to: string, back?: boolean) => projectRpc(project.id).terminalControl({ id: thread.id, to, ...(back ? { back: true } : {}) })
  return (
    <article
      data-xq-card-root
      data-terminal-card={thread.id}
      aria-label={terminal.command}
      className={`ntwine-card-body flex min-w-0 max-w-full flex-col ${BLOCK_RADIUS} border border-border-strong bg-panel shadow-lg shadow-shadow-ink/25`}
    >
      <header className="flex items-center gap-3 rounded-t-xl border-b border-border/60 px-5 py-3.5">
        {chip && <ProjectMark project={project} onChoose={onChoose} />}
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-semibold leading-snug" title={terminal.command}>
            {/* The command is its name, in the face it is typed in; the title is the drawer's door, `o` presses it. */}
            <a href={href} onClick={openHere} data-command="open" className="rounded-sm outline-none hover:underline hover:underline-offset-2 focus-visible:ring-1 focus-visible:ring-focus-ink-60">
              <span aria-hidden className="font-mono-keep text-[14px] font-normal leading-none text-muted-55">$ </span>
              <span className="font-mono-keep text-[14px] leading-none">{terminal.command}</span>
            </a>
          </h3>
          <div data-facts-line className={`mt-0.5 ${FACTS_LINE_CLASS} text-[11px] leading-tight text-muted-75`}>
            {chip && <Fact><ProjectChip project={project} onChoose={onChoose} square={false} /></Fact>}
            <Fact><FactSep /><span data-terminal-card-state className={tone}>{said}</span></Fact>
            <Fact><LastActive at={queueLabelAt(thread)} label={queueLabelWord(thread)} fallbackAt={thread.spawnedAt} lead={<FactSep />} className="min-w-0 truncate" /></Fact>
            {folder && <Fact give="6em"><FactSep /><span className="min-w-0 truncate" title={terminal.cwd}>{folder}</span></Fact>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {terminal.state === "exited" && !driver && <RestartButton projectId={project.id} id={thread.id} onSent={onSent} onLanded={onLanded} onFailed={onReturn} />}
          <ThreadProjectScope projectId={project.id} projectDir={project.projectDir}>
            <ThreadLifecycleActions
              thread={thread}
              className="-mr-2"
              projectName={project.name}
              onSnoozed={onLeave}
              onUnsnoozed={onReturn}
              onArchived={onSent}
              onDismissCancel={onReturn}
              onCompleted={onLanded}
            />
          </ThreadProjectScope>
        </div>
      </header>
      <ThreadProjectScope projectId={project.id} projectDir={project.projectDir}>
        <div className="px-5 pb-4 pt-4">
          <div className={`overflow-hidden rounded-md border ${outcome === "prompt" ? "border-attention/40" : "border-border"}`}>
            <TerminalControlBar terminal={terminal} threads={threads} move={move} />
            <CardScreen id={thread.id} runId={terminal.runId} readOnly={Boolean(driver)} />
          </div>
        </div>
        {terminal.state === "exited" && !driver && (
          <div className="border-t border-border/60 px-5 pb-3 pt-3">
            <TerminalFollowUp key={terminal.runId} id={thread.id} lastCommand={terminal.shell ? "" : terminal.command} onRan={() => { onSent(); onLanded() }} />
          </div>
        )}
      </ThreadProjectScope>
    </article>
  )
}

/** The screen: live at a prompt, the last one after an exit. Keyed on the run, so a restart is a fresh screen;
 *  no focus grab, because a card is one of many. A prompt's border is the attention colour of its band. */
function CardScreen({ id, runId, readOnly }: { id: string; runId: number; readOnly: boolean }) {
  const base = useThreadApiBase()
  return (
    <div data-terminal-card-screen={id} className="flex h-[220px] min-w-0 overflow-hidden">
      <Suspense fallback={<div className="flex-1 bg-bg" />}>
        <TerminalPane key={`${id}:${runId}`} id={id} base={base} focusOnMount={false} readOnly={readOnly} exitedStatus={() => null} />
      </Suspense>
    </div>
  )
}

function RestartButton({ projectId, id, onSent, onLanded, onFailed }: { projectId: string; id: string; onSent: () => void; onLanded: () => void; onFailed: () => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <Tooltip label="Restart">
      <button
        type="button"
        aria-label="Restart"
        data-terminal-card-restart={id}
        disabled={busy}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          setBusy(true)
          onSent()
          projectRpc(projectId).terminalRestart({ id })
            .then(onLanded)
            .catch((error: unknown) => {
              onFailed()
              showToast(`Could not restart: ${(error instanceof Error ? error.message : String(error)).slice(0, 80)}`)
            })
            .finally(() => setBusy(false))
        }}
        className={HEADER_ICON_CLASS}
      >
        <RotateCcw size={14} />
      </button>
    </Tooltip>
  )
}
