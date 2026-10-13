import { useState } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import "./styles.css"
import { splitProseAttachments } from "./lib/imagePaths.ts"
import { installLocalFileLinkInterceptor } from "./lib/local-file-links.ts"
import { mdToHtml } from "./lib/markdown.ts"
import type { BlockAnswer, ParsedQuestion } from "./lib/questionBlocks.ts"
import type { RegisteredQuestionView } from "@ntwine/shared"
import { BlockImage, FenceCard } from "./components/ChatView.tsx"
import { ImageViewer } from "./components/ImageViewer.tsx"
import { LightboxGallery, LightboxHost } from "./components/Lightbox.tsx"
import { QuestionBlockCard } from "./components/QuestionBlockCard.tsx"
import { RegisteredAnswerSheet } from "./components/RegisteredAnswerSheet.tsx"
import { RegisteredAnsweringContext, type RegisteredAnswering } from "./components/RegisteredQuestionCards.tsx"

// The ```lightbox fence with the REAL components: worker prose split exactly as ChatView splits it
// (splitProseAttachments), each gallery drawn by LightboxGallery, and the viewer hosted the way the page
// layouts host it. Driven by components/lightbox.e2e.test.ts.
//
// Below the transcript's galleries, the OTHER surfaces a fence reaches, each through its real
// component: a done card (FenceCard), a question option (QuestionBlockCard) and the same question on the
// phone's answer sheet (RegisteredAnswerSheet), which render prose as one string of HTML and grow their
// galleries as islands (useLightboxIslands). And a message's LOOSE
// pictures — a Markdown image, a bare path line (BlockImage), a link to a picture — which open the same
// viewer through the delegated click listener (lib/local-file-links.ts).
//
// The pictures come from that test, not from here. An <img> load is not a `fetch`, so no stub on this
// page can answer `/_ntwine/local-image` (see attachment-render-fixture.tsx); the test intercepts the
// request instead and draws a PNG at the size the path names (`…-1440x900.png`), and answers a `.webm`
// with a real clip, in byte ranges as the real route does. A path naming `missing` is answered 404, the
// way the real route answers a file that is gone.
//
// A window listener counts the keys that reach the PAGE. The real page unwinds its drawers — and leaves
// the fullscreen page — on an Escape that gets that far (DrawerStack), so the viewer must keep its own.
declare global {
  interface Window { __pageKeys?: string[]; __chips?: number[]; __sheetPicks?: number[] }
}
window.__pageKeys = []
window.__chips = []
window.__sheetPicks = []
window.addEventListener("keydown", (e) => { window.__pageKeys!.push(e.key) })

