import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { useSnapshot } from "valtio"
import type { BoardSnapshot, RegisteredQuestionView, ThreadHandoff, ThreadView as ThreadViewModel } from "@ntwine/shared"
import { AllQueuesCard } from "./components/AllQueuesCard.tsx"
import { SettingsDrawer } from "./components/SettingsDrawer.tsx"
import { CommandPalette } from "./components/CommandPalette.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import type { QueuesProject } from "./lib/allQueues.ts"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for a REGISTERED question on the queue card (components/AllQueuesCard.tsx, the Everything
// page's card) — a question a worker created with the `ask` tool, which is a row rather than a fence in a
// message. This fixture mounted the board's queue card (TodosView) until that card was deleted with the
// single-project board (2026-09-28); the question stack is the same component on both. It renders through the shared QuestionBlockCard
// (RegisteredQuestionCards.tsx), so what is worth looking at here is what a registration adds: the ×,
// the rich option BODY (full markdown inside the chip, visible before anything is picked — one option
// below writes the new multi-line `description`, the other the retired `preview`, and they must render
// the same), and the FOLLOW-UP tree that appears as the root is answered.
//
//   ?tree=1     — a root whose "Yes" carries two follow-ups. Pick A and watch them appear indented.
//   ?danger=1   — the destructive gate: `risk` tone, and NO × (declining is an option INSIDE it).
//   ?many=1     — three open questions at once: each is sent on its own as it is completed, and the
//                 others stay open (one question at a time, 2026-09-29).
//   ?busy=1     — a question AND live background work, which is the case the memo calls out: the
//                 question expands and the waits must not compete with it for the one glance.
//   ?past=1     — the question was asked at an OLDER rest, the human replied past it without answering,
//                 and the worker's newest handoff carries a LEGACY empty ```question qst_… marker naming
//                 it — how a worker dispatched before 2026-09-28 says a newer handoff still owes the ask.
//                 The marker must draw NOTHING and the card must render ONCE, at the BOTTOM under the
//                 whole handoff.
//   ?table=1    — an option whose body carries a TABLE, a blockquote and a code fence: the blocks whose
//                 opaque panel fills clashed with a selected chip's accent tint (screenshot 2026-09-02).
//   ?wide=1     — a `multi` over THIRTY options: no count cap (2026-09-03), and numbering past the 1–9 keys.
//   ?placed=1   — RETIRED PLACEMENT (2026-09-28): two questions open at one rest, and the handoff carries
//                 a legacy marker for ONE of them mid-prose, with a paragraph under it. The marker must
//                 draw NOTHING (lib/allQueues handoffParts): both cards render together UNDER the whole
//                 handoff, one stack, one Send.
//   ?woken=1    — the worker asked and rested, then ntwine WOKE it (a PR watcher expired) and it wrote a
//                 newer handoff with the question still open. Only ntwine has spoken since, so the card
//                 must render at the BOTTOM, under the newer handoff — not frozen above the wake.
//   ?default=1  — the question will take its recommended option in ~7m unless answered: the countdown
//                 caption under the card, with its own × that turns the default off (2026-10-05).
//   ?keys=1     — the NUMBER KEYS (lib/questionKeys.ts): TWO queue cards, the first asking the settings
//                 store and the land-it tree, the second the commit gates, with the real Settings drawer
//                 and ⌘K palette mounted off the store (`window.fixtureStore` opens them). What it is for
//                 is WHICH question a bare digit answers, and above all that it never answers one the
//                 operator cannot see.
//   ?font=sans  — the other of the two fonts this app renders in; mono is the default and the wider.
const params = new URLSearchParams(location.search)
document.documentElement.dataset.font = params.get("font") === "sans" ? "sans" : "mono"
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()

const SETTINGS: RegisteredQuestionView = {
  id: "qst_0001aaaa",
  askedAt: ago(6),
  spec: {
    question: "Where should the settings store live?",
    kind: "question",
    options: [
      {
        label: "SQLite",
        // The NEW shape: a multi-line description IS the option's body — full markdown, inside the
        // chip, visible before anything is picked.
        description: "Transactional, and it is where sessions already live.\n\n```sql\nCREATE TABLE setting (\n  key   TEXT PRIMARY KEY,\n  value TEXT NOT NULL\n);\n```\n\nMigrates with the rest of the schema; one more table in `ui.db`.",
        recommended: true,
      },
      {
        label: "A JSON file",
        description: "zero dependencies and hand-editable, but racy under concurrent writes",
        // The RETIRED shape, still carried by stored rows: folds into the same always-visible body
        // under the one-line trade-off, never behind a pick.
        preview: "```json\n{ \"theme\": \"dark\", \"font\": \"mono\" }\n```\nOne file at `~/.ntwine/settings.json`. Two servers writing it at once is the failure mode.",
      },
    ],
  },
}

