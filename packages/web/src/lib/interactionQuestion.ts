// PRODUCER 2 of the shared question model. A ```question fence is parsed into a `ParsedQuestion` by
// questionBlocks.ts; an `agent-question` INTERACTION — a native Claude AskUserQuestion tool call, or
// Codex's item/tool/requestUserInput — is converted into the same `ParsedQuestion` here, so both reach
// QuestionBlockCard as the same thing and cannot drift into two looks.
//
// The two shapes line up one-for-one, which is why one component can serve both:
//     AskUserQuestion   { question, header, options:[{label, description}], multiSelect }  + free text
//     ```question fence   a question line, numbered options with one-line trade-offs, an optional
//                         `multi` tag, and a free-text box at the bottom
// `multiSelect` IS `multi`; `options[].label — description` IS an option line.
//
// It also carries the mapping BACK: an interaction answer is submitted as typed field values, so each
// question keeps the field ids and the exact option values its choices must be submitted as. The
// display label and the submitted value are deliberately separate — the label may be clipped or
// scrubbed for the card, while the value must be the provider's exact bytes or the agent reads the
// answer as freeform prose instead of a pick.
import {
  NOTES_FIELD_SUFFIX,
  type AskQuestion,
  type InteractionField,
  type InteractionRecord,
  type InteractionValue,
  type InteractionValues,
} from "@frizz/shared"
import { optionNumber, type BlockAnswer, type ParsedQuestion } from "./questionBlocks.ts"

export interface InteractionQuestion {
  /** The neutral model the shared card renders. */
  question: ParsedQuestion
  /** The field carrying the chosen option(s), if this question offers any. */
  optionFieldId?: string
  /** The exact value to submit for each option, parallel to `question.options`. */
  optionValues: InteractionValue[]
  /** The field carrying free text, if this producer offers a free-text box. */
  notesFieldId?: string
}


function questionFor(optionField: InteractionField | undefined, notesField: InteractionField | undefined): InteractionQuestion | null {
  const anchor = optionField ?? notesField
  if (!anchor) return null
  const options = optionField && (optionField.input === "select" || optionField.input === "multi-select")
    ? optionField.options
    : []
  return {
    question: {
      kind: optionField?.input === "multi-select" ? "multi" : "question",
      danger: false,
      // The question itself is the field's description (the provider's full question text); the label
      // is the short header chip, used only when a producer supplied no description.
      contextMd: anchor.description ?? anchor.label,
      // Numbered exactly as a registered question's options are (`1. …`). Not decoration: the card
      // draws the identifier as the keycap that picks it, and an operator answering in the composer
      // refers to options by number.
      options: options.map((option, index) => `${optionNumber(index)} ${option.label}`),
      // A tool call has no notion of a recommended option — that is a frizz fence convention — so the
      // badge simply does not appear rather than being faked.
      recommendedIdxs: [],
    },
    ...(optionField ? { optionFieldId: optionField.id } : {}),
    optionValues: options.map((option) => option.value),
    ...(notesField ? { notesFieldId: notesField.id } : {}),
  }
}

/** Convert an `agent-question` interaction's fields into questions the shared card can render, or null
 *  when some field cannot be expressed as one (a number or boolean prompt) — in which case the caller
 *  keeps the generic typed form rather than silently dropping an input the operator has to fill. */
export function interactionQuestions(record: Pick<InteractionRecord, "payload">): InteractionQuestion[] | null {
  if (record.payload.kind !== "agent-question") return null
  const fields = record.payload.fields
  const out: InteractionQuestion[] = []
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]
    // A secret field must never be rendered as an ordinary answer box; the generic card has the
    // secure-fallback affordance for that, so hand the whole record back to it.
    if (field.secret) return null
    if (field.id.endsWith(NOTES_FIELD_SUFFIX)) continue // consumed by its option field below
    const next = fields[index + 1]
    const notesField = next && next.id === `${field.id}${NOTES_FIELD_SUFFIX}` ? next : undefined
    if (field.input === "select" || field.input === "multi-select") {
      const built = questionFor(field, notesField)
      if (!built) return null
      out.push(built)
    } else if (field.input === "text" || field.input === "multiline") {
      // A free-form question (Codex's "other" mode): no options, just the free-text box.
      const built = questionFor(undefined, field)
      if (!built) return null
      out.push(built)
    } else {
      return null // number / integer / boolean — not a question, keep the generic form
    }
  }
  return out.length > 0 ? out : null
}

