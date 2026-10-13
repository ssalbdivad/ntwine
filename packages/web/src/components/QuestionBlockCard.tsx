// THE question card — the single component every question in ntwine renders through, whatever produced
// it. There are two producers and one look:
//
//   1. a ```question fence in an assistant message (lib/questionBlocks.ts parses the markdown), and
//   2. a NATIVE AskUserQuestion tool call from the Claude session broker, whose interaction record is
//      converted to the same model by lib/interactionQuestion.ts.
//
// They share a data model, which is why they can share a component: a question, numbered options each
// with a one-line trade-off, an optional "select several" mode, and a free-text box at the bottom. The
// tool call's `multiSelect` IS the fence's `multi` tag; its `options[].label/description` ARE the
// fence's option lines. Anything that reads as a difference between them is a bug in a producer, not a
// reason for a second card (maintainer 2026-07-27: "Ideally, they could share a component").
//
// It lives in its own module rather than in ChatView so BOTH producers can reach it: the interaction
// surface (InteractionCards.tsx) is imported BY ChatView, so a question card defined inside ChatView
// could only have been shared through a module cycle.
import { Fragment, type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef } from "react"
import { AlertTriangle, Check } from "lucide-react"
import { SECRET_ANSWER_MASK } from "@ntwine/shared"
import { useInlineMarkdownHtml, useMarkdownHtml } from "../lib/useMarkdown.ts"
import { shouldSubmitStagedEnter } from "../lib/composerKeyboard.ts"
import { parseQuestionBlock, splitOptionId, type BlockAnswer, type ParsedQuestion, type QuestionKind } from "../lib/questionBlocks.ts"
import { registerQuestionKeys, type QuestionKeyResult } from "../lib/questionKeys.ts"
import { LinkedHtml } from "./LinkedHtml.tsx"
import { SecretCaption } from "./SecretCaption.tsx"
import { QUEUE_WRAP, TranscriptCard } from "./TranscriptCard.tsx"
import { TextareaCodeFences } from "./TextareaCodeFences.tsx"

export interface BlockInteractive {
  answer: BlockAnswer
  onChip: (optIdx: number, optText: string) => void
  /** The free-text box's content. CONTRACT for a single-select question: the producer must also drop
   *  `answer.chosen` — the card calls this with the text UNCHANGED when the box takes focus, and that
   *  call is what unselects the chip. Two producers wrote only the text and left the chip lit beside
   *  a focused box until 2026-08-28. MULTI keeps its toggled set. */
  onText: (text: string) => void
  onSubmit: () => void
  /** What Enter means in this card, when the producer decides it rather than the batch walk below. The
   *  registered producer sends ONE QUESTION per Enter (2026-09-29): it walks that question's own
   *  unanswered follow-ups first, then sends it and moves on — never the others. Handed the options grid
   *  of the node the key was pressed in. Absent: `advanceOrSubmit`, the fence and native producers' batch. */
  onEnter?: (grid: HTMLElement) => void
}

/** Put the caret in a question node: its free-text box (a secret's password field) when it has one, else its options grid, scrolled
 *  just into view. `node` is a `[data-answerable-question]` grid. */
export function focusQuestionNode(node: HTMLElement) {
  const target = node.querySelector<HTMLElement>("[data-surface='questionAnswer']") ?? node
  target.focus({ preventScroll: true })
  target.scrollIntoView({ block: "nearest" })
}

/**
 * Enter inside ONE card of a batch moves on to the next UNANSWERED card rather than sending the whole
 * batch; only once none is left does it send. Every producer's `onSubmit` sends EVERY staged answer at
 * once, so a bare send here shipped a seven-question ask with one answer typed in (maintainer
 * 2026-09-29: "if i'm in a question checkbox, it probably shouldn't submit the whole response"). The
 * batch is the nearest `[data-question-set]` the producer stamps; a card outside one (the mobile sheet,
 * which steps through its blocks itself) keeps the plain send. The Send answers button still sends
 * whatever is staged — this changes only what Enter means.
 */
function advanceOrSubmit(grid: HTMLElement, submit: () => void) {
  const set = grid.closest("[data-question-set]")
  if (set) {
    const cards = [...set.querySelectorAll<HTMLElement>("[data-answerable-question]")]
    const at = cards.indexOf(grid)
    // After this card first, then wrapping round to the ones above it.
    const order = at < 0 ? cards : [...cards.slice(at + 1), ...cards.slice(0, at)]
    const next = order.find((c) => c.dataset.answered === "false")
    if (next) {
      focusQuestionNode(next)
      return
    }
  }
  submit()
}

