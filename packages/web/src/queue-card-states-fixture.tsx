import { Profiler, memo, useCallback, useEffect, useMemo, useState, type ComponentProps, type ProfilerOnRenderCallback } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { parkExpiredWakeMessage, type BoardSnapshot, type RegisteredQuestionView, type ThreadHandoff, type ThreadView as ThreadViewModel, type TranscriptMessage } from "@ntwine/shared"
import { useLeavingCards } from "./components/AllQueues.tsx"
import { AllQueuesCard } from "./components/AllQueuesCard.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { threadKey, type QueuesProject } from "./lib/allQueues.ts"
import { useViewportLock } from "./lib/viewportLock.ts"
import { drawCardNow } from "./lib/cardVisibility.ts"
import { registerQueueCursor, releaseAutoOpened, useShortcutListener } from "./lib/keyboardRuntime.ts"
import { store } from "./store.ts"
import { FACT_CASES } from "./facts-fixture-cases.ts"
import "./styles.css"

// The page's QUEUE CARD (components/AllQueuesCard.tsx) in the states its own tests used to cover on the
// board's card, before that card and its fixtures were deleted with the board (098de26d, 2026-09-28).
// The REAL AllQueuesCard renders, with the REAL optimistic-exit hook the page runs
// (AllQueues.tsx useLeavingCards: leave → fade → hidden → back after REAPPEAR_MS unless the queue drops
// the thread). Only the network is stubbed, and every RPC the cards make is recorded on window.__rpc.
//
//   ?case=exit (default)       two resting cards; `Mark as done` on the first. completeThread answers
//                              after ?delay= ms (default 1500), then the "poll" drops the thread.
//     &needsConfirmation=1     …the server declines instead (fast, as it really is — the liveness check
//                              runs before any teardown), carrying a hold naming live work.
//     &fail=1                  …the RPC fails.
//     &stalePoll=1             …it succeeds, but the poll does not drop the thread: 9s after the click a
//                              read that STARTED before the done lands (thread still queued), and only
//                              12s after it does a fresh read drop the thread — a loaded server's poll.
//     &stillQueued=1           …it succeeds, and a read started after it still lists the thread: the
//                              done evidently did not take, so the card must come back.
//                              A reply sent from the first card's box steers it: the "poll" drops the
//                              thread 400ms later, once the fade is over.
//     &replyDelay=<ms>         …the reply's followUp answers only after that long (a cold resume, a retry).
//   ?case=registered-done      the thread signed off with `mcp__ntwine__done`: no fence in the handoff text,
//                              a registered `lastFence` on the thread (B1).
//   ?case=fenced-and-registered  both: the fence in the text AND the registration — one card, not two.
//   ?case=pending-ask          a FOREIGN session frozen at a native AskUserQuestion, nothing journaled (B2);
//                              only a foreign session draws that card (lib/operatorBlock.ts frozenPendingAsk).
//   ?case=perm-prompt          a session parked on a permission prompt, nothing journaled (B2).
//   ?case=perm-prompt-journaled  the same, but an answerable interaction IS journaled: the net stands down.
//   ?case=replied              a park queued only for its unread reply (queuedForReply): "Replied", and
//                              Mark as read records it seen (threadSeen), after which the poll drops it.
//   ?case=steps                the first card's thread is AT REST on an ```awaiting fence handing the human
//                              `steps:` (upstream fe668a8d): the card draws the drawer's steps card, and its
//                              Done replies into the CARD's project and takes the card out. The neighbour is
//                              an ordinary rest.
//   ?case=resting              the first card's thread rests on an agent terminal it declared (`shells:`), so
//                              it draws the RESTING card — the wait row, and no snooze while the shell runs.
//   ?case=questions            each card's question at the rest that asked it (upstream e157817a, 22084580). The
//                              first card's was asked two rests ago, the rest after it is a CI wake's bare
//                              reply: the question sits under the reply that asked it, and the bare rest
//                              draws "Rested without a sign-off". The second card's question is its newest
//                              rest's own: under the handoff, no rested card. Both read their transcript
//                              through the card's project (threadTranscript).
//   ?case=facts                a card whose header facts line carries a context reading (narrow-width check).
//     &chip=1                  …led by its project, as on a page showing All projects.
//   ?case=facts-matrix         one card per combination of facts in facts-fixture-cases.ts (a context reading,
//                              a goal loop, a worktree, a spinoff, a long status line), for judging the line's
//                              drop-whole rule at every width at once. Takes &chip=1 too.
//   &cardw=<px>                the queue column's width (default 640px, capped at the viewport).
//   ?case=many&n=<count>       a long queue (default 60 cards), every third handoff long enough to clamp, on
//                              a page whose board IS the cards' project (so the `@` typeahead has threads to
//                              offer). Each card sits in a <Profiler> counting its commits on
//                              window.__renders, and window.__boardDelta() moves the board the way a live
//                              delta does — queueCardVisibility.e2e.test.ts. `&mid=1` gives the short cards
//                              a ~300-character handoff instead, which rewraps (changes height) when the
//                              column's width changes; `&handoffDelay=<ms>` answers every handoff that late.
//                              window.__filter(pattern) shows only the cards whose id matches, as a project
//                              filter does (the rest unmount), and __filter(null) shows them all again.
//
// The card's project is NOT the page's: `store.board` names another project, so a control that read the
// page's client instead of the card's would call `/_ntwine/rpc/…` (unprefixed) and show up in __rpc as
// such.

