import { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import "./styles.css"
import { QuestionBlockCard } from "./components/QuestionBlockCard.tsx"
import { installCodeCopyInterceptor } from "./lib/copy-code.ts"
import { setGithubRepo } from "./lib/githubAutolink.ts"
import { installLocalFileLinkInterceptor } from "./lib/local-file-links.ts"
import { setLocalPathBase } from "./lib/localPathBase.ts"
import type { BlockAnswer, ParsedQuestion } from "./lib/questionBlocks.ts"
import { store } from "./store.ts"

// A ```question card carrying every live reference a worker writes into one — the "usual set of
// augmentations" (maintainer 2026-08-25) — on the REAL render path, so the e2e test can click each one
// and observe which of two things happened: the reference opened, or the option got picked.
//
// The card is a `<div>` row with a stretched button beside its text (see QuestionBlockCard's Chip);
// what this page proves is the z-order that design rests on. A link that had ended up UNDER the
// button would still be in the markup, still styled, still asserted present by a DOM query — and a
// real click on it would pick the option instead. So the test clicks with the mouse, at coordinates.
//
// Both late arrivals are reproduced: the GitHub repo lands a frame after first render (as it does off
// the board), and the file check is a server round-trip answered here by a fetch stub.
const REPO = "colinhacks/frizz"
const BASE_DIR = "/fixture"

const RAW = [
  "Send the Cloudflare note now? The draft is in `notes/cloudflare-ask.md`; the earlier one was `old-ask.md`.",
  "",
  "- A. Yes — it's in `cloudflare-ask.md`, forces a number and a date, and resolves #482 (recommended)",
  "- B. Post [`draft.md`](/fixture/draft.md) first, then read https://example.com/guide and come back",
  "- C. Something else moved.",
  "",
  "Note: the log is in `logs/send.log`.",
].join("\n")

// The paths the "server" says are real. Everything else stays plain code.
const REAL: Record<string, string> = {
  "cloudflare-ask.md": "/fixture/cloudflare-ask.md",
  "notes/cloudflare-ask.md": "/fixture/notes/cloudflare-ask.md",
  "logs/send.log": "/fixture/logs/send.log",
}

type FixtureWindow = Window & {
  __chips?: number[]
  __codeChips?: number[]
  __opened?: string[]
  __drawers?: () => { kind: string; path?: string }[]
  __resolveCalls?: string[][]
}
const w = window as FixtureWindow
w.__chips = []
w.__codeChips = []
w.__opened = []
w.__resolveCalls = []
w.__drawers = () => store.drawers.map((d) => ({ kind: d.kind, path: d.path }))

const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.href)
  const json = (result: unknown) =>
    new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json", "x-frizz-boot": "question-links-fixture" } })
  if (url.pathname === "/_frizz/rpc/resolveLocalPaths") {
    const { paths } = JSON.parse(url.searchParams.get("input") ?? "{}") as { paths: string[] }
    w.__resolveCalls!.push(paths)
    return json({ resolved: paths.map((p) => ({ input: p, path: REAL[p] ?? null })) })
  }
  if (url.pathname === "/_frizz/rpc/openLocalFile") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { path?: string }
    w.__opened!.push(body.path ?? "")
    return json({ action: "copy", path: body.path })
  }
  return nativeFetch(input, init)
}

installLocalFileLinkInterceptor()
installCodeCopyInterceptor()
setLocalPathBase(BASE_DIR, "/fixture/home")

function Live() {
  const [answer, setAnswer] = useState<BlockAnswer>({ chosen: null, chosenSet: [], text: "" })
  return (
    <QuestionBlockCard
      raw={RAW}
      questionKind="question"
      interactive={{
        answer,
        onChip: (i) => {
          w.__chips!.push(i)
          // Toggle + keep the typed draft — the contract every real producer honours (2026-09-02).
          setAnswer((a) => ({ ...a, chosen: a.chosen === i ? null : i }))
        },
        // SINGLE: the box taking over drops the pick — the contract every producer honours (BlockInteractive).
        onText: (text) => setAnswer(() => ({ chosen: null, text })),
        onSubmit: () => {},
      }}
    />
  )
}

// An option whose BODY carries a fenced block (a registered ask's multi-line description). The block is
// raised above the stretched button so it can h-scroll; its copy button has to ride above the block in
// turn, or a click on the copy glyph lands on the `pre` and picks the option instead of copying.
const CODE_QUESTION: ParsedQuestion = {
  kind: "question",
  danger: false,
  contextMd: "Which command should the worker run?",
  options: ["A. Rebuild", "B. Leave it"],
  optionBodies: ["```sh\nnub run build && nub run test\n```", undefined],
  recommendedIdxs: [0],
}

function CodeOption() {
  const [answer, setAnswer] = useState<BlockAnswer>({ chosen: null, chosenSet: [], text: "" })
  return (
    <QuestionBlockCard
      question={CODE_QUESTION}
      interactive={{
        answer,
        onChip: (i) => {
          w.__codeChips!.push(i)
          setAnswer((a) => ({ ...a, chosen: a.chosen === i ? null : i }))
        },
        onText: (text) => setAnswer(() => ({ chosen: null, text })),
        onSubmit: () => {},
      }}
    />
  )
}

function Fixture() {
  // A frame later, exactly as the board's keyframe does — never during the first render.
  useEffect(() => {
    const id = setTimeout(() => setGithubRepo(REPO), 250)
    return () => clearTimeout(id)
  }, [])
  return (
    <main className="mx-auto max-w-[680px] p-8">
      <p className="mb-4 text-[11px] text-muted">Question card links fixture — the repo arrives 250ms after first render</p>
      <div data-case="live" className="mb-6">
        <Live />
      </div>
      {/* The same card as a PAST question: options are inert, the references in them are not. */}
      <div data-case="readonly">
        <QuestionBlockCard raw={RAW} questionKind="question" />
      </div>
      <div data-case="code" className="mt-6">
        <CodeOption />
      </div>
    </main>
  )
}

setGithubRepo(null)
createRoot(document.getElementById("root")!).render(<Fixture />)
