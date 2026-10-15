import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Loader2, RotateCcw } from "lucide-react"
import type { ThreadTerminal, ThreadView } from "@ntwine/shared"
import { useThreadApi, useThreadProjectId } from "../api/threadApi.tsx"
import { liveAgeSince } from "../lib/durationLabels.ts"
import { showToast } from "../store.ts"
import { Tooltip } from "./Tooltip.tsx"

// A TERMINAL THREAD'S ROW (plans/terminal-threads.md § Density): one line — the row's state mark (the rail's
// own family, Sidebar.tsx sessionStateIndicatorFor), a dim `$`, the terminal's NAME, the folder only when it
// is off the project root, and its age. The `$` is the terminal mark: the same character the prompt box takes
// a command after, set in mono, so it needs no glyph alignment of its own. The name is its `@handle`
// (`nub-run-dev`), set as every thread's name is, because it is what the human types to point a thread at it
// (maintainer 2026-10-15: the row read `$ nub run dev`, a command, and the terminal looked unnamed). The
// command itself is one hover away, with its folder; a row from before handles existed shows the command.

/** How long a running terminal has been running — the right-edge column a working row's clock takes. A
 *  Ready one reads its time in the queue there instead (RestedAge); a Done one reads nothing. */
export function terminalRowAge(terminal: ThreadTerminal, nowMs: number): string | undefined {
  if (terminal.state !== "running" || terminal.awaitingInput) return undefined
  return liveAgeSince(terminal.startedAt, nowMs) || undefined
}

/** The folder a terminal runs in, as its row names it: the checkout's own name, and only off the root. */
export function terminalFolderHint(terminal: Pick<ThreadTerminal, "checkout">): string | undefined {
  const dir = terminal.checkout?.dir
  return dir ? (dir.split(/[\\/]/).filter(Boolean).pop() ?? dir) : undefined
}

// THE COMMAND SITS ON THE ROW'S SANS LINE. A mono run set as its own flex item rides high beside sans text
// (two fonts' boxes centred on one line put their baselines apart — ThreadTerminals.tsx LABEL measured 2.34px
// on the strip); as a `leading-none` inline run inside the row's 13px/19px sans line box it sits on the sans
// baseline, so the row's other readings (the age, the rest time) line up with it with nothing to measure.
// 12.5px mono against 13px sans: the strip's 11px-in-11.5px ratio, so a command reads the weight of a title.
export function TerminalRowTitle({ terminal }: { terminal: ThreadTerminal }) {
  const folder = terminalFolderHint(terminal)
  return (
    <span data-terminal-row-title title={terminal.cwd ? `$ ${terminal.command}\n${terminal.cwd}` : `$ ${terminal.command}`}>
      {/* The space after the `$` is the name's own (sans) when a name follows: a mono space there drew 9px of
          ink between the mark and the name, against ~6px for a sans one (measured 2026-10-15, dsf 6). */}
      <span aria-hidden className="font-mono-keep text-[12.5px] leading-none text-muted-55">{terminal.handle ? "$" : "$ "}</span>
      {terminal.handle
        ? <span data-terminal-row-name>{` ${terminal.handle}`}</span>
        : <span data-terminal-row-command className="font-mono-keep text-[12.5px] leading-none">{terminal.command}</span>}
      {folder && <span data-terminal-row-folder className="text-[12px] leading-none text-muted-60">{` · ${folder}`}</span>}
    </span>
  )
}

/** Restart a failed or interrupted terminal from its row — the card's Restart, one click closer. */
export function RowRestartButton({ t, className }: { t: ThreadView; className: string }) {
  const api = useThreadApi()
  const queryClient = useQueryClient()
  const projectId = useThreadProjectId()
  const [busy, setBusy] = useState(false)
  return (
    <Tooltip label="Restart">
      <button
        type="button"
        data-sidebar-restart-terminal={t.id}
        aria-label="Restart"
        disabled={busy}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation()
          setBusy(true)
          api.terminalRestart({ id: t.id })
            .then(() => {
              void queryClient.invalidateQueries({ queryKey: ["projectsQueues"] })
              if (projectId) void queryClient.invalidateQueries({ queryKey: ["ofProject", projectId, "board"] })
            })
            .catch((error: unknown) => showToast(`Could not restart: ${(error instanceof Error ? error.message : String(error)).slice(0, 80)}`))
            .finally(() => setBusy(false))
        }}
        className={`${className} disabled:opacity-50`}
      >
        {busy ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
      </button>
    </Tooltip>
  )
}
