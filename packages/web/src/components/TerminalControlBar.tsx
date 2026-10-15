import { useState } from "react"
import { Bot, MoreHorizontal } from "lucide-react"
import type { ThreadTerminal, ThreadView } from "@ntwine/shared"
import { displayTitle, threadHandleOf } from "../groups.ts"
import { AGENT_GLYPH_STROKE } from "../lib/childOps.ts"
import { showToast } from "../store.ts"
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "./ui/Menu.tsx"

// CONTROL OF A TERMINAL (plans/terminal-threads.md § Control). One driver types into a terminal at a time —
// the human or a thread — and the human can always take it. The server holds the rule (it drops a viewer's
// keystrokes and refuses a thread that does not drive); this file is how the human sees and moves it:
//   · a thread drives → a bar over the screen, "@thread is driving", with Take control; the pane and the `$`
//     line are read-only meanwhile;
//   · the human took it from a thread → the bar offers Hand back to @thread while it runs;
//   · any terminal's ⋯ → Let an agent drive, a pick of this project's threads.

type ControlMove = (to: string, back?: boolean) => Promise<unknown>

/** The thread driving this terminal, or undefined when the human does. */
export function terminalDriver(terminal: Pick<ThreadTerminal, "controller"> | undefined): string | undefined {
  const controller = terminal?.controller
  return controller && controller !== "human" ? controller : undefined
}

/** A thread's `@handle` by slug, as the board names it; the slug when it has none. */
function handleIn(threads: readonly ThreadView[], slug: string): string {
  const t = threads.find((x) => x.id === slug)
  return t ? threadHandleOf(t) ?? slug : slug
}

// No flex-shrink here: Take control never gives way (`shrink-0` at its call site), while Hand back is the one
// part of its bar that may — a `shrink-0` in this shared string outranked that button's own `min-w-0
// truncate`, so a long handle pushed it 222px past a 390px drawer and collapsed "You're driving" to 0px.
const barButtonClass = "whitespace-nowrap rounded-md border border-border-strong bg-panel-2/60 px-2 py-0.5 text-[12px] text-fg/85 transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-50"

export function TerminalControlBar({ terminal, threads, move }: { terminal: ThreadTerminal; threads: readonly ThreadView[]; move: ControlMove }) {
  const [busy, setBusy] = useState(false)
  const driver = terminalDriver(terminal)
  const back = !driver && terminal.state === "running" ? terminal.controlAgent : undefined
  if (!driver && !back) return null
  const act = (to: string, isBack?: boolean) => {
    if (busy) return
    setBusy(true)
    move(to, isBack)
      .catch((error: unknown) => showToast(error instanceof Error ? error.message : "Could not move control of this terminal"))
      .finally(() => setBusy(false))
  }
  return (
    <div
      data-terminal-control={driver ? "agent" : "human"}
      className="flex min-w-0 shrink-0 items-baseline gap-2 border-b border-border/70 bg-panel-2/40 px-3 py-1.5 text-[12px] text-muted"
    >
      {driver ? (
        <>
          {/* Ink, measured at 12px sans, dsf 7: centred on a flex line the bot rode 1.06px under the label's cap
              band; on the baseline with the browser's own `1cap` lift its residual is the figure in the commit.
              It paints 1/12 of its box as air per side, so `-mr-[0.25em]` brings its ink to ~6px off the label
              where `gap-2` alone drew 9.17px. */}
          <Bot aria-hidden strokeWidth={AGENT_GLYPH_STROKE} className="h-[1.1667em] w-[1.1667em] shrink-0 self-baseline -mr-[0.25em] translate-y-[calc(0.5833em_-_0.5cap)] text-muted-60" />
          {/* A long handle gives way, never the verb: "@internationalization-reconc… is driving". */}
          <span data-terminal-driver title={`@${handleIn(threads, driver)} is driving`} className="flex min-w-0 flex-1 whitespace-nowrap">
            <span className="min-w-0 truncate">@{handleIn(threads, driver)}</span>
            <span className="shrink-0 whitespace-pre"> is driving</span>
          </span>
          <button type="button" data-terminal-take-control disabled={busy} onClick={() => act("human")} className={`${barButtonClass} shrink-0`}>
            {busy ? "Taking control…" : "Take control"}
          </button>
        </>
      ) : (
        <>
          {/* "You're driving" is short and always whole; the button beside it gives way, truncating the handle
              at its end ("Hand back to @internationaliz…"), with the whole name in its title. */}
          <span className="flex-1 whitespace-nowrap">You're driving</span>
          <button type="button" data-terminal-hand-back disabled={busy} onClick={() => act(back!, true)} title={`Hand back to @${handleIn(threads, back!)}`} className={`${barButtonClass} min-w-0 truncate`}>
            {busy ? "Handing back…" : `Hand back to @${handleIn(threads, back!)}`}
          </button>
        </>
      )}
    </div>
  )
}

/** The threads a terminal can be handed to: this project's open agent threads, the one it was started from
 *  first, then the most recently active, without the one driving it now. */
export function driveCandidates(terminal: ThreadTerminal, threads: readonly ThreadView[], limit = 8): ThreadView[] {
  const open = threads.filter((t) => t.kind === "session" && !t.archived && t.state !== "archived" && !t.foreign && t.id !== terminal.controller && threadHandleOf(t))
  const recent = [...open].sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""))
  const parent = recent.find((t) => t.id === terminal.parent)
  return [...(parent ? [parent] : []), ...recent.filter((t) => t !== parent)].slice(0, limit)
}

// THE TERMINAL'S ⋯ — Let an agent drive. A menu of threads rather than a dialog: the pick is one click, and
// the list is short by construction (driveCandidates).
export function TerminalMoreMenu({ terminal, threads, move, triggerClass }: { terminal: ThreadTerminal; threads: readonly ThreadView[]; move: ControlMove; triggerClass: string }) {
  const candidates = driveCandidates(terminal, threads)
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" data-terminal-more aria-label="More" title="More" className={triggerClass}>
          <MoreHorizontal aria-hidden size={13} />
        </button>
      </MenuTrigger>
      <MenuContent>
        <MenuLabel>Let an agent drive</MenuLabel>
        {candidates.length === 0 ? (
          <div className="px-2.5 pb-1.5 text-[12px] text-muted-60">No open thread to hand it to</div>
        ) : candidates.map((t) => (
          <MenuItem
            key={t.id}
            value={t.id}
            icon={<Bot aria-hidden size={14} strokeWidth={AGENT_GLYPH_STROKE} />}
            onSelect={() => void move(t.id).catch((error: unknown) => showToast(error instanceof Error ? error.message : "Could not hand this terminal over"))}
          >
            <span className="min-w-0 truncate" title={displayTitle(t)}>@{threadHandleOf(t)}</span>
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  )
}
