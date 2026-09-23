import { lazy, Suspense, useRef, useState } from "react"
import { TerminalSquare } from "lucide-react"
import type { ThreadView } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { showToast, threadBySlug } from "../store.ts"
import { useBoard } from "../hooks.ts"
import { abbreviateHome } from "../lib/paths.ts"
import { commandFailed, commandStateLabel } from "../lib/commandThreads.ts"
import { Sheet } from "./ui/Sheet.tsx"
import { SheetHeader } from "./ui/SheetHeader.tsx"
import { StateButton } from "./ThreadLifecycleFooter.tsx"

// LAZY for the same reason as the sign-in modal's: @xterm/xterm is browser-only, and node (tests)
// imports the drawer stack transitively.
const TerminalPane = lazy(() => import("./TerminalPane.tsx").then((m) => ({ default: m.TerminalPane })))

const actionClass = "rounded-md border border-border-strong bg-panel-2/60 px-2.5 py-1 text-[12px] text-fg/80 transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-50"

// A TERMINAL COMMAND THREAD's drawer: the live pty, full height, under a header naming the command and
// how its run stands. There is no chat and no composer — the terminal takes keystrokes itself, so
// answering a prompt or pressing Ctrl-C happens right in it.
//
// The pane is keyed on the RUN, not the slug: Restart starts a fresh process, and the browser should
// see a fresh screen rather than the new process's output appended under the old one's.
export function CommandSheet({ id, slug, depth, widthDepth }: { id: number; slug: string; depth: number; widthDepth: number }) {
  const board = useBoard()
  const thread = threadBySlug(board, slug)
  const command = thread?.command
  // The drawer opens the moment the start RPC answers, which can beat the board delta carrying the row.
  // Until the row has been seen once, its absence means "starting", not "gone".
  const seen = useRef(false)
  if (command) seen.current = true
  const [pending, setPending] = useState<"stop" | "restart" | "remove" | null>(null)

  function act(kind: "stop" | "restart" | "remove", close: () => void) {
    if (pending) return
    setPending(kind)
    const call = kind === "stop" ? rpc.commandStop({ slug }) : kind === "restart" ? rpc.commandRestart({ slug }) : rpc.commandRemove({ slug })
    call
      .then(() => {
        if (kind === "remove") close()
      })
      .catch((error: unknown) => showToast(error instanceof Error ? error.message : `Could not ${kind} this command`))
      .finally(() => setPending(null))
  }

  return (
    <Sheet id={id} depth={depth} widthDepth={widthDepth}>
      {(close) => (
        <>
          <SheetHeader
            title={command?.command ?? thread?.title ?? slug}
            subtitle={board?.projectDir ? abbreviateHome(board.projectDir, board.homeDir) : undefined}
            icon={<TerminalSquare aria-hidden size={14} className="shrink-0 text-muted-60" />}
            meta={command ? <CommandStateMeta thread={thread} /> : undefined}
            actions={command ? (
              <div className="flex shrink-0 items-center gap-1.5">
                {command.state === "running" ? (
                  <button type="button" data-command-stop disabled={pending !== null} onClick={() => act("stop", close)} className={`${actionClass} hover:border-danger/40 hover:bg-danger/10 hover:text-danger-soft`}>
                    {pending === "stop" ? "Stopping…" : "Stop"}
                  </button>
                ) : null}
                {/* A finished run is queued like a rested thread; done is the same verb here as on its card. */}
                {command.state === "exited" && thread?.state !== "archived" && thread ? <StateButton thread={thread} /> : null}
                <button type="button" data-command-restart disabled={pending !== null} onClick={() => act("restart", close)} className={actionClass}>
                  {pending === "restart" ? "Restarting…" : "Restart"}
                </button>
                <button type="button" data-command-remove disabled={pending !== null} onClick={() => act("remove", close)} className={actionClass}>
                  {pending === "remove" ? "Removing…" : "Remove"}
                </button>
              </div>
            ) : undefined}
            onClose={close}
          />
          {command ? (
            <Suspense fallback={<div className="flex-1 bg-bg" />}>
              <TerminalPane
                key={`${slug}:${command.runId}`}
                slug={slug}
                exitedStatus={() => (
                  <>
                    <span className="text-muted">{commandStateLabel(command) || "Process exited"}</span>
                    <button type="button" className="text-fg hover:underline" onClick={() => act("restart", close)}>
                      Restart →
                    </button>
                  </>
                )}
              />
            </Suspense>
          ) : (
            <div className="flex flex-1 items-center justify-center px-8 text-center text-[13px] text-muted">
              {seen.current ? "This command was removed." : "Starting…"}
            </div>
          )}
        </>
      )}
    </Sheet>
  )
}

function CommandStateMeta({ thread }: { thread: ThreadView | undefined }) {
  const command = thread?.command
  if (!command) return null
  const label = commandStateLabel(command)
  const failed = commandFailed(command)
  return (
    <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[11.5px] text-muted-60">
      {command.state === "running" && <span aria-hidden className="frizz-live-dot frizz-live-dot--shell" />}
      <span className={failed ? "text-danger-soft" : undefined}>{label}</span>
    </span>
  )
}
