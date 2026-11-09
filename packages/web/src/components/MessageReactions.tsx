import { SmilePlus } from "lucide-react"
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { REACTION_EMOJI, type ThreadReactionView } from "@ntwine/shared"
import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/Popover.tsx"

// REACTIONS (2026-11-09; ThreadReactionView in @ntwine/shared). The human puts an emoji on an agent's
// message from a hover button under it; the agent's emoji on the human's message sit under their bubble.
// Mounted by the thread's own chat only (ChatView's provider): a message drawn anywhere else — a sub-agent's
// sheet, a queue card — reads no context and draws no reactions, since those are not this thread's words.

interface ReactionsState {
  bySource: ReadonlyMap<string, readonly ThreadReactionView[]>
  toggle(sourceId: string, emoji: string, excerpt: string): void
}

const ReactionsContext = createContext<ReactionsState | null>(null)

const key = (sourceId: string, emoji: string) => `${sourceId}\u0000${emoji}`

export function ReactionsProvider({ slug, reactions, children }: { slug: string; reactions: readonly ThreadReactionView[] | undefined; children: ReactNode }) {
  // The human's click shows at once; the board's next frame is the truth, and replaces every override.
  const [overrides, setOverrides] = useState<ReadonlyMap<string, { on: boolean; at: number }>>(new Map())
  // An override stands until the board agrees with it (or 15s pass — a save that never echoed). Every
  // board frame re-runs this, and an unrelated frame landing before the save must not undo the click.
  useEffect(() => setOverrides((prev) => {
    if (!prev.size) return prev
    const now = Date.now()
    const next = new Map([...prev].filter(([k, o]) => {
      const [sourceId, emoji] = k.split("\u0000")
      const onBoard = (reactions ?? []).some((r) => r.by === "human" && r.sourceId === sourceId && r.emoji === emoji)
      return onBoard !== o.on && now - o.at < 15_000
    }))
    return next.size === prev.size ? prev : next
  }), [reactions])
  const bySource = useMemo(() => {
    const map = new Map<string, ThreadReactionView[]>()
    const seen = new Set<string>()
    for (const r of reactions ?? []) {
      const k = key(r.sourceId, r.emoji)
      if (r.by === "human" && overrides.get(k)?.on === false) continue
      if (r.by === "human") seen.add(k)
      map.set(r.sourceId, [...(map.get(r.sourceId) ?? []), r])
    }
    for (const [k, o] of overrides) {
      if (!o.on || seen.has(k)) continue
      const [sourceId, emoji] = k.split("\u0000")
      map.set(sourceId, [...(map.get(sourceId) ?? []), { sourceId, emoji, by: "human", at: o.at }])
    }
    return map
  }, [reactions, overrides])
  const toggle = useCallback((sourceId: string, emoji: string, excerpt: string) => {
    const k = key(sourceId, emoji)
    const on = !(bySource.get(sourceId) ?? []).some((r) => r.by === "human" && r.emoji === emoji)
    setOverrides((prev) => new Map(prev).set(k, { on, at: Date.now() }))
    rpc.setReaction({ slug, sourceId, emoji, excerpt, on }).catch((error: unknown) => {
      setOverrides((prev) => {
        const next = new Map(prev)
        next.delete(k)
        return next
      })
      showToast(error instanceof Error ? error.message : "Could not save the reaction")
    })
  }, [bySource, slug])
  const value = useMemo(() => ({ bySource, toggle }), [bySource, toggle])
  return <ReactionsContext.Provider value={value}>{children}</ReactionsContext.Provider>
}

/** Same emoji from one side, counted once: each side reacts with an emoji at most once per message. */
function chipsOf(list: readonly ThreadReactionView[], by: ThreadReactionView["by"]): string[] {
  return list.filter((r) => r.by === by).sort((a, b) => a.at - b.at).map((r) => r.emoji)
}

const CHIP_CLASS = "inline-flex h-[22px] items-center rounded-full border px-[7px] text-[13px] leading-none"

/** Under the HUMAN's bubble: the agent's reactions, read-only. Draws nothing when there are none, so a
 *  bubble with no reaction keeps its exact layout. */
export function UserMessageReactions({ sourceId }: { sourceId?: string }) {
  const state = useContext(ReactionsContext)
  const emoji = sourceId && state ? chipsOf(state.bySource.get(sourceId) ?? [], "agent") : []
  if (!emoji.length) return null
  return (
    <div data-message-reactions="agent" className="flex flex-wrap justify-end gap-1 pt-0.5" aria-label="The agent's reactions">
      {emoji.map((e) => (
        <span key={e} title="The agent reacted" className={`${CHIP_CLASS} border-border/70 bg-elevated`}>{e}</span>
      ))}
    </div>
  )
}

/** Under an AGENT's message: the human's reactions, each a toggle, and a button to add one. The button
 *  shows on hover of the message (the `group/msg` its root carries) or while the picker is open; with no
 *  reactions yet it floats in a zero-height slot, so pointing at a message never shifts the transcript. */
export function AgentMessageReactions({ sourceId, excerpt }: { sourceId?: string; excerpt: string }) {
  const state = useContext(ReactionsContext)
  const [open, setOpen] = useState(false)
  if (!state || !sourceId) return null
  const mine = chipsOf(state.bySource.get(sourceId) ?? [], "human")
  const picker = (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-add-reaction
          aria-label="Add a reaction"
          title="Add a reaction"
          className={`inline-flex h-[22px] w-[26px] items-center justify-center rounded-full text-muted outline-none transition-opacity hover:bg-elevated hover:text-fg focus-visible:opacity-100 ${open ? "opacity-100 bg-elevated" : "opacity-0 group-hover/msg:opacity-100"}`}
        >
          <SmilePlus size={15} strokeWidth={1.75} aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="flex gap-0.5 p-1">
        {REACTION_EMOJI.map((e) => (
          <button
            key={e}
            type="button"
            data-reaction-choice={e}
            aria-pressed={mine.includes(e)}
            onClick={() => {
              state.toggle(sourceId, e, excerpt)
              setOpen(false)
            }}
            className={`flex h-8 w-8 items-center justify-center rounded-md text-[17px] leading-none outline-none hover:bg-fg/10 focus-visible:bg-fg/10 ${mine.includes(e) ? "bg-accent/10" : ""}`}
          >
            {e}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
  if (!mine.length) {
    return (
      <div data-message-reactions="human" className="relative h-0 overflow-visible">
        <div className="absolute left-[-4px] top-[2px]">{picker}</div>
      </div>
    )
  }
  return (
    <div data-message-reactions="human" className="flex flex-wrap items-center gap-1 pt-1.5">
      {mine.map((e) => (
        <button
          key={e}
          type="button"
          title="Remove the reaction"
          aria-label={`Remove the reaction ${e}`}
          onClick={() => state.toggle(sourceId, e, excerpt)}
          className={`${CHIP_CLASS} border-accent/60 bg-accent/10 outline-none hover:bg-accent/20 focus-visible:bg-accent/20`}
        >
          {e}
        </button>
      ))}
      {picker}
    </div>
  )
}
