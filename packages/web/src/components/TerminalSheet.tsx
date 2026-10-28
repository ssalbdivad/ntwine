import { lazy, Suspense, useRef, useState, type ReactNode } from "react"
import { Bot, Check, Copy, RotateCcw, SquareTerminal, Trash2 } from "lucide-react"
import type { BackgroundShellOutputResult, ThreadTerminal, WorkCheckout } from "@ntwine/shared"
import { rpc } from "../api/rpc.ts"
import { showToast, threadBySlug } from "../store.ts"
import { useBoard, useShellLog } from "../hooks.ts"
import { copyTextToClipboard } from "../lib/clipboard.ts"
import { dismissChildOp } from "../lib/dismissChildOp.ts"
import { liveAgeSince } from "../lib/durationLabels.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { displayTitle } from "../groups.ts"
import { abbreviateHome } from "../lib/paths.ts"
import { shellBudgetLabel } from "../lib/shellBudget.ts"
import { terminalFailed, terminalOf, terminalStateLabel } from "../lib/threadTerminals.ts"
import { Sheet } from "./ui/Sheet.tsx"
import { SheetHeader } from "./ui/SheetHeader.tsx"
import { TerminalFollowUp } from "./TerminalFollowUp.tsx"
import { TerminalControlBar, TerminalMoreMenu, terminalDriver } from "./TerminalControlBar.tsx"

// LAZY for the same reason as every xterm consumer: @xterm/xterm is browser-only, and node (tests)
// imports the drawer stack transitively.
const TerminalPane = lazy(() => import("./TerminalPane.tsx").then((m) => ({ default: m.TerminalPane })))
const ShellLogPane = lazy(() => import("./ShellLogPane.tsx").then((m) => ({ default: m.ShellLogPane })))

const actionClass = "rounded-md border border-border-strong bg-panel-2/60 px-2.5 py-1 text-[12px] text-fg/80 transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-50"
const stopClass = `${actionClass} hover:border-danger/40 hover:bg-danger/10 hover:text-danger-soft`
const EMPTY = "flex flex-1 items-center justify-center px-8 text-center text-[13px] text-muted"

/** Whose terminal a drawer shows: yours (a pty over /term/<id>), or the agent's (its log, read-only). */
export type TerminalSource = { owner: "human"; terminalId: string } | { owner: "agent"; shellId: string }

// THE ONE TERMINAL DRAWER, for both owners (David 2026-09-29: an agent's terminal "introspectable the
// same way" as yours). Stacked over the thread it belongs to; the same header anatomy either way — the
// owner's glyph, what it runs, the folder it started in (with `· worktree` when that is a linked worktree),
// how it stands — and an xterm body. What differs is what is honest for each:
//   · YOURS is the live pty. It takes keystrokes itself, so answering a prompt or pressing Ctrl-C happens
//     right in it; Stop, Restart and Remove sit in the header; once it has finished, the foot is the next
//     command line (TerminalFollowUp), the way a rested thread's foot is its next prompt.
//   · THE AGENT'S is read-only. Its output is the log file the harness writes (no pty), streamed by offset
//     into the same xterm so colour and progress bars render; typing does nothing. The header offers Copy
//     command and Stop, and the foot says whose it is.
// There is no Done here: a terminal is not a thread, and it ends with the thread it belongs to (marking the
// thread done stops yours) or on its own Stop / Remove.
export function TerminalSheet({ id, slug, source, label, startedAt, depth, widthDepth }: {
  id: number
  slug: string
  source: TerminalSource
  /** The row's own name for it, shown until the first read answers. */
  label?: string
  startedAt?: string
  depth: number
  widthDepth: number
}) {
  return source.owner === "human"
    ? <HumanTerminalSheet id={id} slug={slug} terminalId={source.terminalId} depth={depth} widthDepth={widthDepth} />
    : <AgentTerminalSheet id={id} slug={slug} shellId={source.shellId} label={label} startedAt={startedAt} depth={depth} widthDepth={widthDepth} />
}