const TREE: RegisteredQuestionView = {
  id: "qst_0002bbbb",
  askedAt: ago(3),
  spec: {
    question: "The parser refactor is green on every gate. Land it on `main`?",
    kind: "question",
    options: [
      {
        label: "Land it",
        description: "the three CI legs are green and the diff is reviewed",
        recommended: true,
        followUps: [
          { question: "Tag a release at the same time?", kind: "question", options: [{ label: "Tag 0.9.0" }, { label: "Leave it unreleased" }] },
          { question: "Anything the release notes must say?", kind: "question" },
        ],
      },
      { label: "Hold it", description: "something about it still reads wrong", followUps: [{ question: "What is blocking it?", kind: "question" }] },
    ],
  },
}

const GATE: RegisteredQuestionView = {
  id: "qst_0003cccc",
  askedAt: ago(1),
  spec: {
    question: "`main` has three commits the remote does not. Force-push over them?",
    kind: "question",
    danger: true,
    options: [
      { label: "Force-push", description: "the three commits are the rebase of the same work — they are not lost" },
      { label: "Stop and leave the remote alone", recommended: true, description: "somebody else may have pulled them" },
    ],
  },
}

const GATES: RegisteredQuestionView = {
  id: "qst_0004dddd",
  askedAt: ago(9),
  spec: {
    question: "Which gates should run before every commit?",
    kind: "multi",
    // TWO recommended on a `multi`: the recommendation there is the set worth ticking, so each wears the badge.
    options: [{ label: "Typecheck", recommended: true }, { label: "Unit tests", recommended: true }, { label: "The browser e2e pass", description: "slow — about 90s" }],
  },
}

// A `multi` over a LONG list — thirty options, past the `.max(8)` the schema carried until 2026-09-03
// and past the 9 the keys can name, so rows 10…30 read as plain `10.`…`30.` beside the 1–9 keycaps.
// What is worth looking at is that the run stays one even column and the free-text row still follows
// the last option.
const WIDE: RegisteredQuestionView = {
  id: "qst_0006ffff",
  askedAt: ago(4),
  spec: {
    question: "The audit turned up thirty findings. Which of them should be fixed on this thread?",
    kind: "multi",
    options: Array.from({ length: 30 }, (_, i) => ({
      label: `Finding ${i + 1}`,
      ...(i % 7 === 3 ? { description: "a one-line trade-off, so the row wraps the way a real one does" } : {}),
    })),
  },
}

// An option body carrying every BLOCK the prose surface renders — a table above all, which is the case
// that broke inside a SELECTED chip (the accent tint behind opaque panel fills; screenshot 2026-09-02).
const TABLE: RegisteredQuestionView = {
  id: "qst_0005eeee",
  askedAt: ago(2),
  spec: {
    question: "The skip warning fires on packages that were already built. How should it resolve?",
    kind: "question",
    options: [
      {
        label: "Leave it — the warning is annoying but the gate stays strict",
        description: "Nothing changes; the warning keeps firing on every `nub add` until the lockfile is re-checked.",
      },
      {
        label: "Fix it — judge the wait per package",
        recommended: true,
        description: [
          "Kills the false warning, but a curated package would start building in a case where it is currently skipped — a real loosening of the supply-chain gate.",
          "",
          "Today a package qualifies for the curated build allowlist only if the graph as a whole came from an already-checked lockfile. Adding any new dependency makes that false for **every** package in the tree.",
          "",
          "Effect on `nub add esbuild`-style flows:",
          "",
          "| today | after |",
          "| --- | --- |",
          "| `WARN ignored build scripts for esbuild@0.24.0` | no warning; esbuild stays trusted |",
          "| already-built packages keep working | same |",
          "| a curated package is skipped after any add | a curated package may now build after an add |",
          "",
          "> The gate's criteria are unchanged; only the unit of judgment moves.",
          "",
          "```ts",
          "const trusted = lockfileChecked(pkg.version) // per package, not per graph",
          "```",
        ].join("\n"),
      },
    ],
  },
}

