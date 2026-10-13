// THE PHONE ANSWER SHEET'S STEP MODEL (components/RegisteredAnswerSheet.tsx), kept pure so the walk is
// testable without a browser.
//
// One STEP per live question node, across every open registration on the thread, in the order the
// desktop cards draw them: each root, then the follow-ups its taken option opens (lib/registeredQuestion
// liveQuestionNodes — the same walk, so a follow-up is a step exactly while the desktop would draw its
// card). A review step always follows the last one; it is not in this list.
//
// The list is DERIVED FROM THE STAGED ANSWERS, so it changes under the sheet: picking an option that
// carries follow-ups inserts steps right after it, and picking a different option removes them. The
// sheet therefore addresses a step by its KEY (`<question id>|<node path>`), never by its index, and
// computes "the step after this pick" against the answers the pick is about to produce
// (`stepAfterPick`) — the new list is not on screen yet in the tap that asks for it.
import type { AskedQuestion, RegisteredQuestionView } from "@ntwine/shared"
import type { BlockAnswer } from "./questionBlocks.ts"
import { liveQuestionNodes, nodeAnswered } from "./registeredQuestion.ts"

export interface AnswerStep {
  /** `<question id>|<node path>` — the address that survives the list growing or shrinking. */
  key: string
  q: RegisteredQuestionView
  path: string
  spec: AskedQuestion
  /** 1 for a root, 2+ for a follow-up. */
  depth: number
}

type AnswersOf = (q: RegisteredQuestionView) => ReadonlyMap<string, BlockAnswer>

export const stepKey = (id: string, path: string) => `${id}|${path}`

export function answerSteps(questions: readonly RegisteredQuestionView[], answersOf: AnswersOf): AnswerStep[] {
  return questions.flatMap((q) =>
    liveQuestionNodes(q.spec, answersOf(q)).map((node) => ({ key: stepKey(q.id, node.path), q, path: node.path, spec: node.spec, depth: node.depth })),
  )
}

/** The key of the step after `step` once option `optIdx` is chosen on it — which may be one of the
 *  follow-ups that pick opens — or null when the next step is the review. */
export function stepAfterPick(questions: readonly RegisteredQuestionView[], answersOf: AnswersOf, step: AnswerStep, optIdx: number): string | null {
  const after: AnswersOf = (q) => {
    const base = answersOf(q)
    if (q.id !== step.q.id) return base
    const prev = base.get(step.path) ?? { chosen: null, chosenSet: [], text: "" }
    return new Map(base).set(step.path, { ...prev, chosen: optIdx })
  }
  return stepAfter(answerSteps(questions, after), step.key)
}

/** The key of the step after `key` in `steps`, or null when that is the review. A key no longer in the
 *  list (its branch closed) also lands on the review rather than on a step the human never reached. */
export function stepAfter(steps: readonly AnswerStep[], key: string): string | null {
  const i = steps.findIndex((s) => s.key === key)
  return i === -1 ? null : steps[i + 1]?.key ?? null
}

/** Where the sheet opens: the first step nothing has been staged on yet, else the review. So closing the
 *  sheet halfway and reopening it lands where the human left off, and a sheet opened over a finished set
 *  goes straight to the step that sends. */
export function firstOpenStep(steps: readonly AnswerStep[], answersOf: AnswersOf): string | null {
  return steps.find((s) => !nodeAnswered(s.spec, answersOf(s.q).get(s.path)))?.key ?? null
}

/** How a staged secret reads wherever the value itself must not: a fixed run, so it says nothing about
 *  the value's length either. */
export const SECRET_MASK = "••••••••"

/** What the review row says was answered, or null for a step nothing was staged on. Reads the answer the
 *  way the payload will (registeredAnswer): a single-select's chip wins over text left beside it, a
 *  multi's text rides after its picks, and a free-text question is its text. */
export function answerSummary(spec: AskedQuestion, answer: BlockAnswer | undefined): string | null {
  if (!answer || !nodeAnswered(spec, answer)) return null
  // The review row is on screen, so a secret shows only THAT it is filled, never what it is.
  if (spec.secret) return SECRET_MASK
  const labels = (spec.options ?? []).map((o) => o.label)
  const text = answer.text.trim()
  if (spec.kind === "multi") {
    const picked = (answer.chosenSet ?? []).slice().sort((a, b) => a - b).flatMap((i) => (labels[i] === undefined ? [] : [labels[i]]))
    return [picked.join(", "), text].filter(Boolean).join(" — ")
  }
  if (answer.chosen !== null && labels[answer.chosen] !== undefined) return labels[answer.chosen]
  return text || null
}

/** An option's description as the sheet's muted line, when it is ONE line. A multi-line description is
 *  the option's rich body (a list, a diff) and renders as markdown instead — see optionParts. */
export function oneLineDescription(description: string | undefined): string | undefined {
  const trimmed = description?.trim()
  return trimmed && !trimmed.includes("\n") ? trimmed : undefined
}
