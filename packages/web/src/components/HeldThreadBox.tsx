import { useEffect, useRef, useState, type ReactElement } from "react"
import { useMutation } from "@tanstack/react-query"
import { Footprints } from "lucide-react"
import type { ThreadView } from "@ntwine/shared"
import { showToast } from "../store.ts"
import { useThreadApi } from "../api/threadApi.tsx"
import { Composer } from "./Composer.tsx"
import { LinkedHtml } from "./LinkedHtml.tsx"
import { QUEUE_WRAP, TranscriptCard } from "./TranscriptCard.tsx"
import { useMarkdownHtml } from "../lib/useMarkdown.ts"

// A HELD THREAD's prompt box (ThreadView.held): a thread written down with no agent behind it. Its text IS
// the box's text — there is no separate note view to keep in step with a draft — so the queue card and the
// drawer show the same words, edits save back as they are typed, and sending it starts the agent with
// whatever the box says by then.
//
// It is not ThreadComposerBox, on purpose. Everything that box carries is about a RUNNING agent — its model
// and permission controls act on a live runtime, `/` asks the harness for its skills, ⌘-Enter interrupts a
// turn, `$ cmd` opens a terminal in the agent's folder — and a held thread has none of those yet. The
// profile it starts on is the one the prompt box had when it was written down.
//
// The draft store is not used either: the server keeps the text (ThreadView.heldPrompt), so the box reads it
// from the board and writes it back through updateHeldPrompt. `saved` is the last text this box knows the
// server has, which is how a board push of our own save is told apart from an edit made somewhere else (the
// other surface, another tab).
const SAVE_DELAY_MS = 500

/** A TO-DO's first steps (ThreadView.todoSteps): what a model wrote from the task to help start it — a
 *  draft, a page, where to look. Drawn over the box on the queue card and in the drawer. */
export function TodoSteps({ steps }: { steps: string }): ReactElement {
  const html = useMarkdownHtml(steps)
  return (
    <TranscriptCard icon={Footprints} label="First steps" data-todo-steps="">
      <LinkedHtml className={`md-body ${QUEUE_WRAP}`} html={html} />
    </TranscriptCard>
  )
}

type HeldComposerProps = { thread: ThreadView; surface: "queueComposer" | "chatComposer"; className?: string; id?: string }

export function HeldThreadComposer({ thread, surface, className, id }: HeldComposerProps): ReactElement {
  const api = useThreadApi()
  const sessionId = thread.sessionId ?? ""
  const note = thread.heldPrompt ?? ""
  const [text, setText] = useState(note)
  const saved = useRef(note)

  // Another surface saved a different text: take it, unless this box has unsaved typing of its own.
  useEffect(() => {
    if (note === saved.current) return
    setText((current) => (current === saved.current ? note : current))
    saved.current = note
  }, [note])

  const save = (prompt: string) => api.updateHeldPrompt({ slug: thread.id, sessionId, prompt })
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    if (text === saved.current) return
    const timer = setTimeout(() => {
      const sending = text
      saveRef.current(sending).then(
        () => { saved.current = sending },
        // Started meanwhile (another tab sent it): the text is now the thread's first message, so there is
        // nothing left to save it into.
        () => {},
      )
    }, SAVE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [text, thread.id])

  const launch = useMutation({
    mutationFn: (prompt: string) => api.startHeldThread({ slug: thread.id, sessionId, prompt }),
    onError: (cause) => showToast(`Could not start the agent: ${(cause instanceof Error ? cause.message : String(cause)).slice(0, 80)}`),
  })

  const submit = () => {
    const prompt = text.trim()
    if (!prompt || !sessionId || launch.isPending) return
    launch.mutate(prompt)
  }

  return (
    <div data-thread-composer-box={surface} data-held-box={thread.held ?? ""} className={className}>
      <Composer
        id={id}
        surface={surface}
        value={text}
        onChange={setText}
        onSubmit={submit}
        placeholder="Describe the task…"
        busy={launch.isPending}
        footer={<span className="pl-1 text-[11px] text-muted-70">Send to start an agent</span>}
      />
    </div>
  )
}