// A ```question block, set off from the surrounding prose: rounded neutral border + slightly elevated
// bg + a muted label (NOT yellow — that's the focus motif). The label tracks the kind — "Question" for
// a plain ask, "Select multiple" for `multi` — with no corner glyph (see KindIcon below for why it was
// dropped). A `danger` block (the destructive gate — force-merge, deletion, rollback) layers the app's
// red risk language (the same text-danger family the bypass permission mode uses) with a warning glyph.
// The context renders as markdown; the convention-parsed trailing options render as choice chips (radio
// feel for single-select, toggleable checkboxes for `multi`) and the "Recommendation:" line as a muted
// note. When `interactive` is present (the live message), chips are clickable and a freetext textarea
// appears; otherwise everything is read-only. How an answer is SENT is the producer's: a fence and a
// native ask stage every answer until Send answers (the native tool call returns all of them at once),
// while a REGISTERED question is sent the moment it is complete — a single-choice pick, an Enter in its
// own box, a multi's confirm — one question at a time (RegisteredQuestionCards, 2026-09-29).
//
// THE MODEL IT RENDERS is `ParsedQuestion` (lib/questionBlocks.ts) — the neutral shape, not a
// fence-shaped one. A caller supplies EITHER the raw fence body (producer 1, parsed here) or an
// already-built `question` (producer 2, the native tool call). Everything below this line reads only
// from `parsed`, so neither producer can drift into its own styling.
export function QuestionBlockCard({
  raw,
  question,
  questionKind,
  danger,
  interactive,
  wrap,
  aside,
  label,
  settled,
  footer,
}: {
  /** Producer 1: the raw body of a ```question fence, parsed here. */
  raw?: string
  /** Producer 2: an already-built question (a native AskUserQuestion tool call). */
  question?: ParsedQuestion
  questionKind?: QuestionKind
  danger?: boolean
  interactive?: BlockInteractive
  wrap?: boolean
  /** A control for the card's TITLE ROW, at its far right — the shared chrome's own `aside` slot.
   *  Producer 3's × for dismissing a registered question rides here rather than being absolutely
   *  positioned over the card, which put it half outside the border. Absent for the two producers
   *  that have nothing to put there. */
  aside?: ReactNode
  /** Overrides the card's kind title. Producer 3 heads a FOLLOW-UP "Follow-up" rather than "Question":
   *  a branch's cards are siblings in the DOM, and three cards all titled "Question" read as three
   *  unrelated asks however far the second two are indented. Absent ⇒ the kind's own word. */
  label?: string
  /** Producer 4: the SETTLED state of a native ask read back out of the transcript. Read-only by
   *  definition (never combined with `interactive`): `chosenIdxs` are the options the recorded answer
   *  named (rendered in the AnswersCard's quiet settled treatment, never the awaiting-you accent),
   *  `text` an answer that named none, and neither ⇒ the ask ended unanswered, which renders a muted
   *  "Not answered" note. */
  settled?: { chosenIdxs: number[]; text?: string }
  /** A control for the card's last line, inside its border — producer 3's own Send for a question
   *  holding an answer nothing has sent, so it reads as THIS question's and not the group's. */
  footer?: ReactNode
}) {
  const parsed = useMemo(
    () => question ?? parseQuestionBlock(raw ?? "", questionKind ?? "question", danger),
    [question, raw, questionKind, danger],
  )
  const html = useMarkdownHtml(parsed.contextMd)
  const trailingHtml = useMarkdownHtml(parsed.trailingMd ?? "")
  const recIdxs = parsed.recommendedIdxs
  const recHtml = useInlineMarkdownHtml(parsed.recommendation ?? "")
  const isMulti = parsed.kind === "multi"
  const isDanger = parsed.danger
  const chosen = interactive?.answer.chosen ?? null
  const chosenSet = interactive?.answer.chosenSet ?? []
  const freetext = interactive?.answer.text ?? ""
  // Whether this card holds an answer the send would carry — read by a SIBLING card's Enter (see
  // advanceOrSubmit) off the grid's data-answered, so it must track the staged state exactly.
  const answered = isMulti ? chosenSet.length > 0 || freetext.trim() !== "" : chosen !== null || freetext.trim() !== ""
  // The free-text answer is an AUTO-EXPANDING textarea (not a fixed one-line input): reset to `auto`
  // so it can SHRINK when text is deleted, then lock to the content height so the box grows line-by-line
  // as the answer is typed. Runs on every freetext change (incl. an external clear via a chip-click).
  const taRef = useRef<HTMLTextAreaElement>(null)
  // The options grid is the card's keyboard rest: a chip click parks focus here (see the chip's
  // onClick) so Enter sends the staged answers immediately after picking an option, without the
  // free-text box having to hold focus. tabIndex=-1: reachable by script, skipped by Tab.
  const gridRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = "auto"
    // box-sizing is border-box (Tailwind preflight), so the style height must INCLUDE the borders —
    // else clientHeight lands a couple px short of scrollHeight and the last line clips (overflow is
    // hidden). `offsetHeight - clientHeight` is the vertical border delta measured at height:auto.
    ta.style.height = `${ta.scrollHeight + ta.offsetHeight - ta.clientHeight}px`
  }, [freetext])
  // NUMBER KEYS (lib/questionKeys.ts): key n picks option n, the key one past the last option takes the
  // caret to the free-text row. Registered once per mount; `keysRef` hands the router the latest render's
  // controller, so a pick never acts on the answer as it stood when the card mounted.
  const keysRef = useRef({ interactive, isMulti, chosen, chosenSet, freetext, count: parsed.options.length })
  keysRef.current = { interactive, isMulti, chosen, chosenSet, freetext, count: parsed.options.length }
  const answerable = !!interactive
  useEffect(() => {
    const grid = gridRef.current
    if (!grid || !answerable) return
    return registerQuestionKeys(grid, {
      press: (n): QuestionKeyResult => {
        const k = keysRef.current
        if (!k.interactive || k.count === 0) return false
        if (n === k.count + 1 && taRef.current) {
          taRef.current.focus()
          return "text"
        }
        if (n > k.count) return false
        k.interactive.onChip(n - 1, parsed.options[n - 1] ?? "")
        return k.isMulti ? "toggled" : "picked"
      },
      keyed: () => keysRef.current.count > 0,
      row: (n) => {
        const k = keysRef.current
        if (!k.interactive || k.count === 0) return null
        if (n === k.count + 1) return taRef.current?.parentElement ?? null
        return n <= k.count ? grid.querySelectorAll<HTMLElement>(":scope > [data-question-option]")[n - 1] ?? null : null
      },
      answered: () => {
        const k = keysRef.current
        return k.isMulti ? k.chosenSet.length > 0 || !!k.freetext.trim() : k.chosen !== null || !!k.freetext.trim()
      },
    })
  }, [answerable, parsed])
  // NO corner glyph on an answerable question (dropped 2026-08-31). The registered-question × rides
  // the same corner, and beside it a full-strength HelpCircle/ListChecks read as the actionable thing
  // while the actual control read as chrome (maintainer: "the actionable thing is gray and light,
  // whereas the not actionable thing is a very bold white color"). The title word already names the
  // kind. The `danger` warning glyph stays: it is a real warning, not decoration, and a danger card
  // never offers the × (see RegisteredQuestionCards), so the collision cannot arise there.
  const KindIcon = isDanger ? AlertTriangle : undefined
  // Sentence case, because the shared chrome renders this as a real TITLE now rather than as an
  // uppercased eyebrow — a lowercase "question" beside the card's glyph reads as a typo.
  const kindLabel = label ?? (parsed.secret ? "Secret" : isMulti ? "Select multiple" : "Question")
  // `risk`, not `danger`: the neutral border with a red title. A destructive gate is a question nobody
  // has answered wrongly yet, not a thing that has broken, and it wore the same lit red border as a dead
  // sign-in until 2026-08-26 (maintainer: they "look way too scary"). The tag's CRITERIA are unchanged
  // and stay narrow — force-merge, deletion, history rewrite, prod rollback — so these should almost
  // never appear; what changed is how loudly one of them shouts.
  return (
    <TranscriptCard tone={isDanger ? "risk" : "neutral"} surface="question" icon={KindIcon} label={kindLabel} aside={aside}>
      {/* FULL-strength, against the card's stepped-down description colour: this card's body is not a
          description of the title, it IS the ask, and the question must never read dimmer than the
          word "Question" above it. The colour rides a WRAPPER because `.card-md .md-body` inherits
          colour by design (and outranks a utility class on the element itself). */}
      {html && (
        <div className="text-fg">
          <LinkedHtml className={`md-body${wrap ? ` ${QUEUE_WRAP}` : ""}`} html={html} />
        </div>
      )}
      {(parsed.options.length > 0 || interactive) && (
        // Options stack in a SINGLE full-width column (maintainer 2026-07-10: a 2-col grid read as
        // ragged, uneven columns with dead whitespace once option text got long). One chip per row;
        // the free-text row keeps col-span-full so the "something else…" answer gets the whole line.
        <div
          ref={gridRef}
          tabIndex={-1}
          // Enter (or ⌘/Ctrl-Enter) sends the staged answers from inside the options grid — above all
          // right after a chip click, which focuses the grid. The free-text box below handles the
          // same keys itself and stops propagation, so this can never double-fire. A Tab-focused
          // chip button or a link inside a chip keeps its native Enter (select the option / follow
          // the link): the send only fires when the grid ITSELF holds focus.
          onKeyDown={(e) => {
            if (!interactive || e.target !== e.currentTarget) return
            if (shouldSubmitStagedEnter({
              key: e.key,
              altKey: e.altKey,
              ctrlKey: e.ctrlKey,
              metaKey: e.metaKey,
              shiftKey: e.shiftKey,
              isComposing: e.nativeEvent.isComposing,
              keyCode: e.nativeEvent.keyCode,
            })) {
              e.preventDefault()
              e.stopPropagation()
              if (interactive.onEnter) interactive.onEnter(e.currentTarget)
              else advanceOrSubmit(e.currentTarget, interactive.onSubmit)
            }
          }}
          data-answerable-question={interactive ? "" : undefined}
          data-answered={interactive ? String(answered) : undefined}
          data-question-grid
          className="group/qgrid mt-2 grid grid-cols-1 gap-1.5 outline-none"
        >
          {parsed.options.map((opt, i) => (
            <Fragment key={i}>
              {/* A group heading the worker wrote between choices ("Melee family:" over D–F). It rides
                  WITH its option rather than being stranded below the chips as unanswerable prose, and
                  wears the SAME body treatment as the context above — the FIRST group's heading is just
                  the tail of that context, so a muted caption here would make two identical things
                  render differently in one card. */}
              {parsed.optionHeadings?.[i] && <OptionHeading md={parsed.optionHeadings[i]!} wrap={wrap} />}
            <Chip
              label={opt}
              index={i}
              // The option's BODY — a multi-line trade-off, the diff, the mockup, the message that
              // would actually be posted — rendered INSIDE the chip, ALWAYS, read-only cards included.
              // It was `optionPreviews`, revealed only once the option was picked, until 2026-09-01:
              // detail that decides a choice arrived after the choice, and content appearing under a
              // click read as an accident (maintainer: "you should just be rendering it as part of the
              // answer before I click on it").
              bodyMd={parsed.optionBodies?.[i]}
              wrap={wrap}
              multi={isMulti}
              // The recommendation renders INSIDE its option as a badge (not as a caption below);
              // the inline `(recommended: why)` rationale (or a legacy rec line) rides the chip's title.
              // A `multi` may badge several options — the set worth ticking; the note is the first's.
              recommended={recIdxs.includes(i)}
              recTitle={recIdxs[0] === i ? parsed.recommendedNote : undefined}
              // MULTI: selected == toggled in the set (coexists with freetext). SINGLE: selected while
              // the chip is the staged answer — re-clicking it toggles it off, and the free-text box
              // taking focus clears it (via onText). Text left in the box is an unselected draft, so it
              // no longer gates the highlight.
              selected={isMulti ? chosenSet.includes(i) : chosen === i}
              settledPick={settled?.chosenIdxs.includes(i) ?? false}
              disabled={!interactive}
              onClick={() => {
                interactive?.onChip(i, opt)
                // Park keyboard focus on the options grid, so an Enter sends right after the click
                // (the grid's own onKeyDown above). MULTI with the note box focused is the one
                // exception: chips and a color note coexist there, so the caret stays put — and that
                // box sends on Enter itself anyway. For SINGLE this also blurs the
                // free-text input (its mousedown is prevented, so clicking a chip won't blur it),
                // whose accent focus border would otherwise sit next to the chip's. Scoped to THIS
                // block's own elements by ref, not by a data- tag: the queue card also renders a
                // free-form composer alongside an open ask, and a tag match would steal the caret
                // out of that unrelated box whenever a chip is clicked.
                if (isMulti && taRef.current && document.activeElement === taRef.current) return
                gridRef.current?.focus()
              }}
            />
            </Fragment>
          ))}
          {/* The free-text answer IS the final option — but it SPANS THE FULL WIDTH (col-span-full)
              below the multi-column options, and is an auto-growing textarea (see taRef effect above)
              rather than a one-line input, so a long "something else…" answer stays fully visible. */}
          {interactive && (
            // The free-text row takes the next number's keycap when the question has options, laid over
            // the box's left padding so the box itself keeps its own border and focus treatment. It sits
            // on the BASELINE of the box's first line (a textarea is a baseline item in Chrome and
            // Safari), the same rule the option rows use, so the browser places the digit and the text on
            // one line at every zoom. A hand-set `top-[7px]` measured 0.8px high at 110% zoom and 0.4px
            // low at 600%: the two snapped to device pixels independently. The -mr cancels the cap's
            // 13px + 16px, so the box still starts at the row's left edge.
            <div className={`relative col-span-full${parsed.options.length > 0 ? " flex items-baseline" : ""}`}>
            {parsed.options.length > 0 && (
              <span className="pointer-events-none relative z-10 ml-[13px] -mr-[29px] flex">
                <OptionKey n={parsed.options.length + 1} live />
              </span>
            )}
            {parsed.secret ? (
              // A SECRET IS A PASSWORD FIELD, not a masked textarea: `type="password"` is what tells a
              // phone keyboard to stop predicting and learning what is typed, and a password manager to
              // offer a fill. One line, because a code or a token is one line. Its value lives in the
              // answering state's memory, never the draft store (RegisteredQuestionCards).
              <>
                <input
                  type="password"
                  data-secret-answer
                  data-claims-escape
                  data-surface="questionAnswer"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  aria-label="Secret value"
                  value={freetext}
                  onChange={(e) => interactive.onText(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === "Escape") {
                      e.preventDefault()
                      gridRef.current?.focus()
                      return
                    }
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      if (gridRef.current && interactive.onEnter) interactive.onEnter(gridRef.current)
                      else if (gridRef.current) advanceOrSubmit(gridRef.current, interactive.onSubmit)
                      else interactive.onSubmit()
                    }
                  }}
                  placeholder="Paste the value…"
                  className={`block w-full rounded-md border py-1.5 pl-3 pr-3 text-[12px] leading-snug text-fg/90 outline-none placeholder:text-muted-80 transition-colors ${
                    freetext.trim() ? "border-selection-border bg-selection" : "border-border bg-transparent hover:bg-panel-2 focus:border-accent"
                  }`}
                />
                <SecretCaption className="mt-2 text-[11px] leading-snug text-muted" />
              </>
            ) : (
            <>
            <textarea
              ref={taRef}
              data-1p-ignore
              rows={1}
              // Its own surface tag — deliberately NOT the queue card's `queueComposer`, which is the
              // separate free-form prompt box at the bottom of the card. Escape climbs out onto this
              // question's own options grid (where the number keys answer it) and stops here rather
              // than reaching the drawer stack's window handler; a second Escape, from the grid,
              // closes the drawer.
              //
              // Stopping the key alone does NOT keep an enclosing thread drawer open — Radix's
              // DismissableLayer takes Escape on the document in the CAPTURE phase, before this
              // bubble-phase handler runs (verified 2026-07-26). `data-claims-escape` is what does:
              // ThreadSheet's onEscapeKeyDown refuses the dismiss for a target inside it, as it does
              // for the prompt box and the title editor. Without it one Escape in an answer closed the
              // whole drawer — on the desktop and in VS Code's sidebar alike, where the drawer is the
              // only place to answer and the human landed back on the queue (draft kept).
              data-claims-escape
              data-surface="questionAnswer"
              value={freetext}
              onChange={(e) => interactive.onText(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === "Escape") {
                  e.preventDefault()
                  // Climb out onto this question's own options, where the number keys answer it.
                  gridRef.current?.focus()
                  return
                }
                // Enter (or ⌘/Ctrl-Enter) sends the staged answers; Shift/Option-Enter write a
                // NEWLINE (the browser default) — the three Enter keys every box shares since
                // 2026-08-26. See shouldSubmitStagedEnter.
                if (shouldSubmitStagedEnter({
                  key: e.key,
                  altKey: e.altKey,
                  ctrlKey: e.ctrlKey,
                  metaKey: e.metaKey,
                  shiftKey: e.shiftKey,
                  isComposing: e.nativeEvent.isComposing,
                  keyCode: e.nativeEvent.keyCode,
                })) {
                  e.preventDefault()
                  if (gridRef.current && interactive.onEnter) interactive.onEnter(gridRef.current)
                  else if (gridRef.current) advanceOrSubmit(gridRef.current, interactive.onSubmit)
                  else interactive.onSubmit()
                }
              }}
              // SINGLE: clicking into the input MOVES the selection here — any chosen chip deselects (its
              // accent border must not linger once the user commits to typing). MULTI keeps its toggled
              // set (the freetext only appends color), so don't disturb it on focus. Keeps typed text.
              onFocus={() => {
                if (!isMulti && chosen !== null) interactive.onText(freetext)
              }}
              // No identifier in the placeholder: the row's keycap carries the next number.
              placeholder={
                isMulti ? "Add a note…" : parsed.options.length ? "Something else…" : "Type your answer…"
              }
              // Styled as the FINAL option row (same shape as a chip) that SPANS both grid columns.
              // resize-none + overflow-hidden hand height control to the auto-grow effect (no manual
              // drag handle, no inner scrollbar). The tinted bg marks the EFFECTIVE answer: content
              // with no chip chosen (a chosen chip beats the text, so text beside one is an unselected
              // draft and the box goes quiet, exactly like an unselected chip). Focus always shows the
              // accent border — the selection moves here the moment the box is entered.
              className={`block w-full min-w-0 flex-1 resize-none overflow-hidden rounded-md border py-1.5 pr-3 ${parsed.options.length > 0 ? OPTION_TEXT_INSET : "pl-3"} text-[12px] leading-snug text-fg/90 outline-none placeholder:text-muted-80 transition-colors ${
                freetext.trim() && (isMulti || chosen === null) ? "border-selection-border bg-selection" : "border-border bg-transparent hover:bg-panel-2 focus:border-accent"
              }`}
            />
            {/* The mirror is the textarea's NEXT sibling and absolutely positioned, so the row's flex
                line still holds only the keycap and the box. */}
            <TextareaCodeFences value={freetext} />
            </>
            )}
            </div>
          )}
        </div>
      )}
      {/* The SETTLED answer, when it named no option (free text, or a label the parse could not match):
          the AnswersCard's quiet recessed chip — a past choice, never the awaiting-you accent. */}
      {/* pl-[11px] matches the settled chips above: 11 + the 2px rule = the plain chips' 12 + 1. */}
      {settled?.text && (
        <div className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere] rounded-md border border-border-strong border-l-2 border-l-accent/40 bg-bg/50 py-1.5 pl-[11px] pr-3 text-[12px] leading-snug text-fg">
          {/* A secret draws the masked field it was typed into — never the delivery note the worker
              reads in its place (where the value went, and on what terms). */}
          {parsed.secret ? SECRET_ANSWER_MASK : settled.text}
        </div>
      )}
      {/* A settled ask nobody answered — the operator steered past it, or the session moved on. The
          note is what keeps the read-only card honest: the chips above are dim and unclickable, and
          without a word saying so the card reads as merely waiting. */}
      {settled && settled.chosenIdxs.length === 0 && !settled.text && (
        <div className="mt-2 text-[11px] text-muted-70">Not answered</div>
      )}
      {/* A "Note: …" footnote the worker wrote AFTER the options — rendered below the chips (muted) so
          the choices stay answerable instead of swallowing them (the old parser dropped the chips).
          Muted on a WRAPPER and sized by `[data-question-note] .md-body` (styles.css), for the reason the
          question's own wrapper gives above: utilities on the element lose to `.card-md .md-body`. */}
      {parsed.trailingMd && (
        <div data-question-note className="mt-2 text-muted-70">
          <LinkedHtml className={`md-body${wrap ? ` ${QUEUE_WRAP}` : ""}`} html={trailingHtml} />
        </div>
      )}
      {/* The caption fallback survives ONLY when the recommendation didn't match an option. */}
      {parsed.recommendation && recIdxs.length === 0 && (
        <LinkedHtml className="md-inline mt-1.5 text-[11px] text-muted-70" html={recHtml} />
      )}
      {footer && <div className="mt-2.5 flex justify-start">{footer}</div>}
    </TranscriptCard>
  )
}