const params = new URLSearchParams(location.search)
// `&font=sans`: the app's own font (index.html pins it); a measurement on the stylesheet's mono default is wrong.
if (params.get("font") === "sans") document.documentElement.dataset.font = "sans"
const CASE = params.get("case") ?? "exit"
const DELAY = Number(params.get("delay") ?? 1500)
const DECLINE = params.get("needsConfirmation") === "1"
const FAIL = params.get("fail") === "1"
const REPLY_DELAY = Number(params.get("replyDelay") ?? 0)
const STALE_POLL = params.get("stalePoll") === "1"
const STILL_QUEUED = params.get("stillQueued") === "1"
const MID = params.get("mid") === "1"
const HANDOFF_DELAY = Number(params.get("handoffDelay") ?? 0)
// `&chip=1`: the card leads its meta line with its project, as it does on a page showing All projects.
const CHIP = params.get("chip") === "1"
// `?asked=update`: the human's last turn was the resting card's "Ask for update", which the server quotes
// by the wake's head line (router.handoffOf) and the card draws as a marker, not a typed bubble.
const ASKED = params.get("asked") === "update" ? parkExpiredWakeMessage([], true, true).split("\n")[0]! : "Rotate the signing key without downtime."

const now = new Date().toISOString()
function thread(id: string, title: string, extra: Partial<ThreadViewModel> = {}): ThreadViewModel {
  return {
    id,
    title,
    status: "needs-human",
    statusText: "",
    mechanism: null,
    humanBlocked: true,
    needsYou: true,
    ready: false,
    dependsOn: [],
    externalDeps: [],
    agents: [],
    errors: [],
    warnings: [],
    runtime: "turn-idle",
    unread: false,
    archived: false,
    hasPlan: false,
    pendingQuestion: false,
    kind: "session",
    foreign: false,
    backend: "claude",
    permissionMode: "default",
    state: "open",
    sessionId: `sess-${id}`,
    subAgents: [],
    bgShells: [],
    watches: [],
    questions: [],
    lastFence: undefined,
    lastActivityAt: now,
    lastAssistantAt: now,
    spawnedAt: now,
    ...extra,
  } as unknown as ThreadViewModel
}

const DONE_BODY = "Rotated the signing key behind a dual-read window.\n\n- New key live on all three regions\n- Old key retired after 24h"
const FENCED = `Both regions verified.\n\n\`\`\`done\n${DONE_BODY}\n\`\`\``
const ASK = {
  questions: [{
    header: "Rollout",
    question: "Which rollout do you want?",
    multiSelect: false,
    options: [{ label: "Rotate in place", description: "one step, a short dual-read window" }, { label: "Stage a second key" }],
  }],
}

// A rest handing the human steps, as the worker contract's own example writes it (WORKER_PROMPT `steps:`).
const STEPS_TITLE = "Sign in to npm so the release can publish"
const STEPS = ["Run `npm login --auth-type=web` in a terminal on this machine.", "Approve the browser prompt with the **acme-bot** account."]
const STEPS_BODY = "The release is staged; it publishes the moment npm accepts the login."
const STEPS_FENCE = `I can't publish without an npm session on this machine.\n\n\`\`\`awaiting\ntitle: ${STEPS_TITLE}\nsteps:\n${STEPS.map((step) => `  - ${step}`).join("\n")}\n---\n${STEPS_BODY}\n\`\`\``
// A rest on an agent terminal the worker declared, still running.
const SHELL_FENCE = "The full suite is running in the background.\n\n```awaiting\nshells: [b1]\nstatus: needs_input\n---\nThe suite takes about ten minutes; the failures so far are all in the auth spec.\n```"