/** The header's second line: the folder, and whether it is a worktree. */
export function terminalSubtitle(cwd: string | undefined, checkout: WorkCheckout | null | undefined, homeDir: string | undefined): string | undefined {
  if (!cwd) return undefined
  return `${abbreviateHome(cwd, homeDir)}${checkout?.kind === "worktree" ? " · worktree" : ""}`
}

/** A folder split for the header: everything up to and including the last separator (the part that may be
 *  cut) and the last segment (the part that names the place, and stays). The separator rides the HEAD
 *  because Chrome's start-side ellipsis always keeps the one character nearest the cut: with the slash
 *  there, the least the head shows is `…/`, where with a letter there it drew `…s/probe` (390px, dsf 6). */
export function splitFolder(path: string): { head: string; tail: string } {
  const trimmed = path.length > 1 ? path.replace(/[\\/]+$/, "") : path
  const at = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  // A head of a character or two (`~`) is shorter than the ellipsis it would shrink to, so it is kept whole.
  return at <= 2 ? { head: "", tail: trimmed } : { head: trimmed.slice(0, at + 1), tail: trimmed.slice(at + 1) }
}

// THE SAME LINE, laid out so a narrow drawer loses the right part of it — and never the part that says where.
// A path truncated at its END cut away both the folder that names the worktree and the ` · worktree` after it
// (`/tmp/tu-v-repo/.ntwine/worktr…`). So the path truncates at its START, by the right-to-left overflow idiom
// around an isolated left-to-right run (so the slashes stay where they are).
//
// AND ITS LAST SEGMENT IS KEPT, with the kind: the head shrinks to `…/` and no further, and the tail
// (`probe`, 16ch at most, ellipsized past that) and ` · worktree` never shrink. With the head alone truncating,
// a narrow header whose second line also carries `waiting for input · 4m` shrank the WHOLE path to 0px and
// left ` · worktree` orphaned, clipped mid-word at 390px (2026-09-30). The head's `w-0` makes it count
// nothing toward this line's minimum bar its 1.5em floor — `…/`, the ellipsis and the slash Chrome keeps
// beside it — so the minimum SheetHeader keeps
// (its `subtitleKeeps`) is exactly `…/probe · worktree`; `grow` and `max-w-max` give the head back up to its
// whole width whenever the line has room.
export function TerminalSubtitle({ cwd, checkout, homeDir }: { cwd: string; checkout: WorkCheckout | null | undefined; homeDir: string | undefined }): ReactNode {
  const { head, tail } = splitFolder(abbreviateHome(cwd, homeDir))
  return (
    <span data-terminal-subtitle className="flex min-w-0" title={terminalSubtitle(cwd, checkout, homeDir)}>
      {head ? <span data-terminal-subtitle-head dir="rtl" className="w-0 min-w-[1.5em] max-w-max grow truncate text-left"><bdi>{head}</bdi></span> : null}
      <span data-terminal-subtitle-tail className="max-w-[16ch] shrink-0 truncate">{tail}</span>
      {checkout?.kind === "worktree" ? <span data-terminal-subtitle-kind className="shrink-0 whitespace-pre"> · worktree</span> : null}
    </span>
  )
}

/** A named terminal's drawer subtitle: `$ pnpm run dev` in mono, then its folder (TerminalSubtitle). The command
 *  gives way first — the name above already says which program it is — and the folder keeps its last part.
 *  The command is sized from zero (`w-0 grow`, as TerminalSubtitle's head is) so the line's min-content stays
 *  the folder's kept part: as a plain shrinking run its whole width was the line's min-content, and under 28rem
 *  (SheetHeader `subtitleKeeps`) it pushed the reading off the line and ran under the actions (420px). Under 28rem
 *  it is not drawn at all: the line is then the reading and the folder, which squeezed to `wai…` and `$ …`
 *  beside it; the command is the line's tooltip there, and on the screen below. */