// A group heading between options. Its own component only so the markdown parse and the
// dangerouslySetInnerHTML prop can be memoized per heading — a hook can't be called inside the
// options .map(), and an inline `{ __html }` literal there would rebuild the DOM on every render
// (see useInnerHtml).
function OptionHeading({ md, wrap }: { md: string; wrap?: boolean }) {
  const html = useInlineMarkdownHtml(md.split("\n").join(" "))
  return (
    <div className="mt-1 text-fg">
      <LinkedHtml className={`md-body${wrap ? ` ${QUEUE_WRAP}` : ""}`} html={html} />
    </div>
  )
}


// recommendedIndex (rec-line → option index) now lives in ../lib/questionBlocks.ts alongside the rest
// of the question parsing, so it's covered by the pure-logic unit tests.

// A single answer choice: a left-aligned neutral row; when selected it takes the subtle accent
// border (focus-adjacent selection). A `multi` chip additionally carries a checkbox square (empty →
// checked) so the "toggle several" affordance reads unmistakably as multi-select vs the single-select
// chips' bare border highlight. Read-only (no interactive controller) → muted and non-clickable.
//
// THE HIT AREA IS A STRETCHED, EMPTY BUTTON LAID OVER THE ROW — not a button wrapped around the text.
// The option text is worker-authored markdown, and it carries the same live things a paragraph does: a
// link, a `#123` reference, a bare URL, a file path (maintainer 2026-08-25: "the link to that Markdown
// file should be clickable … as well as URLs and PR/issue links inside questions — the usual set of
// augmentations"). None of those may sit INSIDE a `<button>`: interactive-in-interactive is invalid
// HTML, and Gecko retargets a click inside a button to the button, so the link would never open. So
// the row is a plain `<div>`; the button is `absolute inset-0` beside the text, named by the text
// through `aria-labelledby`; and styles.css positions each live element in the text ABOVE the button.
// A click on a link follows it and selects nothing; a click on any other pixel of the row picks the
// option. Tab reaches the button first and each link after it. Until this the chip asked the sanitizer
// to flatten links to spans (`inertInteractive`), which is why a file named in an option never opened.
function Chip({
  label,
  index,
  bodyMd,
  wrap,
  selected,
  settledPick,
  disabled,
  multi,
  recommended,
  recTitle,
  onClick,
}: {
  /** The option line as the producer wrote it, identifier included ("2. SQLite — …"). */
  label: string
  /** Position in the option list: the KEY that picks it is `index + 1`. */
  index: number
  /** Block markdown rendered INSIDE the chip, under the label line, ALWAYS — the multi-line trade-off,
   *  the diff, the message that would be posted. Part of the answer, so it shows before anything is
   *  picked and survives into read-only and settled cards. */
  bodyMd?: string
  wrap?: boolean
  selected: boolean
  /** The recorded answer of a SETTLED ask named this option: the AnswersCard's quiet recessed
   *  treatment (inset panel, soft left rule) — a past choice, never the awaiting-you accent. */
  settledPick?: boolean
  disabled: boolean
  multi?: boolean
  recommended?: boolean
  recTitle?: string
  onClick: () => void
}) {
  // Inline-only: the label line is one line, so no `<p>`/list block chrome. Raw `label` used to leak
  // `**bold**`/backticks. The body below it is the opposite — FULL markdown, blocks and all.
  // The identifier comes OFF the label line and goes into the gutter, as the keycap that picks it. A live
  // card's key is always the POSITION (the router presses `index + 1`), so its keycap must be too — a
  // worker's fence numbered from 2, or lettered, still answers to 1. Only a READ-ONLY card shows the
  // label's own number: a settled card keeps just the picked options, and "3" must still say which one.
  const { id, rest } = splitOptionId(label)
  const labelHtml = useInlineMarkdownHtml(rest)
  const n = disabled && id && /^\d+$/.test(id) ? Number(id) : index + 1
  const bodyHtml = useMarkdownHtml(bodyMd ?? "")
  const labelId = useId()
  return (
    <div
      data-question-option
      title={recTitle}
      // The div-level click exists for the body's ELEVATED, non-link content — a code block sits above
      // the stretched button so it can h-scroll (styles.css), which takes its pixels out of the
      // button's hit area, and a click on the code you are reading must still pick the option. The
      // guards keep it from double-firing or over-reaching: a click the BUTTON caught bubbles here
      // with the button as target (closest matches, skip — a second call would un-toggle a multi), a
      // link keeps its own click, a picture opens the lightbox (a gallery tile is a button), a
      // `<summary>` opens its section (raised above the button in styles.css, like a link), and a
      // text-selection drag inside the code block is reading, not choosing.
      onClick={(e) => {
        if (disabled) return
        if ((e.target as Element).closest("a, button, summary, img[data-local-path], .local-file-action, .local-file-code")) return
        if (window.getSelection()?.toString()) return
        onClick()
      }}
      className={`relative flex items-baseline gap-2 rounded-md border px-3 py-1.5 text-[12px] leading-snug transition-colors ${
        selected
          ? "border-selection-border bg-selection text-fg"
          : settledPick
            // pl-[11px]: the 2px left rule is 1px thicker than the siblings' 1px border, so the text
            // starts 1px right of theirs on the shared px-3 — measured 14px vs 13px inset. 11+2 = 12+1.
            ? "border-border-strong border-l-2 border-l-accent/40 bg-bg/50 pl-[11px] text-fg"
            : disabled
              ? "border-border text-muted-80"
              // hover lands on `elevated`, one step above the card's own panel-2 fill — hovering to
              // panel-2 was invisible once every card standardized on that fill. Keyboard focus on the
              // row's button lifts the border the same step hover does (the ring below is the mark).
              : "border-border text-fg/90 hover:bg-elevated hover:border-border-strong has-[>button:focus-visible]:border-border-strong"
      }`}
    >
      {/* THE FOCUS MARK is the stretched button's own inset ring, in the app's focus ink. It had none:
          Tab reached option A and Space picked it with nothing on screen saying which row had the key
          (outline none, box-shadow none, border unchanged — measured on the desktop drawer and in VS
          Code's sidebar alike, where answering by keyboard is the point). `inset-ring`, never
          `ring-inset`: in this theme that one is a colour utility too (lib/theme.test.ts). */}
      <button
        type="button"
        disabled={disabled}
        aria-labelledby={labelId}
        aria-pressed={selected}
        aria-keyshortcuts={disabled || n > 9 ? undefined : String(n)}
        onClick={onClick}
        onMouseDown={(e) => e.preventDefault()}
        className="absolute inset-0 rounded-md outline-none focus-visible:inset-ring-1 focus-visible:inset-ring-focus-ink-60"
      />
      <OptionKey n={n} live={!disabled} selected={selected} />
      {multi && (
        <span
          aria-hidden
          className={`mt-px flex h-3.5 w-3.5 shrink-0 self-start items-center justify-center rounded-[3px] border ${
            selected ? "border-accent bg-accent-fill text-on-accent" : settledPick ? "border-control-strong text-fg" : "border-control-strong"
          }`}
        >
          {(selected || settledPick) && <Check size={10} strokeWidth={3} />}
        </span>
      )}
      <div className="@container/option min-w-0 flex-1">
        {/* The label LINE is its own block (and the button's accessible name — the body is detail, not
            name). The "Recommended" badge FLOATS to the top-right so the option text flows around it
            and reclaims the full width on the lines below — instead of a flex sibling that permanently
            narrows the text column. The badge must precede the label in source order for the float to
            take effect.
            UNDER 12.5rem OF LABEL COLUMN (this div is a size container) the badge drops BELOW the label
            instead: there its ~95px took half the first line, and "B. 30 days" read "B. 30 / days" in a
            300px VS Code sidebar's follow-up. The label div turns into a column and the badge sorts last;
            any wider column, the desktop's included, keeps the float. */}
        <div id={labelId} className="@max-[12.5rem]/option:flex @max-[12.5rem]/option:flex-col @max-[12.5rem]/option:items-start @max-[12.5rem]/option:gap-1">
          {recommended && (
            // Keep the pill inside the first answer line, not taller than it. In system sans,
            // leading-none gives a 13.5px pill; its border/text centers are within 0.2px of the
            // answer's cap band at desktop and phone widths (verify-control-chrome.mjs).
            // The float still lets wrapped answers reclaim the full width below it.
            <span className="pointer-events-none float-right ml-2 mt-px rounded-full border border-border-strong px-1.5 py-px text-[9.5px] leading-none uppercase tracking-wide text-muted @max-[12.5rem]/option:order-last @max-[12.5rem]/option:float-none @max-[12.5rem]/option:ml-0 @max-[12.5rem]/option:mt-0">
              Recommended
            </span>
          )}
          <LinkedHtml as="span" className="md-inline" html={labelHtml} />
        </div>
        {/* The body inherits the chip's colour state (selected/read-only/settled) and steps down HALF
            a size, not to the muted tone: it is the substance of the choice, not a caption on it. The
            size is `[data-question-option] .md-body` in styles.css — a utility here loses to `.md-body`. */}
        {bodyMd !== undefined && (
          <LinkedHtml className={`md-body mt-1.5 opacity-90${wrap ? ` ${QUEUE_WRAP}` : ""}`} html={bodyHtml} />
        )}
      </div>
    </div>
  )
}