// `?case=questions`: questions at the rest that asked them.
const T0 = Date.now()
const ago = (min: number) => new Date(T0 - min * 60_000).toISOString()
const said = (role: "user" | "assistant", text: string, minAgo: number, extra: Partial<TranscriptMessage> = {}) =>
  ({ role, text, at: ago(minAgo), tools: [], parts: [{ kind: "text", text }], ...extra }) as TranscriptMessage
const ROLLOUT_ASK = "Both rollouts are ready to go; the only difference is how long the old key stays readable."
const BARE_REST = "CI is green on main; nothing else changed."
const CI_ASK = "Found the race in the token refresh. One call before I land the fix."
const OLD_QUESTION: RegisteredQuestionView = {
  id: "qst_rollout0001",
  askedAt: ago(25),
  spec: { kind: "question", header: "Rollout", question: "Which rollout do you want?", options: [{ label: "Rotate in place", description: "One step, a short dual-read window.", recommended: true }, { label: "Stage a second key" }] },
}
const NEW_QUESTION: RegisteredQuestionView = {
  id: "qst_retries0002",
  askedAt: ago(5),
  spec: { kind: "question", header: "Retries", question: "Keep the retry wrapper on the auth suite?", options: [{ label: "Drop it", description: "The race is fixed at the source.", recommended: true }, { label: "Keep it for a week" }] },
}

// Long enough to clamp (AllQueuesCard ClampedBody, 188px).
const LONG = Array.from({ length: 14 }, (_, i) => `Paragraph ${i + 1} of a long handoff: what changed, why, and what is left to check before this can be marked done.`).join("\n\n")

// Under the clamp, and long enough to wrap onto more lines when the column narrows.
const midHandoff = (id: string) => `A mid-length handoff for ${id}: ${"the change landed, the tests pass, and one follow-up is left for review before it can be marked done. ".repeat(3)}`

// `?case=earlier-under-done`: @precompile-design, 2026-10-16. The worker answers with examples long enough
// to clamp; `window.__restAgain()` then rests it again on a done, as the sign-off did. The examples must
// stay on the card, and stay open if the human opened them.
const EXAMPLES = `Four example Types, each run through arktype and through today's build.\n\n| | 1 | 2 | 3 |\n| --- | --- | --- | --- |\n| arktype | \`b: {n: 8}\` | \`[{n:4},{n:4}]\` | \`b: "1"\` |\n| Today's rules | build fails | builds | \`b: 1\` |\n| Precondition | \`b: {n: 4}\` | halved twice | \`b: 1\` |\n\n${LONG}`
const SIGNED_OFF = "Everything is on `precompile`, not merged. I kept today's case-by-case guards.\n\n```done\n- **Kept the guards**: an example of each alternative is in my last message.\n```"
let rested = 0