// The cards resolve inline-code paths and read the board; nothing real answers either here.
const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.href)
  if (url.pathname === "/_ntwine/rpc/resolveLocalPaths") {
    return new Response(JSON.stringify({ result: { resolved: [] } }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname.startsWith("/_ntwine/rpc/")) {
    return new Response(JSON.stringify({ result: {} }), { headers: { "content-type": "application/json" } })
  }
  return nativeFetch(input, init)
}
installLocalFileLinkInterceptor()

const shot = (name: string) => `/fixture/lightbox/${name}`

const messages = [
  ["Before and after:", "", "```lightbox", `${shot("before-1440x900.png")}  Before`, `${shot("after-1440x900.png")}  After`, "```"],
  ["The board at three widths:", "", "```lightbox", shot("phone-375x812.png"), shot("tablet-768x1024.png"), shot("desktop-1440x900.png"), "```"],
  ["One file was cleaned up:", "", "```lightbox", shot("first-1440x900.png"), shot("missing-1440x900.png"), shot("last-1440x900.png"), "```"],
  ["The flow, recorded:", "", "```lightbox", `${shot("flow-start-1440x900.png")}  Start`, `${shot("flow-320x180.webm")}  The whole flow`, "```"],
].map((lines) => lines.join("\n"))

const DONE_BODY = ["Shipped the new settings page.", "", "```lightbox", `${shot("card-before-1440x900.png")}  Before`, `${shot("card-after-1440x900.png")}  After`, "```"].join("\n")

const LAYOUT_QUESTION: ParsedQuestion = {
  kind: "question",
  danger: false,
  contextMd: "Which layout ships?",
  options: ["A. Two columns", "B. One column"],
  optionBodies: [
    ["```lightbox", `${shot("two-col-1440x900.png")}  Desktop`, `${shot("two-col-phone-390x844.png")}  Phone`, "```"].join("\n"),
    `![One column](${shot("one-col-1440x900.png")})`,
  ],
  recommendedIdxs: [0],
}

function LayoutQuestion() {
  const [answer, setAnswer] = useState<BlockAnswer>({ chosen: null, chosenSet: [], text: "" })
  return (
    <QuestionBlockCard
      question={LAYOUT_QUESTION}
      interactive={{
        answer,
        onChip: (i) => {
          window.__chips!.push(i)
          setAnswer((a) => ({ ...a, chosen: a.chosen === i ? null : i }))
        },
        onText: (text) => setAnswer(() => ({ chosen: null, text })),
        onSubmit: () => {},
      }}
    />
  )
}

// The phone's way to answer a registered question: a bottom sheet whose option ROWS are buttons, with
// the description's gallery and picture inside them.
const REGISTERED: RegisteredQuestionView = {
  id: "qst_fixture",
  askedAt: "2026-10-03T00:00:00.000Z",
  spec: {
    question: "Which layout ships?",
    kind: "question",
    options: [
      { label: "Two columns", recommended: true, description: ["```lightbox", `${shot("sheet-desktop-1440x900.png")}  Desktop`, `${shot("sheet-phone-390x844.png")}  Phone`, "```"].join("\n") },
      { label: "One column", description: [`![One column](${shot("sheet-one-col-1440x900.png")})`, "", "Everything in one page."].join("\n") },
    ],
  },
}

function AnswerSheet() {
  const [open, setOpen] = useState(false)
  const [answers, setAnswers] = useState(() => new Map<string, BlockAnswer>())
  const answering: RegisteredAnswering = {
    slug: "fixture",
    take: () => null,
    answerFor: (_q, path) => answers.get(path) ?? { chosen: null, chosenSet: [], text: "" },
    answersOf: () => answers,
    onChip: (_q, path, _multi, optIdx) => {
      window.__sheetPicks!.push(optIdx)
      setAnswers((prev) => new Map(prev).set(path, { chosen: optIdx, chosenSet: [], text: "" }))
    },
    onText: () => {},
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
    staged: 0,
    sending: false,
    error: undefined,
  }
  return (
    <RegisteredAnsweringContext.Provider value={answering}>
      <button type="button" data-fixture-open-sheet onClick={() => setOpen(true)} className="rounded-md border border-border px-3 py-1.5 text-[13px]">
        Answer
      </button>
      {open && <RegisteredAnswerSheet questions={[REGISTERED]} onClose={() => setOpen(false)} />}
    </RegisteredAnsweringContext.Provider>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <main className="mx-auto max-w-[700px] p-8">
      {messages.map((md, m) => (
        <section key={m} data-fixture-message={m} className="mb-8 flex flex-col gap-3 text-[13px]">
          {splitProseAttachments(md).map((part, i) =>
            part.kind === "lightbox" ? <LightboxGallery key={i} entries={part.entries} />
            : part.kind === "md" ? <div key={i} className="md-body" dangerouslySetInnerHTML={{ __html: mdToHtml(part.text) }} />
            : null,
          )}
        </section>
      ))}
      {/* One transcript message's loose pictures: `data-ntwine-msg` is the root ChatView stamps on it. */}
      <section data-fixture-loose data-ntwine-msg="loose" className="mb-8 flex flex-col gap-3 text-[13px]">
        <div className="md-body" dangerouslySetInnerHTML={{ __html: mdToHtml(`The page now:\n\n![The settings page](${shot("settings-1200x800.png")})`) }} />
        <BlockImage path={shot("terminal-1000x700.png")} />
        <div className="md-body" dangerouslySetInnerHTML={{ __html: mdToHtml(`And [the log view](${shot("log-800x600.png")}) on its own.`) }} />
      </section>
      <section data-fixture-card className="mb-8">
        <FenceCard fenceKind="done" body={DONE_BODY} hints={[]} />
      </section>
      <section data-fixture-question className="mb-8">
        <LayoutQuestion />
      </section>
      <section data-fixture-sheet className="mb-8">
        <AnswerSheet />
      </section>
      <LightboxHost />
      {/* A single picture opens the picture viewer, which the app mounts with its drawers (DrawerStack). */}
      <ImageViewer />
    </main>
  </QueryClientProvider>,
)