// PRODUCER 4 of the shared question model: a SETTLED native AskUserQuestion read back out of the
// transcript (TranscriptToolCall.ask/askAnswers). The pending copy of the same call rendered through
// producer 2 above while it was answerable; this is its durable, read-only afterlife — the record that
// keeps a question on screen after the operator steered past it instead of answering (or answered it,
// in which case the choice renders settled). Options are numbered exactly as producer 2 numbers them,
// and the option's one-line description rides the line the way a fence option carries its trade-off.
export interface SettledAskView {
  /** The neutral model the shared card renders. */
  question: ParsedQuestion
  /** The options the recorded answer names (empty when it named none). */
  chosenIdxs: number[]
  /** The recorded answer when it is NOT one of the options — free text, or a label the parse could not
   *  match. Undefined for an unanswered ask, which the card renders as "Not answered". */
  text?: string
}

export function settledAskView(q: AskQuestion, answer: string | null | undefined): SettledAskView {
  const chosenIdxs: number[] = []
  let text: string | undefined
  if (answer) {
    // A single-select answer is the chosen option's label verbatim; a multi-select answer is the chosen
    // labels joined ", " (the server's normalization of the structured result). Match labels first and
    // fall back to free text — an answer that names no option is the human typing their own.
    const parts = q.multiSelect ? answer.split(", ") : [answer]
    q.options.forEach((option, index) => {
      if (parts.includes(option.label)) chosenIdxs.push(index)
    })
    if (chosenIdxs.length === 0) text = answer
  }
  return {
    question: {
      kind: q.multiSelect ? "multi" : "question",
      danger: false,
      contextMd: q.question,
      options: q.options.map((option, index) => `${optionNumber(index)} ${option.label}${option.description ? ` — ${option.description}` : ""}`),
      recommendedIdxs: [],
    },
    chosenIdxs,
    text,
  }
}

/** Map the card's staged answers back to typed interaction field values, using EXACTLY the fence
 *  card's own semantics so the two behave identically: for a single-select, the chosen chip IS the
 *  answer while set (text left in the box beside it is an unselected draft — the box taking focus
 *  clears the chip, so a non-null chip was picked last), and free text answers only when no chip is
 *  chosen; for `multi`, free text COEXISTS with the toggled set and appends colour. Returns undefined
 *  when nothing was answered at all. */
export function interactionQuestionValues(
  questions: readonly InteractionQuestion[],
  answers: readonly BlockAnswer[],
): InteractionValues | undefined {
  const values: Record<string, InteractionValue> = {}
  questions.forEach((entry, index) => {
    const answer = answers[index]
    if (!answer) return
    const text = answer.text.trim()
    if (entry.question.kind === "multi") {
      const picked = (answer.chosenSet ?? [])
        .slice()
        .sort((a, b) => a - b)
        .flatMap((optionIndex) => {
          const value = entry.optionValues[optionIndex]
          return value === undefined ? [] : [value as string]
        })
      if (entry.optionFieldId && picked.length > 0) values[entry.optionFieldId] = picked
      if (entry.notesFieldId && text) values[entry.notesFieldId] = text
      return
    }
    const chosen = answer.chosen
    if (entry.optionFieldId && chosen !== null && entry.optionValues[chosen] !== undefined) {
      values[entry.optionFieldId] = entry.optionValues[chosen]
      return
    }
    if (text && entry.notesFieldId) values[entry.notesFieldId] = text
  })
  return Object.keys(values).length > 0 ? (values as InteractionValues) : undefined
}