interface Scenario {
  threads: ThreadViewModel[]
  text: (id: string) => string
  /** The rest of the handoff (`earlier`, …) beyond the newest rest's text, by thread. */
  handoff?: (id: string) => Partial<ThreadHandoff>
  /** The thread's transcript, for a card that reads one (hooks/useCardTranscript.ts). */
  transcript?: (id: string) => TranscriptMessage[]
}
function scenario(): Scenario {
  switch (CASE) {
    case "steps":
      return {
        threads: [
          thread("rotate-key", "Rotate the signing key without downtime", {
            awaitingBackground: true,
            lastFence: { kind: "awaiting", body: STEPS_BODY, hints: [{ kind: "title", value: STEPS_TITLE }, ...STEPS.map((value) => ({ kind: "step" as const, value }))] },
          }),
          thread("flaky-ci", "Deflake the auth integration suite"),
        ],
        text: (id) => (id === "rotate-key" ? STEPS_FENCE : "Found the race; the fix is in, 50 green runs."),
      }
    case "resting":
      return {
        threads: [
          thread("rotate-key", "Rotate the signing key without downtime", {
            awaitingBackground: true,
            bgShells: [{ id: "b1", label: "nub run test", state: "running", startedAt: new Date(Date.now() - 4 * 60_000).toISOString() }],
            watches: [{ id: "shell:rotate-key:b1", kind: "shell", target: "b1", state: "armed", createdAt: now }],
            lastFence: { kind: "awaiting", body: "The suite takes about ten minutes; the failures so far are all in the auth spec.", hints: [{ kind: "shell", value: "b1" }, { kind: "status", value: "needs_input" }] },
          }),
          thread("flaky-ci", "Deflake the auth integration suite"),
        ],
        text: (id) => (id === "rotate-key" ? SHELL_FENCE : "Found the race; the fix is in, 50 green runs."),
      }
    // A parent resting `needs_input` on a sub-agent still out — working, so nothing may snooze it — beside a
    // card with nothing running, under the keyboard runtime so `s` and `j` act as on the page.
    case "subagents":
      return {
        threads: [
          thread("rotate-key", "Rotate the signing key without downtime", {
            subAgents: [{ id: "lane", label: "Audit the refresh-token rotation", state: "running", startedAt: new Date(Date.now() - 10 * 60_000).toISOString() }],
            lastFence: { kind: "awaiting", body: "The audit lane is still running.", hints: [{ kind: "agent", value: "lane" }, { kind: "status", value: "needs_input" }] },
          }),
          thread("flaky-ci", "Deflake the auth integration suite"),
        ],
        text: (id) => (id === "rotate-key" ? "Rotation is staged.\n\n```awaiting\nagents: [lane]\nstatus: needs_input\n---\nThe audit lane is still running.\n```" : "Found the race; the fix is in, 50 green runs."),
      }
    case "questions":
      return {
        threads: [
          thread("rotate-key", "Rotate the signing key without downtime", { questions: [OLD_QUESTION], lastAssistantAt: ago(2) }),
          thread("flaky-ci", "Deflake the auth integration suite", { questions: [NEW_QUESTION], lastAssistantAt: ago(5) }),
        ],
        text: (id) => (id === "rotate-key" ? BARE_REST : CI_ASK),
        handoff: (id) => (id === "rotate-key" ? { earlier: [{ text: ROLLOUT_ASK, at: ago(25) }], at: ago(2), askedAt: ago(30) } : { at: ago(5), askedAt: ago(20) }),
        transcript: (id) => (id === "rotate-key"
          ? [said("user", ASKED, 30), said("assistant", ROLLOUT_ASK, 25), said("user", "CI finished on main: all checks passed.", 3, { wake: true }), said("assistant", BARE_REST, 2)]
          : [said("user", "Find out why the auth suite flakes.", 20), said("assistant", CI_ASK, 5)]),
      }
    case "earlier-under-done":
      return {
        threads: [thread("rotate-key", "Precompile design", { lastAssistantAt: ago(3) })],
        text: () => (rested ? SIGNED_OFF : EXAMPLES),
        handoff: () => (rested ? { earlier: [{ text: EXAMPLES, at: ago(3) }], at: ago(0) } : { at: ago(3) }),
      }
    case "registered-done":
      return {
        threads: [thread("rotate-key", "Rotate the signing key without downtime", { lastFence: { kind: "done", body: DONE_BODY, hints: [], registered: true } })],
        text: () => "Both regions verified; the old key is retired.",
      }
    case "fenced-and-registered":
      return {
        threads: [thread("rotate-key", "Rotate the signing key without downtime", { lastFence: { kind: "done", body: DONE_BODY, hints: [], registered: true } })],
        text: () => FENCED,
      }
    case "pending-ask":
      return {
        threads: [thread("rotate-key", "Rotate the signing key without downtime", { runtime: "running", foreign: true, pendingAsk: ASK })],
        text: () => "I need a call on the rollout before I touch production.",
      }
    case "perm-prompt":
    case "perm-prompt-journaled":
      return {
        threads: [thread("rotate-key", "Rotate the signing key without downtime", { runtime: "perm-prompt", pendingInteraction: CASE === "perm-prompt-journaled" })],
        text: () => "Running the migration against staging now.",
      }
    case "replied":
      return {
        threads: [thread("rotate-key", "Rotate the signing key without downtime", { queuedAt: now, queuedForReply: true })],
        text: () => "Yes — the old key stays readable for 24h.\n\n```awaiting\nshells: [b1]\nfor: 2h\n---\nThe dual-read window is open; the old key is retired when it closes.\n```",
      }
    // The header's facts line with a context reading beside "Ready …" — judged at a 420px card, where the
    // line used to squeeze the time to nothing and open on a stray "·".
    case "facts":
      return {
        threads: [thread("rotate-key", "Rotate the signing key without downtime", { context: { tokens: 148_000, window: 200_000 }, lastAssistantAt: new Date(Date.now() - 37 * 60_000).toISOString() })],
        text: () => "Both regions verified; the old key is retired.",
      }
    case "facts-matrix":
      return {
        threads: FACT_CASES.filter((c) => c.id !== "no-band").map((c) => thread(c.id, c.title, { lastAssistantAt: new Date(Date.now() - 37 * 60_000).toISOString(), ...c.extra })),
        text: () => "Both regions verified; the old key is retired.",
      }
    // A thread's TIME LIMIT on the facts line (DeadlineControl DeadlineFact): plenty of time, the last stretch,
    // and over time on a limit the agent set — `&font=sans` for the measured reading.
    case "deadline": {
      const at = (leftMin: number, budgetMin: number, setBy: "human" | "worker" = "human") => ({
        deadline: { at: new Date(Date.now() + leftMin * 60_000).toISOString(), setAt: new Date(Date.now() + (leftMin - budgetMin) * 60_000).toISOString(), setBy },
        lastAssistantAt: new Date(Date.now() - 4 * 60_000).toISOString(),
      })
      return {
        threads: [
          thread("deadline-plenty", "Rotate the signing key without downtime", { ...at(42, 120), context: { tokens: 148_000, window: 200_000 } }),
          thread("deadline-closing", "Deflake the auth integration suite", at(4, 60)),
          thread("deadline-over", "Port the parser to the new grammar", at(-8, 30, "worker")),
        ],
        text: () => "Both regions verified; the old key is retired.",
      }
    }
    case "many": {
      const count = Number(params.get("n") ?? 60)
      const threads = Array.from({ length: count }, (_, i) => thread(`card-${i}`, `Queue card ${i}`))
      return { threads, text: (id) => (Number(id.slice(5)) % 3 === 0 ? LONG : MID ? midHandoff(id) : `Short handoff for ${id}.`) }
    }
    default:
      return {
        threads: [
          thread("rotate-key", "Rotate the signing key without downtime"),
          thread("flaky-ci", "Deflake the auth integration suite"),
        ],
        text: (id) => (id === "rotate-key" ? "The key is rotated. Mark it done when you have checked the dashboards." : "Found the race; the fix is in, 50 green runs."),
      }
  }
}
const { threads: THREADS, text: textOf, handoff: handoffOf, transcript: transcriptOf } = scenario()

