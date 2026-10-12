import { useState } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { questionAnswerMessage, secretAnswerText } from "@frizz/shared"
import { QuestionBlockCard } from "./components/QuestionBlockCard.tsx"
import { AnswersCard } from "./components/AnswersCard.tsx"
import { parseAnswersCard } from "./lib/answersMessage.ts"
import type { ParsedQuestion } from "./lib/questionBlocks.ts"
import { TooltipProvider } from "./components/Tooltip.tsx"
import "./styles.css"

// A SECRET question (`mcp__frizz__secret`) in its three readings: open with the caption under its
// password field, settled after the send, and the human's Answers card. The settled card and the
// Answers card must draw a mask, never the delivery note the worker reads (where the value went).
const question: ParsedQuestion = {
  kind: "question",
  danger: false,
  secret: true,
  contextMd:
    "A NEW OpenRouter management key for Pullfrog production: open https://openrouter.ai/settings/management-keys, click Create New Key, name it vercel-production-2026-10-09, and paste the key here.",
  options: [],
  recommendedIdxs: [],
}

const stored = secretAnswerText("/Users/someone/.frizz/projects/029a30af/secrets/a-thread/qst_d792566b3316")
const answers = parseAnswersCard(questionAnswerMessage([{ questionId: "qst_d792566b3316", question: "OpenRouter management key", chosen: [], text: stored }])) ?? []

function Open() {
  const [text, setText] = useState("")
  return (
    <QuestionBlockCard
      question={question}
      interactive={{ answer: { chosen: null, chosenSet: [], text }, onChip: () => {}, onText: setText, onSubmit: () => {} }}
    />
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <TooltipProvider>
      <div className="card-md mx-auto flex max-w-[720px] flex-col gap-6 p-8">
        <div data-case="open"><Open /></div>
        <div data-case="settled"><QuestionBlockCard question={question} settled={{ chosenIdxs: [], text: stored }} /></div>
        <div data-case="answers"><AnswersCard answers={answers} /></div>
      </div>
    </TooltipProvider>
  </QueryClientProvider>,
)
