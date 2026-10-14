import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { ChevronDown, Eye, EyeOff, FileCode2, Undo2, X } from "lucide-react"
import { embedded } from "../lib/embed.ts"
import { barAdd, barHints, contextBarReading, editorAddChord, isLeftOut, leaveOut, registerContextBar, requestEditorContext, setShareEditor, useEditorContext, type ContextBarReading, type ContextBox, type EditorContextState } from "../lib/editorContext.ts"
import { problemCountsLabel, useEditorExtras, type EditorExtrasState } from "../lib/editorReach.ts"
import { detectPlatform } from "../lib/keybindings.ts"
import { basename, dirnameLike } from "../lib/paths.ts"
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "./ui/Menu.tsx"

// THE CONTEXT BAR — the top strip inside a prompt box in an editor's sidebar (ARCHITECTURE.md § VS Code extension
// § The editor in the sidebar). It shows what the editor around the sidebar has in front, live from
// `ntwine:editor-context` (lib/editorContext.ts): the file, and when code is selected, its range and size.
//
// IT SAYS WHAT THE NEXT SEND CARRIES. A message sent from this box takes the selection with it — or, with
// nothing selected, the file's name and the caret's line — as Claude Code's VS Code extension and Cursor
// do (lib/editorContext.ts outgoingMessage), so the reading here is not a suggestion but the attachment
// itself. The EYE before it is the one switch for the editor reaching ntwine on its own — the extension's
// `ntwine.shareEditorState`, which also keeps the agents' editor tool out (lib/editorContext.ts
// setShareEditor): off, the reading is struck through and dimmed, so whether the code is going is legible
// without hovering anything. A click on the reading still adds it as a chip in THIS box, for the human who
// wants it placed in their sentence; the other open files are behind the control's chevron.
//
// The prior art the maintainer pointed at, in this app's own vocabulary: Claude Code's VS Code extension
// names the selection under its prompt ("26 lines selected"), Copilot Chat offers the current file as a
// chip the human clicks to attach, and Cursor's composer lists its context as pills along the top of the
// box. Here the pill the bar offers IS the chip it will make — the same `r2-private.ts:91-116` label
// (contextChipLabel) — so what the human clicks is what lands.
//
// LEAVING ONE OUT. Pointing at the reading turns its file glyph into a × (Cursor's context pills do the same
// with theirs): a click leaves THIS selection — or with nothing selected this file — out of the messages
// until the editor shows something else, while the eye stays on (lib/editorContext.ts leaveOut says why
// that is a different thing from the eye). Left out, the reading wears the eye-off state — struck, dimmed —
// so the two read alike at a glance: what is struck is not going. The glyph then offers to put it back.
// A hover affordance and not a fourth control on the strip: at 300px the hint already gets ~110px, and a
// × drawn at rest would take most of that for an act the human rarely needs.
//
// Two tones, because "is code highlighted right now" is the question the bar exists to answer at a
// glance (the maintainer asked for "some visual indicator" of it): a selection wears the accent, like
// the box's own focus ring; a file with nothing selected is a quiet outline — a suggestion.
//
// The control is a SPLIT button, the shape the lifecycle footer's snooze had (SnoozeButton, until
// 2026-10-05): the reading adds what it names, the chevron offers the rest. A separate "3 open files" label beside it was tried first and, in a 300px
// sidebar, took the room the file's own name needed — `r2-private.ts:91-116` truncated to `r:91-116`.
//
// Embed mode only: in a browser tab nothing writes the editor's context, and the bar renders nothing.
export function EditorContextBar({ box }: { box: ContextBox }) {
  return embedded() ? <Bar box={box} /> : null
}