// The page's project, deliberately NOT the card's (see the header) — but for `many`, whose page IS the
// cards' project, as on a page focused on it.
store.board = (CASE === "many"
  ? { projectSlug: "signing", projectDir: "/fixture/signing", threads: THREADS }
  : { projectDir: "/fixture/elsewhere", threads: [] }) as unknown as BoardSnapshot
// A live board delta, applied IN PLACE as store.ts applyDelta applies one: a thread arrives on the board.
let deltas = 0
;(window as unknown as { __boardDelta: () => void }).__boardDelta = () => {
  store.board!.threads.push(thread(`delta-${++deltas}`, `Arrived ${deltas}`))
}
const renders: Record<string, number> = {}
;(window as unknown as { __renders: Record<string, number> }).__renders = renders
const countRender: ProfilerOnRenderCallback = (id) => { renders[id] = (renders[id] ?? 0) + 1 }
// The <Profiler> sits INSIDE a memo of its own: a Profiler reports every time its parent renders it, even
// when everything under it bails out, so outside one it would count the queue's renders, not the card's.
// Its props are the card's own, so it renders exactly when the card is handed something new — and its
// onRender fires besides whenever anything inside the card commits.
const CountedCard = memo(function CountedCard({ id, ...props }: ComponentProps<typeof AllQueuesCard> & { id: string }) {
  return (
    <Profiler id={id} onRender={countRender}>
      <AllQueuesCard {...props} />
    </Profiler>
  )
})