function TerminalCommandSubtitle({ terminal, homeDir }: { terminal: ThreadTerminal; homeDir: string | undefined }): ReactNode {
  return (
    <span data-terminal-subtitle-line className="flex min-w-0 items-baseline" title={`$ ${terminal.command}`}>
      <span data-terminal-subtitle-command className="w-0 min-w-[2em] max-w-max grow truncate font-mono-keep text-[9.5px] @max-[28rem]:hidden" title={terminal.command}>{`$ ${terminal.command}`}</span>
      {terminal.cwd ? (
        <>
          <span className="shrink-0 whitespace-pre @max-[28rem]:hidden"> · </span>
          <TerminalSubtitle cwd={terminal.cwd} checkout={terminal.checkout} homeDir={homeDir} />
        </>
      ) : null}
    </span>
  )
}

// A HEADER ACTION'S LABEL: the words where there is room, the glyph where there is not. Both drawers'
// headers are size containers (the wrapper around each SheetHeader), and under 28rem — a phone, or a
// narrow split — two or three worded buttons took all the width and left the TITLE 0px wide beside them
// (verified at 420px, 2026-09-29). Stop keeps its word at every width: it is the one action that ends
// something, and the one a glyph would make easiest to hit by mistake.
function NarrowGlyph({ icon: Icon, text }: { icon: typeof Copy; text: string }) {
  return (
    <>
      <span className="@max-[28rem]:hidden">{text}</span>
      <Icon aria-hidden size={13} className="hidden @max-[28rem]:block" />
    </>
  )
}

/** A terminal's state, its age while it runs, and (the agent's) what is left of its budget — the same
 *  reading in both drawers' headers, joined the way every reading in the app is. */
export function StateReading({ state, age, budget, tone, stopShown, attr }: {
  state: string
  age?: string
  budget?: string
  tone?: "attention" | "danger"
  /** The header shows a Stop — which already says the terminal is running, so a narrow header drops the
   *  word `running` and keeps the numbers. */
  stopShown?: boolean
  attr: Record<string, string | undefined>
}) {
  // THE READING NEVER BREAKS MID-WORD. It truncated as one run, so a narrow header drew `running · 34m left
  // · 2…` — `2…` is not a duration — and `waiting for input…` with its age cut off. It is now a line of whole
  // parts, one line tall and clipped (SheetHeader gives it up to 70% of its line): a part that does not fit
  // wraps away WHOLE, the last first — the age, then the budget — and only the state word, alone, can end in
  // an ellipsis. Under 28rem `running` goes when a Stop stands beside it (`stopShown`), as it said nothing the
  // button did not, and the title had given its width to it.
  const quietState = stopShown && state === "running"
  const parts = [budget, age].filter((part): part is string => Boolean(part))
  return (
    <span {...attr} className="flex h-[1lh] min-w-0 flex-wrap items-baseline overflow-hidden whitespace-nowrap text-[11.5px] text-muted-60">
      <span className={`min-w-0 truncate ${quietState ? "@max-[28rem]:hidden" : ""} ${tone === "attention" ? "text-attention" : tone === "danger" ? "text-danger-soft" : ""}`}>{state}</span>
      {/* The budget before the age, as the strip and the rail read the same shell: one order everywhere. */}
      {parts.map((part, i) => (
        <span key={i} data-reading-part className="shrink-0">
          {/* `whitespace-pre`, or the separator's leading space is lost: a part is a flex item, and a space
              opening a flex item's line is collapsed away, which drew `running· 43m left· 16m`. */}
          <span className={i === 0 && quietState ? "whitespace-pre @max-[28rem]:hidden" : "whitespace-pre"}>{" · "}</span>
          {part}
        </span>
      ))}
    </span>
  )
}

