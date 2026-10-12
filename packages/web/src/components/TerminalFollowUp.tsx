import { useState } from "react"
import { ArrowUp, Loader2 } from "lucide-react"
import { useThreadApi, useThreadProjectDir } from "../api/threadApi.tsx"
import { showToast } from "../store.ts"
import { draftKey, draftStore, useDraft } from "../lib/drafts.ts"
import { composerRail } from "../lib/iconRhythm.ts"

// A FINISHED terminal's next line — the terminal's answer to an agent thread's follow-up prompt. Someone
// who ran `whoami` wants `ls` next, in the same place and the same folder, not a second terminal. Enter
// runs the line as the terminal's next run (`terminalRun`): the server carries the screen forward under
// a `$ ls` line, so the drawer reads as one shell session, and the terminal is named for the command now
// running.
//
// Only offered once the run has ended: while it runs, the terminal itself takes the keystrokes.
// ArrowUp in an empty box recalls the command that just ran, the shell's own gesture for "again, edited".
export function TerminalFollowUp({ id, lastCommand, autoFocus, onRan }: {
  id: string
  lastCommand: string
  autoFocus?: boolean
  /** After the run starts. */
  onRan?: () => void
}) {
  const api = useThreadApi()
  const projectDir = useThreadProjectDir()
  const key = draftKey.terminalNext(projectDir, id)
  const [value, setValue, clear] = useDraft(key)
  const [pending, setPending] = useState(false)
  const hasContent = value.trim().length > 0

  function submit() {
    const command = value.trim()
    if (!command || pending) return
    setPending(true)
    clear()
    api
      .terminalRun({ id, command })
      .then(() => onRan?.())
      .catch((error: unknown) => {
        if (!draftStore.get(key)) setValue(command)
        showToast(`Could not run the command: ${(error instanceof Error ? error.message : String(error)).slice(0, 80)}`)
      })
      .finally(() => setPending(false))
  }

  return (
    <div data-terminal-follow-up className="relative flex items-center rounded-lg border border-border bg-bg transition-colors focus-within:border-accent">
      {/* The shell's prompt mark in the input's font, so the box reads as a command line. */}
      <span aria-hidden className="font-mono-keep select-none pl-3 text-[13px] text-muted-60">$</span>
      <input
        data-surface="terminalFollowUp"
        data-claims-escape
        value={value}
        autoFocus={autoFocus}
        disabled={pending}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation()
            e.currentTarget.blur()
            return
          }
          if (e.key === "ArrowUp" && !value) {
            e.preventDefault()
            setValue(lastCommand)
            return
          }
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          }
        }}
        placeholder="Run another command"
        aria-label="Run another command"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        className="font-mono-keep block min-w-0 flex-1 bg-transparent py-2 pl-2 pr-11 text-[13px] text-fg outline-none placeholder:font-sans placeholder:text-muted disabled:opacity-60"
      />
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={submit}
        disabled={!hasContent || pending}
        title="Run (Enter)"
        aria-label="Run command"
        // The prompt box's own Send position (lib/iconRhythm composerRail), so the run button sits where
        // a thread's Send does.
        style={{ right: composerRail({}).right.send }}
        className={`icon-hover-outline absolute flex h-6 w-6 items-center justify-center rounded-md transition-[color,background-color,opacity,scale] ${
          hasContent && !pending ? "bg-fg text-bg hover:opacity-90 active:scale-95" : "bg-panel-2 text-muted"
        }`}
      >
        {pending ? <Loader2 size={13} strokeWidth={2.5} className="animate-spin" /> : <ArrowUp size={13} strokeWidth={2.5} />}
      </button>
    </div>
  )
}