// The ask an ntwine wake used to strand above the worker's newer handoff (2026-09-28, a real thread's
// shape: asked on one day, the PR watcher expired four days later, the worker re-armed and rested again).
const MERGE: RegisteredQuestionView = {
  id: "qst_0007abab",
  askedAt: ago(30),
  spec: {
    question: "PR #1403 is merge-ready (CI green, e2e approved on the preview repo, last review clean). Merge it to main?",
    kind: "question",
    options: [
      { label: "Merge it", description: "squash-merge now; the preview repo already approved it end to end", recommended: true },
      { label: "Hold it", description: "leave it open for another look" },
    ],
  },
}

const placed = params.get("placed") === "1"
const woken = params.get("woken") === "1"
const keys = params.get("keys") === "1"
const questions = params.get("danger") === "1" ? [GATE]
  : keys ? [SETTINGS, TREE]
  : placed ? [SETTINGS, GATES]
  : woken ? [MERGE]
  : params.get("wide") === "1" ? [WIDE]
  : params.get("tree") === "1" ? [TREE]
  : params.get("many") === "1" ? [SETTINGS, TREE, GATES]
  : params.get("table") === "1" ? [TABLE]
  : params.get("default") === "1" ? [{ ...SETTINGS, defaultsAt: new Date(Date.now() + 7 * 60_000 + 20_000).toISOString() }]
  : params.get("default") === "2" ? [{ ...SETTINGS, defaultsAt: new Date(Date.now() + 7 * 60_000 + 20_000).toISOString(), defaultsTo: "Keep the repro in the handoff" }]
  : [SETTINGS]

const tail = "Both stores work. The choice is yours because it is the one thing here that is hard to reverse once there is data in it."
const past = params.get("past") === "1"
const marker = `**Fixed** — nothing further to do on the store: \`c6c292e8\` is on local \`main\`.\n\nThe one card still on the board is yours to decide, and it is the reason this thread does not file itself away as done:\n\n\`\`\`question ${SETTINGS.id}\n\`\`\`\n\nAnswer it either way and this thread is finished.`
const placedHandoff = `**Fixed** — the store is in and \`c6c292e8\` is on local \`main\`.\n\nOne call is yours, because it is the one thing here that is hard to reverse once there is data in it:\n\n\`\`\`question ${SETTINGS.id}\n\`\`\`\n\nEither store passes every gate today. The gates themselves are the other open card, below.`
const wokenHandoff = "[#1403](https://github.com/pullfrog/app/pull/1403) is still open and merge-ready. Nothing has happened on it since the clean review: CI is green on `df703a8` and it is still mergeable.\n\nThe PR watch is re-armed for 30 days, so a conflict or a new review wakes this thread."
// The card reads only the handoff — the human's last ask and the worker's answer to it — never the
// transcript (AllQueuesCard's header comment), so each case is spelled as that pair.
const handoff: ThreadHandoff = placed
  ? { asked: "Add a settings store.", askedAt: ago(12), text: placedHandoff, at: ago(1) }
  : woken
  // Only ntwine has spoken since the ask — a wake is not the human's — so the pair is the human's own ask
  // and the worker's NEWER handoff.
  ? { asked: "Get #1403 merge-ready.", askedAt: ago(40), text: wokenHandoff, at: ago(4) }
  : past
  ? { asked: "Well done, you did it.", askedAt: ago(2), text: marker, at: ago(1) }
  : { asked: "Add a settings store.", askedAt: ago(3), text: tail, at: ago(1) }

const thread = {
  id: "registered-question-demo",
  title: woken ? "Get #1403 merge-ready" : "Add a settings store",
  status: "active",
  mechanism: null,
  humanBlocked: false,
  // A registered question is a hard queue member — deriveNeedsYou returns true on any open row.
  needsYou: true,
  awaitingBackground: false,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  runtime: "turn-idle",
  sessionId: "aaaaaaaa-bbbb-cccc-dddd-000000000009",
  unread: false,
  archived: false,
  hasPlan: false,
  pendingQuestion: false,
  questions,
  kind: "session",
  foreign: false,
  backend: "claude",
  permissionMode: "default",
  subAgents: params.get("busy") === "1"
    ? [{ id: "agent-a", label: "Audit the parser for edge cases", subagentType: "ntwine:high", startedAt: ago(4), state: "running" }]
    : [],
  bgShells: params.get("busy") === "1"
    ? [{ id: "toolu_ci", taskId: "bzvtnt3ig", label: "gh run watch 1842", startedAt: ago(6), state: "running" }]
    : [],
  watches: params.get("busy") === "1"
    ? [{ id: "wch_aaa", kind: "shell", target: "bzvtnt3ig", state: "armed", createdAt: ago(6) }]
    : [],
  lastActivityAt: ago(1),
  lastAssistantAt: ago(1),
  lastAssistant: tail,
} as unknown as ThreadViewModel