// The pane is keyed on the RUN, not the terminal: Restart starts a fresh process, and the browser should
// see a fresh screen rather than the new process's output appended under the old one's.
function HumanTerminalSheet({ id, slug, terminalId, depth, widthDepth }: { id: number; slug: string; terminalId: string; depth: number; widthDepth: number }) {
  const board = useBoard()
  const thread = threadBySlug(board, slug)
  // The terminal's own row first (it is a thread of its own), then the strip of the thread it was opened
  // over — which drops it once it is Done, while its own row keeps it.
  const own = threadBySlug(board, terminalId)
  const terminal = terminalOf(own, terminalId) ?? terminalOf(thread, terminalId)
  const filed = own?.kind === "terminal" && own.state === "archived"
  // The drawer opens the moment the start RPC answers, which can beat the board delta carrying the
  // terminal. Until it has been seen once, its absence means "starting", not "gone".
  const seen = useRef(false)
  if (terminal) seen.current = true
  const [pending, setPending] = useState<TerminalAct | null>(null)
  const threads = board?.threads ?? []
  // A thread drives it (plans/terminal-threads.md § Control): the screen and the `$` line are read-only, and
  // Stop and Restart wait for Take control; Mark as done and Remove stay, as the human outranks any driver.
  const driver = terminalDriver(terminal)
  const move = (to: string, back?: boolean) => rpc.terminalControl({ id: terminalId, to, ...(back ? { back: true } : {}) })

  function act(kind: TerminalAct, close: () => void) {
    if (pending) return
    setPending(kind)
    const call = kind === "stop" ? rpc.terminalStop({ id: terminalId })
      : kind === "restart" ? rpc.terminalRestart({ id: terminalId })
      : kind === "done" ? rpc.setThreadState({ slug: terminalId, state: "archived" })
      : rpc.terminalRemove({ id: terminalId })
    call
      .then(() => {
        if (kind === "remove" || kind === "done") close()
      })
      .catch((error: unknown) => showToast(error instanceof Error ? error.message : `Could not ${kind} this terminal`))
      .finally(() => setPending(null))
  }

  return (
    <Sheet id={id} depth={depth} widthDepth={widthDepth}>
      {(close) => (
        <>
          <HumanTerminalHeader
            terminal={terminal}
            fallbackSubtitle={thread ? displayTitle(thread) : undefined}
            homeDir={board?.homeDir}
            pending={pending}
            done={filed}
            onAct={(kind) => act(kind, close)}
            onClose={close}
            driven={Boolean(driver)}
            more={terminal ? <TerminalMoreMenu terminal={terminal} threads={threads} move={move} triggerClass={actionClass} /> : undefined}
          />
          {terminal ? (
            <>
              <TerminalControlBar terminal={terminal} threads={threads} move={move} />
              <Suspense fallback={<div className="flex-1 bg-bg" />}>
                {/* No exited bar: the header states how the run ended and carries Restart, and the foot
                    below is where the next command goes. */}
                <TerminalPane key={`${terminalId}:${terminal.runId}`} id={terminalId} focusOnMount={terminal.state === "running" && !driver} readOnly={Boolean(driver)} exitedStatus={() => null} />
              </Suspense>
              {terminal.state === "exited" && !driver ? (
                <div className="shrink-0 border-t border-border/70 bg-panel px-3 py-2.5">
                  {/* Keyed on the run, so each finished run takes focus afresh — straight from the terminal
                      the human was just typing into, or on opening a finished one. */}
                  <TerminalFollowUp key={terminal.runId} id={terminalId} lastCommand={terminal.shell ? "" : terminal.command} autoFocus />
                </div>
              ) : null}
            </>
          ) : (
            <div className={EMPTY}>{seen.current || !thread ? "This terminal is closed." : "Starting…"}</div>
          )}
        </>
      )}
    </Sheet>
  )
}

/** YOUR TERMINAL'S DRAWER HEADER — the command, where it runs, how it stands, and its actions — split out so
 *  the terminals fixture draws the very header the drawer does (terminals-unified-fixture `?mode=header`). */
