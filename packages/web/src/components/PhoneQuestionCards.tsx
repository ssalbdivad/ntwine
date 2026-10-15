import { createContext, useContext } from "react"
import { Check, Keyboard } from "lucide-react"
import type { AskedOption, RegisteredQuestionView } from "@ntwine/shared"
import { oneLineDescription, stepKey } from "../lib/answerSheet.ts"
import { nodeAnswered, ROOT_PATH } from "../lib/registeredQuestion.ts"
import { useMarkdownHtml } from "../lib/useMarkdown.ts"
import { LinkedHtml } from "./LinkedHtml.tsx"
import { RegisteredAnsweringContext } from "./RegisteredQuestionCards.tsx"

// ON A PHONE THE TRANSCRIPT'S QUESTIONS ARE ANSWERED WHERE THEY STAND (2026-10-03). Each open registered
// question draws compactly — its number, its text, and each option as a full-width tap target carrying
// its number, label and one-line trade-off. A plain single-choice question is answered by ONE TAP on its
// option: the pick goes through the thread's shared RegisteredAnswering, whose "a pick that completes its
// question sends it" rule is the send, exactly as a click on the desktop card is.
//
// Until 2026-10-03 these cards were READ-ONLY (mockup v2 §3) and every answer went through the stepped
// sheet behind the bottom bar's "Answer" — even a two-option yes/no, and nothing on the card said the
// sheet was where answering lived (maintainer: "it should be possible to answer simple questions without
// the expanded view, which isn't even clear that's how it's supposed to work"). The sheet
// (RegisteredAnswerSheet) stays for what one tap cannot finish, and the card opens it AT THAT QUESTION:
//   - an option with follow-ups: the tap records the pick, then the sheet opens on the first follow-up;
//   - an option with a rich (multi-line) body: the tap opens the sheet, where the body renders in full —
//     a pick made without reading the detail that decides it is the thing the body exists to prevent;
//   - "Other answer…" under a single-choice, and "Write an answer…" for a free-text question: typing
//     belongs in the sheet, whose footer rides the keyboard;
//   - a multi-select toggles here, and a Send under it commits that question alone.
//
// The accent is on the numbers and the RECOMMENDED tags and nowhere else (not a card border): the
// accent means "awaiting you", and on this card that is the question and the worker's own pick.
//
// PROVIDED, NOT DETECTED. The phone thread page (ChatView with `phone`) provides this context; every
// registered card under it reads it and draws compactly. `numberOf` numbers a question by its place among the thread's open
// questions, so a card placed inside a message and its sibling at the rest still count 1, 2. `openSheet`
// opens the answer sheet, at the step `stepKey` names or else where the human left off.
export interface PhoneQuestions {
  numberOf: (id: string) => number
  openSheet: (step?: string) => void
}

export const PhoneQuestionsContext = createContext<PhoneQuestions | null>(null)

export function usePhoneQuestions(): PhoneQuestions | null {
  return useContext(PhoneQuestionsContext)
}

/** Several open registered questions in ONE bordered card, a hairline between each — the mockup's
 *  shape for the questions a rest asked together. A placed card (inside a message) is a list of one. */
export function CompactQuestionList({ questions }: { questions: readonly RegisteredQuestionView[] }) {
  const phone = usePhoneQuestions()
  if (questions.length === 0) return null
  return (
    <div
      data-compact-questions
      className="min-w-0 overflow-hidden rounded-[12px] border border-border-strong bg-panel pb-3 text-[14px] leading-5"
    >
      {questions.map((q, i) => (
        <div key={q.id} data-question-id={q.id} className={i > 0 ? "mt-3 border-t border-border" : undefined}>
          <CompactQuestion q={q} n={phone?.numberOf(q.id) ?? i + 1} />
        </div>
      ))}
    </div>
  )
}

/** An option whose description is more than one line (or carries a legacy `preview`) has a rich body,
 *  which only the sheet renders. */
const hasBody = (option: AskedOption) => (!oneLineDescription(option.description) && !!option.description?.trim()) || !!option.preview?.trim()

