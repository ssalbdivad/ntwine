import { useEffect, useId, useRef, useState } from "react"
import { useSnapshot } from "valtio"
import { useQuery } from "@tanstack/react-query"
import { Loader2, Timer } from "lucide-react"
import { parseDeadlineInput } from "@ntwine/shared"
import { rpc } from "../api/rpc.ts"
import { showToast, store } from "../store.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { limitPreview } from "../lib/threadDeadline.ts"
import { Dialog } from "./ui/Dialog.tsx"
import { STATUS_ROW_ACTION, STATUS_ROW_ICON } from "../lib/statusRow.ts"

// ONE TIME LIMIT ON EVERY RUNNING THREAD, in every open project, with a note each worker reads beside it
// (router setRunningDeadlines) — the palette's way to say "restarting the machine in 15m" before a reboot.
// A Ntwine restart needs none of this: the agents run in daemons it does not own. Opened from the command
// palette or the status row's stopwatch (`store.showRunningTimeLimit`), mounted once by App.

const PRESETS = ["5m", "15m", "30m", "1h"] as const
const NOTE_MAX = 2_000

/**
 * The way in beside the palette: a stopwatch in the status row, just before the restart button — next to
 * the restart it prepares for, and on every page that row is on, All projects included. It is the same
 * stopwatch a row shows once it has a time limit (DeadlineControl.tsx).
 */
export function RunningTimeLimitButton() {
  return (
    <button
      type="button"
      data-running-time-limit-open
      title="Time limit for running threads"
      aria-label="Time limit for running threads"
      onClick={() => { store.showRunningTimeLimit = true }}
      className={STATUS_ROW_ACTION}
    >
      <Timer size={STATUS_ROW_ICON} aria-hidden />
    </button>
  )
}

export function RunningTimeLimitHost() {
  const open = useSnapshot(store).showRunningTimeLimit
  return open ? <RunningTimeLimitDialog onClose={() => { store.showRunningTimeLimit = false }} /> : null
}

function RunningTimeLimitDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("15m")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const formId = useId()
  const limitId = useId()
  const noteId = useId()
  const noteRef = useRef<HTMLTextAreaElement>(null)
  const nowMs = useNowMs()
  const preview = limitPreview(text, Math.max(nowMs, Date.now()))
  // The same machine-wide count the project rail polls, so the button names what a click reaches.
  const counts = useQuery({ queryKey: ["projectsRailCounts"], queryFn: () => rpc.projectsRailCounts(), refetchInterval: 5_000 })
  const running = counts.data ? Object.values(counts.data).reduce((sum, c) => sum + c.running, 0) : undefined
  useEffect(() => setError(""), [text, note])

  const submit = async () => {
    if (busy) return
    const parsed = parseDeadlineInput(text, Date.now())
    if (!parsed.ok) return setError(parsed.error)
    setBusy(true)
    try {
      const got = await rpc.setRunningDeadlines({ deadline: new Date(parsed.atMs).toISOString(), ...(note.trim() ? { note: note.trim() } : {}) })
      onClose()
      showToast(got.threads === 0
        ? "No threads are running"
        : `Time limit set on ${got.threads} ${got.threads === 1 ? "thread" : "threads"}${got.projects > 1 ? ` in ${got.projects} projects` : ""}${got.children > 0 ? ` and ${got.children} ${got.children === 1 ? "sub-agent" : "sub-agents"}` : ""}`)
    } catch (caught) {
      setBusy(false)
      setError((caught instanceof Error ? caught.message : String(caught)).slice(0, 160))
    }
  }

  // Calls the wrap-up off: every Running thread's limit is lifted, whoever set it, and its worker is told.
  const removeAll = async () => {
    if (busy) return
    setBusy(true)
    try {
      const got = await rpc.setRunningDeadlines({ deadline: null })
      onClose()
      showToast(got.threads === 0
        ? "No running threads have a time limit"
        : `Time limit removed from ${got.threads} ${got.threads === 1 ? "thread" : "threads"}${got.projects > 1 ? ` in ${got.projects} projects` : ""}${got.children > 0 ? ` and ${got.children} ${got.children === 1 ? "sub-agent" : "sub-agents"}` : ""}`)
    } catch (caught) {
      setBusy(false)
      setError((caught instanceof Error ? caught.message : String(caught)).slice(0, 160))
    }
  }

  const label = running === undefined ? "Set time limit" : running === 0 ? "No threads running" : `Set on ${running} running ${running === 1 ? "thread" : "threads"}`
  return (
    <Dialog
      open
      onOpenChange={(next) => { if (!next && !busy) onClose() }}
      title="Time limit for running threads"
      className="w-[400px] max-w-[92vw]"
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        noteRef.current?.focus()
      }}
      footer={
        <>
          {error
            ? <span role="alert" className="mr-auto min-w-0 break-words text-[11px] leading-snug text-danger-soft">{error}</span>
            : (
              <button
                type="button"
                data-running-time-limit-remove
                disabled={busy || running === 0}
                onClick={() => void removeAll()}
                className="-ml-2 mr-auto rounded-md px-2 py-1.5 text-[12px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:opacity-45"
              >
                Remove limits
              </button>
            )}
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="button-outline rounded-md px-3 py-1.5 text-[12px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-45"
          >
            Cancel
          </button>
          <button
            type="submit"
            form={formId}
            data-running-time-limit-submit
            disabled={busy || !preview?.ok || running === 0}
            className="button-outline flex items-center gap-1.5 rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-bg outline-none transition-opacity hover:opacity-90 disabled:opacity-45"
          >
            {busy && <Loader2 size={12} className="animate-spin" />}
            {label}
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-2.5 p-4"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <label htmlFor={limitId} className="text-[11px] font-medium text-muted">Hand off within</label>
        <div className="flex items-center gap-1.5">
          <input
            id={limitId}
            data-running-time-limit-input
            data-1p-ignore
            autoComplete="off"
            spellCheck={false}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="15m, 1h, 15:30…"
            aria-invalid={preview && !preview.ok ? true : undefined}
            className="w-20 rounded-md border border-border bg-bg px-2 py-1 text-[12px] tabular-nums text-fg outline-none placeholder:text-muted-40 focus:border-accent"
          />
          <div role="group" aria-label="Time limit presets" className="flex flex-wrap gap-1">
            {PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                aria-pressed={text.trim() === preset}
                onClick={() => setText(preset)}
                className="rounded-md border border-border/70 px-2 py-1 text-[12px] tabular-nums text-muted outline-none transition-colors hover:border-border hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60 aria-pressed:border-border aria-pressed:bg-panel-2 aria-pressed:text-fg"
              >
                {preset}
              </button>
            ))}
          </div>
        </div>
        <p aria-live="polite" className={`-mt-1 text-[10.5px] leading-snug empty:hidden ${preview && !preview.ok ? "text-danger" : "text-muted-60"}`}>
          {preview?.text}
        </p>
        <label htmlFor={noteId} className="mt-1 text-[11px] font-medium text-muted">
          Note to each agent <span className="font-normal text-muted-55">(optional)</span>
        </label>
        <textarea
          id={noteId}
          ref={noteRef}
          data-running-time-limit-note
          data-1p-ignore
          rows={3}
          maxLength={NOTE_MAX}
          placeholder="e.g. Restarting the machine. Commit what you have and leave the work easy to resume."
          value={note}
          onChange={(event) => setNote(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void submit()
            }
          }}
          className="w-full resize-none rounded-md border border-border bg-bg px-2.5 py-2 text-[13px] text-fg outline-none placeholder:text-muted-40 focus:border-accent"
        />
        <p className="text-[10.5px] leading-snug text-muted-65">Sub-agents get it too. A thread with an earlier time limit keeps it; queued threads count only while their sub-agents are still running.</p>
      </form>
    </Dialog>
  )
}