function Bar({ box }: { box: ContextBox }) {
  const { active, open, share, leftOut: leftOutKey } = useEditorContext()
  // The file's problems and the terminal's last command (lib/editorReach.ts), offered in the chevron's
  // menu above the open files — so the chevron is there whenever either is, even with no file open.
  const extras = useEditorExtras()
  const more = open.length > 0 || Boolean(extras.problems || extras.terminal)
  const reading = contextBarReading(active)
  // Left out with the ×: only while the eye is on, which is the only time there is anything to leave out.
  const leftOut = share && isLeftOut({ active, leftOut: leftOutKey })
  const sending = share && !leftOut
  const chord = useMemo(() => editorAddChord(detectPlatform()), [])
  const hints = barHints({ sending: share, selection: reading?.kind === "selection", withheld: active?.withheld === true, chord, leftOut })
  // Registered by its strip, so ⌘I typed in this box presses it (lib/editorContext.ts addEditorContextByKey).
  // ⌘L typed here is not the bar's: it goes back to the editor, as Cursor's does (lib/embedKeys.ts).
  const strip = useRef<HTMLDivElement>(null)
  const drawn = Boolean(reading || more)
  useEffect(() => {
    if (!drawn || !strip.current) return
    return registerContextBar(strip.current, { key: box.key, projectDir: box.projectDir, surface: box.surface })
  }, [drawn, box.key, box.projectDir, box.surface])
  if (!drawn) return null
  const selection = reading?.kind === "selection"
  const add = () => {
    const what = barAdd(active)
    if (what) requestEditorContext(box, what)
  }
  // `inset-ring`, never `ring-inset`: that one is also a COLOUR utility here (theme.css --color-inset)
  // and paints every edge in it (Composer's CONTEXT_PILL has the measurement). Not sending — the eye off,
  // or this one left out — the reading takes the quiet outline whatever is selected: the accent says "this
  // goes with your message", and it does not.
  const lit = selection && sending
  const tone = lit
    ? "bg-accent/12 text-accent inset-ring-accent/35"
    : sending ? "text-muted inset-ring-border" : "text-muted-55 inset-ring-border"
  const hover = lit ? "hover:bg-accent/12" : "hover:bg-panel-2 hover:text-fg"
  // Struck through, not hidden: the human still sees what is in front, and that it is staying behind.
  const struck = sending ? "" : "line-through decoration-from-font"
  return (
    <div
      ref={strip}
      data-editor-context-bar
      data-editor-context-sending={reading ? String(share) : undefined}
      data-editor-context-left-out={reading && share ? String(leftOut) : undefined}
      className="flex items-center gap-2 px-1.5 pt-1.5"
    >
      {reading && <SendToggle sending={share} />}
      <div data-editor-context-control className={`flex h-6 min-w-0 items-stretch rounded-md text-[11.5px] leading-6 inset-ring transition-colors ${tone} ${reading ? "max-w-full" : ""}`}>
        {reading && (
          // The reading's half of the split: the glyph (the × on hover) and the label, one hover surface,
          // so pointing anywhere on the reading shows the × where the glyph was.
          <div data-editor-context-reading className={`group/reading flex min-w-0 items-baseline transition-colors ${more ? "rounded-l-md" : "rounded-md"} ${hover}`}>
            {share ? <LeaveOutToggle reading={reading} leftOut={leftOut} /> : <span className="flex shrink-0 items-baseline pl-1.5 pr-1"><span aria-hidden>{"\u200b"}</span><FileCode2 aria-hidden size="1em" strokeWidth={2.25} className={MARK} /></span>}
            <button
              type="button"
              data-editor-context={reading.kind}
              // Keep the caret where it is: the add comes back to this box and puts it after the chip.
              onMouseDown={(e) => e.preventDefault()}
              onClick={add}
              // The readings are separate spans spaced by the row's gap, so the text alone would read
              // "r2-private.ts:91-11626 lines" to a screen reader.
              aria-label={`Add ${reading.name}${reading.range}${reading.count ? `, ${reading.count},` : ""} to the prompt`}
              // The chord is the editor's: pressed here, it goes back to the editor (lib/embedHost.ts). ⌘I adds
              // from a box here, as the `?` sheet says (App.tsx app.details).
              title={active?.untitled ? `${reading.where} isn't saved, so it can't be added here` : `Add ${reading.where}${reading.range} at the caret (${chord} in the editor)`}
              // 7px, not 6, on the right when the chevron follows: its glyph carries 0.88px of side
              // bearing, and the rule between them should sit centred in ink (6.88 | 6.88, sans).
              className={`flex min-w-0 items-baseline gap-1 transition-colors ${FOCUS} ${more ? "pr-[7px]" : "rounded-r-md pr-1.5"}`}
            >
              {/* The name truncates and the range does not: `very-long-na…:1204-1288` still says which lines. */}
              <span className={`min-w-0 truncate ${struck}`}>{reading.name}</span>
              {reading.range && <span className={`-ml-1 shrink-0 ${struck}`}>{reading.range}</span>}
              {reading.count && <span className={`shrink-0 ${lit ? "text-accent/70" : ""} ${struck}`}>{reading.count}</span>}
            </button>
          </div>
        )}
        {reading && more && <span aria-hidden className="my-1.5 w-px shrink-0 bg-current opacity-20" />}
        {more && <OpenFiles box={box} open={open} extras={extras} labelled={!reading} hover={hover} />}
      </div>
      {hints.length > 0 && <Hint variants={hints} />}
    </div>
  )
}

/**
 * The reading's glyph, which is also its × (the header says why a hover affordance): at rest the file
 * glyph — one glyph in both states, since it is the same file either way and the pill lighting up IS the
 * news that lines are selected (Lucide's TextSelect was tried for the selection: at this size its dashed
 * box reads as a smudge) — and, while the reading is pointed at or this has the keyboard, a × that leaves
 * what is in front out of the messages, or, once it is left out, the arrow that puts it back.
 *
 * The glyph's 4px to the name is this button's right padding, the gap the reading's own row used to give
 * it, so the reading measures as it did before it had two halves.
 */