// ?keys=1's second card: the same rest, asking only the commit gates.
const gatesThread = { ...thread, id: "registered-question-gates", title: "Pick the commit gates", questions: [GATES], lastActivityAt: ago(2) } as ThreadViewModel

store.board = { projectDir: "/fixture/ntwine", threads: keys ? [thread, gatesThread] : [thread] } as BoardSnapshot
Object.assign(window, { fixtureStore: store })

const project: QueuesProject = {
  id: "fixture",
  slug: "ntwine",
  name: "ntwine",
  card: undefined,
  open: true,
  stale: false,
  projectDir: "/fixture/ntwine",
  homeDir: "/fixture",
  githubRepo: undefined,
  queued: keys ? [thread, gatesThread] : [thread],
  running: [],
  snoozed: [],
  pinnedDone: [],
  doneCount: 0,
}

const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.origin)
  // The card addresses its OWN project (`/_ntwine/<project id>/rpc/…`, api/rpc.ts projectRpc), so every
  // route is matched on the rpc name alone.
  const rpc = /^\/_ntwine\/[^/]+\/rpc\/([^/]+)$/.exec(url.pathname)?.[1] ?? null
  // Every write, in order, for a probe asserting WHICH sends happened and in what sequence (a reply sent
  // with answers staged must send the answers first — registeredQuestionAutoSend.e2e).
  if (rpc !== null && rpc !== "threadHandoff") ((window as unknown as { __rpcs?: string[] }).__rpcs ??= []).push(rpc)
  if (rpc === "threadHandoff") {
    return new Response(JSON.stringify({ result: handoff }), { headers: { "content-type": "application/json" } })
  }
  // The writes the card makes, echoed onto the window so a probe can assert the exact payload the
  // worker would receive — above all that an answer RESTATES the question and carries the option's own
  // label rather than the numbered chip text. A prompt box's Send carries staged answers on `followUp`
  // (with whatever was typed there, upstream 59089c92), so that is echoed too.
  if (rpc === "followUp") {
    const body = JSON.parse(String(init?.body ?? "{}"))
    window.dispatchEvent(new CustomEvent("fixture-rpc", { detail: { rpc: "followUp", body } }))
    return new Response(JSON.stringify({ result: {} }), { headers: { "content-type": "application/json" } })
  }
  if (rpc === "answerQuestions" || rpc === "dismissQuestions" || rpc === "holdQuestionDefault") {
    const body = JSON.parse(String(init?.body ?? "{}"))
    window.dispatchEvent(new CustomEvent("fixture-rpc", { detail: { rpc, body } }))
    const ids: string[] = body.ids ?? (body.answers ?? []).map((a: { questionId: string }) => a.questionId)
    return new Response(JSON.stringify({ result: { answered: ids, dismissed: ids, open: [] } }), { headers: { "content-type": "application/json" } })
  }
  // The Settings drawer (?keys=1) reads the machine's settings; any plausible object will do.
  if (rpc === "settingsGet") {
    return new Response(JSON.stringify({ result: { permissionMode: "auto", notifications: false } }), { headers: { "content-type": "application/json" } })
  }
  if (rpc !== null) {
    return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  }
  return originalFetch(input, init)
}

// Settings and the palette mount the way App mounts them: off the store flags.
function Overlays() {
  const snap = useSnapshot(store)
  return (
    <>
      {snap.showSettings && <SettingsDrawer />}
      <CommandPalette />
    </>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter>
      <TooltipProvider>
        <div className="mx-auto flex w-[min(680px,calc(100%-32px))] flex-col gap-4 py-8">
          {/* Each card in a wrapper naming its thread, so a probe can address one card of ?keys=1's two. */}
          {(keys ? [thread, gatesThread] : [thread]).map((t) => (
            <div key={t.id} data-queue-card-root={t.id}>
              <AllQueuesCard project={project} thread={t} leaving={false} onLeave={() => {}} onReturn={() => {}} />
            </div>
          ))}
        </div>
        {keys && <Overlays />}
      </TooltipProvider>
    </MemoryRouter>
  </QueryClientProvider>,
)
