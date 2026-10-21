import { awaitingStatus, questionPassedOver, type TranscriptMessage } from "@ntwine/shared"
import { readAwaitingPark } from "./awaiting.ts"
import { safeQuestionSpec } from "./board.ts"
import { operatorMessages, type RestHandoff } from "./periodic-status.ts"
import type { Storage } from "./storage.ts"
import { parseSignalFence } from "./tailer.ts"

// The rest's HANDOFF for the status writer (periodic-status.ts): the questions still holding the thread
// and the sign-off it rested on. Its own module because the readers it needs — the fence parser, the
// question spec, the park — live in tailer.ts and board.ts, which both import periodic-status.ts.
//
// Read from the transcript the writer already holds plus storage, not from the board snapshot: the rest
// that triggers a write lands before the board refreshes, and a snapshot one rest behind is exactly the
// staleness this exists to remove. "Typed past" is judged against the newest operator message, the
// transcript's own reading of the board's `lastHumanAt`.
export function restHandoff(
  storage: Pick<Storage, "listThreadQuestions" | "getThreadDone">,
  slug: string,
  messages: readonly TranscriptMessage[],
): RestHandoff {
  const lastHumanAt = operatorMessages(messages).at(-1)?.at
  const questions = storage.listThreadQuestions(slug, { openOnly: true }).flatMap((q) => {
    const spec = safeQuestionSpec(q.spec)
    if (!spec || questionPassedOver(q, spec, lastHumanAt)) return []
    return [spec.question]
  })
  // `ntwinectl done` is a row, not transcript text; it counts only when recorded after the human last
  // spoke, since a new message spends it.
  const done = storage.getThreadDone(slug)
  if (done && (!lastHumanAt || done.doneAt >= Date.parse(lastHumanAt))) return { questions, signoff: { kind: "done" } }
  const lastReply = messages.findLast((m) => m.role === "assistant" && !m.kind && !m.boundary && m.text.trim() !== "")
  const fence = parseSignalFence(lastReply?.text)
  if (!fence) return { questions }
  if (fence.kind === "done") return { questions, signoff: { kind: "done" } }
  const park = readAwaitingPark(fence.hints)
  return {
    questions,
    signoff: {
      kind: "awaiting",
      status: awaitingStatus(fence.hints),
      waitsOn: park.items.map((i) => `${i.kind} ${i.value}`),
      steps: park.steps,
    },
  }
}
