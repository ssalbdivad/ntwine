import { lazy, Suspense, useState } from "react"
import { TerminalSquare } from "lucide-react"
import type { ThreadView } from "@frizz/shared"
import { useThreadApi, useThreadApiBase } from "../api/threadApi.tsx"
import { openThread, showToast } from "../store.ts"
import { commandFailed, commandStateLabel } from "../lib/commandThreads.ts"
import { STRIP_INK_GAP } from "../lib/iconRhythm.ts"
import { BLOCK_RADIUS, BLOCK_RADIUS_INNER_BOTTOM, BLOCK_RADIUS_TOP } from "./TranscriptCard.tsx"
import { LastActive } from "./LastActive.tsx"
import { StateButton } from "./ThreadLifecycleFooter.tsx"
import { CommandFollowUp } from "./CommandFollowUp.tsx"

// LAZY for the same reason as CommandSheet's: @xterm/xterm is browser-only.
const TerminalPane = lazy(() => import("./TerminalPane.tsx").then((m) => ({ default: m.TerminalPane })))

// A FINISHED TERMINAL COMMAND's queue card. A run that has ended is waiting on the human exactly like
// a rested agent — read how it went, then mark it done — so it takes a card in the same queue, with the
// same shell and the same Mark as done. What differs is the body: the run's last screen (the server's
// replay) instead of a transcript, and the terminal mark + mono command in the header, which is how a
// command reads apart from an agent thread everywhere it appears.
//
// A finished run cards, and so does a LIVE one sitting at a prompt (`awaitingInput` — an OTP, a
// password, a [y/N]). That one's pane is the live pty, so the answer can be typed straight into the card,
// and its verb is Stop rather than Restart; the follow-up box is withheld, since running a next command
// would kill the one that is asking.
//
// PROJECT-SCOPED through api/threadApi.tsx: on a board it acts on the page's project, and under the All
// queues page's `ThreadProjectScope` its Restart, its pty and its Mark as done all go to the card's own
// project. `onOpen` replaces the drawer there, which is the page's and would open the wrong thread.
export function CommandQueueCard({ thread, leaving, onResolve, onUnresolve, onOpen }: {
  thread: ThreadView
  leaving: boolean
  onResolve: (slug: string) => void
  onUnresolve: (slug: string) => void
  onOpen?: () => void
}) {
  const command = thread.command
  const api = useThreadApi()
  const termBase = useThreadApiBase()
  const [pending, setPending] = useState<"restart" | "stop" | null>(null)
  if (!command) return null
  const failed = commandFailed(command)
  const prompting = command.state === "running"
  const act = (kind: "restart" | "stop") => {
    if (pending) return
    setPending(kind)
    const call = kind === "stop" ? api.commandStop({ slug: thread.id }) : api.commandRestart({ slug: thread.id })
    call
      .catch((error: unknown) => showToast(error instanceof Error ? error.message : `Could not ${kind} this command`))
      .finally(() => setPending(null))
  }
  return (
    <div
      data-queue-card-root={thread.id}
      data-queue-leaving={leaving}
      data-command-card={command.state}
      className={`flex min-w-0 max-w-full flex-col ${BLOCK_RADIUS} border border-border-strong bg-panel shadow-lg shadow-shadow-ink/25`}
    >
      <div className={`flex items-center gap-2 bg-panel px-5 py-3.5 ${BLOCK_RADIUS_TOP} border-b border-border/60`}>
        <button type="button" onClick={onOpen ?? (() => openThread(thread.id))} className="flex min-w-0 flex-1 items-start gap-2 text-left">
          <TerminalSquare aria-hidden size={14} className={`mt-[3px] shrink-0 ${failed ? "text-danger-soft" : "text-muted-60"}`} />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-mono-keep text-[13px] leading-snug text-fg" title={command.command}>{command.command}</span>
            <span className="mt-0.5 flex items-baseline gap-1.5 text-[11px] leading-tight text-muted-75">
              <span className={failed ? "text-danger-soft" : undefined}>{commandStateLabel(command)}</span>
              <span aria-hidden>·</span>
              <LastActive at={command.exitedAt ?? thread.lastActivityAt ?? command.startedAt} className="truncate" />
            </span>
          </span>
        </button>
      </div>
      {/* overflow-hidden: xterm sizes its screen to whole rows and can run a row past the box on first
          fit, which painted a strip over the footer's top edge. */}
      <div className="flex h-[240px] min-h-0 flex-col overflow-hidden">
        <Suspense fallback={<div className="flex-1 bg-bg" />}>
          <TerminalPane key={`${thread.id}:${command.runId}`} slug={thread.id} base={termBase} focusOnMount={false} exitedStatus={() => null} />
        </Suspense>
      </div>
      {/* The next command, as a rested agent's card takes its next prompt. Running it takes the thread out
          of the queue, so the drawer opens on the new run rather than leaving the human nowhere. */}
      {prompting ? null : (
        <div className="border-t border-border/70 bg-panel px-3 pt-2.5">
          <CommandFollowUp slug={thread.id} lastCommand={command.command} onRan={onOpen ?? (() => openThread(thread.id))} />
        </div>
      )}
      <footer
        aria-label="Thread lifecycle actions"
        className={`${BLOCK_RADIUS_INNER_BOTTOM} flex min-h-10 shrink-0 items-center justify-end ${STRIP_INK_GAP} bg-panel/95 px-3 py-2 text-[12px]`}
      >
        <button
          type="button"
          {...(prompting ? { "data-command-stop": true } : { "data-command-restart": true })}
          disabled={pending !== null}
          onClick={() => act(prompting ? "stop" : "restart")}
          onMouseDown={(event) => event.preventDefault()}
          className="rounded-md border border-border-strong bg-panel-2/60 px-2.5 py-1 font-medium text-fg/80 transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-45"
        >
          {prompting ? (pending === "stop" ? "Stopping…" : "Stop") : pending === "restart" ? "Restarting…" : "Restart"}
        </button>
        <StateButton thread={thread} onArchived={() => onResolve(thread.id)} onDismissCancel={() => onUnresolve(thread.id)} command />
      </footer>
    </div>
  )
}
