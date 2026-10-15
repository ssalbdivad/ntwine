import { useEffect, useRef, useState, type ReactElement } from "react"
import { useMutation } from "@tanstack/react-query"
import { Footprints } from "lucide-react"
import type { ThreadView } from "@ntwine/shared"

type TodoStarter = NonNullable<ThreadView["todoStarters"]>[number]
import { showToast } from "../store.ts"
import { useThreadApi } from "../api/threadApi.tsx"
import { Composer } from "./Composer.tsx"
import { TranscriptCard } from "./TranscriptCard.tsx"

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

/** What a starter launches: the to-do itself, then the first job picked. */
export function starterPrompt(task: string, starter: TodoStarter): string {
  return `${task.trim()}\n\nStart here: ${starter.prompt}`
}

function useLaunch(thread: ThreadView, on: { onLanded?: () => void; onFailed?: () => void } = {}) {
  const api = useThreadApi()
  const sessionId = thread.sessionId ?? ""
  return useMutation({
    mutationFn: (prompt: string) => api.startHeldThread({ slug: thread.id, sessionId, prompt }),
    onSuccess: () => on.onLanded?.(),
    onError: (cause) => {
      on.onFailed?.()
      const message = cause instanceof Error ? cause.message : String(cause)
      // Started already — from another tab, or a send whose answer this box missed. Not a failure.
      showToast(/already start/i.test(message) ? "This thread has already started." : `Could not start the agent: ${message.slice(0, 80)}`)
    },
  })
}

/** A TO-DO's starters (ThreadView.todoStarters): up to three first jobs a model proposed from the task,
 *  each a button that starts the agent on it. Drawn over the box on the queue card and in the drawer. */
export function TodoStarters({ thread }: { thread: ThreadView }): ReactElement | null {
  const launch = useLaunch(thread)
  const starters = thread.todoStarters
  if (!starters?.length) return null
  const task = thread.heldPrompt ?? ""
  return (
    <TranscriptCard icon={Footprints} label="Start with" data-todo-starters="">
      <div className="flex flex-col gap-1.5">
        {starters.map((starter) => (
          <button
            key={starter.label}
            type="button"
            title={starter.prompt}
            disabled={launch.isPending || launch.isSuccess || !thread.sessionId}
            onClick={() => launch.mutate(starterPrompt(task, starter))}
            className="rounded-md border border-border/70 px-3 py-2 text-left text-sm text-fg hover:border-accent hover:bg-accent/10 disabled:opacity-50"
          >
            {starter.label}
          </button>
        ))}
      </div>
    </TranscriptCard>
  )
}

type HeldComposerProps = {
  thread: ThreadView
  surface: "queueComposer" | "chatComposer"
  className?: string
  id?: string
  /** The start went out: a queue card leaves, as it does for a reply (AllQueues useLeavingCards). */
  onSent?: () => void
  /** It landed. */
  onLanded?: () => void
  /** It failed: the card comes back, with the words still in its box. */
  onFailed?: () => void
}

export function HeldThreadComposer({ thread, surface, className, id, onSent, onLanded, onFailed }: HeldComposerProps): ReactElement {
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

  const launch = useLaunch(thread, { onLanded, onFailed })
  // STARTED IS FINAL. Once the start lands the thread is running, but this box is still drawn with the
  // words in it until the board says so — and a queue card whose box has the caret stays drawn for as
  // long as it does (AllQueues `typingKey`). It used to unlock there, so the box looked as if nothing had
  // happened, and a second send answered "This thread has already started" (2026-10-15). It stays
  // locked from the send until it is replaced by the running thread's box.
  const locked = launch.isPending || launch.isSuccess

  const submit = () => {
    const prompt = text.trim()
    if (!prompt || !sessionId || locked) return
    // A queue card unmounts as it leaves, and its pending save with it; should the start fail, the card
    // comes back with what the server has. So the words go to the server now, not 500ms from now. Once the
    // start lands this save is refused (the text is the first message by then), which is nothing to report.
    if (text !== saved.current) void save(text).then(() => { saved.current = text }, () => {})
    onSent?.()
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
        busy={locked}
        footer={<span className="pl-1 text-[11px] text-muted-70">Send to start an agent</span>}
      />
    </div>
  )
}
