import { useQuery } from "@tanstack/react-query"
import { FileCode2 } from "lucide-react"
import { useSnapshot } from "valtio"
import { rpc } from "../api/rpc.ts"
import { showToast, store } from "../store.ts"
import { composeInto } from "../lib/editorBridge.ts"
import type { ContextBox } from "../lib/editorContext.ts"
import { editorLineReading, editorLineWanted } from "../lib/editorFront.ts"
import { embedded } from "../lib/embed.ts"
import { useIsMobile } from "../lib/mobile.ts"
import { basename } from "../lib/paths.ts"

/**
 * THE EDITOR BESIDE THIS TAB, in one quiet line at the right of a prompt box's footer — `VS Code: a.ts:12-20`
 * — naming what the agents' editor tool would read now, and adding it as a chip on a click (lib/
 * editorFront.ts says why a browser tab gets this and the sidebar gets its whole bar instead).
 *
 * In the footer, not along the top as the sidebar's bar is: the bar is the sidebar's main way in and earns
 * its row, while here the line is a side note beside a box the human mostly uses for other things, so it
 * takes the footer's free right end and costs the box no height. Muted and borderless like the footer's
 * interrupt hint, so it reads as information first and a control on hover — the paperclip's hover.
 *
 * Nothing renders until the server says a window with this project shares its editor: with VS Code closed,
 * sharing off, or another project in front, the box is exactly as it was.
 */
export function EditorLine({ box }: { box: ContextBox }) {
  const phone = useIsMobile()
  const { editorWindows } = useSnapshot(store)
  const wanted = editorLineWanted({ embedded: embedded(), phone, windows: editorWindows })
  const query = useQuery({
    // Keyed by the box's project folder: the page's RPC base follows the project the box writes to (the
    // address), and the folder changes with it, so a box re-aimed at another project asks that one.
    queryKey: ["editorFront", box.projectDir ?? ""],
    queryFn: async () => (await rpc.editorFront({})).front,
    enabled: wanted,
    // An ntwine from before the procedure answers 404: no line, and no retry storm over it.
    retry: false,
    // The `editor-front` ping is what refreshes it (lib/editorBridge.ts editorFrontChanged), and a focus
    // back on the tab — the human returning from the editor — asks again as well (the query default).
    staleTime: 60_000,
  })
  const front = wanted ? query.data ?? null : null
  if (!front) return null
  const reading = editorLineReading(front, box.projectDir)
  const name = basename(front.path)
  const range = reading.label.slice(name.length)
  const add = async () => {
    try {
      // The text now, and only now: the line itself never carried it.
      const { item } = await rpc.editorFront({ text: true })
      if (!item) {
        showToast(`Nothing to add from ${reading.editor}`, { detail: "It no longer has a file in front for this project." })
        return
      }
      const outcome = await composeInto(item, { target: { box }, focus: true })
      if (!outcome.ok) showToast(`Couldn't add ${basename(item.path)} to the prompt box`, { detail: outcome.reason, duration: 6000 })
    } catch (error) {
      showToast(`Couldn't read ${reading.editor}`, { detail: error instanceof Error ? error.message.slice(0, 100) : undefined })
    }
  }
  return (
    <button
      type="button"
      data-editor-line
      data-editor-line-selection={String(reading.selection)}
      title={reading.title}
      aria-label={reading.addable ? `Add ${reading.label} from ${reading.editor} to the prompt` : `${reading.label} in ${reading.editor}`}
      // Keep the caret in the box: the chip lands at its end and the caret goes after it.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => void add()}
      disabled={!reading.addable}
      // `ml-auto`: the footer's free right end. The interrupt hint after it drops its own auto margin
      // (Composer), so the two sit together at the right rather than splitting the free space between them.
      // `pt-px`: the readouts before it (the project and model pills) set their 10px small caps 1px lower
      // in the same centred row than 11px text sits in this 24px box — measured 195.56 against 196.56,
      // sans, in both boxes — and text on one row is read by its baseline. The padding moves the text,
      // not the hover square, which stays centred on the pills.
      className="ml-auto flex h-6 min-w-0 max-w-full shrink items-baseline gap-1 rounded-md px-1.5 pt-px text-[11px] leading-6 text-muted-70 outline-none transition-colors focus-visible:inset-ring-1 focus-visible:inset-ring-focus-ink-60 enabled:hover:bg-panel-2/70 enabled:hover:text-fg"
    >
      {/* A baseline for the glyph to ride (the context bar's own trick), so it sits on the cap band. */}
      <span aria-hidden>{"​"}</span>
      <FileCode2 aria-hidden size="1em" strokeWidth={2.25} className={MARK} />
      <span className="shrink-0">{reading.editor}:</span>
      {/* The name truncates and the range does not, as on the sidebar's bar. */}
      <span className="min-w-0 truncate">{name}</span>
      {range && <span className="-ml-1 shrink-0">{range}</span>}
    </button>
  )
}

// The context bar's placement for a 1em glyph beside text (EditorContextBar MARK): on the cap band in any
// font, at any size, computed by the browser rather than measured by hand.
const MARK = "shrink-0 self-baseline translate-y-[calc(0.5em_-_0.5cap)]"