function CompactQuestion({ q, n }: { q: RegisteredQuestionView; n: number }) {
  const html = useMarkdownHtml(q.spec.question)
  const a = useContext(RegisteredAnsweringContext)
  const phone = usePhoneQuestions()
  const options = q.spec.options ?? []
  const multi = q.spec.kind === "multi"
  const answer = a?.answerFor(q, ROOT_PATH)
  const here = stepKey(q.id, ROOT_PATH)
  const pick = (i: number) => {
    if (!a) return
    const option = options[i]!
    if (multi) return a.onChip(q, ROOT_PATH, true, i)
    if (hasBody(option)) return phone?.openSheet(here)
    // Never a toggle-off: a re-tap of the option already picked keeps it.
    if (answer?.chosen !== i) a.onChip(q, ROOT_PATH, false, i)
    if (option.followUps?.length) phone?.openSheet(stepKey(q.id, `${ROOT_PATH}/${i}.0`))
  }
  const staged = multi && a ? nodeAnswered(q.spec, answer) : false
  return (
    <>
      <div className="flex gap-2 px-3.5 pb-2 pt-3 font-semibold">
        <span className="shrink-0 tabular-nums text-accent">{n}</span>
        <LinkedHtml className={`min-w-0 flex-1 ${QUESTION_PROSE}`} html={html} />
      </div>
      <div role={multi ? "group" : "radiogroup"} className="flex flex-col gap-1.5 px-2.5">
        {options.map((option, i) => {
          const on = multi ? (answer?.chosenSet ?? []).includes(i) : answer?.chosen === i
          const line = oneLineDescription(option.description)
          return (
            <button
              key={i}
              type="button"
              role={multi ? "checkbox" : "radio"}
              aria-checked={on}
              data-compact-option
              data-on={on || undefined}
              disabled={!a || a.sending}
              onClick={() => pick(i)}
              className={`${OPTION} ${on ? "border-fg/50 bg-hover" : "border-border bg-bg"}`}
            >
              <span className={`${KEY} ${on ? "border-fg bg-fg text-bg" : "border-border-strong text-muted"}`}>
                {multi && on ? <Check aria-hidden size={12} strokeWidth={3} /> : i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-fg">
                  {option.label}
                  {option.recommended && <span className="ml-1.5 text-[11px] font-semibold text-accent">RECOMMENDED</span>}
                </span>
                {line && <span className="mt-px block text-[13px] leading-[18px] text-muted">{line}</span>}
                {hasBody(option) && <span className="mt-px block text-[13px] leading-[18px] text-muted">Details…</span>}
              </span>
            </button>
          )
        })}
        {options.length === 0 ? (
          <button type="button" data-compact-write onClick={() => phone?.openSheet(here)} className={`${OPTION} border-dashed border-border-strong bg-bg text-muted`}>
            <Keyboard aria-hidden size={16} strokeWidth={1.8} className="mt-0.5 shrink-0" />
            <span className="font-medium">Write an answer…</span>
          </button>
        ) : (
          <div className="flex items-center justify-between gap-2 pt-0.5">
            <button type="button" data-compact-write onClick={() => phone?.openSheet(here)} className="min-h-[36px] px-1 text-[13.5px] font-medium text-muted active:text-fg">
              {multi ? "Add a note…" : "Other answer…"}
            </button>
            {multi && (
              <button
                type="button"
                data-compact-send
                disabled={!staged || !a || a.sending}
                onClick={() => a?.commit(q)}
                className="h-[36px] rounded-[10px] bg-fg px-4 text-[14px] font-semibold text-bg active:opacity-90 disabled:opacity-35"
              >
                Send
              </button>
            )}
          </div>
        )}
      </div>
    </>
  )
}

/** A tap target at least 40px tall, the label on the number's line. */
const OPTION = "flex w-full items-start gap-2.5 rounded-[10px] border px-3 py-2.5 text-left outline-none transition-colors active:bg-hover focus-visible:border-fg/50 disabled:opacity-60"
/** The option's number, in a key-cap that fills when picked — the same numbers every surface uses. */
const KEY = "flex size-5 shrink-0 items-center justify-center rounded-[6px] border text-[11px] font-bold tabular-nums"

/** A question's markdown at the SURROUNDING type, not the transcript's prose scale: `md-body` pins its
 *  own 14px/1.7 and outranks any utility here (it is unlayered CSS), so the question is rendered bare —
 *  preflight zeroes a paragraph's margins — with just enough block rhythm for a worker that wrote two
 *  paragraphs or a list. `md-inline` keeps inline code monospace. Shared with the sheet. */
export const QUESTION_PROSE =
  "md-inline break-words [&_p+*]:mt-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li+li]:mt-1 [&_pre]:overflow-x-auto [&_pre]:text-[0.85em] [&_code]:text-[0.9em] [&_a]:underline"

/** THE BOTTOM BAR'S THIRD STATE (mockup v2 §2–3): on a thread with open questions the resting row is
 *  [keyboard] + "Answer N questions". The keyboard button is for a free reply instead — it switches the
 *  bar back to the prompt and focuses it inside the same tap, which is what makes iOS raise the keyboard
 *  (Composer's PhoneBarApi). Rendered through ThreadComposerBox's `phoneBarOverride`, so it shows only
 *  while the prompt is empty and blurred. */
export function PhoneAnswerBar({ count, onAnswer, onReply }: { count: number; onAnswer: () => void; onReply: () => void }) {
  return (
    <>
      <button
        type="button"
        data-phone-answer-reply
        onClick={onReply}
        aria-label="Write a reply instead"
        title="Write a reply instead"
        className="flex size-[42px] shrink-0 items-center justify-center rounded-full border border-border-strong bg-panel text-fg active:bg-hover"
      >
        <Keyboard aria-hidden size={19} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        data-phone-answer-open
        onClick={onAnswer}
        className="flex h-[42px] min-w-0 flex-1 items-center justify-center rounded-full bg-fg px-4 text-[15px] font-semibold text-bg active:opacity-90"
      >
        {count > 1 ? `Answer ${count} questions` : "Answer"}
      </button>
    </>
  )
}
