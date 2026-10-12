import type { AskedQuestion } from "@frizz/shared"
import type { BlockAnswer } from "./questionBlocks.ts"

export type QuestionPick = Required<Pick<BlockAnswer, "chosen" | "chosenSet">>

// The server stores a registration's spec verbatim for its durable qst_ id. Its option slots are
// immutable, unlike numbered/lettered display strings. Keep the raw label as a stale-data guard;
// the slot distinguishes options with identical labels (which the worker contract permits).
export function encodeQuestionPick(spec: AskedQuestion, pick: QuestionPick): string {
  const options = spec.options ?? []
  if (pick.chosen === null && pick.chosenSet.length === 0) return ""
  const saved = (index: number) => options[index] ? { index, label: options[index].label } : null
  return JSON.stringify({
    chosen: pick.chosen === null ? null : saved(pick.chosen),
    chosenSet: pick.chosenSet.flatMap((i) => {
      const option = saved(i)
      return option ? [option] : []
    }),
  })
}

export function decodeQuestionPick(spec: AskedQuestion, raw: string): QuestionPick {
  const empty: QuestionPick = { chosen: null, chosenSet: [] }
  if (!raw) return empty
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== "object") return empty
    const { chosen, chosenSet } = value as { chosen?: unknown; chosenSet?: unknown }
    if (!Array.isArray(chosenSet)) return empty
    const options = spec.options ?? []
    const indexOf = (saved: unknown): number | null => {
      if (!saved || typeof saved !== "object") return null
      const { index, label } = saved as { index?: unknown; label?: unknown }
      return typeof index === "number" && Number.isInteger(index) && index >= 0
        && typeof label === "string" && options[index]?.label === label ? index : null
    }
    const indices = new Set(chosenSet.map(indexOf).filter((i): i is number => i !== null))
    return spec.kind === "multi"
      ? { chosen: null, chosenSet: options.flatMap((_, i) => indices.has(i) ? [i] : []) }
      : { chosen: indexOf(chosen), chosenSet: [] }
  } catch {
    return empty
  }
}

/** Paths address the immutable registered tree, not a card's position on any surface. */
export function questionSpecAt(spec: AskedQuestion, path: string): AskedQuestion | undefined {
  const [root, ...steps] = path.split("/")
  if (root !== "root") return undefined
  let node: AskedQuestion | undefined = spec
  for (const step of steps) {
    if (!/^\d+\.\d+$/.test(step)) return undefined
    const [option, followUp] = step.split(".").map(Number)
    node = node?.options?.[option]?.followUps?.[followUp]
  }
  return node
}