export type TerminalAct = "stop" | "restart" | "remove" | "done"

export function HumanTerminalHeader({ terminal, fallbackSubtitle, homeDir, pending, done = true, onAct, onClose, driven = false, more }: {
  terminal: ThreadTerminal | undefined
  /** The thread's title, for a terminal with no folder (or none yet). */
  fallbackSubtitle?: string
  homeDir: string | undefined
  pending: TerminalAct | null
  /** Already Done — so no Mark as done. A terminal is a thread of its own, and Done is its to reach. */
  done?: boolean
  onAct: (kind: TerminalAct) => void
  onClose: () => void
  /** A thread drives it: Stop and Restart wait until the human takes control. */
  driven?: boolean
  /** The ⋯ menu (Let an agent drive), last in the row. */
  more?: ReactNode
}) {
  // A size container, so the header's secondary actions fold to glyphs when the drawer is narrow.
  return (
    <div className="@container shrink-0">
      <SheetHeader
        // Titled by its NAME, its `@handle`, as a thread's drawer is: the row you click and the drawer it opens
        // name one thing. The command it runs leads the subtitle, in mono as every surface sets a command. A
        // terminal from before handles existed is titled by its command instead, in that same mono.
        title={terminal?.handle ?? terminal?.command ?? "Terminal"}
        titleMono={Boolean(terminal && !terminal.handle)}
        subtitle={terminal?.handle ? <TerminalCommandSubtitle terminal={terminal} homeDir={homeDir} /> : terminal?.cwd ? <TerminalSubtitle cwd={terminal.cwd} checkout={terminal.checkout} homeDir={homeDir} /> : fallbackSubtitle}
        subtitleKeeps={Boolean(terminal?.cwd)}
        icon={<SquareTerminal aria-hidden size={14} className="shrink-0 text-muted-60" data-terminal-owner="human" />}
        meta={terminal ? <TerminalStateMeta terminal={terminal} /> : undefined}
        actions={terminal ? (
          <div className="flex shrink-0 items-center gap-1.5">
            {terminal.state === "running" && !driven ? (
              <button type="button" data-terminal-stop disabled={pending !== null} onClick={() => onAct("stop")} className={stopClass}>
                {pending === "stop" ? "Stopping…" : "Stop"}
              </button>
            ) : null}
            {/* Mark as done on a running one stops it first (thread-terminals.ts setState). */}
            {!done ? (
              <button type="button" data-terminal-done disabled={pending !== null} onClick={() => onAct("done")} title="Mark as done" aria-label="Mark as done" className={actionClass}>
                <NarrowGlyph icon={Check} text={pending === "done" ? "Marking…" : "Mark as done"} />
              </button>
            ) : null}
            {!driven ? <button type="button" data-terminal-restart disabled={pending !== null} onClick={() => onAct("restart")} title="Restart" aria-label="Restart" className={actionClass}>
              <NarrowGlyph icon={RotateCcw} text={pending === "restart" ? "Restarting…" : "Restart"} />
            </button> : null}
            <button type="button" data-terminal-remove disabled={pending !== null} onClick={() => onAct("remove")} title="Remove" aria-label="Remove" className={actionClass}>
              <NarrowGlyph icon={Trash2} text={pending === "remove" ? "Removing…" : "Remove"} />
            </button>
            {more}
          </div>
        ) : undefined}
        onClose={onClose}
      />
    </div>
  )
}

// Your terminal's reading, in the agent drawer's shape: `running · 12m`, `waiting for input · 3m`,
// `exit 2`. It used to be a live dot and a bare state word, so how long it had run was in one drawer and
// not the other; the header's glyph already says whose it is, and the words say how it stands.
function TerminalStateMeta({ terminal }: { terminal: ThreadTerminal }) {
  const now = useNowMs()
  const tone = terminal.awaitingInput ? "attention" : terminalFailed(terminal) ? "danger" : undefined
  const age = terminal.state === "running" ? liveAgeSince(terminal.startedAt, now) : undefined
  return <StateReading state={terminalStateLabel(terminal)} age={age} tone={tone} stopShown={terminal.state === "running"} attr={{ "data-terminal-state-reading": terminal.state }} />
}