function LeaveOutToggle({ reading, leftOut }: { reading: ContextBarReading; leftOut: boolean }) {
  const what = reading.kind === "selection" ? "this selection" : "this file"
  const title = leftOut ? `Include ${what} in your message again` : `Leave ${what} out of your message`
  return (
    <button
      type="button"
      data-editor-context-leave-out
      aria-pressed={leftOut}
      aria-label={`Leave ${reading.name}${reading.range} out of your message`}
      title={title}
      // Keep the caret in the box, as the eye does: the human is mid-sentence.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => leaveOut(!leftOut)}
      className={`group/glyph flex h-6 shrink-0 items-baseline rounded-l-md pl-1.5 pr-1 transition-colors ${FOCUS} hover:text-fg`}
    >
      <span aria-hidden>{"\u200b"}</span>
      <FileCode2 aria-hidden size="1em" strokeWidth={2.25} className={`${MARK} group-hover/reading:hidden group-focus-visible/glyph:hidden`} />
      {leftOut
        ? <Undo2 aria-hidden size="1em" strokeWidth={2.25} className={`${MARK} hidden group-hover/reading:block group-focus-visible/glyph:block`} />
        : <X aria-hidden size="1em" strokeWidth={2.25} className={`${MARK} hidden group-hover/reading:block group-focus-visible/glyph:block`} />}
    </button>
  )
}

/**
 * The eye: whether the editor reaches ntwine on its own — a send from this box carrying what the editor has
 * in front, and ntwine's agents reading it through their editor tool. One switch for both, the extension's
 * `ntwine.shareEditorState`: an eye that kept the selection out of the message while an agent could still
 * read it through the tool would promise a privacy it did not keep. Every box with a bar shows the same
 * one — it is a habit of how the human works beside this editor, not a choice per message, as Claude Code's
 * toggle is — and, being a VS Code setting, it holds across reloads and in every window. Its glyph shows
 * the state (open: shared; struck: kept to yourself); its tooltip says what a click will do.
 */
function SendToggle({ sending }: { sending: boolean }) {
  const title = sending ? "Stop sharing the editor with ntwine" : "Share the editor with ntwine"
  return (
    <button
      type="button"
      data-editor-context-toggle
      aria-pressed={sending}
      aria-label="Share the editor with ntwine"
      title={title}
      // Keep the caret in the box: the human is mid-sentence, deciding what goes with it.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => setShareEditor(!sending)}
      // A baseline row with a zero-width space, like the chevron's half of the control: the glyph then
      // rides the reading's own baseline and sits on its cap band (MARK), rather than centred in a box.
      className={`flex h-6 shrink-0 items-baseline rounded-md px-1 text-[11.5px] leading-6 transition-colors ${FOCUS} hover:bg-panel-2 hover:text-fg ${sending ? "text-muted" : "text-muted-55"}`}
    >
      <span aria-hidden>{"\u200b"}</span>
      {sending ? <Eye aria-hidden size="1.1em" strokeWidth={2} className={MARK} /> : <EyeOff aria-hidden size="1.1em" strokeWidth={2} className={MARK} />}
    </button>
  )
}

/**
 * The other files open in the editor, each one a whole-file chip — after the file's problems and the
 * terminal's last command when the editor has them, each one chip (`@problems`, `@terminal`). Labelled
 * when it is all the bar has.
 */