// Where an option's TEXT starts: the row's 12px padding, the 16px keycap, the row's 8px gap. The
// free-text row lays its keycap over its own padding, so it insets its text by the same sum to line up
// (and places the cap at 13px, not 12: the cap sits outside the box's 1px border, a chip's inside it).
const OPTION_TEXT_INSET = "pl-9"

// An option's number in its gutter. LIVE (an answerable card) it is a KEYCAP — a key-shaped mark reads as
// "press this" with nothing to explain, and the key on screen is the key the card binds (questionKeys).
// Read-only it is the plain number: a settled card answers no key. Past 9 there is no key to name, so
// those stay plain too. On a touch screen there is no keyboard to point at, so the cap drops its border
// and fill and reads as a plain number. The SELECTED cap fills with the accent, the same fill the multi
// checkbox uses, so a keyboard pick shows where it landed. Inside the focused options grid every cap
// steps up a tone: the question that holds the keyboard says so. The row is `items-baseline`, so the
// digit stands on the label's baseline and the browser does the aligning, with the same result at every
// zoom (measured in sans at 1x, 1.1x, 2x, 2.2x and 6x: the digit's foot on the label's baseline in every
// row, the free-text row included). Leave the cap's own padding alone: a `pt-px` that lifts the cap half
// a pixel rounded up in the option rows and down in the free-text row, 1px apart.
function OptionKey({ n, live, selected = false }: { n: number; live: boolean; selected?: boolean }) {
  if (!live || n > 9) {
    return <span aria-hidden className="w-4 shrink-0 text-center text-[11px] tabular-nums text-muted">{n}.</span>
  }
  return (
    <span
      aria-hidden
      className={`pointer-events-none flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-b-2 text-[10.5px] font-medium leading-none tabular-nums transition-colors ${
        selected
          ? "border-accent bg-accent-fill text-on-accent"
          : "border-border-strong bg-panel text-muted group-focus-visible/qgrid:border-control-strong group-focus-visible/qgrid:text-fg"
      } pointer-coarse:border-transparent pointer-coarse:bg-transparent pointer-coarse:font-normal ${selected ? "pointer-coarse:text-fg" : "pointer-coarse:text-muted"}`}
    >
      {n}
    </span>
  )
}