/**
 * What stands in an agent terminal's pane when there is nothing to draw yet — or ever. Undefined ⇒ the log.
 *
 * `missing` outranks `running`: a log named for this shell that can no longer be read will not start
 * arriving, so "Waiting for the first output…" beside it was a promise nothing would keep. A read that
 * keeps FAILING before any reply says so (the poll retries every 3s) rather than waiting forever on a reply
 * that is not coming. Output already on screen is never replaced by any of these.
 */
export function agentTerminalEmpty(meta: Pick<BackgroundShellOutputResult, "state" | "missing" | "outputUnavailable"> | undefined, error: boolean, received: number): string | undefined {
  // First: a `gone` that follows output used to unmount the log it had written and say "closed" instead —
  // the header's state word already says the shell is no longer known.
  if (received > 0) return undefined
  if (!meta) return error ? "Could not read this terminal's output. Retrying…" : "Waiting for the first output…"
  if (meta.state === "gone") return "This terminal is closed."
  if (meta.outputUnavailable) return "Codex hands this command's output to the agent when it checks in, so ntwine can't show it here."
  if (meta.missing) return "The output file is gone."
  return meta.state === "running" ? "Waiting for the first output…" : "No output was captured."
}

// AN AGENT'S TERMINAL. Everything the header says comes from the same replies the log streams from (the
// scoped `backgroundShellOutput`, which survives the shell ending — its folder and command stay readable
// in an open drawer), with the board's live row as the fallback until the first reply lands.
function AgentTerminalSheet({ id, slug, shellId, label, startedAt, depth, widthDepth }: {
  id: number
  slug: string
  shellId: string
  label?: string
  startedAt?: string
  depth: number
  widthDepth: number
}) {
  const board = useBoard()
  const thread = threadBySlug(board, slug)
  const row = thread?.bgShells?.find((shell) => shell.id === shellId)
  // A FINISHED one's row (ThreadView.endedShells) — how it ended, and its name and folder before the first
  // read answers — for a drawer opened from the strip's finished row or a transcript wake line.
  const ended = row ? undefined : thread?.endedShells?.find((shell) => shell.id === shellId)
  const { stream, meta, error, refresh } = useShellLog(slug, shellId)
  const now = useNowMs()
  const [stopping, setStopping] = useState(false)
  const [stopped, setStopped] = useState(false)
  const state = meta?.state
  const running = state === "running"
  const cwd = meta?.cwd ?? row?.cwd ?? ended?.cwd
  const checkout = meta ? meta.checkout : row?.checkout ?? ended?.checkout
  const monitor = meta?.monitor ?? row?.monitor ?? ended?.monitor
  const doneWord = stopped || ended?.status === "killed" ? "stopped" : ended?.status === "failed" ? "failed" : "finished"
  const stateWord = state === "running" ? "running" : state === "done" ? doneWord : state === "gone" ? (stopped ? "stopped" : "unavailable") : undefined
  const noun = monitor ? "Agent monitor" : "Agent terminal"

  // STOP FROM THE DRAWER — where a wedged watcher is actually diagnosed: you only know a shell is stuck
  // AFTER reading its output. A Claude shell stops through `subAgentStop`, which does not force-retire the
  // row this drawer is rendering (the provider's own terminal event clears it a moment later); a Codex exec
  // has no provider task and stops the way its row's × does, through the one shared dismisser (which also
  // owns the toast).
  function stop() {
    if (stopping) return
    setStopping(true)
    if (meta?.outputUnavailable) {
      void dismissChildOp(slug, shellId, monitor ? "MONITOR" : "SHELL").then((killed) => {
        if (killed) setStopped(true)
        setStopping(false)
        refresh()
      })
      return
    }
    rpc.subAgentStop({ slug, id: shellId })
      .then(({ note }) => {
        setStopped(true)
        // A shell has no subtree, so `note` can only be the one failure specific to it: the process is dead
        // but the AGENT could not be told, and may still be waiting on it.
        if (note) showToast(`${noun} stopped. ${note}`, { duration: 7000 })
        else showToast(`${noun} stopped — the agent was told`)
        refresh()
      })
      .catch((error: unknown) => showToast(error instanceof Error ? error.message : "Could not stop this terminal"))
      .finally(() => setStopping(false))
  }

  async function copyCommand() {
    if (!meta?.command) return
    try {
      await copyTextToClipboard(meta.command)
      showToast("Command copied")
    } catch {
      showToast("Could not copy the command")
    }
  }

  const empty = agentTerminalEmpty(meta, error, stream.received)

  return (
    <Sheet id={id} depth={depth} widthDepth={widthDepth}>
      {(close) => (
        <>
          {/* A size container, so the header's secondary actions fold to glyphs when the drawer is narrow. */}
          <div className="@container shrink-0">
            <SheetHeader
              title={row?.label ?? ended?.label ?? label ?? noun}
              // A Codex exec with no description is labelled by its command, and its row sets it in mono.
              titleMono={row?.command !== undefined && row.command === row.label}
              subtitle={cwd ? <TerminalSubtitle cwd={cwd} checkout={checkout} homeDir={board?.homeDir} /> : undefined}
              subtitleKeeps
              // 15px against your terminal's 14: the same weight match as the strip's owner glyphs (ThreadTerminals OWNER_ICON).
              icon={<Bot aria-hidden size={15} className="shrink-0 text-muted-60" data-terminal-owner="agent" />}
              meta={stateWord ? (
                <StateReading
                  state={stateWord}
                  age={running ? liveAgeSince(startedAt ?? row?.startedAt, now) : undefined}
                  budget={running ? shellBudgetLabel(row?.budgetEndsAt, now) : undefined}
                  stopShown={running && meta?.stoppable === true}
                  tone={stateWord === "failed" ? "danger" : undefined}
                  attr={{ "data-agent-terminal-state": state }}
                />
              ) : undefined}
              actions={(
                <div className="flex shrink-0 items-center gap-1.5">
                  {meta?.command ? (
                    <button type="button" data-agent-terminal-copy onClick={() => void copyCommand()} title="Copy command" aria-label="Copy command" className={actionClass}>
                      <NarrowGlyph icon={Copy} text="Copy command" />
                    </button>
                  ) : null}
                  {running && meta?.stoppable ? (
                    <button type="button" data-agent-terminal-stop disabled={stopping} onClick={stop} className={stopClass}>
                      {stopping ? "Stopping…" : "Stop"}
                    </button>
                  ) : null}
                </div>
              )}
              onClose={close}
            />
          </div>
          {empty ? (
            <div data-agent-terminal-empty className={EMPTY}>{empty}</div>
          ) : (
            <Suspense fallback={<div className="flex-1 bg-bg" />}>
              <ShellLogPane stream={stream} />
            </Suspense>
          )}
          {/* Whose it is, said once, at the foot where your own terminal's next command would go. A running
              shell ntwine cannot reach says why instead, because no control and no explanation is what sent
              the maintainer looking for a Stop in the first place. */}
          <footer
            data-agent-terminal-footer
            className="w-full shrink-0 border-t border-border/70 bg-panel/95 px-4 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-[11.5px] text-muted-60"
          >
            {running && meta && !meta.stoppable && meta.stopNote ? meta.stopNote : "Read-only — started by the agent"}
          </footer>
        </>
      )}
    </Sheet>
  )
}