interface RpcLog { calls: { path: string; at: number; body?: string }[]; completeCalledAt: number | null; completeResolvedAt: number | null }
const log: RpcLog = { calls: [], completeCalledAt: null, completeResolvedAt: null }
;(window as unknown as { __rpc: RpcLog }).__rpc = log
;(window as unknown as { __store: typeof store }).__store = store

// The poll dropping a completed thread, as the page's projectsQueues read would once the server archives it.
let dropThread: (id: string) => void = () => {}
// A read that LANDS now, still listing every thread, having started at `startedAt`.
let landRead: (startedAt: number) => void = () => {}

const json = (result: unknown) => new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json" } })
const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.origin)
  if (!url.pathname.startsWith("/_ntwine/")) return originalFetch(input, init)
  log.calls.push({ path: url.pathname, at: performance.now(), ...(typeof init?.body === "string" ? { body: init.body } : {}) })
  const rpc = /\/rpc\/([^/]+)$/.exec(url.pathname)?.[1]
  // Not an RPC (an attachment's `/attach`): left to whatever a test installed under this stub.
  if (!rpc) return originalFetch(input, init)
  // A query carries its input in `?input=`, a mutation in the body.
  const raw = typeof init?.body === "string" ? init.body : url.searchParams.get("input")
  const body = raw ? (JSON.parse(raw) as { slug?: string }) : {}
  if (rpc === "threadHandoff") {
    if (HANDOFF_DELAY) await new Promise((resolve) => setTimeout(resolve, HANDOFF_DELAY))
    const handoff: ThreadHandoff = { asked: ASKED, askedAt: now, text: textOf(body.slug ?? ""), at: now, ...handoffOf?.(body.slug ?? "") }
    return json(handoff)
  }
  if (rpc === "threadTranscript" && transcriptOf) {
    const messages = transcriptOf(body.slug ?? "")
    return json({ messages, beforeCursor: null, hasEarlier: false, reachedTurnBoundary: true, transcriptKey: `fixture-${body.slug}` })
  }
  if (rpc === "threadSettledQuestions") return json({ questions: [] })
  // A reply steers the thread back to work, and the next poll drops it from the queue. After the fade, not
  // during it: the page holds a leaving card's slot (and its thread) until the fade ends (AllQueues.tsx
  // stableQueue `keep`), which this fixture does not reproduce — dropping it sooner here would unmount the
  // card mid-fade, which the page never does.
  if (rpc === "followUp") {
    if (REPLY_DELAY) await new Promise((resolve) => setTimeout(resolve, REPLY_DELAY))
    setTimeout(() => dropThread(body.slug ?? ""), 400)
    return json({})
  }
  // The reply box's @ typeahead reads every project's queue on an All projects page, which this path
  // reads as; its answer is a list, and `{}` crashed the box.
  if (rpc === "projectsQueues") return json([])
  if (rpc === "threadSeen") {
    setTimeout(() => dropThread(body.slug ?? ""), 50)
    return json({})
  }
  if (rpc === "completeThread") {
    log.completeCalledAt = performance.now()
    if (DECLINE) {
      await new Promise((resolve) => setTimeout(resolve, 90))
      log.completeResolvedAt = performance.now()
      return json({
        needsConfirmation: true,
        hold: {
          turnInFlight: false,
          unobservable: false,
          subAgents: [{ label: "Audit the refresh-token rotation", state: "running" }],
          subAgentCount: 1,
          bgShells: [{ label: "Watch origin/main CI", state: "running" }, { label: "vite dev server", state: "stale" }],
          bgShellCount: 2,
        },
      })
    }
    await new Promise((resolve) => setTimeout(resolve, DELAY))
    log.completeResolvedAt = performance.now()
    if (FAIL) return new Response(JSON.stringify({ error: "the worker would not stop" }), { status: 500, headers: { "content-type": "application/json" } })
    if (STILL_QUEUED) {
      setTimeout(() => landRead(Date.now()), 1_000)
      return json({ needsConfirmation: false })
    }
    if (STALE_POLL) {
      const calledAt = Date.now() - DELAY
      setTimeout(() => landRead(calledAt - 500), 9_000 - DELAY)
      setTimeout(() => dropThread(body.slug ?? ""), 12_000 - DELAY)
      return json({ needsConfirmation: false })
    }
    setTimeout(() => dropThread(body.slug ?? ""), 50)
    return json({ needsConfirmation: false })
  }
  return json({})
}

let setFilter: (pattern: string | null) => void = () => {}
;(window as unknown as { __filter: (pattern: string | null) => void }).__filter = (pattern) => setFilter(pattern)

