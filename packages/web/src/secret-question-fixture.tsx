import { useState } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { questionAnswerMessage, secretAnswerText } from "@ntwine/shared"
import { QuestionBlockCard } from "./components/QuestionBlockCard.tsx"
import { AnswersCard } from "./components/AnswersCard.tsx"
import { parseAnswersCard } from "./lib/answersMessage.ts"
import type { ParsedQuestion } from "./lib/questionBlocks.ts"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { RegisteredAnswerSheet } from "./components/RegisteredAnswerSheet.tsx"
import { RegisteredAnsweringContext, type RegisteredAnswering } from "./components/RegisteredQuestionCards.tsx"
import type { RegisteredQuestionView } from "@ntwine/shared"
import "./styles.css"

// A SECRET question (`ntwinectl secret`) in its three readings: open with the locked caption under its
// password field, settled after the send, and the human's Answers card. The settled card and the
// Answers card must draw a mask, never the delivery note the worker reads (where the value went).
// `?case=sheet` draws the PHONE's reading instead: the real answer sheet on the secret step, over a stub
// answering state (open it at a phone width).
const question: ParsedQuestion = {
  kind: "question",
  danger: false,
  secret: true,
  contextMd:
    "A NEW OpenRouter management key for Pullfrog production: open https://openrouter.ai/settings/management-keys, click Create New Key, name it vercel-production-2026-10-09, and paste the key here.",
  options: [],
  recommendedIdxs: [],
}

const stored = secretAnswerText("/Users/someone/.ntwine/projects/029a30af/secrets/a-thread/qst_d792566b3316")
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

const registered: RegisteredQuestionView = {
  id: "qst_d792566b3316",
  spec: { question: question.contextMd, kind: "question", secret: true },
  askedAt: "2026-10-09T12:00:00.000Z",
}

function Sheet() {
  const [text, setText] = useState("")
  const answer = { chosen: null, chosenSet: [], text }
  const a: RegisteredAnswering = {
    slug: "fixture",
    answerFor: () => answer,
    answersOf: () => new Map([["question", answer]]),
    onChip: () => {},
    onText: (_q, _path, _multi, next) => setText(next),
    dismiss: () => {},
    dismissing: false,
    dismissed: new Set(),
    submit: () => {},
    submitGroup: () => {},
    unsent: () => false,
    settled: [],
    cancelDefault: () => {},
    defaultCountdown: undefined,
    commit: () => {},
    enter: () => {},
    sent: new Map(),
    editing: new Map(),
    canChange: () => false,
    change: () => {},
    keep: () => {},
    take: () => null,
    staged: 0,
    sending: false,
    error: undefined,
  }
  return (
    <RegisteredAnsweringContext.Provider value={a}>
      <RegisteredAnswerSheet questions={[registered]} onClose={() => {}} />
    </RegisteredAnsweringContext.Provider>
  )
}

createRoot(document.getElementById("root")!).render(
  new URLSearchParams(location.search).get("case") === "sheet" ? <Sheet /> :
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