function OpenFiles({ box, open, extras, labelled, hover }: { box: ContextBox; open: EditorContextState["open"]; extras: EditorExtrasState; labelled: boolean; hover: string }) {
  const count = open.length ? `${open.length} open ${open.length === 1 ? "file" : "files"}` : ""
  const hasExtras = Boolean(extras.problems || extras.terminal)
  const title = hasExtras ? `More to add${count ? ` (${count})` : ""}` : `Add an open file (${count})`
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          data-editor-open-files
          aria-label={title}
          title={title}
          className={`flex shrink-0 items-baseline transition-colors ${FOCUS} ${labelled ? "gap-0.5 rounded-md px-1.5" : "rounded-r-md px-1"} ${hover} data-[state=open]:bg-panel-2 data-[state=open]:text-fg`}
        >
          {/* The chevron rides a text baseline like every glyph beside text. Alone in the split's right
              half it has no text of its own, and a baseline row then took its BOX bottom as the
              baseline — it rode 3px high; centred on the control instead it sat 0.5px low of the
              reading's cap band. A zero-width space gives it the reading's own baseline: 0.00px. */}
          {labelled ? count || "More to add" : <span aria-hidden>{"\u200b"}</span>}
          <ChevronDown aria-hidden size="1em" strokeWidth={2.25} className={MARK} />
        </button>
      </MenuTrigger>
      {/* Kept 8px off the frame's edges: a sidebar is narrow enough that the menu usually has to shift. */}
      <MenuContent align="start" collisionPadding={8}>
        <div className="max-h-72 max-w-[min(26rem,calc(100vw-24px))] overflow-y-auto">
          {extras.problems && (
            <MenuItem onSelect={() => requestEditorContext(box, { what: "problems" })}>
              <span data-editor-extra="problems" title={`Add the problems in ${extras.problems.label}`} className="flex min-w-0 items-baseline gap-1.5">
                <span className="shrink-0">Add problems in this file</span>
                <span className="min-w-0 truncate text-[11px] text-muted-55">{problemCountsLabel(extras.problems)}</span>
              </span>
            </MenuItem>
          )}
          {extras.terminal && (
            <MenuItem onSelect={() => requestEditorContext(box, { what: "terminal" })}>
              <span data-editor-extra="terminal" title={extras.terminal.command ? `Add ${extras.terminal.command} and its output` : "Add the last command and its output"} className="flex min-w-0 items-baseline gap-1.5">
                <span className="shrink-0">Add last terminal command</span>
                {extras.terminal.command && <span className="min-w-0 truncate text-[11px] text-muted-55">{extras.terminal.command}</span>}
              </span>
            </MenuItem>
          )}
          {hasExtras && open.length > 0 && <MenuSeparator />}
          {open.length > 0 && <div className="px-2.5 pb-1 pt-1 text-[11px] text-muted-55">Add an open file</div>}
          {open.map((file) => (
            <MenuItem key={file.path} onSelect={() => requestEditorContext(box, { what: "file", path: file.path })}>
              <span data-editor-open-file={file.label} title={file.label} className="flex min-w-0 items-baseline gap-1.5">
                <span className="shrink-0">{basename(file.label)}</span>
                {dirnameLike(file.label) && <span className="min-w-0 truncate text-[11px] text-muted-55">{dirnameLike(file.label)}</span>}
              </span>
            </MenuItem>
          ))}
        </div>
      </MenuContent>
    </Menu>
  )
}

/**
 * What the bar means, said beside it (lib/editorContext.ts barHints): what goes with the message on its own,
 * and what the editor's chord adds — a chip at the caret, to point at code mid-sentence. The longest
 * wording that fits the room the control leaves, measured — never one cut to "Selections go with yo…", and
 * nothing at all when even the short one does not fit (the eye's and the reading's tooltips say it too).
 * The room changes with the file's name as much as with the sidebar's width, so a fixed breakpoint could
 * not pick.
 */
function Hint({ variants }: { variants: readonly string[] }) {
  const slotRef = useRef<HTMLSpanElement>(null)
  const measureRef = useRef<HTMLSpanElement>(null)
  const [fit, setFit] = useState(0)
  useLayoutEffect(() => {
    const slot = slotRef.current
    const measure = measureRef.current
    if (!slot || !measure) return
    const choose = () => {
      const room = slot.clientWidth - parseFloat(getComputedStyle(slot).paddingRight)
      const widths = [...measure.children].map((child) => (child as HTMLElement).offsetWidth)
      const index = widths.findIndex((width) => width <= room)
      setFit(index === -1 ? variants.length : index)
    }
    choose()
    const observer = new ResizeObserver(choose)
    observer.observe(slot)
    return () => observer.disconnect()
  }, [variants.join("\n")])
  return (
    // `pr-0.5`: the text's last ink then sits 9px in from the box's edge, over the send button's (sans).
    <span ref={slotRef} data-editor-context-hint className="relative min-w-0 flex-1 overflow-hidden whitespace-nowrap pr-0.5 text-right text-[11px] leading-6 text-muted-70">
      {variants[fit]}
      <span ref={measureRef} aria-hidden data-hint-measure className="invisible absolute left-0 top-0 flex">
        {variants.map((variant) => <span key={variant}>{variant}</span>)}
      </span>
    </span>
  )
}

// The app's 1px focus ring, drawn inside each half so it follows that half's corners. Without it Tab drew
// the browser's own outline, a thick double ring (sweep 2026-10-01). `inset-ring`, never `ring-inset`
// (the tone above says why).
const FOCUS = "outline-none focus-visible:inset-ring-1 focus-visible:inset-ring-focus-ink-60"

// A 1em glyph on the text's cap band (CLAUDE.md § optical spacing): baseline-aligned in a baseline row,
// lifted by half its box less half the font's own cap height — so it sits right in either font, at any
// size, with nothing measured by hand.
const MARK = "shrink-0 self-baseline translate-y-[calc(0.5em_-_0.5cap)]"