function Queue() {
  const [queued, setQueued] = useState(THREADS)
  const [filter, setFilterState] = useState<RegExp | null>(null)
  setFilter = (pattern) => setFilterState(pattern === null ? null : new RegExp(pattern))
  // When the newest "poll" STARTED (lib/projectsQueuesRead.ts). A drop is a fresh read.
  const [readAt, setReadAt] = useState(() => Date.now())
  dropThread = (id) => {
    setQueued((list) => list.filter((t) => t.id !== id))
    setReadAt(Date.now())
  }
  ;(window as unknown as { __restAgain: () => void }).__restAgain = () => {
    rested++
    setQueued((list) => list.map((t) => ({ ...t, lastAssistantAt: new Date().toISOString() })))
  }
  landRead = (startedAt) => {
    setQueued((list) => [...list])
    setReadAt(startedAt)
  }
  const project: QueuesProject = useMemo(() => ({
    id: "fixture-card",
    slug: "signing",
    name: "signing",
    card: undefined,
    open: true,
    stale: false,
    projectDir: "/fixture/signing",
    homeDir: "/fixture",
    githubRepo: undefined,
    queued,
    running: [],
    snoozed: [],
    pinnedDone: [], recentDone: [],
    doneCount: 0,
  }), [queued])
  const leaving = useLeavingCards([project], readAt)
  return (
    <div className="flex flex-col gap-5">
      {queued.filter((t) => !leaving.hidden(threadKey(project.id, t.id)) && (!filter || filter.test(t.id))).map((t) => {
        const key = threadKey(project.id, t.id)
        return (
          <CountedCard key={key} id={key} project={project} thread={t} chip={CHIP} leaving={leaving.isLeaving(key)} onLeave={leaving.leave(key)} onReturn={leaving.restore(key)} onSent={leaving.sent(key)} onLanded={leaving.landed(key)} />
        )
      })}
    </div>
  )
}

// `many` holds the page with the queue's own viewport lock (lib/viewportLock.ts), as AllQueues does, so the
// cards building near the screen can be checked against it (queueCardVisibility.e2e.test.ts) — and with the
// keyboard runtime and a cursor that lands a card the way AllQueues' does (useScrollToCard: release the card
// a key opened, draw the target, go there; instantly, where the page glides). The card being read is the one
// last landed on, else the first. Each landing is recorded on window.__landings, with whether the card had a
// "Show more" the moment it was landed on.
const landings: { key: string; hadShowMore: boolean }[] = []
;(window as unknown as { __landings: typeof landings }).__landings = landings
function LockedQueue() {
  const [, repaint] = useState(0)
  useViewportLock("[data-xq-card]", (slot) => slot.dataset.xqCard, useCallback(() => repaint((n) => n + 1), []))
  useShortcutListener()
  useEffect(() => {
    const slots = () => [...document.querySelectorAll<HTMLElement>('[data-xq-card][data-queue-leaving="false"]')]
    const slotOf = (key: string) => slots().find((slot) => slot.dataset.xqCard === key)
    return registerQueueCursor({
      keys: () => slots().map((slot) => slot.dataset.xqCard!),
      current: () => landings.at(-1)?.key ?? slots()[0]?.dataset.xqCard ?? null,
      root: (key) => slotOf(key)?.querySelector<HTMLElement>("[data-xq-card-root]") ?? null,
      go: (key) => {
        releaseAutoOpened(key)
        const slot = slotOf(key)
        if (!slot) return
        drawCardNow(slot)
        scrollTo({ top: slot.getBoundingClientRect().top + scrollY - 40, behavior: "instant" })
        landings.push({ key, hadShowMore: Boolean(slot.querySelector("[data-xq-show-more]")) })
      },
    })
  }, [])
  return <Queue />
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter>
      <TooltipProvider>
        <div className="min-h-screen bg-bg px-4 py-6 text-sm text-fg">
          <div data-fixture-queue className="mx-auto w-[640px] max-w-full min-w-0" style={params.has("cardw") ? { width: `${Number(params.get("cardw"))}px` } : undefined}>
            {CASE === "many" || CASE === "subagents" ? <LockedQueue /> : <Queue />}
          </div>
        </div>
      </TooltipProvider>
    </MemoryRouter>
  </QueryClientProvider>,
)
