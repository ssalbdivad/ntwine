import { useEffect, useRef, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { rpc } from "../api/rpc.ts"
import { SETTINGS_HELP } from "../lib/settingsHelp.ts"
import { SaveStatus, type SaveState } from "../hooks/useSettingsAutosave.tsx"
import { SettingsField } from "./SettingsField.tsx"

const SAVE_DEBOUNCE_MS = 500
const SAVED_LINGER_MS = 1600

// The "Project instructions" editor in the model picker's agent settings: the project's FRIZZ.md, which
// Frizz injects into every worker it dispatches, adopts or resumes here, on either runtime. It edits the
// file itself rather than a Settings value (why: project-instructions.ts on the server), so it keeps
// its own save loop instead of useSettingsDraft — same write-as-you-type feel, but every write names
// the revision it started from. Workers edit FRIZZ.md too; when one has, the save is refused and the
// field offers the file as it now is instead of overwriting it.
export function ProjectInstructionsField() {
  const queryClient = useQueryClient()
  const loaded = useQuery({ queryKey: ["projectInstructions"], queryFn: () => rpc.projectInstructionsGet(), staleTime: 0 })
  const [text, setText] = useState<string | null>(null)
  const [state, setState] = useState<SaveState>("idle")
  const [conflict, setConflict] = useState<{ content: string; revision: string } | null>(null)
  const revision = useRef<string | null>(null)
  const pending = useRef<string | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const linger = useRef<number | undefined>(undefined)

  // Seed once per mount from a fresh read, so reopening the panel shows what is on disk now.
  useEffect(() => {
    if (loaded.data && text === null) {
      setText(loaded.data.content)
      revision.current = loaded.data.revision
    }
  }, [loaded.data, text])

  async function flush() {
    if (timer.current !== undefined) window.clearTimeout(timer.current)
    timer.current = undefined
    const content = pending.current
    if (content === null || revision.current === null) return
    pending.current = null
    setState("saving")
    try {
      const result = await rpc.projectInstructionsSet({ content, baseRevision: revision.current })
      if (!result.ok) {
        setState("error")
        if (result.reason === "conflict") setConflict({ content: result.content, revision: result.revision })
        return
      }
      revision.current = result.revision
      queryClient.setQueryData(["projectInstructions"], { content: result.content, revision: result.revision, editable: true })
      setState("saved")
      window.clearTimeout(linger.current)
      linger.current = window.setTimeout(() => setState("idle"), SAVED_LINGER_MS)
    } catch {
      setState("error")
    }
  }
  const flushRef = useRef(flush)
  flushRef.current = flush
  // Closing the panel must not drop the last half-second of typing.
  useEffect(() => () => void flushRef.current(), [])

  function edit(next: string) {
    setText(next)
    if (conflict) return // nothing saves over a file the operator has not seen yet
    pending.current = next
    if (timer.current !== undefined) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void flushRef.current(), SAVE_DEBOUNCE_MS)
  }

  function loadLatest() {
    if (!conflict) return
    setText(conflict.content)
    revision.current = conflict.revision
    setConflict(null)
    setState("idle")
  }

  const editable = loaded.data?.editable !== false
  return (
    <SettingsField label="Project instructions" help={SETTINGS_HELP.projectInstructions}>
      {text === null ? (
        <div className="text-[12px] text-muted">{loaded.isError ? "Couldn't read FRIZZ.md" : "Loading…"}</div>
      ) : !editable ? (
        <div className="text-[12px] text-muted">FRIZZ.md is a symlink or too large to edit here; edit it in the repo.</div>
      ) : (
        <>
          <textarea
            value={text}
            onChange={(e) => edit(e.target.value)}
            rows={8}
            placeholder="Conventions every agent in this project should follow — build and test gates, commit rules, review depth."
            aria-label="Project instructions"
            className="input resize-y text-[12px] leading-relaxed font-mono-keep"
            spellCheck={false}
          />
          <div className="flex items-center justify-between gap-3 text-[11px] text-muted-70">
            {conflict ? (
              <span className="text-accent">
                FRIZZ.md changed on disk.{" "}
                <button type="button" onClick={loadLatest} className="underline hover:text-fg">
                  Load latest
                </button>
              </span>
            ) : (
              <span>
                Stored in <code className="font-mono-keep">FRIZZ.md</code> at the repo root
              </span>
            )}
            <SaveStatus state={state} />
          </div>
        </>
      )}
    </SettingsField>
  )
}
